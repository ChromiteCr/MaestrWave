/**
 * 评分用的动作模板：把画给人看的图式压回**手实际怎么动**。
 *
 * ## 为什么不能直接拿 `PATTERNS` 当模板
 *
 * `patterns.ts` 的文件头写得很清楚：「拍点应当落在同一个想象中的水平面上」。
 * 但它的数据里，三拍的第 3 拍和四拍的第 4 拍都在 `y = 0.84` —— 图上那一拍画在
 * 高处，是为了把「这一拍同时是下一小节的预备」表达出来，纸面上这么画没问题。
 *
 * 问题在于评分那边照着它比：一个**拍点全部老老实实落在平面上**（也就是完全
 * 按教材做对）的人，DTW 距离反而变大。实测：
 *
 * | 拍号 | 直接用 PATTERNS | 压平之后 |
 * |------|----------------|---------|
 * | 2    | 100            | 100     |
 * | 3    | 85             | 100     |
 * | 4    | 76             | 100     |
 *
 * 也就是说做对的人要凭空丢掉 15~24 分，而「拍型准确度」在拍型那一课占 0.4 的权重。
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
 * 拍点平面的高度。取各拍点里**最低**的那个，而不是写死一个常量 ——
 * 图式那边调整 PLANE 时这里自动跟上。
 */
function planeOf(p: BeatPattern): number {
  return Math.min(...p.ictus.map((q) => q.y));
}

const cache = new Map<Meter, BeatPattern>();

export function motionPattern(meter: Meter): BeatPattern {
  const hit = cache.get(meter);
  if (hit) return hit;
  const drawn = PATTERNS[meter];
  const plane = planeOf(drawn);
  const out: BeatPattern = {
    ...drawn,
    ictus: drawn.ictus.map((q) => ({ x: q.x, y: plane })),
    // rebound 一个都不动：反弹的高低是真手也会走的，正是「拍点清晰度」要量的东西
    rebound: drawn.rebound.map((q) => ({ ...q })),
  };
  cache.set(meter, out);
  return out;
}
