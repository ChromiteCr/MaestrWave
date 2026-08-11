/**
 * 图形拍型识别：把一小节的手部轨迹和标准拍型比对。
 *
 * 用 DTW（动态时间规整）而不是逐点欧氏距离，因为人打拍不可能和模板等速：
 * 同一个 4 拍型，有人第 2 拍拖一点、第 3 拍赶一点，形状是对的、时间对不齐。
 * 逐点比会把这种「形状对、节奏略偏」判成形状错，而节奏偏差已经由「拍点准确度」
 * 和「速度稳定性」两个维度单独评了，这里再罚一次就是重复计分。
 *
 * 做成可插拔接口：之后换成训练好的分类器时，只要实现 `BeatPatternClassifier`，
 * 评分那边一行都不用改。
 */

import { motionPattern, patternPointAt, type BeatPattern, type Meter, type Point } from "../teaching/patterns";

/** 重采样后的点数。48 点在 2/3/4 拍上都够描出形状，DTW 是 48×48 的表，可忽略不计。 */
export const RESAMPLE_N = 48;

export interface PatternMatch {
  meter: Meter;
  /** 归一化后的 DTW 平均每点距离。越小越像。 */
  distance: number;
}

export interface BeatPatternClassifier {
  /** 返回按相似度排序的候选，第一个是最像的。 */
  classify(bar: Point[]): PatternMatch[];
}

/** 按累计弧长等距重采样。按索引均分是不对的 —— 帧率抖动会让点的疏密失真。 */
export function resample(pts: Point[], n = RESAMPLE_N): Point[] {
  if (pts.length === 0) return [];
  if (pts.length === 1) return Array.from({ length: n }, () => pts[0]);

  const acc: number[] = [0];
  for (let i = 1; i < pts.length; i += 1) {
    acc.push(acc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = acc[acc.length - 1];
  if (total === 0) return Array.from({ length: n }, () => pts[0]);

  const out: Point[] = [];
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    const target = (i / (n - 1)) * total;
    while (j < acc.length - 2 && acc[j + 1] < target) j += 1;
    const span = acc[j + 1] - acc[j];
    const k = span > 0 ? (target - acc[j]) / span : 0;
    out.push({
      x: pts[j].x + (pts[j + 1].x - pts[j].x) * k,
      y: pts[j].y + (pts[j + 1].y - pts[j].y) * k,
    });
  }
  return out;
}

/**
 * 平移到质心、按包围盒对角线缩放。
 *
 * 位置和大小都要归一化掉：站得偏一点不该扣拍型分，拍型的**大小**是「力度对应」
 * 那个维度的事（教材：力度由拍型大小表达）。这里只看形状。
 */
export function normalize(pts: Point[]): Point[] {
  if (pts.length === 0) return [];
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length;
  cy /= pts.length;

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  const scale = Math.hypot(x1 - x0, y1 - y0) || 1;
  return pts.map((p) => ({ x: (p.x - cx) / scale, y: (p.y - cy) / scale }));
}

/** 标准 DTW，返回**平均每点**距离，这样点数不同也可比。 */
export function dtwDistance(a: Point[], b: Point[]): number {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return Infinity;

  // 只留两行：DTW 的递推只依赖上一行，全表存下来是 n×m 的浪费
  let prev = new Float64Array(m + 1).fill(Infinity);
  let cur = new Float64Array(m + 1).fill(Infinity);
  prev[0] = 0;

  for (let i = 1; i <= n; i += 1) {
    cur[0] = Infinity;
    for (let j = 1; j <= m; j += 1) {
      const d = Math.hypot(a[i - 1].x - b[j - 1].x, a[i - 1].y - b[j - 1].y);
      cur[j] = d + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  // 规整路径长度在 max(n,m) 到 n+m 之间，用 max 归一化是常见做法
  return prev[m] / Math.max(n, m);
}

/** 模板缓存 —— 每次分类都重算一遍模板的重采样是纯浪费。 */
const templateCache = new Map<Meter, Point[]>();

export function templateShape(meter: Meter): Point[] {
  const hit = templateCache.get(meter);
  if (hit) return hit;
  // 用动作模板而不是图式：图式为了画得开把拍点逐拍抬高了，拿它当模板，
  // 一个拍点老老实实落在平面上的人反而会被判形状不对（见 patterns.ts 文件头）
  const p: BeatPattern = motionPattern(meter);
  // 从第 1 拍拍点起，走完一整圈，和 splitBars 切出来的一小节对齐
  const raw: Point[] = [];
  const perBeat = 32;
  for (let i = 0; i < p.meter * perBeat; i += 1) {
    raw.push(patternPointAt(p, i / perBeat));
  }
  const shape = normalize(resample(raw));
  templateCache.set(meter, shape);
  return shape;
}

/**
 * ⚠️ 目前没有调用者，接进 UI 之前先读这段。
 *
 * 只看**轮廓**分不开二拍和三拍：归一化掉位置与大小之后，二拍的水滴形和三拍的
 * 圆角三角形几乎是同一条闭合线，实测两个模板之间的 DTW 距离只有 0.034，远小于
 * 判「形状对」的阈值 SHAPE_PERFECT=0.06。二者真正的区别是**拍点落在这条线的
 * 哪几处**，而这一层信息在 `normalize(resample(bar))` 里正好被丢掉了。
 *
 * 所以「你打的其实是三拍」这类诊断不能只靠它，得把拍点时刻一起喂进来。
 * 评分走的是 `shapeDistance(bar, meter)` —— 拍号由课程给定，不受这条限制。
 */
export const dtwClassifier: BeatPatternClassifier = {
  classify(bar: Point[]): PatternMatch[] {
    const shape = normalize(resample(bar));
    const metres: Meter[] = [2, 3, 4];
    return metres
      .map((meter) => ({ meter, distance: dtwDistance(shape, templateShape(meter)) }))
      .sort((a, b) => a.distance - b.distance);
  },
};

/**
 * 一小节轨迹与**指定**拍号模板的距离。评分用这个 —— 课程已经告诉我们该打几拍了，
 * 不需要先猜拍号。`classify` 用于「你打的其实是三拍」这类诊断。
 */
export function shapeDistance(bar: Point[], meter: Meter): number {
  return dtwDistance(normalize(resample(bar)), templateShape(meter));
}
