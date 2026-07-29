"""
局域网地址探测（M4）。

「输出」页在电脑模式下要生成一个手机能扫的二维码，二维码里必须是
局域网可达的地址。浏览器自己拿不到本机的局域网 IP（页面地址可能是
localhost），所以由后端探测后通过 /api/network-info 告诉前端。

前端只取 host 部分，协议和端口沿用它自己的 window.location——
因为开发模式下前端在 Vite 端口（如 5199）、后端在 3000，后端并不知道
前端跑在哪个端口。
"""

import re
import shutil
import socket
import subprocess
from pathlib import Path
from typing import List

REPO_ROOT = Path(__file__).resolve().parent.parent
# 前端 dev server 的证书位置（scripts/dev-certs.sh 生成，frontend/vite.config.ts 读取）
CERT_PATH = REPO_ROOT / "frontend" / "certs" / "dev-cert.pem"


def _primary_lan_ip() -> str | None:
    """
    用一个 UDP socket "连接"外部地址来问操作系统：默认路由会走哪张网卡。
    UDP connect 不会真的发包，所以离线也能拿到结果。
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()


def lan_ips() -> List[str]:
    """返回本机可能的局域网 IPv4 地址，最可能可达的排在最前面。"""
    ips: List[str] = []

    primary = _primary_lan_ip()
    if primary and not primary.startswith("127."):
        ips.append(primary)

    # 主网卡之外可能还有别的（有线 + 无线同时连着），一并列出来让用户选。
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except OSError:
        pass

    return ips


def cert_info() -> dict:
    """开发证书的状态：存不存在、覆盖了哪些地址。

    「输出」页用它自检——最常见的两个坑都是静默失败：
      1. 证书生成了但 dev server 是用 `npm run dev`（HTTP）起的；
      2. 换了 Wi-Fi 导致局域网 IP 变了，而证书里签的还是旧 IP。
    两种情况手机扫码都连不上，界面上不提示的话根本查不出来。
    """
    info = {"exists": CERT_PATH.exists(), "covers": [], "path": str(CERT_PATH)}
    if not info["exists"]:
        return info

    openssl = shutil.which("openssl")
    if not openssl:
        return info  # 拿不到覆盖范围就只报存在性，不猜

    try:
        out = subprocess.run(
            [openssl, "x509", "-in", str(CERT_PATH), "-noout", "-ext", "subjectAltName"],
            capture_output=True, text=True, timeout=10,
        ).stdout
        # 形如: DNS:localhost, IP Address:127.0.0.1, IP Address:192.168.1.5
        info["covers"] = re.findall(r"(?:DNS|IP Address):\s*([^,\s]+)", out)
    except (subprocess.SubprocessError, OSError):
        pass
    return info


def network_info() -> dict:
    return {
        "hostname": socket.gethostname(),
        "lan_ips": lan_ips(),
        "cert": cert_info(),
        # 「输出」页用它拼出**带绝对路径**的命令：面板里那几条命令是给用户
        # 直接复制去终端跑的，只写 `npm run dev:https` 的话，在 backend/ 或
        # 别的目录下执行会报 ENOENT（找不到 package.json）。
        "repo_root": str(REPO_ROOT),
    }
