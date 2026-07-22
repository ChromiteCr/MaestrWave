import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 开发模式下，Vite 只 serve 前端资源；/api、/audio、/project-audio、/ws 一律
// 转发给 FastAPI 后端（默认 :3000，见 backend/app.py）。
// 生产模式下 vite build 产出 dist/，由 backend/app.py 直接 serve（见 M2 计划）。

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// M4：手机要能扫码接入，dev server 必须在局域网可达；而 iOS 只在 HTTPS 下
// 才允许运动传感器权限。证书由 scripts/dev-certs.sh 生成到 frontend/certs/，
// 存在就自动启用 HTTPS，不存在就退回 HTTP（纯桌面调试够用）。
const certDir = path.join(rootDir, "certs");
const keyPath = path.join(certDir, "dev-key.pem");
const certPath = path.join(certDir, "dev-cert.pem");
const httpsConfig =
  fs.existsSync(keyPath) && fs.existsSync(certPath)
    ? { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
    : undefined;

// 走 ngrok / cloudflared 隧道时，Vite 会因为 Host 头不认识而拒绝请求。
// 用 MW_ALLOWED_HOSTS=xxx.ngrok-free.app 放行（逗号分隔）。
const allowedHosts = process.env.MW_ALLOWED_HOSTS
  ? process.env.MW_ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
  : undefined;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 监听 0.0.0.0，否则手机用局域网 IP 根本连不上（M4 之前就卡在这里）。
    host: true,
    https: httpsConfig,
    ...(allowedHosts ? { allowedHosts } : {}),
    proxy: {
      "/api": "http://localhost:3000",
      "/audio": "http://localhost:3000",
      "/project-audio": "http://localhost:3000",
      // 指挥中转是 WebSocket，必须显式开 ws 才会被代理（见 backend/conduct.py）。
      // 手机连的是 Vite（HTTPS/WSS），Vite 再转发到后端的明文 WS，
      // 所以后端自己不需要配证书。
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
  build: {
    outDir: "dist",
  },
});
