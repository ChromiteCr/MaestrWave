"""
局域网地址探测（M4）。

「输出」页在电脑模式下要生成一个手机能扫的二维码，二维码里必须是
局域网可达的地址。浏览器自己拿不到本机的局域网 IP（页面地址可能是
localhost），所以由后端探测后通过 /api/network-info 告诉前端。

前端只取 host 部分，协议和端口沿用它自己的 window.location——
因为开发模式下前端在 Vite 端口（如 5199）、后端在 3000，后端并不知道
前端跑在哪个端口。
"""

import socket
from typing import List


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


def network_info() -> dict:
    return {
        "hostname": socket.gethostname(),
        "lan_ips": lan_ips(),
    }
