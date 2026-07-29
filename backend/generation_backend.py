"""生成后端抽象：把"怎么跟模型对话"和"编排乐器/和声逻辑"（project_gen.py）
分开，方便换生成服务而不用改上层编排代码。

现有实现：
  - LocalACEStepBackend：本机/局域网跑着的 acestep-api，能力最全（含 lego / repaint）。
  - TMEBackend：腾讯音乐天琴云端 API，不吃本机显存，但**只有整曲文生乐**，
    没有 lego（音频层面协同）和 repaint，见 tme_backend.py 顶部说明。
  - CloudACEStepBackend：占位，等以后租到带显卡的服务器再补。

选哪个由 config.GENERATION_BACKEND 决定，project_gen.py 不需要分支。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional

try:
    from .generator import ACEStepGenerator
    from .tme_backend import TMEBackend as _TMEBackendImpl
    from . import config
except Exception:
    from generator import ACEStepGenerator
    from tme_backend import TMEBackend as _TMEBackendImpl
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


# TMEBackend 实现在 tme_backend.py（那边不 import 本模块，避免循环依赖），
# 这里把它注册成 GenerationBackend 的虚拟子类，让 isinstance 检查和类型标注成立。
GenerationBackend.register(_TMEBackendImpl)
TMEBackend = _TMEBackendImpl


def get_backend() -> GenerationBackend:
    """按 config.GENERATION_BACKEND 选择实现。"""
    backend = (config.GENERATION_BACKEND or "local").strip().lower()
    if backend == "cloud":
        return CloudACEStepBackend()
    if backend == "tme":
        return TMEBackend()
    return LocalACEStepBackend()


def backend_capabilities(backend_name: Optional[str] = None) -> dict:
    """各后端支持哪些任务类型。前端据此决定要不要禁用 Repaint 之类的按钮，
    也用来在「设置」页说明当前后端的能力差异。"""
    name = (backend_name or config.GENERATION_BACKEND or "local").strip().lower()
    if name == "tme":
        return {
            "name": "tme",
            "display_name": "腾讯音乐天琴（云端）",
            "text2music": True,
            # 天琴只有整曲文生乐，没有音频条件生成，lego 会降级成 text2music
            "lego": False,
            "repaint": False,
            "lora": False,
            "note": "云端生成，不占用本机显存。乐器之间只能靠共享的调号/拍号/速度"
                    "在文字层面对齐，配合度弱于 ACE-Step；不支持局部重绘。",
        }
    if name == "cloud":
        return {
            "name": "cloud", "display_name": "云端 ACE-Step（未接入）",
            "text2music": False, "lego": False, "repaint": False, "lora": False,
            "note": "占位实现，尚未接入。",
        }
    return {
        "name": "local", "display_name": "本机 ACE-Step",
        "text2music": True, "lego": True, "repaint": True, "lora": True,
        "note": "能力最全，但需要本机/局域网有跑着的 acestep-api 和足够显存。",
    }
