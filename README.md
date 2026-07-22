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
- 支持手机 IMU 作为实时混音输入，可选"手机自采自放"或"手机遥控、电脑出声"两种模式
- 当 ACE-Step 不可用时，自动回退到程序化占位音频，便于本地验证

## 版本记录

- ✅ **M0** 仓库可运行状态修复：解决一次 merge 遗留在 `main` 里的未解决冲突标记（导致 `backend/*.py` 语法错误）。
- ✅ **M1** 后端生成链路重写：对接 ACE-Step 原生任务队列 API（`/release_task` + `/query_result`），新增「项目→乐器→take」数据模型和 `lego` 分乐器协同生成，`batch_size` 显式设为 1。
- ✅ **M2** 前端重写为剪辑软件式 UI：迁移到 React + Vite，左侧竖直图标侧栏 + 文件/生成/浏览/输出/训练/设置六个页面，canvas 波形为签名视觉元素，主色调为浅蓝，上半部分有波浪渐变装饰，侧栏文件图标上方是指挥棒+波浪的 logo。
- ✅ **M2a1**（M2 之下的一次细化调整）：
  - 「文件」页新建项目表单简化为只填「项目名称」和「乐曲总时长」，风格描述/调性/拍号/BPM 都交给「生成」页处理。
  - 添加乐器时新增「其他」选项，支持输入任意自定义乐器名，会正确带入生成提示词（后端 `get_instrument_spec` 的 fallback 逻辑已支持，这次补的是前端入口）。
  - 训练/设置/生成/浏览四个页面统一了表单字号、卡片内边距和页面留白，「设置」页去掉了过窄的 640px 宽度限制，「浏览」页波形加高、操作按钮对齐。
- ✅ **M2a2**（本次改动，M2 之下的另一次细化调整）：
  - 「生成」页头部右上角的调性/BPM/拍号 chip 全部去掉，音乐参数只在「高级」面板里看和调。
  - 「高级」模式下的调性/拍号/BPM/乐曲总时长挪到了风格描述输入框的上方（原来在下方）。
  - 风格描述输入框在没有内容时，和其它输入框一样显示占位提示文字。
- ⏳ **M3** 训练页后端：尚未开始，卡在需要确认训练机器上具体用 ACE-Step 自带的 Gradio LoRA Training 标签页，还是 Side-Step CLI。
- ✅ **M4** 手机遥控指挥（本次改动）：在原本"手机单机自采自放"之外，新增"手机当指挥棒、电脑出声"的模式，两种模式在「输出」页可切换。
  - 后端新增 WebSocket 中转 `/ws/conduct/{room}`（`backend/conduct.py`），只做纯转发不解析手势；新增 `/api/network-info`（`backend/netinfo.py`）供前端拼手机可达地址。
  - 前端把"采集传感器"抽成可替换的 `SensorSource`（`lib/sensorSource.ts`），单机模式与电脑模式共用同一套指挥/出声逻辑。
  - 「输出」页电脑模式显示房间码与二维码，手机扫码即进入专用遥控界面（`pages/RemotePage`，不加载任何音频）。
  - 开发模式下 Vite 改为监听 `0.0.0.0` 并代理 WebSocket——此前只绑 localhost，手机在局域网里根本连不上。
  - 新增 `scripts/dev-certs.sh` 生成 HTTPS 证书：iOS 只在安全上下文才允许运动传感器权限。
  - 顺带修回一个 M2 移植时漏掉的逻辑：起播后 5 秒无传感器数据的检测（原先桌面端会永远停在"等待手势…"）。

## 代码结构

- backend
  - app.py：FastAPI 入口与 REST API
  - generator.py：ACE-Step 客户端与生成任务封装
  - project.py：项目/乐器/take 数据模型
  - project_gen.py：分乐器协同生成与 lego 编排逻辑
  - generation_backend.py：生成后端抽象
  - conduct.py：手机遥控指挥的 WebSocket 中转
  - netinfo.py：局域网地址探测
  - synth.py：程序化音频 fallback
  - config.py：配置项与乐器目录
- frontend
  - src/App.tsx：页面路由与侧栏入口
  - src/pages：文件、生成、浏览、输出、训练、设置六个页面，外加手机端遥控页 RemotePage
  - src/components：波形、侧栏、提示面板、二维码等 UI 组件
  - src/lib：音频引擎、传感器源、手势解析、指挥链路（conductLink）与 API 封装
- scripts
  - dev-certs.sh：生成开发用 HTTPS 证书（iOS 传感器权限需要）
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

1. 打开“文件”页，新建项目（只需要项目名称和乐曲总时长）。
2. 在“生成”页填写风格描述、按需调整调性/拍号/BPM，为不同乐器创建 tab（含自定义乐器）并逐个生成音频。
3. 在“浏览”页试听与检查生成结果。
4. 在“输出”页选择指挥模式：单机模式用手机打开同一地址，电脑模式用手机扫二维码接入（详见下面「手机指挥」）。

## 手机指挥

「输出」页有两种模式：

| 模式 | 谁采传感器 | 谁出声 | 需要什么 |
|------|-----------|--------|----------|
| 单机模式 | 手机 | 手机 | 手机能打开页面即可 |
| 电脑模式 | 手机 | 这台电脑 | 手机和电脑在同一局域网 |

电脑模式的流程是：「输出」页切到电脑模式 → 页面显示房间码和二维码 → 手机扫码进入遥控界面 → 电脑点「开始指挥」→ 挥动手机，声音从电脑放出。手机端只发传感器数据，不下载音频。

### iOS 必须先启用 HTTPS

iOS 只在安全上下文里才允许 `DeviceMotionEvent.requestPermission()`。手机通过局域网 IP 走 http:// 访问时，Safari 连权限弹窗都不会出现。生成证书：

```bash
bash scripts/dev-certs.sh
```

脚本优先用 mkcert（推荐 `brew install mkcert`，签出的证书受系统信任），没有则用 openssl 自签名兜底。证书写到 `frontend/certs/`，重启 `npm run dev` 后 Vite 会自动以 HTTPS 启动。用 mkcert 时手机还需要安装一次它的根证书（脚本会打印步骤）；用自签名证书则手机首次访问时点「继续访问」即可。

Android 上 Chrome 通常不强制这一点，HTTP 也能拿到传感器数据。

### 用隧道代替证书

不想折腾证书的话，用 ngrok / cloudflared 暴露 5173 端口也可以，它们自带受信任的 HTTPS。这种情况下要放行 Vite 的 Host 检查：

```bash
MW_ALLOWED_HOSTS=your-tunnel.ngrok-free.app npm run dev
```

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
- GET /api/network-info：局域网地址，「输出」页用它生成手机扫码地址
- WS /ws/conduct/{room_id}?role=stage|remote：手机遥控指挥的中转通道
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

