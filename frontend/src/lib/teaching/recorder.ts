/**
 * 跟练录制层。
 *
 * 为什么必须有：`ConductIntent` 没有时间戳，`ConductingModel` 的 `lastIctusAt`
 * 只保留最后一次，轨迹 `traj` 只滚动留 1200ms 且是 private。要评一整段的表现，
 * 现场那点状态根本不够 —— 得先把每一帧存下来，结束后一次性分析。
 *
 * 这一层同时是回放讲评的数据源，所以存的是原始样本而不是算好的指标：
 * 指标的算法还会改，原始数据不会。
 */

import type { ConductSample } from "../camera/cameraIntentSource";
import type { Point } from "./patterns";
import type { BeatGrid } from "./metronome";

export interface RecordedFrame {
  /** performance.now()，毫秒。 */
  t: number;
  beat: Point | null;
  expr: Point | null;
  ictus: boolean;
  /** 拍点的真实时刻。见 ConductSample.ictusAt —— 评分一律用它，不要用 `t`。 */
  ictusAt: number | null;
  effort: number;
}

export interface Recording {
  frames: RecordedFrame[];
  /** 拍网格。没有它就没法把手势时刻换算成拍号，也就没法评分。 */
  grid: BeatGrid;
  /** 录制起止（performance.now）。 */
  startedAt: number;
  endedAt: number;
}

/**
 * 一段录制的上限。
 *
 * 60fps × 90 秒 ≈ 5400 帧，每帧几个数字，内存上完全无所谓；设上限是防止
 * 用户忘了停、页面挂着跑一晚上。到上限就停止追加，已录的部分照常可用。
 */
const MAX_FRAMES = 20000;

export class SessionRecorder {
  private frames: RecordedFrame[] = [];
  private grid: BeatGrid | null = null;
  private startedAt = 0;
  private stoppedAt = 0;
  private recording = false;

  get isRecording(): boolean {
    return this.recording;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** 已录到的拍点数，UI 实时显示用。 */
  get ictusCount(): number {
    let n = 0;
    for (const f of this.frames) if (f.ictus) n += 1;
    return n;
  }

  /** 最后一个拍点的真实时刻。跟练时用它做「刚才那一下早了/晚了」的即时反馈。 */
  get lastIctusAt(): number | null {
    for (let i = this.frames.length - 1; i >= 0; i -= 1) {
      if (this.frames[i].ictus && this.frames[i].ictusAt !== null) return this.frames[i].ictusAt;
    }
    return null;
  }

  start(grid: BeatGrid): void {
    this.frames = [];
    this.grid = grid;
    this.startedAt = performance.now();
    this.stoppedAt = 0;
    this.recording = true;
  }

  /** 直接接到 `CameraIntentSource.onSample`。 */
  push = (s: ConductSample): void => {
    if (!this.recording || this.frames.length >= MAX_FRAMES) return;
    this.frames.push({
      t: s.t,
      beat: s.beat,
      expr: s.expr,
      ictus: s.ictus,
      ictusAt: s.ictusAt,
      effort: s.intent.effort,
    });
  };

  stop(): Recording | null {
    this.recording = false;
    this.stoppedAt = performance.now();
    if (!this.grid || this.frames.length === 0) return null;
    return {
      frames: this.frames,
      grid: this.grid,
      startedAt: this.startedAt,
      endedAt: this.stoppedAt,
    };
  }
}

/** 取出所有拍点时刻（拐角的真实时刻，不是确认它的那一帧）。 */
export function ictusTimes(rec: Recording): number[] {
  const out: number[] = [];
  for (const f of rec.frames) if (f.ictus && f.ictusAt !== null) out.push(f.ictusAt);
  return out;
}

/**
 * 切出来的一小节。
 *
 * 带上 `index`（网格上的第几小节，0 起）而不只是点集，是因为「力度对应」要拿
 * 每一小节的拍型大小去比**乐曲那一小节写下的力度** —— 用户少打了开头两小节的话，
 * 按顺序对齐就会拿第 3 小节的动作去比第 1 小节的力度，相关系数变成噪声。
 */
export interface Bar {
  index: number;
  points: Point[];
}

/** 一小节至少要有这么多帧才算数：30fps 下最短的一小节（2/4 @ 168BPM）也有 21 帧。 */
const MIN_FRAMES_PER_BAR = 12;

function sliceBetween(rec: Recording, t0: number, t1: number): Point[] {
  const out: Point[] = [];
  for (const f of rec.frames) {
    if (f.t >= t0 && f.t < t1 && f.beat) out.push(f.beat);
  }
  return out;
}

/**
 * 按**拍网格**把轨迹切成一小节一段。
 *
 * 只保留完整的小节：半截小节的形状和标准拍型比没有意义，DTW 会判它一个很差的
 * 分数，而用户其实只是在开头或结尾多录了一点。
 */
export function splitBars(rec: Recording): Bar[] {
  const { grid } = rec;
  const barMs = (60000 / grid.bpm) * grid.meter;
  const withHand = rec.frames.filter((f) => f.beat);
  if (withHand.length === 0) return [];

  const firstBar = Math.ceil((withHand[0].t - grid.originPerf) / barMs);
  const lastBar = Math.floor((withHand[withHand.length - 1].t - grid.originPerf) / barMs);

  const bars: Bar[] = [];
  for (let b = Math.max(0, firstBar); b < lastBar; b += 1) {
    const t0 = grid.originPerf + b * barMs;
    const points = sliceBetween(rec, t0, t0 + barMs);
    if (points.length >= MIN_FRAMES_PER_BAR) bars.push({ index: b, points });
  }
  return bars;
}

/**
 * 按**用户自己的强拍**切小节，评拍型形状时用这个。
 *
 * 用网格切会把时间误差混进形状分：一个拖了 25% 拍长的人，网格切出来的每一"小节"
 * 都是被旋转过的拍型，DTW 距离自然差 —— 可他的形状其实是对的，晚不晚是
 * 「拍点准确度」那一维的事，在这里再罚一次就是重复计分。
 *
 * `downbeats` 是已经和网格对上、且落在小节第一拍的用户拍点：`bar` 是它对上的
 * 那个网格小节，`t` 是用户实际打下去的时刻。切片按 `t` 走（形状要按用户自己的
 * 动作切），编号按 `bar` 走（力度要和乐曲的小节对上）。
 *
 * 数量不足时返回 null，调用方回退到 `splitBars`。
 */
export function splitBarsByDownbeat(
  rec: Recording,
  downbeats: { bar: number; t: number }[],
): Bar[] | null {
  if (downbeats.length < 2) return null;
  const bars: Bar[] = [];
  for (let i = 0; i + 1 < downbeats.length; i += 1) {
    const points = sliceBetween(rec, downbeats[i].t, downbeats[i + 1].t);
    if (points.length >= MIN_FRAMES_PER_BAR) {
      bars.push({ index: downbeats[i].bar, points });
    }
  }
  return bars.length ? bars : null;
}

/** 录制的实际帧间隔中位数（毫秒）。评分要按同样的采样率去算模板的基准值。 */
export function medianFrameIntervalMs(rec: Recording): number {
  const dts: number[] = [];
  for (let i = 1; i < rec.frames.length; i += 1) {
    const dt = rec.frames[i].t - rec.frames[i - 1].t;
    if (dt > 0) dts.push(dt);
  }
  if (!dts.length) return 1000 / 30;
  dts.sort((a, b) => a - b);
  return dts[Math.floor(dts.length / 2)];
}
