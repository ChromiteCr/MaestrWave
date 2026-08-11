# 外部符号音乐模型接入契约

MaestrWave 的「写谱演奏」模式把**作曲**和**发声**拆开了：作曲器产出音符表，采样器
按谱子渲染成每件乐器一条 WAV。这份文档描述的是作曲器那一半的 HTTP 契约 ——
自己给任何符号音乐模型（Anticipatory Music Transformer、MMM、Music Transformer
之类）包一层薄服务实现它，后端一行都不用改。

对应实现：`backend/composer.py` 的 `RemoteSymbolicComposer`。

## 怎么接上

1. 起你的服务，监听一个**本机或局域网**地址，比如 `http://127.0.0.1:8002`。
2. 「设置」页 → 写谱 → 作曲器选「外部符号模型」，填地址。
   （只接受私网地址；要连公网服务得用 `SYMBOLIC_COMPOSER_URL` 环境变量启动后端。
   原因见下面「安全边界」。）
3. 「生成」页照常逐件乐器点生成。

## 端点

只有一个：

```
POST {base_url}/compose_part
Content-Type: application/json
```

超时 180 秒。**不重试** —— 重试一个跑了两分钟的推理请求只会让用户等更久。

### 请求体

```jsonc
{
  // 全曲蓝图。同一首曲子的每次调用都是同一份，可以缓存
  "blueprint": {
    "schema_version": 1,
    "revision": 1,
    "bpm": 92,
    "key": "D major",
    "time_signature": "4/4",
    "bars": 24,
    "beats_per_bar": 4,
    "exact_duration": 62.6,
    "sections": [
      { "id": "s1", "label": "引入", "start_bar": 1, "end_bar": 6, "intensity": 0.35 }
    ],
    // 每小节一个和弦，长度恒等于 bars
    "chords": ["D", "A/C#", "Bm", "G", "..."]
  },

  // 这一次要写哪件乐器
  "instrument": {
    "library_key": "cello",
    "display_name": "大提琴",
    "role": "bass",              // melody | harmony | bass | rhythm
    "gm_program": 42,            // GM 音色号，0 起
    "range": [36, 76],           // MIDI 音高上下限（保守的舒适音区，不是极限音域）
    "percussion": false,         // true 时 range 无意义，见下
    "active_bars": [1, 2, 3, 7]  // 这件乐器该出声的小节，来自构型的 participation
  },

  // 已经写好的其它声部，格式同响应里的 part。第一件乐器时是空数组
  "existing_parts": [ /* Part */ ],

  "style": "warm orchestral sketch",  // 用户填的风格描述，英文
  "seed": 123456                      // 同一件乐器点「重新生成」会换一个
}
```

### 响应体

```jsonc
{
  "notes": [
    [1, 1.0, 2.0, 50, 88],
    [1, 3.0, 1.0, 57, 72]
  ]
}
```

一个音符是定长数组 `[小节, 拍, 时值(拍), MIDI 音高, 力度]`：

| 位 | 含义 | 取值 |
|---|---|---|
| 0 | 小节 | 1 起，≤ `blueprint.bars` |
| 1 | 拍 | 1 起，可小数（`3.5` = 第 3 拍后半） |
| 2 | 时值 | 单位是拍，可小数 |
| 3 | 音高 | MIDI 音高；打击乐是**鼓件编号** |
| 4 | 力度 | 1~127 |

定长数组不是为了省事，是为了省 token：一首 32 小节 8 声部的曲子上千个音符，
写成 `{"bar":1,"beat":1,…}` 光键名就吃掉几千 token。

响应里除 `notes` 之外的字段都会被忽略，可以自由带调试信息。

## 你不用管的事

**不用管音符合不合法。** 后端一定会跑一遍 `score.validate_and_repair_part`，五条
确定性修复：

- 超出 `range` 的音高做**八度移位**，移不进去才丢弃（硬钳会把一句旋律压成一条直线）
- `beat` 吸附到 1/4 拍网格，`dur` 下限 1/8 拍
- `bar` 越界的丢弃
- 同声部同音高重叠时截短前一个（否则 note_off 会把后一个音也关掉）
- 限复音：旋律 2 / 和声 4 / 低音 2 / 打击乐 8，超出的按力度低者丢弃

修了什么会记进 take 并显示给用户（「3 处被修正：…」），所以**不要指望悄悄蒙混过去**，
但也不必自己实现这些规则。

**不用管和弦走向与段落结构。** 蓝图是后端本地算好的：符号模型擅长续写音符，不擅长
按段落强度规划全曲结构，后者恰好是纯规则做得又快又稳的部分。

**不用管渲染、时长对齐、循环接缝。** 那些都在采样器那一侧。

## 你需要管的事

- **只在 `active_bars` 里写音符。** 不在里面的小节应当留白 —— 那是构型里
  「这件乐器这一段不参与」的意思。写了也不会被丢（它不是校验规则），但配器会乱。
- **参照 `existing_parts`。** 这是这个模式相对「直接生成音频」的核心优势：符号域里
  「和已有声部配合」是真的成立的。别把每件乐器当成独立的一段来写。
- **打击乐（`percussion: true`）的音高是鼓件编号，不是音高**，不做八度移位，
  只接受这几个键（管弦乐编制，不是流行鼓组）：

  | 编号 | 乐器 | 编号 | 乐器 |
  |---|---|---|---|
  | 35 | 大鼓 | 55 | 小吊镲 |
  | 38 | 小军鼓 | 80 | 三角铁（闷音）|
  | 49 | 吊镲 | 81 | 三角铁 |
  | 52 | 中国钹 | | |

  不在表里的键会被丢弃并记一条修正。定音鼓（`timpani`）反过来是**有音高的**，
  走普通通道和普通音域规则。

## 出错怎么办

返回任意非 2xx 状态码即可。后端会：

1. 把这次生成标成失败，在界面上显示「连不上符号模型服务」或「服务返回 HTTP 5xx」；
2. **不会**自动退回规则作曲 —— 这一点和 LLM 通路不同。选了外部模型却悄悄拿规则
   作曲的结果糊弄过去，你就再也判断不了这个模型到底行不行。

响应体不是合法 JSON、或者 `notes` 不是数组时，校验层会把它当成空谱处理并记一条修正。

## 安全边界

设置页只接受**私网地址**（`localhost` / `127.x` / `10.x` / `192.168.x` /
`172.16-31.x` / `*.local`）。这条限制的对象不是你，是隧道：`tunnel.py` 一开，
后端就暴露在公网上，而这个地址决定了后端会把整份乐谱 POST 到哪里去 —— 能通过
接口随手改成任意外网地址的话，它就是一条现成的数据外传通道。

和 `llm.py` 的「主机白名单只能手工编辑配置文件添加、不能通过接口添加」是同一条线。
确实要连公网服务时，用环境变量启动后端：

```bash
SYMBOLIC_COMPOSER_URL=https://your-service.example.com SCORE_COMPOSER=remote python3 -m uvicorn backend.app:app
```

那是启动时的运维决定，不是一个能被远程改写的运行时开关。

## 最小实现

```python
# pip install fastapi uvicorn
from fastapi import FastAPI

app = FastAPI()

@app.post("/compose_part")
async def compose_part(req: dict):
    bp = req["blueprint"]
    lo, hi = req["instrument"]["range"]
    root = 60  # 真实实现这里换成你的模型
    notes = []
    for bar in req["instrument"]["active_bars"]:
        for beat in (1.0, 3.0):
            pitch = max(lo, min(hi, root))
            notes.append([bar, beat, 2.0, pitch, 80])
    return {"notes": notes}
```

```bash
uvicorn stub:app --port 8002
```

设置页填 `http://127.0.0.1:8002`，选「外部符号模型」，就能在「生成」页听到它了。
