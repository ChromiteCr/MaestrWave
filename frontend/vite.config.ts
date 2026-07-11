import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发模式下，Vite 只 serve 前端资源；/api、/audio、/project-audio 一律
// 转发给 FastAPI 后端（默认 :3000，见 backend/app.py）。
// 生产模式下 vite build 产出 dist/，由 backend/app.py 直接 serve（见 M2 计划）。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/audio": "http://localhost:3000",
      "/project-audio": "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist",
  },
});
