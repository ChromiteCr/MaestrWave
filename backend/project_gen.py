"""分乐器按需生成的编排逻辑 —— 这次重构的核心。

设计（对应重构计划 M1 §1.4）：
  - 项目里第一件"已经有 take"的乐器：用 text2music 独立生成，作为和声锚点。
  - 之后每件乐器：用 ACE-Step 原生的 lego 任务，把"除它之外、当前已生成的
    所有乐器"混音后的临时 wav 作为 src_audio_path 喂给模型——这是模型原生
    支持、在音频内容层面真正做协同生成的机制（而不是像旧代码那样，靠
    "共享文字描述"硬凑和声）。
  - "Regenerate"复用同一个函数：无论目标乐器是不是第一次生成，都只参照
    "除它之外"的其它乐器，所以换一版之后依然和其它声部合拍。
  - 每次调用只生成 project.segment_duration 这一小段单乐器音频，不是整首
    曲子——这既是"点一次生成一段"的直接实现，也把每次调用的显存峰值摊薄。
"""
from __future__ import annotations

import logging
import uuid
from pathlib import Path
from typing import Optional

try:
    from .config import get_instrument_spec
    from . import project as projectlib
    from .audio_utils import mix_wav_files
    from .generation_backend import GenerationBackend
except Exception:
    from config import get_instrument_spec
    import project as projectlib
    from audio_utils import mix_wav_files
    from generation_backend import GenerationBackend

logger = logging.getLogger(__name__)

_ROLE_HINTS = {
    "melody": "add a clear lead melody that stands out above",
    "harmony": "add a supporting harmony line that fits underneath",
    "bass": "add a low-register foundation beneath",
    "rhythm": "add rhythmic drive that locks in with",
}


def _build_prompt(project: dict, instrument: dict, others: list[dict]) -> str:
    spec = get_instrument_spec(instrument["library_key"])
    base = spec["prompt"].format(style=project["style_description"])
    if not others:
        return base
    existing_names = "、".join(o["display_name"] for o in others)
    role_hint = _ROLE_HINTS.get(instrument.get("role", "harmony"), _ROLE_HINTS["harmony"])
    return (
        f"{base}. On top of the existing {existing_names}, {role_hint} them, "
        f"same tempo and key throughout."
    )


def _bounce_mix(project: dict, others: list[dict], for_instrument_id: str) -> Path:
    """把 others 当前生效的 take 混音落地，作为 lego 的 src_audio_path。"""
    paths = [projectlib.current_take_path(project, o["id"]) for o in others]
    paths = [p for p in paths if p is not None]
    out_dir = projectlib.project_dir(project["project_id"]) / "mixes"
    out_path = out_dir / f"{for_instrument_id}_{uuid.uuid4().hex[:8]}.wav"
    return mix_wav_files(paths, out_path)


async def generate_instrument(project: dict, instrument_id: str, backend: GenerationBackend,
                               lora_path: Optional[str] = None) -> dict:
    """为某个乐器新增一版 take。同一函数服务于"首次生成"和"regenerate"：
    永远只参照除它自己之外、当前已生成的其它乐器。"""
    instrument = projectlib.get_instrument(project, instrument_id)
    others = projectlib.other_instruments_with_takes(project, exclude_instrument_id=instrument_id)
    prompt = _build_prompt(project, instrument, others)

    common = dict(
        bpm=project["bpm"], key=project["key"], time_signature=project["time_signature"],
        duration=project["segment_duration"], lora_path=lora_path,
        instrument_hint=instrument["library_key"],
    )

    if not others:
        audio = await backend.text2music(prompt=prompt, **common)
        task_type = "text2music"
        src_ref = None
    else:
        mix_path = _bounce_mix(project, others, instrument_id)
        audio = await backend.lego(prompt=prompt, src_audio_path=str(mix_path), **common)
        task_type = "lego"
        src_ref = str(mix_path)

    return projectlib.add_take(project, instrument_id, audio, task_type, params={
        "prompt": prompt,
        "src_audio_path": src_ref,
        "referenced_instruments": [o["id"] for o in others],
        **{k: v for k, v in common.items() if k != "instrument_hint"},
    })


async def repaint_instrument(project: dict, instrument_id: str, backend: GenerationBackend,
                              prompt: str, start_time: float, end_time: float,
                              lora_path: Optional[str] = None) -> dict:
    """对该乐器当前 take 的指定区间做局部重绘，命名/行为对齐 ACE-Step 自己的
    repaint 术语。"""
    src = projectlib.current_take_path(project, instrument_id)
    if src is None:
        raise ValueError("该乐器还没有任何已生成的 take，无法 repaint")

    audio = await backend.repaint(
        src_audio_path=str(src), prompt=prompt,
        start_time=start_time, end_time=end_time, lora_path=lora_path,
    )
    return projectlib.add_take(project, instrument_id, audio, "repaint", params={
        "prompt": prompt, "start_time": start_time, "end_time": end_time,
        "src_audio_path": str(src),
    })
