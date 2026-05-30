"""
纯 Python 的程序化音频合成兜底模块。

当 ACE-Step API 未启动 / 调用失败 / 用户选择 "no-model" 时，
使用此模块生成可听的"占位"管弦乐音频，保证整套系统在没有
真实模型情况下依然能跑通端到端流程（前端可加载/播放/指挥）。

输出为 16-bit PCM mono WAV bytes，便于直接写入 .wav 文件。
"""
from __future__ import annotations

import io
import math
import random
import struct
import wave
from typing import List, Tuple


SR = 22050  # 采样率（低一些以节省体积）


# 每个声部的音色配置：基频(Hz)、谐波振幅、节奏密度(每拍触发概率)、ADSR
_INSTRUMENT_PROFILES = {
    "violin":     {"root": 392.0, "harmonics": [1.0, 0.6, 0.35, 0.2, 0.1], "trigger": 0.85, "attack": 0.08, "release": 0.6, "vibrato": 5.5},
    "cello":      {"root": 130.8, "harmonics": [1.0, 0.5, 0.25, 0.1],      "trigger": 0.6,  "attack": 0.12, "release": 0.8, "vibrato": 3.5},
    "trumpet":    {"root": 261.6, "harmonics": [0.8, 1.0, 0.7, 0.4, 0.25, 0.15], "trigger": 0.55, "attack": 0.03, "release": 0.25, "vibrato": 4.0},
    "woodwind":   {"root": 523.2, "harmonics": [1.0, 0.3, 0.15, 0.05],     "trigger": 0.75, "attack": 0.05, "release": 0.4, "vibrato": 6.0},
    "percussion": {"root": 0.0,   "harmonics": [],                          "trigger": 0.9,  "attack": 0.001, "release": 0.18, "vibrato": 0.0},
    "full":       {"root": 196.0, "harmonics": [1.0, 0.6, 0.4, 0.25, 0.15, 0.1], "trigger": 0.9, "attack": 0.06, "release": 0.5, "vibrato": 4.5},
}


# 简单大调音阶（半音偏移）以及 D-major 调式
_SCALE_MAJOR = [0, 2, 4, 5, 7, 9, 11, 12]
_SCALE_MINOR = [0, 2, 3, 5, 7, 8, 10, 12]


def _key_offset(key: str) -> int:
    """把 'D major' / 'A minor' 解析为相对 C 的半音偏移。"""
    table = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}
    k = (key or "").strip().lower()
    if not k:
        return 0
    base = table.get(k[0], 0)
    if "#" in k or "sharp" in k:
        base += 1
    if "b " in k or "flat" in k:
        base -= 1
    return base


def _scale(key: str) -> List[int]:
    return _SCALE_MINOR if "minor" in (key or "").lower() else _SCALE_MAJOR


def _midi_to_freq(semitone_from_root: int, root_hz: float) -> float:
    return root_hz * (2.0 ** (semitone_from_root / 12.0))


def _adsr(n: int, sr: int, attack: float, release: float) -> List[float]:
    a = max(1, int(attack * sr))
    r = max(1, int(release * sr))
    sustain_level = 0.9
    env = [0.0] * n
    for i in range(min(a, n)):
        env[i] = (i / a) * sustain_level
    for i in range(a, max(a, n - r)):
        if i < n:
            env[i] = sustain_level
    for i, j in enumerate(range(max(0, n - r), n)):
        env[j] = max(0.0, sustain_level * (1.0 - i / max(1, r)))
    return env


def _synth_tone(freq: float, dur: float, sr: int, profile: dict, amp: float = 0.25) -> List[float]:
    n = int(dur * sr)
    if n <= 0 or freq <= 0:
        return [0.0] * max(0, n)
    env = _adsr(n, sr, profile["attack"], profile["release"])
    harmonics = profile["harmonics"] or [1.0]
    vib = profile["vibrato"]
    out = [0.0] * n
    two_pi = 2.0 * math.pi
    for i in range(n):
        t = i / sr
        # 颤音调制
        f = freq * (1.0 + 0.005 * math.sin(two_pi * vib * t)) if vib else freq
        s = 0.0
        for h_idx, h_amp in enumerate(harmonics, start=1):
            s += h_amp * math.sin(two_pi * f * h_idx * t)
        out[i] = s * env[i] * amp
    return out


def _synth_percussion(dur: float, sr: int, amp: float = 0.5) -> List[float]:
    """噪声 + 快速衰减 -> 简单的鼓/打击声。"""
    n = int(dur * sr)
    if n <= 0:
        return []
    out = [0.0] * n
    for i in range(n):
        t = i / sr
        env = math.exp(-t * 18.0)
        out[i] = (random.uniform(-1.0, 1.0)) * env * amp
    return out


def _mix_into(target: List[float], src: List[float], offset: int) -> None:
    end = min(len(target), offset + len(src))
    j = 0
    for i in range(offset, end):
        target[i] += src[j]
        j += 1


def _to_wav_bytes(samples: List[float], sr: int = SR) -> bytes:
    # 简单峰值归一化避免 clipping
    peak = 0.0
    for s in samples:
        a = s if s >= 0 else -s
        if a > peak:
            peak = a
    gain = 0.9 / peak if peak > 1e-6 else 1.0
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        frames = bytearray()
        for s in samples:
            v = int(max(-1.0, min(1.0, s * gain)) * 32767)
            frames += struct.pack("<h", v)
        wf.writeframes(bytes(frames))
    return buf.getvalue()


def synth_stem(instrument: str, duration: int = 30, bpm: int = 80,
               key: str = "D major", seed: int = -1) -> bytes:
    """为指定声部合成一段占位音频，返回 WAV bytes。"""
    instrument = (instrument or "full").lower()
    profile = _INSTRUMENT_PROFILES.get(instrument, _INSTRUMENT_PROFILES["full"])
    if seed is not None and seed >= 0:
        random.seed(seed + hash(instrument) % 100000)
    else:
        random.seed(hash(instrument) % 100000)

    total = int(duration * SR)
    out = [0.0] * total

    beat_sec = 60.0 / max(1, bpm)
    n_beats = int(duration / beat_sec)
    scale = _scale(key)
    key_off = _key_offset(key)

    if instrument == "percussion":
        for b in range(n_beats):
            if random.random() < profile["trigger"]:
                hit = _synth_percussion(0.25, SR, amp=0.6 if b % 2 == 0 else 0.35)
                _mix_into(out, hit, int(b * beat_sec * SR))
        return _to_wav_bytes(out)

    # 旋律/和声声部：在节拍上随机挑选音阶音
    last_degree = 0
    for b in range(n_beats):
        if random.random() > profile["trigger"]:
            continue
        # 简单旋律走向：在 last_degree 邻域选择
        candidates = [d for d in scale if abs(d - last_degree) <= 5]
        degree = random.choice(candidates)
        # 低音声部偏低八度，铜管偏高
        octave_shift = 0
        if instrument == "cello":
            octave_shift = -12
        elif instrument == "trumpet":
            octave_shift = 0
        elif instrument == "woodwind":
            octave_shift = 12 if random.random() < 0.5 else 0
        freq = _midi_to_freq(degree + key_off + octave_shift, profile["root"])
        dur = beat_sec * random.choice([0.5, 1.0, 1.0, 1.5, 2.0])
        tone = _synth_tone(freq, dur, SR, profile, amp=0.22)
        _mix_into(out, tone, int(b * beat_sec * SR))
        last_degree = degree

    return _to_wav_bytes(out)


def synth_full_mix(duration: int = 30, bpm: int = 80, key: str = "D major",
                   seed: int = -1, parts: Tuple[str, ...] = ("violin", "cello", "trumpet", "woodwind", "percussion")) -> bytes:
    """把多个声部叠加成一个 full mix。"""
    total = int(duration * SR)
    out = [0.0] * total
    for inst in parts:
        wav_bytes = synth_stem(inst, duration=duration, bpm=bpm, key=key, seed=seed)
        # 解码 wav bytes 回 float
        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            nframes = wf.getnframes()
            raw = wf.readframes(nframes)
        # 16-bit mono
        samples = struct.unpack("<" + "h" * nframes, raw)
        # 各声部音量比例
        amp = {"violin": 0.8, "cello": 0.7, "trumpet": 0.6, "woodwind": 0.6, "percussion": 0.5}.get(inst, 0.6)
        for i in range(min(len(out), len(samples))):
            out[i] += (samples[i] / 32767.0) * amp
    return _to_wav_bytes(out)
