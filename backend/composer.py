"""作曲器：产出蓝图与各声部的音符表（M7）。

抽象照搬 `generation_backend.py` 的 `GenerationBackend` + `get_backend()`
—— 那套「一个接口、若干实现、按配置选」已经在这个仓库里用顺手了。

三个实现：

  `AlgorithmicComposer`  纯规则，不联网、不吃显存。既是没配 key 时的兜底，
                         也是测试基线和「模型写砸了」时的参照系。
  `LLMComposer`          走已有的 BYOK 通路（`llm.chat_json`）。
  `RemoteSymbolicComposer` 指向外部符号音乐模型服务，契约见
                         `docs/SYMBOLIC_COMPOSER_API.md`。

**两级调用，不是一次生成整曲**：`blueprint()` 全曲算一次（和弦走向、段落
边界），`compose_part()` 每件乐器一次。后者正好对上「生成」页现有的交互
——一件乐器一个按钮，一次点击一次调用——也是绕开模型输出 token 上限的
唯一办法：一首 32 小节 8 声部的曲子一次要吐上千个音符。
"""
from __future__ import annotations

import json
import logging
import random
import re
from abc import ABC, abstractmethod
from typing import Optional

import httpx

try:
    from . import config
    from . import llm as llmlib
    from . import project as projectlib
    from . import score as scorelib
except Exception:
    import config
    import llm as llmlib
    import project as projectlib
    import score as scorelib

logger = logging.getLogger(__name__)


class ComposerError(RuntimeError):
    """对外可见的作曲失败。"""


class Composer(ABC):
    name = "base"

    @abstractmethod
    async def blueprint(self, project: dict) -> dict:
        """全曲一份：调性、速度、小节数、段落、每小节的和弦。"""

    @abstractmethod
    async def compose_part(self, *, project: dict, instrument: dict, blueprint: dict,
                           existing_parts: list[dict], seed: int) -> dict:
        """一件乐器一份音符表。返回**未经校验**的原始结构，
        由 `score.validate_and_repair_part` 统一收口。"""


# ---------------- 共享：从项目推出蓝图骨架 ----------------

def _sections_from_project(project: dict, bars: int) -> list[dict]:
    """把构型的段落（按秒）换算成按小节。没有构型就当成一整段。"""
    formation = project.get("formation") or {}
    raw = formation.get("sections") or []
    if not raw:
        return [{"id": "whole", "label": "全曲", "start_bar": 1, "end_bar": bars,
                 "intensity": 0.6, "is_climax": False}]

    total = sum(float(s.get("duration") or 0) for s in raw) or 1.0
    out: list[dict] = []
    cursor = 1
    for i, s in enumerate(raw):
        share = float(s.get("duration") or 0) / total
        # 最后一段直接吃掉剩下的，避免逐段取整之后总数对不上
        span = (bars - cursor + 1) if i == len(raw) - 1 else max(1, round(share * bars))
        end = min(bars, cursor + span - 1)
        if cursor > bars:
            break
        out.append({
            "id": s.get("id") or f"s{i}",
            "label": s.get("label") or s.get("kind") or f"第 {i + 1} 段",
            "start_bar": cursor,
            "end_bar": end,
            "intensity": float(s.get("intensity") or 0.6),
            "is_climax": bool(s.get("is_climax")),
        })
        cursor = end + 1
    if not out:
        out = [{"id": "whole", "label": "全曲", "start_bar": 1, "end_bar": bars,
                "intensity": 0.6, "is_climax": False}]
    return out


def skeleton(project: dict) -> dict:
    """蓝图里不依赖和声决策的那部分。三个作曲器共用，保证时间轴一致。"""
    bpm = int(project.get("bpm") or 92)
    bpb, unit = scorelib.parse_time_signature(project.get("time_signature") or "4/4")
    bars = scorelib.bars_for_duration(projectlib.total_duration(project), bpm, bpb, unit)
    return {
        "schema_version": scorelib.SCORE_SCHEMA_VERSION,
        "revision": 1,
        "bpm": bpm,
        "key": project.get("key") or "C major",
        "time_signature": project.get("time_signature") or "4/4",
        "beats_per_bar": bpb,
        "beat_unit": unit,
        "bars": bars,
        "exact_duration": round(scorelib.exact_duration(bars, bpm, bpb, unit), 4),
        "sections": _sections_from_project(project, bars),
    }


# ---------------- 算法作曲 ----------------

# 各段落按强度挑一条四小节的级数走向（下标是级数 - 1）。
# 这些都是通用套路而不是抄某首曲子：I–V–vi–IV 之类的进行本身不受版权保护。
_PROGRESSIONS: list[tuple[float, tuple[int, ...]]] = [
    # (强度上限, 级数序列)
    (0.35, (0, 5, 3, 0)),   # I  vi IV I   —— 安静，几乎不离开主和弦
    (0.55, (0, 3, 4, 0)),   # I  IV V  I   —— 最基本的正格进行
    (0.75, (0, 4, 5, 3)),   # I  V  vi IV  —— 有推进感
    (1.01, (5, 3, 0, 4)),   # vi IV I  V   —— 从关系小调起头，最紧张
]

_ROLE_VELOCITY = {"melody": 96, "harmony": 68, "bass": 78, "rhythm": 88}


def _progression_for(intensity: float) -> tuple[int, ...]:
    for limit, prog in _PROGRESSIONS:
        if intensity <= limit:
            return prog
    return _PROGRESSIONS[-1][1]


class AlgorithmicComposer(Composer):
    """纯规则作曲。

    目标不是写出好听的曲子，是写出**站得住的**曲子：调性统一、和声不打架、
    拍点落在网格上、各声部音区不重叠。它同时是：没配语言模型时的兜底、
    渲染链路的测试基线，以及语言模型写砸时用来对照的参照系。
    """

    name = "algorithmic"

    async def blueprint(self, project: dict) -> dict:
        bp = skeleton(project)
        key = scorelib.parse_key(bp["key"])
        triads = scorelib.diatonic_triads(key)

        chords: list[str] = []
        for sec in bp["sections"]:
            prog = _progression_for(sec["intensity"])
            span = sec["end_bar"] - sec["start_bar"] + 1
            for i in range(span):
                degree = prog[i % len(prog)]
                # 每一段的最后一小节回主和弦（末段）或落到属和弦（中间段），
                # 让段落之间有明确的呼吸口，而不是四小节循环无限接下去。
                if i == span - 1:
                    degree = 0 if sec is bp["sections"][-1] else 4
                chords.append(triads[degree])
        bp["chords"] = chords[: bp["bars"]]
        while len(bp["chords"]) < bp["bars"]:
            bp["chords"].append(triads[0])
        bp["created_by"] = "algorithmic"
        return bp

    async def compose_part(self, *, project, instrument, blueprint, existing_parts, seed):
        rng = random.Random(seed)
        role = instrument.get("role") or "harmony"
        library_key = instrument.get("library_key") or ""
        lo, hi = scorelib.instrument_range(library_key)
        bpb = int(blueprint["beats_per_bar"])
        notes: list[list] = []

        for bar in range(1, int(blueprint["bars"]) + 1):
            sec = _section_of(blueprint, bar)
            weight = _participation_at(project, instrument, blueprint, bar)
            if weight <= 0.02:
                continue  # 构型说这一段这件乐器不参与，就真的一个音都不写
            chord = scorelib.blueprint_chord(blueprint, bar)
            vel = _ROLE_VELOCITY.get(role, 70) * (0.55 + 0.45 * sec["intensity"]) * weight

            if scorelib.is_percussion(library_key):
                notes += _percussion(bar, bpb, sec, vel, rng)
            elif role == "rhythm":
                # 有音高的打击乐（定音鼓）。不能走 _pad —— 定音鼓敲不出持续和弦，
                # 它的活是在强拍上用主音/属音把和声的根基砸实。
                notes += _timpani(bar, bpb, chord, blueprint, lo, hi, vel)
            elif role == "bass":
                notes += _bass(bar, bpb, chord, lo, hi, vel)
            elif role == "melody":
                notes += _melody(bar, bpb, chord, blueprint, lo, hi, vel, notes, rng)
            else:
                notes += _pad(bar, bpb, chord, lo, hi, vel, notes)

        return {"notes": notes}


def _section_of(blueprint: dict, bar: int) -> dict:
    for s in blueprint["sections"]:
        if s["start_bar"] <= bar <= s["end_bar"]:
            return s
    return blueprint["sections"][-1]


def _participation_at(project: dict, instrument: dict, blueprint: dict, bar: int) -> float:
    """这件乐器在第 bar 小节的参与权重。

    这是 `formation.instruments[].participation` **真正生效的地方**。M4d 就
    存下了这份数据，但前端的 `participationEnvelope` 至今没有调用者，音频层面
    从没兑现过「谁在哪一段进出场」。符号模式下它在作曲阶段就落实：不参与的
    小节根本不写音符 —— 比生成完再拿音量包络去压干净得多。
    """
    part = instrument.get("participation") or []
    if not part:
        return 1.0
    sections = blueprint["sections"]
    for i, s in enumerate(sections):
        if s["start_bar"] <= bar <= s["end_bar"]:
            return float(part[i]) if i < len(part) else 1.0
    return 1.0


def _pick(pcs: list[int], target: int, lo: int, hi: int) -> Optional[int]:
    """在 [lo, hi] 里找离 target 最近、音级属于 pcs 的音。"""
    best, best_d = None, 10 ** 9
    for pc in pcs:
        base = pc + 12 * ((lo - pc) // 12)
        for p in range(base, hi + 1, 12):
            if p < lo:
                continue
            d = abs(p - target)
            if d < best_d:
                best, best_d = p, d
    return best


def _bass(bar: int, bpb: int, chord: dict, lo: int, hi: int, vel: float) -> list[list]:
    """低音：强拍给根音，四拍时第三拍换五音。

    第三拍不重复根音是有原因的：连续四小节的同音会把低音听成一条直线，
    而换到五音既保持了和声功能，又给出了行进感。
    """
    # 低音声部往音区下三分之一放，别和中声部抢地方
    anchor = lo + (hi - lo) // 4
    root = _pick([chord["bass_pc"]], anchor, lo, hi)
    if root is None:
        return []
    out = [[bar, 1.0, min(2.0, bpb / 2), root, int(vel)]]
    if bpb >= 4:
        fifth_pc = chord["pcs"][2] if len(chord["pcs"]) > 2 else chord["root_pc"]
        fifth = _pick([fifth_pc], root, lo, hi) or root
        out.append([bar, 3.0, min(2.0, bpb / 2), fifth, int(vel * 0.88)])
    elif bpb == 3:
        # 三拍子低音只在第一拍落，第二三拍留给和声声部 —— 这是圆舞曲的骨架
        out[0][2] = 1.0
    return out


def _pad(bar: int, bpb: int, chord: dict, lo: int, hi: int, vel: float,
         prev: list[list]) -> list[list]:
    """和声：整小节持续的和弦音，带**声部进行**。

    声部进行（voice leading）是这套规则里最影响听感的一条：每个声部都取离
    上一小节自己那个音最近的和弦音，而不是每次都从根音往上堆。前者是和声在
    平稳移动，后者是一块块和弦被砸下来 —— 差别一耳朵就能听出来。
    """
    # 中声部放在音区中段，上下各留一点，免得转位时顶到边界
    center = lo + (hi - lo) // 2
    prev_bar = [n for n in prev if n[scorelib.N_BAR] == bar - 1]
    targets = sorted(n[scorelib.N_PITCH] for n in prev_bar) or [center - 4, center + 3]

    out: list[list] = []
    used: set[int] = set()
    for t in targets[:3]:
        p = _pick(chord["pcs"], t, lo, hi)
        # 两个声部撞到同一个音就往上找一个，否则听起来会少一层
        while p is not None and p in used:
            nxt = _pick([pc for pc in chord["pcs"] if pc != p % 12], p + 2, lo, hi)
            if nxt is None or nxt in used:
                break
            p = nxt
        if p is None or p in used:
            continue
        used.add(p)
        out.append([bar, 1.0, float(bpb), p, int(vel)])
    return out


def _melody(bar: int, bpb: int, chord: dict, blueprint: dict, lo: int, hi: int,
            vel: float, prev: list[list], rng: random.Random) -> list[list]:
    """旋律：强拍取和弦音，弱拍走级进，两小节一句、句尾留白。

    留白是刻意的。不留的话旋律会变成一条从头响到尾的连续音流 —— 听起来不像
    人在演奏，指挥起来也没有可以「收」的地方。
    """
    key = scorelib.parse_key(blueprint["key"])
    scale = scorelib.scale_pcs(key)
    # 旋律放在音区上三分之一，才浮得到和声上面
    anchor = lo + (hi - lo) * 2 // 3
    last = prev[-1][scorelib.N_PITCH] if prev else anchor

    out: list[list] = []
    # 每四小节的最后一拍空出来换气
    breathe = (bar % 4 == 0)
    beat = 1.0
    while beat <= bpb - (1 if breathe else 0) + 0.01:
        strong = abs(beat - round(beat)) < 1e-6 and int(round(beat)) in (1, 3)
        pcs = chord["pcs"] if strong else scale
        # 目标音在上一个音附近游走，跨度控制在五度以内 —— 大跳听着像在乱蹦
        target = last + rng.choice([-4, -2, -1, 1, 2, 3, 5])
        p = _pick(pcs, max(lo, min(hi, target)), lo, hi)
        if p is None:
            break
        dur = 1.0 if strong else 0.5
        out.append([bar, beat, dur, p, int(vel * (1.0 if strong else 0.82))])
        last = p
        beat += dur
    return out


def _timpani(bar: int, bpb: int, chord: dict, blueprint: dict, lo: int, hi: int,
             vel: float) -> list[list]:
    """定音鼓：强拍上敲主音或属音。

    真实的定音鼓一次只调得出两三个音（演奏中间来不及换调），所以这里只用调式
    的主音和属音，并且**按当前和弦挑那个属于和弦的**：和弦里有主音就敲主音，
    没有就敲属音。这条约束不是为了省事，是定音鼓的物理事实。
    """
    key = scorelib.parse_key(blueprint["key"])
    tonic = key["tonic_pc"]
    dominant = (tonic + 7) % 12
    pick_pc = tonic if tonic in chord["pcs"] else (
        dominant if dominant in chord["pcs"] else chord["root_pc"])
    p = _pick([pick_pc], lo + (hi - lo) // 3, lo, hi)
    if p is None:
        return []

    out = [[bar, 1.0, 1.0, p, int(vel)]]
    # 四拍子里第三拍补一下，是进行曲式的支撑；三拍子不补，否则圆舞曲会变得很重
    if bpb >= 4:
        out.append([bar, 3.0, 1.0, p, int(vel * 0.72)])
    return out


def _percussion(bar: int, bpb: int, sec: dict, vel: float, rng: random.Random) -> list[list]:
    """管弦乐打击乐：大鼓、小军鼓、吊镲、三角铁。

    **不是爵士鼓组。** 管弦乐队里没有踩镲，也不会有人从头到尾打 2/4 反拍 ——
    打击乐在管弦乐里是**强调**，不是节拍垫底。所以这里的写法是：大鼓压强拍，
    小军鼓只在强度够高时打进行曲式的短音型，吊镲只在段落起头和高潮砸，
    三角铁只在轻的段落点缀。安静的段落可以整段不出声，那是正常的。
    """
    out: list[list] = []
    inten = sec["intensity"]

    # 强度很低的段落，打击乐就该沉默 —— 让弦乐和木管自己说话
    if inten < 0.25:
        return out

    # 大鼓：每小节第一拍。强度高时四拍子的第三拍再补一下
    out.append([bar, 1.0, 1.0, 35, int(vel)])
    if bpb >= 4 and inten > 0.7:
        out.append([bar, 3.0, 1.0, 35, int(vel * 0.72)])

    # 小军鼓：进行曲式的「长短短」音型，只在中高强度出现，且隔小节才来一次，
    # 免得变成连续的节拍垫
    if inten > 0.5 and bar % 2 == 0:
        # 小节末尾的「短—长」把下一小节推出去，是进行曲最常见的连接音型
        out.append([bar, max(1.0, bpb - 0.5), 0.25, 38, int(vel * 0.55)])
        out.append([bar, float(bpb), 0.5, 38, int(vel * 0.72)])

    # 吊镲：段落开头砸一下，高潮段落再多给一次
    if bar == sec["start_bar"] and inten > 0.45:
        out.append([bar, 1.0, 2.0, 49, int(vel * 0.9)])
    elif sec.get("is_climax") and bar % 4 == 1:
        out.append([bar, 1.0, 2.0, 52, int(vel * 0.75)])

    # 三角铁：轻盈段落的点缀。和吊镲互斥，两个一起响会糊成一片金属声
    if 0.25 <= inten <= 0.5 and bar % 2 == 1:
        out.append([bar, float(bpb), 0.5, 81, int(vel * 0.5)])

    return out


# ---------------- 语言模型作曲 ----------------

_SYSTEM = """你是一位管弦乐编配者。你的任务是为**一件乐器**写出它在整首曲子里的音符。

只输出一个 JSON 对象，形如：
{"notes": [[小节, 拍, 时值, 音高, 力度], ...]}

字段含义（全部是数字）：
- 小节：从 1 开始，不得超过给定的总小节数
- 拍：从 1 开始，可带小数，必须是 0.25 的整数倍，且小于「每小节拍数 + 1」
- 时值：以拍为单位，最小 0.25，允许跨小节
- 音高：MIDI 音高，必须落在给定的音域内
- 力度：1–127

硬性要求：
1. 严格使用给定的调性与每小节的和弦。强拍上用和弦音，经过音只放在弱拍。
2. 不要写超出音域的音。
3. 同时发声的音不要超过给定的上限。
4. 尊重「参与的小节」：没列出的小节一个音都不要写。
5. 与已有声部配合：不要和它们抢同一个音区，节奏上要互补而不是齐奏。
6. 乐句要有呼吸，不要从头到尾密不透风。

不要输出任何解释文字，不要用 markdown 围栏。"""

# 一件乐器的音符表就能上千个数字，默认的 max_tokens 根本不够。
_PART_MAX_TOKENS = 12000

# 从**残缺**的输出里捞音符用的。匹配任何完整的 4~5 个数字的数组。
_NOTE_RE = re.compile(
    r"\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,"
    r"\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)"
    r"(?:\s*,\s*(-?\d+(?:\.\d+)?))?\s*\]"
)


def _salvage_notes(text: str) -> list[list[float]]:
    """从模型输出里把音符捞出来，**不要求整段是合法 JSON**。

    实测最常见的失败就是音符表太长、在 max_tokens 处被截断，回来一段以
    `[[1,1,1,62,90],[1,2,...` 结尾的半截 JSON。`json.loads` 对它无能为力，
    但前面那几百个音符是完好的 —— 丢掉整份重来既慢又费钱，而少了最后几小节
    的谱子照样能用（缺的部分下次「重新生成」再补）。

    先按正常 JSON 试，失败了才用正则逐个捞完整的数组。
    """
    stripped = text.strip()
    fence = re.search(r"```(?:json)?\s*(.+?)```", stripped, re.S)
    if fence:
        stripped = fence.group(1).strip()
    try:
        obj = json.loads(stripped)
        if isinstance(obj, dict) and isinstance(obj.get("notes"), list):
            return obj["notes"]
        if isinstance(obj, list):
            return obj
    except (json.JSONDecodeError, TypeError):
        pass

    out: list[list[float]] = []
    for m in _NOTE_RE.finditer(stripped):
        g = m.groups()
        vals = [float(x) for x in g[:4]]
        vals.append(float(g[4]) if g[4] is not None else 80.0)
        out.append(vals)
    return out


def _digest_existing(parts: list[dict], beats_per_bar: int) -> str:
    """已有声部的**压缩视图**。

    旋律声部给全量音符（新声部要能跟着它走），其余只给每小节的音符数与音区。
    不压缩的话，写到第八件乐器时输入里已经堆了七份完整谱子，token 直接爆掉。
    """
    if not parts:
        return "（这是第一件乐器，没有已有声部。）"
    lines = []
    for p in parts:
        name = p.get("library_key") or "?"
        notes = p.get("notes") or []
        if p.get("role") == "melody" and len(notes) <= 220:
            lines.append(f"- {name}（旋律，全量）：{json.dumps(notes, separators=(',', ':'))}")
            continue
        per_bar: dict[int, list[int]] = {}
        for n in notes:
            per_bar.setdefault(int(n[scorelib.N_BAR]), []).append(int(n[scorelib.N_PITCH]))
        brief = ", ".join(
            f"{bar}小节:{len(ps)}音/音区{min(ps)}-{max(ps)}"
            for bar, ps in sorted(per_bar.items())[:40]
        )
        lines.append(f"- {name}（{p.get('role')}）：{brief or '无音符'}")
    return "\n".join(lines)


class LLMComposer(Composer):
    """走已有的 BYOK 通路。白名单、限流、key 只存后端全是现成的（见 llm.py）。

    **任何一步失败都退到算法作曲，而不是让「生成」按钮报错。** 用户点生成
    是想要音乐，不是想看一段 502。退化的事实会如实写进 take 的 params，
    前端能显示成「这一条是本地作曲写的」，不会假装是模型写的。
    """

    name = "llm"

    def __init__(self):
        self._fallback = AlgorithmicComposer()

    async def blueprint(self, project: dict) -> dict:
        bp = skeleton(project)
        key = scorelib.parse_key(bp["key"])
        triads = scorelib.diatonic_triads(key)
        sections = "\n".join(
            f"- {s['label']}：第 {s['start_bar']}–{s['end_bar']} 小节，"
            f"强度 {s['intensity']:.2f}{'（高潮）' if s['is_climax'] else ''}"
            for s in bp["sections"]
        )
        user = (
            f"为一首管弦乐曲写和声走向。\n"
            f"调性：{bp['key']}；拍号：{bp['time_signature']}；速度：{bp['bpm']} BPM；"
            f"共 {bp['bars']} 小节。\n"
            f"风格：{project.get('style_description') or '管弦乐'}\n"
            f"段落：\n{sections}\n\n"
            f"调内可用的和弦：{', '.join(triads)}。也可以用 7 / maj7 / m7 / sus4，"
            f"以及 /低音 形式的转位。\n"
            f'只输出 JSON：{{"chords": ["每小节一个和弦符号", ...]}}，'
            f"数组长度必须正好是 {bp['bars']}。"
            f"每段最后一小节要有收束感，全曲最后一小节回主和弦。"
        )
        try:
            raw = await llmlib.chat_json(
                "你是一位作曲家。只输出 JSON，不要任何解释。", user, temperature=0.5)
        except llmlib.LLMError as e:
            # 和声表只是给分谱当参考，拿不到就用调内级数自己排一套，
            # 没必要为此让整首曲子生不出来
            logger.warning("和声走向调用语言模型失败（%s），改用规则生成", e)
            bp = await self._fallback.blueprint(project)
            bp["created_by"] = "algorithmic"
            bp["fallback_reason"] = f"和声：{e}"
            return bp

        chords = [str(c) for c in (raw.get("chords") or []) if isinstance(c, (str, int))]
        # 长度对不上就用主和弦补齐/截断，而不是报错 —— 和声表只是参考，
        # 真正的约束在每个声部的校验里（score.validate_and_repair_part）。
        while len(chords) < bp["bars"]:
            chords.append(triads[0])
        bp["chords"] = chords[: bp["bars"]]
        bp["created_by"] = "llm"
        return bp

    async def compose_part(self, *, project, instrument, blueprint, existing_parts, seed):
        library_key = instrument.get("library_key") or ""
        role = instrument.get("role") or "harmony"
        lo, hi = scorelib.instrument_range(library_key)
        perc = scorelib.is_percussion(library_key)
        bpb = int(blueprint["beats_per_bar"])
        bars = int(blueprint["bars"])

        active = [b for b in range(1, bars + 1)
                  if _participation_at(project, instrument, blueprint, b) > 0.02]
        chord_lines = "\n".join(
            f"{b}: {blueprint['chords'][b - 1]}" for b in range(1, bars + 1))

        if perc:
            pitch_rule = ("这是鼓组，走 MIDI 第 10 通道，音高数字代表鼓件，只能用："
                          + "、".join(f"{k}={v}" for k, v in sorted(scorelib.DRUM_KEYS.items())))
        else:
            pitch_rule = f"音域：MIDI {lo}–{hi}（含端点），一个音都不要超出。"

        user = (
            f"乐器：{instrument.get('display_name') or library_key}"
            f"（角色：{role}）\n"
            f"{pitch_rule}\n"
            f"同时发声上限：{scorelib.POLYPHONY.get('rhythm' if perc else role, 4)} 个音\n"
            f"调性：{blueprint['key']}；拍号：{blueprint['time_signature']}；"
            f"速度：{blueprint['bpm']} BPM；每小节 {bpb} 拍；共 {bars} 小节。\n"
            f"风格：{project.get('style_description') or '管弦乐'}\n"
            f"要写音符的小节：{_ranges(active)}\n"
            f"每小节的和弦：\n{chord_lines}\n\n"
            f"已有声部：\n{_digest_existing(existing_parts, bpb)}\n"
            f"\n随机种子 {seed}：同样的输入换个种子应当写出不同但同样合理的一版。"
        )
        # 用 chat_text 而不是 chat_json：那边解析失败就整份丢掉重试，而这里
        # **拿到原始文本才能抢救**。音符表被 max_tokens 截断是最常见的失败，
        # 而截断前的几百个音符是完好的，丢掉它们重来既慢又费额度。
        try:
            text = await llmlib.chat_text(
                [{"role": "system", "content": _SYSTEM},
                 {"role": "user", "content": user}],
                temperature=0.8, max_tokens=_PART_MAX_TOKENS,
            )
        except llmlib.LLMError as e:
            logger.warning("分谱调用语言模型失败（%s），改用规则作曲", e)
            raw = await self._fallback.compose_part(
                project=project, instrument=instrument, blueprint=blueprint,
                existing_parts=existing_parts, seed=seed)
            raw["source"] = "algorithmic"
            raw["fallback_reason"] = str(e)
            return raw

        notes = _salvage_notes(text)
        if not notes:
            logger.warning("语言模型没给出可用的音符（返回 %d 字），改用规则作曲", len(text))
            raw = await self._fallback.compose_part(
                project=project, instrument=instrument, blueprint=blueprint,
                existing_parts=existing_parts, seed=seed)
            raw["source"] = "algorithmic"
            raw["fallback_reason"] = "模型输出里没有可识别的音符"
            return raw

        out: dict = {"notes": notes, "source": "llm"}
        if not text.rstrip().endswith(("]}", "]", "}")):
            # 收尾不完整说明被截断了。音符照用，但要让用户知道后面缺了一截。
            out["fallback_reason"] = "模型输出被截断，已保留截断前的音符"
        return out


def _ranges(bars: list[int]) -> str:
    """[1,2,3,7,8] → '1-3, 7-8'。逐个列出来会占掉几百个 token。"""
    if not bars:
        return "（无）"
    out, start, prev = [], bars[0], bars[0]
    for b in bars[1:]:
        if b == prev + 1:
            prev = b
            continue
        out.append(f"{start}-{prev}" if prev > start else f"{start}")
        start = prev = b
    out.append(f"{start}-{prev}" if prev > start else f"{start}")
    return ", ".join(out)


# ---------------- 外部符号音乐模型 ----------------

class RemoteSymbolicComposer(Composer):
    """指向任意符号音乐模型服务（Anticipatory Music Transformer、MMM 之类，
    自己包一层薄 HTTP 即可）。契约见 docs/SYMBOLIC_COMPOSER_API.md。

    和弦走向仍然本地算：符号模型擅长续写音符，不擅长按段落强度规划全曲结构，
    而后者恰好是纯规则做得又快又稳的部分。
    """

    name = "remote"

    def __init__(self, url: Optional[str] = None):
        self.url = (url or config.SYMBOLIC_COMPOSER_URL or "").rstrip("/")
        self._fallback = AlgorithmicComposer()

    async def blueprint(self, project: dict) -> dict:
        bp = await self._fallback.blueprint(project)
        bp["created_by"] = "remote"
        return bp

    async def compose_part(self, *, project, instrument, blueprint, existing_parts, seed):
        if not self.url:
            raise ComposerError(
                "SCORE_COMPOSER=remote 但没有配置 SYMBOLIC_COMPOSER_URL。")
        payload = {
            "blueprint": blueprint,
            "instrument": {
                "library_key": instrument.get("library_key"),
                "display_name": instrument.get("display_name"),
                "role": instrument.get("role"),
                "gm_program": scorelib.instrument_program(instrument.get("library_key") or ""),
                "range": list(scorelib.instrument_range(instrument.get("library_key") or "")),
                "percussion": scorelib.is_percussion(instrument.get("library_key") or ""),
                "active_bars": [
                    b for b in range(1, int(blueprint["bars"]) + 1)
                    if _participation_at(project, instrument, blueprint, b) > 0.02
                ],
            },
            "existing_parts": existing_parts,
            "style": project.get("style_description") or "",
            "seed": seed,
        }
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                resp = await client.post(f"{self.url}/compose_part", json=payload)
                resp.raise_for_status()
                return resp.json()
        except httpx.HTTPStatusError as e:
            raise ComposerError(
                f"符号模型服务返回 HTTP {e.response.status_code}") from None
        except httpx.RequestError as e:
            raise ComposerError(f"连不上符号模型服务：{type(e).__name__}") from None


# ---------------- 选择 ----------------

def composer_status() -> dict:
    """给 /api/health 用。"""
    choice = config.active_composer_choice().strip().lower()
    llm_ready = bool(llmlib.public_status().get("ready"))
    if choice == "llm":
        active = "llm" if llm_ready else "algorithmic"
    elif choice == "remote":
        active = "remote" if config.SYMBOLIC_COMPOSER_URL else "algorithmic"
    elif choice == "algorithmic":
        active = "algorithmic"
    else:
        active = "llm" if llm_ready else "algorithmic"
    return {
        "composer": active,
        "composer_configured": choice,
        "llm_ready": llm_ready,
        "remote_url": config.SYMBOLIC_COMPOSER_URL,
    }


def get_composer() -> Composer:
    """按配置选。**永远返回一个能用的作曲器** —— 没配 key 就退到算法作曲，
    而不是让「生成」按钮报错。和生成后端不可用时回退 synth 是同一个思路。"""
    active = composer_status()["composer"]
    if active == "llm":
        return LLMComposer()
    if active == "remote":
        return RemoteSymbolicComposer()
    return AlgorithmicComposer()
