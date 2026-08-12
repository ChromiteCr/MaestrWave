"""随仓库分发的真实交响乐曲目：清单、渲染缓存、以及「造成一个可指挥的项目」。

和 `practice.py` 的关系：那边是**照规格写谱**（同一份 spec 永远渲染出同一份音频），
这边是**读别人排好的总谱**。两者产出的东西刻意做成同形 —— 同样的
`(wav, mid, meta{grid, loudness_per_bar})`、同样落在 `config.PRACTICE_DIR`，
于是 `/api/practice/{id}/*` 那几个端点、前端的 `PiecePlayer` 与 `PracticeRunner`
一行都不用改。

## 为什么不支持任意 MIDI 上传

只接这里列出的、随仓库分发的文件。任意上传要处理速度图、拍号变更、声部识别，
还有一个「解析用户文件」的安全面，是另一件事。这里的每一首都**人工核对过**
声部顺序与截取窗口。
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

try:
    from . import config, midi_in, practice, project as projectlib, render as renderlib, score as scorelib
    from .audio_utils import read_wav_bytes, to_wav_bytes
    from . import midi_out
except ImportError:  # 脚本方式跑
    import config, midi_in, practice, project as projectlib, render as renderlib, score as scorelib
    from audio_utils import read_wav_bytes, to_wav_bytes
    import midi_out

logger = logging.getLogger(__name__)

# 改了本模块里任何影响音符的逻辑就 +1。理由同 `practice._ALGO_VERSION`：
# 缓存键不含算法版本的话，改完逻辑后旧音频会被继续端出来。
_ALGO_VERSION = 1

ASSET_DIR = Path(__file__).resolve().parent.parent / "assets" / "repertoire"


@dataclass(frozen=True)
class RepertoireItem:
    id: str
    title: str
    composer: str
    """曲目文件名（相对 assets/repertoire/）。"""
    filename: str
    """截取窗口的起点，用 **tick** 给。

    不用小节号：小节号在多拍号文件里不成立。埃格蒙特前面是 3/2 与 3/4，
    尾声那段 4/4 的起点除以 4/4 的小节长度是 232.5，照小节号截会从半个小节中间
    切进去。tick 是文件里唯一无歧义的时间坐标。
    """
    start_tick: int
    """取几小节（按窗口内那个拍号算）。0 = 一直到最后一个音符。"""
    bars: int
    """这一段在讲什么，界面上原样显示。"""
    blurb: str
    """许可，界面上要显示 —— 随仓库分发就得说清楚出处。"""
    license: str
    source_url: str
    """按**总谱顺序**给的声部表。轨 0 通常是控制轨，不在这里出现。"""
    tracks: dict[int, midi_in.TrackSpec]
    """考试用的数拍小节数；体验模式不数拍，给 0。"""
    count_in_bars: int = 0


def _t(name, key, gm, role="harmony"):
    return midi_in.TrackSpec(name=name, library_key=key, gm_program=gm, role=role)


# 声部表按**总谱顺序**写死，不读文件里的 GM 程序号 —— 这两份文件的圆号与小号
# 都被 LilyPond 写成 GM 69（英国管），那是没设 midiInstrument 时的默认值。
# 轨道名也只是 `one:` `two:`，同样认不得。
_BEETHOVEN_7_TRACKS = {
    1: _t("长笛", "flute", 73, "melody"),
    2: _t("双簧管", "oboe", 68, "melody"),
    3: _t("单簧管", "clarinet", 71),
    # 库里没有 bassoon：library_key 取 woodwind 只为拿到木管音色族（纯 Python
    # 合成用），GM 音色仍给真正的大管 70。两者分开的理由见 midi_in 文件头。
    4: _t("大管", "woodwind", 70),
    5: _t("圆号", "french_horn", 60),
    6: _t("小号", "trumpet", 56, "melody"),
    7: _t("定音鼓", "timpani", 47, "rhythm"),
    8: _t("小提琴 I", "violin", 40, "melody"),
    9: _t("小提琴 II", "violin", 40, "melody"),
    10: _t("中提琴", "strings", 41),
    11: _t("大提琴", "cello", 42, "bass"),
    12: _t("低音提琴", "cello", 43, "bass"),
}

_EGMONT_TRACKS = {
    1: _t("长笛 I", "flute", 73, "melody"),
    2: _t("长笛 II", "flute", 73, "melody"),
    3: _t("双簧管", "oboe", 68, "melody"),
    4: _t("单簧管", "clarinet", 71),
    5: _t("大管", "woodwind", 70),
    6: _t("圆号", "french_horn", 60),
    7: _t("小号", "trumpet", 56, "melody"),
    8: _t("长号", "trombone", 57),
    9: _t("定音鼓", "timpani", 47, "rhythm"),
    10: _t("小提琴 I", "violin", 40, "melody"),
    11: _t("小提琴 II", "violin", 40, "melody"),
    12: _t("中提琴", "strings", 41),
    13: _t("大提琴", "cello", 42, "bass"),
    14: _t("低音提琴", "cello", 43, "bass"),
}

ITEMS: dict[str, RepertoireItem] = {
    "beethoven-7-ii": RepertoireItem(
        id="beethoven-7-ii",
        title="第七交响曲 第二乐章（选段）",
        composer="贝多芬",
        filename="beethoven-symphony7-mvt2.mid",
        # 从头起 50 小节。2/4 @ 76 BPM 全乐章不变，所以窗口怎么取都是单速度单拍号；
        # 取开头是因为织体从三个声部一层层涨到全奏，是这一乐章最要紧的那段累加。
        start_tick=0,
        bars=50,
        blurb="拍子清楚到不可能听错：那个短-长-短-短的节奏细胞几乎不间断地重复。"
              "织体从低音弦乐三个声部一层层涨到全奏。",
        license="Public Domain (CC0)",
        source_url="https://www.mutopiaproject.org/ftp/BeethovenLv/O92/Symphony7_2/Symphony7_2.mid",
        tracks=_BEETHOVEN_7_TRACKS,
        count_in_bars=2,
    ),
    "beethoven-egmont-coda": RepertoireItem(
        id="beethoven-egmont-coda",
        title="《埃格蒙特》序曲 · 胜利尾声",
        composer="贝多芬",
        filename="beethoven-egmont-overture.mid",
        # 尾声起于 4/4 + 152 BPM 那个双重变更点（tick 357120）。选段是按
        # 「活跃声部/音符密度/力度跨度」滑窗选出来的，正好也落在结构分界上 ——
        # 往前挪一点就会跨进 3/4 段，`uniform_grid` 会直接报错而不是悄悄出错。
        start_tick=357120,
        bars=0,   # 一直取到最后一个音符
        blurb="全曲最密的一段：十四个声部全开，铜管与定音鼓压着走。"
              "力度跨度是整首里最大的，适合用身体去推。",
        license="Public Domain (CC0)",
        source_url="https://www.mutopiaproject.org/ftp/BeethovenLv/O84/Egmont/Egmont.mid",
        tracks=_EGMONT_TRACKS,
        count_in_bars=0,
    ),
}

def asset_path(item: RepertoireItem) -> Path:
    return ASSET_DIR / item.filename


def resolve_bars(item: RepertoireItem, parsed: midi_in.ParsedMidi) -> int:
    """`bars=0` 表示「取到最后一个音符」，在这里换算成实际小节数。"""
    if item.bars > 0:
        return item.bars
    _bpm, bpb = midi_in.uniform_grid(parsed, item.start_tick, item.start_tick + 1)
    ticks_per_bar = int(round(parsed.division * bpb))
    last = max(n.tick for n in parsed.notes)
    return max(1, math.ceil((last - item.start_tick + 1) / ticks_per_bar))


def piece_id(item: RepertoireItem) -> str:
    """缓存键 = 文件内容 + 截取窗口 + 算法版本。

    含**文件 sha256** 而不是文件名：换了一份同名的 MIDI（比如上游更新了排版）
    就该是另一首，否则用户听到的还是旧缓存。
    """
    digest = hashlib.sha256(asset_path(item).read_bytes()).hexdigest()
    blob = json.dumps({
        "v": _ALGO_VERSION, "sha256": digest, "id": item.id,
        "start_tick": item.start_tick, "bars": item.bars,
        "count_in": item.count_in_bars,
    }, sort_keys=True)
    return hashlib.sha1(blob.encode()).hexdigest()[:16]


# ---------------- 数拍 ----------------

def _with_count_in(blueprint: dict, parts: list[dict], bars_in: int) -> tuple[dict, list[dict]]:
    """在正曲前面插 `bars_in` 小节数拍，并把全部音符往后挪。

    MIDI 里没有预备拍，直接开打不符合真实指挥 —— 乐队要先看到你数拍才知道
    速度。数拍鼓点复用 `practice._drum_hits(count_in=True)`，和练习曲是同一套声音，
    用户在课程里已经熟悉了。
    """
    if bars_in <= 0:
        return blueprint, parts

    bpb = int(blueprint["beats_per_bar"])
    shifted = []
    for part in parts:
        p = dict(part)
        p["notes"] = [[n[0] + bars_in, n[1], n[2], n[3], n[4]] for n in part["notes"]]
        shifted.append(p)

    drum_notes = []
    for b in range(1, bars_in + 1):
        for beat, drum, factor in practice._drum_hits("march", bpb, count_in=True):
            drum_notes.append([b, beat + 1, 0.25, drum,
                               practice._vel("drums", 0.75, factor)])
    shifted.append({
        "schema_version": 1,
        "instrument_id": "count-in",
        "library_key": "percussion",
        "display_name": "数拍",
        "role": "rhythm",
        "gm_program": 0,
        "channel": scorelib.PERCUSSION_CHANNEL,
        "blueprint_revision": 1,
        "kind": "drums",
        "notes": drum_notes,
        "warnings": [],
    })

    bp = dict(blueprint)
    bp["bars"] = int(blueprint["bars"]) + bars_in
    bp["count_in_bars"] = bars_in
    bp["exact_duration"] = round(bp["bars"] * bpb * 60.0 / float(blueprint["bpm"]), 4)
    return bp, shifted


def build_score(item: RepertoireItem) -> tuple[dict, list[dict], dict]:
    """曲目 → `(blueprint, parts, meta)`。纯函数，可离线断言。"""
    parsed = midi_in.parse(asset_path(item))
    blueprint, parts, meta = midi_in.build_score(
        parsed, item.tracks, start_tick=item.start_tick, bars=resolve_bars(item, parsed),
        # 力度平的时候要叠小节内强弱层次，否则拍子听不出来（M7k 量过）
        accent=practice._beat_accent,
    )
    blueprint, parts = _with_count_in(blueprint, parts, item.count_in_bars)
    meta["count_in_bars"] = item.count_in_bars
    return blueprint, parts, meta


# ---------------- 渲染与缓存 ----------------

def _paths(pid: str):
    d = Path(config.PRACTICE_DIR)
    d.mkdir(parents=True, exist_ok=True)
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


def render_piece(item: RepertoireItem) -> dict:
    """写谱 → 逐声部渲染 → 混一条 → 落盘。**阻塞、CPU 密集，别在事件循环里直接调。**

    产出与 `practice.render_piece` 同形，因此 `/api/practice/{id}/*` 与前端播放器
    都不用区分这首曲子是写出来的还是读进来的。
    """
    pid = piece_id(item)
    wav_path, mid_path, meta_path = _paths(pid)

    blueprint, parts, info = build_score(item)
    renderer = renderlib.get_renderer()

    total = renderer.target_samples(blueprint)
    mix = [0.0] * total
    for part in parts:
        samples, sr = read_wav_bytes(renderer.render_part(part, blueprint))
        if sr != config.SCORE_SAMPLE_RATE:
            raise RuntimeError(f"声部 {part['display_name']} 采样率 {sr}，期望 {config.SCORE_SAMPLE_RATE}")
        gain = 0.55 if part["instrument_id"] == "count-in" else 1.0
        for i in range(min(total, len(samples))):
            mix[i] += samples[i] * gain

    peak = max((abs(s) for s in mix), default=0.0)
    if peak > 1e-6:
        k = 0.89 / peak
        mix = [s * k for s in mix]

    wav_path.write_bytes(to_wav_bytes(mix, config.SCORE_SAMPLE_RATE, normalize=False))
    mid_path.write_bytes(midi_out.merged_midi(
        parts, bpm=blueprint["bpm"], beats_per_bar=blueprint["beats_per_bar"],
        beat_unit=blueprint["beat_unit"]))

    bpb = int(blueprint["beats_per_bar"])
    bpm = float(blueprint["bpm"])
    meta = {
        "piece_id": pid,
        "source": "repertoire",
        "repertoire_id": item.id,
        "title": item.title,
        "composer": item.composer,
        "license": item.license,
        "grid": {
            "bpm": bpm,
            "beats_per_bar": bpb,
            "offset": round(item.count_in_bars * bpb * 60.0 / bpm, 6),
        },
        "loudness_per_bar": info["loudness_per_bar"],
        "dynamics_source": info["dynamics_source"],
        "count_in_bars": item.count_in_bars,
        "music_bars": info["music_bars"],
        "duration": blueprint["exact_duration"],
        "renderer": renderer.name,
        "instruments": [
            {"library_key": p["library_key"], "kind": p.get("display_name", ""),
             "note_count": len(p["notes"])} for p in parts
        ],
        "repairs": [],
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    logger.info("曲目 %s（%s）渲染完成：%s，%d 小节，%.1f 秒，力度来源 %s，渲染器 %s",
                pid, item.id, item.title, info["music_bars"],
                blueprint["exact_duration"], info["dynamics_source"], renderer.name)
    return meta


# ---------------- 造一个可指挥的项目 ----------------

def build_project(item: RepertoireItem) -> dict:
    """每条 MIDI 轨 → 一个乐器 + 一条 take。造完之后走的是和自己生成的项目
    完全一样的链路（浏览、指挥、输出），体感混音那边一行都不用改。"""
    blueprint, parts, info = build_score(item)
    renderer = renderlib.get_renderer()

    proj = projectlib.create_project(
        style_description=f"{item.composer}《{item.title}》 · {item.license}",
        key="", bpm=int(round(float(blueprint["bpm"]))),
        time_signature=f"{blueprint['beats_per_bar']}/4",
        segment_duration=float(blueprint["exact_duration"]),
        name=f"{item.composer} · {item.title}",
        generation_mode="multitrack",
    )
    for part in parts:
        if part["instrument_id"] == "count-in":
            continue
        inst = projectlib.add_instrument(
            proj, part["library_key"], display_name=part.get("display_name"),
            role=part.get("role"),
        )
        audio = renderer.render_part(part, blueprint)
        projectlib.add_take(proj, inst["id"], audio, "repertoire",
                            {"repertoire_id": item.id, "gm_program": part["gm_program"]})
    return projectlib.load_project(proj["project_id"])


def self_check() -> list[str]:
    """离线断言。`python3 backend/repertoire.py` 跑一遍，不需要渲染。

    仓库里没有测试框架，而这几条恰恰是「改坏了也不会报错、只会悄悄出错」的那类：
    截错窗口只是听起来怪，力度反推失效只是分数变得莫名其妙。
    """
    problems: list[str] = []
    for item in ITEMS.values():
        tag = item.id
        try:
            parsed = midi_in.parse(asset_path(item))
            blueprint, parts, meta = build_score(item)
        except Exception as e:
            problems.append(f"{tag}: 构建失败 {type(e).__name__}: {e}")
            continue

        # 1. 声部表必须和文件里的轨数对得上 —— 少写一条就是整个声部消失
        expect = parsed.track_count - 1        # 轨 0 是控制轨
        if len(item.tracks) != expect:
            problems.append(f"{tag}: 声部表 {len(item.tracks)} 条，文件有 {expect} 条乐器轨")

        # 2. 正曲第一个音符必须落在第 1 拍附近 —— 截点没对上强拍时它会落在小节中间
        music = [n for p in parts if p["instrument_id"] != "count-in" for n in p["notes"]]
        if not music:
            problems.append(f"{tag}: 截出来一个音符都没有")
        else:
            first = min(music, key=lambda n: (n[0], n[1]))
            if first[1] > 1.5:
                problems.append(f"{tag}: 正曲第一个音符在第 {first[1]} 拍，截点可能没对上强拍")

        # 3. 力度反推必须重现作品公认的形状（详见 midi_in.derive_dynamics）
        if meta["dynamics_source"] == "derived":
            curve = meta["loudness_per_bar"]
            head = sum(curve[:10]) / 10
            tail = sum(curve[-10:]) / 10
            if tail <= head + 0.15:
                problems.append(
                    f"{tag}: 力度反推没有爬升（前 {head:.2f} → 后 {tail:.2f}），"
                    f"反推法在这首上不成立，不能当评分真值")

        # 4. 每个声部都得有音符。空声部说明轨号错位了
        empty = [p["display_name"] for p in parts
                 if not p["notes"] and p["instrument_id"] != "count-in"]
        if len(empty) > len(parts) // 2:
            problems.append(f"{tag}: 一半以上的声部是空的 {empty}，轨号大概错位了")
    return problems


def listing() -> list[dict]:
    """给界面用的曲目清单。不做渲染，只报「准备好了没」。"""
    out = []
    for item in ITEMS.values():
        pid = piece_id(item)
        out.append({
            "id": item.id,
            "title": item.title,
            "composer": item.composer,
            "blurb": item.blurb,
            "license": item.license,
            "source_url": item.source_url,
            "piece_id": pid,
            "ready": is_ready(pid),
        })
    return out


if __name__ == "__main__":
    import sys
    issues = self_check()
    for line in issues:
        print("✗", line)
    print(f"{len(ITEMS)} 首曲目，{len(issues)} 处问题")
    sys.exit(1 if issues else 0)
