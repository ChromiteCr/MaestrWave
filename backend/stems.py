import asyncio
import uuid
import json
import logging
<<<<<<< HEAD
import gc
from datetime import datetime
from pathlib import Path
from typing import Optional, Callable, Awaitable, Union
=======
from datetime import datetime
from pathlib import Path
from typing import Optional
>>>>>>> dae77008d3d21757083961899b4d89bbbdab2add

# support package or module import
try:
    from .generator import ACEStepGenerator
    from .config import STEM_PROMPTS, OUTPUT_DIR, ALLOW_SYNTH_FALLBACK
    from . import synth
except Exception:
    from generator import ACEStepGenerator
    from config import STEM_PROMPTS, OUTPUT_DIR, ALLOW_SYNTH_FALLBACK
    import synth

logger = logging.getLogger(__name__)

# progress_cb 签名: (event: dict) -> None | awaitable
ProgressCb = Callable[[dict], Union[None, Awaitable[None]]]


async def _emit(cb: Optional[ProgressCb], event: dict) -> None:
    if cb is None:
        return
    try:
        r = cb(event)
        if asyncio.iscoroutine(r):
            await r
    except Exception:
        logger.exception("progress callback raised; ignoring")


class StemGenerator:
    def __init__(self):
        self.gen = ACEStepGenerator()

    async def _generate_once(self,
                             prompt: str,
                             duration: int,
                             bpm: int,
                             key: str,
                             lora_path: Optional[str],
                             instrument_hint: str,
                             reference_audio_path: Optional[str] = None) -> bytes:
        """单段生成：每次创建独立 generator，完成后立即关闭释放资源。"""
        gen = ACEStepGenerator()
        try:
            if reference_audio_path:
                return await gen.generate_with_reference(
                    prompt=prompt,
                    reference_audio_path=reference_audio_path,
                    duration=duration,
                    bpm=bpm,
                    key=key,
                    lora_path=lora_path,
                    instrument_hint=instrument_hint,
                )
            return await gen.generate(
                prompt=prompt,
                duration=duration,
                bpm=bpm,
                key=key,
                lora_path=lora_path,
                instrument_hint=instrument_hint,
            )
        finally:
            await gen.close()
            # 主动触发一次回收，降低长会话中对象滞留。
            gc.collect()

    async def generate_full_session(self, user_description: str,
                                     duration: int = 60, bpm: int = 80,
                                     key: str = "D major",
<<<<<<< HEAD
                                     lora_path: Optional[str] = None,
                                     progress_cb: Optional[ProgressCb] = None) -> dict:
=======
                                     lora_path: Optional[str] = None) -> dict:
>>>>>>> dae77008d3d21757083961899b4d89bbbdab2add
        session_id = str(uuid.uuid4())[:8]
        session_dir = Path(OUTPUT_DIR) / session_id
        session_dir.mkdir(parents=True, exist_ok=True)

<<<<<<< HEAD
        # 总步数 = full_mix + 各 stem
        stem_names = list(STEM_PROMPTS.keys())
        total_steps = 1 + len(stem_names)
        await _emit(progress_cb, {
            "type": "start",
            "session_id": session_id,
            "total": total_steps,
            "stages": ["full_mix", *stem_names],
        })

        # Step 1: 完整混音作为参考
        full_prompt = f"Full orchestral ensemble, {user_description}"
        await _emit(progress_cb, {
            "type": "stage_start", "stage": "full_mix",
            "index": 0, "total": total_steps,
        })
        try:
            full_audio = await self._generate_once(
                prompt=full_prompt,
                duration=duration,
                bpm=bpm,
                key=key,
                lora_path=lora_path,
                instrument_hint="full",
=======
        # Step 1: 完整混音作为参考
        full_prompt = f"Full orchestral ensemble, {user_description}"
        try:
            full_audio = await self.gen.generate(
                prompt=full_prompt, duration=duration, bpm=bpm, key=key,
                lora_path=lora_path, instrument_hint="full",
>>>>>>> dae77008d3d21757083961899b4d89bbbdab2add
            )
        except Exception as e:
            logger.exception("生成 full_mix 失败: %s", e)
            if not ALLOW_SYNTH_FALLBACK:
                raise
            full_audio = synth.synth_full_mix(duration=duration, bpm=bpm, key=key)

        full_path = session_dir / "full_mix.wav"
        full_path.write_bytes(full_audio)
        await _emit(progress_cb, {
            "type": "stage_done", "stage": "full_mix",
            "index": 1, "total": total_steps,
            "url": f"/audio/{session_id}/full_mix.wav",
        })

        stems: dict[str, str] = {}
        # Step 2: 以完整混音为参考，逐一生成各声部分轨
        for i, instrument in enumerate(stem_names, start=1):
            prompt_template = STEM_PROMPTS[instrument]
            prompt = prompt_template.format(style=user_description)
            await _emit(progress_cb, {
                "type": "stage_start", "stage": instrument,
                "index": i, "total": total_steps,
            })
            try:
                stem_audio = await self._generate_once(
                    prompt=prompt,
                    reference_audio_path=str(full_path),
<<<<<<< HEAD
                    duration=duration,
                    bpm=bpm,
                    key=key,
                    lora_path=lora_path,
                    instrument_hint=instrument,
=======
                    duration=duration, bpm=bpm, key=key,
                    lora_path=lora_path, instrument_hint=instrument,
>>>>>>> dae77008d3d21757083961899b4d89bbbdab2add
                )
            except Exception as e:
                logger.exception("Failed to generate stem %s: %s", instrument, e)
                if not ALLOW_SYNTH_FALLBACK:
<<<<<<< HEAD
                    await _emit(progress_cb, {
                        "type": "stage_error", "stage": instrument,
                        "index": i + 1, "total": total_steps, "error": str(e),
                    })
=======
>>>>>>> dae77008d3d21757083961899b4d89bbbdab2add
                    continue
                stem_audio = synth.synth_stem(
                    instrument=instrument, duration=duration, bpm=bpm, key=key,
                )
            stem_path = session_dir / f"{instrument}.wav"
            stem_path.write_bytes(stem_audio)
            stems[instrument] = str(stem_path)
<<<<<<< HEAD
            await _emit(progress_cb, {
                "type": "stage_done", "stage": instrument,
                "index": i + 1, "total": total_steps,
                "url": f"/audio/{session_id}/{instrument}.wav",
            })
=======
>>>>>>> dae77008d3d21757083961899b4d89bbbdab2add

        # 写入 metadata 方便后续 "音乐库" 浏览
        meta = {
            "session_id": session_id,
            "created_at": datetime.utcnow().isoformat() + "Z",
            "description": user_description,
            "duration": duration,
            "bpm": bpm,
            "key": key,
            "lora_path": lora_path or "",
            "stems": list(stems.keys()),
            "has_full_mix": True,
        }
        (session_dir / "metadata.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        return {
            "session_id": session_id,
            "full_mix": str(full_path),
            "stems": stems,
            "metadata": meta,
        }


def list_sessions() -> list[dict]:
    """扫描 OUTPUT_DIR，返回所有历史会话的元信息。"""
    out = Path(OUTPUT_DIR)
    if not out.exists():
        return []
    sessions = []
    for d in sorted(out.iterdir(), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True):
        if not d.is_dir():
            continue
        sid = d.name
        meta_path = d / "metadata.json"
        meta: dict = {}
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                meta = {}
        stems = {}
        for wav in d.glob("*.wav"):
            stems[wav.stem] = f"/audio/{sid}/{wav.name}"
        if not stems:
            continue
        full_mix_url = stems.get("full_mix")
        stem_urls = {k: v for k, v in stems.items() if k != "full_mix"}
        sessions.append({
            "session_id": sid,
            "created_at": meta.get("created_at") or datetime.utcfromtimestamp(d.stat().st_mtime).isoformat() + "Z",
            "description": meta.get("description", ""),
            "duration": meta.get("duration"),
            "bpm": meta.get("bpm"),
            "key": meta.get("key"),
            "lora_path": meta.get("lora_path", ""),
            "full_mix_url": full_mix_url,
            "stems": stem_urls,
        })
    return sessions
