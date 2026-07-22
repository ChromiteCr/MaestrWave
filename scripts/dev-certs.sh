#!/usr/bin/env bash
#
# 为开发模式生成 HTTPS 证书（M4）。
#
# 为什么需要：iOS 只在安全上下文（HTTPS）里才允许 DeviceMotionEvent.requestPermission()。
# 手机通过局域网 IP 走 http:// 访问时，Safari 连权限弹窗都不会出现，
# 「手机指挥」功能就完全用不了。
#
# 证书会写到 frontend/certs/，Vite 检测到就自动启用 HTTPS（见 frontend/vite.config.ts）。
#
# 优先用 mkcert（签发的证书被系统信任，手机装一次根证书后就没有安全警告）；
# 没有 mkcert 就用 openssl 自签名兜底（能用，但手机上要手动点「继续访问」）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_DIR="$SCRIPT_DIR/../frontend/certs"
KEY_FILE="$CERT_DIR/dev-key.pem"
CRT_FILE="$CERT_DIR/dev-cert.pem"

mkdir -p "$CERT_DIR"

# 探测局域网 IP，证书必须覆盖它，否则手机用 IP 访问时域名对不上。
detect_lan_ip() {
  if command -v ipconfig >/dev/null 2>&1; then
    for iface in en0 en1 en2; do
      ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
      [ -n "$ip" ] && { echo "$ip"; return; }
    done
  fi
  if command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [ -n "$ip" ] && { echo "$ip"; return; }
  fi
  echo ""
}

LAN_IP="$(detect_lan_ip)"
if [ -z "$LAN_IP" ]; then
  echo "!! 没探测到局域网 IP，证书只会覆盖 localhost。请确认已连上 Wi-Fi。"
else
  echo "-> 局域网 IP: $LAN_IP"
fi

if command -v mkcert >/dev/null 2>&1; then
  echo "-> 使用 mkcert 签发证书"
  # shellcheck disable=SC2086
  mkcert -key-file "$KEY_FILE" -cert-file "$CRT_FILE" localhost 127.0.0.1 ::1 ${LAN_IP:+$LAN_IP}
  echo
  echo "✅ 完成。手机需要安装一次 mkcert 的根证书才能不报警告："
  echo "   1) 运行 mkcert -CAROOT 找到 rootCA.pem"
  echo "   2) 用 AirDrop / 邮件把 rootCA.pem 发到手机并安装"
  echo "   3) iOS 还要到 设置 → 通用 → 关于本机 → 证书信任设置 里手动信任它"
else
  echo "!! 未安装 mkcert，改用 openssl 自签名证书。"
  echo "   建议改用 mkcert（brew install mkcert），否则手机访问时会有安全警告。"
  SAN="DNS:localhost,IP:127.0.0.1"
  [ -n "$LAN_IP" ] && SAN="$SAN,IP:$LAN_IP"
  openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
    -keyout "$KEY_FILE" -out "$CRT_FILE" \
    -subj "/CN=MaestrWave Dev" \
    -addext "subjectAltName=$SAN" >/dev/null 2>&1
  echo
  echo "✅ 完成（自签名）。手机首次访问会提示证书不受信任，点「继续访问」即可。"
fi

echo
echo "证书位置：$CERT_DIR"
echo
echo "HTTPS 不会自动启用（否则 http:// 的旧地址会静默失效）。要连手机时用："
echo "    npm run dev:https"
echo "日常桌面开发仍然用 npm run dev（HTTP）。"
if [ -n "$LAN_IP" ]; then
  echo
  echo "手机访问：https://$LAN_IP:5173"
fi
