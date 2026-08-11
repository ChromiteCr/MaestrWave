/**
 * 手部关键点 → ConductIntent。摄像头侧的「指挥法」实现。
 *
 * 映射依据的是真实指挥法的行业标准（见 README 的 M5 条目里列的来源）：
 *
 *   打拍手（持棒手，默认右手）
 *     · 拍点(ictus) = 手向下走到底、开始回弹的那一瞬间。教材原话是拍点由手腕的
 *       一个轻弹给出，三段式是 预备(prep) → 拍点(ictus) → 反弹(rebound)。
 *       检测的是**轨迹这个多边形的拐角**，不是「位置低于某条线」，也不是逐帧的
 *       速度过零点 —— 后者是噪声的属性不是手势的属性，实测一拍能数成三下。
 *       见 `ictusDetector.ts`。
 *     · 拍型的大小本身就表达力度 —— "the right hand pattern gradually gets larger,
 *       both in height and in width"。所以取轨迹包围盒当力度主项。
 *
 *   表情手（非持棒手，默认左手）
 *     · 力度：渐强是掌心向上、从水平面向上向外展开；渐弱是向下向内收。所以手的
 *       高度直接映射力度，这是它最主要的职能。
 *     · 声部平衡：按乐队席位（指挥视角）横向分区 —— 左手边是第一小提琴（主旋律），
 *       中间是木管/中提（和声），右手边是大提琴与低音提琴（低音）。
 *
 *   只看到一只手时退化为该手兼管两者。教材反对左右手镜像，但也承认
 *   "all the great conductors do it" —— 单手指挥同理，是现实而不是错误。
 *
 * 节奏声部不在这里映射：它由 beatPulse 驱动，在 mixIntent 里统一处理，和 IMU 路径共用。
 */
import type { ConductIntent } from "../gesture";
import {
  ACTIVE_FLOOR, MAX_BEAT_INTERVAL_MS, MIN_ACTIVE_MS, MIN_BEAT_INTERVAL_MS,
  PULSE_TAU_MS, QUIET_HOLD_MS, RELEASE_MS, SUSTAIN_FLOOR,
} from "../gestureConstants";
import type { Point } from "../teaching/patterns";
import { ICTUS_WINDOW_MS, IctusTracker } from "./ictusDetector";
import type { HandFrame, HandPoint } from "./handTracker";

// ---- 摄像头专用参数 ----

/**
 * 力度用的轨迹包围盒窗口。和 IMU 侧的力度窗口同量级，跨得过一拍。
 *
 * 拍点检测用的是更长的 `ICTUS_WINDOW_MS` —— 认一个拐角要看得见它两边的边，
 * 1200ms 在慢速下盖不住两拍。缓冲区按长的那个留，这里只是取包围盒时往回数多远。
 */
const TRAJ_WINDOW_MS = 1200;
/**
 * 包围盒对角线长度（归一化图像坐标）到力度的绝对映射区间。
 *
 * 取值要覆盖整个拍型而不只是垂直幅度：一个 4/4 拍型横向就能占到画面的三四成
 * （1下 2左 3右 4上），对角线因此天然在 0.3 以上。早先按「只有垂直幅度」估的
 * 0.04~0.32 会让任何正常大小的拍型都直接饱和到满力度。
 */
const SIZE_REST = 0.08;
const SIZE_FULL = 0.55;
/**
 * 包围盒的平滑时间常数。
 *
 * 包围盒是「窗口内最大范围」这类统计量，最远的那个点滑出窗口时盒子会**阶跃塌缩**，
 * 直接用会在停手一秒后出现一个断崖。和 IMU 侧对滑动窗口峰值做平滑是同一个道理。
 */
const SIZE_SMOOTH_TAU_MS = 250;
/** 判定「手停住了」的包围盒上限与窗口。对应 IMU 侧的峰峰值判静止。 */
const STILL_WINDOW_MS = 300;
const STILL_BOX = 0.02;
/** 表情手高度映射力度时，占最终力度的权重（其余给拍型大小）。 */
const EXPRESSION_WEIGHT = 0.6;

interface TrajPoint { t: number; x: number; y: number; }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * 图像坐标 → 指挥者自己的视角。
 *
 * 未镜像的摄像头画面里，你面对镜头，你的右手出现在图像左侧（x 小）。而席位分区
 * 说的「左手边是第一小提琴」是**指挥自己的**左右，所以要翻过来。
 */
function toConductorView(p: HandPoint, mirrored: boolean): { ux: number; h: number } {
  return {
    ux: mirrored ? p.x : 1 - p.x, // 越大越靠指挥自己的右手边
    h: 1 - p.y,                    // 图像 y 向下，翻成「越大越高」
  };
}

export interface CameraModelOptions {
  /** 交换双手职能。左撇子指挥用，教材明确说持棒手左右都可以。 */
  swapHands?: boolean;
  /** 画面是否已镜像。影响横向的席位分区，不影响拍点检测。 */
  mirrored?: boolean;
}

export class ConductingModel {
  baseBpm = 80;
  private opts: Required<CameraModelOptions>;

  private traj: TrajPoint[] = [];
  private lastT = 0;
  private bpm = 80;
  private lastBeatAt = 0;
  private beatPulse = 0;
  /** 拍点检测器。轨迹化成多边形取拐角，见 `ictusDetector.ts` 开头那段说明。 */
  private ictus = new IctusTracker();
  /** 平滑后的包围盒对角线，见 SIZE_SMOOTH_TAU_MS。 */
  private smoothDiag = 0;

  private active = false;
  private activeSince = 0;
  private quietSince = 0;
  private releaseSince = 0;
  private releaseFrom = SUSTAIN_FLOOR;
  private lastEffort = SUSTAIN_FLOOR;

  /** 最近一次识别到拍点的时刻，供 UI 打点用。 */
  lastIctusAt = 0;
  /**
   * 最近一帧两只手的**指挥视角**坐标（x 左→右，y 下→上），与
   * `lib/teaching/patterns.ts` 同一坐标系。录制层直接取这个，
   * 不要自己再算一遍镜像与左右手交换 —— 算错了评分会整体镜像，还很难发现。
   */
  lastView: { beat: Point | null; expr: Point | null } = { beat: null, expr: null };

  constructor(opts: CameraModelOptions = {}) {
    this.opts = { swapHands: !!opts.swapHands, mirrored: !!opts.mirrored };
    // 没人调 setBaseBpm 时也要有个像样的不应期，别退回 200ms 那个绝对下限
    this.setBaseBpm(this.baseBpm);
  }

  setOptions(opts: CameraModelOptions): void {
    this.opts = { ...this.opts, ...opts } as Required<CameraModelOptions>;
  }

  setBaseBpm(bpm: number): void {
    this.baseBpm = bpm;
    this.bpm = bpm;
    // 不应期按拍长走。固定 200ms 在慢速下等于没有，抖动能在一拍里攒出假拐角
    // （66 BPM 实测查准率 66%）。45% 只排除掉「比曲子快一倍以上」的候选，
    // 打半速或抢拍都不会被误杀。
    if (bpm > 0) this.ictus.setOptions({ minIntervalMs: Math.max(200, (60000 / bpm) * 0.45) });
  }

  /** 打拍手 / 表情手，按 handedness 与 swapHands 决定。 */
  private split(frame: HandFrame): { beat: HandPoint | null; expr: HandPoint | null } {
    const beat = this.opts.swapHands ? frame.left : frame.right;
    const expr = this.opts.swapHands ? frame.right : frame.left;
    // 只看到一只手：它同时负责打拍与表情
    if (!beat && expr) return { beat: expr, expr };
    return { beat, expr };
  }

  read(frame: HandFrame): ConductIntent {
    const now = frame.t;
    const dt = this.lastT ? now - this.lastT : 0;
    this.lastT = now;

    const { beat, expr } = this.split(frame);

    // 拍点脉冲先按时间衰减，检测到新拍点再打回 1（和 IMU 侧同一套逻辑）
    this.beatPulse *= dt > 0 ? Math.exp(-dt / PULSE_TAU_MS) : 1;

    if (beat) {
      const v = toConductorView(beat, this.opts.mirrored);
      this.traj.push({ t: now, x: v.ux, y: v.h });
      while (this.traj.length && now - this.traj[0].t > ICTUS_WINDOW_MS) this.traj.shift();
      const at = this.ictus.feed(this.traj);
      if (at !== null) this.acceptIctus(at);
    } else {
      this.traj = this.traj.filter((p) => now - p.t <= ICTUS_WINDOW_MS);
    }

    const exprView = expr ? toConductorView(expr, this.opts.mirrored) : null;
    this.lastView = {
      beat: beat ? { x: this.traj[this.traj.length - 1].x, y: this.traj[this.traj.length - 1].y } : null,
      expr: exprView ? { x: exprView.ux, y: exprView.h } : null,
    };

    const box = this.boundingBox(TRAJ_WINDOW_MS, now);
    const still = !beat || this.boundingBox(STILL_WINDOW_MS, now).diag < STILL_BOX;

    const k = dt > 0 ? 1 - Math.exp(-dt / SIZE_SMOOTH_TAU_MS) : 1;
    this.smoothDiag += (box.diag - this.smoothDiag) * k;

    // 力度：拍型大小是主项（教材：拍型越大力度越强），表情手的高度调制它
    const sizeEffort = clamp((this.smoothDiag - SIZE_REST) / (SIZE_FULL - SIZE_REST), 0, 1);
    let raw = sizeEffort;
    if (expr && expr !== beat) {
      const h = toConductorView(expr, this.opts.mirrored).h;
      // 手抬得越高越强 —— "begin on the horizontal plane and move upwards and outwards"
      const heightEffort = clamp((h - 0.25) / 0.5, 0, 1);
      raw = sizeEffort * (1 - EXPRESSION_WEIGHT) + heightEffort * EXPRESSION_WEIGHT;
    }

    const effort = this.gate(raw, still, now);

    return {
      effort,
      beatPulse: this.beatPulse,
      tempoRatio: this.bpm / (this.baseBpm || 80),
      emphasis: this.emphasis(expr),
      density: clamp(this.smoothDiag / SIZE_FULL, 0, 1),
      stillness: this.quietSince === 0 ? 0 : clamp((now - this.quietSince) / QUIET_HOLD_MS, 0, 1),
      expression: null,
    };
  }

  /**
   * 收下一个已确认的拍点。`at` 是**拐角本身的时刻**，不是确认它的时刻。
   *
   * 之所以要区分：多边形拐角要等出边长够了才敢认，实测滞后约 120ms。评分读的是
   * `at`，所以时间准确度不受滞后影响（实测平均偏差 19ms）；而 `beatPulse` 是
   * 现在才亮的，节奏声部的重音因此会晚一点点 —— 这是换来「不再一拍数成三下」
   * 的代价。要消掉它得再上一层锁相预测，那是另一件事。
   */
  private acceptIctus(at: number): void {
    const interval = at - this.lastBeatAt;
    if (interval > MIN_BEAT_INTERVAL_MS && interval < MAX_BEAT_INTERVAL_MS) {
      const detected = 60000 / interval;
      const lo = this.baseBpm * 0.7;
      const hi = this.baseBpm * 1.3;
      this.bpm = this.bpm * 0.85 + clamp(detected, lo, hi) * 0.15;
    }
    this.lastBeatAt = at;
    this.lastIctusAt = at;
    this.beatPulse = 1;
  }

  private boundingBox(windowMs: number, now: number): { width: number; height: number; diag: number } {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, n = 0;
    for (let i = this.traj.length - 1; i >= 0; i--) {
      const p = this.traj[i];
      if (now - p.t > windowMs) break;
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      n++;
    }
    if (n < 2) return { width: 0, height: 0, diag: 0 };
    const width = x1 - x0;
    const height = y1 - y0;
    return { width, height, diag: Math.hypot(width, height) };
  }

  /**
   * 门控 + release。和 IMU 侧同一套：停手不静音，而是约 1 秒平滑落到保持音量。
   */
  private gate(raw: number, still: boolean, now: number): number {
    if (!still) this.quietSince = 0;
    else if (this.quietSince === 0) this.quietSince = now;

    if (!this.active) {
      if (!still && raw > 0.05) {
        this.active = true;
        this.activeSince = now;
      }
    } else if (now - this.activeSince > MIN_ACTIVE_MS) {
      const quietLongEnough = this.quietSince !== 0 && now - this.quietSince >= QUIET_HOLD_MS;
      if (quietLongEnough) {
        this.active = false;
        this.releaseSince = now;
        this.releaseFrom = this.lastEffort;
      }
    }

    if (this.active) {
      this.lastEffort = Math.max(ACTIVE_FLOOR, raw);
      return this.lastEffort;
    }
    const elapsed = now - this.releaseSince;
    if (elapsed >= RELEASE_MS) {
      this.lastEffort = SUSTAIN_FLOOR;
      return SUSTAIN_FLOOR;
    }
    const k = elapsed / RELEASE_MS;
    this.lastEffort = this.releaseFrom + (SUSTAIN_FLOOR - this.releaseFrom) * k;
    return this.lastEffort;
  }

  /**
   * 声部平衡：按乐队席位（指挥视角）横向分区。
   *
   * 左手边第一小提琴 → 主旋律；中间木管/中提 → 和声；右手边大提琴与低音提琴 → 低音。
   * 这比 IMU 那套「倾斜角正负端」更符合直觉，也更好教 —— 指向哪个方位就是强调那一片。
   */
  private emphasis(expr: HandPoint | null): ConductIntent["emphasis"] {
    if (!expr) return { melody: 0, harmony: 0, bass: 0 };
    const ux = toConductorView(expr, this.opts.mirrored).ux;
    const zone = (center: number) => clamp(1 - Math.abs(ux - center) / 0.28, 0, 1);
    return { melody: zone(0.16), harmony: zone(0.5), bass: zone(0.84) };
  }

  /**
   * 回到刚 new 出来的状态。
   *
   * 教学与考试要反复重练，漏掉任何一个字段，上一次的状态就会带进下一次 ——
   * 尤其是 `lastBeatAt`：不清它的话，重练的第一下会和上一次的最后一拍算间隔，
   * 得出一个荒谬的 BPM 混进平滑里；`bpm` 不清则第二次一开始的 tempoRatio 是上次的余温。
   * 这两样都会直接污染评分。**新增私有状态时必须同步加到这里。**
   */
  reset(): void {
    this.traj = [];
    this.lastT = 0;
    this.bpm = this.baseBpm;
    this.lastBeatAt = 0;
    this.beatPulse = 0;
    this.ictus.reset();
    this.smoothDiag = 0;
    this.active = false;
    this.activeSince = 0;
    this.quietSince = 0;
    this.releaseSince = 0;
    this.releaseFrom = SUSTAIN_FLOOR;
    this.lastEffort = SUSTAIN_FLOOR;
    this.lastIctusAt = 0;
    this.lastView = { beat: null, expr: null };
  }
}
