import asyncio
import logging
import httpx
from pathlib import Path
from config import ACESTEP_API_URL, LOKR_WEIGHTS_PATH

logger = logging.getLogger(__name__)


class ACEStepGenerator:
    def __init__(self, api_url: str = None):
        self.api_url = api_url or ACESTEP_API_URL
        # 生成可能需要较长时间，设置较大超时
        self.client = httpx.AsyncClient(timeout=300.0)

    async def generate(self, prompt: str, lyrics: str = "[Instrumental]",
                       duration: int = 60, bpm: int = 80,
                       key: str = "D major", seed: int = -1) -> bytes:
        payload = {
            "prompt": prompt,
            "lyrics": lyrics,
            "duration": duration,
            "bpm": bpm,
            "keyscale": key,
            "time_signature": "4",
            "lora_path": LOKR_WEIGHTS_PATH,
            "num_samples": 1,
            "steps": 50,
            "seed": seed,
        }

        resp = await self.client.post(f"{self.api_url}/generate", json=payload)
        resp.raise_for_status()
        return resp.content

    async def generate_with_reference(self, prompt: str, reference_audio_path: str,
                                       duration: int = 60, bpm: int = 80,
                                       key: str = "D major", seed: int = -1) -> bytes:
        # 有些 ACE-Step 实现会接受 reference path 字段，具体以实际 API 为准
        payload = {
            "prompt": prompt,
            "reference_audio": reference_audio_path,
            "duration": duration,
            "bpm": bpm,
            "keyscale": key,
            "lora_path": LOKR_WEIGHTS_PATH,
            "num_samples": 1,
            "steps": 50,
            "seed": seed,
        }

        resp = await self.client.post(f"{self.api_url}/generate", json=payload)
        resp.raise_for_status()
        return resp.content

    async def repaint(self, audio_path: str, prompt: str,
                      start_time: float, end_time: float) -> bytes:
        payload = {
            "audio_path": audio_path,
            "prompt": prompt,
            "repaint_start": start_time,
            "repaint_end": end_time,
            "lora_path": LOKR_WEIGHTS_PATH,
        }
        resp = await self.client.post(f"{self.api_url}/repaint", json=payload)
        resp.raise_for_status()
        return resp.content

    async def close(self):
        await self.client.aclose()

    def __del__(self):
        try:
            # best-effort close
            asyncio.get_event_loop().create_task(self.client.aclose())
        except Exception:
            pass
