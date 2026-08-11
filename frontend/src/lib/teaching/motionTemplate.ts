/**
 * 评分用的动作模板：把画给人看的图式压回**手实际怎么动**。
 *
 * ## 为什么不能直接拿 `PATTERNS` 当模板
 *
 * 纸面图式把拍点逐拍抬高，是为了把路线画得开、看得清（见 `patterns.ts` 文件头）；
 * 真手不这么走 —— 教材反复强调 conducting plane，拍点应当落在同一个想象中的
 * 水平面上，抬高的只有拍与拍之间的反弹。
 *
 * 评分那边要是照着图式比，一个**拍点全部老老实实落在平面上**（也就是完全按教材
 * 做对）的人，DTW 距离反而变大。实测：
 *
 * | 拍号 | 直接用 PATTERNS | 压平之后 |
 * |------|----------------|---------|
 * | 2    | 88             | 100     |
 * | 3    | 60             | 100     |
 * | 4    | 72             | 100     |
 *
 * 也就是说做对的人要凭空丢掉 12~40 分，而「拍型准确度」在拍型那一课占 0.4 的权重。
 * 同一件事「平面一致性」那一维已经在单独评了，在这里再罚一次就是重复计分。
 *
 * ## 为什么单独成文件，而不是加回 `patterns.ts`
 *
 * `patterns.ts` 是**图式**的真源，归示范动画那条线管，会被反复调整。这里只是
 * 评分侧从它派生出来的一个视图 —— 放在一起的话，每次改图式都要在同一个文件里
 * 分辨「这段是给人看的还是给 DTW 比的」，而这正是之前混淆的起因。
 *
 * 派生规则只有一条：**拍点全部落回平面，其余原样不动。** 横向走向、反弹顶点的
 * 高度与位置全部保留 —— 那些都是图式和动作共有的真信息，图式改了模板跟着改，
 * 不会漂移。
 */

import { PATTERNS, type BeatPattern, type Meter } from "./patterns";

/**
 * 拍点平面的高度。取各拍点里**最低**的那个（也就是第 1 拍），而不是写死一个
 * 常量 —— 图式那边调整时这里自动跟上。
 */
function planeOf(p: BeatPattern): number {
  return Math.min(...p.ictus.map((q) => q.y));
}

/** 拍与拍之间的反弹高度。够看得出「离开拍点又落回来」，但不喧宾夺主。 */
const REBOUND_LIFT = 0.1;
/** 末拍 → 下一小节第 1 拍那一段的抬手高度。它同时是预备拍，所以明显更高。 */
const PREP_LIFT = 0.72;

const cache = new Map<Meter, BeatPattern>();

/**
 * 纵轴是**重新构造**的，不是从图式换算过来的。
 *
 * 试过「保留反弹相对于弦的高度」那种等价变换，对升高式图式行不通：图上那些反弹
 * 顶点的高度，大部分来自**下一个拍点本来就更高**，而不是来自反弹本身。把拍点压平
 * 之后，这份高度就跟着没了 —— 实测三拍的预备段算出来的抬手量正好是 0，也就是
 * 「预备拍完全不抬手」，而预备恰恰是整小节抬得最高的一下。
 *
 * 所以只从图式继承**横向走向**（那是图与动作共有的真信息，也是乐手数拍的唯一
 * 线索，图式改了左右这里跟着改，不会漂移），纵向按动作本身该有的样子写死。
 */
export function motionPattern(meter: Meter): BeatPattern {
  const hit = cache.get(meter);
  if (hit) return hit;
  const drawn = PATTERNS[meter];
  const plane = planeOf(drawn);
  const last = drawn.rebound.length - 1;
  const out: BeatPattern = {
    ...drawn,
    ictus: drawn.ictus.map((q) => ({ x: q.x, y: plane })),
    rebound: drawn.rebound.map((q, i) => ({
      x: q.x,
      y: plane + (i === last ? PREP_LIFT : REBOUND_LIFT),
    })),
  };
  cache.set(meter, out);
  return out;
}
