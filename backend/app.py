from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
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
import zipfile

# support running as package (backend.app) or as module (app)
try:
    from .stems import StemGenerator, list_sessions
    from .config import (
        list_lokr_weights, ACESTEP_API_URL, ALLOW_SYNTH_FALLBACK, LOKR_WEIGHTS_DIR,
        OUTPUT_DIR, PROJECTS_DIR, GENERATION_BACKEND, INSTRUMENT_LIBRARY, DEFAULT_INSTRUMENTS,
    )
    from .generator import ACEStepGenerator
    from . import project as projectlib
    from . import project_gen
    from .generation_backend import get_backend, backend_capabilities
    from .conduct import hub as conduct_hub
    from .netinfo import network_info
    from .tunnel import manager as tunnel_manager
except Exception:
    from stems import StemGenerator, list_sessions
    from config import (
        list_lokr_weights, ACESTEP_API_URL, ALLOW_SYNTH_FALLBACK, LOKR_WEIGHTS_DIR,
        OUTPUT_DIR, PROJECTS_DIR, GENERATION_BACKEND, INSTRUMENT_LIBRARY, DEFAULT_INSTRUMENTS,
    )
    from generator import ACEStepGenerator
    import project as projectlib
    import project_gen
    from generation_backend import get_backend, backend_capabilities
    from conduct import hub as conduct_hub
    from netinfo import network_info
    from tunnel import manager as tunnel_manager

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
    buf.seek(0)
    filename = f"{project.get('name') or project_id}.zip"
    return StreamingResponse(
        buf, media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
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
