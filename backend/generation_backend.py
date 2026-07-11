"""生成后端抽象：把"怎么跟模型对话"和"编排乐器/和声逻辑"（project_gen.py）
分开，方便以后接入云端 GPU 服务器而不用改上层编排代码。

今天只有 LocalACEStepBackend 是真正实现，指向本机/局域网跑着的
acestep-api。CloudACEStepBackend 先占位——等以后租到带显卡的服务器，
只需要把 config.GENERATION_BACKEND 切到 "cloud" 并补上这个类的实现，
project_gen.py 不需要改动。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional

try:
    from .generator import ACEStepGenerator
    from . import config
except Exception:
    from generator import ACEStepGenerator
    import config


class GenerationBackend(ABC):
    """project_gen.py 只依赖这个接口，不直接依赖某个具体后端。"""

    @abstractmethod
    async def text2music(self, *, prompt: str, bpm: int, key: str,
                          time_signature: str, duration: float,
                          lora_path: Optional[str] = None,
                          instrument_hint: Optional[str] = None) -> bytes:
        """不依赖任何已有音轨，独立生成第一件乐器（和声锚点）。"""

    @abstractmethod
    async def lego(self, *, prompt: str, src_audio_path: str, bpm: int, key: str,
                    time_signature: str, duration: float,
                    lora_path: Optional[str] = None,
                    instrument_hint: Optional[str] = None) -> bytes:
        """在 src_audio_path 描述的已有音轨基础上，智能新增一个乐器声部。"""

    @abstractmethod
    async def repaint(self, *, src_audio_path: str, prompt: str,
                       start_time: float, end_time: float,
                       lora_path: Optional[str] = None) -> bytes:
        """对某段已有音频的指定时间区间做局部重绘。"""

    @abstractmethod
    async def health(self) -> bool:
        ...

    async def close(self) -> None:
        pass


class LocalACEStepBackend(GenerationBackend):
    """指向本机/局域网 ACESTEP_API_URL 的 ACE-Step 服务。"""

    def __init__(self, api_url: Optional[str] = None):
        self._gen = ACEStepGenerator(api_url)

    async def text2music(self, *, prompt, bpm, key, time_signature, duration,
                          lora_path=None, instrument_hint=None) -> bytes:
        return await self._gen.run(
            "text2music", instrument_hint=instrument_hint,
            prompt=prompt, bpm=bpm, key=key, time_signature=time_signature,
            duration=duration, lora_path=lora_path,
        )

    async def lego(self, *, prompt, src_audio_path, bpm, key, time_signature, duration,
                    lora_path=None, instrument_hint=None) -> bytes:
        return await self._gen.run(
            "lego", instrument_hint=instrument_hint,
            prompt=prompt, src_audio_path=src_audio_path,
            bpm=bpm, key=key, time_signature=time_signature, duration=duration,
            lora_path=lora_path,
        )

    async def repaint(self, *, src_audio_path, prompt, start_time, end_time,
                       lora_path=None) -> bytes:
        return await self._gen.run(
            "repaint", prompt=prompt, src_audio_path=src_audio_path,
            repainting_start=start_time, repainting_end=end_time, lora_path=lora_path,
        )

    async def health(self) -> bool:
        return await self._gen.ping()

    async def close(self) -> None:
        await self._gen.close()


class CloudACEStepBackend(GenerationBackend):
    """预留：以后租到带显卡的服务器后在这里接入。方法签名和
    LocalACEStepBackend 完全一致，project_gen.py 无需改动。"""

    def __init__(self, api_url: Optional[str] = None, api_key: Optional[str] = None):
        self.api_url = api_url or config.CLOUD_ACESTEP_API_URL
        self.api_key = api_key or config.CLOUD_ACESTEP_API_KEY

    def _not_configured(self):
        raise NotImplementedError(
            "CloudACEStepBackend 尚未接入：需要先在 config.py 里配置 "
            "CLOUD_ACESTEP_API_URL / CLOUD_ACESTEP_API_KEY，并在这里实现具体调用。"
        )

    async def text2music(self, **kwargs) -> bytes:
        self._not_configured()

    async def lego(self, **kwargs) -> bytes:
        self._not_configured()

    async def repaint(self, **kwargs) -> bytes:
        self._not_configured()

    async def health(self) -> bool:
        return False


def get_backend() -> GenerationBackend:
    """按 config.GENERATION_BACKEND 选择实现。"""
    if config.GENERATION_BACKEND == "cloud":
        return CloudACEStepBackend()
    return LocalACEStepBackend()
