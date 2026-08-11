/**
 * 拍点检测：把手的轨迹**化成多边形**，取多边形的拐角。
 *
 * ## 为什么不能用逐帧的速度过零点
 *
 * 原来的做法是「垂直速度由负转正 = 拍点」。运动学上说得通，工程上不成立：
 * 过零点是**噪声的属性**，不是手势的属性。MediaPipe 的关键点在 30fps 下有
 * 0.003~0.01 的抖动，手本身还有 8~12Hz 的生理性微颤，于是每一下真实的击拍
 * 附近都会冒出一串符号翻转。实测合成轨迹：正常挥 30 秒（应有 44 拍）数出
 * 84~121 拍，间隔中位数只有 100~133ms —— 也就是三四帧一「拍」。
 *
 * 反过来，动作足够干净时它又漏拍：它只看高度一维，而 2/3/4 拍图式里真正
 * 「先下后上」的只有第 1 拍，其余几拍是**横向**的折返。
 *
 * ## 多边形拐角
 *
 * 拍点在几何上就是图式的**角**：手走到那里，方向变了。所以：
 *
 *   1. 取最近一段轨迹，用 Douglas–Peucker 把它简化成折线。抖动的幅度远小于
 *      简化阈值，整串假过零点在这一步就消失了 —— 这是它比逐帧求导稳的根本原因。
 *   2. 折线的每个内部顶点看两条邻边：都够长、且转角够大，才算一个拍点。
 *   3. 两个拍点之间还要隔开最短时间，同一个角不会被数两次。
 *
 * 判据是二维的（转角），不是一维的（高度），所以横向折返的第 2、3 拍也认得出来。
 * 走满一小节时这条折线首尾相接，就是「拍型」那个多边形本身。
 *
 * ## 代价：确认是滞后的
 *
 * 一个角要等**出边**长到够了才能确认，因此拍点是回头才认出来的，滞后约
 * 0.2~0.3 拍。给评分用完全没问题（评分本来就是录完再算，而且时间戳记的是
 * 拐角本身的时刻，不是确认的时刻）；驱动节奏声部的实时脉冲不能等这么久，
 * 那条路径见 `ConductingModel` 里的说明。
 */

export interface PathPoint {
  /** performance.now()，毫秒。 */
  t: number;
  /** 指挥视角坐标：x 左→右，y 下→上。与 lib/teaching/patterns.ts 同坐标系。 */
  x: number;
  y: number;
}

export interface IctusOptions {
  /** Douglas–Peucker 阈值，占轨迹包围盒对角线的比例。比抖动大、比拍型小。 */
  epsilonRatio: number;
  /** 拐点两侧的边至少要有这么长（占对角线），太短的角是噪声残留。 */
  minEdgeRatio: number;
  /** 转角小于这个度数的不算拐角 —— 那是弧线，不是拍点。 */
  minTurnDeg: number;
  /**
   * 两个拍点之间的最短间隔（不应期）。
   *
   * 默认 200ms 只是个绝对下限（300 BPM，远超人手能打的极限）。**知道曲子速度时
   * 一定要按速度调**：慢速下这个下限形同虚设 —— 66 BPM 一拍有 909ms，一拍之内
   * 手走得慢、抖动有足够时间攒出一个像模像样的假拐角，实测查准率掉到 66%；
   * 按拍长的 45% 设不应期之后回到 90% 以上。见 `ConductingModel.setBaseBpm`。
   */
  minIntervalMs: number;
  /** 包围盒对角线小于这个值就认为没在挥拍，一个拍点都不给。 */
  minSpan: number;
  /** 只认「低角」（进来在下行、出去在上行）。关掉它会把反弹顶点也数成拍点。 */
  requireLowCorner: boolean;
}

export const DEFAULT_ICTUS_OPTIONS: IctusOptions = {
  // 这四个值是在合成的真人轨迹上扫出来的（2/3/4 拍 × 66/88/120 BPM ×
  // 三档抖动 × 三个随机种子）：查全 95%、查准 93%、拍点时刻平均偏差 19ms。
  epsilonRatio: 0.1,
  minEdgeRatio: 0.14,
  minTurnDeg: 35,
  minIntervalMs: 200,
  minSpan: 0.06,
  requireLowCorner: true,
};

/** 轨迹要留够两条边才认得出中间那个角。2 秒在 60 BPM 下也盖得住两拍。 */
export const ICTUS_WINDOW_MS = 2000;

function dist(a: PathPoint, b: PathPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 点到线段的垂直距离。线段退化成一点时就是点距。 */
function pointToSegment(p: PathPoint, a: PathPoint, b: PathPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Douglas–Peucker 折线简化。保留的点都是原始采样，所以时间戳是真的，不是插出来的。
 *
 * 用显式栈而不是递归：轨迹长度由窗口决定（60fps × 2s = 120 点）虽然爆不了栈，
 * 但这里每帧都要跑一次，省掉调用开销没有坏处。
 */
export function simplifyPath(pts: PathPoint[], epsilon: number): PathPoint[] {
  if (pts.length <= 2) return pts.slice();

  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop() as [number, number];
    if (hi - lo < 2) continue;
    let worst = 0;
    let worstAt = -1;
    for (let i = lo + 1; i < hi; i += 1) {
      const d = pointToSegment(pts[i], pts[lo], pts[hi]);
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }
    if (worstAt >= 0 && worst > epsilon) {
      keep[worstAt] = 1;
      stack.push([lo, worstAt], [worstAt, hi]);
    }
  }

  const out: PathPoint[] = [];
  for (let i = 0; i < pts.length; i += 1) if (keep[i]) out.push(pts[i]);
  return out;
}

export interface Corner extends PathPoint {
  /** 转角度数，越大越像一个明确的击点。同一处有多个候选时按它取舍。 */
  turnDeg: number;
}

export function boundingSpan(pts: PathPoint[]): number {
  if (pts.length < 2) return 0;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return Math.hypot(x1 - x0, y1 - y0);
}

/**
 * 从一段轨迹里找出拍点。纯函数 —— 实时那条路和录完之后重算用的是同一份代码，
 * 「示范给你看的」「评分照着比的」必须是同一个东西，这里同理。
 */
export function detectIctus(
  path: PathPoint[],
  options: Partial<IctusOptions> = {},
): Corner[] {
  const opt = { ...DEFAULT_ICTUS_OPTIONS, ...options };
  if (path.length < 5) return [];

  const span = boundingSpan(path);
  if (span < opt.minSpan) return [];

  const poly = simplifyPath(path, span * opt.epsilonRatio);
  const minEdge = span * opt.minEdgeRatio;

  const found: Corner[] = [];
  for (let i = 1; i < poly.length - 1; i += 1) {
    const a = poly[i - 1];
    const b = poly[i];
    const c = poly[i + 1];
    const inLen = dist(a, b);
    const outLen = dist(b, c);
    if (inLen < minEdge || outLen < minEdge) continue;

    // 转角 = 两条边方向之差。0° 是直着走，180° 是原路折回
    const a1 = Math.atan2(b.y - a.y, b.x - a.x);
    const a2 = Math.atan2(c.y - b.y, c.x - b.x);
    let turn = Math.abs(a2 - a1);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    const turnDeg = (turn * 180) / Math.PI;
    if (turnDeg < opt.minTurnDeg) continue;

    /*
     * 一个拍型的多边形有两种角：底下的击点，和拍与拍之间顶上的反弹顶点，
     * 数量各一半。只数「角」的话每拍会多出一个，查准率卡在六成上不去。
     *
     * 击点是**低**的那种：进来的边在下行、出去的边在上行。判据看着和老的
     * 「垂直速度过零点」一样，区别在于这里比的是多边形的两条边，不是相邻两帧
     * —— 抖动早在简化那一步就被抹掉了，剩下的下行/上行是真的在下行、上行。
     */
    if (opt.requireLowCorner && !(b.y < a.y && b.y < c.y)) continue;

    found.push({ t: b.t, x: b.x, y: b.y, turnDeg });
  }

  // 挨得太近的只留转得最狠的那个
  const out: Corner[] = [];
  for (const c of found) {
    const prev = out[out.length - 1];
    if (prev && c.t - prev.t < opt.minIntervalMs) {
      if (c.turnDeg > prev.turnDeg) out[out.length - 1] = c;
      continue;
    }
    out.push(c);
  }
  return out;
}

/**
 * 实时用的增量包装：每帧喂当前的滚动窗口，返回**这一帧新确认**的拍点。
 *
 * 只认时间戳比上一个已发的更晚的拐角。窗口末尾的角会随着新点到来而稳定下来，
 * 而 `detectIctus` 要求出边够长才认，所以一个角被发出来时它已经不会再挪了。
 */
export class IctusTracker {
  private lastEmitted = 0;
  private options: Partial<IctusOptions>;

  constructor(options: Partial<IctusOptions> = {}) {
    this.options = options;
  }

  /** 改参数不清空已发出的进度 —— 换速度不该让当前这一拍被重复报一次。 */
  setOptions(patch: Partial<IctusOptions>): void {
    this.options = { ...this.options, ...patch };
  }

  reset(): void {
    this.lastEmitted = 0;
  }

  /** @returns 新拍点的时刻（就是拐角本身的时刻，不是确认它的时刻），没有则 null。 */
  feed(window: PathPoint[]): number | null {
    const minInterval = this.options.minIntervalMs ?? DEFAULT_ICTUS_OPTIONS.minIntervalMs;
    const corners = detectIctus(window, this.options);
    let emitted: number | null = null;
    for (const c of corners) {
      if (c.t > this.lastEmitted && c.t - this.lastEmitted >= minInterval) {
        this.lastEmitted = c.t;
        emitted = c.t;
      }
    }
    return emitted;
  }
}
