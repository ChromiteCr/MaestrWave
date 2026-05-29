# MTX Orchestral Conductor — 项目骨架

这是根据项目规格生成的代码骨架，包含后端（FastAPI）与前端（Vanilla JS + Web Audio API）示例实现。

快速启动（开发环境）：

1. 启动 ACE-Step API（确保本地可达，默认 http://localhost:8001）

2. 后端：

```bash
cd backend
python -m pip install -r requirements.txt
# 在开发机器上运行
uvicorn app:app --host 0.0.0.0 --port 3000
```

3. 浏览器访问 `https://<your-host>:3000` 或使用 `ngrok` 将本地端口暴露为 HTTPS（以便手机访问 DeviceMotion）。

注意：ACE-Step API 的端点与字段可能与示例代码存在差异，请参考 ACE-Step 本地服务的 /docs 调整 `backend/generator.py` 的 payload。
