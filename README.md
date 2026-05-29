# MTX Orchestral Conductor — 项目骨架

一个两阶段的交互式音乐系统骨架：

- 阶段一：基于本地 ACE‑Step 生成多轨分声部（后端负责调用本地 ACE‑Step API 并将生成文件保存到 `output/sessions/{session_id}`）。
- 阶段二：前端（手机/浏览器）使用 Web DeviceMotion/DeviceOrientation 作为指挥输入，运行 Web Audio 实时混音与空间化。

本仓库包含完整骨架代码（后端 + 前端示例），目标是提供可运行的最小实现以便快速验证交互体验。

主要文件
- 后端: [backend/app.py](backend/app.py) · [backend/generator.py](backend/generator.py) · [backend/stems.py](backend/stems.py) · [backend/config.py](backend/config.py) · [backend/requirements.txt](backend/requirements.txt)
- 前端: [frontend/index.html](frontend/index.html) · [frontend/js/app.js](frontend/js/app.js) · [frontend/js/sensor.js](frontend/js/sensor.js) · [frontend/js/gesture.js](frontend/js/gesture.js) · [frontend/js/audio-engine.js](frontend/js/audio-engine.js)

功能概览
- 生成端点：`POST /api/generate`（返回 `session_id`、`full_mix_url` 与 `stems` 列表）。
- 静态资源：前端通过 `/static` 提供 UI，生成音频文件通过 `/audio/{session_id}/...` 访问。
- 前端：采集手机 IMU，解析手势映射到声部激活/力度/速度，使用 Web Audio API 实时混音与控制。

配置
- 在 `backend/config.py` 中设置：
	- `ACESTEP_API_URL`（默认 `http://localhost:8001`）
	- `LOKR_WEIGHTS_PATH`（LoKr/LoRA 微调权重路径）
	- `OUTPUT_DIR`（生成音频输出目录，默认 `output/sessions`）

启动与运行（开发）

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

如何使用
1. 启动 ACE‑Step API（参见 ACE‑Step 仓库，默认 `http://localhost:8001`）。
2. 修改 `backend/config.py` 中的 `LOKR_WEIGHTS_PATH` 指向你本地的 LoKr 权重（如果需要）。
3. 启动后端服务（见上面的启动步骤）。
4. 打开浏览器访问 `https://<host>:3000`（或 ngrok 提供的地址），在“阶段一”输入你想要的音乐描述并点击 `生成分轨`。
5. 生成完成后，使用“阶段二”加载分轨并开始指挥（页面会请求传感器权限）。

API 说明
- POST /api/generate
	- 请求体 JSON: `{ "description": str, "duration": int, "bpm": int, "key": str }`
	- 返回: `{ "session_id": str, "full_mix_url": str, "stems": {instrument: url} }`

已做的修复与注意点
- 修复了后端模块导入，使得既可以从 `backend` 目录直接运行 `uvicorn app:app`，也可以在项目根运行 `uvicorn backend.app:app`。
- 确保 `output/sessions` 目录存在（已在仓库中创建占位目录）。
- 前端示例使用 Web Audio API、DeviceMotion API；注意不同浏览器对权限和 API 支持的兼容性。

调试与排查建议
- 如果出现 500 错误，请检查后端日志，通常是 ACE‑Step 的接口或参数不匹配。启动 ACE‑Step 后访问 `http://localhost:8001/docs` 查看实际端点与参数。
- 若静态音频无法播放，确认生成的 wav 文件位于 `output/sessions/{session_id}` 并可通过 `http://<host>:3000/audio/{session_id}/violin.wav` 访问。
- 若手机无法访问传感器，确保使用 HTTPS（见上文）并使用支持 DeviceMotion 的浏览器（Safari / Chrome 移动版在不同版本上行为不同）。

下一步建议
- 根据 ACE‑Step 实际 API 文档调整 `backend/generator.py` 的请求字段（`reference_audio` 等）。
- 添加简单的单元测试和轻量集成测试（例如 mock ACE‑Step 返回）以自动化验证分轨生成流程。

本地开发快速验证（无需 ACE‑Step）
 - 仓库包含 `backend/dev_generate_mock.py`，用于创建一个包含静音 `full_mix.wav` 和各声部 `*.wav` 的 mock session。
 - 用法：

```bash
cd backend
python dev_generate_mock.py
# 启动服务后在浏览器加载该 session 的 /audio/<session_id>/full_mix.wav
```

版权与许可
- 本仓库为示例骨架，实现参考用户提供的项目规范。请在实际发布前补充许可与作者信息。

