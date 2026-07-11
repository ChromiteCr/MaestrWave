"""ACE-Step 1.5 原生任务队列 API 的最小客户端。

对齐的是 ACE-Step 官方文档 docs/zh/API.md 描述的真实接口：
  POST /release_task   提交任务，返回 {data: {task_id, status, queue_position}}
  POST /query_result    轮询，body={"task_id_list": [...]}，
                         data[].status 是 0(排队/运行)/1(成功)/2(失败)，
                         成功时 data[].result 是一个 JSON 字符串，需要 json.loads
                         后取 "file" 字段（形如 "/v1/audio?path=..."）
  GET  /v1/audio?path=  下载生成的音频字节
  GET  /health           健康检查

之前的实现把这套原生 API 和另一套完全不同的 OpenRouter 兼容接口
（/v1/chat/completions，同步返回、音频以 base64 内嵌在
choices[0].message.audio 里）混在了一起，还调用了一个文档中不存在的
/v1/init，这是导致生成经常静默 fallback 到 synth.py 占位音频、同时
ACE-Step 服务端仍在真实跑推理消耗显存的根因之一。这里改为只对接原生
任务队列 API，且显式对每次请求设置 batch_size=1（原生 API 默认值是 2，
之前从未覆盖，等于每次调用都在被动地把计算/显存翻倍）。
"""
import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Optional

import httpx

try:
    from .config import ACESTEP_API_URL, LOKR_WEIGHTS_PATH, ALLOW_SYNTH_FALLBACK
    from . import synth
except Exception:
    from config import ACESTEP_API_URL, LOKR_WEIGHTS_PATH, ALLOW_SYNTH_FALLBACK
    import synth

logger = logging.getLogger(__name__)

RELEASE_TASK = "/release_task"
QUERY_RESULT = "/query_result"
AUDIO_ENDPOINT = "/v1/audio"

SUBMIT_TIMEOUT = 30.0   # 提交任务本身很快，不应该长时间挂起
MAX_TASK_WAIT = 600     # 单次任务最长轮询等待秒数
POLL_INTERVAL = 2.0

# 任务失败/排队/成功的 status 码（见 API.md）
STATUS_PENDING = 0
STATUS_SUCCEEDED = 1
STATUS_FAILED = 2

TASK_TEXT2MUSIC = "text2music"
TASK_COVER = "cover"
TASK_REPAINT = "repaint"
TASK_LEGO = "lego"
TASK_EXTRACT = "extract"
TASK_COMPLETE = "complete"


def _resolve_lora_path(lora_path: Optional[str]) -> Optional[str]:
    """统一处理 lora_path 入参：none/default/绝对路径。"""
    if not lora_path or str(lora_path).lower() in ("none", "no-model", "no_model", "raw"):
        return None
    if str(lora_path).lower() == "default":
        p = Path(LOKR_WEIGHTS_PATH)
        return str(p) if p.exists() else None
    p = Path(lora_path)
    return str(p) if p.exists() else None


class ACEStepGenerator:
    """ACE-Step 原生任务队列 API 的薄封装：submit -> poll -> download。"""

    def __init__(self, api_url: Optional[str] = None):
        self.api_url = (api_url or ACESTEP_API_URL).rstrip("/")
        self.client = httpx.AsyncClient(timeout=SUBMIT_TIMEOUT)

    async def _post(self, endpoint: str, payload: dict, timeout: float = None) -> dict:
        resp = await self.client.post(
            f"{self.api_url}{endpoint}", json=payload, timeout=timeout or SUBMIT_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json()

    async def _get_audio_bytes(self, file_ref: str) -> bytes:
        """下载生成的音频。file_ref 既可能是纯路径，也可能是
        query_result 里返回的完整 "/v1/audio?path=..." 引用。"""
        if file_ref.startswith("http://") or file_ref.startswith("https://"):
            resp = await self.client.get(file_ref, timeout=60.0)
        elif file_ref.startswith(AUDIO_ENDPOINT):
            resp = await self.client.get(f"{self.api_url}{file_ref}", timeout=60.0)
        else:
            resp = await self.client.get(
                f"{self.api_url}{AUDIO_ENDPOINT}", params={"path": file_ref}, timeout=60.0,
            )
        resp.raise_for_status()
        return resp.content

    async def submit(self, task_type: str, *, prompt: str = "", lyrics: str = "[Instrumental]",
                      bpm: Optional[int] = None, key: Optional[str] = None,
                      time_signature: Optional[str] = None, duration: Optional[float] = None,
                      seed: int = -1, batch_size: int = 1,
                      inference_steps: int = 8, guidance_scale: float = 7.0,
                      src_audio_path: Optional[str] = None,
                      reference_audio_path: Optional[str] = None,
                      audio_cover_strength: Optional[float] = None,
                      repainting_start: Optional[float] = None,
                      repainting_end: Optional[float] = None,
                      lora_path: Optional[str] = None) -> str:
        """提交一个任务，返回 task_id。"""
        payload = {
            "task_type": task_type,
            "prompt": prompt,
            "caption": prompt,
            "lyrics": lyrics,
            "audio_format": "wav",
            # batch_size 原生默认是 2；这里显式覆盖为 1，是最直接的显存/算力节省点。
            "batch_size": max(1, batch_size),
            "inference_steps": inference_steps,
            "guidance_scale": guidance_scale,
            "seed": seed,
            "use_random_seed": seed is None or seed < 0,
        }
        if bpm is not None:
            payload["bpm"] = bpm
        if key is not None:
            payload["key_scale"] = key
        if time_signature is not None:
            payload["time_signature"] = time_signature
        if duration is not None:
            payload["audio_duration"] = duration
        if src_audio_path is not None:
            payload["src_audio_path"] = src_audio_path
        if reference_audio_path is not None:
            payload["reference_audio_path"] = reference_audio_path
        if audio_cover_strength is not None:
            payload["audio_cover_strength"] = audio_cover_strength
        if repainting_start is not None:
            payload["repainting_start"] = repainting_start
        if repainting_end is not None:
            payload["repainting_end"] = repainting_end
        # 注意：ACE-Step 文档没有明确给出 /release_task 层面的每请求 LoRA/LoKr
        # 选择字段（官方 Gradio 界面是在服务启动/加载模型时选权重）。这里仍然
        # 把 lora_path 透传过去，若服务端不识别会被忽略；真正验证需要对着
        # 本机跑起来的 acestep-api 实测。
        resolved_lora = _resolve_lora_path(lora_path)
        if resolved_lora:
            payload["lora_path"] = resolved_lora

        logger.info("release_task[%s]: %s", task_type, (prompt or "")[:60])
        result = await self._post(RELEASE_TASK, payload, timeout=SUBMIT_TIMEOUT)
        data = result.get("data", result) or {}
        task_id = data.get("task_id")
        if not task_id:
            raise ValueError(f"No task_id in /release_task response: {result}")
        return task_id

    async def wait_result(self, task_id: str, max_wait_sec: int = MAX_TASK_WAIT) -> dict:
        """轮询 /query_result 直到任务成功/失败，返回解析后的 result dict。"""
        start = time.time()
        while True:
            elapsed = time.time() - start
            if elapsed > max_wait_sec:
                raise TimeoutError(f"Task {task_id} not completed after {max_wait_sec}s")

            resp = await self._post(QUERY_RESULT, {"task_id_list": [task_id]})
            items = resp.get("data", [])
            if items:
                item = items[0]
                status = item.get("status")
                if status == STATUS_SUCCEEDED:
                    raw = item.get("result")
                    return json.loads(raw) if isinstance(raw, str) else (raw or {})
                if status == STATUS_FAILED:
                    raise RuntimeError(f"Task {task_id} failed: {item.get('result')}")
                # status == STATUS_PENDING: 继续轮询
            await asyncio.sleep(POLL_INTERVAL)

    async def run(self, task_type: str, *, instrument_hint: Optional[str] = None, **kwargs) -> bytes:
        """submit + poll + download 的组合便捷方法，返回音频字节。

        失败时（网络错误/服务不可达/解析失败）在 ALLOW_SYNTH_FALLBACK=1 时
        回退到本地程序化合成占位音频，保证链路始终可演示；否则原样抛出。
        """
        try:
            task_id = await self.submit(task_type, **kwargs)
            result = await self.wait_result(task_id)
            file_ref = result.get("file")
            if not file_ref:
                raise ValueError(f"No 'file' in query_result: {result}")
            logger.info("Downloading audio: %s", file_ref)
            return await self._get_audio_bytes(file_ref)
        except Exception as e:
            logger.warning("ACE-Step %s failed (%s), falling back to synth: %s",
                            task_type, type(e).__name__, e)
            if not ALLOW_SYNTH_FALLBACK:
                raise
            duration = int(kwargs.get("duration") or 30)
            bpm = kwargs.get("bpm") or 80
            key = kwargs.get("key") or "D major"
            seed = kwargs.get("seed", -1)
            return synth.synth_stem(
                instrument=instrument_hint or "full",
                duration=duration, bpm=bpm, key=key, seed=seed,
            ) if instrument_hint else synth.synth_full_mix(
                duration=duration, bpm=bpm, key=key, seed=seed,
            )

    # ---- 便捷封装：与旧调用方（backend/stems.py）保持方法名兼容 ----

    async def generate(self, prompt: str, lyrics: str = "[Instrumental]",
                        duration: int = 60, bpm: int = 80,
                        key: str = "D major", seed: int = -1,
                        lora_path: Optional[str] = None,
                        instrument_hint: Optional[str] = None) -> bytes:
        """text2music：不依赖任何已有音轨的独立生成。"""
        return await self.run(
            TASK_TEXT2MUSIC, instrument_hint=instrument_hint,
            prompt=prompt, lyrics=lyrics, duration=duration, bpm=bpm, key=key,
            seed=seed, lora_path=lora_path,
        )

    async def generate_with_reference(self, prompt: str, reference_audio_path: str,
                                       duration: int = 60, bpm: int = 80,
                                       key: str = "D major", seed: int = -1,
                                       lora_path: Optional[str] = None,
                                       instrument_hint: Optional[str] = None) -> bytes:
        """在已有音轨基础上新增一个声部，使用 ACE-Step 原生的 lego 任务——
        这是真正在音频内容层面做协同生成的机制（reference_audio 参数按官方
        文档只控制音色/混音等声学层面，不控制旋律/节奏/和声，撑不起这个需求）。
        """
        return await self.run(
            TASK_LEGO, instrument_hint=instrument_hint,
            prompt=prompt, lyrics="[Instrumental]", duration=duration, bpm=bpm, key=key,
            seed=seed, lora_path=lora_path, src_audio_path=reference_audio_path,
        )

    async def repaint(self, audio_path: str, prompt: str,
                       start_time: float, end_time: float,
                       lora_path: Optional[str] = None) -> bytes:
        return await self.run(
            TASK_REPAINT, prompt=prompt, lyrics="[Instrumental]",
            src_audio_path=audio_path, repainting_start=start_time,
            repainting_end=end_time, lora_path=lora_path,
        )

    async def ping(self) -> bool:
        try:
            resp = await self.client.get(f"{self.api_url}/health", timeout=3.0)
            return resp.status_code < 500
        except Exception:
            return False

    async def close(self):
        await self.client.aclose()
