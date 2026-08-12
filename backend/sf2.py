"""SoundFont 2 的解析与采样播放，纯标准库（M7a2）。

**为什么自己写而不是调 fluidsynth**：fluidsynth 是个外部可执行文件，连它的
递归依赖一共 19 个文件 7.8MB，还得按平台各收一套、在 macOS 上改 install_name，
而从源码跑的人依然要自己 `brew install`。自己解析 SF2 之后，源码跑和打包跑
完全一致，到哪台机器都出得了声。这和这个仓库手写 HMAC 签名（tme_backend）、
手写 MIDI 写入（midi_out）是同一个取舍。

**实现到什么程度**：够放管弦乐，不是完整的 SF2 合成器。
  做了：样本区选择（按音高与力度）、按音高重采样（线性插值）、循环点、
        音量包络（延迟/起音/保持/衰减/延持/释放）、初始衰减、粗调与微调。
  没做：滤波器、LFO、调制器（modulator）、立体声声像、和声效果。
        管弦乐音源基本不依赖这些，而每加一项都要多一层每采样的运算。

格式参考：SoundFont 2.04 规范。RIFF 分块，样本在 sdta/smpl（16-bit PCM），
分区信息在 pdta 的九个子块里。
"""
from __future__ import annotations

import logging
import struct
from pathlib import Path
from typing import Optional, Union

logger = logging.getLogger(__name__)


class SF2Error(RuntimeError):
    pass


# ---- 用得上的发生器（generator）编号，取自 SF2 规范 8.1.3 ----
GEN_START_ADDR_OFS = 0
GEN_END_ADDR_OFS = 1
GEN_STARTLOOP_OFS = 2
GEN_ENDLOOP_OFS = 3
GEN_START_ADDR_COARSE = 4
GEN_END_ADDR_COARSE = 12
GEN_PAN = 17
GEN_DELAY_VOL_ENV = 33
GEN_ATTACK_VOL_ENV = 34
GEN_HOLD_VOL_ENV = 35
GEN_DECAY_VOL_ENV = 36
GEN_SUSTAIN_VOL_ENV = 37
GEN_RELEASE_VOL_ENV = 38
GEN_INSTRUMENT = 41
GEN_KEY_RANGE = 43
GEN_VEL_RANGE = 44
GEN_STARTLOOP_COARSE = 45
GEN_ENDLOOP_COARSE = 50
GEN_INITIAL_ATTENUATION = 48
GEN_COARSE_TUNE = 51
GEN_FINE_TUNE = 52
GEN_SAMPLE_ID = 53
GEN_SAMPLE_MODES = 54
GEN_SCALE_TUNING = 56
GEN_OVERRIDING_ROOT_KEY = 58

# 这些发生器的取值是有符号的。SF2 把所有 genAmount 都存成 16 位，
# 按无符号读会让「降八度」（-1200 音分）变成 64336，音高直接飞掉。
_SIGNED_GENS = {
    GEN_START_ADDR_OFS, GEN_END_ADDR_OFS, GEN_STARTLOOP_OFS, GEN_ENDLOOP_OFS,
    GEN_START_ADDR_COARSE, GEN_END_ADDR_COARSE, GEN_STARTLOOP_COARSE,
    GEN_ENDLOOP_COARSE, GEN_PAN, GEN_COARSE_TUNE, GEN_FINE_TUNE,
    GEN_DELAY_VOL_ENV, GEN_ATTACK_VOL_ENV, GEN_HOLD_VOL_ENV,
    GEN_DECAY_VOL_ENV, GEN_RELEASE_VOL_ENV,
}

# 各发生器缺省值（规范 8.1.2）。没显式给的走这里。
_DEFAULTS = {
    GEN_KEY_RANGE: (0, 127),
    GEN_VEL_RANGE: (0, 127),
    GEN_INITIAL_ATTENUATION: 0,
    GEN_COARSE_TUNE: 0,
    GEN_FINE_TUNE: 0,
    GEN_SCALE_TUNING: 100,
    GEN_SAMPLE_MODES: 0,
    # 包络时间是 timecents，-12000 相当于 1 毫秒，规范里的「无」
    GEN_DELAY_VOL_ENV: -12000,
    GEN_ATTACK_VOL_ENV: -12000,
    GEN_HOLD_VOL_ENV: -12000,
    GEN_DECAY_VOL_ENV: -12000,
    GEN_SUSTAIN_VOL_ENV: 0,
    GEN_RELEASE_VOL_ENV: -12000,
}


# GM 里鼓组固定在 bank 128。
DRUM_BANK = 128

# 鼓件缺失时的替代链，按「音色最接近」排。管弦乐那几件（三角铁、小吊镲、
# 中国钹）在不少 GM 音源里是没有的，尤其是电子鼓组。
DRUM_ALTERNATIVES: dict[int, tuple[int, ...]] = {
    35: (36, 41, 45),          # 大鼓 → 另一个大鼓 → 低嗵
    36: (35, 41, 45),
    38: (40, 37, 39),          # 小军鼓 → 边击 → 拍手
    49: (57, 55, 52, 51),      # 吊镲 → 另一片吊镲 → 小吊镲 → 中国钹 → 叮叮
    52: (49, 57, 55),          # 中国钹 → 吊镲
    55: (49, 57, 51),          # 小吊镲 → 吊镲
    80: (81, 51, 42),          # 闷三角铁 → 三角铁 → 叮叮
    81: (80, 51, 49),          # 三角铁 → 闷三角铁 → 叮叮 → 吊镲
}

# 旋律音色缺失时的替代链，按「音色最接近」排。
#
# 裁剪过的音源缺音色是常态：随仓库分发的 `orchestral.sf2` 只有 12 个音色，
# **没有中提琴（41）、低音提琴（43）、大管（70）**，也没有 GM 钢琴（0）。
# 原来的退路是「同 bank 的 0 号 → GM 钢琴」，这两个它一个都没有，于是整条声部
# 悄悄变成静音 —— 轨还在、长度也对、不报错，只是没声音。贝多芬第七第二乐章
# 的主题正好在中提琴与低音提琴上，听起来就是「这首曲子没声音」。
#
# 表里只写**同族的**替代：中提琴退到弦乐合奏而不是小提琴（音区差一截），
# 低音提琴退到大提琴，大管退到单簧管（都是低音区还有样本的木管）。
# 表外的按 GM 家族（每 8 个一族）就近找，再不行才在全部音色里找最近的号。
MELODIC_ALTERNATIVES: dict[int, tuple[int, ...]] = {
    41: (48, 40, 42),          # 中提琴 → 弦乐合奏 → 小提琴 → 大提琴
    43: (42, 48, 58),          # 低音提琴 → 大提琴 → 弦乐合奏 → 大号
    70: (71, 68, 57),          # 大管 → 单簧管 → 双簧管 → 长号
    69: (68, 71),              # 英国管 → 双簧管 → 单簧管
    58: (57, 61),              # 大号 → 长号 → 铜管组
    45: (48, 40),              # 拨弦弦乐 → 弦乐合奏 → 小提琴
    46: (48, 40),              # 竖琴 → 弦乐合奏
}


def timecents_to_seconds(tc: float) -> float:
    """timecents → 秒。-12000 及以下当作 0（规范里表示「没有这一段」）。"""
    if tc <= -12000:
        return 0.0
    return 2.0 ** (tc / 1200.0)


def centibels_to_gain(cb: float) -> float:
    """百分贝衰减 → 线性增益。960 cB（96 dB）以上视作静音。"""
    if cb <= 0:
        return 1.0
    if cb >= 960:
        return 0.0
    return 10.0 ** (-cb / 200.0)


def pan_to_mono_gain(pan: float) -> float:
    """SF2 的声像 → 单声道降混增益。

    我们全程输出单声道，而 SF2 里**硬左 + 硬右叠两层**是很常见的写法（实测
    VintageDreams 的多数音色就是这样）。两层都按原样叠加，出来的音量是应有的
    两倍 —— 这不是「立体声变单声道」，是实打实的错。

    按 `(L+R)/2` 的降混规则算：等功率声像下 L=√((1−p)/2)、R=√((1+p)/2)，
    单声道贡献就是 (L+R)/2。硬左与硬右各得 0.5，两层加起来正好还原成 1.0；
    居中的一层得 0.707 —— 和把立体声输出平均成单声道的结果一致。
    """
    p = max(-1.0, min(1.0, pan / 500.0))
    left = ((1.0 - p) / 2.0) ** 0.5
    right = ((1.0 + p) / 2.0) ** 0.5
    return (left + right) / 2.0


class Zone:
    """一个已经解析好的样本区：给定音高与力度后真正要播的那段样本。"""

    __slots__ = ("start", "end", "loop_start", "loop_end", "sample_rate",
                 "root_key", "tune_cents", "loop", "attenuation", "scale_tuning",
                 "delay", "attack", "hold", "decay", "sustain", "release",
                 "mono_gain")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw[k])


class SoundFont:
    """解析一个 .sf2 文件。

    只在构造时读一次盘，样本数据整块留在内存 —— 裁剪过的管弦乐音源只有几 MB，
    而每个音符都回盘上 seek 一次会比合成本身还慢。
    """

    def __init__(self, path: Union[str, Path]):
        self.path = str(path)
        data = Path(path).read_bytes()
        self._parse(data)

    # ---------------- RIFF ----------------

    @staticmethod
    def _chunks(buf: bytes, start: int, end: int):
        """依次产出 (标签, 起, 止)。RIFF 的块是**偶数对齐**的，
        奇数长度后面会补一个填充字节，不跳过它后面所有块的偏移都会错位。"""
        pos = start
        while pos + 8 <= end:
            tag = buf[pos:pos + 4]
            size = struct.unpack_from("<I", buf, pos + 4)[0]
            body = pos + 8
            yield tag, body, min(body + size, end)
            pos = body + size + (size & 1)

    def _parse(self, buf: bytes) -> None:
        if buf[:4] != b"RIFF" or buf[8:12] != b"sfbk":
            raise SF2Error("不是 SoundFont 2 文件（缺 RIFF/sfbk 头）")
        total = min(len(buf), 8 + struct.unpack_from("<I", buf, 4)[0])

        smpl = (0, 0)
        pdta: dict[bytes, tuple[int, int]] = {}
        for tag, s, e in self._chunks(buf, 12, total):
            if tag != b"LIST":
                continue
            kind = buf[s:s + 4]
            if kind == b"sdta":
                for t2, s2, e2 in self._chunks(buf, s + 4, e):
                    if t2 == b"smpl":
                        smpl = (s2, e2)
            elif kind == b"pdta":
                for t2, s2, e2 in self._chunks(buf, s + 4, e):
                    pdta[t2] = (s2, e2)

        need = [b"phdr", b"pbag", b"pgen", b"inst", b"ibag", b"igen", b"shdr"]
        missing = [t.decode() for t in need if t not in pdta]
        if missing:
            raise SF2Error(f"pdta 里缺少必需的子块：{', '.join(missing)}")

        # 样本数据保持 16-bit PCM 原样，取用时再转 float —— 一个几 MB 的音源
        # 全转成 Python float 列表会膨胀到几十倍内存。
        s, e = smpl
        self._smpl = buf[s:e]
        self._smpl_count = (e - s) // 2

        self._phdr = self._read_phdr(buf, *pdta[b"phdr"])
        self._pbag = self._read_bag(buf, *pdta[b"pbag"])
        self._pgen = self._read_gen(buf, *pdta[b"pgen"])
        self._inst = self._read_inst(buf, *pdta[b"inst"])
        self._ibag = self._read_bag(buf, *pdta[b"ibag"])
        self._igen = self._read_gen(buf, *pdta[b"igen"])
        self._shdr = self._read_shdr(buf, *pdta[b"shdr"])

        # (bank, program) → phdr 下标
        self._presets: dict[tuple[int, int], int] = {}
        for i, p in enumerate(self._phdr[:-1]):        # 最后一条是终止记录 EOP
            self._presets[(p["bank"], p["program"])] = i
        self._zone_cache: dict[tuple[int, int, int, int], list[Zone]] = {}
        # 缺失音色 → 替代音色的 phdr 下标（None 表示确实没得替）。缓存是为了
        # 那条 warning 只打一次，不是为了性能 —— 一个声部几千个音符
        # 每个都打一行日志的话，真正的问题会被淹掉
        self._preset_fallback: dict[tuple[int, int], Optional[int]] = {}

    @staticmethod
    def _read_phdr(buf, s, e):
        out = []
        for pos in range(s, e - 37, 38):
            name, program, bank, bag = struct.unpack_from("<20sHHH", buf, pos)
            out.append({"name": name.split(b"\0")[0].decode("latin-1"),
                        "program": program, "bank": bank, "bag": bag})
        return out

    @staticmethod
    def _read_inst(buf, s, e):
        out = []
        for pos in range(s, e - 21, 22):
            name, bag = struct.unpack_from("<20sH", buf, pos)
            out.append({"name": name.split(b"\0")[0].decode("latin-1"), "bag": bag})
        return out

    @staticmethod
    def _read_bag(buf, s, e):
        return [struct.unpack_from("<HH", buf, pos)[0]
                for pos in range(s, e - 3, 4)]

    @staticmethod
    def _read_gen(buf, s, e):
        out = []
        for pos in range(s, e - 3, 4):
            oper, amount = struct.unpack_from("<HH", buf, pos)
            if oper in (GEN_KEY_RANGE, GEN_VEL_RANGE):
                out.append((oper, (amount & 0xFF, (amount >> 8) & 0xFF)))
            elif oper in _SIGNED_GENS:
                out.append((oper, struct.unpack("<h", struct.pack("<H", amount))[0]))
            else:
                out.append((oper, amount))
        return out

    @staticmethod
    def _read_shdr(buf, s, e):
        out = []
        for pos in range(s, e - 45, 46):
            (name, start, end_, ls, le, rate, pitch, corr, link,
             typ) = struct.unpack_from("<20sIIIIIBbHH", buf, pos)
            out.append({"name": name.split(b"\0")[0].decode("latin-1"),
                        "start": start, "end": end_, "loop_start": ls,
                        "loop_end": le, "rate": rate or 44100,
                        "root": pitch, "correction": corr, "type": typ})
        return out

    # ---------------- 分区解析 ----------------

    @staticmethod
    def _bag_range(bags: list[int], gens_len: int, first: int, last: int):
        """产出 (该 bag 的 gen 起, 止)。bag 表里存的是**起点**，某个 bag 的
        终点是下一个 bag 的起点 —— 最后一个 bag 用 gen 表长度收尾。"""
        for i in range(first, last):
            lo = bags[i]
            hi = bags[i + 1] if i + 1 < len(bags) else gens_len
            yield lo, hi

    def _collect(self, gens, lo, hi) -> dict:
        return {oper: amount for oper, amount in gens[lo:hi]}

    def _instrument_zones(self, inst_idx: int, key: int, vel: int,
                          preset_gens: dict) -> list[Zone]:
        inst = self._inst[inst_idx]
        bag_end = (self._inst[inst_idx + 1]["bag"] if inst_idx + 1 < len(self._inst)
                   else len(self._ibag))
        zones: list[Zone] = []
        global_gens: dict = {}

        for gi, (lo, hi) in enumerate(
                self._bag_range(self._ibag, len(self._igen), inst["bag"], bag_end)):
            gens = self._collect(self._igen, lo, hi)
            if GEN_SAMPLE_ID not in gens:
                # 没有 sampleID 的第一个分区是**全局区**，它的发生器作为后面
                # 所有分区的默认值。漏掉它，很多音源的包络和衰减会全丢。
                if gi == 0:
                    global_gens = gens
                continue

            merged = {**_DEFAULTS, **global_gens, **gens}
            klo, khi = merged[GEN_KEY_RANGE]
            vlo, vhi = merged[GEN_VEL_RANGE]
            if not (klo <= key <= khi and vlo <= vel <= vhi):
                continue

            # 预设层的发生器对乐器层是**相加**关系，不是覆盖（规范 9.4）
            for g in (GEN_INITIAL_ATTENUATION, GEN_COARSE_TUNE, GEN_FINE_TUNE,
                      GEN_ATTACK_VOL_ENV, GEN_DECAY_VOL_ENV, GEN_RELEASE_VOL_ENV,
                      GEN_HOLD_VOL_ENV, GEN_SUSTAIN_VOL_ENV, GEN_PAN):
                if g in preset_gens:
                    merged[g] = merged.get(g, 0) + preset_gens[g]

            sid = merged[GEN_SAMPLE_ID]
            if sid >= len(self._shdr):
                continue
            sh = self._shdr[sid]

            start = sh["start"] + merged.get(GEN_START_ADDR_OFS, 0) \
                + 32768 * merged.get(GEN_START_ADDR_COARSE, 0)
            end = sh["end"] + merged.get(GEN_END_ADDR_OFS, 0) \
                + 32768 * merged.get(GEN_END_ADDR_COARSE, 0)
            ls = sh["loop_start"] + merged.get(GEN_STARTLOOP_OFS, 0) \
                + 32768 * merged.get(GEN_STARTLOOP_COARSE, 0)
            le = sh["loop_end"] + merged.get(GEN_ENDLOOP_OFS, 0) \
                + 32768 * merged.get(GEN_ENDLOOP_COARSE, 0)

            start = max(0, min(start, self._smpl_count))
            end = max(start, min(end, self._smpl_count))
            ls = max(start, min(ls, end))
            le = max(ls + 1, min(le, end))

            root = merged.get(GEN_OVERRIDING_ROOT_KEY, sh["root"])
            if not (0 <= root <= 127):
                root = sh["root"]

            zones.append(Zone(
                start=start, end=end, loop_start=ls, loop_end=le,
                sample_rate=sh["rate"], root_key=root,
                tune_cents=merged[GEN_COARSE_TUNE] * 100 + merged[GEN_FINE_TUNE]
                + sh["correction"],
                loop=bool(merged[GEN_SAMPLE_MODES] & 1),
                attenuation=merged[GEN_INITIAL_ATTENUATION],
                scale_tuning=merged.get(GEN_SCALE_TUNING, 100),
                delay=timecents_to_seconds(merged[GEN_DELAY_VOL_ENV]),
                attack=timecents_to_seconds(merged[GEN_ATTACK_VOL_ENV]),
                hold=timecents_to_seconds(merged[GEN_HOLD_VOL_ENV]),
                decay=timecents_to_seconds(merged[GEN_DECAY_VOL_ENV]),
                sustain=merged[GEN_SUSTAIN_VOL_ENV],
                release=timecents_to_seconds(merged[GEN_RELEASE_VOL_ENV]),
                # 声像只用来算单声道降混权重，不做真正的立体声
                mono_gain=pan_to_mono_gain(merged.get(GEN_PAN, 0)),
            ))
        return zones

    def zones(self, bank: int, program: int, key: int, vel: int) -> list[Zone]:
        """给定音色与音高力度，返回要叠加播放的样本区。查不到返回空表。"""
        ck = (bank, program, key, vel)
        hit = self._zone_cache.get(ck)
        if hit is not None:
            return hit

        pi = self._presets.get((bank, program))
        if pi is None:
            pi = self._melodic_fallback(bank, program)
            if pi is None:
                self._zone_cache[ck] = []
                return []

        preset = self._phdr[pi]
        bag_end = (self._phdr[pi + 1]["bag"] if pi + 1 < len(self._phdr)
                   else len(self._pbag))
        out: list[Zone] = []
        global_pgens: dict = {}

        for gi, (lo, hi) in enumerate(
                self._bag_range(self._pbag, len(self._pgen), preset["bag"], bag_end)):
            gens = self._collect(self._pgen, lo, hi)
            if GEN_INSTRUMENT not in gens:
                if gi == 0:
                    global_pgens = gens
                continue
            merged = {**global_pgens, **gens}
            klo, khi = merged.get(GEN_KEY_RANGE, (0, 127))
            vlo, vhi = merged.get(GEN_VEL_RANGE, (0, 127))
            if not (klo <= key <= khi and vlo <= vel <= vhi):
                continue
            idx = merged[GEN_INSTRUMENT]
            if 0 <= idx < len(self._inst):
                out += self._instrument_zones(idx, key, vel, merged)

        self._zone_cache[ck] = out
        return out

    def _melodic_fallback(self, bank: int, program: int) -> Optional[int]:
        """音色缺失时挑一个最接近的，挑不到返回 None。

        三层，一层比一层粗：①手写的同族替代表；②同一个 GM 家族（每 8 个一族，
        弦乐/木管/铜管各自成组）里号最近的；③整个音源里号最近的。

        **不再退到 GM 钢琴**：裁剪过的音源往往连 0 号都没有（随仓库那份就没有），
        退到一个不存在的音色等于静音，而静音是所有失败模式里最难查的一种 ——
        不报错、轨还在、长度也对。这里退不到就**记一条警告**。
        """
        if (bank, program) in self._preset_fallback:
            return self._preset_fallback[(bank, program)]

        same_bank = sorted(p for (b, p) in self._presets if b == bank)
        pick: Optional[int] = None
        for alt in MELODIC_ALTERNATIVES.get(program, ()):
            if (bank, alt) in self._presets:
                pick = alt
                break
        if pick is None:
            family = program // 8
            in_family = [p for p in same_bank if p // 8 == family]
            pool = in_family or same_bank
            if pool:
                pick = min(pool, key=lambda p: abs(p - program))

        pi = self._presets.get((bank, pick)) if pick is not None else None
        if pi is None:
            logger.warning("音源里没有 %d:%d，也找不到替代音色，这一声部会是静音",
                           bank, program)
        else:
            logger.info("音源里没有 %d:%d，改用 %d:%d（%s）",
                        bank, program, bank, pick, self._phdr[pi]["name"])
        self._preset_fallback[(bank, program)] = pi
        return pi

    def _drum_fallback(self, bank: int, program: int, key: int, vel: int) -> list["Zone"]:
        """鼓件缺失时换一件音色最接近的。

        GM 的鼓组映射是「建议」不是强制，各家音源实际有哪些键差别很大 ——
        实测 fluidsynth 自带的 TR-808 鼓组就没有三角铁和小吊镲。作曲器写了
        这些键，音源里没有，那一声就凭空消失了，而且**完全不报错**：轨还在、
        长度也对，只是少了几下，非常难查。所以这里退到同族的替代品。
        """
        for alt in DRUM_ALTERNATIVES.get(key, ()):
            zs = self.zones(bank, program, alt, vel)
            if zs:
                logger.debug("鼓件 %d 在音源里没有，改用 %d", key, alt)
                return zs
        return []

    def has_preset(self, bank: int, program: int) -> bool:
        return (bank, program) in self._presets

    def has_drum_key(self, key: int, program: int = 0) -> bool:
        return bool(self.zones(DRUM_BANK, program, key, 100))

    def preset_names(self) -> list[str]:
        return [f"{p['bank']}:{p['program']} {p['name']}" for p in self._phdr[:-1]]

    # ---------------- 播放 ----------------

    def render_note(self, buf: list[float], offset: int, sr: int, *,
                    bank: int, program: int, key: int, vel: int,
                    dur: float, gain: float = 1.0) -> None:
        """把一个音符叠加进 buf。offset 是起点（采样数），dur 是按住的秒数。"""
        zs = self.zones(bank, program, key, vel)
        if not zs and bank == DRUM_BANK:
            zs = self._drum_fallback(bank, program, key, vel)
        if not zs:
            return
        vel_gain = (vel / 127.0) ** 1.2
        for z in zs:
            self._render_zone(buf, offset, sr, z, key, dur, gain * vel_gain)

    def _render_zone(self, buf: list[float], offset: int, sr: int, z: Zone,
                     key: int, dur: float, gain: float) -> None:
        smpl = self._smpl
        n_buf = len(buf)
        if offset >= n_buf:
            return

        # 播放速率：音高差 + 音源自带的调音，再乘上采样率之比
        cents = (key - z.root_key) * (z.scale_tuning / 100.0) * 100 + z.tune_cents
        step = (2.0 ** (cents / 1200.0)) * (z.sample_rate / sr)
        if step <= 0:
            return

        atten = centibels_to_gain(z.attenuation) * gain * z.mono_gain
        if atten <= 0.0001:
            return

        # 包络分段（秒 → 采样数）
        d_n = int(z.delay * sr)
        a_n = max(1, int(z.attack * sr)) if z.attack > 0 else 0
        h_n = int(z.hold * sr)
        dec_n = max(1, int(z.decay * sr)) if z.decay > 0 else 0
        sus = centibels_to_gain(z.sustain)
        rel_n = max(1, int(z.release * sr)) if z.release > 0 else 1
        held_n = max(1, int(dur * sr))
        total = held_n + rel_n

        loop_len = z.loop_end - z.loop_start
        can_loop = z.loop and loop_len > 1

        pos = float(z.start)
        end_f = float(z.end)
        for i in range(total):
            j = offset + i
            if j >= n_buf:
                break

            # --- 取样本（线性插值）---
            ip = int(pos)
            if ip + 1 >= z.end:
                if can_loop and i < held_n:
                    pos = z.loop_start + (pos - z.loop_end) % loop_len
                    ip = int(pos)
                else:
                    break
            frac = pos - ip
            a = struct.unpack_from("<h", smpl, ip * 2)[0]
            b = struct.unpack_from("<h", smpl, (ip + 1) * 2)[0]
            s = (a + (b - a) * frac) / 32768.0

            # --- 包络 ---
            if i < d_n:
                env = 0.0
            elif i < d_n + a_n:
                env = (i - d_n) / a_n if a_n else 1.0
            elif i < d_n + a_n + h_n:
                env = 1.0
            elif i < held_n:
                if dec_n:
                    k = (i - d_n - a_n - h_n) / dec_n
                    env = 1.0 - (1.0 - sus) * min(1.0, k)
                else:
                    env = sus
            else:
                # 释放段从「松手那一刻的包络值」往下走，不是从 1 往下走 ——
                # 后者会让每个音在放开时先跳响一下
                base = sus if dec_n or h_n or a_n else 1.0
                env = base * max(0.0, 1.0 - (i - held_n) / rel_n)
                if env <= 0.0:
                    break

            buf[j] += s * env * atten
            pos += step
            if pos >= end_f and not can_loop:
                break


_cache: dict[str, SoundFont] = {}


def load(path: Union[str, Path]) -> SoundFont:
    """带缓存的加载。同一个音源在一次生成里会被十几件乐器反复用到，
    每次都重新解析几 MB 的文件是纯粹的浪费。"""
    key = str(path)
    sf = _cache.get(key)
    if sf is None:
        sf = SoundFont(path)
        _cache[key] = sf
        logger.info("已加载 SoundFont %s（%d 个音色）", key, len(sf.preset_names()))
    return sf
