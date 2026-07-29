# MTX Project: AI-Powered Orchestral Conducting Experience

## 项目概述

一个两阶段的交互式音乐体验系统：

1. **阶段一：AI预生成素材** — 用户通过文字描述定义音乐方向，AI（ACE-Step 1.5 + LoKr微调）生成多轨分声部音频
2. **阶段二：体感指挥演绎** — 用户手持手机（陀螺仪+加速度计）充当指挥棒，实时控制各声部的混音

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│  阶段一：AI音频生成流水线                                      │
│                                                              │
│  用户描述 ──→ ACE-Step 1.5 ──→ 多轨分声部音频                  │
│  (风格/情绪/     (LoKr微调)     ├─ 小提琴                      │
│   节奏描述)                     ├─ 大提琴                      │
│                                 ├─ 小号                       │
│                                 ├─ 木管                       │
│                                 ├─ 打击乐                     │
│                                 └─ (人声声部)                  │
│                                                              │
│  试听 → Repainting修正(如需) → 最终分轨导出                    │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  阶段二：实时指挥引擎                                          │
│                                                              │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │ 传感器   │───→│ 手势解析     │───→│ 音频混音器       │   │
│  │ 输入层   │    │ 模块         │    │ (Web Audio API)  │   │
│  └──────────┘    └──────────────┘    └──────────────────┘   │
│       │                │                      │              │
│  DeviceMotion    映射引擎：              输出：               │
│  DeviceOrientation • 方向→声部         • 空间化音频          │
│  + 踏板输入        • 速度→力度         • 实时混音            │
│                    • 频率→速度         • 视觉反馈            │
│                    • 幅度→密度                               │
│                    • 手势→表情                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 音乐生成 | ACE-Step 1.5（本地部署，LoKr 微调适配器） |
| 后端 | Python / FastAPI |
| 前端 | HTML5 + Vanilla JS |
| 传感器采集 | Web DeviceMotion / DeviceOrientation API |
| 动作识别 | 规则引擎 + 轻量1D-CNN |
| 音频混合 | Web Audio API 实时混音 + HRTF 空间化 |
| 踏板 | 蓝牙 HID 或第二部手机 |

---

## ACE-Step 1.5 本地环境

- **已部署**：ACE-Step 1.5 本地安装完成
- **API 启动方式**：`uv run acestep-api`（默认 `http://localhost:8001`）
- **LoKr 适配器**：已用 8 首管弦乐作品完成 LoKr 训练，权重文件在本地
- **参考仓库**：https://github.com/ace-step/ACE-Step-1.5/

### ACE-Step API 核心能力

| 功能 | 用途 |
|------|------|
| 文本条件生成 | 根据 caption + 歌词/结构标签生成音频 |
| Reference Audio | 以参考音频引导生成风格 |
| Repaint | 局部重新生成指定时间段 |
| LoRA/LoKr 加载 | 运行时加载微调权重 |
| 元数据控制 | 指定 BPM、调式、拍号、时长 |

---

## 项目文件结构

```
mtx-conductor/
├── backend/
│   ├── app.py              # FastAPI 后端主入口
│   ├── generator.py        # ACE-Step API 调用封装
│   ├── stems.py            # 分轨生成逻辑
│   └── config.py           # 配置（API地址、LoKr路径等）
│
├── frontend/
│   ├── index.html          # 主页面（包含阶段一和阶段二两个视图）
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── app.js          # 主控制器（协调各模块）
│       ├── stage1.js       # 阶段一：生成界面逻辑
│       ├── stage2.js       # 阶段二：指挥界面逻辑
│       ├── sensor.js       # 传感器数据采集模块
│       ├── gesture.js      # 手势解析模块
│       └── audio-engine.js # Web Audio 混音引擎
│
├── output/                 # 生成的音频文件存放
│   └── sessions/
│       └── {session_id}/
│           ├── full_mix.wav
│           ├── violin.wav
│           ├── cello.wav
│           ├── trumpet.wav
│           ├── woodwind.wav
│           └── percussion.wav
│
└── README.md
```

---

## 模块详细设计

### 1. 后端：`backend/config.py`

```python
ACESTEP_API_URL = "http://localhost:8001"
LOKR_WEIGHTS_PATH = "/path/to/your/trained/lokr/weights"  # 修改为实际路径
OUTPUT_DIR = "../output/sessions"

# 分声部生成的 caption 模板
# {style} 会被用户输入的描述替换
STEM_PROMPTS = {
    "violin": "Solo violin melody, orchestral, legato, expressive vibrato, {style}",
    "cello": "Cello section, orchestral bass and harmony, rich warm tone, {style}",
    "trumpet": "Brass section with trumpet lead, orchestral fanfare, bold and majestic, {style}",
    "woodwind": "Woodwind ensemble, flute and oboe, light and airy countermelody, {style}",
    "percussion": "Orchestral percussion, timpani and cymbals, rhythmic foundation, {style}",
}
```

### 2. 后端：`backend/generator.py`

封装对 ACE-Step API 的调用：

```python
import httpx
import asyncio
from pathlib import Path
from config import ACESTEP_API_URL, LOKR_WEIGHTS_PATH

class ACEStepGenerator:
    def __init__(self):
        self.api_url = ACESTEP_API_URL
        self.client = httpx.AsyncClient(timeout=300)  # 生成可能需要较长时间

    async def generate(self, prompt: str, lyrics: str = "[Instrumental]",
                       duration: int = 60, bpm: int = 80,
                       key: str = "D major", seed: int = -1) -> bytes:
        """调用 ACE-Step API 生成单条音频"""
        payload = {
            "prompt": prompt,
            "lyrics": lyrics,
            "duration": duration,
            "bpm": bpm,
            "keyscale": key,
            "time_signature": "4",
            "lora_path": LOKR_WEIGHTS_PATH,
            "num_samples": 1,
            "steps": 50,
            "seed": seed,
        }

        resp = await self.client.post(f"{self.api_url}/generate", json=payload)
        resp.raise_for_status()
        return resp.content  # 返回音频二进制数据

    async def generate_with_reference(self, prompt: str, reference_audio_path: str,
                                       **kwargs) -> bytes:
        """使用参考音频引导生成（用于保持分轨一致性）"""
        payload = {
            "prompt": prompt,
            "reference_audio": reference_audio_path,
            "lora_path": LOKR_WEIGHTS_PATH,
            **kwargs
        }
        resp = await self.client.post(f"{self.api_url}/generate", json=payload)
        resp.raise_for_status()
        return resp.content

    async def repaint(self, audio_path: str, prompt: str,
                      start_time: float, end_time: float) -> bytes:
        """Repainting: 局部重新生成"""
        payload = {
            "audio_path": audio_path,
            "prompt": prompt,
            "repaint_start": start_time,
            "repaint_end": end_time,
            "lora_path": LOKR_WEIGHTS_PATH,
        }
        resp = await self.client.post(f"{self.api_url}/repaint", json=payload)
        resp.raise_for_status()
        return resp.content
```

### 3. 后端：`backend/stems.py`

分轨生成的完整流程：

```python
import asyncio
from pathlib import Path
from generator import ACEStepGenerator
from config import STEM_PROMPTS, OUTPUT_DIR

class StemGenerator:
    def __init__(self):
        self.gen = ACEStepGenerator()

    async def generate_full_session(self, user_description: str,
                                     duration: int = 60, bpm: int = 80,
                                     key: str = "D major") -> dict:
        """
        完整的分轨生成流程：
        1. 生成完整混音（指挥轨）作为参考
        2. 以指挥轨为参考，逐一生成各声部分轨，保证一致性
        """
        import uuid
        session_id = str(uuid.uuid4())[:8]
        session_dir = Path(OUTPUT_DIR) / session_id
        session_dir.mkdir(parents=True, exist_ok=True)

        # Step 1: 生成完整混音作为参考
        full_prompt = f"Full orchestral ensemble, {user_description}"
        full_audio = await self.gen.generate(
            prompt=full_prompt, duration=duration, bpm=bpm, key=key
        )
        full_path = session_dir / "full_mix.wav"
        full_path.write_bytes(full_audio)

        # Step 2: 以完整混音为参考，生成各分轨
        stems = {}
        for instrument, prompt_template in STEM_PROMPTS.items():
            prompt = prompt_template.format(style=user_description)
            stem_audio = await self.gen.generate_with_reference(
                prompt=prompt,
                reference_audio_path=str(full_path),
                duration=duration,
                bpm=bpm,
                keyscale=key,
            )
            stem_path = session_dir / f"{instrument}.wav"
            stem_path.write_bytes(stem_audio)
            stems[instrument] = str(stem_path)

        return {
            "session_id": session_id,
            "full_mix": str(full_path),
            "stems": stems,
        }
```

### 4. 后端：`backend/app.py`

FastAPI 主入口，提供 REST API + 静态文件服务：

```python
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from stems import StemGenerator

app = FastAPI()
stem_gen = StemGenerator()

# 静态文件服务
app.mount("/static", StaticFiles(directory="../frontend"), name="static")
app.mount("/audio", StaticFiles(directory="../output/sessions"), name="audio")

class GenerateRequest(BaseModel):
    description: str        # 用户的风格描述
    duration: int = 60      # 时长（秒）
    bpm: int = 80
    key: str = "D major"

class GenerateResponse(BaseModel):
    session_id: str
    full_mix_url: str
    stems: dict  # {instrument: url}

@app.post("/api/generate", response_model=GenerateResponse)
async def generate_stems(req: GenerateRequest):
    """阶段一：根据用户描述生成全部分轨"""
    result = await stem_gen.generate_full_session(
        user_description=req.description,
        duration=req.duration,
        bpm=req.bpm,
        key=req.key
    )

    sid = result["session_id"]
    stems_urls = {k: f"/audio/{sid}/{k}.wav" for k in result["stems"]}

    return GenerateResponse(
        session_id=sid,
        full_mix_url=f"/audio/{sid}/full_mix.wav",
        stems=stems_urls
    )

@app.get("/")
async def index():
    return FileResponse("../frontend/index.html")
```

### 5. 前端：`frontend/js/sensor.js`

传感器数据采集（手机 IMU）：

```javascript
class SensorInput {
    constructor() {
        this.alpha = 0;   // z轴旋转 (0-360)
        this.beta = 0;    // 前后倾斜 (-180~180)
        this.gamma = 0;   // 左右倾斜 (-90~90)
        this.acceleration = { x: 0, y: 0, z: 0 };
        this.rotationRate = { alpha: 0, beta: 0, gamma: 0 };
        this.listeners = [];
    }

    async requestPermission() {
        /** iOS 13+ 需要显式请求权限 */
        if (typeof DeviceMotionEvent.requestPermission === 'function') {
            const permission = await DeviceMotionEvent.requestPermission();
            if (permission !== 'granted') {
                throw new Error('传感器权限被拒绝');
            }
        }
    }

    start() {
        window.addEventListener('deviceorientation', (e) => {
            this.alpha = e.alpha || 0;
            this.beta = e.beta || 0;
            this.gamma = e.gamma || 0;
        });

        window.addEventListener('devicemotion', (e) => {
            const acc = e.accelerationIncludingGravity;
            this.acceleration = { x: acc.x || 0, y: acc.y || 0, z: acc.z || 0 };
            this.rotationRate = {
                alpha: e.rotationRate.alpha || 0,
                beta: e.rotationRate.beta || 0,
                gamma: e.rotationRate.gamma || 0,
            };
            this._notify();
        });
    }

    onUpdate(callback) {
        this.listeners.push(callback);
    }

    _notify() {
        const data = {
            orientation: { alpha: this.alpha, beta: this.beta, gamma: this.gamma },
            acceleration: this.acceleration,
            rotationRate: this.rotationRate,
            timestamp: performance.now(),
        };
        this.listeners.forEach(cb => cb(data));
    }
}
```

### 6. 前端：`frontend/js/gesture.js`

手势解析 — 将传感器原始数据转化为音乐控制参数：

> ⚠️ **以下代码是 M4b 之前的初版实现，已不代表当前行为。** 其中的固定阈值
> （`(energy-0.5)/(15-0.5)`）、四轴 sigmoid 声部映射、按帧数计的判定窗口、写死的
> `-9.81` 去重力，都是「乐器乱响 / 动作小了没声音 / 停止后没声音 / 四声部划分不合逻辑」
> 这几个问题的根因，已在 M4b、M4c 中重构。当前设计见下方「手势映射设计详解」章节，
> 实现见 `frontend/src/lib/gesture.ts` 与 `gestureConstants.ts`。此处保留仅作演进对照。

```javascript
class GestureInterpreter {
    constructor() {
        this.history = [];       // 最近 N 帧传感器数据
        this.historySize = 60;   // 1秒 @60Hz
        this.lastBeatTime = 0;
        this.bpm = 80;           // 当前检测到的 BPM
        this.baseBpm = 80;       // 原始生成时的 BPM

        // 平滑状态
        this.filtered = { energy: 0, gamma: 0, beta: 0 };
    }

    process(sensorData) {
        /**
         * 输入：原始传感器数据
         * 输出：{ sections, dynamics, tempo, density, expression }
         */
        this.history.push(sensorData);
        if (this.history.length > this.historySize) this.history.shift();

        const { orientation, acceleration } = sensorData;

        // 运动能量（去重力）
        const energy = Math.sqrt(
            acceleration.x ** 2 + acceleration.y ** 2 + acceleration.z ** 2
        ) - 9.81;
        this.filtered.energy = this._smooth(this.filtered.energy, Math.max(0, energy), 0.3);

        // 方向平滑
        this.filtered.gamma = this._smooth(this.filtered.gamma, orientation.gamma, 0.2);
        this.filtered.beta = this._smooth(this.filtered.beta, orientation.beta, 0.2);

        return {
            sections: this._calcSectionActivation(),
            dynamics: this._calcDynamics(),
            tempo: this._calcTempo(acceleration),
            density: this._calcDensity(),
            expression: this._detectExpression(),
        };
    }

    _calcSectionActivation() {
        /**
         * 空间方向 → 声部激活度 (0-1)
         * 模拟交响乐团座位布局（观众视角）：
         *            [上方: 木管]
         *               ↑
         * [左侧: 弦乐] ← → [右侧: 铜管]
         *               ↓
         *          [下方: 打击乐]
         */
        const g = this.filtered.gamma;  // 左右倾斜
        const b = this.filtered.beta;   // 前后倾斜
        const smooth = 15;  // sigmoid 平滑系数

        return {
            violin: this._sigmoid((-g - 20) / smooth),
            cello: this._sigmoid((-g - 10) / smooth) * 0.8,
            trumpet: this._sigmoid((g - 20) / smooth),
            woodwind: this._sigmoid((-b - 15) / smooth),
            percussion: this._sigmoid((b - 15) / smooth),
        };
    }

    _calcDynamics() {
        /** 运动速度 → 力度 (0-1) */
        const REST = 0.5;   // 静止阈值
        const MAX = 15;     // 最大能量
        return Math.min(1, Math.max(0, (this.filtered.energy - REST) / (MAX - REST)));
    }

    _calcTempo(acceleration) {
        /**
         * 节拍检测 → playbackRate
         * 通过垂直加速度的峰值检测识别下拍
         * 返回值为播放速率比 (0.7 - 1.3)
         */
        const now = performance.now();

        if (this.history.length >= 2) {
            const prev = this.history[this.history.length - 2].acceleration.y;
            const curr = acceleration.y;

            // 负→正 过零点 + 最小能量阈值 = 一个下拍
            if (prev < 0 && curr >= 0 && this.filtered.energy > 2) {
                const interval = now - this.lastBeatTime;
                if (interval > 200 && interval < 2000) {  // 30-300 BPM 有效范围
                    const detectedBpm = 60000 / interval;
                    // 限制在原始 BPM 的 ±30%
                    const minBpm = this.baseBpm * 0.7;
                    const maxBpm = this.baseBpm * 1.3;
                    const clamped = Math.min(maxBpm, Math.max(minBpm, detectedBpm));
                    this.bpm = this._smooth(this.bpm, clamped, 0.15);
                }
                this.lastBeatTime = now;
            }
        }

        return this.bpm / this.baseBpm;  // playbackRate
    }

    _calcDensity() {
        /**
         * 动作幅度 → 合奏密度 (0-1)
         * 大幅挥动 = 全奏 tutti
         * 小幅精确 = 独奏 solo
         */
        const recent = this.history.slice(-30);  // 最近 0.5 秒
        if (recent.length < 5) return 0.5;

        const energies = recent.map(d =>
            Math.sqrt(d.acceleration.x**2 + d.acceleration.y**2 + d.acceleration.z**2)
        );
        const variance = this._variance(energies);
        return Math.min(1, variance / 50);  // 归一化
    }

    _detectExpression() {
        /**
         * 特殊手势 → 音乐表情
         * - crescendo: 能量持续上升 1-2秒
         * - decrescendo: 能量持续下降
         * - cutoff: 从高能量突然静止（急停/握拳）
         * - fermata: 持续低能量 > 2秒（延音）
         */
        if (this.history.length < 30) return null;

        const recent = this.history.slice(-30);
        const energyTrend = recent.map(d =>
            Math.sqrt(d.acceleration.x**2 + d.acceleration.y**2 + d.acceleration.z**2)
        );

        // 渐强
        if (this._isRising(energyTrend)) return 'crescendo';

        // 渐弱
        if (this._isFalling(energyTrend)) return 'decrescendo';

        // 切断
        const lastEnergy = energyTrend[energyTrend.length - 1];
        const avgEnergy = energyTrend.slice(0, 20).reduce((a,b) => a+b, 0) / 20;
        if (avgEnergy > 5 && lastEnergy < 1) return 'cutoff';

        return null;
    }

    // ===== 工具函数 =====
    _sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
    _smooth(prev, curr, factor) { return prev * (1 - factor) + curr * factor; }
    _variance(arr) {
        const mean = arr.reduce((a,b) => a+b, 0) / arr.length;
        return arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / arr.length;
    }
    _isRising(arr) {
        let rises = 0;
        for (let i = 1; i < arr.length; i++) if (arr[i] > arr[i-1]) rises++;
        return rises / (arr.length - 1) > 0.7;
    }
    _isFalling(arr) {
        let falls = 0;
        for (let i = 1; i < arr.length; i++) if (arr[i] < arr[i-1]) falls++;
        return falls / (arr.length - 1) > 0.7;
    }
}
```

### 7. 前端：`frontend/js/audio-engine.js`

Web Audio API 实时混音引擎：

```javascript
class AudioEngine {
    constructor() {
        this.ctx = null;
        this.masterGain = null;
        this.tracks = {};  // {instrument: {buffer, source, gain, panner}}
        this.isPlaying = false;
    }

    async init() {
        this.ctx = new AudioContext();
        this.masterGain = this.ctx.createGain();
        this.masterGain.connect(this.ctx.destination);
    }

    async loadStems(stems) {
        /**
         * stems: {violin: "/audio/xxx/violin.wav", cello: "...", ...}
         * 加载所有分轨到 AudioBuffer
         */
        // 乐团座位空间化位置 (StereoPanner: -1左 ~ +1右)
        const positions = {
            violin: -0.8,
            cello: -0.4,
            trumpet: 0.7,
            woodwind: 0.0,
            percussion: 0.3,
        };

        for (const [instrument, url] of Object.entries(stems)) {
            const resp = await fetch(url);
            const buffer = await resp.arrayBuffer();
            const audioBuffer = await this.ctx.decodeAudioData(buffer);

            const gain = this.ctx.createGain();
            const panner = this.ctx.createStereoPanner();
            panner.pan.value = positions[instrument] || 0;

            gain.connect(panner);
            panner.connect(this.masterGain);

            this.tracks[instrument] = {
                buffer: audioBuffer,
                gain: gain,
                panner: panner,
                source: null,
            };
        }
    }

    play() {
        /** 同步启动所有分轨播放 */
        const startTime = this.ctx.currentTime + 0.05;

        for (const [instrument, track] of Object.entries(this.tracks)) {
            const source = this.ctx.createBufferSource();
            source.buffer = track.buffer;
            source.connect(track.gain);
            source.loop = true;  // 循环播放
            source.start(startTime);
            track.source = source;
        }
        this.isPlaying = true;
    }

    stop() {
        for (const track of Object.values(this.tracks)) {
            if (track.source) {
                track.source.stop();
                track.source = null;
            }
        }
        this.isPlaying = false;
    }

    // ===== 指挥控制接口 =====

    setTrackVolume(instrument, value) {
        /** value: 0.0 - 1.0, 50ms平滑过渡 */
        if (this.tracks[instrument]) {
            this.tracks[instrument].gain.gain.linearRampToValueAtTime(
                value, this.ctx.currentTime + 0.05
            );
        }
    }

    setMasterVolume(value) {
        this.masterGain.gain.linearRampToValueAtTime(
            value, this.ctx.currentTime + 0.05
        );
    }

    setPlaybackRate(rate) {
        /** rate: 0.7 - 1.3, 控制所有轨道播放速度 */
        for (const track of Object.values(this.tracks)) {
            if (track.source) {
                track.source.playbackRate.linearRampToValueAtTime(
                    rate, this.ctx.currentTime + 0.1
                );
            }
        }
    }
}
```

### 8. 前端：`frontend/js/app.js`

主控制器，串联所有模块：

```javascript
class MTXApp {
    constructor() {
        this.audioEngine = new AudioEngine();
        this.sensor = new SensorInput();
        this.gesture = new GestureInterpreter();
        this.currentSession = null;
    }

    async init() {
        await this.audioEngine.init();
    }

    // ===== 阶段一：AI 生成 =====

    async generateStems(description, duration = 60, bpm = 80, key = "D major") {
        /**
         * 调用后端，生成完整混音 + 各分轨
         * 返回 session 信息（含各音频 URL）
         */
        const resp = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description, duration, bpm, key })
        });
        this.currentSession = await resp.json();
        return this.currentSession;
    }

    async previewFullMix() {
        /** 试听完整混音（阶段一确认用） */
        const audio = new Audio(this.currentSession.full_mix_url);
        audio.play();
        return audio;  // 返回以便 UI 控制暂停
    }

    // ===== 阶段二：实时指挥 =====

    async startConducting() {
        // 1. 加载分轨到音频引擎
        await this.audioEngine.loadStems(this.currentSession.stems);

        // 2. 设置基准 BPM
        this.gesture.baseBpm = 80;  // TODO: 从 session 获取实际 BPM

        // 3. 请求传感器权限并启动
        await this.sensor.requestPermission();
        this.sensor.start();

        // 4. 开始播放
        this.audioEngine.play();

        // 5. 实时循环：传感器 → 手势解析 → 控制音频
        this.sensor.onUpdate((sensorData) => {
            const params = this.gesture.process(sensorData);
            this._applyToAudio(params);
        });
    }

    _applyToAudio(params) {
        /**
         * 将手势解析结果映射到音频引擎控制：
         * - sections × dynamics → 各轨音量
         * - tempo → 播放速率
         * - density → 声部数量控制
         * - expression → 特殊效果
         */

        // 各声部音量 = 激活度 × 整体力度
        for (const [instrument, activation] of Object.entries(params.sections)) {
            const volume = activation * params.dynamics;
            this.audioEngine.setTrackVolume(instrument, volume);
        }

        // 速度控制
        this.audioEngine.setPlaybackRate(params.tempo);

        // 密度控制：低密度时只保留最活跃的声部
        if (params.density < 0.3) {
            const sorted = Object.entries(params.sections)
                .sort((a, b) => b[1] - a[1]);
            sorted.slice(2).forEach(([inst]) => {
                this.audioEngine.setTrackVolume(inst, 0);
            });
        }

        // 特殊表情
        if (params.expression === 'cutoff') {
            this.audioEngine.setMasterVolume(0);
            setTimeout(() => this.audioEngine.setMasterVolume(1), 100);
        }
    }

    stopConducting() {
        this.audioEngine.stop();
    }
}
```

---

## 手势映射设计详解

> 本章描述 M4b/M4c 重构后的实际实现。全部可调参数集中在
> `frontend/src/lib/gestureConstants.ts`，每个都附了取值理由。

### 分层：ConductIntent

手势解析分成两段，中间以一个与传感器无关的「指挥意图」结构相接：

```
IMU 适配器（GestureInterpreter.readIntent）
    ↓ ConductIntent { effort, beatPulse, tempoRatio, emphasis, density, stillness, expression }
混音层（mixIntent）
    ↓ GestureParams { roles, dynamics, tempo, density, expression }
```

重力基线、欧拉角度数、加速度过零点这些 IMU 特有的东西全部收敛在适配器里，不往上层漏。
M5 的摄像头适配器只要产出同一个 `ConductIntent`，声部逻辑就不必重写。

所有判定窗口按**毫秒**而非帧数——电脑模式下采样经 WebSocket 到达，网络抖动会让同样的
帧数覆盖忽长忽短的真实时间。

### 空间方向 → 声部强调（混音平衡范式）

**所有声部始终在演奏**，手势只调整「谁更突出」。被弱化的声部退到 `BED_LEVEL`（约 45%
音量，动作越大压得越低）但绝不静音——声部忽有忽无正是「乐器乱响」的来源。

| 手机姿态 | 效果 |
|----------|------|
| gamma < 0（左倾） | 强调主旋律，倾 35° 到满 |
| gamma > 0（右倾） | 强调和声 |
| beta < 0（上仰） | 强调低音 |
| 居中 | 三者均衡，都在底噪电平 |

节奏声部不占用朝向轴，改由**拍点脉冲**驱动（触发后 200ms 指数衰减）——打击类声部本质是
点状事件，跟着拍「哒」一下，不该和旋律一样是连续的朝向量。

> 早期实现给四个角色各配一个 sigmoid，但 melody/harmony 同取 gamma 轴、bass/rhythm 同取
> beta 轴，四个「声部」其实只是两个物理轴的正负两端；且端正握持时四者只有 0.21~0.27，
> 正常姿势下每个声部都只有约四分之一音量。

### 运动速度 → 力度（音量）

能量取**相对静止基线的偏离量**，不假设读数含不含重力：

```
magBaseline ← 慢速跟踪（起步阶段用 running mean 快速收敛）
energy      = |mag - magBaseline|
activity    = 滑动窗口(1200ms)峰值，再做 250ms 平滑
dynamics    = clamp((activity - DYN_REST) / (DYN_FULL - DYN_REST), ACTIVE_FLOOR, 1)
```

三个要点：

- **力度取窗口峰值而非瞬时能量。** 挥拍时能量在一拍之内必然从峰值掉到零，用瞬时值会让
  所有音轨跟着拍子整体脉动。滑动窗口只要盖得住一拍，稳定挥拍时力度就是平的。
- **门限自适应、取值绝对。** 判断「在不在指挥」用跟随包络的滞回门限（30%/12% + 最短驻留
  150ms），适应不同人的挥动幅度；力度取值保持绝对，否则轻挥会被自动增益拉回满音量、
  强弱对比就没了。
- **停手不静音。** 约 0.9 秒平滑衰减到 `SUSTAIN_FLOOR`（18%）并保持，重新挥动立即恢复。

### 节拍频率 → 速度

检测垂直加速度的负→正过零点为一个下拍（即文献中的 ictus，运动学拐点），计算间隔得到
BPM，限制在原始 BPM 的 ±30% 范围内。过零点的能量门限跟随包络，否则小幅度指挥永远检测
不到拍点、速度会一直卡在基准值。

### 动作幅度 → 强调对比度

`density`（近期加速度模长的方差）不再决定「哪些声部该静音」，改为调节底噪高低：动作幅度
大时底噪压低、强调对比更强烈；幅度小时底噪回升、各声部更均衡。任何情况下都不会让声部消失。

### 特殊手势 → 音乐表情

| 手势 | 检测方法 | 音乐效果 | 状态 |
|------|----------|----------|------|
| 逐渐上扬 | 趋势窗口内能量持续上升 | 渐强 Crescendo | ✅ |
| 逐渐下压 | 能量持续下降 | 渐弱 Decrescendo | ✅ |
| 急停 | 刚才还在用力挥（activity 高）+ 现在完全静止（模长峰峰值 < 0.8） | 切断 Cutoff | ✅ |
| 保持静止 | — | 延音 Fermata | ⏸ 暂缓 |
| 画圈动作 | 陀螺仪 z 轴旋转模式 | 颤音/揉弦 | ⏸ 暂缓 |

**收势（Cutoff）**要连续满足 80ms 且带 500ms 不应期，并且只在「由动转静」的瞬间报一次
（否则只要人保持静止，条件会一直成立、每过一个不应期就再报一次）。触发后走力度自己的
release 曲线，全系统只有这一套衰减机制——早期实现是主音量瞬间归零、100ms 后无条件拉回 1，
和每帧持续写入的 trackVolume 直接冲突，这就是「完全停止之后又直接没有声音了」。

**Fermata 暂缓的原因**：它和「停手」在单手 IMU 的信号上是同一个输入——都只是静止。原设想的
判据是「静止超过 2 秒」，但停手 1 秒内就已衰减到保持音量了；若让「静止更久 → 音量更高」，
等于站着不动越久乐队越响，手感是反的。真正的延音需要区分「半空中定住」和「收势停下」，
单手 IMU 的模长信号给不出这个区分。摄像头到位后（M5，有手的绝对空间位置）这个区分是自然的。

**画圈颤音暂缓的原因**：需要角速度积分与轨迹形状识别，投入远超其余各项。同样在摄像头方案
下会容易得多。

### 调试

开发模式下访问 `/?debug=conduct` 打开手势解析调试页：用合成传感器序列驱动真正的
`GestureInterpreter`，实时画出力度、四个声部音量、密度与收势触发点。预置了稳定挥拍、
幅度渐小、夹杂抖动、收势静止、朝向微抖、左倾强调六段序列，改完参数刷新即可对比。

---

## 踏板：情绪调控层

踏板映射到 Valence-Arousal 连续空间的唤醒度轴：

- **踏板位置 0（松开）**：低唤醒度 — 柔和混响、高频衰减、更软的起音
- **踏板位置 1（踩下）**：高唤醒度 — 更亮的 EQ、更短的混响、压缩增加冲击感

实现方式：Web Audio API 的 BiquadFilterNode + ConvolverNode（混响）+ DynamicsCompressorNode，参数值根据踏板位置实时插值。

---

## 启动与运行

```bash
# 终端 1：启动 ACE-Step API（确保已部署）
cd ACE-Step-1.5
uv run acestep-api
# → http://localhost:8001

# 终端 2：启动项目后端
cd mtx-conductor/backend
pip install fastapi uvicorn httpx
uvicorn app:app --host 0.0.0.0 --port 3000

# 浏览器打开 http://localhost:3000
```

### ⚠️ 重要：手机传感器需要 HTTPS

DeviceMotion/DeviceOrientation API 在大多数浏览器上要求安全上下文（HTTPS）。开发阶段方案：

```bash
# 方案一：mkcert 本地证书
mkcert -install
mkcert localhost 192.168.x.x  # 你的局域网IP
uvicorn app:app --host 0.0.0.0 --port 3000 \
  --ssl-keyfile=./localhost+1-key.pem \
  --ssl-certfile=./localhost+1.pem

# 方案二：ngrok 隧道（自带 HTTPS）
ngrok http 3000
```

---

## 关键注意事项

1. **ACE-Step API 接口**：上面的 API 调用格式是基于 ACE-Step 文档推断的，实际端点和参数名需要查看 `acestep-api` 启动后的文档（通常在 `http://localhost:8001/docs`）。请根据实际 API 文档调整 `generator.py` 中的 payload 字段。

2. **LoKr 权重路径**：`config.py` 中的 `LOKR_WEIGHTS_PATH` 需改为你实际训练输出的权重文件路径。

3. **多轨一致性**：当前方案通过"先生成完整混音，再以其为参考生成分轨"来保证一致性。如果 ACE-Step 的 reference audio 功能不能完美满足需求，备选方案是：
   - 使用相同的随机种子 + 相近的 prompt
   - 后期通过节拍对齐算法（librosa beat_track）修正时间偏差

4. **延迟要求**：阶段二的指挥体验要求 < 50ms 端到端延迟（手势→音频变化）。Web Audio API 本身延迟极低，主要瓶颈在传感器采样率（60Hz ≈ 16ms）和平滑滤波引入的额外延迟。

5. **音频格式**：Web Audio API 的 `decodeAudioData` 支持 WAV/MP3/OGG。ACE-Step 默认输出 WAV，无需转码。

---

## 实现优先级

| 优先级 | 任务 | 说明 |
|--------|------|------|
| P0 | 确认 ACE-Step API 端点格式 | 启动 `acestep-api`，查看 `/docs`，确认请求/响应格式 |
| P1 | 后端：能成功调用 API 生成一段音频 | 验证 generator.py 可用 |
| P2 | 后端：完整分轨生成流程 | stems.py 跑通 |
| P3 | 前端：AudioEngine 加载并播放分轨 | 先用固定音频文件测试 |
| P4 | 前端：SensorInput 采集数据 | 手机打开页面验证读数 |
| P5 | 前端：GestureInterpreter + 音频联动 | 核心体验验证 |
| P6 | UI/视觉反馈/踏板 | 体验优化 |
