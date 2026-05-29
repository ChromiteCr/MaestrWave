from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from stems import StemGenerator
from pathlib import Path
import logging

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
AUDIO_DIR = BASE_DIR / "output" / "sessions"

app = FastAPI()

# 静态文件服务
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")
app.mount("/audio", StaticFiles(directory=str(AUDIO_DIR)), name="audio")

stem_gen = StemGenerator()


class GenerateRequest(BaseModel):
    description: str
    duration: int = 60
    bpm: int = 80
    key: str = "D major"


class GenerateResponse(BaseModel):
    session_id: str
    full_mix_url: str
    stems: dict


@app.post("/api/generate", response_model=GenerateResponse)
async def generate_stems(req: GenerateRequest):
    try:
        result = await stem_gen.generate_full_session(
            user_description=req.description,
            duration=req.duration,
            bpm=req.bpm,
            key=req.key,
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
    )


@app.get("/")
async def index():
    idx = FRONTEND_DIR / "index.html"
    return FileResponse(str(idx))
