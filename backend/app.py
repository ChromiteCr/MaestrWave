from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from pydantic import BaseModel
from pathlib import Path
from typing import Optional
import asyncio
import io
import json
import logging
import time
import urllib.parse
import zipfile

# support running as package (backend.app) or as module (app)
try:
    from .stems import StemGenerator, list_sessions
    from .config import (
        list_lokr_weights, ACESTEP_API_URL, ALLOW_SYNTH_FALLBACK, LOKR_WEIGHTS_DIR,
        OUTPUT_DIR, PROJECTS_DIR, GENERATION_BACKEND, INSTRUMENT_LIBRARY, DEFAULT_INSTRUMENTS,
    )
    from . import config as cfg
    from .generator import ACEStepGenerator
    from . import project as projectlib
    from . import project_gen
    from .generation_backend import get_backend, backend_capabilities
    from . import composer as composerlib
    from . import render as renderlib
    from . import score_gen
    from . import practice
    from . import repertoire as repertoirelib
    from .conduct import hub as conduct_hub
    from .netinfo import network_info
    from .tunnel import manager as tunnel_manager
    from . import llm as llmlib
    from . import configuration as configlib
    from . import agent as agentlib
except Exception:
    from stems import StemGenerator, list_sessions
    from config import (
        list_lokr_weights, ACESTEP_API_URL, ALLOW_SYNTH_FALLBACK, LOKR_WEIGHTS_DIR,
        OUTPUT_DIR, PROJECTS_DIR, GENERATION_BACKEND, INSTRUMENT_LIBRARY, DEFAULT_INSTRUMENTS,
    )
    import config as cfg
    from generator import ACEStepGenerator
    import project as projectlib
    import project_gen
    from generation_backend import get_backend, backend_capabilities
    import composer as composerlib
    import render as renderlib
    import score_gen
    import practice
    import repertoire as repertoirelib
    from conduct import hub as conduct_hub
    from netinfo import network_info
    from tunnel import manager as tunnel_manager
    import llm as llmlib
    import configuration as configlib
    import agent as agentlib

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
FRONTEND_DIST_DIR = FRONTEND_DIR / "dist"
AUDIO_DIR = Path(OUTPUT_DIR)
AUDIO_DIR.mkdir(parents=True, exist_ok=True)
Path(LOKR_WEIGHTS_DIR).mkdir(parents=True, exist_ok=True)
Path(PROJECTS_DIR).mkdir(parents=True, exist_ok=True)

app = FastAPI(title="MTX Orchestral Conductor")

# 静态文件服务
app.mount("/audio", StaticFiles(directory=str(AUDIO_DIR)), name="audio")
# 新的 project 模型的音频（takes/ 混音临时文件）单独挂一个前缀
app.mount("/project-audio", StaticFiles(directory=str(PROJECTS_DIR)), name="project-audio")
# 生产模式下 `npm run build` 产出的 React 前端（见 frontend/vite.config.ts）；
# 开发模式下前端走 Vite dev server（:5173，proxy /api 到本服务），不经过这里。
if FRONTEND_DIST_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST_DIR / "assets")), name="frontend-assets")

stem_gen = StemGenerator()


class GenerateRequest(BaseModel):
    description: str
    duration: int = 60
    bpm: int = 80
    key: str = "D major"
    # 可选：要使用的 LoKr/LoRA 权重 ID（来自 /api/lokr 返回的 id）
    # 也接受 "none" / "default" / 任意绝对路径
    lora_path: Optional[str] = None


class GenerateResponse(BaseModel):
    session_id: str
    full_mix_url: str
    stems: dict
    metadata: dict


class RepaintRequest(BaseModel):
    session_id: str
    target: str = "full_mix"  # full_mix / violin / cello / trumpet / woodwind / percussion
    prompt: str
    start_time: float
    end_time: float
    lora_path: Optional[str] = None


class RepaintResponse(BaseModel):
    session_id: str
    target: str
    original_url: str
    repaint_url: str
    repaint_file: str


def _resolve_lora_id_or_path(lora_path: Optional[str]) -> Optional[str]:
    """把前端传入的 LoKr 选择值解析为绝对路径（或 none/default 原样保留）。"""
    if not lora_path:
        return lora_path
    if lora_path in ("none", "default"):
        return lora_path
    candidate = Path(LOKR_WEIGHTS_DIR) / lora_path
    if candidate.exists():
        return str(candidate)
    return lora_path


@app.get("/api/health")
async def health():
    """前端可借此判断后端 + ACE-Step 是否可用。"""
    gen = ACEStepGenerator()
    try:
        ace_ok = await gen.ping()
    finally:
        await gen.close()
    # 当前选中的生成后端是否可用（天琴看密钥配没配，ACE-Step 看服务通不通）
    active = get_backend()
    try:
        active_ok = await active.health()
    except Exception:
        active_ok = False
    finally:
        await active.close()

    return {
        "backend": "ok",
        "acestep_api_url": ACESTEP_API_URL,
        "acestep_reachable": ace_ok,
        "synth_fallback_enabled": ALLOW_SYNTH_FALLBACK,
        "generation_backend": GENERATION_BACKEND,
        "generation_backend_ready": active_ok,
        "capabilities": backend_capabilities(),
        # 符号乐谱模式（generation_mode="score"）用哪个作曲器、哪个渲染器。
        # 和上面那套是两个维度：上面按环境变量选服务，这个按项目选流水线。
        "score": {**renderlib.renderer_status(), **composerlib.composer_status()},
    }


@app.get("/api/network-info")
async def get_network_info():
    """
    局域网地址。「输出」页在电脑模式下用它拼出手机扫码用的 URL——
    浏览器自己拿不到本机局域网 IP，必须问后端（见 backend/netinfo.py）。
    """
    info = network_info()
    info["conduct_rooms"] = conduct_hub.room_stats()
    return info


@app.websocket("/ws/conduct/{room_id}")
async def conduct_ws(websocket: WebSocket, room_id: str, role: str = "remote"):
    """
    手机遥控指挥的中转通道（见 backend/conduct.py）。
    role=stage 是电脑（加载音频、出声），role=remote 是手机（只采传感器）。
    """
    if role not in ("stage", "remote"):
        await websocket.close(code=1008)
        return

    try:
        peer_id = await conduct_hub.join(room_id, role, websocket)
    except RuntimeError:
        return  # join 里已经关掉连接了（比如房间满）

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue

            # 心跳就地应答，不进转发链路。
            if payload.get("t") == "ping":
                await websocket.send_text(json.dumps({"t": "pong"}))
                continue

            if role == "remote":
                await conduct_hub.relay_from_remote(room_id, peer_id, payload)
            else:
                await conduct_hub.relay_from_stage(room_id, payload)
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("conduct ws 异常 room=%s role=%s", room_id, role)
    finally:
        await conduct_hub.leave(room_id, role, peer_id)


class TunnelStartRequest(BaseModel):
    port: int = 5173


@app.get("/api/tunnel")
async def get_tunnel_status():
    """隧道当前状态（见 backend/tunnel.py）。前端轮询它等域名分配下来。"""
    return tunnel_manager.status()


@app.post("/api/tunnel/start")
async def start_tunnel(req: TunnelStartRequest):
    """
    启动 cloudflared 隧道。只应由用户在「输出」页显式点击触发——
    这会把本机 dev server 暴露到公网。
    """
    return await tunnel_manager.start(req.port)


@app.post("/api/tunnel/stop")
async def stop_tunnel():
    return await tunnel_manager.stop()


@app.on_event("shutdown")
async def _shutdown_tunnel():
    """后端退出时兜底关掉隧道，避免它在用户不知情的情况下一直开着。"""
    await tunnel_manager.stop()


@app.get("/api/lokr")
async def get_lokr_list():
    """列出 lokr_weights/ 目录下所有可用权重。
    前端用此构造下拉框；总是包含一个 'none'（不使用任何权重）选项。
    """
    items = list_lokr_weights()
    options = [{"id": "none", "name": "无（不加载 LoKr / 原始模型）", "path": ""}]
    options += items
    return {"options": options, "weights_dir": str(LOKR_WEIGHTS_DIR)}


@app.get("/api/sessions")
async def get_sessions():
    """列出全部历史生成会话，供前端"音乐库"展示。"""
    return {"sessions": list_sessions()}


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    """获取单个会话的分轨 url 信息。"""
    for s in list_sessions():
        if s["session_id"] == session_id:
            return s
    raise HTTPException(status_code=404, detail="session not found")


@app.post("/api/generate", response_model=GenerateResponse)
async def generate_stems(req: GenerateRequest):
    lora_path = _resolve_lora_id_or_path(req.lora_path)

    try:
        result = await stem_gen.generate_full_session(
            user_description=req.description,
            duration=req.duration,
            bpm=req.bpm,
            key=req.key,
            lora_path=lora_path,
        )
    except Exception as e:
        logger.exception("generation failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))

    sid = result["session_id"]
    stems_urls = {k: f"/audio/{sid}/{k}.wav" for k in result["stems"]}

    return GenerateResponse(
        session_id=sid,
        full_mix_url=f"/audio/{sid}/full_mix.wav",
        stems=stems_urls,
        metadata=result.get("metadata", {}),
    )


@app.post("/api/generate/stream")
async def generate_stems_stream(req: GenerateRequest):
    """以 SSE 流式推送生成进度。前端用 fetch + ReadableStream 读取。
    事件类型：start / stage_start / stage_done / stage_error / done / error
    每条以 "data: <json>\n\n" 发送。
    """
    lora_path = _resolve_lora_id_or_path(req.lora_path)
    queue: asyncio.Queue = asyncio.Queue()
    SENTINEL = object()

    async def cb(event: dict):
        await queue.put(event)

    async def runner():
        try:
            result = await stem_gen.generate_full_session(
                user_description=req.description,
                duration=req.duration,
                bpm=req.bpm,
                key=req.key,
                lora_path=lora_path,
                progress_cb=cb,
            )
            sid = result["session_id"]
            stems_urls = {k: f"/audio/{sid}/{k}.wav" for k in result["stems"]}
            await queue.put({
                "type": "done",
                "session_id": sid,
                "full_mix_url": f"/audio/{sid}/full_mix.wav",
                "stems": stems_urls,
                "metadata": result.get("metadata", {}),
            })
        except Exception as e:
            logger.exception("streaming generation failed: %s", e)
            await queue.put({"type": "error", "error": str(e)})
        finally:
            await queue.put(SENTINEL)

    task = asyncio.create_task(runner())

    async def event_stream():
        try:
            while True:
                item = await queue.get()
                if item is SENTINEL:
                    break
                yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/repaint", response_model=RepaintResponse)
async def repaint_segment(req: RepaintRequest):
    """对某个会话的指定轨道进行局部重绘，输出新文件。"""
    if req.start_time < 0 or req.end_time <= req.start_time:
        raise HTTPException(status_code=400, detail="invalid repaint time range")

    session_dir = AUDIO_DIR / req.session_id
    if not session_dir.exists():
        raise HTTPException(status_code=404, detail="session not found")

    target = (req.target or "full_mix").strip().lower()
    target_file = session_dir / f"{target}.wav"
    if not target_file.exists():
        raise HTTPException(status_code=404, detail=f"target wav not found: {target}.wav")

    lora_path = _resolve_lora_id_or_path(req.lora_path)
    try:
        audio_bytes = await stem_gen.gen.repaint(
            audio_path=str(target_file),
            prompt=req.prompt,
            start_time=req.start_time,
            end_time=req.end_time,
            lora_path=lora_path,
        )
    except Exception as e:
        logger.exception("repaint failed: %s", e)
        raise HTTPException(status_code=500, detail=f"repaint failed: {e}")

    repaint_name = f"{target}_repaint_{int(time.time())}.wav"
    repaint_file = session_dir / repaint_name
    repaint_file.write_bytes(audio_bytes)

    return RepaintResponse(
        session_id=req.session_id,
        target=target,
        original_url=f"/audio/{req.session_id}/{target}.wav",
        repaint_url=f"/audio/{req.session_id}/{repaint_name}",
        repaint_file=repaint_name,
    )


# ============================================================
# 新的 project 模型 API：分乐器按需生成 + lego 和声机制（见 project_gen.py）
# ============================================================

class CreateProjectRequest(BaseModel):
    style_description: str
    key: str = "D major"
    bpm: int = 80
    time_signature: str = "4/4"
    # total_duration 是 M4d 起的正式字段；segment_duration 保留为兼容入参，
    # 两者都收，projectlib.set_duration 会一起写。
    total_duration: Optional[float] = None
    segment_duration: float = 16.0
    name: str = ""
    generation_mode: str = "multitrack"


class UpdateProjectRequest(BaseModel):
    style_description: Optional[str] = None
    key: Optional[str] = None
    bpm: Optional[int] = None
    time_signature: Optional[str] = None
    total_duration: Optional[float] = None
    segment_duration: Optional[float] = None
    name: Optional[str] = None
    generation_mode: Optional[str] = None
    formation: Optional[dict] = None
    generation_order: Optional[list] = None


class AddInstrumentRequest(BaseModel):
    library_key: str
    display_name: Optional[str] = None
    role: Optional[str] = None
    family: Optional[str] = None


class GenerateInstrumentRequest(BaseModel):
    lora_path: Optional[str] = None


class RepaintInstrumentRequest(BaseModel):
    prompt: str
    start_time: float
    end_time: float
    lora_path: Optional[str] = None


def _take_url(project_id: str, instrument_id: str, audio_file: str) -> str:
    return f"/project-audio/{project_id}/takes/{instrument_id}/{audio_file}"


def _content_disposition(filename: str) -> str:
    """下载文件名。**中文名必须走 RFC 5987 的 filename\\*。**

    HTTP 头只能是 latin-1，直接把中文塞进 `filename="..."` 会让 starlette 在
    编码响应头时抛 UnicodeEncodeError，整个请求 500 —— 而项目名默认就允许中文。
    做法是给两份：ASCII 的 `filename` 兜底老客户端，UTF-8 百分号编码的
    `filename*` 给现代浏览器（后者优先级更高）。
    """
    quoted = urllib.parse.quote(filename, safe="")
    stem, _, ext = filename.rpartition(".")
    ascii_stem = (stem or filename).encode("ascii", "ignore").decode("ascii")
    ascii_stem = ascii_stem.replace('"', "").strip()
    # 纯中文名 ASCII 化之后会只剩个扩展名（".mid"），给个能认的默认词干
    ascii_name = f"{ascii_stem or 'maestrwave'}.{ext}" if ext else (ascii_stem or "download")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quoted}"


def _serialize_project(project: dict) -> dict:
    """给每个 take 补一个可直接播放的 url 字段，前端不用自己拼路径。"""
    out = json.loads(json.dumps(project))
    for inst in out.get("instruments", []):
        for take in inst.get("takes", []):
            take["url"] = _take_url(out["project_id"], inst["id"], take["audio_file"])
    return out


@app.get("/api/instrument-library")
async def get_instrument_library():
    """给「生成」页的乐器 tab 选择器用：默认三个 tab + 完整可选乐器目录。"""
    return {"default_instruments": DEFAULT_INSTRUMENTS, "library": INSTRUMENT_LIBRARY}


# ---------------- BYOK 语言模型 ----------------

class LLMConfigRequest(BaseModel):
    base_url: Optional[str] = None
    model: Optional[str] = None
    # 空字符串 = 保持原 key 不动（这样可以只改 base_url 而不必重填 key）
    api_key: Optional[str] = None


class FormationSkeletonRequest(BaseModel):
    style_description: Optional[str] = None
    mood_tags: Optional[list] = None
    ensemble_size: Optional[str] = None
    climax_hint: Optional[str] = None
    template_id: Optional[str] = None


class FormationRefineRequest(BaseModel):
    instruction: str
    scope: Optional[str] = None


def _guard_llm(token: Optional[str]) -> None:
    """隧道开着时才要求令牌 —— 隧道没开说明只有本机能访问，不设门槛。

    针对的实际风险：隧道把后端暴露到公网后，拿到链接的人可以直接调用 LLM 接口白嫖
    用户的 key 额度。房间码只保护 WebSocket 指挥通道，不保护 REST。
    """
    running = bool(tunnel_manager.status().get("running"))
    try:
        llmlib.check_access(running, token)
    except llmlib.LLMError as e:
        raise HTTPException(status_code=403, detail=str(e))


@app.get("/api/llm/config")
async def get_llm_config():
    """「设置」页读它。**只回 has_key 与掩码，绝不回显明文 key。**"""
    status = llmlib.public_status()
    status["tunnel_running"] = bool(tunnel_manager.status().get("running"))
    return status


@app.post("/api/llm/config")
async def set_llm_config(req: LLMConfigRequest):
    llmlib.save_config(base_url=req.base_url, model=req.model, api_key=req.api_key)
    return llmlib.public_status()


class AgentChatRequest(BaseModel):
    """messages 只接受 user/assistant，system 由服务端拼（见 agent.sanitize_history）。"""
    messages: list[dict]
    context: Optional[dict] = None


@app.post("/api/agent/chat")
async def agent_chat(req: AgentChatRequest, x_mw_token: Optional[str] = Header(default=None)):
    """对话式 Agent。和构型页共用一条 BYOK 通路，因此同样受隧道令牌与限流保护。"""
    _guard_llm(x_mw_token)
    try:
        reply = await agentlib.answer(req.messages, req.context)
    except llmlib.LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"reply": reply}


class ScorePrefsRequest(BaseModel):
    """「设置」页选的音源与作曲器。auto 表示按可用性自动挑。"""
    renderer: Optional[str] = None
    composer: Optional[str] = None
    """外部符号音乐模型服务地址。空字符串表示清除。"""
    symbolic_url: Optional[str] = None


@app.post("/api/score/prefs")
async def set_score_prefs(req: ScorePrefsRequest):
    valid_r = {"auto", "sf2", "fluidsynth", "builtin"}
    valid_c = {"auto", "llm", "remote", "algorithmic"}
    if req.renderer is not None and req.renderer not in valid_r:
        raise HTTPException(status_code=400, detail=f"renderer 只能是 {sorted(valid_r)}")
    if req.composer is not None and req.composer not in valid_c:
        raise HTTPException(status_code=400, detail=f"composer 只能是 {sorted(valid_c)}")
    # 用顶上那个 `cfg` 而不是在函数里 `from config import …`：以包的方式启动
    # （`uvicorn backend.app:app`，发布包的入口就是这么跑的）时顶层 `config`
    # 根本不在 sys.path 上，函数里那句 import 会当场 ModuleNotFoundError ——
    # 这个端点在发布包里一直是 500，只是没人从那条路径点过它。
    url = req.symbolic_url.strip() if req.symbolic_url is not None else None
    if url:
        # 只放行本机/局域网。理由见 config.is_private_endpoint —— 和 llm.py 的
        # 「白名单只能手工加」是同一条线：接口不能把后端的外发范围拉大。
        if not cfg.is_private_endpoint(url):
            raise HTTPException(
                status_code=400,
                detail="只能填本机或局域网地址（localhost / 127.x / 10.x / 192.168.x / *.local）。"
                       "确实要连公网服务的话，请用 SYMBOLIC_COMPOSER_URL 环境变量启动。")
    cfg.save_score_prefs(renderer=req.renderer, composer=req.composer, symbolic_url=url)
    return {**renderlib.renderer_status(), **composerlib.composer_status()}


# ---------------- 指挥练习曲 / 考试曲目 ----------------

class PracticeRequest(BaseModel):
    """一首练习曲的完整定义。字段含义与边界见 `practice.PieceSpec`。

    **spec 由前端给**，后端只是把它渲染出来。这样课程数据（`curriculum.ts`）
    与考试曲目（`exam.ts`）保持单一真源 —— 后端再抄一份必然漂移，而考试曲目
    一漂移就意味着两个人考的不是同一首。「固定」由 spec 是常量 + 渲染可复现
    共同保证，不需要往仓库里塞音频文件。
    """
    style: str = "march"
    meter: int = 4
    bpm: int = 88
    bars: int = 16
    count_in_bars: int = 1
    key: str = "C major"
    dynamics: Optional[list[float]] = None
    pickup: bool = False
    seed: int = 0


# piece_id → "rendering" | "ready" | 错误消息。只在内存里，进程重启后靠磁盘
# 上的文件重新判断（`practice.is_ready`），不需要持久化。
_practice_jobs: dict[str, str] = {}


def _practice_status(pid: str) -> dict:
    if practice.is_ready(pid):
        meta = practice.load_meta(pid)
        if meta:
            return {"state": "ready", **meta}
    state = _practice_jobs.get(pid)
    if state in (None, "ready"):
        # "ready" 但文件不在了（用户删了 output/practice）：当成没生成过
        return {"piece_id": pid, "state": "missing"}
    if state == "rendering":
        return {"piece_id": pid, "state": "rendering"}
    return {"piece_id": pid, "state": "error", "error": state}


async def _render_practice(spec, pid: str) -> None:
    try:
        # 渲染是纯 CPU 的（几秒到十几秒），直接在事件循环里跑会把整个后端卡住 ——
        # 摄像头指挥的 WebSocket 也在这个循环上。
        await asyncio.to_thread(practice.render_piece, spec)
        _practice_jobs[pid] = "ready"
    except Exception as e:
        logger.exception("练习曲渲染失败 %s", pid)
        _practice_jobs[pid] = f"{type(e).__name__}: {e}"


@app.post("/api/practice/generate")
async def practice_generate(req: PracticeRequest):
    """开始渲染一首练习曲，立刻返回 piece_id。已经渲染过的直接就绪。"""
    try:
        spec = practice.parse_spec(req.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    pid = practice.piece_id(spec)
    if practice.is_ready(pid):
        return _practice_status(pid)
    if _practice_jobs.get(pid) != "rendering":
        _practice_jobs[pid] = "rendering"
        asyncio.create_task(_render_practice(spec, pid))
    return {"piece_id": pid, "state": "rendering"}


def _valid_piece_id(pid: str) -> str:
    """piece_id 从 URL 上来，落到文件名之前必须校验 —— 否则 `../` 就能读任意文件。"""
    if not practice.PIECE_ID_RE.match(pid):
        raise HTTPException(status_code=400, detail="piece_id 格式不对")
    return pid


# 带后缀的两条必须写在 `/{piece_id}` **前面**：路径参数不匹配 `/` 但匹配 `.`，
# 所以 `/api/practice/abc.wav` 会先被裸的那条吃掉，piece_id 变成 "abc.wav"。
@app.get("/api/practice/{piece_id}.wav")
async def practice_audio(piece_id: str):
    pid = _valid_piece_id(piece_id)
    path = practice.piece_dir() / f"{pid}.wav"
    if not path.exists():
        raise HTTPException(status_code=404, detail="这首练习曲还没渲染好")
    return FileResponse(path, media_type="audio/wav")


@app.get("/api/practice/{piece_id}.mid")
async def practice_midi(piece_id: str):
    """练习曲的 MIDI。曲子本来就是写出来的，导出等于零成本 ——
    想弄清「标准答案长什么样」的人可以直接拖进 MuseScore 看谱。"""
    pid = _valid_piece_id(piece_id)
    path = practice.piece_dir() / f"{pid}.mid"
    if not path.exists():
        raise HTTPException(status_code=404, detail="这首练习曲还没渲染好")
    return FileResponse(path, media_type="audio/midi",
                        filename=f"practice-{pid}.mid")


@app.get("/api/practice/{piece_id}")
async def practice_status(piece_id: str):
    return _practice_status(_valid_piece_id(piece_id))


# ---------------- 随仓库分发的真实曲目 ----------------
#
# 渲染产物与练习曲**同形、同目录**，所以上面 `/api/practice/{id}.wav|.mid|状态`
# 那三条端点原样就能服务这里的曲目，不需要再写一遍。这里只加「列清单」「开始渲染」
# 「造成可指挥的项目」「下原始文件」四条。

def _repertoire_or_404(item_id: str):
    item = repertoirelib.ITEMS.get(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="没有这首曲目")
    return item


async def _render_repertoire(item, pid: str) -> None:
    try:
        await asyncio.to_thread(repertoirelib.render_piece, item)
        _practice_jobs[pid] = "ready"
    except Exception as e:
        logger.exception("曲目渲染失败 %s", pid)
        _practice_jobs[pid] = f"{type(e).__name__}: {e}"


@app.get("/api/repertoire")
async def repertoire_list():
    """曲目清单。不触发渲染，只报「准备好了没」。"""
    return {"items": repertoirelib.listing()}


@app.post("/api/repertoire/{item_id}/prepare")
async def repertoire_prepare(item_id: str):
    """开始渲染，立刻返回 piece_id。返回结构与 `/api/practice/generate` 一致，
    前端那个轮询 hook 不用分辨这首是写出来的还是读进来的。"""
    item = _repertoire_or_404(item_id)
    pid = repertoirelib.piece_id(item)
    if repertoirelib.is_ready(pid):
        return _practice_status(pid)
    if _practice_jobs.get(pid) != "rendering":
        _practice_jobs[pid] = "rendering"
        asyncio.create_task(_render_repertoire(item, pid))
    return {"piece_id": pid, "state": "rendering"}


@app.post("/api/repertoire/{item_id}/project")
async def repertoire_project(item_id: str):
    """把曲目造成一个可指挥的项目：每条 MIDI 轨一个乐器、一条 take。

    造完之后走的是和自己生成的项目完全一样的链路，指挥那边一行都不用改。
    """
    item = _repertoire_or_404(item_id)
    try:
        project = await asyncio.to_thread(repertoirelib.build_project, item)
    except Exception as e:
        logger.exception("曲目建项目失败 %s", item_id)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")
    return {"project": project}


@app.get("/api/repertoire/{item_id}/source.mid")
async def repertoire_source(item_id: str):
    """原始 MIDI，**未截取**。截取只发生在渲染那一路，想拿全曲的人应该拿到全曲。"""
    item = _repertoire_or_404(item_id)
    path = repertoirelib.asset_path(item)
    if not path.exists():
        raise HTTPException(status_code=404, detail="曲目文件不在")
    return FileResponse(path, media_type="audio/midi", filename=item.filename)


@app.get("/api/formation/templates")
async def get_formation_templates():
    """模版列表。纯本地，没配 key 也能用 —— 这是构型页的保底路径。"""
    return {"templates": configlib.list_templates()}


def _load_or_404(project_id: str) -> dict:
    try:
        return projectlib.load_project(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="project not found")


@app.post("/api/projects/{project_id}/formation/template")
async def apply_formation_template(project_id: str, template_id: str):
    project = _load_or_404(project_id)
    try:
        formation = configlib.apply_template(template_id, project)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    projectlib.update_settings(project, formation=formation)
    return formation


@app.post("/api/projects/{project_id}/formation/generate")
async def generate_formation_endpoint(project_id: str, req: FormationSkeletonRequest,
                                       x_mw_token: Optional[str] = Header(default=None)):
    _guard_llm(x_mw_token)
    project = _load_or_404(project_id)
    formation = await configlib.generate_formation(project, req.model_dump(exclude_none=True))
    projectlib.update_settings(project, formation=formation)
    return formation


@app.post("/api/projects/{project_id}/formation/refine")
async def refine_formation_endpoint(project_id: str, req: FormationRefineRequest,
                                     x_mw_token: Optional[str] = Header(default=None)):
    _guard_llm(x_mw_token)
    project = _load_or_404(project_id)
    formation = project.get("formation")
    if not formation:
        raise HTTPException(status_code=400, detail="这个项目还没有构型")
    try:
        updated = await configlib.refine_formation(project, formation, req.instruction, req.scope)
    except llmlib.LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))
    projectlib.update_settings(project, formation=updated)
    return updated


@app.put("/api/projects/{project_id}/formation")
async def save_formation(project_id: str, formation: dict):
    """保存用户在构型页手工编辑后的结果。不调模型，但仍走一遍校验修复。"""
    project = _load_or_404(project_id)
    repaired = configlib.validate_and_repair(
        formation, project, created_by="manual",
        template_id=formation.get("source_template_id"),
    )
    repaired["dirty"] = True
    repaired["revision"] = int(formation.get("revision") or 0)
    projectlib.update_settings(project, formation=repaired)
    return repaired


@app.post("/api/projects/{project_id}/formation/apply")
async def apply_formation_to_project(project_id: str):
    """「应用到生成页」：写回项目设置 + 按构型创建乐器 tab。

    显式动作而不是自动同步 —— 用户在构型页改了东西不该立刻把生成页已生成的 tab 洗掉。
    """
    project = _load_or_404(project_id)
    formation = project.get("formation")
    if not formation:
        raise HTTPException(status_code=400, detail="这个项目还没有构型")

    g = formation["global"]
    projectlib.update_settings(
        project, key=g["key"], bpm=g["bpm"], time_signature=g["time_signature"],
        total_duration=g["total_duration"],
        # 全局提示词写进 style_description：project_gen._build_prompt 里
        # spec["prompt"].format(style=...) 会自动让它全程生效，后端一行不用改。
        style_description=g["global_prompt"],
    )

    # 已有乐器按 library_key 匹配保留（连同已生成的 take），只更新 role
    existing = {i["library_key"]: i for i in project["instruments"]}
    order: list[str] = []
    created = 0
    for fi in formation["instruments"]:
        hit = existing.get(fi["library_key"])
        if hit:
            hit["role"] = fi["role"]
            hit["participation"] = list(fi["participation"])
            hit["tier"] = fi["tier"]
            order.append(hit["id"])
        else:
            inst = projectlib.add_instrument(
                project, fi["library_key"], fi["display_name"],
                role=fi["role"], family=fi.get("family"),
                participation=list(fi["participation"]), tier=fi["tier"],
            )
            order.append(inst["id"])
            created += 1

    formation["revision"] = int(formation.get("revision") or 0) + 1
    projectlib.update_settings(project, formation=formation, generation_order=order)
    extra = [i for i in project["instruments"] if i["id"] not in order]
    return {
        "project": _serialize_project(project),
        "created": created,
        # 构型里没有的多余乐器不自动删，交给用户决定
        "unmatched": [{"id": i["id"], "display_name": i["display_name"]} for i in extra],
    }


@app.post("/api/projects")
async def create_project_endpoint(req: CreateProjectRequest):
    project = projectlib.create_project(
        style_description=req.style_description, key=req.key, bpm=req.bpm,
        time_signature=req.time_signature,
        segment_duration=req.total_duration if req.total_duration is not None else req.segment_duration,
        name=req.name, generation_mode=req.generation_mode,
    )
    return _serialize_project(project)


@app.get("/api/projects")
async def list_projects_endpoint():
    return {"projects": [_serialize_project(p) for p in projectlib.list_projects()]}


@app.get("/api/projects/{project_id}")
async def get_project_endpoint(project_id: str):
    try:
        project = projectlib.load_project(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="project not found")
    return _serialize_project(project)


@app.patch("/api/projects/{project_id}")
async def update_project_endpoint(project_id: str, req: UpdateProjectRequest):
    """更新项目级共享上下文（生成页「高级」面板用：调式/拍号/BPM/单段时长）。"""
    try:
        project = projectlib.load_project(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="project not found")
    project = projectlib.update_settings(project, **req.model_dump(exclude_unset=True))
    return _serialize_project(project)


@app.get("/api/projects/{project_id}/export")
async def export_project_endpoint(project_id: str):
    """把 project.json + 所有 take 音频打包成 zip 下载。"""
    try:
        project = projectlib.load_project(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="project not found")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("project.json", json.dumps(project, ensure_ascii=False, indent=2))
        for inst in project["instruments"]:
            for take in inst["takes"]:
                wav_path = projectlib.takes_dir(project_id, inst["id"]) / take["audio_file"]
                if wav_path.exists():
                    zf.write(wav_path, f"takes/{inst['display_name']}_{inst['id']}/{take['audio_file']}")

        # 写谱模式：谱子和音频一样是这个项目的产物，导出漏掉的话，拿到 zip 的人
        # 只有渲染结果、没有音符，改不了也接不下去。
        scores = score_gen.scores_dir(project_id)
        if scores.is_dir():
            for f in sorted(scores.glob("*.json")):
                zf.write(f, f"scores/{f.name}")
        try:
            zf.writestr("score.mid", score_gen.project_midi(project))
        except ValueError:
            pass  # 还没生成过任何声部，没有可导的谱子
    buf.seek(0)
    filename = f"{project.get('name') or project_id}.zip"
    return StreamingResponse(
        buf, media_type="application/zip",
        headers={"Content-Disposition": _content_disposition(filename)},
    )


@app.get("/api/projects/{project_id}/score")
async def get_project_score(project_id: str):
    """蓝图 + 各声部音符，喂「生成」页的钢琴卷帘。"""
    project = _load_or_404(project_id)
    return score_gen.project_score(project)


@app.get("/api/projects/{project_id}/score.mid")
async def get_project_midi(project_id: str):
    """全部声部导出成一个 MIDI，拿去 MuseScore / DAW 里用。"""
    project = _load_or_404(project_id)
    try:
        data = score_gen.project_midi(project)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    name = f"{project.get('name') or project_id}.mid"
    return StreamingResponse(
        io.BytesIO(data), media_type="audio/midi",
        headers={"Content-Disposition": _content_disposition(name)},
    )


@app.post("/api/projects/{project_id}/instruments")
async def add_instrument_endpoint(project_id: str, req: AddInstrumentRequest):
    try:
        project = projectlib.load_project(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="project not found")
    if req.library_key not in INSTRUMENT_LIBRARY:
        # 允许完全自定义乐器名（get_instrument_spec 会退化成通用模板）
        logger.info("adding custom instrument not in library: %s", req.library_key)
    instrument = projectlib.add_instrument(
        project, req.library_key, req.display_name, role=req.role, family=req.family,
    )
    return instrument


@app.delete("/api/projects/{project_id}/instruments/{instrument_id}")
async def remove_instrument_endpoint(project_id: str, instrument_id: str):
    try:
        project = projectlib.load_project(project_id)
        projectlib.remove_instrument(project, instrument_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="project not found")
    except KeyError:
        raise HTTPException(status_code=404, detail="instrument not found")
    return {"ok": True}


@app.post("/api/projects/{project_id}/instruments/{instrument_id}/generate")
async def generate_instrument_endpoint(project_id: str, instrument_id: str,
                                        req: GenerateInstrumentRequest):
    """一次点击 = 一段单乐器音频。同一接口同时服务"首次生成"和"regenerate"：
    项目里第一件有 take 的乐器走 text2music，其余的都用 lego 参照当前已生成
    的其它乐器（regenerate 时会排除自己，所以永远参照"除自己外的最新状态"）。"""
    try:
        project = projectlib.load_project(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="project not found")

    # 模式三走完全不同的流水线（作曲 → 渲染），但**返回结构一模一样**，
    # 所以前端、浏览页、指挥链路都不用知道这件事。
    if (project.get("generation_mode") or "").lower() == "score":
        try:
            take = await score_gen.generate_instrument_score(
                project, instrument_id, composerlib.get_composer(), renderlib.get_renderer())
        except KeyError:
            raise HTTPException(status_code=404, detail="instrument not found")
        except composerlib.ComposerError as e:
            raise HTTPException(status_code=502, detail=str(e))
        except Exception as e:
            logger.exception("score generation failed: %s", e)
            raise HTTPException(status_code=500, detail=str(e))
        take = dict(take)
        take["url"] = _take_url(project_id, instrument_id, take["audio_file"])
        return take

    lora_path = _resolve_lora_id_or_path(req.lora_path)
    backend = get_backend()
    try:
        take = await project_gen.generate_instrument(project, instrument_id, backend, lora_path)
    except KeyError:
        raise HTTPException(status_code=404, detail="instrument not found")
    except Exception as e:
        logger.exception("instrument generation failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await backend.close()

    take = dict(take)
    take["url"] = _take_url(project_id, instrument_id, take["audio_file"])
    return take


@app.post("/api/projects/{project_id}/instruments/{instrument_id}/repaint")
async def repaint_instrument_endpoint(project_id: str, instrument_id: str,
                                       req: RepaintInstrumentRequest):
    if req.start_time < 0 or req.end_time <= req.start_time:
        raise HTTPException(status_code=400, detail="invalid repaint time range")
    try:
        project = projectlib.load_project(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="project not found")

    # 符号模式下重绘是真能做的：重写那几小节的音符再整轨重渲染，
    # 不需要模型支持音频层面的局部重绘（天琴那边直接 501）。
    if (project.get("generation_mode") or "").lower() == "score":
        try:
            take = await score_gen.repaint_instrument_score(
                project, instrument_id, composerlib.get_composer(), renderlib.get_renderer(),
                start_time=req.start_time, end_time=req.end_time)
        except KeyError:
            raise HTTPException(status_code=404, detail="instrument not found")
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except composerlib.ComposerError as e:
            raise HTTPException(status_code=502, detail=str(e))
        except Exception as e:
            logger.exception("score repaint failed: %s", e)
            raise HTTPException(status_code=500, detail=str(e))
        take = dict(take)
        take["url"] = _take_url(project_id, instrument_id, take["audio_file"])
        return take

    lora_path = _resolve_lora_id_or_path(req.lora_path)
    backend = get_backend()
    try:
        take = await project_gen.repaint_instrument(
            project, instrument_id, backend,
            prompt=req.prompt, start_time=req.start_time, end_time=req.end_time,
            lora_path=lora_path,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="instrument not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except NotImplementedError as e:
        # 当前生成后端不支持 repaint（比如天琴只有整曲文生乐），
        # 用 501 而不是 500，前端好区分"能力缺失"和"真出错了"。
        raise HTTPException(status_code=501, detail=str(e))
    except Exception as e:
        logger.exception("instrument repaint failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await backend.close()

    take = dict(take)
    take["url"] = _take_url(project_id, instrument_id, take["audio_file"])
    return take


@app.get("/")
async def index():
    dist_index = FRONTEND_DIST_DIR / "index.html"
    if dist_index.exists():
        return FileResponse(str(dist_index))
    return JSONResponse({
        "backend": "ok",
        "hint": (
            "前端还没有构建产物（frontend/dist/）。开发时运行 `npm run dev`（在 "
            "frontend/ 目录下）并访问它给出的地址（默认 http://localhost:5173），"
            "它会把 /api、/audio、/project-audio 转发到这个后端；生产部署时先 "
            "`npm run build` 再重启本服务。"
        ),
    })
