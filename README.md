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
- 生成后端可切换：本机 ACE-Step，或腾讯音乐天琴云端 API（不占本机显存）
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
  - 新增 `scripts/dev-certs.sh` 生成 HTTPS 证书：iOS 只在安全上下文才允许运动传感器权限。HTTPS 是显式开关（`npm run dev:https`），避免装完证书后 http:// 旧地址静默失效。
  - 「输出」页电脑模式提供「局域网 / 隧道」两种配对方式，任何手机零安装即可用隧道方式接入。`npm run dev:tunnel` 按后缀放行常见隧道域名，解决"隧道域名随机、Vite 却要启动时就知道放行谁"的鸡生蛋问题。
  - 隧道可在 UI 上一键启停（`backend/tunnel.py` 代管 cloudflared 子进程，抓到域名后回传前端自动填入），不需要另开终端；后端退出时自动关闭隧道。
  - 顺带修回一个 M2 移植时漏掉的逻辑：起播后 5 秒无传感器数据的检测（原先桌面端会永远停在"等待手势…"）。
- ✅ **M4a**（本次改动，M4 之下的一次细化调整）新增云端 API 生成方式，本机不跑模型：
  - 新增 `backend/tme_backend.py` 对接腾讯音乐天琴 workflow API（HMAC 签名、异步提交、轮询、下载），`GENERATION_BACKEND=tme` 即可切换。
  - 生成请求的 tags 会带上「生成」页里的全部音乐信息：乐器（含自定义名）、角色、调号、拍号、BPM、片段时长、风格描述、已有声部。
  - 天琴只有整曲文生乐：`lego` 降级为共享乐理上下文的文字对齐，`repaint` 明确返回 501 且前端自动隐藏按钮；「设置」页新增「当前后端能力」卡片说明差异。
  - 天琴返回整曲 MP3，用 ffmpeg 转单声道 WAV 并裁到项目时长，保证多轨对齐；`mix_wav_files` 改为跳过读不了的音轨而不是整体崩掉。

## 用云端 API 生成（不占本机显存）

ACE-Step 要在本机跑模型，消费级设备显存吃紧。可以改用腾讯音乐天琴的云端 API：

```bash
export GENERATION_BACKEND=tme
export TME_APP_ID=你的AppId
export TME_APP_KEY=你的AppKey
uvicorn app:app --host 0.0.0.0 --port 3000
```

密钥只从环境变量读，不写进仓库。配好后「设置」页会显示当前后端、是否就绪，以及能力差异。

生成时会把「生成」页里的**全部音乐信息**编进请求的 tags，包括正在生成哪件乐器（含自定义乐器名）、它承担的角色、调号、拍号、BPM、片段时长、风格描述，以及已有哪些声部。实际发出的 tags 会打进后端日志，方便核对。

### 能力差异（重要）

天琴是**整曲生成器**，只有文生乐，没有 ACE-Step 的两项能力：

| | 本机 ACE-Step | 天琴（云端） |
|---|---|---|
| 显存占用 | 本机 16GB+ | 无 |
| 文生乐 | ✅ | ✅ |
| 音频层面协同（lego） | ✅ 真的"听"已有音轨来加声部 | ❌ 降级为共享调号/拍号/速度的文字对齐 |
| 局部重绘（Repaint） | ✅ | ❌ 按钮会自动隐藏 |
| LoKr / LoRA 权重 | ✅ | ❌ |

也就是说，用天琴时**各声部之间的配合会明显弱于 ACE-Step**——它们是各自独立生成的，只靠同一套乐理参数和文字描述对齐，而不是像 `lego` 那样在音频内容层面协同。想要最好的配合效果，仍然建议用 ACE-Step（本机或 AutoDL 等租用的 GPU 机器）。

天琴返回的是完整曲子的 MP3，后端会用 ffmpeg 转成单声道 WAV 并裁到项目的「乐曲总时长」，保证多轨能对齐循环播放。没装 ffmpeg 时会告警并保留原始音频（浏览器仍能播，但 Python 侧的混音会跳过这条轨）。

## 代码结构

- backend
  - app.py：FastAPI 入口与 REST API
  - generator.py：ACE-Step 客户端与生成任务封装
  - project.py：项目/乐器/take 数据模型
  - project_gen.py：分乐器协同生成与 lego 编排逻辑
  - generation_backend.py：生成后端抽象与能力声明
  - tme_backend.py：腾讯音乐天琴云端生成后端
  - conduct.py：手机遥控指挥的 WebSocket 中转
  - netinfo.py：局域网地址探测
  - tunnel.py：代管 cloudflared 隧道进程（UI 一键启停）
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

电脑模式下手机怎么连过来有两种方式，在「输出」页可以切换：**局域网**（延迟最低，iPhone 需装一次证书）和**隧道**（零安装，不要求同一网络）。

### 方式一：局域网 —— iOS 必须先启用 HTTPS

iOS 只在安全上下文里才允许 `DeviceMotionEvent.requestPermission()`。手机通过局域网 IP 走 http:// 访问时，Safari 连权限弹窗都不会出现。生成证书：

```bash
bash scripts/dev-certs.sh
```

脚本优先用 mkcert（推荐 `brew install mkcert`，签出的证书受系统信任），没有则用 openssl 自签名兜底。证书写到 `frontend/certs/`。

证书生成后 HTTPS **不会自动启用**——要用 HTTPS 启动（注意在 `frontend/` 目录下）：

```bash
cd frontend && npm run dev:https
```

> 换了 Wi-Fi 之后局域网 IP 会变，而证书里签的是生成时那一刻的 IP，手机会因证书不匹配连不上。重跑一次 `scripts/dev-certs.sh` 再重启即可（根证书不用在手机上重装）。「输出」页的局域网模式会自动检测这种情况并给出可复制的命令。

日常桌面开发继续用 `npm run dev`（HTTP）。这样区分是因为：如果"有证书就自动切 HTTPS"，那么所有 `http://localhost:5173` 的旧地址会静默失效，Safari 只会报一句「服务器意外中断了连接」，很难联想到是协议变了。

用 mkcert 时手机还需要安装一次它的根证书（脚本会打印步骤）；用自签名证书则手机首次访问时点「继续访问」即可。

> 每台要连的 iPhone 都得装一次 mkcert 根证书——它是只有你自己设备信任的私有 CA。如果要给多个人/多台手机演示，用下面的隧道方案更合适（公开受信任证书，任何设备零安装）。Android 上 Chrome 通常不强制 HTTPS，直接用 HTTP 即可。

Android 上 Chrome 通常不强制这一点，HTTP 也能拿到传感器数据。

### 方式二：隧道（不用证书，任何手机零安装）

「输出」页电脑模式里可以把配对方式从「局域网」切到「隧道」，页面会给出完整步骤。原理是用 cloudflared / ngrok 把本机暴露到公网，它们自带**公开受信任**的 HTTPS 证书，所以任何手机都不用装任何东西，也不要求和电脑在同一个网络。

前提是装了 cloudflared，并且 dev server 用 `dev:tunnel` 启动（原因见下）：

```bash
brew install cloudflared
cd frontend && npm run dev:tunnel
```

然后在「输出」页 → 电脑模式 → 隧道，**点「启动隧道」**即可：后端会代管 cloudflared 进程，拿到域名后自动填进输入框、二维码同步刷新，不需要你另开终端。再点一次「停止隧道」关闭。

走隧道时**不需要 mkcert 证书，也不需要 `dev:https`**——TLS 由隧道那一端终结。

其它情况：
- 没装 cloudflared 时，UI 会显示安装提示和可复制的手动命令，跑完把网址粘进输入框也一样能用（地址存在 localStorage，刷新不丢）。
- 直接用隧道域名在电脑上打开本页面时，UI 会自动识别并预填。
- 后端进程退出时会自动关掉它启动的隧道，避免机器在你不知情的情况下一直暴露在公网。

**为什么必须用 `dev:tunnel`**：Vite 会拒绝 Host 头不在允许列表里的请求（防 DNS 重绑定攻击），而 cloudflared 的临时隧道每次启动都是随机域名，没法提前写进配置——鸡生蛋。`MW_TUNNEL=1`（即 `dev:tunnel`）按**后缀**放行 `.trycloudflare.com`、`.ngrok-free.app`、`.ngrok.io`、`.ngrok.app`、`.loca.lt`，既不用提前知道具体域名，也保留了对其它域名的防护。

自建隧道或自有域名用 `MW_ALLOWED_HOSTS=a.example.com,b.example.com npm run dev`；`MW_ALLOWED_HOSTS=*` 可以放行一切，但会关掉 DNS 重绑定防护，只在临时演示时用。

> ⚠️ 隧道地址是**公网可访问**的，拿到链接的人都能接进房间指挥。房间码是 6 位随机码（约 8.8 亿组合，暴力猜不现实），但链接本身别乱发，演示完记得关掉隧道。

### 两种方式怎么选

| | 局域网 | 隧道 |
|---|---|---|
| 延迟 | 最低 | 多几十毫秒 |
| iPhone 要装证书 | 是（每台一次） | 否 |
| 要求同一 Wi-Fi | 是 | 否 |
| 适合 | 自己开发调试 | 给别人演示、多台手机 |

## 配置说明

后端配置主要在 [backend/config.py](backend/config.py) 中，支持通过环境变量覆盖：

- GENERATION_BACKEND：生成后端，local（默认，本机 ACE-Step）/ tme（腾讯音乐天琴云端）/ cloud（预留）
- ACESTEP_API_URL：ACE-Step 服务地址，默认 http://localhost:8001
- TME_APP_ID / TME_APP_KEY：天琴的 AppId 与密钥，用 tme 后端时必填
- TME_API_URL：天琴接口地址，默认测试环境
- PROJECTS_DIR：项目产物目录，默认 output/projects
- OUTPUT_DIR：legacy 产物目录，默认 output/sessions
- LOKR_WEIGHTS_DIR：LoKr / LoRA 权重目录
- ALLOW_SYNTH_FALLBACK：是否启用程序化占位音频 fallback

## 主要 API

当前主流程以 project API 为主：

- GET /api/health：检查后端与 ACE-Step 可达性
- GET /api/network-info：局域网地址，「输出」页用它生成手机扫码地址
- WS /ws/conduct/{room_id}?role=stage|remote：手机遥控指挥的中转通道
- GET /api/tunnel、POST /api/tunnel/start、POST /api/tunnel/stop：cloudflared 隧道启停与状态
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

