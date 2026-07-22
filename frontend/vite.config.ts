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
// 才允许运动传感器权限。证书由 scripts/dev-certs.sh 生成到 frontend/certs/。
//
// HTTPS 是显式开关（npm run dev:https），不是"有证书就自动启用"——自动启用会让
// 装完证书后所有 http:// 的旧地址静默失效，Safari 只会报一句"服务器意外中断了
// 连接"，很难联想到是协议变了。日常桌面开发用 HTTP，只有要连手机时才开 HTTPS。
const wantHttps = process.env.MW_HTTPS === "1";
const certDir = path.join(rootDir, "certs");
const keyPath = path.join(certDir, "dev-key.pem");
const certPath = path.join(certDir, "dev-cert.pem");
const hasCerts = fs.existsSync(keyPath) && fs.existsSync(certPath);

if (wantHttps && !hasCerts) {
  console.warn("\n⚠️  MW_HTTPS=1 但没找到证书，将以 HTTP 启动。先运行：bash scripts/dev-certs.sh\n");
}

const httpsConfig =
  wantHttps && hasCerts
    ? { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
    : undefined;

// 走 ngrok / cloudflared 隧道时，Vite 会因为 Host 头不认识而拒绝请求。
//
// 麻烦在于 cloudflared 的临时隧道每次启动都随机分配域名，而 Vite 必须在启动时就
// 知道放行谁——鸡生蛋。三种解法，按推荐程度排：
//   1. MW_TUNNEL=1（npm run dev:tunnel）：按后缀放行已知隧道服务，不需要提前知道
//      具体域名，同时保留对其它域名的 DNS rebinding 防护。日常用这个。
//   2. MW_ALLOWED_HOSTS=a.com,b.com：自定义域名（自建隧道/自有域名）时用。
//   3. MW_ALLOWED_HOSTS=*：放行一切，会关掉 DNS rebinding 防护——任意网站都能把
//      域名解析到你的 localhost 来读 dev server。只在临时演示时用，别常开。
const TUNNEL_HOST_SUFFIXES = [
  ".trycloudflare.com",
  ".ngrok-free.app",
  ".ngrok.io",
  ".ngrok.app",
  ".loca.lt",
];

const rawAllowedHosts = process.env.MW_ALLOWED_HOSTS?.trim();
const explicitHosts =
  rawAllowedHosts && rawAllowedHosts !== "*"
    ? rawAllowedHosts.split(",").map((h) => h.trim()).filter(Boolean)
    : [];
const tunnelHosts = process.env.MW_TUNNEL === "1" ? TUNNEL_HOST_SUFFIXES : [];
const hostList = [...explicitHosts, ...tunnelHosts];

const allowedHosts: true | string[] | undefined =
  rawAllowedHosts === "*" ? true : hostList.length ? hostList : undefined;

if (allowedHosts === true) {
  console.warn("\n⚠️  MW_ALLOWED_HOSTS=* 已放行全部 Host（关闭了 DNS rebinding 防护），仅建议临时演示时使用。\n");
} else if (tunnelHosts.length) {
  console.log(`\n🌐 隧道模式：已放行 ${TUNNEL_HOST_SUFFIXES.join("、")}\n`);
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 监听 0.0.0.0，否则手机用局域网 IP 根本连不上（M4 之前就卡在这里）。
    host: true,
    https: httpsConfig,
    ...(allowedHosts !== undefined ? { allowedHosts } : {}),
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
