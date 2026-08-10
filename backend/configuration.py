"""音乐构型：模版、语言模型调用、校验修复流水线。

「构型」页的后端。产出一份 formation 挂在 project["formation"] 上，「生成」页据此
继承全局属性、自动创建乐器 tab、合成提示词。

三条贯穿的设计原则：

1. **sections 是唯一真源。** 段落存 duration 不存 start/end —— 「无缝、无重叠、并集
   恰好等于全曲时长」这条不变式由结构本身保证，不需要校验器去追。情绪柱状图是它的
   纯函数投影，出声时间段是参与度包络的支撑集，高潮起止时间是 is_climax 段的并集。
   一份事实存两处，用户改一次另一处就错，而且错得很安静。

2. **模版是保底，语言模型是可选加速器。** 没配 key 时整页照常可用：选模版、改段落、
   拖柱子、增删乐器全都不需要网络。模型调用失败/超时/解析不出来，就落地模版结果加
   一条警告 —— 用户永远不会面对一张空白页。

3. **永远不直接信任模型输出。** 时间越界按比例缩放而不是截断（模型很容易按 3 分钟的
   常识去分段却忽略你只有 16 秒，缩放能保住它真正的产出即结构比例，截断会把 outro
   整个切掉）；权重 clamp；participation 长度对齐；乐器名三级映射；高潮不连续则合并。
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Optional

try:
    from .config import INSTRUMENT_LIBRARY, resolve_instrument_key, get_instrument_spec
    from . import llm as llmlib
    from . import project as projectlib
except Exception:
    from config import INSTRUMENT_LIBRARY, resolve_instrument_key, get_instrument_spec
    import llm as llmlib
    import project as projectlib

logger = logging.getLogger(__name__)

FORMATION_SCHEMA_VERSION = 1
ROLES = ("melody", "harmony", "bass", "rhythm")
SECTION_KINDS = ("intro", "build", "main", "bridge", "climax", "breakdown", "outro")
SHAPES = ("flat", "rise", "fall", "arch", "dip")


# ---------------- 模版 ----------------
# 段落存**比例**不存秒数，这样同一个模版能同时服务 16 秒和 4 分钟的曲子。
# 应用时乘以 total_duration 再归一化。

FORMATION_TEMPLATES: dict = {
    "epic_cinematic": {
        "name": "史诗电影配乐",
        "description": "低起、阶梯爬升、高原、缓落。高潮乐器与伴奏乐器分工最典型。",
        "key": "D minor", "bpm": 88, "time_signature": "4/4",
        "ensemble_size": "cinematic", "dynamic_range": "wide",
        "mood_tags": ["庄严", "悲壮", "希望"],
        "global_prompt": "epic cinematic orchestral score, dark and heroic, wide dynamics",
        "sections": [
            {"kind": "intro", "label": "引入", "ratio": 0.15, "intensity": 0.20, "shape": "rise"},
            {"kind": "build", "label": "推进", "ratio": 0.25, "intensity": 0.50, "shape": "rise"},
            {"kind": "climax", "label": "高潮", "ratio": 0.35, "intensity": 0.95, "shape": "arch", "is_climax": True},
            {"kind": "outro", "label": "收束", "ratio": 0.25, "intensity": 0.30, "shape": "fall"},
        ],
        "instruments": [
            {"key": "strings", "role": "melody", "tier": "core", "participation": [0.7, 0.9, 1.0, 0.6]},
            {"key": "cello", "role": "bass", "tier": "core", "participation": [0.6, 0.8, 1.0, 0.5]},
            {"key": "timpani", "role": "rhythm", "tier": "core", "participation": [0.0, 0.5, 1.0, 0.2]},
            {"key": "brass", "role": "harmony", "tier": "climax", "participation": [0.0, 0.2, 1.0, 0.4]},
            {"key": "french_horn", "role": "harmony", "tier": "climax", "participation": [0.0, 0.4, 0.9, 0.3]},
        ],
    },
    "chamber": {
        "name": "室内乐",
        "description": "整体平缓起伏，没有陡峰 —— 不是每首曲子都得有大高潮。",
        "key": "G major", "bpm": 76, "time_signature": "4/4",
        "ensemble_size": "chamber", "dynamic_range": "narrow",
        "mood_tags": ["温暖", "亲密", "流动"],
        "global_prompt": "intimate chamber ensemble, warm and conversational, gentle dynamics",
        "sections": [
            {"kind": "intro", "label": "呈示", "ratio": 0.20, "intensity": 0.35, "shape": "flat"},
            {"kind": "main", "label": "主题", "ratio": 0.35, "intensity": 0.55, "shape": "arch"},
            {"kind": "bridge", "label": "过渡", "ratio": 0.25, "intensity": 0.45, "shape": "dip"},
            {"kind": "outro", "label": "收束", "ratio": 0.20, "intensity": 0.30, "shape": "fall"},
        ],
        "instruments": [
            {"key": "violin", "role": "melody", "tier": "core", "participation": [0.8, 1.0, 0.7, 0.6]},
            {"key": "cello", "role": "bass", "tier": "core", "participation": [0.7, 0.8, 0.8, 0.6]},
            {"key": "clarinet", "role": "harmony", "tier": "core", "participation": [0.5, 0.8, 0.9, 0.4]},
            {"key": "flute", "role": "melody", "tier": "accent", "participation": [0.3, 0.6, 0.5, 0.3]},
        ],
    },
    "march": {
        "name": "进行曲",
        "description": "方块状力度，几乎没有渐变 —— 进行曲的力度是台阶不是斜坡。",
        "key": "Bb major", "bpm": 116, "time_signature": "4/4",
        "ensemble_size": "orchestral", "dynamic_range": "medium",
        "mood_tags": ["昂扬", "整齐", "明亮"],
        "global_prompt": "bright military march, crisp and confident, steady tempo",
        "sections": [
            {"kind": "intro", "label": "起句", "ratio": 0.10, "intensity": 0.60, "shape": "flat"},
            {"kind": "main", "label": "主段", "ratio": 0.35, "intensity": 0.75, "shape": "flat"},
            {"kind": "bridge", "label": "三声中部", "ratio": 0.25, "intensity": 0.45, "shape": "flat"},
            {"kind": "climax", "label": "再现", "ratio": 0.30, "intensity": 0.95, "shape": "flat", "is_climax": True},
        ],
        "instruments": [
            {"key": "trumpet", "role": "melody", "tier": "core", "participation": [1.0, 1.0, 0.4, 1.0]},
            {"key": "trombone", "role": "harmony", "tier": "core", "participation": [0.8, 0.9, 0.5, 1.0]},
            {"key": "woodwind", "role": "harmony", "tier": "core", "participation": [0.6, 0.8, 0.9, 0.8]},
            {"key": "percussion", "role": "rhythm", "tier": "core", "participation": [1.0, 1.0, 0.6, 1.0]},
            {"key": "timpani", "role": "rhythm", "tier": "accent", "participation": [0.5, 0.6, 0.2, 0.9]},
        ],
    },
    "ambient_minimal": {
        "name": "极简氛围",
        "description": "低幅长弧。故意没有打击乐 —— 用来验证 role 覆盖不全只该是提示不是错误。",
        "key": "A minor", "bpm": 60, "time_signature": "4/4",
        "ensemble_size": "chamber", "dynamic_range": "narrow",
        "mood_tags": ["空灵", "静谧", "悬浮"],
        "global_prompt": "minimal ambient orchestral texture, sustained and spacious, very slow evolution",
        "sections": [
            {"kind": "intro", "label": "持续音", "ratio": 0.40, "intensity": 0.20, "shape": "flat"},
            {"kind": "main", "label": "绽放", "ratio": 0.40, "intensity": 0.55, "shape": "arch"},
            {"kind": "outro", "label": "消散", "ratio": 0.20, "intensity": 0.12, "shape": "fall"},
        ],
        "instruments": [
            {"key": "strings", "role": "harmony", "tier": "core", "participation": [0.9, 1.0, 0.6]},
            {"key": "flute", "role": "melody", "tier": "core", "participation": [0.3, 0.8, 0.2]},
            {"key": "cello", "role": "bass", "tier": "core", "participation": [0.7, 0.8, 0.5]},
        ],
    },
    "waltz": {
        "name": "圆舞曲",
        "description": "唯一的三拍子模版，顺带验证柱状图分桶在非 4/4 下工作正常。",
        "key": "A major", "bpm": 168, "time_signature": "3/4",
        "ensemble_size": "orchestral", "dynamic_range": "medium",
        "mood_tags": ["优雅", "旋转", "轻快"],
        "global_prompt": "elegant viennese waltz, lilting three-four feel, graceful",
        "sections": [
            {"kind": "intro", "label": "引子", "ratio": 0.08, "intensity": 0.40, "shape": "rise"},
            {"kind": "main", "label": "圆舞 A", "ratio": 0.32, "intensity": 0.55, "shape": "flat"},
            {"kind": "build", "label": "圆舞 B", "ratio": 0.30, "intensity": 0.70, "shape": "rise"},
            {"kind": "climax", "label": "全奏", "ratio": 0.22, "intensity": 0.88, "shape": "flat", "is_climax": True},
            {"kind": "outro", "label": "收束", "ratio": 0.08, "intensity": 0.35, "shape": "fall"},
        ],
        "instruments": [
            {"key": "violin", "role": "melody", "tier": "core", "participation": [0.8, 1.0, 1.0, 1.0, 0.6]},
            {"key": "cello", "role": "bass", "tier": "core", "participation": [0.7, 0.9, 0.9, 1.0, 0.5]},
            {"key": "clarinet", "role": "harmony", "tier": "core", "participation": [0.4, 0.7, 0.8, 0.9, 0.3]},
            {"key": "percussion", "role": "rhythm", "tier": "accent", "participation": [0.2, 0.5, 0.6, 0.8, 0.2]},
        ],
    },
}


def list_templates() -> list[dict]:
    return [
        {"id": tid, "name": t["name"], "description": t["description"],
         "key": t["key"], "bpm": t["bpm"], "time_signature": t["time_signature"],
         "instrument_count": len(t["instruments"]),
         "has_climax": any(s.get("is_climax") for s in t["sections"])}
        for tid, t in FORMATION_TEMPLATES.items()
    ]


def pick_template(style_description: str, total: float) -> str:
    """没选模版时按关键词挑一个。纯本地，不联网。"""
    s = (style_description or "").lower()
    def has(*words): return any(w in s for w in words)
    if has("氛围", "ambient", "冥想", "静", "空灵"):
        return "ambient_minimal"
    if has("进行曲", "march", "军乐", "昂扬"):
        return "march"
    if has("圆舞", "waltz", "华尔兹"):
        return "waltz"
    if has("史诗", "epic", "电影", "cinematic", "宏大", "壮"):
        return "epic_cinematic"
    # 短曲子撑不起大高潮
    return "chamber" if total < 20 else "epic_cinematic"


def _sid() -> str:
    return str(uuid.uuid4())[:8]


def apply_template(template_id: str, project: dict) -> dict:
    """模版 → 完整 formation。纯本地，没有 key 也能用。"""
    t = FORMATION_TEMPLATES.get(template_id)
    if not t:
        raise ValueError(f"未知模版：{template_id}")
    total = projectlib.total_duration(project)

    sections = []
    for s in t["sections"]:
        sections.append({
            "id": _sid(), "kind": s["kind"], "label": s["label"],
            "duration": round(total * s["ratio"], 2),
            "intensity": s["intensity"], "shape": s.get("shape", "flat"),
            "is_climax": bool(s.get("is_climax")),
        })
    sections = _normalize_durations(sections, total)

    instruments = []
    for i in t["instruments"]:
        spec = get_instrument_spec(i["key"])
        instruments.append({
            "id": _sid(), "library_key": i["key"],
            "display_name": spec["display_name"], "role": i["role"],
            "family": spec.get("family", i["key"]), "tier": i["tier"],
            "prominence": round(sum(i["participation"]) / max(1, len(i["participation"])), 2),
            "participation": list(i["participation"]),
            "instrument_prompt": spec["prompt"].format(style=t["global_prompt"]),
            "resolution": {"matched": "exact", "llm_raw_name": i["key"]},
        })

    formation = {
        "schema_version": FORMATION_SCHEMA_VERSION, "revision": 0,
        "created_by": "template", "source_template_id": template_id,
        "updated_at": projectlib._now(), "dirty": False,
        "global": {
            "total_duration": total, "key": t["key"], "bpm": t["bpm"],
            "time_signature": t["time_signature"],
            "style_description": project.get("style_description") or t["description"],
            "global_prompt": t["global_prompt"], "mood_tags": list(t["mood_tags"]),
            "ensemble_size": t["ensemble_size"], "dynamic_range": t["dynamic_range"],
        },
        "sections": sections, "instruments": instruments, "warnings": [],
    }
    formation["warnings"] = _coverage_warnings(formation)
    return formation


# ---------------- 校验修复流水线 ----------------

def _clamp(v, lo, hi, default):
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return default


def _normalize_durations(sections: list[dict], total: float) -> list[dict]:
    """按比例缩放到恰好等于 total，误差由最后一段吸收。

    用缩放而不是截断：模型写「比例合理的结构」比写「正确的绝对秒数」靠谱得多 ——
    它很容易忽略你只有 16 秒、按 3 分钟的常识去分段。缩放能保住它真正的产出，
    截断会把 outro 整个切掉。
    """
    if not sections:
        return sections
    span = sum(max(0.1, s["duration"]) for s in sections)
    k = total / span if span > 0 else 1.0
    for s in sections:
        s["duration"] = round(max(0.1, s["duration"]) * k, 2)
    drift = round(total - sum(s["duration"] for s in sections), 2)
    sections[-1]["duration"] = round(max(0.1, sections[-1]["duration"] + drift), 2)
    return sections


def _coverage_warnings(formation: dict) -> list[dict]:
    warnings = list(formation.get("warnings") or [])
    present = {i["role"] for i in formation["instruments"]}
    missing = [r for r in ROLES if r not in present]
    if missing:
        names = {"melody": "主旋律", "harmony": "和声", "bass": "低音", "rhythm": "节奏"}
        warnings.append({
            "code": "role_coverage_incomplete",
            "message": (f"没有{'、'.join(names[r] for r in missing)}声部的乐器。"
                        f"指挥时对应方向的动作不会有声部响应 —— 如果这是有意的（比如室内乐"
                        f"本来就没有打击乐），可以忽略。"),
        })
    return warnings


def validate_and_repair(raw: dict, project: dict, *, created_by: str = "llm",
                        template_id: Optional[str] = None) -> dict:
    """把语言模型返回的任意结构修成一份合法 formation。确定性、不再调模型。"""
    total = projectlib.total_duration(project)
    warnings: list[dict] = []

    # ---- 段落 ----
    raw_sections = raw.get("sections") or []
    sections = []
    for s in raw_sections:
        dur = s.get("duration")
        if dur is None and s.get("ratio") is not None:
            dur = _clamp(s["ratio"], 0, 1, 0.25) * total
        sections.append({
            "id": _sid(),
            "kind": s.get("kind") if s.get("kind") in SECTION_KINDS else "main",
            "label": str(s.get("label") or s.get("kind") or "段落")[:20],
            "duration": max(0.1, _clamp(dur, 0.1, total * 4, total / max(1, len(raw_sections)))),
            "intensity": _clamp(s.get("intensity"), 0, 1, 0.5),
            "shape": s.get("shape") if s.get("shape") in SHAPES else "flat",
            "is_climax": bool(s.get("is_climax")),
        })
    if not sections:
        sections = [{"id": _sid(), "kind": "main", "label": "全曲", "duration": total,
                     "intensity": 0.6, "shape": "flat", "is_climax": False}]
        warnings.append({"code": "sections_empty",
                         "message": "模型没有给出段落结构，已按单段落处理。"})

    before = sum(s["duration"] for s in sections)
    sections = _normalize_durations(sections, total)
    if before > 0 and abs(before - total) / total > 0.05:
        warnings.append({
            "code": "duration_rescaled",
            "message": f"模型按 {before:.0f} 秒的结构分段，已按比例缩放到项目的 {total:.0f} 秒。",
        })

    # 高潮必须连续：保留 intensity 最高的那个连续块，其余置 false
    climax_idx = [i for i, s in enumerate(sections) if s["is_climax"]]
    if climax_idx:
        blocks, cur = [], [climax_idx[0]]
        for i in climax_idx[1:]:
            if i == cur[-1] + 1:
                cur.append(i)
            else:
                blocks.append(cur); cur = [i]
        blocks.append(cur)
        if len(blocks) > 1:
            best = max(blocks, key=lambda b: sum(sections[i]["intensity"] for i in b))
            for i in climax_idx:
                sections[i]["is_climax"] = i in best
            warnings.append({"code": "climax_not_contiguous",
                             "message": "模型给的高潮段不连续，已合并为最强的那一段。"})

    # ---- 乐器 ----
    n = len(sections)
    instruments = []
    for inst in (raw.get("instruments") or []):
        raw_name = str(inst.get("library_key") or inst.get("name") or "").strip()
        key, matched = resolve_instrument_key(raw_name)
        spec = get_instrument_spec(key)
        part = inst.get("participation") or []
        part = [_clamp(w, 0, 1, 0.6) for w in part][:n]
        # 长度不足时补满参与而不是补 0 —— 宁可响不可哑
        part += [1.0] * (n - len(part))
        role = inst.get("role") if inst.get("role") in ROLES else spec.get("role", "harmony")
        instruments.append({
            "id": _sid(), "library_key": key,
            "display_name": str(inst.get("display_name") or spec["display_name"])[:20],
            "role": role, "family": spec.get("family", key),
            "tier": inst.get("tier") if inst.get("tier") in ("core", "climax", "accent") else "core",
            "prominence": round(sum(part) / max(1, len(part)), 2),
            "participation": part,
            "instrument_prompt": str(inst.get("instrument_prompt") or
                                     spec["prompt"].format(style=raw.get("global_prompt") or "")),
            "resolution": {"matched": matched, "llm_raw_name": raw_name},
        })
        if matched == "custom" and raw_name:
            warnings.append({
                "code": "instrument_unmatched",
                "message": f"「{raw_name}」不在乐器库里，已按自定义乐器处理（音色描述仍会带上它的名字）。",
            })

    if not instruments:
        tid = template_id or pick_template(project.get("style_description", ""), total)
        fallback = apply_template(tid, project)
        instruments = fallback["instruments"]
        # 参与度按新的段落数对齐
        for i in instruments:
            p = i["participation"][:n]
            p += [1.0] * (n - len(p))
            i["participation"] = p
        warnings.append({"code": "instruments_empty",
                         "message": f"模型没有给出乐器编配，已套用「{FORMATION_TEMPLATES[tid]['name']}」模版的编制。"})

    g = raw.get("global") or raw
    formation = {
        "schema_version": FORMATION_SCHEMA_VERSION, "revision": 0,
        "created_by": created_by, "source_template_id": template_id,
        "updated_at": projectlib._now(), "dirty": False,
        "global": {
            "total_duration": total,
            "key": str(g.get("key") or project.get("key") or "D major"),
            "bpm": int(_clamp(g.get("bpm") or project.get("bpm") or 80, 40, 220, 80)),
            "time_signature": str(g.get("time_signature") or project.get("time_signature") or "4/4"),
            "style_description": str(g.get("style_description") or project.get("style_description") or ""),
            "global_prompt": str(g.get("global_prompt") or g.get("style_description") or ""),
            "mood_tags": [str(m)[:12] for m in (g.get("mood_tags") or [])][:6],
            "ensemble_size": g.get("ensemble_size") if g.get("ensemble_size") in
                             ("solo", "chamber", "orchestral", "cinematic") else "orchestral",
            "dynamic_range": g.get("dynamic_range") if g.get("dynamic_range") in
                             ("narrow", "medium", "wide") else "medium",
        },
        "sections": sections, "instruments": instruments, "warnings": warnings,
    }
    formation["warnings"] = _coverage_warnings(formation)
    return formation


# ---------------- 语言模型调用 ----------------

_SYSTEM = """你是一位管弦乐编配助手。用户会描述他想要的乐曲，你负责把它翻译成一份结构化的「音乐构型」。

只输出一个 JSON 对象，不要有任何解释文字或 markdown 围栏。结构如下：

{
  "global": {
    "key": "调性，如 D minor",
    "bpm": 整数 40-220,
    "time_signature": "拍号，如 4/4",
    "global_prompt": "英文，一句话概括整首曲子的风格与情绪，会作为所有乐器提示词的公共部分",
    "mood_tags": ["中文情绪词，2-4个"],
    "ensemble_size": "solo|chamber|orchestral|cinematic",
    "dynamic_range": "narrow|medium|wide"
  },
  "sections": [
    {
      "kind": "intro|build|main|bridge|climax|breakdown|outro",
      "label": "中文段落名，如「铜管齐奏」",
      "ratio": 该段占全曲的比例，所有段落的 ratio 相加应为 1.0,
      "intensity": 0.0-1.0 的情绪强度,
      "shape": "flat|rise|fall|arch|dip",
      "is_climax": 是否属于高潮（高潮段必须连续）
    }
  ],
  "instruments": [
    {
      "library_key": "乐器标识",
      "display_name": "中文乐器名",
      "role": "melody|harmony|bass|rhythm",
      "tier": "core|climax|accent",
      "participation": [每个段落的参与权重 0.0-1.0，数组长度必须等于 sections 的长度],
      "instrument_prompt": "英文，这件乐器的音色与演奏方式描述"
    }
  ]
}

要点：
- 段落用 ratio（比例）而不是秒数，曲子多长由系统决定。
- participation 是这件乐器在每个段落的音量占比，0 表示该段不出声。「只在高潮出现的
  铜管」就是前几段填 0、高潮段填 1。
- 四个 role 尽量各有至少一件乐器，否则指挥时会有整个方向的动作没有声音回应。
  但如果曲种本来就不需要（如室内乐没有打击乐），可以缺。
- 可用的乐器标识：%s。也可以用这个列表以外的乐器名（写英文小写），系统会按自定义乐器处理。
""" % "、".join(INSTRUMENT_LIBRARY.keys())


def _skeleton_prompt(project: dict, skeleton: dict, baseline: dict) -> str:
    total = projectlib.total_duration(project)
    return (
        f"曲子总时长 {total:.0f} 秒。\n"
        f"风格描述：{skeleton.get('style_description') or project.get('style_description') or '（未填）'}\n"
        f"情绪关键词：{'、'.join(skeleton.get('mood_tags') or []) or '（未填）'}\n"
        f"编制规模：{skeleton.get('ensemble_size') or '（未指定）'}\n"
        f"高潮位置倾向：{skeleton.get('climax_hint') or '（未指定）'}\n\n"
        f"下面是一份可用的基线构型，请在它的基础上按上面的描述调整，而不是从零构建：\n"
        f"{json.dumps(baseline, ensure_ascii=False)}"
    )


async def generate_formation(project: dict, skeleton: dict) -> dict:
    """骨架 → 一次成型。模型失败时落地模版结果，绝不返回空。"""
    total = projectlib.total_duration(project)
    tid = skeleton.get("template_id") or pick_template(
        skeleton.get("style_description") or project.get("style_description", ""), total)
    baseline = apply_template(tid, project)

    try:
        raw = await llmlib.chat_json(_SYSTEM, _skeleton_prompt(project, skeleton, {
            "global": baseline["global"],
            "sections": [{k: s[k] for k in ("kind", "label", "intensity", "shape", "is_climax")}
                         for s in baseline["sections"]],
            "instruments": [{"library_key": i["library_key"], "role": i["role"],
                             "tier": i["tier"], "participation": i["participation"]}
                            for i in baseline["instruments"]],
        }))
    except llmlib.LLMError as e:
        logger.warning("构型生成失败，落地模版：%s", e)
        baseline["warnings"].append({
            "code": "llm_unavailable",
            "message": f"语言模型没能用上（{e}），已套用「{FORMATION_TEMPLATES[tid]['name']}」模版。"
                       f"你可以直接在这个基础上手工调整。",
        })
        return baseline

    return validate_and_repair(raw, project, created_by="llm", template_id=tid)


async def refine_formation(project: dict, formation: dict, instruction: str,
                            scope: Optional[str] = None) -> dict:
    """局部重问：单次无状态改写。

    每次调用都把当前完整构型送进去、返回新构型，**没有对话历史** —— 有历史就有双真源：
    用户在柱状图上拖过、删过乐器，历史里没有这件事，下一轮模型基于旧上下文回答会
    无声覆盖用户的修改。

    scope 之外的字段由服务端强制用旧值覆盖回去，防止「我只想改高潮，它把调性也改了」。
    """
    user = (
        f"这是当前的构型：\n{json.dumps({k: formation[k] for k in ('global','sections','instruments')}, ensure_ascii=False)}\n\n"
        f"请按下面的要求修改后，输出完整的新构型 JSON：\n{instruction}\n"
    )
    if scope and scope.startswith("section:"):
        sid = scope.split(":", 1)[1]
        target = next((s for s in formation["sections"] if s["id"] == sid), None)
        if target:
            user += f"\n只修改「{target['label']}」这一段相关的内容，其余段落与全局属性保持不变。"

    raw = await llmlib.chat_json(_SYSTEM, user)
    new = validate_and_repair(raw, project, created_by="llm",
                              template_id=formation.get("source_template_id"))

    # 服务端强制合并：scope 之外一律用旧值
    if scope and scope.startswith("section:"):
        sid = scope.split(":", 1)[1]
        new["global"] = formation["global"]
        old_by_id = {s["id"]: s for s in formation["sections"]}
        if sid in old_by_id and len(new["sections"]) == len(formation["sections"]):
            merged = []
            for old, fresh in zip(formation["sections"], new["sections"]):
                merged.append(fresh if old["id"] == sid else old)
            new["sections"] = merged
    new["revision"] = formation.get("revision", 0)
    new["dirty"] = formation.get("dirty", False)
    return new
