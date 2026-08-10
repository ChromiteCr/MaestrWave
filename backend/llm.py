"""BYOK 语言模型接入：用户自带 key，用来生成音乐构型的结构化数据。

只做 **OpenAI 兼容层 + 自定义 base_url** 这一条路径。查证结果：DeepSeek、智谱、
Kimi、OpenRouter、Ollama、OpenAI 本身都有官方兼容端点，换 base_url 即用，覆盖八成
以上常见 provider。Anthropic 的兼容层官方自称「仅测试、非生产可用」，response_format
和 tools.strict 都会被忽略 —— 用 Claude 时拿不到严格 JSON 保证，只能靠提示词内嵌
schema + 校验重试兜底，这是已知取舍。

与 backend/generator.py、backend/tme_backend.py 一致，用 httpx 手写请求而不是引入
openai SDK：整个链路只有一个 POST /chat/completions，而仓库的依赖一直保持在四行
（fastapi/uvicorn/httpx/aiofiles），为一个端点引入一整套 SDK 不划算。

安全要点（都不是可选项）：
  - key 只存后端。这个项目有 cloudflared 隧道会把服务暴露到公网，前端代码和
    localStorage 对拿到链接的人都是可读的，存前端等于直接泄露。
  - 配置文件权限 0600，且必须在 .gitignore 里。
  - 任何接口都不回显明文 key，只回 has_key 与掩码。
  - base_url 做**严格主机匹配**，不是子串包含。NextChat 2026-06 的漏洞就是转发时
    对目标 host 用子串匹配，攻击者伪造 URL 就能把后端保存的 key 转发到自己服务器。
  - 隧道开着时 LLM 接口要求令牌（隧道没开就不要求，本机使用零摩擦）。
"""
from __future__ import annotations

import json
import logging
import os
import re
import secrets
import stat
import time
from collections import deque
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx

try:
    from .config import LLM_CONFIG_PATH
except Exception:
    from config import LLM_CONFIG_PATH

logger = logging.getLogger(__name__)

# ---- base_url 主机白名单 ----
# 精确主机名匹配（大小写不敏感），不做任何子串/前缀判断。
ALLOWED_HOSTS = {
    "api.openai.com",
    "api.deepseek.com",
    "open.bigmodel.cn",
    "api.moonshot.cn",
    "api.moonshot.ai",
    "openrouter.ai",
    "dashscope.aliyuncs.com",
    "api.siliconflow.cn",
    "generativelanguage.googleapis.com",
    "api.anthropic.com",
}
# 本机模型（Ollama / LM Studio / vLLM）
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}

REQUEST_TIMEOUT = 90.0
MAX_JSON_RETRIES = 2

# ---- 限流 ----
RATE_PER_MINUTE = 10
RATE_PER_DAY = 200
_calls: deque[float] = deque()


class LLMError(RuntimeError):
    """对外可见的错误。消息里绝不能带 key。"""


# ---------------- 配置读写 ----------------

def _default_config() -> dict:
    return {
        "base_url": "",
        "model": "",
        "api_key": "",
        # 隧道开着时访问 LLM 接口需要的令牌，首次保存配置时自动生成。
        "access_token": secrets.token_urlsafe(24),
        "extra_allowed_hosts": [],
    }


def load_config() -> dict:
    p = Path(LLM_CONFIG_PATH)
    if not p.exists():
        return _default_config()
    try:
        cfg = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning("LLM 配置读取失败（%s），按未配置处理", type(e).__name__)
        return _default_config()
    merged = _default_config()
    merged.update({k: v for k, v in cfg.items() if k in merged})
    return merged


def save_config(**fields) -> dict:
    """只更新传进来的字段。api_key 传空字符串表示「不改」，传 None 表示「清除」。"""
    cfg = load_config()
    for k in ("base_url", "model"):
        if fields.get(k) is not None:
            cfg[k] = str(fields[k]).strip()
    if "api_key" in fields:
        v = fields["api_key"]
        if v is None:
            cfg["api_key"] = ""
        elif str(v).strip():
            cfg["api_key"] = str(v).strip()
        # 空字符串 = 保持原值不动，这样前端可以只改 base_url 而不必重填 key
    if fields.get("extra_allowed_hosts") is not None:
        cfg["extra_allowed_hosts"] = [str(h).strip().lower() for h in fields["extra_allowed_hosts"]]

    p = Path(LLM_CONFIG_PATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)  # 0600
    except OSError as e:
        logger.warning("无法设置 LLM 配置文件权限：%s", e)
    return cfg


def _mask(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "*" * len(key)
    return f"{key[:4]}{'*' * 6}{key[-4:]}"


def public_status() -> dict:
    """给「设置」页看的状态。**绝不包含明文 key。**"""
    cfg = load_config()
    host_ok, host_reason = (True, "") if not cfg["base_url"] else _check_host(cfg["base_url"])
    return {
        "has_key": bool(cfg["api_key"]),
        "key_masked": _mask(cfg["api_key"]),
        "base_url": cfg["base_url"],
        "model": cfg["model"],
        "host_allowed": host_ok,
        "host_reason": host_reason,
        "ready": bool(cfg["api_key"] and cfg["base_url"] and cfg["model"] and host_ok),
        "allowed_hosts": sorted(ALLOWED_HOSTS | set(cfg.get("extra_allowed_hosts") or [])),
    }


# ---------------- 安全校验 ----------------

def _check_host(base_url: str) -> tuple[bool, str]:
    """严格主机名匹配。绝不用 `in` / startswith 之类的子串判断。"""
    try:
        parsed = urlparse(base_url if "://" in base_url else f"https://{base_url}")
    except Exception:
        return False, "base_url 解析失败"
    host = (parsed.hostname or "").lower()
    if not host:
        return False, "base_url 里没有主机名"
    if parsed.scheme not in ("http", "https"):
        return False, f"不支持的协议：{parsed.scheme}"
    if host in LOCAL_HOSTS:
        return True, ""
    extra = {h.lower() for h in (load_config().get("extra_allowed_hosts") or [])}
    if host in ALLOWED_HOSTS or host in extra:
        return True, ""
    return False, (
        f"主机 {host} 不在白名单里。若确实要用，请把它加进 LLM 配置的 "
        f"extra_allowed_hosts（需要手工编辑配置文件，不能通过接口添加）。"
    )


def check_access(tunnel_running: bool, token: Optional[str]) -> None:
    """隧道开着时要求令牌。隧道没开说明只有本机能访问，不设门槛。"""
    if not tunnel_running:
        return
    expected = load_config().get("access_token") or ""
    if not token or not secrets.compare_digest(str(token), expected):
        raise LLMError(
            "隧道正在运行，调用语言模型需要本机令牌。令牌在后端启动日志里，"
            "或在「设置」页查看后填入。"
        )


def _check_rate_limit() -> None:
    now = time.time()
    while _calls and now - _calls[0] > 86400:
        _calls.popleft()
    if sum(1 for t in _calls if now - t < 60) >= RATE_PER_MINUTE:
        raise LLMError(f"调用过于频繁（每分钟上限 {RATE_PER_MINUTE} 次），请稍后再试。")
    if len(_calls) >= RATE_PER_DAY:
        raise LLMError(f"今日调用已达上限（{RATE_PER_DAY} 次）。")
    _calls.append(now)


def _scrub(text: str, key: str) -> str:
    """兜底：万一 provider 把 key 回显在错误消息里，不要让它进日志或响应。"""
    if key and key in text:
        text = text.replace(key, "***")
    return text


# ---------------- 调用 ----------------

def _extract_json(text: str) -> dict:
    """从模型输出里抠出 JSON。兼容 ```json 围栏和前后多余的说明文字。"""
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        return json.loads(text[start:end + 1])
    raise ValueError("模型输出里找不到 JSON")


def _prepare_call() -> tuple[dict, str]:
    """校验配置 + 限流 + 拼出 chat/completions 地址。

    每条 LLM 通路都必须走这里，尤其是 `_check_host` 和 `_check_rate_limit`：
    绕过前者等于把用户的 key 发给任意主机，绕过后者等于给白嫖开一扇窗。
    """
    cfg = load_config()
    if not cfg["api_key"]:
        raise LLMError("还没有配置语言模型的 API key。")
    if not cfg["base_url"] or not cfg["model"]:
        raise LLMError("还没有配置 base_url 或模型名。")
    ok, reason = _check_host(cfg["base_url"])
    if not ok:
        raise LLMError(reason)
    _check_rate_limit()

    url = cfg["base_url"].rstrip("/")
    if not url.endswith("/chat/completions"):
        url = f"{url}/chat/completions"
    return cfg, url


async def chat_text(messages: list[dict], *, temperature: float = 0.4,
                    max_tokens: int = 900) -> str:
    """自由对话，返回纯文本。Agent 侧栏用。

    和 `chat_json` 的区别不只是要不要 JSON：这里**不做重试**。对话失败让用户自己
    再问一次就行，而构型那边失败会导致落盘一个半残结构，才值得自动重试。
    """
    cfg, url = _prepare_call()

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        try:
            resp = await client.post(
                url,
                json={
                    "model": cfg["model"],
                    "messages": messages,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                },
                headers={"Authorization": f"Bearer {cfg['api_key']}",
                         "Content-Type": "application/json"},
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            return (content or "").strip()
        except httpx.HTTPStatusError as e:
            body = _scrub(e.response.text[:300], cfg["api_key"])
            code = e.response.status_code
            if code in (401, 403):
                raise LLMError(f"鉴权失败，请检查 API key。（HTTP {code}）") from None
            if code == 404:
                raise LLMError(f"接口不存在，请检查 base_url 与模型名。（HTTP {code}）") from None
            raise LLMError(f"语言模型返回 HTTP {code}：{body}") from None
        except httpx.RequestError as e:
            raise LLMError(f"连不上语言模型：{type(e).__name__}: {e}") from None
        except (ValueError, KeyError, json.JSONDecodeError) as e:
            raise LLMError(f"语言模型返回的内容无法解析：{type(e).__name__}: {e}") from None


async def chat_json(system: str, user: str, *, temperature: float = 0.35) -> dict:
    """要一段 JSON 回来。失败重试至多 MAX_JSON_RETRIES 次，仍失败就明确报错。

    绝不「猜测拼接」—— 构型数据会直接决定生成什么音乐，宁可报错让用户重试，
    也不要把一个半残的结构悄悄落盘。
    """
    cfg, url = _prepare_call()

    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    last_err = ""

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        for attempt in range(MAX_JSON_RETRIES + 1):
            payload = {
                "model": cfg["model"],
                "messages": messages,
                "temperature": temperature,
                # 兼容层对 response_format 的支持面不一（DeepSeek 只有 json_object、
                # 部分 provider 完全忽略），所以 400 时会去掉它重来一次，见下。
                "response_format": {"type": "json_object"},
            }
            try:
                resp = await client.post(
                    url, json=payload,
                    headers={"Authorization": f"Bearer {cfg['api_key']}",
                             "Content-Type": "application/json"},
                )
                if resp.status_code == 400 and "response_format" in resp.text:
                    payload.pop("response_format")
                    resp = await client.post(
                        url, json=payload,
                        headers={"Authorization": f"Bearer {cfg['api_key']}",
                                 "Content-Type": "application/json"},
                    )
                resp.raise_for_status()
                content = resp.json()["choices"][0]["message"]["content"]
                return _extract_json(content)
            except httpx.HTTPStatusError as e:
                body = _scrub(e.response.text[:300], cfg["api_key"])
                last_err = f"HTTP {e.response.status_code}: {body}"
                logger.warning("LLM 调用失败（第 %d 次）：%s", attempt + 1, last_err)
                if e.response.status_code in (401, 403):
                    raise LLMError(f"鉴权失败，请检查 API key。（{last_err}）") from None
                if e.response.status_code == 404:
                    raise LLMError(f"接口不存在，请检查 base_url 与模型名。（{last_err}）") from None
            except (ValueError, KeyError, json.JSONDecodeError) as e:
                last_err = f"{type(e).__name__}: {e}"
                logger.warning("LLM 输出解析失败（第 %d 次）：%s", attempt + 1, last_err)
                # 把错误回填进对话，让模型知道上次哪里不对
                messages.append({"role": "user", "content":
                                 f"上次的回复无法解析为 JSON（{e}）。请只输出一个 JSON 对象，"
                                 f"不要有任何解释文字或 markdown 围栏。"})
            except httpx.RequestError as e:
                last_err = f"{type(e).__name__}: {e}"
                logger.warning("LLM 网络错误（第 %d 次）：%s", attempt + 1, last_err)

    raise LLMError(f"语言模型调用失败（已重试 {MAX_JSON_RETRIES} 次）：{last_err}")
