# MTX Orchestral Conductor

一个两阶段的交互式音乐系统骨架：

- 阶段一：基于本地 ACE‑Step 生成分乐器音轨（后端负责调用本地 ACE‑Step API 并将生成文件保存到磁盘）。
- 阶段二：前端（手机/浏览器）使用 Web DeviceMotion/DeviceOrientation 作为指挥输入，运行 Web Audio 实时混音与空间化。

## 当前状态（重构进行中）

项目正按 M0→M3 四个里程碑重写生成算法 + 界面，规划见 `.claude/plans/`（如果你不是 Claude Code 会话，可忽略这句）：

- ✅ **M0** 仓库可运行状态修复：之前一次 merge 把冲突标记直接提交进了 `main`，导致 `backend/*.py` 语法错误、服务起不来；已修复。
- ✅ **M1** 后端生成链路重写：`backend/generator.py` 改为对接 ACE-Step **真实**文档化的原生任务队列 API（`POST /release_task` + `POST /query_result`），而不是之前误用的 OpenRouter 兼容接口字段；新增了「项目 → 乐器 → take」的数据模型（`backend/project.py`）和分乐器按需生成的编排逻辑（`backend/project_gen.py`）——**一次点击只生成一件乐器的一小段音频**，且从第二件乐器开始用 ACE-Step 原生的 `lego` 任务在已有音轨基础上协同生成，而不是靠共享文字描述硬凑和声。同时把每次请求的 `batch_size` 显式设为 `1`（原生 API 默认值是 2，之前从未覆盖）。新增 `backend/generation_backend.py` 做本地/云端生成后端的抽象，为以后接入带显卡的云端服务器预留接口。
- ✅ **M2** 前端重写为剪辑软件式 UI：整体迁移到 React + Vite（`frontend/src/`），左侧竖直图标侧栏固定两组（文件/生成/浏览/输出 在上，训练/设置 在下，设置钉在最底部），六个页面全部对接 M1 的 project API。视觉上用了深色调（暖炭黑 + 黄铜金 + 酒红），波形（生成/浏览页的核心可视元素）用 canvas 画峰值+播放头，是这版设计的签名元素。旧的 vanilla JS 前端移到了 `frontend/legacy/`（未删除，供参考），`sensor.js`/`gesture.js`/`audio-engine.js` 的手势解析和音频引擎逻辑原样移植到了 `frontend/src/lib/`，只是把"按乐器名硬编码方向"改成了"按角色（melody/harmony/bass/rhythm）"，因为新架构下乐器是任意的。
- ⏳ **M3** 训练页后端：尚未开始。「训练」页面的表单/显存提示已经在 M2 里做好了，提交按钮先禁用，等确认训练机器上具体用什么工具（见文末 Open Items）再接。

主要文件
- 后端：[backend/app.py](backend/app.py)（FastAPI 入口+路由）· [backend/generator.py](backend/generator.py)（ACE-Step 原生 API 客户端）· [backend/generation_backend.py](backend/generation_backend.py)（本地/云端生成后端抽象）· [backend/project.py](backend/project.py)（project/instrument/take 数据模型）· [backend/project_gen.py](backend/project_gen.py)（分乐器按需生成 + lego 和声编排，新架构核心）· [backend/stems.py](backend/stems.py)（旧的固定 5 声部生成流程，legacy）· [backend/audio_utils.py](backend/audio_utils.py)（wav 读写/混音工具）· [backend/synth.py](backend/synth.py)（ACE-Step 不可用时的程序化占位音频兜底）· [backend/config.py](backend/config.py) · [backend/requirements.txt](backend/requirements.txt)
- 前端：`frontend/src/App.tsx`（页面路由/侧栏）· `frontend/src/pages/`（文件/生成/浏览/输出/训练/设置六个页面）· `frontend/src/components/`（Sidebar、Waveform、InstrumentTabs、PromptPanel 等）· `frontend/src/lib/`（audioEngine.ts、sensor.ts、gesture.ts、api.ts，从旧 vanilla JS 移植）· `frontend/src/state/store.ts`（zustand 全局状态）· `frontend/vite.config.ts`（dev 模式把 `/api`、`/audio`、`/project-audio` 代理到 :3000 后端）。旧版 vanilla JS 前端保留在 `frontend/legacy/` 供参考，不再被 `backend/app.py` 引用。

功能概览
- **project API**（新 UI 用的就是这套）：分乐器按需生成，`lego` 任务实现真正的和声协同，见下方「project API」一节。
- **旧的分轨生成 API（legacy，已没有对应 UI）**：`POST /api/generate`（返回 `session_id`、`full_mix_url` 与 `stems` 列表），一次请求内串行生成 `full_mix` + 5 个固定声部，仅供参考/兼容，不建议再用。
- 静态资源：生产模式下前端构建产物由 `backend/app.py` 直接 serve（见上方「前端」启动说明），legacy 生成的音频通过 `/audio/{session_id}/...` 访问，project API 生成的音频通过 `/project-audio/{project_id}/takes/{instrument_id}/...` 访问。
- 输出页：采集手机 IMU，解析手势映射到乐器角色（melody/harmony/bass/rhythm）的激活度/力度/速度，使用 Web Audio API 实时混音与控制。

配置
- 在 `backend/config.py` 中设置（均可用同名环境变量覆盖）：
	- `ACESTEP_API_URL`（默认 `http://localhost:8001`）
	- `LOKR_WEIGHTS_PATH` / `LOKR_WEIGHTS_DIR`（LoKr/LoRA 微调权重路径/目录）
	- `OUTPUT_DIR`（legacy 分轨生成的输出目录，默认 `output/sessions`）
	- `PROJECTS_DIR`（新 project API 的输出目录，默认 `output/projects`）
	- `GENERATION_BACKEND`（`local` 或 `cloud`，默认 `local`；`cloud` 对应的 `CloudACEStepBackend` 目前是占位实现）
	- `CLOUD_ACESTEP_API_URL` / `CLOUD_ACESTEP_API_KEY`（云端后端预留，目前未启用）

启动与运行（开发）

注：在启动开发前，需要先下载ACE-Step 1.5模型到本地。具体下载方法见模型仓库。

以下两种运行方式均受支持：

1) 在 `backend` 目录内运行（最简单）

```bash
cd backend
python -m pip install -r requirements.txt
# 在 backend 目录下启动 Uvicorn（模块名为 app）
uvicorn app:app --host 0.0.0.0 --port 3000
```

2) 在项目根目录运行（作为 package）

```bash
python -m pip install -r backend/requirements.txt
# 以 package 模式启动
uvicorn backend.app:app --host 0.0.0.0 --port 3000
```

注意：代码已对包内导入和模块导入两种方式做兼容处理（见 `backend/app.py`、`backend/stems.py`、`backend/generator.py`）。

前端（新 UI，React + Vite）

```bash
cd frontend
npm install
npm run dev            # 默认 http://localhost:5173，把 /api /audio /project-audio 代理到上面的后端(:3000)
```

打开 Vite 给出的地址（不是 :3000）即可看到新 UI。生产部署时 `npm run build` 产出 `frontend/dist/`，重启后端后 `backend/app.py` 会直接 serve 这份构建产物，不再需要跑 Vite dev server。

HTTPS 与手机访问
- 浏览器的 DeviceMotion / DeviceOrientation 通常要求 HTTPS 环境。开发阶段推荐两种方案：
	- 使用 `mkcert` 为本地地址生成证书，然后用 Uvicorn 的 `--ssl-keyfile/--ssl-certfile` 启动。示例：

```bash
# 在项目根或 backend 中运行
uvicorn backend.app:app --host 0.0.0.0 --port 3000 \
	--ssl-keyfile=./certs/localhost+1-key.pem --ssl-certfile=./certs/localhost+1.pem
```

	- 使用 `ngrok` 暴露本地端口（ngrok 会提供 HTTPS 公网地址）：

```bash
ngrok http 3000
```

如何使用（新 UI）
1. 启动 ACE‑Step API（参见 ACE‑Step 仓库，默认 `http://localhost:8001`；不启动也能跑，会自动 fallback 到占位音频）。
2. 启动后端（见上面的启动步骤）+ 前端 `npm run dev`，打开 Vite 给出的地址。
3. 「文件」页新建项目（风格描述 + 调性/拍号/BPM/单段时长）。
4. 「生成」页给乐器 tab 挨个点「生成」——第一件乐器独立生成，之后每一件都会参照已有乐器做 `lego` 协同生成；对某件乐器不满意可以「重新生成」或「Repaint」局部重绘一段。
5. 「浏览」页可以看到项目里所有乐器堆叠的波形，「播放全部」统一起播，点某一行单独试听。
6. 「输出」页用手机打开同一个地址（HTTPS，见下文），点「开始指挥」授权传感器后挥动手机指挥。

（legacy 分轨生成 API 仍然存在，见下方「旧的分轨生成 API」，但已经没有对应的 UI 了。）

API 说明

**project API**（新 UI 用的就是这套）——分乐器按需生成，是重构后要长期使用的接口：
- `GET /api/instrument-library`：返回可选乐器目录（`brass`/`woodwind`/`percussion`/`strings`/具体乐器如 `trombone`/`oboe`...）和默认展示的三个 tab。
- `POST /api/projects`：新建项目。请求体 `{ style_description, key, bpm, time_signature, segment_duration, name }`。
- `GET /api/projects` / `GET /api/projects/{project_id}`：列出/获取项目（含每个乐器的 take 历史）。
- `PATCH /api/projects/{project_id}`：更新项目级共享上下文（生成页「高级」面板用）。请求体是上面字段的子集。
- `GET /api/projects/{project_id}/export`：把 project.json + 所有 take 音频打包成 zip 下载。
- `POST /api/projects/{project_id}/instruments`：新增一个乐器 tab。请求体 `{ library_key, display_name? }`。
- `DELETE /api/projects/{project_id}/instruments/{instrument_id}`：移除一个乐器 tab（连带它的 take 音频一起删）。
- `POST /api/projects/{project_id}/instruments/{instrument_id}/generate`：**一次点击生成一段单乐器音频**。项目里第一件有 take 的乐器走 ACE-Step 的 `text2music`；之后每件乐器都走 `lego`，参照"除它之外、当前已生成的其它乐器"混音后的临时 wav——这既用于首次生成，也用于 regenerate（regenerate 只需再调一次同一个接口）。请求体 `{ lora_path? }`，返回新增的 take（含可直接播放的 `url`）。
- `POST /api/projects/{project_id}/instruments/{instrument_id}/repaint`：对该乐器当前 take 的指定时间区间做局部重绘（对齐 ACE-Step 自己的 `repaint` 任务语义）。请求体 `{ prompt, start_time, end_time, lora_path? }`。

**旧的分轨生成 API（legacy，已没有对应 UI，仅保留兼容）**：
- `POST /api/generate`
	- 请求体 JSON: `{ "description": str, "duration": int, "bpm": int, "key": str }`
	- 返回: `{ "session_id": str, "full_mix_url": str, "stems": {instrument: url} }`
- `POST /api/generate/stream`：同上，但以 SSE 推送逐声部生成进度。
- `POST /api/repaint`：对某个 legacy session 的指定轨道做局部重绘。

已做的修复与注意点
- 修复了后端模块导入，使得既可以从 `backend` 目录直接运行 `uvicorn app:app`，也可以在项目根运行 `uvicorn backend.app:app`。
- 修复了一次 merge 遗留在 `main` 分支里的未解决冲突标记（`backend/app.py`、`backend/generator.py`、`backend/stems.py`、旧版 `frontend/js/app.js`、`frontend/js/stage1.js`，这两个 JS 文件现已随 M2 移到 `frontend/legacy/js/`），这些标记会让对应文件直接语法错误、服务起不来。
- `backend/generator.py` 之前对接的是一套不存在/搞混的 API 形状（把 ACE-Step 原生任务队列 API 和 OpenRouter 兼容接口的字段混在了一起，还调用了文档中不存在的 `/v1/init`），现已改为对接文档化的原生接口：`POST /release_task` 提交（`task_id` 在 `data.task_id`）、`POST /query_result`（body 是 `{"task_id_list": [...]}`，成功时 `data[].result` 是需要 `json.loads` 的 JSON 字符串，取其中的 `file` 字段下载）。同时把每次请求的 `batch_size` 显式设为 `1`（原生 API 默认值是 2，之前从未覆盖，等于每次调用都在被动地把计算/显存翻倍）。
- 确保 `output/sessions`、`output/projects`、`lokr_weights` 目录存在（应用启动时自动创建）。
- 前端示例使用 Web Audio API、DeviceMotion API；注意不同浏览器对权限和 API 支持的兼容性。

调试与排查建议
- 如果出现 500 错误，请检查后端日志，通常是 ACE‑Step 的接口或参数不匹配。启动 ACE‑Step 后访问 `http://localhost:8001/docs` 查看实际端点与参数；也可以对照 ACE-Step 仓库的 `docs/zh/API.md`。
- `backend/generator.py` 里没有把握的地方：`/release_task` 文档没有明确给出"每请求选择 LoRA/LoKr"的字段（官方 Gradio 界面是在加载模型时选权重），现在仍然把 `lora_path` 透传过去，服务端若不认识会被忽略——这一点需要对着真实跑起来的 `acestep-api` 实测确认。
- 若静态音频无法播放：legacy 流程确认 wav 文件位于 `output/sessions/{session_id}` 并可通过 `http://<host>:3000/audio/{session_id}/violin.wav` 访问；project API 确认文件位于 `output/projects/{project_id}/takes/{instrument_id}/` 并可通过 `http://<host>:3000/project-audio/{project_id}/takes/{instrument_id}/{take_id}.wav` 访问。
- 若手机无法访问传感器，确保使用 HTTPS（见上文）并使用支持 DeviceMotion 的浏览器（Safari / Chrome 移动版在不同版本上行为不同）。

本地开发快速验证（无需 ACE‑Step）
 - 仓库包含 `backend/dev_generate_mock.py`，用于创建一个包含静音 `full_mix.wav` 和各声部 `*.wav` 的 mock session（legacy 流程）。
 - 用法：

```bash
cd backend
python dev_generate_mock.py
# 启动服务后在浏览器加载该 session 的 /audio/<session_id>/full_mix.wav
```

 - project API 目前没有等价的 mock 脚本；但即使 ACE‑Step 不可达，`backend/generator.py` 也会自动 fallback 到 `backend/synth.py` 的程序化占位音频（`ALLOW_SYNTH_FALLBACK=1`，默认开启），所以直接调用 project API（`POST /api/projects` → `POST /api/projects/{id}/instruments` → `POST .../generate`）也能跑通端到端链路，用于验证接口本身。
