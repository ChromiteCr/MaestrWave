"""
从「输出」页一键启停 cloudflared 隧道（M4）。

为什么放在后端：cloudflared 是个要长期驻留的子进程，浏览器起不了进程，
所以由 FastAPI 代管——用户点一下按钮，后端 spawn 它、从输出里抓出随机分配的
公网域名回传给前端，前端直接拿去生成二维码，省掉"另开一个终端"这一步。

安全上的取舍：启动隧道 = 把本机 dev server 暴露到公网，所以这里**绝不自动启动**，
必须由用户在 UI 上显式点击；同时提供停止按钮，并在后端退出时兜底关掉，
避免隧道在用户不知情的情况下一直开着。
"""

import asyncio
import logging
import re
import shutil
from typing import Optional

logger = logging.getLogger(__name__)

# cloudflared 会把分配到的域名打印在一个 ASCII 方框里，形如
#   |  https://xxx-yyy-zzz.trycloudflare.com   |
TUNNEL_URL_RE = re.compile(r"https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com")

# 输出里保留最近这么多行，失败时回传给前端好排查。
LOG_TAIL_LINES = 40


class TunnelManager:
    def __init__(self) -> None:
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._url: Optional[str] = None
        self._error: Optional[str] = None
        self._port: Optional[int] = None
        self._log: list[str] = []
        self._reader: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    # ---------- 查询 ----------

    @staticmethod
    def binary_available() -> bool:
        return shutil.which("cloudflared") is not None

    def status(self) -> dict:
        running = self._proc is not None and self._proc.returncode is None
        return {
            "available": self.binary_available(),
            "running": running,
            "url": self._url,
            "port": self._port,
            "error": self._error,
            "log_tail": self._log[-LOG_TAIL_LINES:],
        }

    # ---------- 启停 ----------

    async def start(self, port: int) -> dict:
        if not (1 <= port <= 65535):
            return {**self.status(), "error": f"端口不合法：{port}"}

        async with self._lock:
            if self._proc is not None and self._proc.returncode is None:
                # 已经在跑了，直接返回现状（端口不同也不重启，避免误杀正在用的隧道）
                return self.status()

            if not self.binary_available():
                self._error = "没找到 cloudflared。安装：brew install cloudflared"
                return self.status()

            self._url = None
            self._error = None
            self._port = port
            self._log = []

            try:
                self._proc = await asyncio.create_subprocess_exec(
                    "cloudflared", "tunnel", "--url", f"http://localhost:{port}",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
            except OSError as e:
                self._error = f"启动 cloudflared 失败：{e}"
                self._proc = None
                return self.status()

            self._reader = asyncio.create_task(self._read_output())
            logger.info("tunnel: 已启动 cloudflared -> localhost:%s", port)
            # 域名要等几秒才会出现，前端轮询 status 拿结果。
            return self.status()

    async def _read_output(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        try:
            async for raw in proc.stdout:
                line = raw.decode("utf-8", errors="replace").rstrip()
                if not line:
                    continue
                self._log.append(line)
                if self._url is None:
                    match = TUNNEL_URL_RE.search(line)
                    if match:
                        self._url = match.group(0)
                        logger.info("tunnel: domain=%s", self._url)
        except Exception:
            logger.exception("tunnel: 读取输出异常")
        finally:
            code = await proc.wait()
            if self._url is None and self._error is None:
                # 没拿到域名就退出了，把尾部日志交给前端，比一句"失败了"有用
                self._error = f"cloudflared 退出（code={code}），没拿到隧道域名。"
            logger.info("tunnel: cloudflared 已退出 code=%s", code)

    async def stop(self) -> dict:
        async with self._lock:
            proc = self._proc
            if proc is None or proc.returncode is not None:
                self._proc = None
                self._url = None
                return self.status()

            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()

            self._proc = None
            self._url = None
            self._error = None
            logger.info("tunnel: 已停止")
            return self.status()


manager = TunnelManager()
