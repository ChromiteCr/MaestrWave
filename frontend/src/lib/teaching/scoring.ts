/**
 * 六维评分。
 *
 * ## 为什么是客观指标而不是一个笼统的分数
 *
 * 指挥比赛的文献自己就承认人工评审主观性高，且很大程度上"often due to poor
 * descriptions" —— 评语说不清楚，分数就没有说服力。所以这里每一维都：
 * 给出**具体数字**（偏了多少毫秒、变异系数多少）、说清**怎么算的**、
 * 再给一句**能照着改的建议**。用户拿到的不是「78 分」，是「平均早了 62 毫秒，
 * 你在抢拍」。
 *
 * ## 满分怎么定
 *
 * 凡是能用标准拍型算出来的，就拿**模板自己的数值当满分基准**（见
 * `templateClarity`）。这比拍脑袋定一个阈值可靠：标准动作应该得满分，
 * 这是定义问题，不是调参问题。
 *
 * ## 容差随速度缩放
 *
 * 拍点偏差的容差用**拍长的百分比**而不是固定毫秒数。168 BPM 时一拍才 357ms，
 * 固定 180ms 的容差等于允许偏半拍，那就什么都没评。
 */

import { shapeDistance } from "../camera/beatPattern";
import type { RubricDimension, RubricItem } from "./curriculum";
import { DIMENSIONS } from "./curriculum";
import { ictusTimes, medianFrameIntervalMs, splitBars, splitBarsByDownbeat, type Recording } from "./recorder";
import { PATTERNS, patternPointAt, type Meter, type Point } from "./patterns";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 拍点偏差：≤5% 拍长满分，≥25% 拍长零分。 */
const TIMING_PERFECT_RATIO = 0.05;
const TIMING_ZERO_RATIO = 0.25;
/** 速度稳定性：变异系数 ≤3% 满分，≥20% 零分。 */
const CV_PERFECT = 0.03;
const CV_ZERO = 0.2;
/** 平均拍长与音乐拍长的相对偏差：≤4% 不罚，≥30% 归零。作为稳定性分的乘数。 */
const TEMPO_MATCH_PERFECT = 0.04;
const TEMPO_MATCH_ZERO = 0.3;
/** 拍型 DTW 距离：≤0.06 满分，≥0.30 零分（归一化后的平均每点距离）。 */
const SHAPE_PERFECT = 0.06;
const SHAPE_ZERO = 0.3;
/** 平面一致性：拍点高度标准差占拍型高度的比例，≤4% 满分，≥25% 零分。 */
const PLANE_PERFECT = 0.04;
const PLANE_ZERO = 0.25;

/** 匹配拍点时的搜索半径，超过半拍就不算「对应同一拍」了。 */
const MATCH_WINDOW_RATIO = 0.5;

export interface DimensionScore {
  dimension: RubricDimension;
  label: string;
  /** 0~100。null 表示这一维这次评不了（数据不够或功能未接入）。 */
  score: number | null;
  /** 归一化后的实际权重。评不了的维度权重被摊给其它维度，这里是摊完的值。 */
  weight: number;
  /** 具体数字。 */
  detail: string;
  /** 一句能照着改的建议。 */
  advice: string;
  /** 评不了的原因。 */
  unavailable?: string;
}

export interface SessionScore {
  total: number;
  dimensions: DimensionScore[];
  beats: {
    /** 网格上应该有多少拍（只算录制覆盖到的部分）。 */
    expected: number;
    /** 用户实际打出多少拍。 */
    detected: number;
    /** 其中有多少能对上网格。 */
    matched: number;
  };
  bars: number;
  /** 正数=拖拍，负数=抢拍，毫秒。 */
  bias: number;
}

export interface ScoreOptions {
  meter: Meter;
  rubric: RubricItem[];
  /**
   * 乐曲每小节写下的力度（0~1），下标就是小节号（0 起，数拍不算），用来评
   * 「力度对应」。来自 `backend/practice.py` 的 `loudness_per_bar`。
   *
   * 跟节拍器练时不传 —— 那一维会标成评不了并把权重摊给其它维度，而不是给个
   * 0 分冤枉人。
   */
  loudnessPerBar?: number[];
}

// ---- 各维度 ----

interface Matched {
  /** 每个网格拍对应的用户拍点时刻（毫秒），没对上是 null。 */
  pairs: { beat: number; offsetMs: number | null }[];
  offsets: number[];
  /** 对上了的拍：网格上的第几拍 + 用户实际打的时刻。算拍间隔要用它，见下。 */
  hits: { beat: number; t: number }[];
  /** 对上了、且落在小节第一拍的那些用户拍点。按用户强拍切小节时用。 */
  downbeats: { bar: number; t: number }[];
}

function matchIctus(rec: Recording, ictus: number[]): Matched {
  const beatMs = 60000 / rec.grid.bpm;
  const window = beatMs * MATCH_WINDOW_RATIO;

  // 只统计录制真正覆盖到的那些网格拍
  const first = Math.ceil((rec.startedAt - rec.grid.originPerf) / beatMs);
  const last = Math.floor((rec.endedAt - rec.grid.originPerf) / beatMs);

  const pairs: Matched["pairs"] = [];
  const offsets: number[] = [];
  const hits: Matched["hits"] = [];
  const downbeats: Matched["downbeats"] = [];
  const used = new Set<number>();

  for (let b = Math.max(0, first); b <= last; b += 1) {
    const target = rec.grid.originPerf + b * beatMs;
    let bestI = -1;
    let bestD = Infinity;
    ictus.forEach((t, i) => {
      if (used.has(i)) return;
      const d = Math.abs(t - target);
      if (d < bestD) { bestD = d; bestI = i; }
    });
    if (bestI >= 0 && bestD <= window) {
      used.add(bestI);
      const off = ictus[bestI] - target;
      pairs.push({ beat: b, offsetMs: off });
      offsets.push(off);
      hits.push({ beat: b, t: ictus[bestI] });
      if (b % rec.grid.meter === 0) {
        downbeats.push({ bar: b / rec.grid.meter, t: ictus[bestI] });
      }
    } else {
      pairs.push({ beat: b, offsetMs: null });
    }
  }
  return { pairs, offsets, hits, downbeats };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

const ramp = (v: number, perfect: number, zero: number) =>
  100 * (1 - clamp((v - perfect) / (zero - perfect), 0, 1));

/** 用户端算清晰度时的回看窗口。 */
const CLARITY_LOOKBACK_MS = 60;

/**
 * 模板自己的「拍点清晰度」，作为满分基准。
 *
 * 定义为：拍点前后的峰值速度 ÷ 整小节的平均速度。标准拍型在拍点前是加速的，
 * 这个比值明显大于 1；匀速划圈的人接近 1。
 *
 * **必须按录制的实际帧率来采样**。模板用解析精度算出来是 2.74 倍，而 30fps 采样
 * 下同一条轨迹只测得到 2.33 倍 —— 峰值被离散采样抹掉了。拿解析值当满分基准，
 * 等于设了一个谁都够不着的线，完美动作也只能得 85 分。
 */
function templateClarity(meter: Meter, bpm: number, frameMs: number): number {
  const p = PATTERNS[meter];
  const beatMs = 60000 / bpm;
  const dBeat = frameMs / beatMs;
  const speedAt = (beat: number) => {
    const a = patternPointAt(p, beat - dBeat / 2);
    const b = patternPointAt(p, beat + dBeat / 2);
    return Math.hypot(b.x - a.x, b.y - a.y) / frameMs;
  };

  // 平均速度：按帧步长走完一整小节
  const steps = Math.max(8, Math.round(meter / dBeat));
  let total = 0;
  for (let i = 0; i < steps; i += 1) total += speedAt((i / steps) * meter);
  const avg = total / steps;
  if (avg <= 0) return 1;

  // 拍点峰值：和 userClarity 一样，取拍点前 CLARITY_LOOKBACK_MS 内的最大速度
  const look = Math.max(1, Math.round(CLARITY_LOOKBACK_MS / frameMs));
  let peaks = 0;
  for (let i = 0; i < meter; i += 1) {
    let best = 0;
    for (let k = 0; k <= look; k += 1) best = Math.max(best, speedAt(i - k * dBeat));
    peaks += best;
  }
  return peaks / meter / avg;
}

/** 用户实际的拍点清晰度：拍点前 60ms 的峰值速度 ÷ 全段平均速度。 */
function userClarity(rec: Recording): number | null {
  const frames = rec.frames.filter((f) => f.beat);
  if (frames.length < 10) return null;

  const speeds: { t: number; v: number }[] = [];
  for (let i = 1; i < frames.length; i += 1) {
    const dt = frames[i].t - frames[i - 1].t;
    if (dt <= 0) continue;
    const a = frames[i - 1].beat as Point;
    const b = frames[i].beat as Point;
    speeds.push({ t: frames[i].t, v: Math.hypot(b.x - a.x, b.y - a.y) / dt });
  }
  if (speeds.length < 5) return null;
  const avg = mean(speeds.map((s) => s.v));
  if (avg <= 0) return null;

  const ictusAt = ictusTimes(rec);
  if (ictusAt.length === 0) return null;
  const peaks = ictusAt.map((t) => {
    const near = speeds.filter((s) => s.t <= t && t - s.t <= CLARITY_LOOKBACK_MS);
    return near.length ? Math.max(...near.map((s) => s.v)) : 0;
  });
  return mean(peaks) / avg;
}

// ---- 主入口 ----

export function scoreSession(rec: Recording, opts: ScoreOptions): SessionScore {
  const beatMs = 60000 / rec.grid.bpm;
  const ictus = ictusTimes(rec);
  const { pairs, offsets, hits, downbeats } = matchIctus(rec, ictus);
  // 形状按用户自己的强拍切，时间误差才不会渗进拍型分（见 splitBarsByDownbeat）
  const bars = splitBarsByDownbeat(rec, downbeats) ?? splitBars(rec);

  const absMae = mean(offsets.map(Math.abs));
  const bias = mean(offsets);
  const coverage = pairs.length ? offsets.length / pairs.length : 0;

  const raw = new Map<RubricDimension, Omit<DimensionScore, "weight" | "label" | "dimension">>();

  // 1. 拍点准确度
  if (offsets.length >= 4) {
    const base = ramp(absMae / beatMs, TIMING_PERFECT_RATIO, TIMING_ZERO_RATIO);
    // 漏拍要罚：只打了三下却下下精准，不该拿高分
    raw.set("ictusTiming", {
      score: base * coverage,
      detail: `平均偏差 ${absMae.toFixed(0)}ms（拍长 ${beatMs.toFixed(0)}ms 的 ${((absMae / beatMs) * 100).toFixed(0)}%），对上 ${offsets.length}/${pairs.length} 拍`,
      advice:
        coverage < 0.8
          ? `有 ${pairs.length - offsets.length} 拍没打出来或偏得太远，先保证每一拍都有一个明确的落点。`
          : Math.abs(bias) < beatMs * 0.03
            ? "偏差没有系统性方向，属于抖动，多练几遍就会收敛。"
            : bias < 0
              ? `你平均早了 ${Math.abs(bias).toFixed(0)}ms —— 在抢拍。等音乐先响再落手，别用手去追。`
              : `你平均晚了 ${bias.toFixed(0)}ms —— 在拖拍。拍点要落在音上，不是听到音再落手。`,
    });
  } else {
    raw.set("ictusTiming", {
      score: null,
      detail: `只对上 ${offsets.length} 拍`,
      advice: "打够 4 拍以上才能评。",
      unavailable: "拍点太少",
    });
  }

  // 2. 速度稳定性
  //
  // 间隔要按**对上网格的那些拍**来算，并且除以它们之间隔了几拍。
  //
  // 直接拿相邻拍点相减不行：漏掉一拍就会多出一个双倍长的间隔，几个这样的间隔
  // 就足以把变异系数从 4% 抬到 25%，于是「漏了几拍」被算成「速度极不稳」，
  // 同一件事在「拍点准确度」那一维已经按覆盖率罚过一次了。多打出来的杂拍同理，
  // 它们对不上网格，本来就不该参与速度的统计。
  const intervals: number[] = [];
  for (let i = 1; i < hits.length; i += 1) {
    const span = hits[i].beat - hits[i - 1].beat;
    // 隔了四拍以上说明中间断了一大段，那一段的平均值说明不了速度稳不稳
    if (span >= 1 && span <= 4) intervals.push((hits[i].t - hits[i - 1].t) / span);
  }
  if (intervals.length >= 4) {
    const m = mean(intervals);
    const cv = m > 0 ? stdev(intervals) / m : 1;
    // 稳，但稳在错的速度上，一样是跟不上乐队 —— 这一维的依据本来就是「跟上乐队」，
    // 只看自洽性的话，一个人全程稳定地慢 30% 也能拿满分。
    const ratio = m > 0 ? m / beatMs : 1;
    const off = Math.abs(ratio - 1);
    const tempoPenalty = ramp(off, TEMPO_MATCH_PERFECT, TEMPO_MATCH_ZERO) / 100;
    const userBpm = m > 0 ? 60000 / m : 0;
    raw.set("tempoStability", {
      score: ramp(cv, CV_PERFECT, CV_ZERO) * tempoPenalty,
      detail:
        `拍间隔 ${m.toFixed(0)}ms（约 ${userBpm.toFixed(0)} BPM，音乐是 ${rec.grid.bpm} BPM），变异系数 ${(cv * 100).toFixed(1)}%`,
      advice:
        off > TEMPO_MATCH_PERFECT
          ? ratio > 1
            ? `你整体比音乐慢了 ${((ratio - 1) * 100).toFixed(0)}%${ratio > 1.7 ? "（像是在打半速）" : ""} —— 稳是稳的，但不是这首的速度。`
            : `你整体比音乐快了 ${((1 - ratio) * 100).toFixed(0)}%${ratio < 0.6 ? "（像是在打双倍拍）" : ""} —— 稳是稳的，但不是这首的速度。`
          : cv <= CV_PERFECT
            ? "非常稳。"
            : cv < 0.1
              ? "基本稳，个别拍抢了或拖了。注意反弹的速度 —— 乐手是靠它预判下一拍什么时候到的。"
              : "速度在飘。先不管拍型好不好看，跟着节拍器把间隔打匀。",
    });
  } else {
    raw.set("tempoStability", {
      score: null,
      detail: `只有 ${intervals.length} 个间隔`,
      advice: "连续打够 5 拍以上才能评。",
      unavailable: "拍点太少",
    });
  }

  // 3. 拍型准确度
  if (bars.length >= 1) {
    const dists = bars.map((b) => shapeDistance(b.points, opts.meter));
    const d = mean(dists);
    raw.set("patternShape", {
      score: ramp(d, SHAPE_PERFECT, SHAPE_ZERO),
      detail: `${bars.length} 个完整小节，与 ${opts.meter} 拍标准拍型的平均 DTW 距离 ${d.toFixed(3)}`,
      advice:
        d <= SHAPE_PERFECT
          ? "形状很准。"
          : opts.meter === 4
            ? "对照示范再走几遍。四拍最常见的错是第 2 拍往右打了 —— 它应该去你自己的左边。"
            : "对照示范再走几遍，注意每一拍走向的先后顺序。",
    });
  } else {
    raw.set("patternShape", {
      score: null,
      detail: "没有完整的小节",
      advice: "至少完整打满一小节。",
      unavailable: "小节不足",
    });
  }

  // 4. 拍点清晰度
  const clarity = userClarity(rec);
  if (clarity !== null) {
    const ref = templateClarity(opts.meter, rec.grid.bpm, medianFrameIntervalMs(rec));
    raw.set("ictusClarity", {
      score: clamp((clarity / ref) * 100, 0, 100),
      detail: `拍点处速度是平均速度的 ${clarity.toFixed(2)} 倍（标准拍型是 ${ref.toFixed(2)} 倍）`,
      advice:
        clarity >= ref
          ? "拍点很清楚，乐手一眼就能看出哪一下是拍。"
          : "拍点糊了 —— 你在匀速划圈。离开拍点后要减速，到反弹顶点最慢，再加速砸下去。",
    });
  } else {
    raw.set("ictusClarity", {
      score: null,
      detail: "数据不足",
      advice: "多打几拍。",
      unavailable: "帧数不足",
    });
  }

  // 5. 平面一致性
  const ictusHeights = rec.frames.filter((f) => f.ictus && f.beat).map((f) => (f.beat as Point).y);
  if (ictusHeights.length >= 4 && bars.length >= 1) {
    const heights = bars.map((b) => {
      const ys = b.points.map((p) => p.y);
      return Math.max(...ys) - Math.min(...ys);
    });
    const patternHeight = mean(heights) || 1;
    const sd = stdev(ictusHeights);
    const ratio = sd / patternHeight;
    raw.set("planeConsistency", {
      score: ramp(ratio, PLANE_PERFECT, PLANE_ZERO),
      detail: `拍点高度标准差为拍型高度的 ${(ratio * 100).toFixed(0)}%`,
      advice:
        ratio <= PLANE_PERFECT
          ? "拍点都落在同一个平面上。"
          : "拍点在上下跑。想象胸前有一张水平的桌面，每一拍都要落到桌面上。",
    });
  } else {
    raw.set("planeConsistency", {
      score: null,
      detail: "拍点太少",
      advice: "打够 4 拍以上才能评。",
      unavailable: "拍点太少",
    });
  }

  // 6. 力度对应
  //
  // 力度曲线是练习曲**谱面上写下的**每小节力度（`backend/practice.py`），不是从
  // 音频测的响度 —— 测出来的那个会被混响、配器、乃至这一小节恰好有没有镲声污染。
  //
  // 按 `bar.index` 取值，不按顺序对齐：用户漏掉开头两小节的话，顺序对齐会拿他
  // 第 3 小节的动作去比第 1 小节的力度，算出来的相关系数纯属噪声。
  const loud = opts.loudnessPerBar;
  const paired = loud
    ? bars.filter((b) => b.index >= 0 && b.index < loud.length)
    : [];
  if (loud && paired.length >= 3) {
    const sizes = paired.map((b) => {
      const xs = b.points.map((p) => p.x);
      const ys = b.points.map((p) => p.y);
      return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    });
    const target = paired.map((b) => loud[b.index]);
    // 力度全程不变的曲子（进行曲那一首）没有相关性可言 —— 这时候「拍型大小
    // 也别变」才是对的，所以改成看稳定性：变异系数越小越好。
    const spread = Math.max(...target) - Math.min(...target);
    if (spread < 0.1) {
      const m = mean(sizes);
      const cv = m > 0 ? stdev(sizes) / m : 1;
      raw.set("dynamicsMatch", {
        score: ramp(cv, 0.08, 0.4),
        detail: `这一首力度全程不变，你的拍型大小波动 ${(cv * 100).toFixed(0)}%`,
        advice:
          cv <= 0.08
            ? "拍型大小很稳 —— 音乐没有力度变化时，拍型也不该忽大忽小。"
            : "音乐的力度没变，拍型大小却在变 —— 乐队会以为你在要求渐强渐弱。",
      });
    } else {
      const r = pearson(sizes, target);
      raw.set("dynamicsMatch", {
        score: clamp(((r + 1) / 2) * 100, 0, 100),
        detail: `${paired.length} 个小节，拍型大小与谱面力度的相关系数 ${r.toFixed(2)}`,
        advice:
          r > 0.6
            ? "拍型大小跟着音乐走，对了。"
            : r > 0.2
              ? "方向对了但跟得不够 —— 渐强要从第一小节就开始逐格变大，不能到高潮才突然放大。"
              : "音乐变响时拍型要跟着变大，高度和宽度一起变 —— 只变高看起来像速度变了。",
      });
    }
  } else {
    raw.set("dynamicsMatch", {
      score: null,
      detail: loud ? `只有 ${paired.length} 个小节能和乐谱对上` : "这一次没有练习曲，跟的是节拍器",
      advice: loud ? "完整打满三小节以上才能评。" : "跟着练习曲或考试曲目打，这一维才评得了。",
      unavailable: loud ? "小节不足" : "没有力度曲线",
    });
  }

  // 权重归一化：评不了的维度把权重摊给其它维度，而不是当 0 分算
  const items = opts.rubric.filter((r) => raw.has(r.dimension));
  const usable = items.filter((r) => raw.get(r.dimension)!.score !== null);
  const usableWeight = usable.reduce((s, r) => s + r.weight, 0);

  const dimensions: DimensionScore[] = items.map((r) => {
    const d = raw.get(r.dimension)!;
    return {
      dimension: r.dimension,
      label: DIMENSIONS[r.dimension].label,
      score: d.score,
      weight: d.score === null || usableWeight === 0 ? 0 : r.weight / usableWeight,
      detail: d.detail,
      advice: d.advice,
      unavailable: d.unavailable,
    };
  });

  const total = dimensions.reduce((s, d) => s + (d.score ?? 0) * d.weight, 0);

  return {
    total: Math.round(total),
    dimensions,
    beats: { expected: pairs.length, detected: ictus.length, matched: offsets.length },
    bars: bars.length,
    bias,
  };
}

function pearson(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i += 1) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}
