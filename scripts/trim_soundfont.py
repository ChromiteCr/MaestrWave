#!/usr/bin/env python3
"""把一个完整的 GM 音源裁成「只含本项目用得到的音色」的小音源。

完整 GM 音源有 128 个旋律音色加若干套鼓组，动辄 200MB，而 MaestrWave 只用
`INSTRUMENT_LIBRARY` 里那十几个 `gm_program`，外加 `score.DRUM_KEYS` 那几件
管弦乐打击乐器。其余全是白带的 —— 裁掉之后才可能把音源直接放进仓库，
让用户零配置就有采样音色。

用法：

    python3 scripts/trim_soundfont.py 完整音源.sf2 backend/soundfonts/orchestral.sf2

做法是**保留 + 重新编号**：挑出要留的 preset，顺着 pbag/pgen → inst →
ibag/igen → shdr 把它们依赖的记录全部收集起来，重建各个表并把所有下标改写成
新表里的位置，样本数据只复制用到的那几段。不改任何音色参数。
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import config          # noqa: E402
import score as scorelib  # noqa: E402
import sf2             # noqa: E402

# 每个样本前后要留的静音帧数，规范要求至少 46 帧，用来给插值留余量。
# 不留的话循环点附近会有咔哒声。
GUARD = 46


def wanted_presets() -> tuple[set[int], bool]:
    """要保留的 (旋律音色号集合, 是否需要鼓组)。"""
    programs = set()
    need_drums = False
    for spec in config.INSTRUMENT_LIBRARY.values():
        if spec.get("percussion"):
            need_drums = True
        else:
            programs.add(int(spec["gm_program"]))
    # 自定义乐器的兜底音色也得留，否则用户填个库里没有的乐器名就没声
    programs.add(config.get_instrument_spec("__custom__")["gm_program"])
    return programs, need_drums


def _pack_name(name: str) -> bytes:
    return name.encode("latin-1", "replace")[:20].ljust(20, b"\0")


def trim(src_path: str, dst_path: str) -> None:
    sf = sf2.load(src_path)
    programs, need_drums = wanted_presets()

    keep_presets = []
    for i, p in enumerate(sf._phdr[:-1]):
        if p["bank"] == 0 and p["program"] in programs:
            keep_presets.append(i)
        elif need_drums and p["bank"] == 128 and p["program"] == 0:
            keep_presets.append(i)

    if not keep_presets:
        raise SystemExit(
            f"源音源里一个需要的音色都没有。需要 bank0 的 {sorted(programs)}"
            f"{'，以及 bank128 的鼓组' if need_drums else ''}。\n"
            f"它有：{', '.join(sf.preset_names()[:12])} …")

    missing = programs - {sf._phdr[i]["program"] for i in keep_presets
                          if sf._phdr[i]["bank"] == 0}
    if missing:
        print(f"⚠️  源音源缺这些音色，将来会退到 0 号：{sorted(missing)}")

    # ---- 收集依赖 ----
    inst_used: list[int] = []
    smpl_used: list[int] = []

    def add(seq, v):
        if v not in seq:
            seq.append(v)
        return seq.index(v)

    new_pbag, new_pgen, new_phdr = [], [], []
    for pi in keep_presets:
        p = sf._phdr[pi]
        bag_end = (sf._phdr[pi + 1]["bag"] if pi + 1 < len(sf._phdr) else len(sf._pbag))
        new_phdr.append({"name": p["name"], "program": p["program"],
                         "bank": p["bank"], "bag": len(new_pbag)})
        for lo, hi in sf._bag_range(sf._pbag, len(sf._pgen), p["bag"], bag_end):
            new_pbag.append(len(new_pgen))
            for oper, amount in sf._pgen[lo:hi]:
                if oper == sf2.GEN_INSTRUMENT:
                    amount = add(inst_used, amount)
                new_pgen.append((oper, amount))

    new_ibag, new_igen, new_inst = [], [], []
    for ii in inst_used:
        inst = sf._inst[ii]
        bag_end = (sf._inst[ii + 1]["bag"] if ii + 1 < len(sf._inst) else len(sf._ibag))
        new_inst.append({"name": inst["name"], "bag": len(new_ibag)})
        for lo, hi in sf._bag_range(sf._ibag, len(sf._igen), inst["bag"], bag_end):
            new_ibag.append(len(new_igen))
            for oper, amount in sf._igen[lo:hi]:
                if oper == sf2.GEN_SAMPLE_ID:
                    amount = add(smpl_used, amount)
                new_igen.append((oper, amount))

    # ---- 复制样本 ----
    smpl = bytearray()
    new_shdr = []
    for si in smpl_used:
        h = sf._shdr[si]
        n = h["end"] - h["start"]
        if n <= 0:
            new_shdr.append({**h, "start": 0, "end": 0, "loop_start": 0, "loop_end": 0})
            continue
        base = len(smpl) // 2
        smpl += sf._smpl[h["start"] * 2:h["end"] * 2]
        smpl += b"\0" * (GUARD * 2)
        new_shdr.append({
            **h,
            "start": base, "end": base + n,
            "loop_start": base + (h["loop_start"] - h["start"]),
            "loop_end": base + (h["loop_end"] - h["start"]),
        })

    _write(dst_path, new_phdr, new_pbag, new_pgen,
           new_inst, new_ibag, new_igen, new_shdr, bytes(smpl))

    src_mb = Path(src_path).stat().st_size / 1024 / 1024
    dst_mb = Path(dst_path).stat().st_size / 1024 / 1024
    print(f"保留 {len(new_phdr)} 个音色、{len(new_inst)} 个乐器、"
          f"{len(new_shdr)} 段样本")
    print(f"{src_mb:.1f} MB → {dst_mb:.1f} MB（{dst_mb / src_mb * 100:.1f}%）")


def _chunk(tag: bytes, body: bytes) -> bytes:
    # RIFF 块要偶数对齐，奇数长度后面补一个字节
    pad = b"\0" if len(body) & 1 else b""
    return tag + struct.pack("<I", len(body)) + body + pad


def _write(path, phdr, pbag, pgen, inst, ibag, igen, shdr, smpl) -> None:
    info = _chunk(b"ifil", struct.pack("<HH", 2, 4))
    info += _chunk(b"isng", b"EMU8000\0")
    info += _chunk(b"INAM", b"MaestrWave Orchestral\0")
    info = _chunk(b"LIST", b"INFO" + info)

    sdta = _chunk(b"LIST", b"sdta" + _chunk(b"smpl", smpl))

    # 每张表末尾都要一条终止记录，解析器靠它算出最后一条的长度
    body = b"phdr"
    ph = b"".join(struct.pack("<20sHHHIII", _pack_name(p["name"]), p["program"],
                              p["bank"], p["bag"], 0, 0, 0) for p in phdr)
    ph += struct.pack("<20sHHHIII", _pack_name("EOP"), 0, 0, len(pbag), 0, 0, 0)
    body += b""  # 占位，下面统一拼

    out = _chunk(b"phdr", ph)
    out += _chunk(b"pbag", b"".join(struct.pack("<HH", g, 0) for g in pbag)
                  + struct.pack("<HH", len(pgen), 0))
    out += _chunk(b"pmod", struct.pack("<HHHHH", 0, 0, 0, 0, 0))
    out += _chunk(b"pgen", b"".join(_gen_bytes(o, a) for o, a in pgen)
                  + struct.pack("<HH", 0, 0))
    out += _chunk(b"inst", b"".join(struct.pack("<20sH", _pack_name(i["name"]), i["bag"])
                                    for i in inst)
                  + struct.pack("<20sH", _pack_name("EOI"), len(ibag)))
    out += _chunk(b"ibag", b"".join(struct.pack("<HH", g, 0) for g in ibag)
                  + struct.pack("<HH", len(igen), 0))
    out += _chunk(b"imod", struct.pack("<HHHHH", 0, 0, 0, 0, 0))
    out += _chunk(b"igen", b"".join(_gen_bytes(o, a) for o, a in igen)
                  + struct.pack("<HH", 0, 0))
    out += _chunk(b"shdr", b"".join(
        struct.pack("<20sIIIIIBbHH", _pack_name(h["name"]), h["start"], h["end"],
                    h["loop_start"], h["loop_end"], h["rate"], h["root"],
                    h["correction"], 0, h["type"]) for h in shdr)
        + struct.pack("<20sIIIIIBbHH", _pack_name("EOS"), 0, 0, 0, 0, 0, 0, 0, 0, 0))
    pdta = _chunk(b"LIST", b"pdta" + out)

    payload = b"sfbk" + info + sdta + pdta
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(b"RIFF" + struct.pack("<I", len(payload)) + payload)


def _gen_bytes(oper: int, amount) -> bytes:
    if isinstance(amount, tuple):
        return struct.pack("<HBB", oper, amount[0], amount[1])
    if amount < 0:
        return struct.pack("<Hh", oper, amount)
    return struct.pack("<HH", oper, amount & 0xFFFF)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    trim(sys.argv[1], sys.argv[2])
