"""符号乐谱模式的编排层（M7）。

和 `project_gen.py` 平行：那边是「调生成后端要一段音频」，这边是「先作曲、
再渲染成音频」。两者的出口完全相同 —— 都落在 `projectlib.add_take(...)`，
所以「生成」页、浏览页、输出页、整条摄像头指挥链路一行都不用改。

**为什么不塞进 `GenerationBackend`**：那个接口只吃 `prompt: str`，而作曲需要
蓝图、和弦表、participation、其它声部已经写了什么音。硬塞进 prompt 是假装
复用。端点按 `project["generation_mode"]` 分流，明写出来。
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Optional

try:
    from . import composer as composerlib
    from . import midi_out
    from . import project as projectlib
    from . import render as renderlib
    from . import score as scorelib
except Exception:
    import composer as composerlib
    import midi_out
    import project as projectlib
    import render as renderlib
    import score as scorelib

logger = logging.getLogger(__name__)

# 首次生成时用户可能连点两件乐器，两个请求会各建一份蓝图，第二份把第一份
# 覆盖掉 —— 于是先生成的那件乐器是照着一份已经不存在的和声写的。按 project
# 上锁，只让第一个进去建。
_blueprint_locks: dict[str, asyncio.Lock] = {}


def _lock_for(project_id: str) -> asyncio.Lock:
    lock = _blueprint_locks.get(project_id)
    if lock is None:
        lock = asyncio.Lock()
        _blueprint_locks[project_id] = lock
    return lock


# ---------------- 谱子的落盘 ----------------

def scores_dir(project_id: str) -> Path:
    return projectlib.project_dir(project_id) / "scores"


def score_path(project_id: str, take_id: str) -> Path:
    return scores_dir(project_id) / f"{take_id}.json"


def save_part(project_id: str, take_id: str, part: dict) -> str:
    d = scores_dir(project_id)
    d.mkdir(parents=True, exist_ok=True)
    name = f"{take_id}.json"
    (d / name).write_text(json.dumps(part, ensure_ascii=False), encoding="utf-8")
    return name


def load_part(project_id: str, take: dict) -> Optional[dict]:
    name = (take.get("params") or {}).get("score_file")
    if not name:
        return None
    p = scores_dir(project_id) / name
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("读不了谱子 %s：%s", p, e)
        return None


def current_parts(project: dict, exclude_instrument_id: Optional[str] = None) -> list[dict]:
    """当前生效的各声部谱子。作曲时给「参照已有声部」用，导出 MIDI 也用它。"""
    out: list[dict] = []
    for inst in project.get("instruments", []):
        if inst["id"] == exclude_instrument_id or not inst.get("current_take_id"):
            continue
        for t in inst.get("takes", []):
            if t["take_id"] == inst["current_take_id"]:
                part = load_part(project["project_id"], t)
                if part:
                    out.append(part)
                break
    return out


# ---------------- 蓝图 ----------------

def blueprint_is_stale(project: dict) -> bool:
    """项目的调性/速度/拍号/时长改过之后，已有蓝图就不作数了。"""
    bp = project.get("score_blueprint")
    if not bp:
        return True
    fresh = composerlib.skeleton(project)
    return any(bp.get(k) != fresh[k]
               for k in ("bpm", "key", "time_signature", "bars", "beats_per_bar"))


async def ensure_blueprint(project: dict, composer: composerlib.Composer) -> dict:
    """拿到当前有效的蓝图，没有或已失效就重建。

    重建时 `revision` 自增，而各 take 里记着自己是按哪个 revision 写的 ——
    前端据此把旧声部标成「按旧蓝图写的」。**不自动重写已有声部**：哪几件要
    重生成是用户的判断，替他决定只会白烧一堆 token。
    """
    async with _lock_for(project["project_id"]):
        # 等锁期间别人可能已经建好了，重新读一次盘再判断
        fresh = projectlib.load_project(project["project_id"])
        if not blueprint_is_stale(fresh):
            project["score_blueprint"] = fresh["score_blueprint"]
            return fresh["score_blueprint"]

        old_rev = int((fresh.get("score_blueprint") or {}).get("revision") or 0)
        bp = await composer.blueprint(fresh)
        bp["revision"] = old_rev + 1

        fresh["score_blueprint"] = bp
        # 小节是真值，项目时长反过来对齐到整小节（见 M7 计划「小节是唯一真值」）。
        # set_duration 会同时写 total_duration 和影子副本 segment_duration。
        projectlib.set_duration(fresh, bp["exact_duration"])
        projectlib.save_project(fresh)

        project["score_blueprint"] = bp
        project["total_duration"] = fresh["total_duration"]
        project["segment_duration"] = fresh["segment_duration"]
        return bp


# ---------------- 生成 ----------------

async def generate_instrument_score(project: dict, instrument_id: str,
                                    composer: composerlib.Composer,
                                    renderer: renderlib.ScoreRenderer,
                                    seed: Optional[int] = None) -> dict:
    """为一件乐器写谱 + 渲染成音轨，追加一个 take。

    和 `project_gen.generate_instrument` 一样，同一函数服务「首次生成」和
    「重新生成」：永远只参照除它自己之外、当前已有谱子的声部。
    """
    instrument = projectlib.get_instrument(project, instrument_id)
    bp = await ensure_blueprint(project, composer)
    others = current_parts(project, exclude_instrument_id=instrument_id)

    # 种子来自已有 take 数：同一件乐器连点「重新生成」要拿到不同的一版，
    # 否则那个按钮是骗人的。
    if seed is None:
        seed = (len(instrument.get("takes") or []) * 7919 + hash(instrument_id)) & 0x7FFFFFFF

    raw = await composer.compose_part(
        project=project, instrument=instrument, blueprint=bp,
        existing_parts=others, seed=seed,
    )
    part = scorelib.validate_and_repair_part(raw, instrument=instrument, blueprint=bp)
    # 渲染是纯 CPU（fluidsynth 那条还是个最长 180 秒的 subprocess），
    # 直接在事件循环里跑会把整个后端卡住 —— 摄像头指挥的 WebSocket 也在这个循环上。
    # practice.py / repertoire.py 一直是这么包的，主链路这里之前漏了。
    audio = await asyncio.to_thread(renderer.render_part, part, bp)

    # 实际写这一条的是谁。LLM 通路失败会退到规则作曲，这里如实记下来 ——
    # 让退化后的结果冒充模型输出，用户就再也判断不了模型到底行不行。
    used = raw.get("source") or composer.name
    fallback = raw.get("fallback_reason") or bp.get("fallback_reason")

    take = projectlib.add_take(project, instrument_id, audio, "score", params={
        "composer": used,
        "composer_requested": composer.name,
        **({"fallback_reason": fallback} if fallback else {}),
        "renderer": renderer.name,
        "blueprint_revision": bp["revision"],
        "seed": seed,
        "note_count": len(part["notes"]),
        "repairs": part["warnings"],
        # 谱子本身就是拍网格的真值：downbeat 精确落在 0 秒，不需要起始点检测。
        # 教学侧的评分直接读这一项。
        "beat_grid": {
            "bpm": bp["bpm"],
            "beats_per_bar": bp["beats_per_bar"],
            "offset": 0.0,
        },
        "bpm": bp["bpm"],
        "key": bp["key"],
        "time_signature": bp["time_signature"],
        "duration": bp["exact_duration"],
    })

    part["take_id"] = take["take_id"]
    take["params"]["score_file"] = save_part(project["project_id"], take["take_id"], part)
    # 只补这一个字段，不整体覆盖 —— 蓝图与 take 本身在 ensure_blueprint / add_take
    # 里已经各自落过盘了，这里再 save 整份就会把别人这期间写的东西抹掉。
    projectlib.update_take_params(project["project_id"], instrument_id, take["take_id"],
                                  score_file=take["params"]["score_file"])
    return take


async def repaint_instrument_score(project: dict, instrument_id: str,
                                   composer: composerlib.Composer,
                                   renderer: renderlib.ScoreRenderer,
                                   *, start_time: float, end_time: float,
                                   seed: Optional[int] = None) -> dict:
    """只重写某个时间区间的音符，其余原样保留。

    **符号模式下这件事是真能做的**，不需要模型支持音频重绘（天琴那边直接
    501）。UI 传的是秒，这里换算成小节并**向外吸附到小节边界** —— 从半小节
    中间接一段新写的音符，接缝处的和声必然对不上。
    """
    instrument = projectlib.get_instrument(project, instrument_id)
    bp = await ensure_blueprint(project, composer)
    current = None
    for t in instrument.get("takes", []):
        if t["take_id"] == instrument.get("current_take_id"):
            current = load_part(project["project_id"], t)
            break
    if current is None:
        raise ValueError("这件乐器还没有可重绘的谱子，先生成一次。")

    bar_len = scorelib.bar_seconds(bp["bpm"], bp["beats_per_bar"],
                                   bp.get("beat_unit") or 4)
    first = max(1, int(start_time // bar_len) + 1)
    last = min(int(bp["bars"]), max(first, int((end_time - 1e-6) // bar_len) + 1))

    if seed is None:
        seed = (len(instrument.get("takes") or []) * 104729 + first * 31 + last) & 0x7FFFFFFF

    raw = await composer.compose_part(
        project=project, instrument=instrument, blueprint=bp,
        existing_parts=current_parts(project, exclude_instrument_id=instrument_id),
        seed=seed,
    )
    fresh = scorelib.validate_and_repair_part(raw, instrument=instrument, blueprint=bp)

    kept = [n for n in current["notes"] if not (first <= n[scorelib.N_BAR] <= last)]
    new = [n for n in fresh["notes"] if first <= n[scorelib.N_BAR] <= last]
    merged = dict(current)
    merged["notes"] = sorted(kept + new, key=lambda n: (n[scorelib.N_BAR], n[scorelib.N_BEAT]))
    merged["warnings"] = fresh["warnings"]

    # 同上：别把事件循环堵在渲染上
    audio = await asyncio.to_thread(renderer.render_part, merged, bp)
    take = projectlib.add_take(project, instrument_id, audio, "score", params={
        "composer": composer.name,
        "renderer": renderer.name,
        "blueprint_revision": bp["revision"],
        "seed": seed,
        "repainted_bars": [first, last],
        "note_count": len(merged["notes"]),
        "repairs": fresh["warnings"],
        "beat_grid": {"bpm": bp["bpm"], "beats_per_bar": bp["beats_per_bar"], "offset": 0.0},
        "bpm": bp["bpm"],
        "duration": bp["exact_duration"],
    })
    take["params"]["score_file"] = save_part(project["project_id"], take["take_id"], merged)
    # 同上：只补字段，不整体覆盖
    projectlib.update_take_params(project["project_id"], instrument_id, take["take_id"],
                                  score_file=take["params"]["score_file"])
    return take


# ---------------- 导出 ----------------

def project_midi(project: dict) -> bytes:
    """全部声部合成一个 MIDI，导出给 MuseScore / DAW。"""
    bp = project.get("score_blueprint")
    if not bp:
        raise ValueError("这个项目还没有乐谱。")
    parts = current_parts(project)
    if not parts:
        raise ValueError("还没有任何已生成的声部。")
    return midi_out.merged_midi(
        parts, bpm=bp["bpm"], beats_per_bar=bp["beats_per_bar"],
        beat_unit=bp.get("beat_unit") or 4,
    )


def project_score(project: dict) -> dict:
    """蓝图 + 各声部音符，喂前端的钢琴卷帘。"""
    bp = project.get("score_blueprint")
    parts = current_parts(project) if bp else []
    return {"blueprint": bp, "parts": parts}
