"""腾讯音乐天琴（TME）云端生成后端（M4a）。

为什么加这个：ACE-Step 要在本机跑模型，消费级设备显存吃紧。天琴是纯云端
HTTP API，本机零显存占用。

**能力差异（重要，决定了这里的实现方式）**：
天琴是"整曲生成器"——给一段文字描述，返回一首完整的成品曲子。它没有
ACE-Step 的两个关键能力：

  - `lego`：在已有音轨基础上、在音频内容层面新增一个协同的乐器声部
  - `repaint`：对已有音频的某个时间区间做局部重绘

所以在这个后端下：
  - `text2music` 是真实支持的，把项目的全部音乐信息（调号/拍号/速度/正在生成
    哪件乐器/风格描述）编进 tags 一起发过去；
  - `lego` 只能降级成 text2music，靠"共享的调性/速度/拍号 + 文字里点名已有
    乐器"来对齐——这是文字层面的配合，不是音频层面的，效果弱于 ACE-Step 的
    lego，调用方（project_gen.py）无需改动但要知道这个差异；
  - `repaint` 直接报错说明不支持，而不是悄悄返回一段无关音频。

另外天琴返回的是 **MP3 整曲**，而项目要的是 `segment_duration` 那么长的
WAV 片段，所以下载后用 ffmpeg 转码+裁剪（见 `_transcode`）。
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Optional

import httpx

try:
    from . import config
    from .config import get_instrument_spec
except Exception:
    import config
    from config import get_instrument_spec

logger = logging.getLogger(__name__)

SUBMIT_CMD = "api/v1/workflow/async/run"
POLL_CMD = "api/v1/workflow/result/poll"

# 天琴 generate_mode：1 = 填词做歌。纯器乐时 lyrics 只放结构标记、不放歌词，
# 参考官方示例的用法。
GENERATE_MODE_LYRICS = 1

# 器乐片段的结构标记。段落给少一点，避免模型把几十秒的片段写成完整歌曲结构。
INSTRUMENTAL_STRUCTURE = "[intro] [main-theme] [outro]"

_ROLE_TAGS = {
    "melody": "lead melodic line, sits on top of the mix",
    "harmony": "supporting harmony line, sits under the melody",
    "bass": "low register foundation",
    "rhythm": "rhythmic drive and pulse",
}


def build_tags(*, prompt: str, key: str, time_signature: str, bpm: int,
               duration: float, instrument_key: Optional[str]) -> str:
    """把「软件里用户给出的全部音乐信息」编成天琴的 tags 串。

    职责边界：ACE-Step 的 API 把 bpm / key_scale / time_signature / audio_duration
    当**结构化字段**单独传，而天琴只有一个自由文本的 tags。所以这个函数干的事
    就是——**把那些结构化字段折进文本**，其余描述沿用 project_gen 已经拼好的
    prompt（里面已含乐器描述、风格描述，以及"在已有的某某声部之上"的上下文），
    避免同一件事在两处各拼一遍。

    天琴 tags 是逗号分隔的短语（官方示例：
    "heavy metal instrumental, ..., dark minor key, 180bpm, epic metal soundtrack"），
    所以每项信息各占一个短语：

      乐器（显式点名） → 角色 → project_gen 的完整描述 → 纯器乐声明
      → 调号 → 拍号 → 速度 → 时长 → 录音质感
    """
    parts: list[str] = []

    # 1) 正在生成哪件乐器：显式单列一项，不依赖 prompt 里恰好提到它
    #    （用户可以填完全自定义的乐器名，走 get_instrument_spec 的 fallback）
    if instrument_key:
        spec = get_instrument_spec(instrument_key)
        display = spec.get("display_name") or instrument_key
        # 库里的乐器同时给英文 key 和中文名（两种说法都喂给模型）；
        # 自定义乐器时 key 本身就是用户填的名字，不重复写。
        named = instrument_key if display == instrument_key else f"{instrument_key} ({display})"
        parts.append(f"featured instrument: {named}")
        role_tag = _ROLE_TAGS.get(spec.get("role", "harmony"))
        if role_tag:
            parts.append(role_tag)

    # 2) project_gen 拼好的描述：乐器音色模板 + 用户填的风格描述
    #    +（若已有其它声部）"在它们之上扮演什么角色、保持同样速度和调性"
    prompt = (prompt or "").strip().rstrip(".")
    if prompt:
        parts.append(prompt)

    # 3) 明确要纯器乐——天琴默认是"做歌"，不声明会唱出人声
    parts.append("instrumental only, no vocals, no singing")

    # 4) 调号 / 拍号 / 速度 / 时长：用户在「生成」页高级面板设的项目级共享上下文。
    #    天琴听不到已有音轨，多件乐器能不能合得上全靠这几项文字对齐，必须逐项写。
    if key:
        parts.append(f"key of {key}")
    if time_signature:
        parts.append(f"{time_signature} time signature")
    if bpm:
        parts.append(f"{int(bpm)}bpm, strict steady tempo")
    if duration:
        parts.append(f"about {int(round(duration))} seconds long")

    parts.append("orchestral studio recording, clean mix")
    return ", ".join(parts)


class TMEError(RuntimeError):
    pass


class TMEClient:
    """天琴 workflow API 的异步客户端（签名逻辑对齐官方示例 tme.py）。"""

    def __init__(self, api_url: Optional[str] = None, app_id: Optional[str] = None,
                 app_key: Optional[str] = None):
        self.api_url = api_url or config.TME_API_URL
        self.app_id = app_id or config.TME_APP_ID
        self.app_key = app_key or config.TME_APP_KEY
        self._client: Optional[httpx.AsyncClient] = None

    def configured(self) -> bool:
        return bool(self.api_url and self.app_id and self.app_key)

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=60.0)
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _post(self, cmd: str, biz_data: dict) -> dict:
        """双重序列化 + HMAC-SHA256 签名后 POST。

        注意 biz_data 是被 json.dumps 成字符串塞进 cgi.data 的（双重序列化），
        而签名算的是最外层 body 加上固定的 "&cookie=" 后缀——这两点都是天琴
        协议的要求，改动任何一处签名都会失败。
        """
        if not self.configured():
            raise TMEError(
                "TME 未配置：需要设置环境变量 TME_APP_ID / TME_APP_KEY，"
                "见 README「用云端 API 生成」。"
            )

        timestamp = str(int(time.time()))
        payload = {
            "comm": {
                "app_id": self.app_id,
                "timestamp": timestamp,
                "opi_cmd": "DoTianQinWorkFlow",
            },
            "cgi": {
                "cmd": cmd,
                "unique_id": f"maestrwave-{timestamp}",
                "data": json.dumps(biz_data, separators=(",", ":")),
            },
        }
        raw_body = json.dumps(payload, separators=(",", ":"))
        sign = hmac.new(
            self.app_key.encode("utf-8"),
            (raw_body + "&cookie=").encode("utf-8"),
            hashlib.sha256,
        ).hexdigest().lower()

        resp = await self._http().post(
            self.api_url,
            content=raw_body.encode("utf-8"),
            headers={"Content-Type": "application/json", "X-QYOPI-Sign": sign},
        )
        resp.raise_for_status()
        outer = resp.json()

        if outer.get("ret") != 0:
            raise TMEError(f"天琴接口请求失败: ret={outer.get('ret')} msg={outer.get('msg')}")

        inner = outer.get("data")
        if isinstance(inner, str):
            inner = json.loads(inner)
        return inner or {}

    async def submit(self, *, tags: str, lyrics: str = INSTRUMENTAL_STRUCTURE) -> str:
        inner = await self._post(SUBMIT_CMD, {
            "inputs": {
                "lyrics": lyrics,
                "tags": tags,
                "generate_mode": GENERATE_MODE_LYRICS,
                "song_num": 1,
            }
        })
        if inner.get("code") != 0:
            raise TMEError(f"天琴提交任务失败: {inner.get('msg')}")
        task_id = inner.get("taskId")
        if not task_id:
            raise TMEError(f"天琴没有返回 taskId: {inner}")
        logger.info("tme: 已提交任务 task_id=%s", task_id)
        return task_id

    async def wait_result(self, task_id: str) -> str:
        """轮询到成功后返回云端音频 URL。poll_status: 0=进行中 1=成功 2=失败。"""
        deadline = time.monotonic() + config.TME_POLL_TIMEOUT
        while True:
            inner = await self._post(POLL_CMD, {"taskId": task_id})
            status = inner.get("poll_status")

            if status == 1:
                result = inner.get("data")
                if isinstance(result, str):
                    result = json.loads(result)
                try:
                    url = result["iter_output"][0]["full_decode_url"]
                except (KeyError, IndexError, TypeError) as e:
                    raise TMEError(f"天琴结果里找不到音频地址: {e}; result={result}")
                logger.info("tme: 任务完成 task_id=%s", task_id)
                return url

            if status == 2:
                raise TMEError(f"天琴任务失败或超时 (task_id={task_id})")

            if time.monotonic() > deadline:
                raise TMEError(
                    f"等待天琴结果超时（{config.TME_POLL_TIMEOUT}s, task_id={task_id}）"
                )
            await asyncio.sleep(config.TME_POLL_INTERVAL)

    async def download(self, url: str) -> bytes:
        resp = await self._http().get(url, timeout=120.0)
        resp.raise_for_status()
        return resp.content


def _transcode(audio: bytes, duration: float) -> bytes:
    """MP3 整曲 → 裁到 duration 秒的 16-bit 单声道 WAV。

    两个原因必须转：
      1. project.add_take 一律按 .wav 存，而 audio_utils 用标准库 wave 读——
         MP3 字节塞进 .wav 会让后续混音/波形直接报错。
      2. 天琴返回的是完整曲子，项目要的是 segment_duration 那一小段；多轨
         循环播放时长度不一致会散架。

    没装 ffmpeg 时原样返回并告警——音频在浏览器里还能播（decodeAudioData 按
    内容嗅探格式），只是 Python 侧的混音用不了。
    """
    if not shutil.which("ffmpeg"):
        logger.warning("tme: 未找到 ffmpeg，跳过转码/裁剪，音频保持原始 MP3 格式")
        return audio

    seconds = max(1, int(round(duration or 16)))

    # 输出必须落到真实文件而不是 pipe：WAV 的 RIFF/data 长度字段写在文件头，
    # ffmpeg 要在写完后 seek 回去补。管道不可 seek，它只能写占位值，
    # 结果就是头里的时长完全错乱（实测 16 秒的音频头写成 48695 秒），
    # 波形渲染和浏览器解码都会受影响。
    with tempfile.TemporaryDirectory() as tmp:
        out_path = Path(tmp) / "out.wav"
        try:
            subprocess.run(
                [
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-i", "pipe:0",
                    "-t", str(seconds),
                    "-ac", "1",             # 单声道，和 audio_utils 的假设一致
                    "-ar", "44100",
                    "-c:a", "pcm_s16le",
                    str(out_path),
                ],
                input=audio, capture_output=True, timeout=120, check=True,
            )
            return out_path.read_bytes()
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as e:
            stderr = getattr(e, "stderr", b"") or b""
            logger.warning("tme: ffmpeg 转码失败(%s)，保留原始音频: %s",
                            type(e).__name__, stderr.decode("utf-8", "replace")[:300])
            return audio


class TMEBackend:
    """把天琴接进 GenerationBackend 接口。

    继承关系在 generation_backend.py 里声明（避免循环 import）。
    """

    def __init__(self):
        self._client = TMEClient()

    async def _generate(self, *, prompt: str, bpm: int, key: str,
                        time_signature: str, duration: float,
                        instrument_hint: Optional[str]) -> bytes:
        tags = build_tags(
            prompt=prompt, key=key, time_signature=time_signature,
            bpm=bpm, duration=duration, instrument_key=instrument_hint,
        )
        logger.info("tme: tags=%s", tags)
        task_id = await self._client.submit(tags=tags)
        url = await self._client.wait_result(task_id)
        audio = await self._client.download(url)
        return _transcode(audio, duration)

    async def text2music(self, *, prompt, bpm, key, time_signature, duration,
                         lora_path=None, instrument_hint=None) -> bytes:
        # lora_path 是 ACE-Step 的本地权重概念，天琴用不上，忽略。
        return await self._generate(
            prompt=prompt, bpm=bpm, key=key, time_signature=time_signature,
            duration=duration, instrument_hint=instrument_hint,
        )

    async def lego(self, *, prompt, src_audio_path, bpm, key, time_signature, duration,
                   lora_path=None, instrument_hint=None) -> bytes:
        """天琴没有音频条件生成，降级为 text2music。

        src_audio_path（已有声部的混音）在这里用不上——保留参数只是为了和
        GenerationBackend 接口一致，让 project_gen.py 不用分支。已有声部的信息
        通过 prompt 传达：project_gen._build_prompt 会写成"在已有的某某声部之上，
        扮演什么角色，保持同样的速度和调性"。这是文字层面而非音频层面的配合。
        """
        logger.warning(
            "tme: 不支持 lego（音频层面协同），降级为 text2music + 共享乐理上下文。"
            " 各声部的配合会弱于 ACE-Step。"
        )
        return await self._generate(
            prompt=prompt, bpm=bpm, key=key, time_signature=time_signature,
            duration=duration, instrument_hint=instrument_hint,
        )

    async def repaint(self, *, src_audio_path, prompt, start_time, end_time,
                      lora_path=None) -> bytes:
        raise NotImplementedError(
            "腾讯音乐天琴 API 不支持局部重绘（repaint）。"
            "可以改用「重新生成」，或把生成后端切回 ACE-Step。"
        )

    async def health(self) -> bool:
        return self._client.configured()

    async def close(self) -> None:
        await self._client.close()
