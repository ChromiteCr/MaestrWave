import asyncio
import uuid
import logging
from pathlib import Path

# support package or module import
try:
    from .generator import ACEStepGenerator
    from .config import STEM_PROMPTS, OUTPUT_DIR
except Exception:
    from generator import ACEStepGenerator
    from config import STEM_PROMPTS, OUTPUT_DIR

logger = logging.getLogger(__name__)


class StemGenerator:
    def __init__(self):
        self.gen = ACEStepGenerator()

    async def generate_full_session(self, user_description: str,
                                     duration: int = 60, bpm: int = 80,
                                     key: str = "D major") -> dict:
        session_id = str(uuid.uuid4())[:8]
        session_dir = Path(OUTPUT_DIR) / session_id
        session_dir.mkdir(parents=True, exist_ok=True)

        # Step 1: 生成完整混音作为参考
        full_prompt = f"Full orchestral ensemble, {user_description}"
        full_audio = await self.gen.generate(
            prompt=full_prompt, duration=duration, bpm=bpm, key=key
        )
        full_path = session_dir / "full_mix.wav"
        full_path.write_bytes(full_audio)

        stems = {}
        # Step 2: 以完整混音为参考，逐一生成各声部分轨
        for instrument, prompt_template in STEM_PROMPTS.items():
            prompt = prompt_template.format(style=user_description)
            try:
                stem_audio = await self.gen.generate_with_reference(
                    prompt=prompt,
                    reference_audio_path=str(full_path),
                    duration=duration,
                    bpm=bpm,
                    key=key,
                )
                stem_path = session_dir / f"{instrument}.wav"
                stem_path.write_bytes(stem_audio)
                stems[instrument] = str(stem_path)
            except Exception as e:
                logger.exception("Failed to generate stem %s: %s", instrument, e)

        return {
            "session_id": session_id,
            "full_mix": str(full_path),
            "stems": stems,
        }
