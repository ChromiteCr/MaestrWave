# M6：两级导航 + 指挥教学模式

> 这份是 M6 的实施计划原文，放进仓库供随时查阅。**下面的「实施顺序」一节是进度真源**，
> 每完成一步就在那里勾掉；正文其余部分是计划制定时的判断与依据，除非结论被推翻否则不改
> —— 改了就看不出「当初为什么这么定」。

## 进度

| 步骤 | 状态 | 说明 |
|---|---|---|
| 1. Serif 字体 | ✅ 已完成（M6） | 顺带换了品牌图标 |
| 2. 两级导航 | ✅ 已完成（M6b） | 一级归属改为从 `activePage` 推导，见下方偏离说明 |
| 3. 课程数据 + 讲解/示范 | ✅ 已完成（M6d） | 11 课静态数据 + 图形拍型动画，不依赖后端与摄像头 |
| 4. 练习曲端点 | ⏳ 未开始 | 等指令 |
| 5. 录制层 + 评分 | ✅ 已完成（M6f） | 用节拍器当拍网格，不等音频；「力度对应」一维待音频接入 |
| 6. 手机传感器兜底 | ❌ 已砍掉 | 教学与考试纯用摄像头，见下方原因 |
| 7. 对话式 Agent 入口 | ⏳ 未开始 | 计划制定后追加，见下方独立一节 |

**与计划的偏离（第 2 步）**：计划写的是「store 新增 `section`」，实际改成**从 `activePage` 推导**
（`PAGE_SECTION` 表）。存两份就得让每一处 `setActivePage` 记得同步，而跨页跳转有 4 处，
少一处就是一个「侧栏高亮和内容对不上」的 bug。另存的 `navSection` 只管「展开哪一级的
二级列表」，跳到训练/设置时刻意不变。结果是计划里「4 处跨页跳转都要带上 section」这项
工作直接消失了。

**与计划的偏离（第 3 步）**：计划把「基本拍型(2/3/4)」当作一课，实际也是一课，但
示范组件带拍号切换，一课里能看三种拍型。另外 `patterns.ts` 的 `rebound` 一开始被
当成二次贝塞尔的**控制点**用，而贝塞尔不经过控制点 —— 写着 0.84 的「反弹顶点」实际
只到 0.48。是把画出来的曲线量了一遍才发现的，现在反解控制点让曲线真的经过它，并加了
断言。口诀（下/左/右/上）也从拍点标注里拿掉了：它描述的是整拍动作的走向，标在拍点上
会误导（第 4 拍叫「上」，它的拍点却在平面上），改为标在两个拍点之间的箭头旁。

**与计划的偏离（第 5 步）**：计划把第 5 步排在第 4 步之后，实际**跳过第 4 步先做**，
用节拍器当拍网格。理由是反馈回路 —— 练习曲要配密钥、每次迭代一次云端调用加几十秒等待，
而评分的核心（DTW、六维计算）是纯函数，用合成轨迹离线验证一秒一轮。更关键的是：
节拍器是我们自己排的严格网格，**网格原点是写下的常数，不需要检测音频起始点**，
评分反而比接了音乐更干净。计划里第 4 步的「能量起始点检测 + 手动校准」因此暂时用不上，
等真接音乐时再做。

`useConductor` 的三项改动（锁 1× 播放、暴露起播锚点、逐帧回调）也**没有做** ——
跟练放的是节拍器不是项目音轨，根本没走 `useConductor`。那三项是「用真实音乐跟练」
才需要的，属于第 4 步接上音乐之后的工作。

**第 6 步已砍掉（2026-08-10 决定）**：教学与考试**纯用摄像头**，不做手机传感器兜底。

原因有两条，都是做到一半才看清楚的：

1. **能评的维度太少，分数会失真。** 六个维度里有三个（拍型准确度、平面一致性、
   拍点清晰度）需要手在空间里的位置，而加速度计只有加速度、给不出位置。手机兜底
   实际只剩「拍点准确度」和「速度稳定性」两维 —— 那已经不是「同一套评分」，
   拿它和摄像头的分数放在一起比是误导。
2. **两种形态都有硬伤。** 在手机上直接打开教学页：项目里**没有任何移动端断点**，
   侧栏是写死的 196px，375px 宽的手机只剩 179px 内容区，而且挥着手机根本看不到
   示范和当前拍号。手机当遥控（电脑显示）：要把「输出」页那整套配对 UI
   （局域网/隧道切换、网络地址探测、cloudflared 启停）抽成共用组件，成本不小，
   收益仍然只有那两个维度。

已写了一半的 IMU 采样通路（`GestureInterpreter.lastIctusAt`、`IntentSource.onSample`、
评分里的「无位置」分支）**全部回退了** —— 留着就是没人用的死代码，而且会让
`ConductSample` 这个只有摄像头产出的结构看起来像是通用的。`ConductSample` 回到
`camera/cameraIntentSource.ts`，也就是它唯一的产地。

## 追加需求：「考试」模式（并入第 5 步）

> 这一节也是计划定稿之后追加的。

「指挥教学」下除「课程」外再加一项**「考试」**：用**固定的示例歌曲**给用户打分，摄像头采集。

**为什么必须和课程里的跟练分开**：练习曲是现场按本课需要生成的，每次都不一样 ——
分数没法横向比，也没法说「你比上次好了」。考试用同一批曲目、同一个速度、同一个拍号，
分数才有意义。所以考试曲目**不走** `/api/practice/generate`，而是随应用附带的音频文件。

- 曲目数据在 `lib/teaching/exam.ts`，三首覆盖三个难度：进行曲（四拍，只考跟得上）、
  圆舞曲（三拍 + 渐强，左手开始做事）、抒情段落（弱起 + 延音 + 渐慢，三个单元一次全考）。
- `audio` 字段显式留成 `null` 表示「曲目未就绪」，UI 明说，而不是摆一个点了没反应的按钮。
- **摄像头自检先做**，因为它现在就能做：环境检查（安全上下文 / 浏览器支持）、开摄像头、
  认手、看帧率，全部复用 M5 的 `HandTracker` 与 `CameraPreview`。考前该踩的坑当场踩完。
- 及格 70 / 优秀 85。定得不高是因为初学者跟着音乐打拍时，人的听觉—动作延迟本身就有
  几十毫秒，要求太严会把「已经能带起乐队」的人判成不及格。**真机试考后按实际分布回调。**

**还缺**：示例歌曲的音频（录制还是生成后固化？）、录制层、DTW 拍型识别、六个维度的
计算与讲评页 —— 都是第 5 步本来就要做的东西，考试页是它们的落地处。

## 追加需求：对话式 Agent 入口（第 7 步）

> 这一节是计划定稿之后追加的，不在原来的六步里。

**要什么**：右侧一个**可折叠**的对话侧栏，用户随时能问「这个手势怎么打」「这一页的
按钮是干嘛的」，不用离开当前页面去翻文档。

- **模型接入走已有的 BYOK**（`backend/llm.py`），**不新开一条通道**。密钥只存后端、
  文件权限 600、在 `.gitignore` 里、任何接口都不回显明文；`base_url` 走严格主机名
  白名单（不是子串包含）；隧道运行时要求本机令牌。这些约束是 M4d 定的，Agent
  一样适用 —— 它比构型页调用得更频繁，更需要限流。
- **Agent 能看到三类上下文**：
  1. **指挥知识库** —— 与教学模式的 `lib/teaching/curriculum.ts` 同源，不另写一份。
     两份必然漂移，而漂移的结果是「Agent 教的和课程教的不一样」。
  2. **项目操作使用方法** —— 需要一份写给用户看的操作文档作检索源。
     `docs/USER_GUIDE.md` 应该就是这份，接入前先确认它覆盖了各页面的实际操作。
  3. **软件本身的当前状态** —— 当前项目、构型、乐器、生成任务进度等，
     这样「我的小提琴怎么没声音」才答得上来。
- **一级导航之外**：它是常驻的辅助面板，不属于「指挥教学」也不属于「指挥体验」，
  所以放右侧、可折叠，而不是做成侧栏里的第三个一级项。

**待定**：排在第 6 步之后，还是插进教学模式里一起做（教学场景下「随时能问一句」的
价值最大）。以及第 3 类上下文要喂多少 —— 整个 project JSON 塞进去会很贵，多半需要
挑字段。

## Context

现在的应用只有一条工作流：建项目 → 构型 → 生成 → 浏览 → 输出（指挥）。它默认用户**已经会指挥**——但体感指挥对绝大多数人是全新的动作，没人告诉他"拍点该打在哪、左手该干什么、什么算打得准"。M5 刚把摄像头指挥做通，手部信号已经足够支撑客观评价，这是加教学的时机。

**目标产出**：

1. 导航改成两级：一级「指挥教学」/「指挥体验」，现有七个页面全部归入「指挥体验」。
2. 新增「指挥教学」：按行业标准编排的初学者课程，摄像头为主、手机传感器为辅，现场用天琴 API 生成针对当前课程的练习曲，指挥后按可量化的标准打分讲评。
3. UI 全部改为 Serif 字体。

**版本号 M6**。M5（摄像头指挥）尚未完成的 DTW 图形拍型识别**并入本版本**——教学的"拍型准确度"评分本来就需要它，两处需求是同一件事。

## 已确认的决策

| 项 | 决定 |
|---|---|
| 教学范围 | ConductIT 的**单元一、二、三**：姿势 → 预备拍 → 基本拍型(2/3/4) → 收拍 → 非持棒手 → 主动拍/被动拍 → 打1拍 → 从非第一拍起 → 延音 → 力度 → 渐慢渐快 |
| 练习曲 | **只现场生成**，但在用户开始浏览本课教程时就**后台启动生成**，用学习时间掩盖等待 |
| 评分基准 | 以音乐为准（要"跟上乐队"）。提示词里**强要求 BPM 准确**，并**允许架子鼓/定音鼓等打击乐**降低跟拍难度 |
| 拍网格相位 | 三管齐下：提示词要求开头带**数拍(count-in)** + 对音频做**能量起始点自动检测** + 置信度低时让用户**跟拍手动校准** |
| 一级导航形态 | **侧栏加宽显示文字** |
| 字体 | UI 全部改 Serif |

---

## 已核实的技术约束（决定了方案形状）

**一、教学模式必须锁定 `playbackRate = 1`。**
`playheadSeconds()`（[audioEngine.ts:122](frontend/src/lib/audioEngine.ts:122)）是「墙钟经过时间对 buffer 时长取模」，**完全不感知 `playbackRate`**。而指挥模式每帧都在写 `setPlaybackRate(params.tempo)`（[useConductor.ts:57](frontend/src/lib/useConductor.ts:57)），速率一旦偏离 1 就持续发散、误差不可恢复。评分靠播放头对齐拍网格，这个漂移会毁掉评分。

好在这不是妥协而是**教学与体验的本质区别**：体验模式里指挥控制乐队的速度；教学模式里音乐就是「乐队」，学生要**跟上它**。锁定 1× 既解决漂移，也正是教学该有的语义。

**二、两个时钟域没有对齐代码。**
手部数据用 `performance.now()`（`HandFrame.t`），音频用 `AudioContext.currentTime`，两者之间目前没有任何映射。`playAll()` 内部的 `ctx.currentTime + 0.05` 是唯一的音频零点，但它**没有被返回或存下来**。评分要在起播时记录一对 `(performance.now(), ctx.currentTime)` 作为锚点。

**三、`ConductIntent` 没有时间戳，拍点历史留不住。**
`conductingModel` 的 `lastIctusAt` 是 public 但只有最后一次；`traj` 只滚动保留 1200ms 且是 private。评分需要整段的拍点序列与轨迹 —— 录制层是必需的，不是锦上添花。

**四、`ConductingModel.reset()` 漏重置一批状态**（`lastIctusAt`、`lastBeatAt`、`bpm`、`lastY`、`activeSince` 等）。教学要反复重练，上一次的状态会带进下一次。**这是个已有 bug，本版本顺手修掉。**

**五、`synth.py` 不能当节拍器。**
它的 percussion 每拍有 **10% 概率被跳过**（`random.random() < trigger`），且随机种子用 `hash(str)`、跨进程不可复现。要节拍器就得另写一个严格网格的，几十行的事。

**六、生成练习曲确实需要新端点。**
`/api/generate` 虽不需要 project，但它**绕过了 `get_backend()`**（`stems.py` 直接 `ACEStepGenerator()`），`GENERATION_BACKEND=tme` 对它完全无效，而且一次产 6 轨。好消息是库层面 `TMEBackend().text2music(...)` 和 `build_tags(...)` 都只吃裸参数、不依赖 project 结构，新端点直接调它们即可。

另外 `build_tags` 已经在拼 `"strict steady tempo"`，你要的「强要求 BPM 准确」有基础了，缺的是 count-in 和打击乐这两条，扩展它即可。

---

## 一、两级导航

现状约束（已核实）：侧栏是 64px 纯图标栏，无文字无分组（[Sidebar.tsx:6-17](frontend/src/components/Sidebar/Sidebar.tsx:6)、`.rail` 宽度写死 64px）；`PageId` 是七元联合类型（[store.ts:4](frontend/src/state/store.ts:4)）；`App.tsx` 的 `PAGES` 是普通对象字面量、靠 `PAGES[activePage]` 结构推断——**给 `PageId` 加成员却不加 `PAGES` 键会直接编译报错**，这是好事，编译器会替我们兜住。

设计：

- store 新增 `section: "teach" | "perform"`，`PageId` 扩展教学侧的页面；`activePage` 保持单一真源，切一级时跳到该一级的默认页
- 侧栏加宽到约 200px：Logo → 一级两项（带文字）→ 分隔线 → 当前一级下的二级项（图标 + 文字）
- **七个页面的 `.body` 都是左右 40px 内边距**（与 PageHeader 对齐），侧栏变宽后内容区变窄，但七个页面用的都是 `max-width` 或自适应 grid，不需要逐页改
- `?conduct=` 与 `?debug=conduct` 两个 query 分支绕开侧栏，不受影响（[App.tsx:48-54](frontend/src/App.tsx:48)）
- 跨页跳转有 4 处 `setActivePage`（FilePage 打开项目、FormationPage 应用到生成页与去设置、BrowsePage 编辑），都要带上 section

新增图标：教学、体验两个一级图标，加进 [icons.tsx](frontend/src/components/icons.tsx)。

## 二、教学模式

### 课程数据

课程是**静态数据**（`frontend/src/lib/teaching/curriculum.ts`），不走后端、不需要联网。每课包含：

```ts
interface Lesson {
  id: string;
  unit: 1 | 2 | 3;
  title: string;              // 如「四拍图形拍型」
  goal: string;               // 一句话说清这节课要练成什么
  standard: string;           // 行业标准依据原文（教学价值在这里）
  meter?: 2 | 3 | 4;          // 本课练哪个拍号
  bpm: number;
  /** 生成练习曲用的提示词模板，强调 BPM 准确 + 打击乐 + count-in */
  practicePrompt: string;
  /** 本课评哪几个维度、及格线多少 */
  rubric: RubricItem[];
}
```

单元一二三共约 11 课。内容依据 ConductIT 的章节顺序（先把右手拍型"locked in"，再谈手的独立性）。

### 每课的流程

```
讲解（标准原文 + 图示）
  └─ 打开本课的瞬间就 POST 练习曲生成，拿到 job_id
示范（图形拍型动画，canvas 画标准轨迹 + 拍点标记）
跟练（摄像头，实时显示你的轨迹叠在标准轨迹上）
  └─ 练习曲此时通常已经好了；没好就先跟节拍器练
评分与讲评
```

**图形拍型的标准轨迹**（指挥自己视角，已查证）：

| 拍号 | 方向序列 |
|---|---|
| 2 拍 | 下 → 右上 |
| 3 拍 | 下 → 右 → 上（三角） |
| 4 拍 | 下 → 左 → 右 → 上 |

这套轨迹一物三用：示范动画、跟练时的参考叠加、评分时 DTW 的模板。

### 练习曲生成

**必须新增一条轻量端点。** 现有两条路都不合适：`/api/projects/{id}/instruments/{iid}/generate` 强依赖 project + instrument；`/api/generate`（[app.py:254](backend/app.py:254)）虽然不需要 project，但走的是旧 session 流程，一次生成 full_mix + 5 条固定分轨共 **6 次模型调用**，做一首练习曲太重。

新增 `POST /api/practice/generate` → `{job_id}`，`GET /api/practice/{job_id}` 轮询：

- 直接调 `TMEBackend().text2music(...)`，**不经 project**（它只吃裸参数，不依赖 project 结构）
- 时长短（30~45 秒足够练一段）
- 扩展 `build_tags`（[tme_backend.py:67](backend/tme_backend.py:67)）加两条：**含打击乐**（架子鼓/定音鼓，你要的降低跟拍难度）、开头**一小节数拍 count-in**。它已有的 `"strict steady tempo"` 保留
- 结果缓存到磁盘并按 `(lesson_id, bpm, meter)` 复用——同一课重练不该重新生成
- 天琴轮询上限 300 秒、间隔 5 秒（[config.py:29-30](backend/config.py:29)），前端轮询要覆盖这个量级
- **返回时一并给出 `downbeat_offset` 与检测置信度**（见下文拍网格）

`_transcode` 会把音频裁到指定时长、44.1kHz 单声道（[tme_backend.py:249](backend/tme_backend.py:249)），练习曲直接复用，不用改。

**节拍器兜底**：生成未完成时先用节拍器练。`synth.py` 的 percussion 每拍有 10% 概率漏拍、不能用（见约束五），需另写一个严格网格的节拍器合成（几十行，或前端用 Web Audio 直接排 `OscillatorNode`，后者更准且零后端往返 —— 推荐后者）。

**用户浏览教程时就启动生成**：进入课程页即发起，UI 上用一个不打断的进度条表示"练习曲准备中"，讲解和示范阶段照常进行。

## 三、评分

### 先解决拍网格

评分要把用户的拍点和音乐的拍点对齐，需要**速度**和**相位**两样：

- **速度**：信任请求的 BPM（提示词强要求）
- **相位**：对生成的音频做能量起始点检测，找出第一个强拍。这一步之所以可行，正是因为练习曲里有打击乐——纯管弦乐的能量包络很糊，有鼓就清楚得多
- **兜底**：检测置信度低时，UI 让用户跟着音乐点几下，取中位数定相位

检测放后端（生成时算一次，随音频一起返回 `downbeat_offset` 与置信度），前端不用重复算。可复用 `backend/audio_utils.py` 的 `read_wav_samples`。

### 评分维度

全部可从现有信号直接算出，且每一条都有标准依据：

| 维度 | 怎么算 | 依据 |
|---|---|---|
| 拍点准确度 | 用户 ictus 与拍网格的时间偏差（平均绝对误差） | ictus 是"the definite point of placement of the beat"，提供 clarity 与 predictability |
| 速度稳定性 | 相邻拍间隔的变异系数 | "Changes to the tempo are indicated by changing the speed of the beat"——不该变的时候就不能变 |
| 拍型准确度 | 轨迹与标准图形拍型的 DTW 距离 | 单元一 1.5 基本拍型 |
| 拍点清晰度 | 拍点处速度反转的锐度 | ictus 由"a slight touch of the wrist"给出，要能被看出来 |
| 平面一致性 | 各拍点高度的离散程度 | 教材强调 conducting plane |
| 力度对应（单元三） | 拍型大小与乐曲力度的相关性 | "dynamic indicated by the size of the preparation" |

前四项在单元一二就能评，后两项进单元三。

文献承认人工评审主观性高、"often due to poor descriptions"——这恰好是用客观指标打分的理由，也是讲评时要给出**具体数字 + 具体建议**而不是一个笼统分数的理由。

### 信号来源与时钟对齐

跟练期间加一个**录制层**，把 `{t, 手部坐标, 是否拍点, effort}` 逐帧存进内存，结束后一次性分析。这层同时服务回放讲评。

时钟对齐是评分能不能成立的前提（见上文约束二）：起播时记录锚点 `t0_perf ↔ t0_ctx`，之后

```
音乐时刻 = (手势时刻_perf - t0_perf) / 1000 - 0.05   // 0.05 是 playAll 的预约提前量
拍序号   = (音乐时刻 - downbeat_offset) / (60 / bpm)
```

因为教学模式锁 1× 播放，这个换算全程有效，不会漂。

DTW 拍型分类器（M5 欠的）在这里落地，做成可插拔接口，方便之后换成你另外训练的模型。

### 教学模式对现有指挥链路的改动

`useConductor` 现在是「手势驱动音量 + 手势驱动速度」。教学模式要的是「音乐固定速度、手势只驱动音量、同时记录」，所以给它加一个模式开关：

- `lockPlaybackRate`：不再调 `setPlaybackRate`，锁 1×
- 暴露起播锚点 `(t0_perf, t0_ctx)` 供评分换算
- 可选的 `onFrame` 回调给录制层

体验模式的行为完全不变。

## 四、Serif 字体

现在三个字体 token 都是无衬线/等宽（[global.css:33-35](frontend/src/styles/global.css:33)）：Space Grotesk（display）、Inter（body）、IBM Plex Mono（mono）。

- UI 是中文为主，**必须同时换 CJK serif**，否则中文会掉到系统默认字体。用 `@fontsource/noto-serif-sc` + 一款拉丁 serif（如 Source Serif 4），CJK 字体走 @fontsource 的 unicode-range 分片，只加载用到的区段
- 改动集中在 `global.css` 的三个 token 与 `main.tsx` 的字体 import，各组件不用动（都引用的是 token）
- **一处要留意**：`--font-mono` 用在情绪柱状图刻度、时间码、`.mono-chip` 这些**需要数字等宽对齐**的地方。换成 serif 后数字会不等宽、表格和图表会参差。计划里按你说的"全部改"执行，但把 mono 单独留成一个 token，觉得不对时改一行就能退回

## 五、实施顺序

1. **Serif 字体**——独立、风险低、立刻能看到，先做完确认观感
2. **两级导航**——store 加 section、侧栏加宽、七个页面归入「指挥体验」。此时教学侧只放一个占位页
3. **课程数据 + 讲解/示范**——静态内容 + 图形拍型动画，不依赖后端也不依赖摄像头，可独立验证
4. **练习曲端点**——`/api/practice/generate` + 缓存 + 起始点检测。依赖天琴密钥已配
5. **录制层 + 评分**——跟练录制、DTW 拍型分类器、六个维度打分、讲评页
6. **手机传感器兜底**——没有摄像头时用手机 IMU 走同一套评分（拍点与速度稳定性可评，拍型与平面无法评，要在 UI 上说清楚）

第 1–3 步不依赖任何外部服务，可以先完整交付。

## 关键文件

**新增**
- `frontend/src/lib/teaching/curriculum.ts` — 课程数据
- `frontend/src/lib/teaching/patterns.ts` — 标准图形拍型轨迹（示范/参考/DTW 模板三用）
- `frontend/src/lib/teaching/recorder.ts` — 跟练录制
- `frontend/src/lib/teaching/scoring.ts` — 六维评分
- `frontend/src/lib/camera/beatPattern.ts` — DTW 拍型分类器（可插拔接口）
- `frontend/src/pages/Teach*/` — 课程列表、课程详情、讲评三个页面
- `backend/practice.py` — 练习曲生成、缓存、起始点检测

**修改**
- [useConductor.ts](frontend/src/lib/useConductor.ts) — 教学模式开关：锁 1× 播放、暴露起播锚点、逐帧回调
- [conductingModel.ts](frontend/src/lib/camera/conductingModel.ts) — 补齐 `reset()` 漏掉的状态（已有 bug）
- [tme_backend.py](backend/tme_backend.py) — `build_tags` 加打击乐与 count-in
- [store.ts](frontend/src/state/store.ts) — 加 `section`，扩展 `PageId`
- [Sidebar.tsx](frontend/src/components/Sidebar/Sidebar.tsx) + CSS — 加宽、两级、文字
- [App.tsx](frontend/src/App.tsx) — `PAGES` 加教学页面
- [icons.tsx](frontend/src/components/icons.tsx) — 两个一级图标 + 课程相关图标
- [global.css](frontend/src/styles/global.css) — 三个字体 token
- [app.py](backend/app.py) — 练习曲端点
- [audio_utils.py](backend/audio_utils.py) — 起始点检测（复用 `read_wav_samples`）
- [README.md](README.md) — M6 版本记录

## 验证

1. `cd frontend && npm run typecheck && npm run build` —— 每步都要过
2. **导航回归**：七个页面在「指挥体验」下全部可达，跨页跳转（打开项目、应用到生成页、编辑乐器）仍正确；`?conduct=` 与 `?debug=conduct` 不受影响
3. **字体**：中英文都确认用上 serif，检查情绪柱状图刻度与 `.mono-chip` 的数字对齐是否可接受
4. **课程页**：不配天琴密钥、不开摄像头，讲解与示范动画应完全可用
5. **练习曲**：确认后台生成在讲解期间完成；同一课重练走缓存不重新生成
6. **拍网格**：用一段已知 BPM 的音频验证起始点检测；故意用检测不准的素材验证手动校准入口
7. **评分**：用合成的手部轨迹（复用 M5 的 harness 思路）喂进评分器，验证"完美拍型"得高分、"拖拍/抢拍"在拍点准确度上扣分、"拍型走样"在 DTW 维度上扣分
8. 真机端到端：摄像头走完一课，确认评分与讲评合理

按全局规则，改动落地时在 [README.md](README.md) 版本记录表最上方加 M6 条目。
