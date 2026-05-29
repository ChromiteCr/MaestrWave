from pathlib import Path
import os

BASE_DIR = Path(__file__).resolve().parent.parent

# ACE-Step API 地址（与 README 中一致，默认 8001）
ACESTEP_API_URL = os.environ.get("ACESTEP_API_URL", "http://localhost:8001")

# LoKr / LoRA 权重目录：放在这里的 *.pt / *.safetensors / *.ckpt 会被自动列出
LOKR_WEIGHTS_DIR = Path(os.environ.get("LOKR_WEIGHTS_DIR", str(BASE_DIR / "lokr_weights")))

# 默认 LoKr 权重路径（向后兼容；可为不存在的路径 -> 视为"无模型"）
LOKR_WEIGHTS_PATH = os.environ.get("LOKR_WEIGHTS_PATH", str(LOKR_WEIGHTS_DIR / "lokr.pt"))

# 生成音频输出目录
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", str(BASE_DIR / "output" / "sessions")))

# 当 ACE-Step API 调用失败时，是否回退到本地程序化合成（保证演示链路）
ALLOW_SYNTH_FALLBACK = os.environ.get("ALLOW_SYNTH_FALLBACK", "1") not in ("0", "false", "False")

# 支持的 LoKr 权重文件后缀
LOKR_EXTENSIONS = (".pt", ".safetensors", ".ckpt", ".bin")

# 分声部生成的 caption 模板
STEM_PROMPTS = {
    "violin": "Solo violin melody, orchestral, legato, expressive vibrato, {style}",
    "cello": "Cello section, orchestral bass and harmony, rich warm tone, {style}",
    "trumpet": "Brass section with trumpet lead, orchestral fanfare, bold and majestic, {style}",
    "woodwind": "Woodwind ensemble, flute and oboe, light and airy countermelody, {style}",
    "percussion": "Orchestral percussion, timpani and cymbals, rhythmic foundation, {style}",
}


def list_lokr_weights() -> list[dict]:
    """扫描 LOKR_WEIGHTS_DIR，返回所有可用 LoKr 权重的元信息列表。

    返回结构：[{"id": "<filename>", "name": "<filename>", "path": "<abs>"}]
    """
    results: list[dict] = []
    d = LOKR_WEIGHTS_DIR
    if d.exists() and d.is_dir():
        for p in sorted(d.iterdir()):
            if p.is_file() and p.suffix.lower() in LOKR_EXTENSIONS:
                results.append({
                    "id": p.name,
                    "name": p.name,
                    "path": str(p.resolve()),
                    "size_mb": round(p.stat().st_size / (1024 * 1024), 2),
                })
    return results
