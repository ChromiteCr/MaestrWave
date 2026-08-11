"""共享的 WAV 读写/混音工具（纯标准库，无需 numpy）。

被两处使用：
  - synth.py 的程序化占位音频合成（原来私有实现，这里提炼成公共函数）。
  - project_gen.py 在调用 ACE-Step 的 lego 任务前，把项目里"已经生成的
    乐器"混音落地成一个临时 wav，作为 src_audio_path 传给模型。
"""
from __future__ import annotations

import io
import logging
import struct
import wave
from pathlib import Path
from typing import List, Sequence, Union

logger = logging.getLogger(__name__)


def mix_into(target: List[float], src: Sequence[float], offset: int = 0) -> None:
    """把 src 按 offset 累加进 target（原地修改）。"""
    end = min(len(target), offset + len(src))
    j = 0
    for i in range(offset, end):
        target[i] += src[j]
        j += 1


def to_wav_bytes(samples: Sequence[float], sr: int, normalize: bool = True) -> bytes:
    """float 采样（约 -1..1）编码为 16-bit PCM mono WAV。

    `normalize=True`（默认，保持既有调用方行为）会把峰值拉到 0.9。

    **分声部渲染时必须传 False。** 逐轨归一化会把每条音轨都推到同一个响度，
    一件三角铁和铜管齐奏出来一样响，整个配器平衡当场作废 —— 而这个软件的
    卖点正是指挥能分别控制各个声部。M7 的符号渲染走固定增益，响度差异由
    力度（velocity）和声部基准音量决定。
    """
    gain = 1.0
    if normalize:
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


def read_wav_samples(path: Union[str, Path]) -> tuple[List[float], int]:
    """读取 16-bit mono/stereo WAV，返回 (float 采样[-1,1] mono, sample_rate)。
    立体声会被降混为单声道。"""
    with wave.open(str(path), "rb") as wf:
        sr = wf.getframerate()
        n_channels = wf.getnchannels()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)
    total = struct.unpack("<" + "h" * (len(raw) // 2), raw)
    if n_channels == 1:
        samples = [v / 32767.0 for v in total]
    else:
        samples = []
        for i in range(0, len(total) - n_channels + 1, n_channels):
            frame = total[i:i + n_channels]
            samples.append((sum(frame) / len(frame)) / 32767.0)
    return samples, sr


def mix_wav_files(paths: Sequence[Union[str, Path]], out_path: Union[str, Path],
                   weights: Sequence[float] = None) -> Path:
    """把多个 wav 文件按（可选）权重叠加混音，写入 out_path，返回该路径。
    采样率以第一个文件为准；不做重采样，假设所有输入都在同一采样率下生成
    （ACE-Step 输出应当一致）。"""
    paths = list(paths)
    if not paths:
        raise ValueError("mix_wav_files: no input paths")
    weights = list(weights) if weights else [1.0] * len(paths)

    # 有的 take 可能不是真正的 WAV（比如云端后端返回 MP3、而本机没装 ffmpeg
    # 转不了码，见 tme_backend._transcode）。跳过读不了的那些，而不是让整次
    # 生成因为一条旧轨崩掉。
    decoded = []
    kept_weights = []
    for p, w in zip(paths, weights):
        try:
            decoded.append(read_wav_samples(p))
            kept_weights.append(w)
        except Exception as e:
            logger.warning("mix_wav_files: 跳过无法读取的音频 %s (%s: %s)",
                           p, type(e).__name__, e)
    if not decoded:
        raise ValueError("mix_wav_files: 没有任何可读的 WAV 输入")
    weights = kept_weights
    sr = decoded[0][1]
    total_len = max(len(s) for s, _ in decoded)
    out = [0.0] * total_len
    for (samples, _), w in zip(decoded, weights):
        weighted = [v * w for v in samples]
        mix_into(out, weighted, 0)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(to_wav_bytes(out, sr))
    return out_path
