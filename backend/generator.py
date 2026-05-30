import asyncio
import logging
import httpx
import time
from pathlib import Path
from typing import Optional

# support running as package (backend.generator) or as module (generator)
try:
    from .config import ACESTEP_API_URL, LOKR_WEIGHTS_PATH, ALLOW_SYNTH_FALLBACK
    from . import synth
except Exception:
    from config import ACESTEP_API_URL, LOKR_WEIGHTS_PATH, ALLOW_SYNTH_FALLBACK
    import synth

logger = logging.getLogger(__name__)

# ACE-Step v1 API 路由
ACESTEP_V1_INIT = "/v1/init"
ACESTEP_V1_CHAT = "/v1/chat/completions"
ACESTEP_V1_QUERY = "/query_result"
ACESTEP_V1_AUDIO = "/v1/audio"

# 注意：本适配器**不**调用任何 caption / auto-tag 接口。
# 所有 prompt 直接以 messages.user 字段送往 ACE-Step server，由调用方完整提供。

# 提交任务时的超时（秒）。设置较大值是为了兼容部分 ACE-Step server 实现里
# /v1/chat/completions 是"同步阻塞直到出音频"而非"立即返回 task_id"的情况。
SUBMIT_TIMEOUT = 600.0
# 单次任务最长等待秒数（轮询模式下生效）
MAX_TASK_WAIT = 600


def _resolve_lora_path(lora_path: Optional[str]) -> Optional[str]:
    """统一处理 lora_path 入参。"""
    if not lora_path or str(lora_path).lower() in ("none", "no-model", "no_model", "raw"):
        return None
    if str(lora_path).lower() == "default":
        p = Path(LOKR_WEIGHTS_PATH)
        return str(p) if p.exists() else None
    p = Path(lora_path)
    return str(p) if p.exists() else None


class ACEStepGenerator:
    """ACE-Step v1 API 适配器（任务队列模式）：submit -> poll -> download。"""

    def __init__(self, api_url: Optional[str] = None):
        self.api_url = (api_url or ACESTEP_API_URL).rstrip("/")
        self.client = httpx.AsyncClient(timeout=SUBMIT_TIMEOUT)
        # 缓存 init 状态，避免每次 generate 都打 /v1/init 触发 server 端崩溃
        self._inited: bool = False

    async def _post(self, endpoint: str, payload: dict, timeout: float = None) -> dict:
        """POST 请求，返回 JSON 响应。"""
        url = f"{self.api_url}{endpoint}"
        resp = await self.client.post(
            url,
            json=payload,
            timeout=timeout or self.client.timeout,
        )
        resp.raise_for_status()
        return resp.json()

    async def _get(self, endpoint: str, params: dict = None, timeout: float = None) -> dict:
        """GET 请求，返回 JSON 响应。"""
        url = f"{self.api_url}{endpoint}"
        resp = await self.client.get(
            url,
            params=params or {},
            timeout=timeout or self.client.timeout,
        )
        resp.raise_for_status()
        return resp.json()

    async def _get_audio_bytes(self, file_path: str) -> bytes:
        """从 /v1/audio 下载 WAV 字节流。"""
        resp = await self.client.get(
            f"{self.api_url}{ACESTEP_V1_AUDIO}",
            params={"path": file_path},
            timeout=60.0,
        )
        resp.raise_for_status()
        return resp.content

    async def _init_if_needed(self) -> bool:
        """初始化模型（如果未初始化）。同一 generator 实例只会成功调用一次。"""
        if self._inited:
            return True
        try:
            result = await self._post(ACESTEP_V1_INIT, {}, timeout=120.0)
            logger.info("ACE-Step model initialized: %s", result.get("data", {}).get("loaded_model"))
            self._inited = True
            return True
        except Exception as e:
            logger.warning("ACE-Step init failed: %s", e)
            return False

    async def _wait_for_task(self, task_id: str, max_wait_sec: int = 300) -> dict:
        """轮询 /query_result 直到任务完成。"""
        start = time.time()
        poll_interval = 2
        while True:
            elapsed = time.time() - start
            if elapsed > max_wait_sec:
                raise TimeoutError(f"Task {task_id} not completed after {max_wait_sec}s")
            try:
                result = await self._post(ACESTEP_V1_QUERY, {"task_ids": [task_id]})
                items = result.get("data", [])
                if items and len(items) > 0:
                    item = items[0]
                    if item.get("status") in ("succeeded", "failed"):
                        return item
                logger.debug(f"Task {task_id} still pending...")
            except Exception as e:
                logger.warning(f"Poll query_result failed: {e}")
            await asyncio.sleep(poll_interval)

    async def generate(self, prompt: str, lyrics: str = "[Instrumental]",
                       duration: int = 60, bpm: int = 80,
                       key: str = "D major", seed: int = -1,
                       lora_path: Optional[str] = None,
                       instrument_hint: Optional[str] = None) -> bytes:
        """生成音频。兼容两种 server 行为：
        1) 异步任务队列：/v1/chat/completions 立即返回 task_id，再轮询 /query_result
        2) 同步阻塞：/v1/chat/completions 直接返回 audio_path / audio_url
        本方法不调用任何 caption / auto-tag 接口，prompt 原样下发。
        """
        try:
            await self._init_if_needed()

            system_msg = f"Generate music with BPM={bpm}, Key={key}, Duration={duration}s"
            user_msg = f"{prompt}\n[Lyrics: {lyrics}]"
            if seed >= 0:
                user_msg += f"\n[Seed: {seed}]"

            payload = {
                "model": "acestep-v15-turbo",
                "messages": [
                    {"role": "system", "content": system_msg},
                    {"role": "user", "content": user_msg},
                ],
                "stream": False,
                # 显式告诉支持该字段的 server 不要再做 caption / auto-tag
                "auto_caption": False,
                "use_caption": False,
            }
            if lora_path:
                payload["lora_path"] = lora_path

            logger.info("Submitting generation task: %s", prompt[:50])
            submit_result = await self._post(
                ACESTEP_V1_CHAT, payload, timeout=SUBMIT_TIMEOUT,
            )

            # ---- 同步路径：响应里直接带音频 ----
            data = submit_result.get("data", submit_result) or {}
            sync_audio_path = (
                data.get("audio_path")
                or data.get("file_path")
                or submit_result.get("audio_path")
                or submit_result.get("file_path")
            )
            if sync_audio_path:
                logger.info("Sync mode: downloading audio from %s", sync_audio_path)
                return await self._get_audio_bytes(sync_audio_path)

            # ---- 异步路径：取 task_id 轮询 ----
            task_id = data.get("id") or submit_result.get("id") or data.get("task_id")
            if not task_id:
                raise ValueError(f"No task_id / audio_path in response: {submit_result}")

            logger.info("Generation task submitted: %s", task_id)
            task_result = await self._wait_for_task(task_id, max_wait_sec=MAX_TASK_WAIT)

            if task_result.get("status") != "succeeded":
                raise RuntimeError(f"Task failed: {task_result.get('error')}")

            audio_path = task_result.get("audio_path") or task_result.get("file_path")
            if not audio_path:
                raise ValueError(f"No audio_path in completed task: {task_result}")

            logger.info("Downloading audio from: %s", audio_path)
            return await self._get_audio_bytes(audio_path)

        except Exception as e:
            logger.warning("ACE-Step generation failed (%s), falling back to synth: %s",
                           type(e).__name__, e)
            if not ALLOW_SYNTH_FALLBACK:
                raise
            return synth.synth_stem(
                instrument=instrument_hint or "full",
                duration=duration, bpm=bpm, key=key, seed=seed,
            ) if instrument_hint else synth.synth_full_mix(
                duration=duration, bpm=bpm, key=key, seed=seed,
            )

    async def generate_with_reference(self, prompt: str, reference_audio_path: str,
                                       duration: int = 60, bpm: int = 80,
                                       key: str = "D major", seed: int = -1,
                                       lora_path: Optional[str] = None,
                                       instrument_hint: Optional[str] = None) -> bytes:
        """使用参考音频指导生成（目前回退到普通生成，因为 v1 接口不直接支持）。"""
        logger.info("Reference generation: falling back to regular generation")
        return await self.generate(
            prompt=prompt,
            lyrics="[Instrumental]",
            duration=duration,
            bpm=bpm,
            key=key,
            seed=seed,
            lora_path=lora_path,
            instrument_hint=instrument_hint,
        )

    async def repaint(self, audio_path: str, prompt: str,
                      start_time: float, end_time: float,
                      lora_path: Optional[str] = None) -> bytes:
        """局部重绘（v1 任务队列模式）。"""
        try:
            await self._init_if_needed()

            system_msg = f"Repaint audio from {start_time}s to {end_time}s"
            user_msg = f"Source: {audio_path}\nStyle: {prompt}"

            payload = {
                "model": "acestep-v15-turbo",
                "messages": [
                    {"role": "system", "content": system_msg},
                    {"role": "user", "content": user_msg},
                ],
                "stream": False,
                "task_type": "repaint",
            }

            logger.info(f"Submitting repaint task: {audio_path} [{start_time}-{end_time}]")
            submit_result = await self._post(ACESTEP_V1_CHAT, payload, timeout=SUBMIT_TIMEOUT)
            data = submit_result.get("data", submit_result) or {}
            sync_audio_path = (
                data.get("audio_path") or data.get("file_path")
                or submit_result.get("audio_path") or submit_result.get("file_path")
            )
            if sync_audio_path:
                logger.info("Repaint sync mode: downloading from %s", sync_audio_path)
                return await self._get_audio_bytes(sync_audio_path)

            task_id = data.get("id") or submit_result.get("id") or data.get("task_id")
            if not task_id:
                raise ValueError(f"No task_id in response: {submit_result}")

            logger.info(f"Repaint task submitted: {task_id}")
            task_result = await self._wait_for_task(task_id, max_wait_sec=MAX_TASK_WAIT)

            if task_result.get("status") != "succeeded":
                raise RuntimeError(f"Task failed: {task_result.get('error')}")

            audio_path = task_result.get("audio_path") or task_result.get("file_path")
            if not audio_path:
                raise ValueError(f"No audio_path in completed task: {task_result}")

            logger.info(f"Downloading repaint from: {audio_path}")
            return await self._get_audio_bytes(audio_path)

        except Exception as e:
            logger.warning("ACE-Step repaint failed (%s): %s", type(e).__name__, e)
            raise

    async def ping(self) -> bool:
        """检查 ACE-Step API 是否可达。"""
        try:
            resp = await self.client.get(f"{self.api_url}/health", timeout=3.0)
            return resp.status_code < 500
        except Exception:
            return False

    async def close(self):
        await self.client.aclose()
