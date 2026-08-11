/**
 * 标准图形拍型（graphic beat patterns）的几何定义。
 *
 * 一物三用，所以单独成模块：示范动画、跟练时叠在用户轨迹上的参考图、以及之后
 * DTW 拍型识别的模板。三处必须是同一份数据，否则「示范给你看的」和「评分照着比的」
 * 会是两个东西。
 *
 * ## 坐标系
 *
 * 与 `lib/camera/conductingModel.ts` 的 `toConductorView()` 完全一致：
 * `x` 0→1 是**指挥自己的**左→右（摄像头画面已镜像），`y` 0→1 是下→上（高度，
 * 注意和 canvas 的 y 轴相反）。这样 DTW 模板可以直接和摄像头输出比对，中间不用换算。
 *
 * ## 为什么所有拍点的高度都一样
 *
 * 教材反复强调 conducting plane：拍点应当落在同一个想象中的水平面上，乐手才能
 * 一眼看出「哪一下是拍」。所谓 2 拍「下→右上」、3 拍「下→右→上」、4 拍
 * 「下→左→右→上」，说的是**两个拍点之间怎么走**，不是拍点本身的高低。
 * 评分里的「平面一致性」维度就是在量这个，所以模板必须先自己守住。
 */

export type Meter = 1 | 2 | 3 | 4;

export interface Point {
  x: number;
  y: number;
}

export interface BeatPattern {
  meter: Meter;
  /** 拍点位置，按第 1 拍到第 n 拍排列，y 全部相同（conducting plane）。 */
  ictus: Point[];
  /**
   * 第 i 拍之后、第 i+1 拍之前的**反弹顶点**（轨迹真的会经过这个点，见 `controlFor`）。
   * 最后一个是回到第 1 拍的那一段 —— 它明显更高，因为这一下同时是下一小节的预备。
   */
  rebound: Point[];
  /**
   * 传统口诀里每一拍的说法（「下、左、右、上」）。它描述的是**整拍动作的走向**，
   * 讲解文字里用；不要拿它去标注拍点位置 —— 第 4 拍的「上」指的是这一拍把手带到
   * 高处准备下一小节，而它的拍点仍然落在平面上。标注拍点之间的走向请用 `strokes`。
   */
  mnemonic: string[];
  /** 第 i 拍拍点 → 第 i+1 拍拍点这一段的走向，示范图上标在箭头旁边。 */
  strokes: string[];
}

/** 拍点所在的水平面。留 0.12 而不是贴底，是给收势和渐弱留出向下的余量。 */
const PLANE = 0.12;

export const PATTERNS: Record<Meter, BeatPattern> = {
  /** 一拍子：右下→左上斜椭圆，上下尖角、左右极窄 */
  1: {
    meter: 1,
    ictus: [
      { x: 0.624, y: 0.123 },
    ],
    rebound: [
      { x: 0.536, y: 0.837 },
    ],
    mnemonic: ["下·上"],
    strokes: ["上提·预备"],
  },
  /** 二拍子横∞字：1→2 底部右弧 + 2→1 左上跨中线弧 = 横躺 8 字 */
  2: {
    meter: 2,
    ictus: [
      { x: 0.5, y: PLANE },
      { x: 0.76, y: PLANE },
    ],
    rebound: [
      { x: 0.63, y: PLANE + 0.08 },
      { x: 0.37, y: 0.84 },
    ],
    mnemonic: ["下", "右上"],
    strokes: ["向右", "上提·预备"],
  },
  /** 三拍子：1、2 在平面，3 回到身体中线上方 */
  3: {
    meter: 3,
    ictus: [
      { x: 0.5, y: PLANE },
      { x: 0.78, y: PLANE },
      { x: 0.5, y: 0.84 },
    ],
    rebound: [
      { x: 0.66, y: PLANE + 0.03 },
      { x: 0.68, y: 0.38 },
      { x: 0.5, y: 0.94 },
    ],
    mnemonic: ["下", "右", "上"],
    strokes: ["向右", "回中", "上提·预备"],
  },
  /** 四拍子：1/2/3 在平面，4 回到身体中线上方 */
  4: {
    meter: 4,
    ictus: [
      { x: 0.5, y: PLANE },
      { x: 0.21, y: PLANE },
      { x: 0.8, y: PLANE },
      { x: 0.5, y: 0.84 },
    ],
    rebound: [
      { x: 0.35, y: PLANE + 0.05 },
      { x: 0.5, y: PLANE - 0.04 },
      { x: 0.68, y: 0.45 },
      { x: 0.5, y: 0.94 },
    ],
    mnemonic: ["下", "左", "右", "上"],
    strokes: ["向左", "向右", "回中", "上提·预备"],
  },
};

/**
 * 拍与拍之间的走时不是匀速的。
 *
 * 手离开拍点时快、到反弹顶点慢下来、再加速砸向下一个拍点 —— 正是这个加速让拍点
 * 清晰可辨（评分里的「拍点清晰度」量的就是拍点处速度反转的锐度）。匀速走一遍
 * 贝塞尔看起来会像机械臂，学的人也就学不到「要加速下去」这件事。
 *
 * 导数是 1 + k·cos(2πt)：t=0（刚离开拍点）和 t=1（正砸向拍点）时最快，中间最慢。
 */
function easeThroughRebound(t: number): number {
  const k = 0.5;
  return t + (k * Math.sin(2 * Math.PI * t)) / (2 * Math.PI);
}

/**
 * 二次贝塞尔**不经过**它的控制点：控制点取 0.84 时曲线最高只到 0.48。
 * 所以 `rebound` 不能直接当控制点用 —— 那样「反弹顶点」这个名字就是假的，
 * 示范图上的高度和数据对不上（这个 bug 是把画出来的曲线量了一遍才发现的）。
 * 反解：要让曲线在 t=0.5 经过 P，控制点取 C = 2P − (A+B)/2。
 */
function controlFor(a: Point, apex: Point, b: Point): Point {
  return { x: 2 * apex.x - (a.x + b.x) / 2, y: 2 * apex.y - (a.y + b.y) / 2 };
}

function bezier(a: Point, c: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
}

/**
 * 取小节内任意时刻的手位置。
 *
 * `beat` 用「小节内的拍数」表示，可以是小数，也可以超出一小节（内部会取模）：
 * beat=0 是第 1 拍的拍点，beat=1.5 是第 2 拍与第 3 拍之间的反弹顶点附近。
 *
 * ## 1 拍特殊处理
 *
 * 1 拍是两段式椭圆：右弧（高点→右侧→拍点，下落） + 左弧（拍点→左侧→高点，上提）。
 * 椭圆逆时针旋转 20°，半长轴 0.36、半短轴 0.10（左右窄）。
 * 两段在顶部和底部接合处切线方向不同，自然形成上下两端的尖角。
 * 下落段占 45%、上提段占 55%，配合 easeThroughRebound 实现「下落略快、回升略缓」。
 */
export function patternPointAt(p: BeatPattern, beat: number): Point {
  const n = p.meter;

  // -- 1 拍：右下→左上斜椭圆，逆时针倾 7°，上下尖角、左右极窄 --
  if (n === 1) {
    const wrapped = ((beat % 1) + 1) % 1;
    const SPLIT = 0.38; // 下落段 38% vs 回升段 62%——快慢对比更剧烈

    /* 椭圆：中心偏右、逆时针 7°、半短轴 0.05 */
    const CX = 0.58, CY = 0.48;
    const A = 0.36;
    const B = 0.05;
    const ROT = 7 * Math.PI / 180;  // 逆时针 → 右下↖左上
    const cosR = Math.cos(ROT), sinR = Math.sin(ROT);

    const rot = (lx: number, ly: number): Point => ({
      x: CX + lx * cosR - ly * sinR,
      y: CY + lx * sinR + ly * cosR,
    });

    const TOP   = rot(0, A);      // 偏左上 (≈0.536, 0.837)
    const BOT   = rot(0, -A);     // 偏右下 (≈0.624, 0.123)
    const RIGHT = rot(B, 0);
    const LEFT  = rot(-B, 0);

    if (wrapped < SPLIT) {
      // 右弧下落：高点→拍点  t³ 三次 ease-in：高点极慢，越落越猛
      const raw = wrapped / SPLIT;
      const lt = raw * raw * raw;
      return bezier(TOP, controlFor(TOP, RIGHT, BOT), BOT, lt);
    }
    // 左弧上提：拍点→高点  线性匀速回升
    const raw = (wrapped - SPLIT) / (1 - SPLIT);
    return bezier(BOT, controlFor(BOT, LEFT, TOP), TOP, raw);
  }

  // -- 2 / 3 / 4 拍：通用逻辑 --
  const wrapped = ((beat % n) + n) % n;
  const i = Math.floor(wrapped);
  const t = easeThroughRebound(wrapped - i);
  const a = p.ictus[i];
  const b = p.ictus[(i + 1) % n];
  return bezier(a, controlFor(a, p.rebound[i], b), b, t);
}

/**
 * 把整条闭合轨迹采样成点列，供画图与 DTW 用。
 * `perBeat` 是每拍采样点数，DTW 模板用 24 左右即可，画图用 40 更平滑。
 */
export function samplePattern(p: BeatPattern, perBeat = 40): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < p.meter * perBeat; i += 1) {
    out.push(patternPointAt(p, i / perBeat));
  }
  out.push(patternPointAt(p, 0)); // 闭合
  return out;
}
