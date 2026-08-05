"""项目（project）数据模型：取代旧的"session 固定 5 声部"模型。

一个 project 可以有任意数量、任意名字的乐器；每个乐器有一串 take（每次
generate/regenerate/repaint 都追加一个新 take，不覆盖旧的），current_take_id
指向当前生效的一版。磁盘布局：

  PROJECTS_DIR/{project_id}/
      project.json
      takes/{instrument_id}/{take_id}.wav
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

try:
    from .config import PROJECTS_DIR, get_instrument_spec
except Exception:
    from config import PROJECTS_DIR, get_instrument_spec


SCHEMA_VERSION = 2

# 新增字段必须同时进这张表，否则老项目读到时会 KeyError —— 这个模块里到处是
# project["xxx"] 直接下标访问，没有 .get() 兜底。迁移完全由这张表驱动。
PROJECT_DEFAULTS: dict = {
    "schema_version": SCHEMA_VERSION,
    # multitrack = 模式一「分轨生成」（每乐器一条轨，本机 ACE-Step）
    # separate   = 模式二「全曲分离」（云端整曲 → ACE-Step extract 分轨）
    # 老项目一律迁成 multitrack：它们的轨确实是逐件独立生成的。
    "generation_mode": "multitrack",
    "total_duration": None,   # 迁移时由 segment_duration 推出，见 migrate_project
    "formation": None,        # 「构型」页产出，见 backend/configuration.py
    "generation_order": [],   # 由构型算出的乐器生成顺序（锚点在前）
    "master": None,           # 模式二：整曲成品
    "stems": [],              # 模式二：extract 分出的轨，原样记录不做解释
}

INSTRUMENT_DEFAULTS: dict = {
    # 该乐器在每个段落的参与权重，长度必须等于 len(formation.sections)。
    # 空数组 = 全程满参与（不是全程静音！见 participation_envelope 的注释）。
    "participation": [],
    "prompt_extra": "",       # 用户在「生成」页写的针对这件乐器的补充描述
    "tier": "core",           # core 贯穿 / climax 只在高潮 / accent 点缀
    "bound_stem_id": None,    # 模式二：绑到哪条 stem
    "origin": "planned",      # planned = 用户/构型指定；stem = 由分轨结果自动建出
}


def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _short_id() -> str:
    return str(uuid.uuid4())[:8]


def total_duration(project: dict) -> float:
    """全曲时长（秒）。读新字段，回退老字段。

    历史包袱：segment_duration 一个字段被当两个概念用 —— 前端两处 UI 标签写的都是
    「乐曲总时长」，后端却拿它当单次生成时长直接传给模型。M4d 起 total_duration 是
    正式字段，segment_duration 降级为每次保存同步写入的影子副本（不硬改名：一次性
    改名要同时动存量 JSON、白名单、两个 Pydantic model 和前端三处类型，收益只是好看，
    风险是全链路 KeyError）。M5 确认无读者后再删。
    """
    v = project.get("total_duration")
    if v is None:
        v = project.get("segment_duration")
    return float(v if v is not None else 16.0)


def set_duration(project: dict, seconds: float) -> None:
    """写时长。两个字段一起写，保证影子副本不漂移。"""
    seconds = float(seconds)
    project["total_duration"] = seconds
    project["segment_duration"] = seconds


def migrate_project(project: dict) -> bool:
    """把老 project.json 补齐到当前 schema。返回是否发生了改动。

    惰性迁移：在 load_project / list_projects 解析后立刻调用，有改动就回写，
    不需要单独的批处理脚本。
    """
    changed = False

    for k, v in PROJECT_DEFAULTS.items():
        if k not in project:
            project[k] = [] if isinstance(v, list) else ({} if isinstance(v, dict) else v)
            changed = True

    # total_duration 的默认值是 None，上面那轮只是把 key 补上，真正的取值在这里。
    if project.get("total_duration") is None:
        project["total_duration"] = float(project.get("segment_duration") or 16.0)
        changed = True
    # 影子副本对齐（老项目里两者本来就相等，这里主要防手工改过 JSON 的情况）
    if project.get("segment_duration") != project["total_duration"]:
        project["segment_duration"] = project["total_duration"]
        changed = True

    for inst in project.get("instruments", []):
        for k, v in INSTRUMENT_DEFAULTS.items():
            if k not in inst:
                inst[k] = [] if isinstance(v, list) else ({} if isinstance(v, dict) else v)
                changed = True

    if project.get("schema_version") != SCHEMA_VERSION:
        project["schema_version"] = SCHEMA_VERSION
        changed = True

    return changed


def project_dir(project_id: str) -> Path:
    return Path(PROJECTS_DIR) / project_id


def takes_dir(project_id: str, instrument_id: str) -> Path:
    return project_dir(project_id) / "takes" / instrument_id


def create_project(style_description: str, key: str = "D major", bpm: int = 80,
                    time_signature: str = "4/4", segment_duration: float = 16.0,
                    name: str = "", generation_mode: str = "multitrack") -> dict:
    project_id = _short_id()
    project = {
        "project_id": project_id,
        "name": name or f"Project {project_id}",
        "created_at": _now(),
        "style_description": style_description,
        "key": key,
        "bpm": bpm,
        "time_signature": time_signature,
        "instruments": [],
        **{k: ([] if isinstance(v, list) else v) for k, v in PROJECT_DEFAULTS.items()},
    }
    project["generation_mode"] = generation_mode
    set_duration(project, segment_duration)
    save_project(project)
    return project


def load_project(project_id: str) -> dict:
    p = project_dir(project_id) / "project.json"
    if not p.exists():
        raise FileNotFoundError(f"project not found: {project_id}")
    project = json.loads(p.read_text(encoding="utf-8"))
    if migrate_project(project):
        save_project(project)
    return project


def save_project(project: dict) -> None:
    d = project_dir(project["project_id"])
    d.mkdir(parents=True, exist_ok=True)
    (d / "project.json").write_text(
        json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def list_projects() -> list[dict]:
    root = Path(PROJECTS_DIR)
    if not root.exists():
        return []
    out = []
    for d in sorted(root.iterdir(), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True):
        pj = d / "project.json"
        if pj.exists():
            try:
                project = json.loads(pj.read_text(encoding="utf-8"))
            except Exception:
                continue
            if migrate_project(project):
                save_project(project)
            out.append(project)
    return out


def get_instrument(project: dict, instrument_id: str) -> dict:
    for inst in project["instruments"]:
        if inst["id"] == instrument_id:
            return inst
    raise KeyError(f"instrument not found: {instrument_id}")


def remove_instrument(project: dict, instrument_id: str) -> None:
    """移除一个乐器 tab（连带它在磁盘上的 take 音频一起删）。"""
    get_instrument(project, instrument_id)  # 校验存在，不存在则抛 KeyError
    project["instruments"] = [i for i in project["instruments"] if i["id"] != instrument_id]
    save_project(project)
    d = takes_dir(project["project_id"], instrument_id)
    if d.exists():
        for f in d.iterdir():
            f.unlink()
        d.rmdir()


def update_settings(project: dict, **fields) -> dict:
    """更新项目级共享上下文。只接受白名单里的字段，其它 key 会被忽略。"""
    allowed = {
        "style_description", "key", "bpm", "time_signature", "name",
        "generation_mode", "formation", "generation_order",
    }
    for k, v in fields.items():
        if k in allowed and v is not None:
            project[k] = v
    # 时长走 set_duration，保证 total_duration 与影子副本 segment_duration 一起写。
    for k in ("total_duration", "segment_duration"):
        if fields.get(k) is not None:
            set_duration(project, fields[k])
            break
    save_project(project)
    return project


def add_instrument(project: dict, library_key: str, display_name: Optional[str] = None,
                    role: Optional[str] = None, family: Optional[str] = None,
                    **extra) -> dict:
    """新增一个乐器 tab（还没有任何 take，等第一次 generate 才产出音频）。

    role/family 允许调用方覆盖：构型页会给自定义乐器（不在 INSTRUMENT_LIBRARY 里的）
    显式分配 role，而 get_instrument_spec 对这类乐器一律返回 harmony —— 不给覆盖入口
    的话构型分配的 role 会全部落空，指挥时四个方向的响应就废了一半。
    """
    spec = get_instrument_spec(library_key)
    instrument = {
        "id": _short_id(),
        "library_key": library_key,
        "display_name": display_name or spec["display_name"],
        "family": family or spec.get("family", library_key),
        "role": role or spec.get("role", "harmony"),
        "takes": [],
        "current_take_id": None,
        **{k: ([] if isinstance(v, list) else v) for k, v in INSTRUMENT_DEFAULTS.items()},
    }
    for k, v in extra.items():
        if k in INSTRUMENT_DEFAULTS and v is not None:
            instrument[k] = v
    project["instruments"].append(instrument)
    save_project(project)
    return instrument


def add_take(project: dict, instrument_id: str, audio_bytes: bytes,
             task_type_used: str, params: dict) -> dict:
    """写入一次新生成的音频作为该乐器的最新 take，并设为 current。"""
    instrument = get_instrument(project, instrument_id)
    take_id = _short_id()
    d = takes_dir(project["project_id"], instrument_id)
    d.mkdir(parents=True, exist_ok=True)
    audio_file = f"{take_id}.wav"
    (d / audio_file).write_bytes(audio_bytes)

    take = {
        "take_id": take_id,
        "created_at": _now(),
        "audio_file": audio_file,
        "task_type_used": task_type_used,
        "params": params,
    }
    instrument["takes"].append(take)
    instrument["current_take_id"] = take_id
    save_project(project)
    return take


def current_take_path(project: dict, instrument_id: str) -> Optional[Path]:
    instrument = get_instrument(project, instrument_id)
    if not instrument["current_take_id"]:
        return None
    for t in instrument["takes"]:
        if t["take_id"] == instrument["current_take_id"]:
            return takes_dir(project["project_id"], instrument_id) / t["audio_file"]
    return None


def other_instruments_with_takes(project: dict, exclude_instrument_id: Optional[str] = None) -> list[dict]:
    """返回除 exclude 之外、已经有至少一个 take 的乐器列表。"""
    return [
        inst for inst in project["instruments"]
        if inst["id"] != exclude_instrument_id and inst["current_take_id"]
    ]
