/**
 * 音画延迟校准。
 *
 * ## 为什么必须有这一步
 *
 * 评分把「你的拍点时刻」和「音乐的拍点时刻」相减。后者是我们算出来的：
 * 排程时刻 + `AudioContext.outputLatency`。问题是这个 `outputLatency` 在多数
 * 浏览器上**报不出蓝牙那一段** —— AirPods 之类的无线耳机有 150~250ms 的链路
 * 延迟，声音早就晚了，我们却以为它准时。
 *
 * 后果是用户什么都没做错，每一拍都被判成拖了 200ms。实测（修容差之前）：
 * 150ms 的固定延迟就能把「拍点准确度」打到 16 分，200ms 打到 0。
 *
 * ## 量的是什么
 *
 * 让用户跟着咔哒声敲几下，取「敲的时刻 − 我们以为的拍点时刻」的中位数。
 * 这个数里有两样东西，而两样都该减掉：
 *
 * - **设备延迟** —— 不是本事问题，显然要减。
 * - **人的负偏**（negative mean asynchrony）—— 人跟拍时天然会早 20~60ms，
 *   这是感觉运动同步里的普遍现象，不是练得掉的。减掉它等于把评分的零点挪到
 *   「这个人自己的准」上，剩下的离散程度才是真正能练的东西。
 *
 * 所以这一项叫「校准」而不是「延迟」：它把你和设备合起来的那个常数归零。
 *
 * 存 localStorage 而不是后端：这是**这台机器 + 这副耳机**的属性，换台机器就得
 * 重测，跟着账号走反而是错的。
 */

import { beatIndexAt, Metronome, type BeatGrid } from "./metronome";

const KEY = "mw.audioLatencyMs";

/** 超出这个范围的校准值多半是敲错了，不接受。 */
export const MAX_LATENCY_MS = 400;

/** 校准用的速度。100 BPM 是最容易跟准的区间，太慢反而不好对。 */
export const CALIBRATION_BPM = 100;
/** 一共敲几下。 */
export const CALIBRATION_TAPS = 10;
/** 前几下不算 —— 人要一两拍才进得去。 */
const WARMUP_TAPS = 3;

export function getLatencyMs(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && Math.abs(v) <= MAX_LATENCY_MS ? v : 0;
  } catch {
    // 隐私模式下 localStorage 会抛。没有校准值不是错误，按 0 走。
    return 0;
  }
}

export function setLatencyMs(ms: number): void {
  try {
    if (!Number.isFinite(ms) || Math.abs(ms) > MAX_LATENCY_MS) return;
    localStorage.setItem(KEY, String(Math.round(ms)));
  } catch {
    /* 存不下就算了，本次仍然生效 */
  }
}

export function clearLatency(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 同上 */
  }
}

/**
 * 把校准值加到拍网格的原点上。
 *
 * 方向：设备把声音**推迟**了 L，用户听到并跟着敲的时刻就晚了 L，所以「音乐
 * 真正响起来的那一刻」比我们排程的时刻晚 L —— 原点要往后挪，不是往前。
 */
export function shiftGrid(grid: BeatGrid, ms: number): BeatGrid {
  return ms ? { ...grid, originPerf: grid.originPerf + ms } : grid;
}

export interface CalibrationResult {
  /** 建议写入的校准值（毫秒）。 */
  offsetMs: number;
  /** 这几下自己有多散。太散说明没敲准，值不可信。 */
  spreadMs: number;
  taps: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};

/**
 * 一轮校准。
 *
 * 复用 `Metronome` 而不是另写一套发声：它已经把「排程 + 输出延迟 + 两个时钟的
 * 锚点」处理好了，而校准要量的正是这套东西**剩下**的那部分误差。另写一份就是
 * 在量另一条通路，量出来的值用在这条上不成立。
 */
export class LatencyCalibrator {
  private metro = new Metronome();
  private grid: BeatGrid | null = null;
  private offsets: number[] = [];

  /** 已经敲了几下（含热身）。 */
  get taps(): number {
    return this.offsets.length;
  }

  get running(): boolean {
    return this.grid !== null;
  }

  async start(): Promise<void> {
    this.offsets = [];
    // 不要数拍：校准就是敲拍子本身，多一小节静默只会让人不知道什么时候开始
    this.grid = await this.metro.start(CALIBRATION_BPM, 4, 0);
  }

  /** 敲一下。返回这一下离最近的咔哒差多少毫秒（正=晚）。 */
  tap(at = performance.now()): number | null {
    if (!this.grid) return null;
    const beat = beatIndexAt(this.grid, at);
    const nearest = Math.round(beat);
    const offset = ((beat - nearest) * 60000) / this.grid.bpm;
    // 差半拍以上的算敲飞了，不计入 —— 但也不打断，让人接着敲
    if (Math.abs(offset) > 30000 / this.grid.bpm) return offset;
    this.offsets.push(offset);
    return offset;
  }

  stop(): void {
    this.metro.stop();
    this.grid = null;
  }

  /** 够不够算结果。 */
  get done(): boolean {
    return this.offsets.length >= CALIBRATION_TAPS;
  }

  result(): CalibrationResult | null {
    const used = this.offsets.slice(WARMUP_TAPS);
    if (used.length < 4) return null;
    const m = median(used);
    return {
      offsetMs: Math.round(m),
      spreadMs: Math.round(median(used.map((o) => Math.abs(o - m)))),
      taps: used.length,
    };
  }
}
