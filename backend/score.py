"""符号乐谱：数据结构、时间换算、和弦解析、校验修复（M7）。

**纯函数模块，不 import 任何后端里有副作用的东西**，因此可以离线跑断言
（见 M7 计划的验证一节）。作曲器（composer.py）产出这里定义的结构，
渲染器（render.py）消费它。

为什么音符是定长数组 `[bar, beat, dur_beats, midi, velocity]` 而不是对象：
一首 32 小节 8 声部的曲子上千个音符，写成 `{"bar":1,"beat":1,...}` 光键名就
吃掉几千 token，而这些结构是要塞进语言模型的提示词、再由它原样吐回来的。

坐标约定（和乐谱习惯一致，不是从 0 开始）：
  bar  从 1 起
  beat 从 1 起，可小数（beat 3.5 = 第三拍后半）
  dur_beats 以拍为单位，允许跨小节
"""
from __future__ import annotations

import math
from typing import Optional

try:
    from .config import get_instrument_spec
except Exception:
    from config import get_instrument_spec


SCORE_SCHEMA_VERSION = 1

# 音符数组的下标。到处写 n[3] 没人看得懂，但又不值得为它建一个类
# —— 这些数组会被成千上万地创建，dataclass 的开销和可读性收益不成比例。
N_BAR, N_BEAT, N_DUR, N_PITCH, N_VEL = 0, 1, 2, 3, 4

# ---- 修复规则的阈值 ----
QUANTIZE_BEAT = 0.25      # beat 吸附到 1/4 拍（十六分音符）网格
MIN_DUR_BEATS = 0.125     # 时值下限，再短渲染出来就只剩一声"咔"
MAX_VELOCITY, MIN_VELOCITY = 127, 1

# 同一声部同时能发几个音。模型很爱给单簧管写六个音的柱式和弦 —— 那是
# 一件单音乐器。角色不在表里的按 harmony 处理。
POLYPHONY = {"melody": 2, "harmony": 4, "bass": 2, "rhythm": 8}

# ---- 打击乐 ----
# GM 第 10 通道（0 起算就是 9）上音高数字是**鼓件编号不是音高**，所以
# 既不能做八度移位，也不能按音域钳制。限定成这 8 件，模型只能从中挑。
PERCUSSION_CHANNEL = 9
DRUM_KEYS = {
    35: "大鼓", 38: "军鼓", 42: "闭镲", 45: "低嗵",
    46: "开镲", 47: "中嗵", 49: "吊镲", 51: "叮叮镲",
}

# 自定义乐器（不在 INSTRUMENT_LIBRARY 里）的兜底音色与音域：
# 弦乐合奏音色 + C3–C6，是一个"放哪件乐器上都不至于离谱"的中庸选择。
FALLBACK_PROGRAM = 48
FALLBACK_RANGE = (48, 84)


# ---------------- 乐器元数据 ----------------

def instrument_program(library_key: str) -> int:
    spec = get_instrument_spec(library_key)
    return int(spec.get("gm_program", FALLBACK_PROGRAM))


def instrument_range(library_key: str) -> tuple[int, int]:
    spec = get_instrument_spec(library_key)
    rng = spec.get("range") or FALLBACK_RANGE
    lo, hi = int(rng[0]), int(rng[1])
    return (lo, hi) if lo <= hi else (hi, lo)


def is_percussion(library_key: str) -> bool:
    """走鼓组通道的乐器。定音鼓**不算** —— 它是有音高的，按普通规则处理。"""
    return get_instrument_spec(library_key).get("percussion") is True


def instrument_channel(library_key: str) -> int:
    return PERCUSSION_CHANNEL if is_percussion(library_key) else 0


# ---------------- 时间换算 ----------------

def parse_time_signature(ts: str) -> tuple[int, int]:
    """'3/4' → (3, 4)。解析不了就按 4/4。"""
    try:
        num, den = str(ts).split("/")
        n, d = int(num), int(den)
        if 1 <= n <= 16 and d in (2, 4, 8, 16):
            return n, d
    except (ValueError, AttributeError):
        pass
    return 4, 4


def beat_seconds(bpm: float, beat_unit: int = 4) -> float:
    """一拍多少秒。

    bpm 按惯例是**四分音符**的速度，所以 6/8 这种以八分音符为一拍的拍号，
    一拍只有四分音符的一半长。指挥教学那边只支持 2/3/4 拍（见
    `lib/teaching/patterns.ts` 的 Meter），这条分支目前用不到，但换算写对
    了不花钱，写错了以后很难查。
    """
    return (60.0 / max(1e-6, float(bpm))) * (4.0 / max(1, beat_unit))


def bar_seconds(bpm: float, beats_per_bar: int, beat_unit: int = 4) -> float:
    return beats_per_bar * beat_seconds(bpm, beat_unit)


def bar_beat_to_seconds(bar: float, beat: float, bpm: float,
                        beats_per_bar: int, beat_unit: int = 4) -> float:
    """(bar, beat) → 从曲子开头算起的秒数。bar/beat 都从 1 起。"""
    total_beats = (bar - 1) * beats_per_bar + (beat - 1)
    return total_beats * beat_seconds(bpm, beat_unit)


def bars_for_duration(total_seconds: float, bpm: float, beats_per_bar: int,
                      beat_unit: int = 4) -> int:
    """秒 → 最接近的整小节数，至少 1 小节。

    score 模式下**小节是唯一真值**，项目时长反过来被改写成整小节。
    不这么定的话每次秒↔小节换算都在积累误差，而多轨循环播放对长度
    是零容忍的：差一个采样，放几圈就散了。
    """
    bs = bar_seconds(bpm, beats_per_bar, beat_unit)
    return max(1, int(round(float(total_seconds) / bs))) if bs > 0 else 1


def exact_duration(bars: int, bpm: float, beats_per_bar: int,
                   beat_unit: int = 4) -> float:
    return bars * bar_seconds(bpm, beats_per_bar, beat_unit)


# ---------------- 和弦 ----------------

_PITCH_CLASS = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}

# 和弦性质 → 相对根音的半音集合。键按**长度倒序**匹配，否则 "maj7" 会先被
# "maj" 吃掉、"m7" 会先被 "m" 吃掉。
_QUALITIES: dict[str, tuple[int, ...]] = {
    "": (0, 4, 7),
    "maj": (0, 4, 7),
    "maj7": (0, 4, 7, 11),
    "m": (0, 3, 7),
    "min": (0, 3, 7),
    "m7": (0, 3, 7, 10),
    "min7": (0, 3, 7, 10),
    "7": (0, 4, 7, 10),
    "dim": (0, 3, 6),
    "aug": (0, 4, 8),
    "sus2": (0, 2, 7),
    "sus4": (0, 5, 7),
}

# 给提示词用：告诉模型合法的写法只有这些
CHORD_QUALITIES = sorted(q for q in _QUALITIES if q)


def _root_pc(text: str) -> Optional[tuple[int, str]]:
    """吃掉开头的根音，返回 (音级, 剩下的部分)。"""
    if not text:
        return None
    pc = _PITCH_CLASS.get(text[0].lower())
    if pc is None:
        return None
    rest = text[1:]
    if rest[:1] == "#":
        pc, rest = (pc + 1) % 12, rest[1:]
    elif rest[:1] == "b":
        # 'Bb' 是降 B，但 'Bm' 的 m 不是降号 —— 只有当下一个字符不构成
        # 已知性质时才把 b 当降号。实际上 'b' 开头的性质一个都没有，
        # 所以这里可以直接吃掉。
        pc, rest = (pc - 1) % 12, rest[1:]
    return pc, rest


def parse_chord(symbol: str) -> dict:
    """和弦符号 → {root_pc, pcs, bass_pc, symbol, resolved}。

    `resolved` 是 "exact" 或 "fallback"。**永远不抛异常** —— 解析不了就
    退化成同名大三和弦（再不行就 C 大三），由调用方决定要不要记一条 warning。
    和声数据只是作曲的参考，不值得为一个写错的和弦让整次生成失败。
    """
    raw = (symbol or "").strip()
    head = raw.split("/", 1)
    body, bass_txt = head[0].strip(), (head[1].strip() if len(head) > 1 else "")

    parsed = _root_pc(body)
    if parsed is None:
        return {"root_pc": 0, "pcs": [0, 4, 7], "bass_pc": 0,
                "symbol": raw or "C", "resolved": "fallback"}

    root, rest = parsed
    quality = rest.strip()
    intervals = _QUALITIES.get(quality)
    resolved = "exact"
    if intervals is None:
        intervals = _QUALITIES[""]
        resolved = "fallback"

    bass_pc = root
    if bass_txt:
        b = _root_pc(bass_txt)
        if b is not None:
            bass_pc = b[0]
        else:
            resolved = "fallback"

    return {
        "root_pc": root,
        "pcs": [(root + i) % 12 for i in intervals],
        "bass_pc": bass_pc,
        "symbol": raw,
        "resolved": resolved,
    }


def pitch_in_chord(pitch: int, chord: dict) -> bool:
    return (pitch % 12) in chord["pcs"]


def nearest_chord_pitch(target: int, chord: dict, lo: int, hi: int) -> Optional[int]:
    """离 target 最近、且落在 [lo, hi] 内的和弦音。找不到返回 None。"""
    best, best_d = None, 10 ** 9
    for pc in chord["pcs"]:
        # 把这个音级的所有八度都试一遍（MIDI 全音域也就 11 个八度）
        base = pc + 12 * ((lo - pc) // 12)
        for p in range(base, hi + 1, 12):
            if p < lo:
                continue
            d = abs(p - target)
            if d < best_d:
                best, best_d = p, d
    return best


# ---------------- 校验与修复 ----------------

def _warn(warnings: list, code: str, message: str) -> None:
    """warnings 用 {code, message} 形状 —— 和 configuration.py 的构型校验
    一致，前端 FormationWarning 那套渲染方式可以直接复用。同 code 只留一条，
    但把条数累计进消息里，不然一百个越界音符会刷出一百行。"""
    for w in warnings:
        if w["code"] == code:
            w["count"] = w.get("count", 1) + 1
            return
    warnings.append({"code": code, "message": message, "count": 1})


def _finalize_warnings(warnings: list) -> list:
    out = []
    for w in warnings:
        n = w.pop("count", 1)
        out.append({"code": w["code"],
                    "message": f"{w['message']}（{n} 处）" if n > 1 else w["message"]})
    return out


def _coerce_note(raw) -> Optional[list]:
    """把模型给的一条音符转成 [bar, beat, dur, pitch, vel]。

    同时接受数组和对象两种写法 —— 提示词里要求的是数组，但模型偶尔会
    自作主张写成对象，为这个报错不值得。
    """
    if isinstance(raw, dict):
        try:
            return [float(raw.get("bar", 1)), float(raw.get("beat", 1)),
                    float(raw.get("dur", raw.get("dur_beats", 1))),
                    float(raw.get("pitch", raw.get("midi", 60))),
                    float(raw.get("vel", raw.get("velocity", 80)))]
        except (TypeError, ValueError):
            return None
    if isinstance(raw, (list, tuple)) and len(raw) >= 4:
        try:
            vel = float(raw[4]) if len(raw) >= 5 else 80.0
            return [float(raw[0]), float(raw[1]), float(raw[2]), float(raw[3]), vel]
        except (TypeError, ValueError):
            return None
    return None


def _fit_range(pitch: int, lo: int, hi: int) -> Optional[int]:
    """八度移位进音域。移不进去（音域窄于一个八度）返回 None。

    刻意不做硬钳：把越界音一律压到边界上，一句旋律会被压成一条直线，
    听起来比丢掉那个音还糟。
    """
    if pitch < lo:
        pitch += 12 * int(math.ceil((lo - pitch) / 12.0))
    if pitch > hi:
        pitch -= 12 * int(math.ceil((pitch - hi) / 12.0))
    return pitch if lo <= pitch <= hi else None


def _drop_overlaps(notes: list, warnings: list) -> list:
    """同音高重叠时截短前一个。

    不处理的话 MIDI 里前一个音的 note_off 会把后一个音一起关掉 ——
    表现为"后面那个音只响了一下就没了"，很难查。
    """
    last_end: dict[int, int] = {}   # pitch → 该音高上一个音符在 notes 里的下标
    for i, n in enumerate(notes):
        p = int(n[N_PITCH])
        j = last_end.get(p)
        if j is not None:
            prev = notes[j]
            prev_end = prev[N_ABS] + prev[N_DUR]
            if prev_end > n[N_ABS]:
                prev[N_DUR] = max(MIN_DUR_BEATS, n[N_ABS] - prev[N_ABS])
                _warn(warnings, "note_overlap", "同音高的音符重叠，前一个已被截短")
        last_end[p] = i
    return notes


# 排序/去重叠阶段临时挂在音符末尾的绝对拍位置（第 6 项）。
# 只在本模块内部存在，返回前会被切掉。
N_ABS = 5


def _limit_polyphony(notes: list, limit: int, warnings: list) -> list:
    """限制同时发声数，超出的丢掉 velocity 最小的那个。

    按起始时间扫一遍，维护"此刻还在响"的集合。丢弱不丢强，是因为强拍
    上的重音承担的是节奏功能，丢了整条声部的骨架就散了。
    """
    kept: list[list] = []
    for n in notes:
        start = n[N_ABS]
        active = [k for k in kept if k[N_ABS] + k[N_DUR] > start + 1e-9]
        if len(active) < limit:
            kept.append(n)
            continue
        weakest = min(active + [n], key=lambda k: (k[N_VEL], -k[N_ABS]))
        _warn(warnings, "polyphony_exceeded",
              f"同时发声超过 {limit} 个，已丢弃力度最弱的音")
        if weakest is n:
            continue
        kept.remove(weakest)
        kept.append(n)
        kept.sort(key=lambda k: k[N_ABS])
    return kept


def validate_and_repair_part(raw: dict, *, instrument: dict, blueprint: dict) -> dict:
    """把作曲器（语言模型或算法）给的一份声部整成可渲染的 Part。

    **修复而不是报错**。`llm.chat_json` 对构型的态度是"宁可报错也不落一个
    半残结构"，音符不一样：一个越界音符不该让整次生成失败，何况模型写
    几百个音符总会有那么几个出格。修了什么如实记进 warnings，前端显示成
    「3 个音符被移了八度」，而不是悄悄改掉。
    """
    warnings: list = []
    library_key = instrument.get("library_key") or "custom"
    role = instrument.get("role") or "harmony"
    bars = int(blueprint["bars"])
    bpb = int(blueprint["beats_per_bar"])
    perc = is_percussion(library_key)
    lo, hi = instrument_range(library_key)
    total_beats = bars * bpb

    prepared: list[list] = []
    for raw_note in (raw.get("notes") or []):
        n = _coerce_note(raw_note)
        if n is None:
            _warn(warnings, "note_unparsable", "有音符格式不对，已跳过")
            continue

        bar = int(round(n[N_BAR]))
        if bar < 1 or bar > bars:
            _warn(warnings, "bar_out_of_range", f"小节号超出 1–{bars} 的范围，已丢弃")
            continue

        # beat 吸附到 1/4 拍网格 —— 模型很爱写 3.07 这种数
        beat = round(n[N_BEAT] / QUANTIZE_BEAT) * QUANTIZE_BEAT
        if beat < 1:
            beat = 1.0
            _warn(warnings, "beat_clamped", "拍位小于 1，已拉回小节开头")
        if beat >= bpb + 1:
            _warn(warnings, "beat_out_of_range", f"拍位超出 1–{bpb} 的范围，已丢弃")
            continue

        abs_beat = (bar - 1) * bpb + (beat - 1)
        dur = max(MIN_DUR_BEATS, round(n[N_DUR] / QUANTIZE_BEAT) * QUANTIZE_BEAT)
        # 允许跨小节，但不能超出全曲 —— 超出的部分渲染时会被裁掉，
        # 与其留个对不上的时值，不如在这里就截齐。
        if abs_beat + dur > total_beats:
            dur = max(MIN_DUR_BEATS, total_beats - abs_beat)

        pitch = int(round(n[N_PITCH]))
        if perc:
            if pitch not in DRUM_KEYS:
                _warn(warnings, "drum_key_unknown",
                      "打击乐用了不认识的鼓件编号，已丢弃")
                continue
        else:
            fitted = _fit_range(pitch, lo, hi)
            if fitted is None:
                _warn(warnings, "pitch_unfittable",
                      f"音高进不了 {lo}–{hi} 的音域，已丢弃")
                continue
            if fitted != pitch:
                _warn(warnings, "pitch_octave_shifted",
                      f"音高超出音域，已移八度进 {lo}–{hi}")
            pitch = fitted

        vel = int(max(MIN_VELOCITY, min(MAX_VELOCITY, round(n[N_VEL]))))
        prepared.append([bar, beat, dur, pitch, vel, abs_beat])

    prepared.sort(key=lambda k: (k[N_ABS], k[N_PITCH]))
    prepared = _drop_overlaps(prepared, warnings)
    prepared = _limit_polyphony(
        prepared, POLYPHONY.get("rhythm" if perc else role, POLYPHONY["harmony"]), warnings)
    prepared.sort(key=lambda k: (k[N_ABS], k[N_PITCH]))

    notes = [[k[N_BAR], round(k[N_BEAT], 3), round(k[N_DUR], 3),
              k[N_PITCH], k[N_VEL]] for k in prepared]
    if not notes:
        _warn(warnings, "part_empty", "这件乐器最后一个音符都没剩下")

    return {
        "schema_version": SCORE_SCHEMA_VERSION,
        "instrument_id": instrument.get("id"),
        "library_key": library_key,
        "role": role,
        "gm_program": instrument_program(library_key),
        "channel": instrument_channel(library_key),
        "blueprint_revision": int(blueprint.get("revision") or 1),
        "notes": notes,
        "warnings": _finalize_warnings(warnings),
    }


# ---------------- 查询辅助 ----------------

def part_end_beats(part: dict, beats_per_bar: int) -> float:
    """最后一个音符的结束位置（绝对拍）。渲染时用它算尾巴要多长。"""
    end = 0.0
    for n in part.get("notes") or []:
        e = (n[N_BAR] - 1) * beats_per_bar + (n[N_BEAT] - 1) + n[N_DUR]
        if e > end:
            end = e
    return end


def part_note_events(part: dict, bpm: float, beats_per_bar: int,
                     beat_unit: int = 4) -> list[dict]:
    """Part → 以秒计的音符事件，渲染器直接消费。"""
    bs = beat_seconds(bpm, beat_unit)
    out = []
    for n in part.get("notes") or []:
        start_beat = (n[N_BAR] - 1) * beats_per_bar + (n[N_BEAT] - 1)
        out.append({
            "start": start_beat * bs,
            "dur": n[N_DUR] * bs,
            "pitch": int(n[N_PITCH]),
            "velocity": int(n[N_VEL]),
        })
    out.sort(key=lambda e: (e["start"], e["pitch"]))
    return out


def blueprint_chord(blueprint: dict, bar: int) -> dict:
    """取第 bar 小节的和弦。越界或缺失时回到第一个和弦（而不是报错）。"""
    chords = blueprint.get("chords") or []
    if not chords:
        return parse_chord("C")
    idx = min(max(1, int(bar)), len(chords)) - 1
    return parse_chord(chords[idx])
