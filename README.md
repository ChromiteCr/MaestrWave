# MaestrWave

MaestrWave 是一个面向“AI 生成管弦乐素材 + 体感指挥演绎”的 Web 应用。项目当前以 React + Vite 作为前端，FastAPI 作为后端，使用 ACE-Step 1.5 进行音频生成，并把手机陀螺仪/加速度计作为实时指挥输入。

## 项目定位

这个项目包含两个相互连接的阶段：

1. 生成阶段：用户描述风格、调性、节奏与时长，系统为不同乐器生成独立音频片段。
2. 演绎阶段：在浏览器或手机端通过传感器控制各声部的激活度、力度与混音，让生成出的音乐以“指挥”方式实时展开。

## 当前能力

- 基于项目模型组织“项目 → 乐器 → take”的生成流程
- 支持单乐器生成、重新生成与局部重绘
- 提供浏览页波形与统一播放体验
- 支持手机 IMU 作为实时混音输入
- 当 ACE-Step 不可用时，自动回退到程序化占位音频，便于本地验证

## 代码结构

- backend
  - app.py：FastAPI 入口与 REST API
  - generator.py：ACE-Step 客户端与生成任务封装
  - project.py：项目/乐器/take 数据模型
  - project_gen.py：分乐器协同生成与 lego 编排逻辑
  - generation_backend.py：生成后端抽象
  - synth.py：程序化音频 fallback
  - config.py：配置项与乐器目录
- frontend
  - src/App.tsx：页面路由与侧栏入口
  - src/pages：文件、生成、浏览、输出、训练、设置六个页面
  - src/components：波形、侧栏、提示面板等 UI 组件
  - src/lib：音频引擎、传感器、手势解析与 API 封装
- output
  - projects：项目化生成产物
  - sessions：旧版 legacy 生成产物

## 快速开始

### 1. 后端

要求：Python 3.10+，建议在虚拟环境中运行。

```bash
cd backend
python -m pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 3000
```

也可以在项目根目录以包模式启动：

```bash
python -m pip install -r backend/requirements.txt
uvicorn backend.app:app --host 0.0.0.0 --port 3000
```

### 2. 前端

```bash
cd frontend
npm install
npm run dev
```

随后访问 Vite 提供的地址即可看到界面。默认开发环境会把 /api、/audio、/project-audio 代理到后端。

### 3. 生成与演绎

1. 打开“文件”页，新建项目并填写风格描述与基本参数。
2. 在“生成”页为不同乐器创建 tab 并逐个生成音频。
3. 在“浏览”页试听与检查生成结果。
4. 在“输出”页用手机打开同一地址，并授权传感器权限后进行实时指挥。

## 配置说明

后端配置主要在 [backend/config.py](backend/config.py) 中，支持通过环境变量覆盖：

- ACESTEP_API_URL：ACE-Step 服务地址，默认 http://localhost:8001
- PROJECTS_DIR：项目产物目录，默认 output/projects
- OUTPUT_DIR：legacy 产物目录，默认 output/sessions
- LOKR_WEIGHTS_DIR：LoKr / LoRA 权重目录
- ALLOW_SYNTH_FALLBACK：是否启用程序化占位音频 fallback

## 主要 API

当前主流程以 project API 为主：

- GET /api/health：检查后端与 ACE-Step 可达性
- GET /api/lokr：列出可用 LoKr / LoRA 权重
- POST /api/projects：创建项目
- GET /api/projects：列出项目
- POST /api/projects/{project_id}/instruments：新增乐器
- POST /api/projects/{project_id}/instruments/{instrument_id}/generate：生成单乐器音频
- POST /api/projects/{project_id}/instruments/{instrument_id}/repaint：局部重绘

此外，仓库中仍保留了旧版 legacy 生成接口，供兼容与参考使用。

## 说明

- 如果 ACE-Step 服务未启动，应用仍可走 fallback 流程，便于前后端联调。
- 如果需要在手机上使用传感器功能，建议使用 HTTPS 环境，例如通过 mkcert 或 ngrok 暴露本地服务。
- 当前项目仍在持续演进，前端界面与生成链路已经从旧版 Vanilla JS 重构为更适合长期维护的 React/Vite 结构。

