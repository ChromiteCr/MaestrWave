/**
 * 把 MediaPipe 的 WASM 运行时从 node_modules 复制到 public/mediapipe/wasm/。
 *
 * 为什么不直接把 WASM 提交进仓库：它有 11MB，而 `npm install` 本来就会把它装进
 * node_modules —— 提交一份等于在 git 里存一份 npm 已经给你的东西。真正需要进仓库的
 * 只有模型文件（hand_landmarker.task，7.5MB），那个 npm 不提供。
 *
 * 挂在 predev / prebuild 上自动跑，不需要用户记得执行（对比 scripts/dev-certs.sh 那种
 * 要手动跑的脚本 —— 忘了跑就只能看到一句语焉不详的报错）。
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const dest = join(root, "public", "mediapipe", "wasm");

// 只带 SIMD 版本。所有目标浏览器（Chrome/Edge、Safari 16.4+、Firefox）自 2021 年起
// 都支持 WebAssembly SIMD，而这个应用本来就要求 Web Audio、getUserMedia 这些更新的
// API。多带一份 10MB 的 nosimd 兜底不划算。
const FILES = ["vision_wasm_internal.js", "vision_wasm_internal.wasm"];

if (!existsSync(src)) {
  console.warn("[mediapipe] 没找到 @mediapipe/tasks-vision，跳过。先跑 npm install。");
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
let copied = 0;
for (const f of FILES) {
  const from = join(src, f);
  if (!existsSync(from)) {
    console.warn(`[mediapipe] 缺少 ${f}，摄像头指挥可能无法启动。`);
    continue;
  }
  copyFileSync(from, join(dest, f));
  copied++;
}
console.log(`[mediapipe] WASM 运行时就绪（${copied} 个文件）`);
