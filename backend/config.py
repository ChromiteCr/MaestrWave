from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

ACESTEP_API_URL = "http://localhost:8001"
# 修改为你的 LoKr 权重实际路径
LOKR_WEIGHTS_PATH = str(BASE_DIR / "lokr_weights" / "lokr.pt")
# 后端静态音频输出目录
OUTPUT_DIR = str(BASE_DIR / "output" / "sessions")

# 分声部生成的 caption 模板
STEM_PROMPTS = {
    "violin": "Solo violin melody, orchestral, legato, expressive vibrato, {style}",
    "cello": "Cello section, orchestral bass and harmony, rich warm tone, {style}",
    "trumpet": "Brass section with trumpet lead, orchestral fanfare, bold and majestic, {style}",
    "woodwind": "Woodwind ensemble, flute and oboe, light and airy countermelody, {style}",
    "percussion": "Orchestral percussion, timpani and cymbals, rhythmic foundation, {style}",
}
