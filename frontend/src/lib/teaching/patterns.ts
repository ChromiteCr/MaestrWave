/**
 * 标准图形拍型（graphic beat patterns）的几何定义。
 *
 * 一份数据两种用法，所以单独成模块：`PATTERNS` 是**画给人看的图式**（示范动画、
 * 跟练时叠在轨迹上的参考图），`motionPattern()` 把它压成**手实际怎么动**（DTW
 * 模板、拍点清晰度的满分基准）。两者只差纵轴，见下面「图式与动作」。
 *
 * ## 坐标系
 *
 * 与 `lib/camera/conductingModel.ts` 的 `toConductorView()` 完全一致：
 * `x` 0→1 是**指挥自己的**左→右（摄像头画面已镜像），`y` 0→1 是下→上（高度，
 * 注意和 canvas 的 y 轴相反）。这样 DTW 模板可以直接和摄像头输出比对，中间不用换算。
 *
 * ## 视角：这是指挥自己的左右，不是看图的人的左右
 *
 * 教材上的图式多半画的是**乐手看指挥**的样子（左右与指挥自己相反）。这里全部按
 * 指挥自己的左右存 —— 摄像头画面已镜像，用户照着屏幕抬右手，屏幕上就往右走，
 * 不用在脑子里翻一次。所以 4 拍的第 2 拍在 `x` 小的一侧（指挥自己的左手边），
 * 与课程里「第 2 拍往右打是最常见的方向错误」是同一件事。
 *
 * ## 拍点逐拍升高
 *
 * 图式从第 1 拍的最低点开始，一拍比一拍高，最后一拍到顶 —— 最后那一下同时是
 * 下一小节的预备，手得先到得了高处，下一个第 1 拍才砸得下来。这是纸面图式的
 * 通行画法，也是这三张图各自的形状来源（2 拍向右兜一个大圈回到高处；3 拍
 * 下→右→上围成一圈；4 拍下→左→右→上，横跨最宽，长扫弦会与落下的那一笔交叉）。
 *
 * ## 图式与动作：为什么评分不能直接拿图式当模板
 *
 * 纸面图式把拍点逐拍抬高，是**为了让路线画得开、看得清**；真手不这么走 ——
 * 教材反复强调 conducting plane，拍点应当落在同一个想象中的水平面上，乐手才能
 * 一眼看出哪一下是拍，抬高的只有拍与拍之间的反弹。
 *
 * 两者混为一谈是有代价的，而且是可量化的：拿一个**打得完全正确**（拍点在平面上）
 * 的人去和图式比 DTW，2/3/4 拍分别只能拿到 65 / 42 / 60 分；和压平后的动作模板
 * 比是 100 / 85 / 76 分。所以这里分开：横向走向（下→左→右→上）是两者共有的
 * 真正信息，纵向则各说各的 —— 图式管好看，模板管好比。
 */

export type Meter = 2 | 3 | 4;

export interface Point {
  x: number;
  y: number;
}

export interface BeatPattern {
  meter: Meter;
  /** 拍点位置，按第 1 拍到第 n 拍排列。第 1 拍最低，末拍最高。 */
  ictus: Point[];
  /**
   * 第 i 拍 → 第 i+1 拍这一段的**途经点**：轨迹真的会从这里过（见 `controlFor`），
   * 不是贝塞尔控制点。整段弧的形状全靠它，所以它决定了图看起来像不像那三张手绘。
   * 最后一个是末拍回到第 1 拍的那一段 —— 落下的那一笔。
   */
  via: Point[];
  /** 传统口诀里每一拍的说法（「下、左、右、上」），讲解文字里用。 */
  mnemonic: string[];
  /**
   * 第 i 拍拍点 → 第 i+1 拍拍点这一段的走向，示范图上标在箭头旁边。
   * 这一段走的就是第 i+1 拍的动作，所以最后一段是「落下」而不是「上提」。
   */
  strokes: string[];
}

/**
 * 三张图的拍点坐标来自手绘图式，按上文的视角说明左右翻过来（手绘是乐手视角）、
 * 再收进画布的安全边距里。相对位置一律照原图：谁在谁左边、谁比谁高，都没有动。
 */
export const PATTERNS: Record<Meter, BeatPattern> = {
  /** 二拍子：落下打 1，再向右兜一个大圈升到最高处打 2 */
  2: {
    meter: 2,
    ictus: [
      { x: 0.46, y: 0.12 },
      { x: 0.52, y: 0.86 },
    ],
    via: [
      { x: 0.88, y: 0.58 },
      { x: 0.42, y: 0.5 },
    ],
    mnemonic: ["下", "右上"],
    strokes: ["向右上", "落下·预备"],
  },
  /** 三拍子：下 → 右 → 上，三个拍点围成一圈，全程在身体中线偏右 */
  3: {
    meter: 3,
    ictus: [
      { x: 0.46, y: 0.12 },
      { x: 0.9, y: 0.44 },
      { x: 0.54, y: 0.86 },
    ],
    via: [
      { x: 0.7, y: 0.22 },
      { x: 0.8, y: 0.68 },
      { x: 0.44, y: 0.49 },
    ],
    mnemonic: ["下", "右", "上"],
    strokes: ["向右", "上提", "落下·预备"],
  },
  /**
   * 四拍子：下 → 左 → 右 → 上。横向跨得最宽，这是它和三拍最好认的区别。
   * 第 2→3 拍那一长扫会与落下的那一笔交叉，手绘图上那个交点就是这么来的。
   */
  4: {
    meter: 4,
    ictus: [
      { x: 0.46, y: 0.12 },
      { x: 0.12, y: 0.38 },
      { x: 0.88, y: 0.64 },
      { x: 0.5, y: 0.88 },
    ],
    via: [
      { x: 0.28, y: 0.3 },
      { x: 0.5, y: 0.48 },
      { x: 0.64, y: 0.6 },
      { x: 0.42, y: 0.5 },
    ],
    mnemonic: ["下", "左", "右", "上"],
    strokes: ["向左", "向右", "上提", "落下·预备"],
  },
};

// ---------------- 动作模板（评分用）----------------

/** 拍点平面的高度。留 0.12 而不是贴底，是给收势和渐弱留出向下的余量。 */
const MOTION_PLANE = 0.12;
/** 拍与拍之间的反弹高度。够看得出「离开拍点又落回来」，但不喧宾夺主。 */
const MOTION_REBOUND = 0.1;
/** 末拍 → 下一小节第 1 拍那一段的抬手高度。它同时是预备拍，所以明显更高。 */
const MOTION_PREP = 0.72;

const motionCache = new Map<Meter, BeatPattern>();

/**
 * 把图式压成**手实际怎么动**：拍点全部落回同一个平面，横向位置原样保留，
 * 拍与拍之间改为向上反弹，末拍之后那一段抬得最高（它是下一小节的预备）。
 *
 * 只动纵轴。横向走向是这两件事共有的真正信息，也是乐手用来数拍的唯一线索，
 * 所以图式改了左右，模板跟着改，不会漂移；而纵轴本来就该是两回事（见文件头
 * 「图式与动作」）。
 *
 * 评分侧一律用这个，别直接用 `PATTERNS`。
 */
export function motionPattern(meter: Meter): BeatPattern {
  const hit = motionCache.get(meter);
  if (hit) return hit;
  const drawn = PATTERNS[meter];
  const out: BeatPattern = {
    ...drawn,
    ictus: drawn.ictus.map((p) => ({ x: p.x, y: MOTION_PLANE })),
    via: drawn.via.map((p, i) => ({
      x: p.x,
      y: MOTION_PLANE + (i === meter - 1 ? MOTION_PREP : MOTION_REBOUND),
    })),
  };
  motionCache.set(meter, out);
  return out;
}

/**
 * 拍与拍之间的走时不是匀速的。
 *
 * 手离开拍点时快、到弧线中段慢下来、再加速砸向下一个拍点 —— 正是这个加速让拍点
 * 清晰可辨（评分里的「拍点清晰度」量的就是拍点处速度反转的锐度）。匀速走一遍
 * 贝塞尔看起来会像机械臂，学的人也就学不到「要加速下去」这件事。
 *
 * 导数是 1 + k·cos(2πt)：t=0（刚离开拍点）和 t=1（正砸向拍点）时最快，中间最慢。
 */
function easeThroughArc(t: number): number {
  const k = 0.5;
  return t + (k * Math.sin(2 * Math.PI * t)) / (2 * Math.PI);
}

/**
 * 二次贝塞尔**不经过**它的控制点：控制点取 0.84 时曲线最高只到 0.48。
 * 所以 `via` 不能直接当控制点用 —— 那样「途经点」这个名字就是假的，
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
 * beat=0 是第 1 拍的拍点，beat=1.5 是第 2 拍与第 3 拍之间那段弧的中点。
 */
export function patternPointAt(p: BeatPattern, beat: number): Point {
  const n = p.meter;
  const wrapped = ((beat % n) + n) % n;
  const i = Math.floor(wrapped);
  const t = easeThroughArc(wrapped - i);
  const a = p.ictus[i];
  const b = p.ictus[(i + 1) % n];
  return bezier(a, controlFor(a, p.via[i], b), b, t);
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
