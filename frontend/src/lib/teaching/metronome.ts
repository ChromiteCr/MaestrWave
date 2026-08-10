/**
 * 严格网格的节拍器，兼作**拍网格的真源**。
 *
 * 为什么不用 `backend/synth.py` 的打击声部：它每拍有 10% 概率被跳过
 * （`random.random() < trigger`），随机种子还用 `hash(str)`、跨进程不可复现。
 * 漏拍的节拍器不能拿来给人打分。
 *
 * 为什么放前端：Web Audio 的 `start(when)` 是采样级精确的，而且零后端往返。
 * 更要紧的是评分需要「手势时刻 ↔ 音乐时刻」的换算，节拍在这里排就意味着
 * 拍网格的原点是我们自己写下的常数，不用再去检测音频起始点。
 *
 * ## 两个时钟
 *
 * 手部数据用 `performance.now()`（毫秒），音频用 `AudioContext.currentTime`（秒）。
 * 两者之间没有现成映射，所以起播时记一对锚点，之后靠它换算。锚点只在起播记一次：
 * 两个时钟都是单调的，不会相对漂移到需要重新对齐的程度。
 */

/** 提前排程的窗口。太短会在主线程卡顿时漏拍，太长则改速度要等更久才生效。 */
const LOOKAHEAD_S = 0.25;
/** 排程循环的间隔。要明显小于 LOOKAHEAD_S。 */
const TICK_MS = 60;

const CLICK_MS = 30;
/** 强拍（每小节第一拍）与弱拍的频率。差一个八度，一耳朵能听出小节线。 */
const DOWNBEAT_HZ = 1600;
const BEAT_HZ = 800;

export interface BeatGrid {
  bpm: number;
  meter: number;
  /**
   * 第 0 拍（第一小节的第 1 拍）对应的 `performance.now()` 时刻，毫秒。
   * 评分把手势时刻减去它再除以拍长，就得到「第几拍」。
   */
  originPerf: number;
}

/**
 * 从 AudioContext 送出到喇叭发声的延迟，秒。
 *
 * `outputLatency` 是准确的那个，但 Safari 至今不提供；退而用 `baseLatency`
 * （只含渲染量子那一段，偏小但聊胜于无）；都没有就按 20ms 估 —— 桌面设备的
 * 典型值，比当 0 更接近事实。
 */
function outputLatency(ctx: AudioContext): number {
  const o = (ctx as AudioContext & { outputLatency?: number }).outputLatency;
  if (typeof o === "number" && o > 0) return o;
  if (typeof ctx.baseLatency === "number" && ctx.baseLatency > 0) return ctx.baseLatency;
  return 0.02;
}

export function beatIndexAt(grid: BeatGrid, perfMs: number): number {
  return ((perfMs - grid.originPerf) / 1000) * (grid.bpm / 60);
}

export function beatTimePerf(grid: BeatGrid, beat: number): number {
  return grid.originPerf + (beat / (grid.bpm / 60)) * 1000;
}

export class Metronome {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 下一个要排的拍号（从 0 开始，0 是第一小节的第 1 拍）。 */
  private nextBeat = 0;
  private startCtx = 0;
  private startPerf = 0;
  private bpm = 90;
  private meter = 4;
  /** 数拍小节数。教材里的起拍要先给一小节，评分的第 0 拍从数拍之后算起。 */
  private countInBars = 1;

  /** 起播后才有值。评分全靠它把手势时刻换算成拍号。 */
  grid: BeatGrid | null = null;
  /** 已经响过的最后一拍（含数拍，可为负）。UI 显示用。 */
  currentBeat = -Infinity;

  get running(): boolean {
    return this.timer !== null;
  }

  /**
   * @param countInBars 数拍小节数。网格原点定在**数拍结束**那一刻，
   *   所以数拍期间的拍号是负的，评分时天然被排除在外。
   */
  async start(bpm: number, meter: number, countInBars = 1): Promise<BeatGrid> {
    this.stop();
    this.bpm = bpm;
    this.meter = meter;
    this.countInBars = countInBars;

    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    // 用户手势里创建的 context 有时仍是 suspended，必须显式 resume，
    // 否则 currentTime 不走、排出去的音一个都不响。
    if (ctx.state === "suspended") await ctx.resume();
    this.ctx = ctx;

    // 起播锚点。先留一点余量再开始，避免第一拍排到已经过去的时刻上。
    const lead = 0.12;
    this.startCtx = ctx.currentTime + lead;
    // 网格原点要加上输出延迟。`currentTime` 是「送进音频图」的时刻，声音真正从
    // 喇叭出来还要晚 10~30ms。用户是跟着**听到的**声音打拍的，不补这一项，
    // 每个人都会被系统性地判成拖拍那么多毫秒 —— 一个谁也看不出来的固定偏差。
    this.startPerf = performance.now() + (lead + outputLatency(ctx)) * 1000;
    this.nextBeat = -countInBars * meter;

    this.grid = { bpm, meter, originPerf: this.startPerf };
    this.currentBeat = -Infinity;

    this.schedule();
    this.timer = setInterval(() => this.schedule(), TICK_MS);
    return this.grid;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.ctx?.close();
    this.ctx = null;
    this.grid = null;
  }

  /** 当前拍号（含小数）。没起播时返回 null。 */
  beatNow(): number | null {
    if (!this.grid) return null;
    return beatIndexAt(this.grid, performance.now());
  }

  private beatToCtxTime(beat: number): number {
    return this.startCtx + (beat / (this.bpm / 60));
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    while (this.beatToCtxTime(this.nextBeat) < ctx.currentTime + LOOKAHEAD_S) {
      this.click(ctx, this.beatToCtxTime(this.nextBeat), this.isDownbeat(this.nextBeat));
      this.nextBeat += 1;
    }
    const b = this.beatNow();
    if (b !== null) this.currentBeat = Math.floor(b);
  }

  /** 数拍期间拍号为负，取模要用「向下取整」的余数，否则 -4 会被当成 0 之外的东西。 */
  private isDownbeat(beat: number): boolean {
    const m = ((beat % this.meter) + this.meter) % this.meter;
    return m === 0;
  }

  private click(ctx: AudioContext, when: number, strong: boolean): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = strong ? DOWNBEAT_HZ : BEAT_HZ;
    // 方波太刺耳，正弦加一个极短的包络就足够「哒」了
    osc.type = "sine";
    const dur = CLICK_MS / 1000;
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(strong ? 0.35 : 0.2, when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + dur + 0.01);
  }
}
