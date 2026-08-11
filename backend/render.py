"""把符号乐谱渲染成每件乐器一条 WAV（M7）。

两个实现，选择逻辑照抄 `ALLOW_SYNTH_FALLBACK` 那套「有更好的就用，没有也不断链」：

  - `FluidSynthRenderer` —— 外部 fluidsynth + GM SoundFont，音色是正经采样音源。
  - `PySynthRenderer`    —— 纯 Python 加法合成，零外部依赖。音色明显更朴素，
                            但保证任何机器上都出得了声。

三条**所有渲染器都必须守**的约定，任缺一条多轨播放就会散架：

  1. **采样率固定 44100**。`audio_utils.mix_wav_files` 明确不做重采样，而
     `synth.py` 的老路径是 22050 —— 两者混在一起会变成噪音。
  2. **各声部采样数完全相同**，等于 `round(exact_duration * 44100)`。
     `AudioEngine` 是多轨各自 loop 播放的，长度差一个采样，放几圈就错开了。
  3. **不做峰值归一化**。逐轨归一化会把三角铁和铜管齐奏推到同样响，
     配器平衡就没了（见 `audio_utils.to_wav_bytes` 的 normalize 参数）。
"""
from __future__ import annotations

import logging
import math
import shutil
import subprocess
import tempfile
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

try:
    from . import config
    from . import midi_out
    from . import score as scorelib
    from . import sf2
    from .audio_utils import read_wav_samples, to_wav_bytes
except Exception:
    import config
    import midi_out
    import score as scorelib
    import sf2
    from audio_utils import read_wav_samples, to_wav_bytes

logger = logging.getLogger(__name__)

SR = config.SCORE_SAMPLE_RATE

# 尾巴长度（秒）。最后一个音的余韵要响完，这段之后会被叠回开头做无缝循环。
TAIL_SECONDS = 2.5

# 总增益。留足余量给多轨叠加 —— 八件乐器同时齐奏时峰值会是单轨的好几倍，
# 而削波（clipping）比整体偏轻难听得多。
MASTER_GAIN = 0.32


# ---------------- 公共处理 ----------------

def _wrap_and_trim(samples: list[float], n: int) -> list[float]:
    """把超出 n 的尾巴叠回开头，再裁到恰好 n 个采样。

    这是「循环无缝」的全部实现。`AudioEngine._start` 里 `source.loop = true`，
    不做这一步的话每绕一圈都会在接缝处听到最后一个和弦被硬切 —— 现有的
    ACE-Step / 天琴两条生成路径至今都有这个毛病，符号模式下顺手解决。
    """
    if len(samples) > n:
        for i in range(len(samples) - n):
            samples[i] += samples[n + i]
    if len(samples) < n:
        samples.extend([0.0] * (n - len(samples)))
    return samples[:n]


class ScoreRenderer(ABC):
    name = "base"

    @abstractmethod
    def render_part(self, part: dict, blueprint: dict) -> bytes:
        """一个声部 → 16-bit mono 44100 WAV 字节。"""

    @staticmethod
    def target_samples(blueprint: dict) -> int:
        return int(round(float(blueprint["exact_duration"]) * SR))


# ---------------- FluidSynth ----------------

class FluidSynthRenderer(ScoreRenderer):
    name = "fluidsynth"

    def __init__(self, soundfont: str):
        self.soundfont = soundfont

    def render_part(self, part: dict, blueprint: dict) -> bytes:
        bpm = float(blueprint["bpm"])
        bpb = int(blueprint["beats_per_bar"])
        unit = int(blueprint.get("beat_unit") or 4)
        n = self.target_samples(blueprint)

        total_beats = int(blueprint["bars"]) * bpb
        tail_beats = TAIL_SECONDS / scorelib.beat_seconds(bpm, unit)
        mid = midi_out.single_part_midi(
            part, bpm=bpm, beats_per_bar=bpb, beat_unit=unit,
            end_beats=total_beats + tail_beats,
        )

        with tempfile.TemporaryDirectory() as tmp:
            mid_path = Path(tmp) / "part.mid"
            wav_path = Path(tmp) / "part.wav"
            mid_path.write_bytes(mid)
            # 输出必须落真实文件而不是管道：WAV 头里的长度字段要在写完后 seek
            # 回去补，管道不可 seek。tme_backend._transcode 已经踩过一次这个坑。
            subprocess.run(
                [
                    "fluidsynth", "-ni", "-q",
                    "-r", str(SR),
                    "-g", "0.9",
                    "-T", "wav",
                    "-F", str(wav_path),
                    self.soundfont, str(mid_path),
                ],
                capture_output=True, timeout=180, check=True,
            )
            # 立体声由 read_wav_samples 自动降混成单声道
            samples, sr = read_wav_samples(wav_path)

        if sr != SR:
            raise RuntimeError(f"fluidsynth 输出采样率是 {sr}，期望 {SR}")

        samples = _wrap_and_trim(samples, n)
        return to_wav_bytes(samples, SR, normalize=False)


# ---------------- 自带的 SoundFont 采样播放 ----------------

class SF2Renderer(ScoreRenderer):
    """用 `backend/sf2.py` 直接读 SoundFont 放采样。**默认走这条。**

    和 FluidSynthRenderer 出的是同一类东西（都是采样音源），区别在于不需要
    任何外部可执行文件 —— 源码跑和打包跑完全一致。
    """

    name = "sf2"

    def __init__(self, soundfont: str):
        self.soundfont = soundfont

    def render_part(self, part: dict, blueprint: dict) -> bytes:
        sf = sf2.load(self.soundfont)
        bpm = float(blueprint["bpm"])
        bpb = int(blueprint["beats_per_bar"])
        unit = int(blueprint.get("beat_unit") or 4)
        n = self.target_samples(blueprint)

        buf = [0.0] * (n + int(TAIL_SECONDS * SR))
        perc = int(part.get("channel") or 0) == scorelib.PERCUSSION_CHANNEL
        # 鼓组在 GM 里是 bank 128；旋律乐器走 bank 0
        bank = 128 if perc else 0
        program = 0 if perc else int(part.get("gm_program") or 0)

        for ev in scorelib.part_note_events(part, bpm, bpb, unit):
            sf.render_note(
                buf, int(ev["start"] * SR), SR,
                bank=bank, program=program, key=ev["pitch"],
                vel=ev["velocity"], dur=ev["dur"], gain=MASTER_GAIN,
            )

        return to_wav_bytes(_wrap_and_trim(buf, n), SR, normalize=False)


# ---------------- 纯 Python 合成 ----------------

# 正弦查表：每个采样点算一次 math.sin 太慢，而这条路径是「没装 fluidsynth 时
# 用户实际会走到的那条」，慢到几十秒就等于没有。查表把内层循环压成一次取模
# 加一次索引。
_TABLE_BITS = 12
_TABLE_SIZE = 1 << _TABLE_BITS
_TABLE_MASK = _TABLE_SIZE - 1
_SINE = [math.sin(2.0 * math.pi * i / _TABLE_SIZE) for i in range(_TABLE_SIZE)]

# 音色。按乐器族给，不是按具体乐器 —— 加法合成本来就分不出长笛和短笛，
# 假装分得出只会让代码变长而听感不变。
_TIMBRES: dict[str, dict] = {
    "strings": {"harmonics": [1.0, 0.55, 0.32, 0.18, 0.09],
                "attack": 0.09, "release": 0.45, "vibrato": 5.0, "gain": 1.0},
    "brass":   {"harmonics": [0.75, 1.0, 0.62, 0.38, 0.22, 0.12],
                "attack": 0.045, "release": 0.3, "vibrato": 4.2, "gain": 0.9},
    "woodwind": {"harmonics": [1.0, 0.28, 0.14, 0.06],
                 "attack": 0.05, "release": 0.32, "vibrato": 5.6, "gain": 1.0},
    "timpani": {"harmonics": [1.0, 0.42, 0.2, 0.08],
                "attack": 0.004, "release": 0.9, "vibrato": 0.0, "gain": 1.15},
    "default": {"harmonics": [1.0, 0.5, 0.25, 0.12],
                "attack": 0.06, "release": 0.4, "vibrato": 4.0, "gain": 1.0},
}

# 鼓件 → (衰减速度, 音高感, 增益)。噪声加指数衰减，够用了。
# 只有 score.DRUM_KEYS 里那几件管弦乐打击乐器，没有踩镲和嗵鼓（那是爵士鼓组）。
_DRUMS: dict[int, tuple[float, float, float]] = {
    35: (9.0, 55.0, 1.3),      # 大鼓：低频、衰减慢，管弦乐的大鼓比流行的更闷更长
    38: (24.0, 190.0, 0.95),   # 小军鼓
    49: (4.0, 3600.0, 0.72),   # 吊镲：拖得最长
    52: (2.6, 2400.0, 0.7),    # 中国钹：更暗、余音更久
    55: (11.0, 5200.0, 0.5),   # 小吊镲
    80: (34.0, 6400.0, 0.34),  # 三角铁（闷音）：一点即止
    81: (3.2, 6400.0, 0.4),    # 三角铁：很长的一串泛音
}


def _timbre_for(library_key: str) -> dict:
    spec = config.get_instrument_spec(library_key)
    family = spec.get("family") or library_key
    if library_key == "timpani" or family == "timpani":
        return _TIMBRES["timpani"]
    return _TIMBRES.get(family, _TIMBRES.get(library_key, _TIMBRES["default"]))


def _envelope(n: int, attack: float, release: float) -> list[float]:
    """ADSR 里只用 A 和 R —— 管弦乐的持续音基本是「起音、保持、放掉」，
    中间那段 decay 在加法合成里听不出来，省掉一段循环。"""
    a = max(1, min(n, int(attack * SR)))
    r = max(1, min(n, int(release * SR)))
    env = [1.0] * n
    for i in range(a):
        env[i] = i / a
    start = n - r
    for i in range(r):
        env[start + i] = 1.0 - i / r
    return env


def _midi_hz(pitch: int) -> float:
    return 440.0 * (2.0 ** ((pitch - 69) / 12.0))


class PySynthRenderer(ScoreRenderer):
    name = "builtin"

    def render_part(self, part: dict, blueprint: dict) -> bytes:
        bpm = float(blueprint["bpm"])
        bpb = int(blueprint["beats_per_bar"])
        unit = int(blueprint.get("beat_unit") or 4)
        n = self.target_samples(blueprint)

        buf = [0.0] * (n + int(TAIL_SECONDS * SR))
        perc = int(part.get("channel") or 0) == scorelib.PERCUSSION_CHANNEL
        timbre = _timbre_for(part.get("library_key") or "")

        for ev in scorelib.part_note_events(part, bpm, bpb, unit):
            start = int(ev["start"] * SR)
            if start >= len(buf):
                continue
            amp = MASTER_GAIN * (ev["velocity"] / 127.0) ** 1.4
            if perc:
                self._drum(buf, start, ev["pitch"], amp)
            else:
                self._tone(buf, start, ev["dur"], ev["pitch"], amp, timbre)

        return to_wav_bytes(_wrap_and_trim(buf, n), SR, normalize=False)

    def _tone(self, buf: list[float], start: int, dur: float, pitch: int,
              amp: float, timbre: dict) -> None:
        freq = _midi_hz(pitch)
        # 音符时值之外再给一段释放，否则每个音都是硬切，听着像电子琴的最低档
        length = int((dur + timbre["release"]) * SR)
        length = min(length, len(buf) - start)
        if length <= 2:
            return

        note = [0.0] * length
        for h, h_amp in enumerate(timbre["harmonics"], start=1):
            f = freq * h
            # 超过奈奎斯特的谐波会折返成完全不相干的低频（混叠），必须丢掉
            if f >= SR / 2:
                break
            inc = f / SR * _TABLE_SIZE
            phase = 0.0
            for i in range(length):
                note[i] += _SINE[int(phase) & _TABLE_MASK] * h_amp
                phase += inc

        # 颤音：给一点缓慢的振幅起伏。真颤音是调频，但调频要在内层循环里改
        # 相位增量，代价翻倍，而听感上这点差别在这条兜底路径里不值得。
        vib = timbre["vibrato"]
        env = _envelope(length, timbre["attack"], timbre["release"])
        g = amp * timbre["gain"] / max(1.0, sum(timbre["harmonics"]))
        if vib > 0:
            w = 2.0 * math.pi * vib / SR
            for i in range(length):
                buf[start + i] += note[i] * env[i] * g * (1.0 + 0.06 * math.sin(w * i))
        else:
            for i in range(length):
                buf[start + i] += note[i] * env[i] * g

    def _drum(self, buf: list[float], start: int, key: int, amp: float) -> None:
        decay, tone_hz, gain = _DRUMS.get(key, (20.0, 200.0, 0.8))
        length = min(int(1.6 * SR), len(buf) - start)
        if length <= 2:
            return
        # 噪声用线性同余自己生成而不是 random：同一份谱子每次渲染要出同样的
        # 字节，否则「重新生成」和「什么都没改」听起来会不一样。
        seed = (key * 2654435761) & 0xFFFFFFFF
        inc = tone_hz / SR * _TABLE_SIZE
        phase = 0.0
        # 高频鼓件（镲）几乎全是噪声，低频鼓件（大鼓/嗵鼓）要有明确的音高感
        noise_mix = 0.92 if tone_hz > 1000 else 0.35
        for i in range(length):
            seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
            noise = (seed / 0x3FFFFFFF) - 1.0
            body = _SINE[int(phase) & _TABLE_MASK]
            phase += inc
            e = math.exp(-decay * i / SR)
            buf[start + i] += (noise * noise_mix + body * (1.0 - noise_mix)) * e * amp * gain


# ---------------- 选择 ----------------

def fluidsynth_available() -> bool:
    return shutil.which("fluidsynth") is not None


def renderer_status() -> dict:
    """给 /api/health 用。前端据此告诉用户当前音色是采样音源还是内置合成。"""
    sf = config.find_soundfont()
    has_fs = fluidsynth_available()
    choice = config.active_renderer_choice().strip().lower()
    # auto 优先自带的 SF2 播放器而不是 fluidsynth：音色是同一类（都是采样），
    # 但不依赖任何外部可执行文件，源码跑和打包跑一致。
    if choice == "fluidsynth":
        active = "fluidsynth" if (has_fs and sf) else ("sf2" if sf else "builtin")
    elif choice == "builtin":
        active = "builtin"
    elif choice == "sf2":
        active = "sf2" if sf else "builtin"
    else:
        active = "sf2" if sf else "builtin"
    return {
        "renderer": active,
        # 键名带前缀：这个 dict 会和 composer_status() 合并进 /api/health 的
        # score 块，两边都叫 configured 的话后合并的那个会静默盖掉前一个。
        "renderer_configured": choice,
        "fluidsynth_found": has_fs,
        "soundfont_found": bool(sf),
        "soundfont_path": sf or "",
        "soundfont_dir": str(config.SOUNDFONT_DIR),
        "sample_rate": SR,
    }


def get_renderer() -> ScoreRenderer:
    st = renderer_status()
    if st["renderer"] == "sf2":
        return SF2Renderer(st["soundfont_path"])
    if st["renderer"] == "fluidsynth":
        return FluidSynthRenderer(st["soundfont_path"])
    if st["renderer_configured"] in ("fluidsynth", "sf2"):
        logger.warning("SCORE_RENDERER=%s 但没在 %s 找到 SoundFont，退回内置合成。",
                       st["renderer_configured"], st["soundfont_dir"])
    return PySynthRenderer()
