"""读 MIDI 文件，转成项目现有的 `(blueprint, parts)`。

`midi_out.py` 的反方向，但**不是它的逆运算**：这里读的是别人排版出来的真实总谱，
不是本项目写出来的谱。两者对「什么叫合法」的要求不一样，所以有三条规矩：

## 一、不走 `score.validate_and_repair_part`

那个函数是给语言模型的输出兜底的：拍位量化到 1/4 拍、丢重叠音、melody 复音砍到 2。
真实管弦乐声部过一遍会被打残 —— 小提琴的双音没了，密集的十六分音符被吸到四分
音符网格上。导入的 MIDI 本身就是合法乐谱，没有「修复」可言。

**绕开而不是放宽**：放宽会改变所有 LLM 生成项目的行为，绕开对现有实现是零改动。

## 二、不夹音域

`score.py` 会把超出乐器音域的音移八度，那在「模型瞎写」的前提下是对的。这里不行：
库里没有 bassoon，最接近的 `woodwind` 是 55–93，而大管的真实音域是 34–75 ——
照着夹会把整个大管声部往上搬一个八度。真实总谱的音高按定义就是对的，
唯一保留的钳制是 velocity 夹进 1–127（渲染器要求）。

## 三、音色不从 `library_key` 取

`library_key` 只用来决定音域族与显示名；GM 音色号由调用方明确给出。原因见
`repertoire.py`：这两份文件的铜管被 LilyPond 全写成 GM 69（英国管），照抄必错，
而库里的 `french_horn` 又不认识「大管」这种库里没有的乐器。分开之后两边都能对。
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

MAX_VELOCITY = 127
MIN_VELOCITY = 1


@dataclass(frozen=True)
class TrackSpec:
    """一条 MIDI 轨在本项目里算什么。按**总谱顺序**给，不读文件里的 GM 程序号。"""

    name: str
    """显示名，也是项目里的乐器名。"""
    library_key: str
    """决定音色族（纯 Python 合成用）与显示，不决定 GM 音色。"""
    gm_program: int
    """真实 GM 音色号。采样渲染器按它取音色，所以这里要写对，不能从库里推。"""
    role: str = "harmony"
    """melody / harmony / bass / rhythm。只影响项目里的角色标注。"""


@dataclass(frozen=True)
class Note:
    tick: int
    dur: int
    pitch: int
    vel: int
    track: int


@dataclass(frozen=True)
class ParsedMidi:
    division: int
    """每四分音符多少 tick。"""
    notes: tuple[Note, ...]
    tempos: tuple[tuple[int, int], ...]
    """(tick, 微秒每四分音符)，按 tick 升序。"""
    timesigs: tuple[tuple[int, int, int], ...]
    """(tick, 分子, 分母)，按 tick 升序。"""
    track_count: int


# ---------------- 解析 ----------------

def _vlq(buf: bytes, i: int) -> tuple[int, int]:
    """可变长度数量。SMF 里所有的时间间隔都是这么编的。"""
    v = 0
    while True:
        v = (v << 7) | (buf[i] & 0x7F)
        more = buf[i] & 0x80
        i += 1
        if not more:
            return v, i


def parse(path: str | Path) -> ParsedMidi:
    """读一个标准 MIDI 文件。

    只认三种元事件（set_tempo / time_signature）与音符开关，别的原样跳过 ——
    我们要的信息就这些，而少解析一种事件就少一处可能读错的地方。

    **必须处理 running status**（连续同类事件省略状态字节）：LilyPond 导出的文件
    大量使用它，不处理的话会把数据字节当成状态字节，整条轨从某一点开始全是垃圾。
    """
    buf = Path(path).read_bytes()
    if buf[:4] != b"MThd":
        raise ValueError(f"{path} 不是标准 MIDI 文件（缺 MThd）")
    _fmt, ntrks, division = struct.unpack(">HHH", buf[8:14])
    if division & 0x8000:
        raise ValueError("暂不支持 SMPTE 时间码，只支持每四分音符 tick 数")

    notes: list[Note] = []
    tempos: list[tuple[int, int]] = []
    timesigs: list[tuple[int, int, int]] = []

    i = 14
    for track in range(ntrks):
        if buf[i:i + 4] != b"MTrk":
            raise ValueError(f"第 {track} 轨的块头不对")
        length = struct.unpack(">I", buf[i + 4:i + 8])[0]
        end = i + 8 + length
        j = i + 8
        tick = 0
        status = 0
        # (pitch, channel) → 最近一次 note-on 的 (tick, velocity)
        open_notes: dict[tuple[int, int], tuple[int, int]] = {}

        while j < end:
            delta, j = _vlq(buf, j)
            tick += delta
            if buf[j] & 0x80:
                status = buf[j]
                j += 1
            kind = status & 0xF0
            channel = status & 0x0F

            if status == 0xFF:
                meta = buf[j]
                j += 1
                n, j = _vlq(buf, j)
                data = buf[j:j + n]
                j += n
                if meta == 0x51 and n == 3:
                    tempos.append((tick, struct.unpack(">I", b"\0" + data)[0]))
                elif meta == 0x58 and n >= 2:
                    timesigs.append((tick, data[0], 2 ** data[1]))
            elif status in (0xF0, 0xF7):
                n, j = _vlq(buf, j)
                j += n
            elif kind in (0xC0, 0xD0):
                j += 1
            elif kind in (0x80, 0x90, 0xA0, 0xB0, 0xE0):
                d1, d2 = buf[j], buf[j + 1]
                j += 2
                if kind == 0x90 and d2 > 0:
                    open_notes[(d1, channel)] = (tick, d2)
                elif kind == 0x80 or (kind == 0x90 and d2 == 0):
                    started = open_notes.pop((d1, channel), None)
                    if started is not None:
                        on_tick, vel = started
                        notes.append(Note(on_tick, max(1, tick - on_tick), d1, vel, track))
            else:
                raise ValueError(f"第 {track} 轨遇到未知状态字节 {status:#x}")

        # 没配上 note-off 的音（文件写坏或轨尾截断）给一个四分音符，别丢掉
        for (pitch, _ch), (on_tick, vel) in open_notes.items():
            notes.append(Note(on_tick, division, pitch, vel, track))
        i = end

    notes.sort(key=lambda n: (n.tick, n.track, n.pitch))
    return ParsedMidi(
        division=division,
        notes=tuple(notes),
        tempos=tuple(sorted(set(tempos))),
        timesigs=tuple(sorted(set(timesigs))),
        track_count=ntrks,
    )


# ---------------- 单速度单拍号检查 ----------------

def uniform_grid(parsed: ParsedMidi, start_tick: int, end_tick: int) -> tuple[float, int]:
    """截取窗口内的 (BPM, 每小节拍数)。窗口里有速度或拍号变化就报错。

    **报错而不是取第一个**：blueprint 只能表达一个速度一个拍号，窗口里真有变化
    时静默取第一个，出来的是一段拍点全错的音频，而且错得很难看出来 ——
    宁可在这里炸掉，让选段的人换一个窗口。
    """
    def _active(events, default):
        cur = default
        for item in events:
            if item[0] <= start_tick:
                cur = item
            elif item[0] < end_tick:
                raise ValueError(
                    f"截取窗口内有变化（tick {item[0]}），而 blueprint 只支持"
                    f"单一速度与单一拍号。请把窗口挪到变化点之后。")
        return cur

    tempo = _active(parsed.tempos, (0, 500000))
    tsig = _active(parsed.timesigs, (0, 4, 4))
    bpm = 60_000_000.0 / tempo[1]
    numerator, denominator = tsig[1], tsig[2]
    # blueprint 的 beat_unit 固定按四分音符算拍，6/8 这类要换算成「一小节几个四分音符」
    beats_per_bar = int(round(numerator * 4 / denominator))
    if beats_per_bar < 1:
        raise ValueError(f"算出来的每小节拍数是 {beats_per_bar}，拍号 {numerator}/{denominator} 不支持")
    return bpm, beats_per_bar


# ---------------- 力度反推 ----------------

# 配器权重：铜管与定音鼓的单位音量本来就比木管弦乐大，这是配器法不是调参。
_ORCHESTRATION_WEIGHT = {
    "trumpet": 1.7, "timpani": 1.6, "french_horn": 1.5, "trombone": 1.5, "brass": 1.6,
    "violin": 1.2, "oboe": 1.1, "flute": 1.0, "clarinet": 1.0, "woodwind": 1.0,
    "strings": 1.0, "cello": 1.0, "percussion": 1.5,
}
_DYN_LO, _DYN_HI = 0.18, 0.90


def derive_dynamics(notes: list[Note], specs: dict[int, TrackSpec],
                    bars: int, ticks_per_bar: int) -> list[float]:
    """源文件没有力度信息时，从**织体**反推一条每小节的力度曲线。

    velocity 恒定的 MIDI（LilyPond 没写 `\\dynamics` 时的默认导出）拿去当力度真值
    就是一条直线，既没法评分也没法听。但力度信息并没有真的消失 —— 它在配器里：
    作曲家让一件乐器加进来，本身就是在写渐强。

        每小节 raw = Σ(在响的声部 × 配器权重) + 音符数 × 0.06

    再做三小节移动平均：指挥做的是**乐句级**力度，逐小节抖动的曲线没法照着打。

    **这条曲线必须能重现作品公认的形状**，否则反推法不成立、不能当评分真值。
    贝七第二乐章实测：前 10 小节均值 0.44 → 后 10 小节 0.87，阶跃正好落在
    小提琴加入对旋律那一小节。`tests` 里有这条断言。
    """
    voices: list[set[int]] = [set() for _ in range(bars)]
    density = [0] * bars
    for n in notes:
        b = n.tick // ticks_per_bar
        if 0 <= b < bars:
            voices[b].add(n.track)
            density[b] += 1

    raw = []
    for b in range(bars):
        w = sum(_ORCHESTRATION_WEIGHT.get(specs[t].library_key, 1.0)
                for t in voices[b] if t in specs)
        raw.append(w + density[b] * 0.06)

    smooth = []
    for b in range(bars):
        window = raw[max(0, b - 1):b + 2]
        smooth.append(sum(window) / len(window))

    lo, hi = min(smooth), max(smooth)
    if hi - lo < 1e-9:
        return [round((_DYN_LO + _DYN_HI) / 2, 3)] * bars
    return [round(_DYN_LO + (_DYN_HI - _DYN_LO) * (v - lo) / (hi - lo), 3) for v in smooth]


def has_dynamics(notes: list[Note], track: int) -> bool:
    """这一轨有没有真的力度信息。**恒定一个值**才算没有 —— 全 127 是「没写」，不是「都很响」。

    判据曾经是「取值超过 2 种」，那会把**两级力度**误判成缺省：埃格蒙特尾声
    最后 28 小节里有 9 条轨只有 101 与 127 两个值，那正是谱面写的 f 与 ff。
    窗口一短，同一份文件就会从「有力度」翻成「没力度」—— 判据不该随截多长而变。
    """
    seen = {n.vel for n in notes if n.track == track}
    return len(seen) > 1


# ---------------- 组装 ----------------

def build_score(
    parsed: ParsedMidi,
    specs: dict[int, TrackSpec],
    *,
    start_tick: int,
    bars: int,
    tail_bars: int = 1,
    accent: Optional[object] = None,
) -> tuple[dict, list[dict], dict]:
    """截取 → `(blueprint, parts, meta)`，可直接喂给 `render.ScoreRenderer`。

    起点用 **tick** 给而不是小节号：小节号在多拍号文件里根本不成立。埃格蒙特
    前面是 3/2 与 3/4，尾声那段 4/4 的起点（tick 357120）除以 4/4 的小节长度是
    232.5 —— 照「按 4/4 从头数第几小节」去截，会从半个小节的中间切进去，
    强拍整段错到第 3 拍上，而音频听起来只是「怪」，很难看出错在哪。

    `accent(bpb, beat_index) -> float` 给的话会叠一层小节内强弱层次。源文件力度是
    平的时候必须给：没有强弱层次，四拍子和二拍子在耳朵里是一回事（M7k 量过），
    而听不出拍子就谈不上指挥。
    """
    bpm, bpb = uniform_grid(parsed, start_tick, start_tick + 1)
    ticks_per_bar = int(round(parsed.division * bpb))
    end_tick = start_tick + bars * ticks_per_bar
    uniform_grid(parsed, start_tick, end_tick)   # 窗口内不许有变化

    kept = [Note(n.tick - start_tick, n.dur, n.pitch, n.vel, n.track)
            for n in parsed.notes
            if start_tick <= n.tick < end_tick and n.track in specs]

    # 反推是**整首**的决定，不是逐轨的。有力度的声部原样留着、没力度的按反推曲线
    # 缩放，同一小节里两组声部就按两套标准变响 —— 听起来是配器失衡，不是渐强。
    # 只有整首几乎全平（LilyPond 没写 `\dynamics` 时的默认导出）才反推。
    flat = {t for t in specs if not has_dynamics(kept, t)}
    flat_notes = sum(1 for n in kept if n.track in flat)
    whole_flat = bool(kept) and flat_notes >= 0.9 * len(kept)
    flat_tracks = sorted(flat) if whole_flat else []
    derived = derive_dynamics(kept, specs, bars, ticks_per_bar) if whole_flat else None

    total_bars = bars + tail_bars
    blueprint = {
        "schema_version": 1,
        "revision": 1,
        # 保留两位就够：60e6/微秒 常有 76.0001 这种尾数，直接显示很难看，
        # 而两位带来的误差是百万分之一量级（80 秒里 0.1ms），网格与音频同源不受影响
        "bpm": round(bpm, 2),
        "beats_per_bar": bpb,
        "beat_unit": 4,
        "bars": total_bars,
        "exact_duration": round(total_bars * bpb * 60.0 / bpm, 4),
        "created_by": "midi_in",
        "music_bars": bars,
        "count_in_bars": 0,
        "tail_bars": tail_bars,
    }

    parts: list[dict] = []
    for track in sorted(specs):
        spec = specs[track]
        rows = [n for n in kept if n.track == track]
        notes_out = []
        for n in rows:
            bar = n.tick // ticks_per_bar + 1
            beat = (n.tick % ticks_per_bar) / parsed.division + 1.0
            dur = max(0.05, n.dur / parsed.division)
            vel = n.vel
            if derived is not None and track in flat_tracks:
                scale = derived[min(bars - 1, bar - 1)]
                a = 1.0
                if accent is not None:
                    a = float(accent(bpb, int(beat - 1)))
                vel = int(round(vel * (0.30 + 0.70 * scale) * a))
            notes_out.append([bar, round(beat, 4), round(dur, 4), n.pitch,
                              max(MIN_VELOCITY, min(MAX_VELOCITY, vel))])
        notes_out.sort(key=lambda k: (k[0], k[1], k[3]))
        parts.append({
            "schema_version": 1,
            "instrument_id": f"midi-{track}",
            "library_key": spec.library_key,
            "display_name": spec.name,
            "role": spec.role,
            "gm_program": spec.gm_program,
            "channel": 0,
            "blueprint_revision": 1,
            "kind": spec.name,
            "notes": notes_out,
            "warnings": [],
        })

    meta = {
        "bpm": round(bpm, 2),
        "beats_per_bar": bpb,
        "music_bars": bars,
        "note_count": len(kept),
        # 力度是**推导的还是谱面的**，界面上要照实说，不能让用户以为是作曲家写的
        "dynamics_source": "derived" if derived is not None else "score",
        "loudness_per_bar": derived if derived is not None
        else _measured_loudness(kept, bars, ticks_per_bar),
        "flat_tracks": flat_tracks,
    }
    return blueprint, parts, meta


def _measured_loudness(notes: list[Note], bars: int, ticks_per_bar: int) -> list[float]:
    """源文件本来就有力度时，每小节的响度真值 = 该小节 velocity 的均值，归一到 0–1。

    用均值而不是峰值：「力度对应」评的是**整体音量**，一小节里有一个重音不等于
    整小节都强，按峰值算会把每一处 sf 都变成一次要求用户放大拍型的指令。
    """
    per_bar: list[list[int]] = [[] for _ in range(bars)]
    for n in notes:
        b = n.tick // ticks_per_bar
        if 0 <= b < bars:
            per_bar[b].append(n.vel)
    out = []
    for vals in per_bar:
        out.append(sum(vals) / len(vals) / 127.0 if vals else 0.0)
    # 空小节沿用前一小节，别让休止被当成「要求最弱」
    for i in range(len(out)):
        if out[i] == 0.0:
            out[i] = out[i - 1] if i else 0.5
    return [round(v, 3) for v in out]
