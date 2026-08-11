"""最小的标准 MIDI 文件（SMF）写入器（M7）。

手写而不是引 `mido` / `pretty_midi`：整条链路只用到四种事件
（note_on / note_off / program_change / set_tempo），而仓库的依赖一直保持在
四行（fastapi / uvicorn / httpx / aiofiles）。这和 `tme_backend.py` 手写 HMAC
签名、不为一个端点引一整套 SDK 是同一个取舍。

产物有两个去处：
  - `single_part_midi()` —— 只含一个声部，交给 fluidsynth 渲染成那件乐器的音轨；
  - `merged_midi()`      —— 全部声部，给用户导出到 MuseScore / DAW 里用。

格式参考：SMF 1.0。type-1 = 多轨同步播放，第 0 轨按惯例只放速度/拍号这类
全局元事件，实际音符从第 1 轨开始。
"""
from __future__ import annotations

import struct

try:
    from . import score as scorelib
except Exception:
    import score as scorelib


# 每四分音符多少 tick。480 是 DAW 通用值，且能被 3 和 4 整除 ——
# 三连音和十六分音符都落在整数 tick 上，不会因取整漂移。
TICKS_PER_BEAT = 480

_META = 0xFF
_END_OF_TRACK = b"\x2f\x00"
_SET_TEMPO = 0x51
_TIME_SIGNATURE = 0x58


def vlq(n: int) -> bytes:
    """可变长度数量（variable-length quantity）编码。

    MIDI 里所有 delta time 都用这个：每字节低 7 位是数据，最高位表示"后面还有"。
    这是整个格式里唯一容易写错的地方，所以单独测（见 harness）。
    """
    if n < 0:
        raise ValueError(f"vlq 不接受负数：{n}")
    out = bytearray([n & 0x7F])
    n >>= 7
    while n:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    return bytes(reversed(out))


def _chunk(tag: bytes, body: bytes) -> bytes:
    return tag + struct.pack(">I", len(body)) + body


def _meta(kind: int, data: bytes) -> bytes:
    return bytes([_META, kind]) + vlq(len(data)) + data


def _tempo_track(bpm: float, beats_per_bar: int, beat_unit: int) -> bytes:
    """第 0 轨：速度 + 拍号。"""
    # set_tempo 的单位是"每四分音符多少微秒"
    us_per_quarter = int(round(60_000_000.0 / max(1e-6, bpm)))
    body = bytearray()
    body += vlq(0) + _meta(_SET_TEMPO, struct.pack(">I", us_per_quarter)[1:])

    # 拍号元事件的分母存的是 2 的幂：4/4 写 (4, 2)，6/8 写 (6, 3)
    denom_pow = max(0, (beat_unit).bit_length() - 1)
    # 后两个字节是节拍器咔哒间隔和三十二分音符数，用标准默认值
    body += vlq(0) + _meta(_TIME_SIGNATURE, bytes([beats_per_bar, denom_pow, 24, 8]))
    body += vlq(0) + bytes([_META]) + _END_OF_TRACK
    return _chunk(b"MTrk", bytes(body))


def _part_track(part: dict, beats_per_bar: int, end_beats: float = 0.0) -> bytes:
    """一个声部一条轨。

    `end_beats` 把轨尾（end_of_track）推到指定的绝对拍位置。渲染器要靠它拿到
    比乐曲本身更长的一段音频 —— 最后一个音的尾音得响完，之后那截尾巴要叠回
    开头才能做出无缝循环。fluidsynth 渲染到轨尾就停，不推的话尾音直接被切掉。
    """
    channel = int(part.get("channel") or 0) & 0x0F
    program = int(part.get("gm_program") or 0) & 0x7F

    # (tick, 优先级, 事件字节)。同一 tick 上 note_off 必须排在 note_on 前面，
    # 否则"前一个音刚结束、后一个音同刻开始"会被听成后一个音直接被掐掉。
    events: list[tuple[int, int, bytes]] = []

    # 鼓组通道不发 program_change：GM 里第 10 通道的音色由音符号决定，
    # 发了反而可能被某些 SoundFont 当成换鼓组。
    if channel != scorelib.PERCUSSION_CHANNEL:
        events.append((0, 0, bytes([0xC0 | channel, program])))

    for n in part.get("notes") or []:
        bar, beat, dur = n[scorelib.N_BAR], n[scorelib.N_BEAT], n[scorelib.N_DUR]
        pitch = int(n[scorelib.N_PITCH]) & 0x7F
        vel = int(n[scorelib.N_VEL]) & 0x7F
        start_beat = (bar - 1) * beats_per_bar + (beat - 1)
        on = int(round(start_beat * TICKS_PER_BEAT))
        off = max(on + 1, int(round((start_beat + dur) * TICKS_PER_BEAT)))
        events.append((on, 1, bytes([0x90 | channel, pitch, vel])))
        # 用 note_on 力度 0 表示 note_off 是通行做法，但这里直接发 0x80，
        # 更直白，体积差别可以忽略。
        events.append((off, 0, bytes([0x80 | channel, pitch, 0])))

    events.sort(key=lambda e: (e[0], e[1]))

    body = bytearray()
    last = 0
    for tick, _, raw in events:
        body += vlq(tick - last) + raw
        last = tick
    end_tick = max(last, int(round(end_beats * TICKS_PER_BEAT)))
    body += vlq(end_tick - last) + bytes([_META]) + _END_OF_TRACK
    return _chunk(b"MTrk", bytes(body))


def _header(n_tracks: int) -> bytes:
    return _chunk(b"MThd", struct.pack(">HHH", 1, n_tracks, TICKS_PER_BEAT))


def build_midi(parts: list[dict], *, bpm: float, beats_per_bar: int,
               beat_unit: int = 4, end_beats: float = 0.0) -> bytes:
    """若干声部 → SMF type-1 字节。"""
    tracks = [_tempo_track(bpm, beats_per_bar, beat_unit)]
    tracks += [_part_track(p, beats_per_bar, end_beats) for p in parts]
    return _header(len(tracks)) + b"".join(tracks)


def single_part_midi(part: dict, *, bpm: float, beats_per_bar: int,
                     beat_unit: int = 4, end_beats: float = 0.0) -> bytes:
    """只含一个声部 —— 渲染成该乐器独立音轨时用。"""
    return build_midi([part], bpm=bpm, beats_per_bar=beats_per_bar,
                      beat_unit=beat_unit, end_beats=end_beats)


def merged_midi(parts: list[dict], *, bpm: float, beats_per_bar: int,
                beat_unit: int = 4) -> bytes:
    """全部声部合成一个文件，导出给 MuseScore / DAW。

    通道分配：非鼓组的声部依次占 0..15（跳过 9），超过 15 个声部就开始复用。
    复用只影响音色（后来的 program_change 会盖掉前一个），不影响音高与时值，
    而 16 件以上乐器的项目本来就该去 DAW 里整理。
    """
    out: list[dict] = []
    ch = 0
    for p in parts:
        q = dict(p)
        if int(p.get("channel") or 0) != scorelib.PERCUSSION_CHANNEL:
            if ch == scorelib.PERCUSSION_CHANNEL:
                ch += 1
            q["channel"] = ch % 16
            ch += 1
        out.append(q)
    return build_midi(out, bpm=bpm, beats_per_bar=beats_per_bar, beat_unit=beat_unit)
