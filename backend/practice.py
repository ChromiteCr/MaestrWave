"""指挥练习曲与考试曲目：直接写谱、渲染成一条音轨（M7e）。

## 为什么用 MIDI 而不是 text2music

M6 计划原本要新开 `/api/practice/generate` 调天琴 `text2music`，并配一套
「能量起始点检测 + 置信度低时让用户跟拍手动校准」来找拍网格的相位。
换成符号乐谱之后，那一整套东西直接不需要了：

1. **拍网格是写下的，不是测出来的。** 音符的 `(bar, beat)` 就是真值，
   第一小节第一拍精确落在数拍结束那一刻，误差是零而不是「检测置信度 0.8」。
2. **可复现。** 考试要求所有人考同一首、同一个速度 —— 生成模型每次给的都不
   一样，而同一份 spec 在这里永远渲染出同一份字节。「固定曲目」因此不需要往
   仓库里塞音频文件（`exam.ts` 里那三个 `audio: null` 就是在等这个）。
3. **每小节的力度是写下的。** 「力度对应」那一维要的是「音乐此刻该多响」，
   拿渲染出来的音频测 RMS 只能得到一个被混响和配器污染过的近似值，而这里
   直接就有作曲时的意图值。这一维从「待接入」变成能评，靠的就是这一点。
4. 不要密钥、不要联网、不用等三百秒。没配天琴的人也能考试。

## 这里的曲子和 `composer.py` 的区别

`AlgorithmicComposer` 服务的是「用户的项目」：它要读构型、participation、
段落强度，写的是一首**作品**。练习曲的约束完全不同 —— 拍子必须**响得出来
且数得清**，强拍要一耳朵听出来，力度曲线是教学上指定的而不是音乐上推导的。
硬套一个 fake project 进去只会两头不讨好，所以这里自己写音符，共用的是
下游：`score.validate_and_repair_part` → `render` → `midi_out`。

配器只用管弦乐队里真有的乐器（见 `config.INSTRUMENT_LIBRARY`）；打击乐限于
`score.DRUM_KEYS` 里那七件，没有爵士鼓组。
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import random
import re
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

try:
    from . import config
    from . import midi_out
    from . import render as renderlib
    from . import score as scorelib
    from .audio_utils import read_wav_bytes, to_wav_bytes
except Exception:  # pragma: no cover - 以模块方式启动时
    import config
    import midi_out
    import render as renderlib
    import score as scorelib
    from audio_utils import read_wav_bytes, to_wav_bytes

logger = logging.getLogger(__name__)


# ---------------- 规格 ----------------

STYLES = ("march", "waltz", "lyric")

# 参数上下限。这些不只是防呆 —— 端点接受的是前端传来的任意 spec，
# 每一份 spec 都会占一次渲染（几秒 CPU）和一个磁盘文件，所以要有边界。
MIN_BPM, MAX_BPM = 40, 208
MAX_BARS = 64
MAX_COUNT_IN = 2

PIECE_ID_RE = re.compile(r"^[0-9a-f]{16}$")


@dataclass(frozen=True)
class PieceSpec:
    """一首练习曲的完整定义。**同一份 spec 永远渲染出同一份音频。**"""

    style: str
    meter: int
    bpm: int
    """正曲小节数，不含数拍与尾巴。"""
    bars: int
    count_in_bars: int
    key: str
    """每小节的目标力度 0~1。长度不足就按最后一个值补齐 —— 「力度对应」的真值。"""
    dynamics: tuple[float, ...]
    """弱起：正曲第一个强拍之前先出一个音（在数拍的最后一拍上）。"""
    pickup: bool
    seed: int


def _clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def parse_spec(raw: dict) -> PieceSpec:
    """把请求体整成 PieceSpec，越界就报错而不是悄悄改。

    悄悄钳制是不行的：spec 决定 piece_id，钳过的 spec 会算出另一个 id，
    用户以为自己考的是 A 卷，实际拿到的是 B 卷。

    **一律用 `is None` 判缺省，不用 `or`。** `raw.get("bars") or 16` 会把
    `bars=0` 悄悄变成 16 —— 那正是这个函数存在的意义所要挡住的事：请求方以为
    自己要的是 0 小节（一个该被拒绝的值），拿到的却是一首 16 小节的曲子。
    """
    def given(name, default):
        v = raw.get(name)
        return default if v is None else v

    style = str(given("style", "march"))
    if style not in STYLES:
        raise ValueError(f"style 只能是 {'/'.join(STYLES)}")

    try:
        meter = int(given("meter", 4))
        bpm = int(round(float(given("bpm", 88))))
        bars = int(given("bars", 16))
        count_in = int(given("count_in_bars", 1))
        seed = int(given("seed", 0)) & 0x7FFFFFFF
    except (TypeError, ValueError):
        raise ValueError("meter / bpm / bars / count_in_bars / seed 只能是整数")

    # 1 拍是「打 1 拍」那一课用的：速度快到一小节只给一下（谐谑曲）。
    # 它不是 1/4 拍号的曲子，而是「一小节只打一个拍点」的练法。
    if meter not in (1, 2, 3, 4):
        raise ValueError("meter 只能是 1、2、3、4")
    if not MIN_BPM <= bpm <= MAX_BPM:
        raise ValueError(f"bpm 要在 {MIN_BPM}–{MAX_BPM} 之间")
    if not 1 <= bars <= MAX_BARS:
        raise ValueError(f"bars 要在 1–{MAX_BARS} 之间")
    if not 0 <= count_in <= MAX_COUNT_IN:
        raise ValueError(f"count_in_bars 要在 0–{MAX_COUNT_IN} 之间")

    dyn_raw = given("dynamics", [0.6])
    if not isinstance(dyn_raw, (list, tuple)) or not dyn_raw:
        raise ValueError("dynamics 要是一个非空数组")
    if len(dyn_raw) > MAX_BARS:
        raise ValueError(f"dynamics 最多 {MAX_BARS} 项")
    try:
        dynamics = tuple(round(_clamp(float(d), 0.0, 1.0), 3) for d in dyn_raw)
    except (TypeError, ValueError):
        raise ValueError("dynamics 只能是数字")

    pickup = bool(raw.get("pickup"))
    if pickup and count_in < 1:
        raise ValueError("弱起要有至少一小节数拍，否则那个音没地方放")

    # key 解析不了不报错（`parse_key` 退到 C 大调），所以这里只限长度
    key = str(given("key", "C major"))[:32]

    return PieceSpec(style=style, meter=meter, bpm=bpm, bars=bars,
                     count_in_bars=count_in, key=key, dynamics=dynamics,
                     pickup=pickup, seed=seed)


# 写谱算法的版本。**改了本模块里任何影响音符的逻辑，就把它 +1。**
#
# 缓存键只由 spec 算出来，所以同一份 spec 换了作曲逻辑之后 id 一模一样，
# 磁盘上那份旧音频会被继续端出来 —— 用户永远听不到修好的版本，而且两台跑着
# 不同版本的后端会在同一个 id 下给出不同的曲子。把版本号也拌进 id 里，
# 「同一个 id ⇒ 同一份音频」才是真的成立。旧文件成为孤儿，下次重渲染几秒钟。
#
# 2 = M7k：重音层次（`_beat_accent`）、`_vel` 的 accent 参数、强拍不再被拆分
_ALGO_VERSION = 2


def piece_id(spec: PieceSpec) -> str:
    """spec + 算法版本 → 缓存键。

    只取 sha1 前 16 位（64 bit）：这不是安全用途，只是给一个本机目录做文件名，
    而碰撞概率在几千首的量级上可以忽略。**取完之后仍然要用 `PIECE_ID_RE` 校验
    路径参数** —— id 从 URL 上来，不能拿它直接拼路径。
    """
    blob = json.dumps({"v": _ALGO_VERSION, "spec": asdict(spec)},
                      sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]


def dynamics_per_bar(spec: PieceSpec) -> list[float]:
    """拉伸到正曲小节数。短了按最后一个值补 —— 「先渐强，然后保持」是常见写法。"""
    out = list(spec.dynamics[: spec.bars])
    while len(out) < spec.bars:
        out.append(out[-1])
    return out


# ---------------- 配器 ----------------

# (库里的乐器 key, 在这首曲子里干什么)。
# role 单独给而不是用库里的默认 role：`score.POLYPHONY` 按 role 限制同时发声数，
# 弦乐在库里是 melody（同时只能 2 个音），当铺底和声用时要按 harmony 放到 4 个。
_ENSEMBLE: dict[str, tuple[tuple[str, str, str], ...]] = {
    # 进行曲：铜管主题 + 圆号铺底 + 大提琴走低音，小军鼓每拍都在
    "march": (("trumpet", "melody", "melody"), ("french_horn", "pad", "harmony"),
              ("cello", "bass", "bass"), ("timpani", "timpani", "rhythm"),
              ("percussion", "drums", "rhythm")),
    # 圆舞曲：小提琴主题 + 弦乐「蓬-恰-恰」 + 三角铁点后两拍
    "waltz": (("violin", "melody", "melody"), ("strings", "pad", "harmony"),
              ("cello", "bass", "bass"), ("timpani", "timpani", "rhythm"),
              ("percussion", "drums", "rhythm")),
    # 抒情：双簧管长句 + 弦乐持续和声，打击乐只在强拍上轻点
    "lyric": (("oboe", "melody", "melody"), ("strings", "pad", "harmony"),
              ("cello", "bass", "bass"), ("timpani", "timpani", "rhythm"),
              ("percussion", "drums", "rhythm")),
}

# 各声部在最终混音里的权重。**不逐轨归一化**（见 audio_utils.to_wav_bytes 的注释）：
# 归一化会让三角铁和铜管一样响，配器平衡当场作废。这里给的是配器上的相对音量。
_MIX_GAIN = {"melody": 1.0, "pad": 0.55, "bass": 0.7, "timpani": 0.8, "drums": 0.65}

# 进度条上显示的声部名。`kind` 是内部键，直接端到界面上就是一行英文夹在中文里。
_PART_LABEL = {"melody": "旋律", "pad": "和声", "bass": "低音", "timpani": "定音鼓", "drums": "打击乐"}

# 各声部的基准力度。乘上每小节的 dynamics 之后才是最终 velocity。
_BASE_VEL = {"melody": 100, "pad": 62, "bass": 78, "timpani": 92, "drums": 86}

# 四小节一句的级数走向（下标 = 级数 - 1）。都是通用套路，不受版权保护。
_PROGRESSION = {
    "march": (0, 3, 4, 0),      # I  IV V  I —— 最直白的正格进行
    "waltz": (0, 5, 3, 4),      # I  vi IV V
    "lyric": (5, 3, 0, 4),      # vi IV I  V —— 从关系小调起头，气质更柔
}


def _vel(part_kind: str, dyn: float, accent: float = 1.0) -> int:
    """力度 = 声部基准 × 该小节的力度系数 × 这一拍的轻重。

    下限不取 0：力度曲线到 0 时应当是「很轻」而不是「没有」—— 真消音了，
    用户就没有拍子可跟了，而这首曲子的头等任务是让人跟得上。

    **`accent` 必须乘在那个下限之外**，不能折进 `dyn` 里。折进去的话 0.42 那个
    下限会把它压掉大半：M7k 之前进行曲的弱拍写的是 `_vel(kind, dyn * 0.68)`，
    看着是「弱拍只有强拍的 68%」，实际算出来 dyn=0.62 时是 66 : 81 —— 82%，
    耳朵基本听不出差别。整首曲子于是变成一串一样响的拍子（见 `_beat_accent`）。
    """
    base = _BASE_VEL.get(part_kind, 80)
    return int(_clamp(round(base * (0.42 + 0.85 * dyn) * accent), 24, 124))


def _beat_accent(bpb: int, beat: int) -> float:
    """小节里第 `beat` 拍（0 起）该有多重。

    **拍号是靠这条曲线听出来的，不是靠数音符数出来的。** 跟练的人正忙着挥手，
    没有余力去数；他能依靠的只有「哪一下最重」。所以强-弱-次强-弱这个层次
    必须真的摆出来 —— 四拍子少了第 3 拍那个次强拍，「强弱弱弱」和「强弱」在
    耳朵里就是同一个东西，抓错强拍之后数成三拍完全正常。

    这不是理论洁癖，是量出来的：M7k 之前对重音包络做自相关，四拍子的
    lag=2 是 +0.82、lag=4 是 +0.92 —— 只差 0.10，等于没有拍号。

    次强拍取 0.62 是扫出来的，**上限比下限更要紧**：把它加重到 0.82 反而更糟，
    因为第 3 拍一旦接近第 1 拍，一小节四拍就听成了两小节二拍（lag4−lag2 从
    +0.23 掉到 +0.15）。次强拍的作用是把小节的下半段撑住，不是再来一次强拍。
    """
    if beat == 0:
        return 1.0
    if bpb >= 4 and beat == bpb // 2:
        return 0.62                      # 次强拍
    return 0.55


def _scale_pitches(key: dict, lo: int, hi: int) -> list[int]:
    """音域内所有调内音，从低到高。旋律在这个表的下标上走，就不会走出调外。"""
    pcs = set(scorelib.scale_pcs(key))
    return [p for p in range(lo, hi + 1) if p % 12 in pcs]


def _nearest_index(pitches: list[int], target: int) -> int:
    best, best_d = 0, 10 ** 9
    for i, p in enumerate(pitches):
        d = abs(p - target)
        if d < best_d:
            best, best_d = i, d
    return best


def _snap_to_chord(pitches: list[int], idx: int, chord: dict) -> int:
    """把下标挪到最近的和弦音上。强拍用，避免主题挂在经过音上。"""
    for step in range(0, 4):
        for cand in (idx - step, idx + step):
            if 0 <= cand < len(pitches) and scorelib.pitch_in_chord(pitches[cand], chord):
                return cand
    return idx


def _melody_rhythm(style: str, bpb: int, rng: random.Random,
                   is_phrase_end: bool) -> list[tuple[float, float]]:
    """一小节的旋律节奏：[(小节内偏移拍, 时值)]，总和等于一小节。

    句尾用长音收住 —— 一路匀速的四分音符听着像练习册，学生也就分不清乐句在哪断。
    """
    if is_phrase_end or bpb == 1:
        # 一小节一拍时旋律也只能一小节一个音，再拆就跨出小节了
        return [(0.0, float(bpb))]
    if style == "lyric":
        if bpb >= 4:
            return [(0.0, 2.0), (2.0, float(bpb - 2))]
        return [(0.0, 1.0), (1.0, float(bpb - 1))]
    if style == "waltz":
        return rng.choice([
            [(0.0, 1.0), (1.0, 1.0), (2.0, 1.0)],
            [(0.0, 2.0), (2.0, 1.0)],
            [(0.0, 1.0), (1.0, 2.0)],
        ]) if bpb == 3 else [(float(i), 1.0) for i in range(bpb)]
    # march：以四分音符为骨架，偶尔把某一拍拆成两个八分，避免整首都是同一个节奏。
    # **强拍不拆**：拆开的第 1 拍在听感上是两个较轻的音，正好把用户唯一的定位点抹掉
    out: list[tuple[float, float]] = []
    split_at = rng.randrange(1, bpb) if bpb >= 2 else 0
    for i in range(bpb):
        if i == split_at and bpb >= 3:
            out.append((float(i), 0.5))
            out.append((i + 0.5, 0.5))
        else:
            out.append((float(i), 1.0))
    return out


def _pad_hits(style: str, bpb: int) -> list[tuple[float, float]]:
    """铺底和声敲在哪几拍。

    **这是拍号最主要的听觉线索。** 圆舞曲的「蓬-恰-恰」（低音在 1，和弦在 2、3）
    和进行曲的后半拍和弦，比任何节拍器都更能让人听出这是三拍还是四拍。
    """
    # 一小节只有一拍：没有「弱拍」可落，和声只能铺满整小节
    if bpb == 1:
        return [(0.0, 1.0)]
    if style == "waltz" and bpb == 3:
        return [(1.0, 1.0), (2.0, 1.0)]
    if style == "lyric":
        return [(0.0, float(bpb))]          # 一整小节的持续和声
    if bpb >= 4:
        return [(1.0, 1.0), (3.0, 1.0)]     # 进行曲：和弦落在弱拍上
    return [(1.0, 1.0)] if bpb == 2 else [(1.0, 1.0), (2.0, 1.0)]


def _bass_hits(style: str, bpb: int) -> list[float]:
    if style == "waltz":
        return [0.0]
    if style == "lyric":
        return [0.0]
    return [0.0, 2.0] if bpb >= 4 else [0.0]


def _drum_hits(style: str, bpb: int, count_in: bool) -> list[tuple[float, int, float]]:
    """[(小节内偏移拍, 鼓件, 力度系数)]。鼓件编号必须在 `score.DRUM_KEYS` 里。

    数拍小节走单独一套：**只有点，没有音乐**，而且每一拍都要清清楚楚 ——
    数拍的唯一任务是告诉用户「下一小节的第一拍在这里」。
    """
    if count_in:
        # 小军鼓每拍一下，第一拍加大鼓压住。数拍这几声是**用户唯一一次**能从容
        # 听出拍号的机会（手还没开始动），所以这里的强弱比正曲还要拉得开一点。
        hits = [(float(i), 38, 1.0 if i == 0 else 0.5) for i in range(bpb)]
        hits.append((0.0, 35, 1.0))
        return hits

    if style == "lyric":
        # 抒情段落只在强拍上给一记三角铁，其余交给旋律和低音 —— 这是高级内容，
        # 拍子不再被喂到嘴边
        return [(0.0, 81, 0.8)]
    if style == "waltz":
        return [(0.0, 35, 1.0)] + [(float(i), 81, 0.6) for i in range(1, bpb)]
    # march：小军鼓每拍走强弱层次，大鼓**只压第 1 拍**。
    #
    # 次强拍上不要再补一记大鼓：试过，那是四拍子听成二拍子的主要原因 ——
    # 大鼓是全曲最低最响的一件，它落在哪儿，哪儿就是小节头。第 1、3 拍各来一下，
    # 等于每两拍宣告一次小节开始（lag4−lag2 从 +0.23 掉到 +0.09）。
    # 第 3 拍该由**音色缺席**来区分：有小军鼓和定音鼓、没有大鼓。
    hits: list[tuple[float, int, float]] = [(0.0, 35, 1.0)]
    hits += [(float(i), 38, _beat_accent(bpb, i)) for i in range(bpb)]
    return hits


# ---------------- 写谱 ----------------

def build_blueprint(spec: PieceSpec) -> dict:
    """蓝图。小节布局是：数拍 → 正曲 → 尾巴。

    尾巴那几小节是空的，专门留给最后一个音的余韵。渲染器把超出时长的尾音
    **叠回开头**做无缝循环（`render._wrap_and_trim`），那是为项目里的循环
    播放设计的；练习曲只放一遍，不留这几小节的话，最后一个和弦的衰减会盖在
    数拍的第一声上 —— 一个只在「跟着音乐从头打」时才听得见的怪响。
    """
    bpb, unit = spec.meter, 4
    bar_s = scorelib.bar_seconds(spec.bpm, bpb, unit)
    tail_bars = max(1, int(math.ceil(renderlib.TAIL_SECONDS / bar_s)))
    total_bars = spec.count_in_bars + spec.bars + tail_bars

    key = scorelib.parse_key(spec.key)
    triads = scorelib.diatonic_triads(key)
    prog = _PROGRESSION[spec.style]

    chords: list[str] = [triads[0]] * spec.count_in_bars
    for m in range(1, spec.bars + 1):
        degree = prog[(m - 1) % len(prog)]
        if m == spec.bars:
            degree = 0                       # 最后一小节回主和弦，收得住
        elif m % 4 == 0:
            degree = 4                       # 每四小节一个属和弦的呼吸口
        chords.append(triads[degree])
    chords += [triads[0]] * tail_bars

    return {
        "schema_version": scorelib.SCORE_SCHEMA_VERSION,
        "revision": 1,
        "bpm": spec.bpm,
        "key": spec.key,
        "time_signature": f"{bpb}/{unit}",
        "beats_per_bar": bpb,
        "beat_unit": unit,
        "bars": total_bars,
        "exact_duration": round(scorelib.exact_duration(total_bars, spec.bpm, bpb, unit), 4),
        "sections": [
            {"id": "count-in", "label": "数拍", "start_bar": 1,
             "end_bar": max(1, spec.count_in_bars), "intensity": 0.5, "is_climax": False},
            {"id": "music", "label": "正曲", "start_bar": spec.count_in_bars + 1,
             "end_bar": spec.count_in_bars + spec.bars, "intensity": 0.7, "is_climax": False},
        ] if spec.count_in_bars else [
            {"id": "music", "label": "正曲", "start_bar": 1, "end_bar": spec.bars,
             "intensity": 0.7, "is_climax": False},
        ],
        "chords": chords,
        "created_by": "practice",
        "count_in_bars": spec.count_in_bars,
        "music_bars": spec.bars,
        "tail_bars": tail_bars,
    }


def _compose(spec: PieceSpec, blueprint: dict) -> list[dict]:
    """写出各声部的原始音符。返回 `[{instrument, notes}]`，交给 score 校验。"""
    bpb = spec.meter
    key = scorelib.parse_key(spec.key)
    dyn = dynamics_per_bar(spec)
    offset = spec.count_in_bars
    out: list[dict] = []

    for part_no, (lib_key, kind, role) in enumerate(_ENSEMBLE[spec.style]):
        # 每个声部一条自己的随机流：改了旋律的写法不该让打击乐跟着变。
        #
        # 偏移用声部**序号**，不用 `hash(kind)` —— str 的 hash 在 CPython 里每个进程
        # 都重新加盐，同一份 spec 重启前后会写出不同的旋律，而 piece_id 一模一样。
        # 那就等于「所有人考同一首」在后端重启的那一刻悄悄失效了。
        rng = random.Random((spec.seed * 1000003 + part_no * 7919) & 0x7FFFFFFF)
        lo, hi = scorelib.instrument_range(lib_key)
        notes: list[list] = []

        if kind == "drums":
            for b in range(1, spec.count_in_bars + 1):
                for beat, drum, f in _drum_hits(spec.style, bpb, count_in=True):
                    notes.append([b, beat + 1, 0.25, drum, _vel(kind, 0.75, f)])
            for m in range(1, spec.bars + 1):
                for beat, drum, f in _drum_hits(spec.style, bpb, count_in=False):
                    notes.append([offset + m, beat + 1, 0.25, drum, _vel(kind, dyn[m - 1], f)])

        elif kind == "timpani":
            for m in range(1, spec.bars + 1):
                chord = scorelib.parse_chord(blueprint["chords"][offset + m - 1])
                root = scorelib.nearest_chord_pitch(48, chord, lo, hi)
                if root is None:
                    continue
                notes.append([offset + m, 1.0, 1.0, root, _vel(kind, dyn[m - 1])])
                # 四拍子的第三拍是次强拍，给一记轻的把小节的下半段撑住。
                # 轻重走 accent 而不是折进 dyn —— 折进去只剩 79%，听不出这是「轻的」
                if bpb >= 4:
                    notes.append([offset + m, 3.0, 1.0, root,
                                  _vel(kind, dyn[m - 1], _beat_accent(bpb, bpb // 2))])

        elif kind == "bass":
            for m in range(1, spec.bars + 1):
                chord = scorelib.parse_chord(blueprint["chords"][offset + m - 1])
                hits = _bass_hits(spec.style, bpb)
                for i, beat in enumerate(hits):
                    # 第二次落音换五音，连着四小节同一个音会把低音听成一条直线
                    pcs = [chord["bass_pc"]] if i == 0 else chord["pcs"][-1:]
                    p = scorelib.nearest_chord_pitch(
                        lo + (hi - lo) // 4, {"pcs": pcs}, lo, hi)
                    if p is None:
                        continue
                    span = (hits[i + 1] if i + 1 < len(hits) else bpb) - beat
                    # 进行曲的低音落在第 1、3 拍。两下一样响的话，小节里就出现了
                    # 一个两拍的脉冲，四拍子听着会像两个二拍子 —— 次强拍那一下要轻
                    notes.append([offset + m, beat + 1, span, p,
                                  _vel(kind, dyn[m - 1], _beat_accent(bpb, int(beat)))])

        elif kind == "pad":
            for m in range(1, spec.bars + 1):
                chord = scorelib.parse_chord(blueprint["chords"][offset + m - 1])
                for beat, dur in _pad_hits(spec.style, bpb):
                    anchor = lo + (hi - lo) // 2
                    for j, pc in enumerate(chord["pcs"][:3]):
                        p = scorelib.nearest_chord_pitch(anchor + j * 4, {"pcs": [pc]}, lo, hi)
                        if p is not None:
                            notes.append([offset + m, beat + 1, dur, p,
                                          _vel(kind, dyn[m - 1])])

        else:  # melody
            pitches = _scale_pitches(key, lo, hi)
            if not pitches:
                out.append({"library_key": lib_key, "kind": kind, "role": role, "notes": []})
                continue
            # 从音域中偏上一点起头：主题要浮在织体上面才听得见
            idx = _nearest_index(pitches, lo + int((hi - lo) * 0.62))
            if spec.pickup:
                # 弱起：数拍的最后一拍先出一个音，落在主和弦的属音上往上推
                idx = _snap_to_chord(pitches, max(0, idx - 4), scorelib.parse_chord(
                    blueprint["chords"][offset]))
                notes.append([spec.count_in_bars, float(bpb), 1.0, pitches[idx],
                              _vel(kind, dyn[0] * 0.8)])
            for m in range(1, spec.bars + 1):
                chord = scorelib.parse_chord(blueprint["chords"][offset + m - 1])
                phrase_end = (m % 4 == 0) or m == spec.bars
                for k, (beat, dur) in enumerate(
                        _melody_rhythm(spec.style, bpb, rng, phrase_end)):
                    if k == 0 or beat == bpb // 2:
                        idx = _snap_to_chord(pitches, idx, chord)
                    else:
                        idx = _clamp(idx + rng.choice((-2, -1, -1, 1, 1, 2)),
                                     0, len(pitches) - 1)
                    notes.append([offset + m, beat + 1, dur, pitches[idx],
                                  _vel(kind, dyn[m - 1])])

        out.append({"library_key": lib_key, "kind": kind, "role": role, "notes": notes})
    return out


def build_score(spec: PieceSpec) -> tuple[dict, list[dict]]:
    """spec → (蓝图, 已校验的各声部)。纯函数，可离线跑断言。"""
    bp = build_blueprint(spec)
    parts: list[dict] = []
    for draft in _compose(spec, bp):
        instrument = {
            "id": draft["kind"],
            "library_key": draft["library_key"],
            "role": draft["role"],
        }
        part = scorelib.validate_and_repair_part(
            {"notes": draft["notes"]}, instrument=instrument, blueprint=bp)
        part["kind"] = draft["kind"]
        parts.append(part)
    return bp, parts


def beat_grid(spec: PieceSpec) -> dict:
    """拍网格。`offset` 是**音频开头到正曲第一拍**的秒数，也就是整段数拍的长度。

    这是符号路线最值钱的一项：它是算出来的，不是检测出来的。
    """
    return {
        "bpm": spec.bpm,
        "beats_per_bar": spec.meter,
        "offset": round(spec.count_in_bars * scorelib.bar_seconds(
            spec.bpm, spec.meter, 4), 6),
    }


# ---------------- 渲染与缓存 ----------------

def piece_dir() -> Path:
    d = Path(config.PRACTICE_DIR)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _paths(pid: str) -> tuple[Path, Path, Path]:
    d = piece_dir()
    return d / f"{pid}.wav", d / f"{pid}.mid", d / f"{pid}.json"


def is_ready(pid: str) -> bool:
    wav, _, meta = _paths(pid)
    return wav.exists() and meta.exists()


def load_meta(pid: str) -> Optional[dict]:
    _, _, meta = _paths(pid)
    try:
        return json.loads(meta.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def render_piece(spec: PieceSpec, on_progress=None) -> dict:
    """写谱 → 渲染每个声部 → 混成一条 → 落盘。**阻塞、CPU 密集，别在事件循环里直接调。**

    `on_progress(已完成, 总数, 正在做什么)` 每完成一步回报一次，不给就什么都不报。
    练习曲只要几秒，但界面上和真实曲目用的是同一个进度条 —— 一边有一边没有，
    用户会以为是卡住了。
    """
    report = on_progress or (lambda *_: None)
    pid = piece_id(spec)
    wav_path, mid_path, meta_path = _paths(pid)

    bp, parts = build_score(spec)
    renderer = renderlib.get_renderer()
    steps = len(parts) + 1

    total = renderer.target_samples(bp)
    mix = [0.0] * total
    for idx, part in enumerate(parts):
        report(idx, steps, f"渲染 {_PART_LABEL.get(part['kind'], part['kind'])}")
        samples, sr = read_wav_bytes(renderer.render_part(part, bp))
        if sr != config.SCORE_SAMPLE_RATE:
            raise RuntimeError(f"声部 {part['kind']} 的采样率是 {sr}，期望 {config.SCORE_SAMPLE_RATE}")
        g = _MIX_GAIN.get(part["kind"], 0.7)
        for i in range(min(total, len(samples))):
            mix[i] += samples[i] * g

    # 只在**总线**上乘一个数，不逐轨归一化 —— 后者会毁掉配器平衡（见 audio_utils
    # 的注释）。整首等比例缩放，声部之间、小节之间的相对响度一点没变，所以写在
    # 谱面上的渐强渐弱原样保留，「力度对应」那一维仍然评得准。
    #
    # 之所以敢往上推（渲染器给每条声部留的余量叠起来只到 0.3 左右，太轻了）：
    # 这一条是**独自播放**的成品，不是要和别的轨叠在一起的分轨。
    report(len(parts), steps, "混音落盘")
    peak = max((abs(s) for s in mix), default=0.0)
    if peak > 1e-6:
        k = 0.89 / peak
        mix = [s * k for s in mix]

    wav_path.write_bytes(to_wav_bytes(mix, config.SCORE_SAMPLE_RATE, normalize=False))
    mid_path.write_bytes(midi_out.merged_midi(
        parts, bpm=bp["bpm"], beats_per_bar=bp["beats_per_bar"],
        beat_unit=bp["beat_unit"]))

    meta = {
        "piece_id": pid,
        "spec": asdict(spec),
        "grid": beat_grid(spec),
        # 「力度对应」的真值：这是作曲时**写下的**力度，不是从音频测的响度
        "loudness_per_bar": dynamics_per_bar(spec),
        "count_in_bars": spec.count_in_bars,
        "music_bars": spec.bars,
        "duration": bp["exact_duration"],
        "renderer": renderer.name,
        "instruments": [
            {"library_key": p["library_key"], "kind": p["kind"],
             "note_count": len(p["notes"])} for p in parts
        ],
        "repairs": [w for p in parts for w in p["warnings"]],
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    report(steps, steps, "完成")
    logger.info("练习曲 %s 渲染完成：%s %d/4 %d BPM，%d 小节，%.1f 秒，渲染器 %s",
                pid, spec.style, spec.meter, spec.bpm, spec.bars,
                bp["exact_duration"], renderer.name)
    return meta
