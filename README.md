# MaestrWave

![version](https://img.shields.io/badge/version-M7s1-blue)
![last commit](https://img.shields.io/github/last-commit/ChromiteCr/MaestrWave)
![commit activity](https://img.shields.io/github/commit-activity/m/ChromiteCr/MaestrWave)
![stars](https://img.shields.io/github/stars/ChromiteCr/MaestrWave)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**AI 生成管弦乐素材，然后用身体指挥它。** React + Vite 前端，FastAPI 后端。
十几条声部各自独立播放，你的手势实时改变它们的音量、速度和平衡。

## 项目定位

界面上是两条并列的路径，不分主次。

**指挥教学**：从零学怎么打拍子。七课分三个单元，每课有标准依据、动画示范、
现场写谱渲染的练习曲，打完按维度给分并给出讲评。另有考试页，用固定曲目打分，
分数可以横向比较。

**指挥体验**：做一首曲子再指挥它。五步流程是文件、构型、生成、浏览、输出。
前四步产出每件乐器一条独立音轨，最后一步是指挥台。

## 当前能力

- 项目模型组织「项目 → 乐器 → take」的生成流程，支持单乐器生成、重新生成与局部重绘
- 三种生成路线：本机 ACE-Step、腾讯音乐天琴云端 API、AI 写谱加采样器演奏
- 摄像头指挥，MediaPipe 在浏览器本地认手，画面不出这台机器
- 手机扫码当指挥棒，声音从电脑放出，走局域网或公网隧道都行
- 七课教学与考试，摄像头采集，六个维度给出具体数字与建议
- 管弦乐四族十三件乐器。「打击乐」指定音鼓与铙钹，跟流行鼓组无关
- ACE-Step 不可用时自动回退到程序化占位音频，便于本地验证

## 一键启动包（GitHub Actions 自动构建）

通过 `.github/workflows/release-build.yml`，GitHub Actions 会把项目自动打包成
**解压即用、双击启动**的绿色发布包（内置 Python/Node 运行时，无需安装环境、无需命令行）：

- **手动触发**：仓库 Actions 页 → `Build & Publish Startup Package` → Run workflow，
  生成 `MaestrWave-macOS.zip` 与 `MaestrWave-Windows.zip`（可在 Actions 页下载）。
- **推送到 main**：自动构建两个平台并上传 artifact，不发布 Release。
- **打 tag 自动发布**：推送 `M*` 或 `v*` 标签（如 `M7s1`）时自动构建并发布到 GitHub Releases。

发布包结构：

```
MaestrWave-{平台}.zip
├── MaestrWave/                  # PyInstaller 打包的后端（FastAPI + uvicorn）
├── frontend/dist/               # 前端构建产物（vite build）
├── output/                      # 运行时数据（生成的项目与音频）
├── config.env                   # 可选配置（TME 密钥 / 端口）
├── Start-MaestrWave.command(.bat)  # 双击启动，自动打开浏览器
└── README.txt
```

使用方式：解压 → 双击 `Start-MaestrWave.command`（macOS）/ `Start-MaestrWave.bat`
（Windows）→ 浏览器自动打开 `http://localhost:3000`。

音频生成后端在发布包里默认使用占位音频（演示链路完整可用）；如需腾讯天琴云端真实
生成，用文本编辑器在 `config.env` 填入 `TME_APP_ID` / `TME_APP_KEY` 并将
`GENERATION_BACKEND` 设为 `tme` 即可，同样不需要命令行。若仓库为私有且信任下载者，
也可在手动触发时勾选 `tme_inject`，由 Actions 从仓库 Secrets 注入密钥。

> 实现要点：后端打包由 `scripts/package/entry.py` + `maestrwave.spec` 完成，前端
> dist 在入口脚本中显式重定向给 `backend.app`（不改动任何业务代码）；CI 里带一次
> 真启动冒烟测试（HTTP 200），确保发布包开箱即用。

## 版本记录

当前版本 **M7s1**。完整的变更历史、版本号规则，以及 M0 到 M6 的阶段记录，都在
[docs/CHANGELOG.md](docs/CHANGELOG.md)。

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

也就是说，用天琴时**各声部之间的配合会明显弱于 ACE-Step**。它们各自独立生成，只靠同一套乐理参数和文字描述对齐，而 `lego` 是在音频内容层面协同的。想要最好的配合效果，仍然建议用 ACE-Step（本机或 AutoDL 等租用的 GPU 机器）。

天琴返回的是完整曲子的 MP3，后端会用 ffmpeg 转成单声道 WAV 并裁到项目的「乐曲总时长」，保证多轨能对齐循环播放。没装 ffmpeg 时会告警并保留原始音频（浏览器仍能播，但 Python 侧的混音会跳过这条轨）。

## 写谱演奏模式（M7）

前两种模式都是**直接产音频**，问题在于这类模型输出的是频谱不是音符：说了 92 BPM 出来的未必真是 92 BPM，多件乐器各生成一次就更对不齐，而这个软件恰好需要「每件乐器一条独立音轨 + 精确的拍网格 + 乐器能按段落进出场」。

第三种模式换个路子：**AI 先写谱，再由采样器演奏**。产物仍然是每件乐器一个 WAV，所以浏览页、输出页、摄像头指挥一行都没改。新建项目时选「写谱演奏」即可。

它顺带解决了几件旧问题：各声部长度精确一致、循环无接缝（尾音会叠回开头）、构型里的 `participation` 第一次真正生效（不参与的小节根本不写音符）、Repaint 真的能用（重写那几小节的音符再整轨重渲染）。谱子可以导出成 `.mid` 拿去 MuseScore 或 DAW 里用。

### 作曲器

| 值 | 说明 |
|---|---|
| `algorithmic` | 纯规则，不联网、不吃显存。调性统一、声部进行平稳、音区不重叠 |
| `llm` | 走已有的 BYOK 通路。任何一步失败都退回 `algorithmic`，并把降级原因记进 take |
| `remote` | 外部符号音乐模型服务。**失败不退回规则作曲**，直接报错。选了模型却拿规则的结果糊弄过去，你就再也判断不了这个模型行不行 |

默认 `auto`：配了语言模型就用 `llm`，否则 `algorithmic`。三者都在「设置」页可切，选择存后端偏好文件。

`remote` 的接口契约见 **[docs/SYMBOLIC_COMPOSER_API.md](docs/SYMBOLIC_COMPOSER_API.md)**，一个
`POST /compose_part`，请求给蓝图、乐器音域与已写好的其它声部，响应回一张音符表。任何符号
音乐模型（Anticipatory Music Transformer、MMM 之类）自己包一层薄服务就能接进来，后端零改动。
和弦走向与段落结构一律本地算：符号模型擅长续写音符，不擅长按段落强度规划全曲结构，而后者
恰好是纯规则做得又快又稳的部分。

服务地址在「设置」页填，**只接受本机或局域网地址**。这条限制的对象是隧道：`tunnel.py` 一开，
后端就暴露在公网，而这个地址决定了后端把整份乐谱 POST 到哪去。要连公网服务请用
`SYMBOLIC_COMPOSER_URL` 环境变量启动。那是启动时的运维决定，远程改不了它。

```bash
export SCORE_COMPOSER=algorithmic   # 强制用本地规则，一次外部调用都不发
```

### 音源

**开箱即用，不需要装任何东西。** 仓库自带一个 33MB 的管弦乐音源
（`backend/soundfonts/orchestral.sf2`，从 MIT 授权的 FluidR3_GM 裁出来的），
由 `backend/sf2.py` 直接读取播放。那是个纯标准库的 SoundFont 解析器加采样
播放器，没有任何外部可执行文件，源码跑和打包跑完全一致。

| 音源 | 说明 |
|---|---|
| `sf2`（默认） | 自带的采样播放器，真实乐器录音 |
| `fluidsynth` | 外部合成器，同一份音源，混响更丰富。装了才能选 |
| `builtin` | 纯加法合成，连音源文件都不需要。音色朴素，是最后的保底 |

在「设置」页可以随时切换，也可以用 `SCORE_RENDERER` 环境变量指定。
`/api/health` 的 `score` 块会如实报告当前实际生效的是哪个。

换自己的音源：把任意 `.sf2` 放进 `backend/soundfonts/` 即可（文件名随意，后端
自己扫）。**只支持未压缩的 `.sf2`**，`.sf3` 的样本是 Ogg Vorbis 压缩的，
纯 Python 解不了。想换个更大的音源再裁一遍：

```bash
python3 scripts/trim_soundfont.py 完整音源.sf2 backend/soundfonts/orchestral.sf2
```

发布包里连 fluidsynth 一起带（macOS 实测 19 个文件 5.7MB，CI 会把库路径改写成
`@loader_path` 相对引用，到没装 Homebrew 的机器上也能跑），所以双击启动的用户
三种音源都能选。

**打击乐限定为管弦乐编制**：大鼓、小军鼓、吊镲、三角铁，没有踩镲和嗵鼓，那是爵士鼓组的东西。定音鼓是有音高的乐器，走普通通道写主音／属音，不当鼓组音效。

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
  - agent.py：对话式 Agent 的上下文拼装（读 docs/USER_GUIDE.md，课程知识由前端传）
  - config.py：配置项与乐器目录
- frontend
  - src/App.tsx：页面路由与侧栏入口
  - src/pages：「指挥体验」下的文件、构型、生成、浏览、输出五页，「指挥教学」下的 TeachPage，以及不属于任何一级的训练、设置；外加手机端遥控页 RemotePage
  - src/components：波形、侧栏（两级导航）、右侧 Agent 面板、情绪柱状图、摄像头预览、图形拍型示范、讲评报告、二维码等 UI 组件
  - src/lib：音频引擎、传感器源、手势解析、摄像头指挥与 DTW 拍型识别（camera/）、教学（teaching/：课程数据、图形拍型、节拍器、录制层、六维评分）、指挥链路（conductLink）与 API 封装
  - src/styles/global.css：设计 token（配色、三个字体 token）；canvas 里的字体经 src/lib/canvasFont.ts 读同一份 token
- docs
  - CHANGELOG.md：完整版本记录
  - USER_GUIDE.md：用户使用指南，同时是应用内助手的知识来源
  - SYMBOLIC_COMPOSER_API.md：外部符号音乐模型的接入契约
  - M6_PLAN.md：M6（两级导航 + 指挥教学）的实施计划与进度
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

1. 打开「文件」页，新建项目，填项目名称与乐曲总时长，选生成方式。
2. 在「构型」页定段落结构与情绪曲线，增删乐器并给每件定声部。
3. 在「生成」页逐件乐器生成音频，同一件可以生成多条 take 再挑一条。
4. 在「浏览」页试听与检查，波形排在一起，可以单独播也可以一起播。
5. 在「输出」页点「开始指挥」。默认用摄像头，想用手机就先去「设置」页换成电脑模式，
   具体见下面「手机指挥」。

## 手机指挥

用什么设备打拍子在「设置」页选（设置 → 指挥 → 指挥方式），输出页上没有这个开关。
两种方式解析出来的是同一种「指挥意图」，声部逻辑、力度与速度的算法完全一样，
差别只在手势从哪儿采集。

| 方式 | 谁采手势 | 谁出声 | 需要什么 |
|------|---------|--------|----------|
| 摄像头模式（默认） | 这台电脑的摄像头 | 这台电脑 | 安全上下文，用 localhost 或 HTTPS 访问 |
| 电脑模式 | 手机 | 这台电脑 | 手机和电脑能互相连上 |

电脑模式的流程：设置页切到电脑模式 → 输出页显示房间码和二维码 → 手机扫码进入遥控界面
→ 电脑点「开始指挥」→ 挥动手机，声音从电脑放出。手机端只发传感器数据，不下载音频。

手机怎么连过来有两种方式，在「输出」页可以切换。**局域网**延迟最低，iPhone 需装一次证书。
**隧道**零安装，也不要求同一网络。

> 早先还有一个「单机模式」，手机自采自放。它已在 M7n 删掉：它和电脑模式做的是同一件事，
> 差别只在声音从哪儿出来，而手机扬声器放十四轨管弦乐本来就不该是这个软件的样子。

### 方式一：局域网，iOS 必须先启用 HTTPS

iOS 只在安全上下文里才允许 `DeviceMotionEvent.requestPermission()`。手机通过局域网 IP 走 http:// 访问时，Safari 连权限弹窗都不会出现。生成证书：

```bash
bash scripts/dev-certs.sh
```

脚本优先用 mkcert（推荐 `brew install mkcert`，签出的证书受系统信任），没有则用 openssl 自签名兜底。证书写到 `frontend/certs/`。

证书生成后 HTTPS **不会自动启用**。要用 HTTPS 启动（注意在 `frontend/` 目录下）：

```bash
cd frontend && npm run dev:https
```

> 换了 Wi-Fi 之后局域网 IP 会变，而证书里签的是生成时那一刻的 IP，手机会因证书不匹配连不上。重跑一次 `scripts/dev-certs.sh` 再重启即可（根证书不用在手机上重装）。「输出」页的局域网模式会自动检测这种情况并给出可复制的命令。

日常桌面开发继续用 `npm run dev`（HTTP）。这样区分是因为：如果「有证书就自动切 HTTPS」，所有 `http://localhost:5173` 的旧地址会静默失效，Safari 只报一句「服务器意外中断了连接」，很难联想到是协议变了。

用 mkcert 时手机还需要安装一次它的根证书（脚本会打印步骤）；用自签名证书则手机首次访问时点「继续访问」即可。

> 每台要连的 iPhone 都得装一次 mkcert 根证书，它是只有你自己设备信任的私有 CA。
> 要给多个人或多台手机演示的话，下面的隧道方案更合适，公开受信任证书，任何设备零安装。
> Android 上 Chrome 通常不强制 HTTPS，直接用 HTTP 就能拿到传感器数据。

### 方式二：隧道（不用证书，任何手机零安装）

「输出」页电脑模式里可以把配对方式从「局域网」切到「隧道」，页面会给出完整步骤。原理是用 cloudflared / ngrok 把本机暴露到公网，它们自带**公开受信任**的 HTTPS 证书，所以任何手机都不用装任何东西，也不要求和电脑在同一个网络。

前提是装了 cloudflared，并且 dev server 用 `dev:tunnel` 启动（原因见下）：

```bash
brew install cloudflared
cd frontend && npm run dev:tunnel
```

然后在「输出」页 → 电脑模式 → 隧道，**点「启动隧道」**即可：后端会代管 cloudflared 进程，拿到域名后自动填进输入框、二维码同步刷新，不需要你另开终端。再点一次「停止隧道」关闭。

走隧道时**不需要 mkcert 证书，也不需要 `dev:https`**，TLS 由隧道那一端终结。

其它情况：
- 没装 cloudflared 时，UI 会显示安装提示和可复制的手动命令，跑完把网址粘进输入框也一样能用（地址存在 localStorage，刷新不丢）。
- 直接用隧道域名在电脑上打开本页面时，UI 会自动识别并预填。
- 后端进程退出时会自动关掉它启动的隧道，避免机器在你不知情的情况下一直暴露在公网。

**为什么必须用 `dev:tunnel`**：Vite 会拒绝 Host 头不在允许列表里的请求（防 DNS 重绑定攻击），而 cloudflared 的临时隧道每次启动都是随机域名，没法提前写进配置，成了鸡生蛋。`MW_TUNNEL=1`（即 `dev:tunnel`）按**后缀**放行 `.trycloudflare.com`、`.ngrok-free.app`、`.ngrok.io`、`.ngrok.app`、`.loca.lt`，既不用提前知道具体域名，也保留了对其它域名的防护。

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

仓库里还留着旧版 legacy 生成接口，供兼容与参考。

## 说明

- ACE-Step 服务没启动时，应用仍然走 fallback 流程，前后端联调不受影响。
- 手机要用传感器就得走 HTTPS，用 mkcert 或隧道把本地服务暴露出去，见上面「手机指挥」。
- 摄像头指挥不需要联网，手部识别的模型与 WASM 运行时都在本地。

## 相关文档

| 文档 | 内容 |
|---|---|
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 完整版本记录与版本号规则 |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | 用户使用指南，同时是应用内助手的知识来源 |
| [docs/SYMBOLIC_COMPOSER_API.md](docs/SYMBOLIC_COMPOSER_API.md) | 外部符号音乐模型的接入契约 |
| [docs/M6_PLAN.md](docs/M6_PLAN.md) | M6 阶段（两级导航 + 指挥教学）的实施计划 |

## License

本项目采用 [MIT License](LICENSE)。

Copyright (c) 2026 Diankun Gao, Xingwen Zhao

第三方资产：`backend/soundfonts/orchestral.sf2` 由 [MIT 授权的 FluidR3_GM](https://github.com/urish/fluidsynth-manager/blob/master/fluid/FluidR3_GM.sf2)
裁切而来（见「音源」章节），其许可仍遵循原作品条款。

