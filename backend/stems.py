import asyncio
import uuid
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

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


class StemGenerator:
    def __init__(self):
        self.gen = ACEStepGenerator()

    async def generate_full_session(self, user_description: str,
                                     duration: int = 60, bpm: int = 80,
                                     key: str = "D major",
                                     lora_path: Optional[str] = None) -> dict:
        session_id = str(uuid.uuid4())[:8]
        session_dir = Path(OUTPUT_DIR) / session_id
        session_dir.mkdir(parents=True, exist_ok=True)

        # Step 1: 完整混音作为参考
        full_prompt = f"Full orchestral ensemble, {user_description}"
        try:
            full_audio = await self.gen.generate(
                prompt=full_prompt, duration=duration, bpm=bpm, key=key,
                lora_path=lora_path, instrument_hint="full",
            )
        except Exception as e:
            logger.exception("生成 full_mix 失败: %s", e)
            if not ALLOW_SYNTH_FALLBACK:
                raise
            full_audio = synth.synth_full_mix(duration=duration, bpm=bpm, key=key)

        full_path = session_dir / "full_mix.wav"
        full_path.write_bytes(full_audio)

        stems: dict[str, str] = {}
        # Step 2: 以完整混音为参考，逐一生成各声部分轨
        for instrument, prompt_template in STEM_PROMPTS.items():
            prompt = prompt_template.format(style=user_description)
            try:
                stem_audio = await self.gen.generate_with_reference(
                    prompt=prompt,
                    reference_audio_path=str(full_path),
                    duration=duration, bpm=bpm, key=key,
                    lora_path=lora_path, instrument_hint=instrument,
                )
            except Exception as e:
                logger.exception("Failed to generate stem %s: %s", instrument, e)
                if not ALLOW_SYNTH_FALLBACK:
                    continue
                stem_audio = synth.synth_stem(
                    instrument=instrument, duration=duration, bpm=bpm, key=key,
                )
            stem_path = session_dir / f"{instrument}.wav"
            stem_path.write_bytes(stem_audio)
            stems[instrument] = str(stem_path)

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
