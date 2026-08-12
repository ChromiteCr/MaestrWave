import type { SensorSample } from "./sensor";

export type InstrumentRole = "melody" | "harmony" | "bass" | "rhythm";

export interface GestureParams {
  roles: Record<InstrumentRole, number>;
  dynamics: number;
  tempo: number;
  density: number;
  expression: "crescendo" | "decrescendo" | "cutoff" | null;
}

/**
 * 与传感器无关的「指挥意图」。
 *
 * M4c 把手势解析拆成两层：传感器适配器产出 ConductIntent，混音层只消费 ConductIntent。
 * 现在只有 IMU 适配器（GestureInterpreter），M5 的摄像头适配器产出同一个结构即可接入，
 * 声部逻辑不必重写 —— 那些「度数阈值、加速度过零点、重力基线」都是 IMU 特有的，
 * 全部收敛在适配器里，不往上层漏。
 */
export interface ConductIntent {
  /** 0-1，已经过包络、滞回与 release 处理的力度。 */
  effort: number;
  /** 0-1，拍点触发后衰减的脉冲。 */
  beatPulse: number;
  /** 相对 baseBpm 的速度比。 */
  tempoRatio: number;
  /** -1..1，各声部的强调倾向。正值表示被强调。 */
  emphasis: { melody: number; harmony: number; bass: number };
  /** 0-1，动作幅度，用来调节强调的对比度。 */
  density: number;
  /** 0-1，静止程度。1 表示完全不动。 */
  stillness: number;
  expression: GestureParams["expression"];
}

/**
 * 移植自 legacy/js/gesture.js，M4b 起做了响应稳定性重构。
 *
 * 原版把空间方向直接映射到写死的 5 个乐器名（violin/cello/trumpet/woodwind/
 * percussion）；新架构下项目乐器是任意的，所以改成映射到 4 个通用角色
 * （melody/harmony/bass/rhythm，对应 backend/config.py 里 INSTRUMENT_LIBRARY
 * 的 role 字段），调用方按每个乐器的 role 去查对应的激活度。
 *
 * M4b 修掉了四个体验问题的信号侧根因（声部划分逻辑本身留到 M4c）：
 *   1. dynamics 原本是 (energy-0.5)/(15-0.5) 的固定绝对阈值，基准 15 定得很高，
 *      中小幅度动作直接归零 —— 即"动作稍微小一点就没有声音"。现在改成除以
 *      「你最近实际挥得多大」的自适应包络，并加滞回和最短驻留，轻挥就是轻响。
 *   2. cutoff 原本是纯瞬时布尔判定（前 20 帧均值 >5 且最后 1 帧 <1），一次抖动
 *      就触发。现在要求连续多帧、持续够久、且带不应期。
 *   3. cutoff 原本由 useConductor 用「主音量瞬间归零 + 100ms 后无条件拉回 1」
 *      来响应，和每帧持续写入的 trackVolume 互相打架 —— 即"完全停止之后又直接
 *      没有声音了"。现在 cutoff 直接走 dynamics 自己的 release 曲线，全系统
 *      只有这一套衰减机制，不会有两个东西抢同一个音量。
 *   4. 判定窗口原本按帧数算（historySize=60、趋势取 30 帧），隐含 60Hz 假设；
 *      但电脑模式下采样是经 WebSocket 到达的，网络抖动会让同样的帧数覆盖忽长
 *      忽短的真实时间。现在一律按毫秒裁窗口。
 */

import {
  ACTIVATE_RATIO,
  ACTIVE_FLOOR,
  ACTIVITY_SMOOTH_TAU_MS,
  ACTIVITY_WINDOW_MS,
  BASELINE_TAU_MS,
  BED_LEVEL,
  CONTRAST_RANGE,
  CUTOFF_HOLD_MS,
  CUTOFF_REFRACTORY_MS,
  DEACTIVATE_RATIO,
  DYN_FULL,
  DYN_REST,
  EMPH_SPAN,
  ENV_FLOOR,
  ENV_TAU_MS,
  HISTORY_MS,
  MAX_BEAT_INTERVAL_MS,
  MIN_ACTIVE_MS,
  MIN_BEAT_INTERVAL_MS,
  pulseTauMs,
  RHYTHM_FLOOR,
  QUIET_HOLD_MS,
  RELEASE_MS,
  STILL_PEAK_TO_PEAK,
  STILL_WINDOW_MS,
  SUSTAIN_FLOOR,
  TREND_MS,
} from "./gestureConstants";

interface HistoryEntry {
  /** 接收侧时钟。见下方 process() 里关于不能用 sample.timestamp 的说明。 */
  t: number;
  /** 加速度模长原值，密度判定用。 */
  mag: number;
  /** 相对静止基线的能量偏离量，力度与表情判定用。 */
  e: number;
  /** 加速度 y 分量，拍点过零点检测用。 */
  ay: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * 指挥意图 → 各声部音量。与传感器无关，M5 的摄像头适配器可直接复用。
 *
 * 混音平衡范式：所有声部始终在演奏，手势只调整"谁更突出"。没有任何声部会被关掉 ——
 * 原实现在 density<0.3 时按当前帧四个角色的相对大小排序、把最低的两个强制静音，
 * 而排序逐帧重算，稍有抖动名次就翻转，刚静音的声部下一帧又起播，这是"乐器乱响"
 * 最直接的来源。现在每个声部各自独立取值，不跟别的声部比名次。
 */
export function mixIntent(intent: ConductIntent): GestureParams {
  // 动作幅度越大，底噪压得越低，强调的对比越强烈。
  const bed = BED_LEVEL - CONTRAST_RANGE * clamp(intent.density, 0, 1);
  const lift = (emphasis: number) => bed + (1 - bed) * Math.max(0, emphasis);

  return {
    roles: {
      melody: lift(intent.emphasis.melody),
      harmony: lift(intent.emphasis.harmony),
      bass: lift(intent.emphasis.bass),
      /*
       * 节奏声部跟拍点走，**但拍点只做重音，不做开关**。
       *
       * 原来这里是 `lift(intent.beatPulse)`：脉冲一衰减，整条节奏轨就从满音量
       * 掉到底噪，实测每拍摆动 6.3dB —— 用户听到的就是「打一拍猛地一响，
       * 然后一路沉下去，下一拍又猛地一响」。而节奏轨放的是定音鼓写好的谱子，
       * 它自己就有节奏；再用用户的拍点去开关它，等于把第二套节奏叠上去，
       * 两套还不同步（音乐走自己的网格，用户的拍点会飘）。
       *
       * 现在地板抬到 RHYTHM_FLOOR，脉冲只在它之上加一层重音，摆幅收到约 2.4dB。
       */
      rhythm: lift(RHYTHM_FLOOR + (1 - RHYTHM_FLOOR) * clamp(intent.beatPulse, 0, 1)),
    },
    dynamics: intent.effort,
    tempo: intent.tempoRatio,
    density: intent.density,
    expression: intent.expression,
  };
}

export class GestureInterpreter {
  private history: HistoryEntry[] = [];
  private lastBeatTime = 0;
  private filtered = { energy: 0, gamma: 0, beta: 0 };

  private _baseBpm = 80;
  private bpm = 80;
  /**
   * 调用方在起播前赋值（useConductor 用 project.bpm）。这里同时把当前 bpm 拉到基准：
   * 原实现 bpm 写死初值 80，而 baseBpm 是之后才赋的，项目若是 120BPM，起播瞬间
   * tempo 就是 80/120=0.67，音乐一上来先慢三分之一，要挥好几拍才追得回去。
   */
  get baseBpm(): number {
    return this._baseBpm;
  }
  set baseBpm(v: number) {
    this._baseBpm = v;
    this.bpm = v;
  }

  private lastProcessAt = 0;
  /** 负值表示尚未初始化，第一帧直接采信当前读数。 */
  private magBaseline = -1;
  private sampleCount = 0;
  private activity = 0;
  private energyEnvelope = ENV_FLOOR;

  private dynamicsActive = false;
  private activeSince = 0;
  /** 0 表示当前不安静；否则是连续安静的起始时刻。 */
  private quietSince = 0;
  private releaseSince = 0;
  private releaseFrom = SUSTAIN_FLOOR;
  private lastDynamics = SUSTAIN_FLOOR;

  private cutoffCandidateSince = 0;
  private lastCutoffAt = Number.NEGATIVE_INFINITY;
  /** 收势只在「由动转静」的瞬间报一次；重新动起来才重新武装。 */
  private cutoffArmed = true;
  private beatPulse = 0;

  process(sample: SensorSample): GestureParams {
    return mixIntent(this.readIntent(sample));
  }

  /** IMU → 指挥意图。所有 IMU 特有的东西（重力基线、度数、加速度过零点）都止步于此。 */
  readIntent(sample: SensorSample): ConductIntent {
    // 用接收侧的时钟，不用 sample.timestamp：电脑模式下 timestamp 是手机自己
    // performance.now() 的值，和本机时钟不同基准，直接拿来裁时间窗口会算错。
    // 到达时刻本身也正是音频侧真正关心的时间。
    const now = performance.now();
    const dt = this.lastProcessAt === 0 ? 0 : now - this.lastProcessAt;
    this.lastProcessAt = now;

    const { orientation, acceleration } = sample;
    const mag = Math.sqrt(acceleration.x ** 2 + acceleration.y ** 2 + acceleration.z ** 2);

    // 慢速跟踪静止基线，再取偏离量当能量。不假设读数含不含重力（见 BASELINE_TAU_MS）。
    //
    // 起步阶段收敛要快：基线若只用第一帧初始化，而那一帧恰好落在动作的峰值或谷值上，
    // 头一两秒的能量就是错的（拍点检测的门限过不去，节奏声部整整两秒不出声）。
    // 取「running mean 与指数平滑中较快的那个」——前几十帧等价于算平均值，之后自然
    // 交棒给 BASELINE_TAU_MS 的慢速跟踪。
    this.sampleCount++;
    if (this.magBaseline < 0) {
      this.magBaseline = mag;
    } else {
      const expK = dt > 0 ? 1 - Math.exp(-dt / BASELINE_TAU_MS) : 0;
      const k = Math.max(expK, 1 / this.sampleCount);
      this.magBaseline += (mag - this.magBaseline) * k;
    }
    const energy = Math.abs(mag - this.magBaseline);

    this.history.push({ t: now, mag, e: energy, ay: acceleration.y });
    const cutoffT = now - HISTORY_MS;
    while (this.history.length > 0 && this.history[0].t < cutoffT) this.history.shift();

    this.filtered.energy = this.smooth(this.filtered.energy, energy, 0.3);
    this.filtered.gamma = this.smooth(this.filtered.gamma, orientation.gamma, 0.2);
    this.filtered.beta = this.smooth(this.filtered.beta, orientation.beta, 0.2);

    this.updateEnvelopes(now, dt);

    const expression = this.detectExpression(now);
    // 收势直接走 dynamics 自己的 release 曲线。全系统只有这一套衰减机制，
    // 不再像 M4b 之前那样由 useConductor 另外去动主音量、和 trackVolume 打架。
    if (expression === "cutoff") this.forceRelease(now);

    // 先衰减再检测：calcTempo 命中拍点时会把 beatPulse 直接打回 1。
    // 衰减按**预测的拍长**走，不是定值：慢速下定值会让脉冲提前塌到底（见 pulseTauMs）
    this.beatPulse *= dt > 0 ? Math.exp(-dt / pulseTauMs(this.bpm)) : 1;
    const tempoRatio = this.calcTempo(acceleration, now);

    return {
      effort: this.calcDynamics(now),
      beatPulse: this.beatPulse,
      tempoRatio,
      emphasis: this.calcEmphasis(),
      density: this.calcDensity(),
      stillness: this.quietSince === 0 ? 0 : clamp((now - this.quietSince) / QUIET_HOLD_MS, 0, 1),
      expression,
    };
  }

  /**
   * 两层包络各管一件事：
   *   - activity（滑动窗口峰值 + 平滑）决定力度大小。取包络而非瞬时能量，才不会让
   *     全体音轨跟着每一拍脉动 —— 挥拍时能量在一拍之内必然从峰值掉到零。
   *   - energyEnvelope 只用来算门限，判断「还在不在指挥」，适应不同人挥动幅度的差异。
   */
  private updateEnvelopes(now: number, dt: number): void {
    // 窗口内的峰值。滑动窗口而不是指数衰减的峰值跟随器 —— 后者在两个拍点之间会自然
    // 衰减，力度仍是锯齿状的（见 ACTIVITY_WINDOW_MS）。
    let peak = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i];
      if (now - entry.t > ACTIVITY_WINDOW_MS) break;
      if (entry.e > peak) peak = entry.e;
    }
    const k = dt > 0 ? 1 - Math.exp(-dt / ACTIVITY_SMOOTH_TAU_MS) : 1;
    this.activity += (peak - this.activity) * k;

    const envDecay = dt > 0 ? Math.exp(-dt / ENV_TAU_MS) : 1;
    this.energyEnvelope = Math.max(this.activity, this.energyEnvelope * envDecay, ENV_FLOOR);
  }

  private get onThreshold(): number {
    return this.energyEnvelope * ACTIVATE_RATIO;
  }
  private get offThreshold(): number {
    return this.energyEnvelope * DEACTIVATE_RATIO;
  }

  /**
   * 朝向 → 强调向量。
   *
   * 原实现给四个角色各配一个 sigmoid，但 melody/harmony 同取 gamma 轴、bass/rhythm 同取
   * beta 轴 —— 四个"声部"其实只是两个物理轴的正负两端，既不独立也对不上音乐意义上的
   * 四类，这就是"分为主旋律、和声、低音、节奏不符合整体逻辑"。现在只产出强调倾向，
   * 节奏声部改由拍点脉冲驱动（见 pulseTauMs 与 RHYTHM_FLOOR），不再占用 beta 轴的负端。
   */
  private calcEmphasis(): ConductIntent["emphasis"] {
    const g = this.filtered.gamma; // 左右倾斜
    const b = this.filtered.beta; // 前后倾斜
    return {
      melody: clamp(-g / EMPH_SPAN, -1, 1), // 左倾 -> 主旋律
      harmony: clamp(g / EMPH_SPAN, -1, 1), // 右倾 -> 和声
      bass: clamp(-b / EMPH_SPAN, -1, 1), // 上仰 -> 低音
    };
  }

  /**
   * 自适应滞回门限 + 绝对力度映射 + release。
   *
   * 力度取值走绝对映射（DYN_REST~DYN_FULL），保住强弱对比 —— 若改成除以包络的自动
   * 增益，轻挥会被拉回满音量，强弱就没了。判断"在不在指挥"则走自适应门限，保住
   * 小动作也认得出来。
   */
  private calcDynamics(now: number): number {
    // 连续安静计时。挥拍的波谷会让某几帧看着很静，所以要看"连续安静了多久"，
    // 而不是某一帧静不静。
    if (!this.isStill(now)) this.quietSince = 0;
    else if (this.quietSince === 0) this.quietSince = now;

    if (!this.dynamicsActive) {
      // 必须同时"设备确实在动"。否则停手后 activity 还在慢慢衰减、始终高于门限，
      // 一进入 release 下一帧就又被判成在指挥，门限来回翻转。
      if (this.quietSince === 0 && this.activity > this.onThreshold) {
        this.dynamicsActive = true;
        this.activeSince = now;
      }
    } else if (now - this.activeSince > MIN_ACTIVE_MS) {
      const quietLongEnough = this.quietSince !== 0 && now - this.quietSince >= QUIET_HOLD_MS;
      if (quietLongEnough || this.activity < this.offThreshold) this.beginRelease(now);
    }

    if (this.dynamicsActive) {
      this.lastDynamics = clamp((this.activity - DYN_REST) / (DYN_FULL - DYN_REST), ACTIVE_FLOOR, 1);
      return this.lastDynamics;
    }

    const elapsed = now - this.releaseSince;
    if (elapsed >= RELEASE_MS) {
      this.lastDynamics = SUSTAIN_FLOOR;
      return SUSTAIN_FLOOR;
    }
    const k = elapsed / RELEASE_MS;
    this.lastDynamics = this.releaseFrom + (SUSTAIN_FLOOR - this.releaseFrom) * k;
    return this.lastDynamics;
  }

  /** 短窗口内模长的峰峰值是否小到只剩传感器噪声。 */
  private isStill(now: number): boolean {
    let lo = Infinity;
    let hi = -Infinity;
    let n = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i];
      if (now - entry.t > STILL_WINDOW_MS) break;
      if (entry.mag < lo) lo = entry.mag;
      if (entry.mag > hi) hi = entry.mag;
      n++;
    }
    return n >= 5 && hi - lo < STILL_PEAK_TO_PEAK;
  }

  private beginRelease(now: number): void {
    this.dynamicsActive = false;
    this.releaseSince = now;
    this.releaseFrom = this.lastDynamics;
  }

  /** 收势：不管当前处于什么状态，立刻进入自然衰减。 */
  private forceRelease(now: number): void {
    if (this.dynamicsActive) this.beginRelease(now);
  }

  private calcTempo(acceleration: SensorSample["acceleration"], now: number): number {
    if (this.history.length >= 2) {
      const prev = this.history[this.history.length - 2].ay;
      const curr = acceleration.y;
      // 拍点(ictus)取加速度方向反转的过零点。门槛跟着包络走，否则小幅度指挥
      // 永远检测不到拍点、速度就会一直卡在 baseBpm。
      const gate = this.energyEnvelope * ACTIVATE_RATIO;
      if (prev < 0 && curr >= 0 && this.filtered.energy > gate) {
        const interval = now - this.lastBeatTime;
        if (interval > MIN_BEAT_INTERVAL_MS && interval < MAX_BEAT_INTERVAL_MS) {
          const detected = 60000 / interval;
          const minBpm = this.baseBpm * 0.7;
          const maxBpm = this.baseBpm * 1.3;
          this.bpm = this.smooth(this.bpm, clamp(detected, minBpm, maxBpm), 0.15);
        }
        this.lastBeatTime = now;
        this.beatPulse = 1;
      }
    }
    return this.bpm / this.baseBpm;
  }

  private calcDensity(): number {
    const recent = this.recentMags();
    if (recent.length < 5) return 0.5;
    return Math.min(1, this.variance(recent) / 50);
  }

  /**
   * M4b：先判 cutoff 再判 crescendo/decrescendo。
   *
   * 原实现把 isRising/isFalling 放在前面 return，而真正的收势必然是下降趋势 ——
   * 结果真收势多半先被认成 decrescendo，反倒是噪声更容易触发 cutoff。顺序反过来
   * 之后，cutoff 还要满足连续低能量 + 持续够久 + 不应期三个条件才算数。
   */
  private detectExpression(now: number): GestureParams["expression"] {
    const recent = this.recentEntries();
    if (recent.length < 10) return null;

    const energies = recent.map((e) => e.e);

    // 收势 = 刚才还在用力挥、现在突然完全静止。
    //
    // 两个判据都不能想当然：
    //   - 「停下了」用 isStill（看模长的波动范围），不用能量。能量要减去重力基线，
    //     而基线是个慢变量，刚停手那会儿它还没跟上，能量迟迟降不下来。
    //   - 「刚才在挥」用 activity（1200ms 滑动窗口峰值），不用趋势窗口的前半段均值。
    //     后者到 isStill 成立时（停手约 300ms 后）已经基本落在停手之后了，两个条件
    //     的重叠只有一帧宽，凑不满持续时间要求，收势就永远触发不了。
    //
    // 门槛跟着包络走。原实现用的是绝对值（均值>5、末帧<1）且作用在含重力的模长上，
    // 而静止时模长就有 9.81 —— 末帧<1 等于要求自由落体，正常设备上根本不会成立。
    // 收势是「由动转静」这一个瞬间的事件，不是一个持续状态。不重新武装的话，只要人
    // 保持静止，条件就一直成立、每过一个不应期就再报一次。
    const stillNow = this.isStill(now);
    if (!stillNow) this.cutoffArmed = true;

    if (this.cutoffArmed && this.activity > this.onThreshold && stillNow) {
      if (this.cutoffCandidateSince === 0) this.cutoffCandidateSince = now;
      const held = now - this.cutoffCandidateSince;
      if (held >= CUTOFF_HOLD_MS && now - this.lastCutoffAt > CUTOFF_REFRACTORY_MS) {
        this.lastCutoffAt = now;
        this.cutoffCandidateSince = 0;
        this.cutoffArmed = false;
        return "cutoff";
      }
    } else {
      this.cutoffCandidateSince = 0;
    }

    if (this.isRising(energies)) return "crescendo";
    if (this.isFalling(energies)) return "decrescendo";
    return null;
  }

  private recentEntries(): HistoryEntry[] {
    if (this.history.length === 0) return [];
    const from = this.history[this.history.length - 1].t - TREND_MS;
    return this.history.filter((e) => e.t >= from);
  }

  private recentMags(): number[] {
    return this.recentEntries().map((e) => e.mag);
  }

  private smooth(prev: number, curr: number, factor: number): number {
    return prev * (1 - factor) + curr * factor;
  }
  private variance(arr: number[]): number {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / arr.length;
  }
  private isRising(arr: number[]): boolean {
    if (arr.length < 2) return false;
    let rises = 0;
    for (let i = 1; i < arr.length; i++) if (arr[i] > arr[i - 1]) rises++;
    return rises / (arr.length - 1) > 0.7;
  }
  private isFalling(arr: number[]): boolean {
    if (arr.length < 2) return false;
    let falls = 0;
    for (let i = 1; i < arr.length; i++) if (arr[i] < arr[i - 1]) falls++;
    return falls / (arr.length - 1) > 0.7;
  }
}
