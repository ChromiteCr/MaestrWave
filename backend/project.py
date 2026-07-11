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


def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _short_id() -> str:
    return str(uuid.uuid4())[:8]


def project_dir(project_id: str) -> Path:
    return Path(PROJECTS_DIR) / project_id


def takes_dir(project_id: str, instrument_id: str) -> Path:
    return project_dir(project_id) / "takes" / instrument_id


def create_project(style_description: str, key: str = "D major", bpm: int = 80,
                    time_signature: str = "4/4", segment_duration: float = 16.0,
                    name: str = "") -> dict:
    project_id = _short_id()
    project = {
        "project_id": project_id,
        "name": name or f"Project {project_id}",
        "created_at": _now(),
        "style_description": style_description,
        "key": key,
        "bpm": bpm,
        "time_signature": time_signature,
        "segment_duration": segment_duration,
        "instruments": [],
    }
    save_project(project)
    return project


def load_project(project_id: str) -> dict:
    p = project_dir(project_id) / "project.json"
    if not p.exists():
        raise FileNotFoundError(f"project not found: {project_id}")
    return json.loads(p.read_text(encoding="utf-8"))


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
                out.append(json.loads(pj.read_text(encoding="utf-8")))
            except Exception:
                continue
    return out


def get_instrument(project: dict, instrument_id: str) -> dict:
    for inst in project["instruments"]:
        if inst["id"] == instrument_id:
            return inst
    raise KeyError(f"instrument not found: {instrument_id}")


def add_instrument(project: dict, library_key: str, display_name: Optional[str] = None) -> dict:
    """新增一个乐器 tab（还没有任何 take，等第一次 generate 才产出音频）。"""
    spec = get_instrument_spec(library_key)
    instrument = {
        "id": _short_id(),
        "library_key": library_key,
        "display_name": display_name or spec["display_name"],
        "family": spec.get("family", library_key),
        "role": spec.get("role", "harmony"),
        "takes": [],
        "current_take_id": None,
    }
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
