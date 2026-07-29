from pathlib import Path
import os

BASE_DIR = Path(__file__).resolve().parent.parent

# ACE-Step API 地址（与 README 中一致，默认 8001）
ACESTEP_API_URL = os.environ.get("ACESTEP_API_URL", "http://localhost:8001")

# 生成后端选择：
#   local —— 本机/局域网跑着的 ACE-Step（默认）
#   cloud —— 未来租用的带显卡服务器（预留）
#   tme   —— 腾讯音乐天琴 API，纯云端不吃本机显存（见 backend/tme_backend.py）
# 见 backend/generation_backend.py 里的 GenerationBackend 抽象。
GENERATION_BACKEND = os.environ.get("GENERATION_BACKEND", "local")

# 云端后端预留配置：现在多半还未使用，等以后接入真实云端 ACE-Step 服务再填。
CLOUD_ACESTEP_API_URL = os.environ.get("CLOUD_ACESTEP_API_URL", "")
CLOUD_ACESTEP_API_KEY = os.environ.get("CLOUD_ACESTEP_API_KEY", "")

# ---- 腾讯音乐天琴（TME）API ----
# APP_KEY 是密钥，只从环境变量读，不写进仓库。设置方式见 README「用云端 API 生成」。
TME_API_URL = os.environ.get(
    "TME_API_URL",
    "https://test.y.qq.com/opentest/rpc_proxy/fcgi-bin/music_open_api.fcg",
)
TME_APP_ID = os.environ.get("TME_APP_ID", "")
TME_APP_KEY = os.environ.get("TME_APP_KEY", "")
# 单次生成的轮询上限（秒）。天琴做一首歌通常一两分钟，留足余量。
TME_POLL_TIMEOUT = int(os.environ.get("TME_POLL_TIMEOUT", "300"))
TME_POLL_INTERVAL = float(os.environ.get("TME_POLL_INTERVAL", "5"))

# 项目（project）数据存放目录，替代旧的固定 5 声部 session 模型。
PROJECTS_DIR = Path(os.environ.get("PROJECTS_DIR", str(BASE_DIR / "output" / "projects")))

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

# 分声部生成的 caption 模板（旧的固定 5 声部 session 流程仍在用，见 stems.py）
STEM_PROMPTS = {
    "violin": "Solo violin melody, orchestral, legato, expressive vibrato, {style}",
    "cello": "Cello section, orchestral bass and harmony, rich warm tone, {style}",
    "trumpet": "Brass section with trumpet lead, orchestral fanfare, bold and majestic, {style}",
    "woodwind": "Woodwind ensemble, flute and oboe, light and airy countermelody, {style}",
    "percussion": "Orchestral percussion, timpani and cymbals, rhythmic foundation, {style}",
}

# 新的「生成」页乐器目录：既有笼统分类（铜管/木管/打击乐/弦乐，"生成"页初始三个
# tab 就是从这里取的），也有具体乐器（长号/双簧管...），用户可以任选其一新增
# 乐器 tab。role 用于 project_gen.py 决定 lego prompt 怎么描述"这个新声部相对
# 于已有声部要扮演什么角色"（melody / harmony / bass / rhythm）。
INSTRUMENT_LIBRARY = {
    "brass": {"display_name": "铜管", "role": "harmony",
              "prompt": "Brass section, warm and cohesive ensemble blend, {style}"},
    "woodwind": {"display_name": "木管", "role": "harmony",
                 "prompt": "Woodwind ensemble, flute and oboe, light and airy countermelody, {style}"},
    "percussion": {"display_name": "打击乐", "role": "rhythm",
                   "prompt": "Orchestral percussion, timpani and cymbals, rhythmic foundation, {style}"},
    "strings": {"display_name": "弦乐", "role": "melody",
                "prompt": "String section, orchestral, legato, expressive, {style}"},
    "violin": {"display_name": "小提琴", "family": "strings", "role": "melody",
               "prompt": "Solo violin melody, orchestral, legato, expressive vibrato, {style}"},
    "cello": {"display_name": "大提琴", "family": "strings", "role": "bass",
              "prompt": "Cello section, orchestral bass and harmony, rich warm tone, {style}"},
    "trumpet": {"display_name": "小号", "family": "brass", "role": "melody",
                "prompt": "Solo trumpet, orchestral fanfare, bold and majestic lead line, {style}"},
    "trombone": {"display_name": "长号", "family": "brass", "role": "harmony",
                 "prompt": "Trombone section, warm brass harmony beneath the melody, {style}"},
    "french_horn": {"display_name": "圆号", "family": "brass", "role": "harmony",
                     "prompt": "French horn, mellow sustained brass harmony, {style}"},
    "oboe": {"display_name": "双簧管", "family": "woodwind", "role": "melody",
             "prompt": "Solo oboe, expressive countermelody, {style}"},
    "flute": {"display_name": "长笛", "family": "woodwind", "role": "melody",
              "prompt": "Solo flute, light airy melodic line, {style}"},
    "clarinet": {"display_name": "单簧管", "family": "woodwind", "role": "harmony",
                 "prompt": "Clarinet, smooth legato harmony line, {style}"},
    "timpani": {"display_name": "定音鼓", "family": "percussion", "role": "rhythm",
                "prompt": "Timpani, orchestral rhythmic punctuation and low-end impact, {style}"},
}

# 「生成」页初始展示的三个 tab
DEFAULT_INSTRUMENTS = ["brass", "woodwind", "percussion"]


def get_instrument_spec(key: str) -> dict:
    """按 key 查 INSTRUMENT_LIBRARY；查不到时（用户填了完全自定义的乐器名）
    退化成一个通用模板，role 默认 harmony。"""
    spec = INSTRUMENT_LIBRARY.get(key)
    if spec:
        return spec
    return {
        "display_name": key,
        "role": "harmony",
        "prompt": f"{key}, orchestral, blending naturally with the rest of the ensemble, " + "{style}",
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
