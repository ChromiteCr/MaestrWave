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

# BYOK 语言模型配置（base_url / model / api_key / 访问令牌）。
# 里面有明文 API key，所以：文件权限 0600、必须在 .gitignore 里、任何接口都不回显。
LLM_CONFIG_PATH = Path(os.environ.get(
    "LLM_CONFIG_PATH", str(BASE_DIR / ".secrets" / "llm.json")))

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


# 语言模型给的乐器名 → INSTRUMENT_LIBRARY 的 key。
# 放在这里而不是各写一份，是为了前后端只有一个真源。
# 注意「中提琴」这类库里没有的乐器**不要**映射到 strings —— 那样 prompt 会退化成
# 通用的 "String section, orchestral, legato"，音色特征全丢。让它走 get_instrument_spec
# 的 fallback，用归一化后的英文名拼出专属 prompt，名字就保住了。
INSTRUMENT_ALIASES = {
    # 弦乐
    "violins": "violin", "vln": "violin", "第一小提琴": "violin", "小提琴组": "violin",
    "violoncello": "cello", "vc": "cello", "大提琴组": "cello",
    "string section": "strings", "string": "strings", "弦乐组": "strings", "弦乐器": "strings",
    # 铜管
    "horn": "french_horn", "horns": "french_horn", "french horns": "french_horn",
    "法国号": "french_horn", "圆号组": "french_horn",
    "trumpets": "trumpet", "tpt": "trumpet", "小号组": "trumpet",
    "trombones": "trombone", "tbn": "trombone", "长号组": "trombone",
    "brass section": "brass", "铜管组": "brass", "铜管乐器": "brass",
    # 木管
    "flutes": "flute", "长笛组": "flute",
    "oboes": "oboe", "双簧管组": "oboe",
    "clarinets": "clarinet", "单簧管组": "clarinet", "黑管": "clarinet",
    "woodwinds": "woodwind", "woodwind section": "woodwind", "木管组": "woodwind",
    # 打击
    "timpani drums": "timpani", "定音鼓组": "timpani",
    "drums": "percussion", "drum kit": "percussion", "percussions": "percussion",
    "打击乐器": "percussion", "鼓组": "percussion",
}


# 库里没有、但语言模型很可能提到的乐器：中文名 → 英文名。
# 必须翻成英文才有意义 —— 自定义乐器的 prompt 是 f"{key}, orchestral, ..."，
# 直接把中文塞进去，音乐模型（主要在英文 tag 上训练）大概率会忽略它，
# 等于这件乐器的音色信息整个丢了。
CUSTOM_NAME_TRANSLATIONS = {
    "中提琴": "viola", "低音提琴": "double bass", "倍大提琴": "double bass",
    "竖琴": "harp", "钢琴": "piano", "管风琴": "pipe organ", "钢片琴": "celesta",
    "大管": "bassoon", "巴松": "bassoon", "短笛": "piccolo", "英国管": "english horn",
    "萨克斯": "saxophone", "萨克斯风": "saxophone", "大号": "tuba", "低音号": "tuba",
    "军鼓": "snare drum", "大鼓": "bass drum", "钹": "cymbals", "三角铁": "triangle",
    "木琴": "xylophone", "马林巴": "marimba", "钟琴": "glockenspiel", "管钟": "tubular bells",
    "吉他": "guitar", "人声": "choir", "合唱": "choir", "女高音": "soprano",
}


def resolve_instrument_key(raw_name: str) -> tuple[str, str]:
    """乐器名 → (library_key, matched)。matched ∈ exact/alias/custom。

    三级映射：库里直接命中 → 查别名表 → 归一化成英文名走自定义 fallback。
    """
    if not raw_name:
        return "harmony", "custom"
    norm = str(raw_name).strip().lower()
    if norm in INSTRUMENT_LIBRARY:
        return norm, "exact"
    underscored = norm.replace(" ", "_").replace("-", "_")
    if underscored in INSTRUMENT_LIBRARY:
        return underscored, "exact"
    # 库里每件乐器的中文 display_name 也算精确命中 —— 语言模型被要求用中文写
    # display_name，很自然会直接把「小提琴」当标识给回来。
    raw = str(raw_name).strip()
    for k, spec in INSTRUMENT_LIBRARY.items():
        if spec["display_name"] == raw:
            return k, "exact"
    if norm in INSTRUMENT_ALIASES:
        return INSTRUMENT_ALIASES[norm], "alias"
    if underscored in INSTRUMENT_ALIASES:
        return INSTRUMENT_ALIASES[underscored], "alias"
    # 自定义：中文先翻成英文，否则 prompt 里的中文 token 会被音乐模型忽略
    translated = CUSTOM_NAME_TRANSLATIONS.get(str(raw_name).strip())
    if translated:
        return translated, "custom"
    return underscored or "custom", "custom"


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
