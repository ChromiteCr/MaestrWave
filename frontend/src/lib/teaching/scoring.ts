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
 * ## 容差随速度缩放，但有一条测量下限
 *
 * 拍点偏差的容差用**拍长的百分比**而不是固定毫秒数。168 BPM 时一拍才 357ms，
 * 固定 180ms 的容差等于允许偏半拍，那就什么都没评。
 *
 * 但百分比也有下限：**没人能评得比自己量得准**。摄像头 30fps，一帧就是 33ms；
 * 拍点检测器实测的时刻偏差是 19ms。168 BPM 下 5% 的拍长只有 18ms，比测量噪声
 * 还小 —— 拿它当满分线，等于要求用户抵消掉我们自己的误差。所以满分容差取
 * `max(比例 × 拍长, MEASUREMENT_FLOOR_MS)`。
 *
 * ## 三条「不要重复计分」的线
 *
 * 同一个毛病只在一个维度上罚。这不是宽容，是准确 —— 罚两次的话分数不再代表
 * 任何一件具体的事，用户也就不知道该改什么：
 *
 * 1. **逐拍抖动**只进「拍点准确度」。「速度稳定性」看的是小节到小节的**趋势**
 *    （越打越快/越打越慢），不是每一拍的抖动。实测：合成轨迹真实速度波动恒为
 *    CV 3.6%，而按相邻拍算出来的 CV 是 4.7%~26.7% —— 其中八成是检测噪声，
 *    却被当成「速度极不稳」扣到 9 分。
 * 2. **时间误差**不进「拍型准确度」（按用户自己的强拍切小节，见 `splitBarsByDownbeat`）。
 * 3. **系统性偏移**（设备延迟、人的负偏）和**离散程度**分开算，见下。
 *
 * ## 为什么系统性偏移要单独看
 *
 * 拍点偏差里混着两样完全不同的东西：
 *
 * - **离散程度**（围绕你自己的中心偏多少）—— 这是真本事。
 * - **系统性偏移**（你的中心离网格多远）—— 这里面大部分不是本事问题。
 *   人跟拍时天然会早 20~60ms（负偏，sensorimotor synchronization 里的普遍现象，
 *   不是能练掉的）；蓝牙耳机还会再加 150~250ms，而 Web Audio 的 `outputLatency`
 *   在多数浏览器上报不出蓝牙那一段。实测 150ms 的固定延迟就能把拍点准确度打到
 *   16 分，200ms 打到 0 —— 用户什么都没做错，只是戴了耳机。
 *
 * 所以：离散程度是主项，系统性偏移做一个**有免罚区、且封了底**的乘数，
 * 并且偏移大到不像人的时候直接告诉用户去校准（`lib/teaching/latency.ts`）。
 */

import { shapeDistance } from "../camera/beatPattern";
import type { RubricDimension, RubricItem } from "./curriculum";
import { DIMENSIONS } from "./curriculum";
import { ictusTimes, medianFrameIntervalMs, splitBars, splitBarsByDownbeat, type Recording } from "./recorder";
import { motionPattern, patternPointAt, type Meter, type Point } from "./patterns";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * 测量下限（毫秒）。任何「满分容差」都不会比这个更严。
 *
 * 由两件事定：摄像头 30fps 一帧 33ms；拍点检测器实测时刻偏差 19ms（见
 * `ictusDetector.ts` 的调参记录）。取 45ms —— 比这更严就是在罚我们自己的噪声。
 */
const MEASUREMENT_FLOOR_MS = 45;

/**
 * 拍点**离散程度**（围绕自己的中心）：≤10% 拍长满分，≥38% 零分。
 *
 * 10% 不是拍脑袋：非音乐专业的人跟着节拍器打，异步量的标准差在 30~50ms 量级
 * （拍长 600~700ms 时约 5~8%），受过训练的在 20~30ms。把满分线放在 10%，
 * 意思是「一个正常初学者认真打就该拿满分」，练的是别的维度。
 */
const TIMING_PERFECT_RATIO = 0.07;
const TIMING_ZERO_RATIO = 0.3;

/** 系统性偏移的免罚区：这么多毫秒以内一分不扣。 */
const BIAS_FREE_MS = 70;
/** 偏移罚到底也只乘这个数 —— 它多半是设备延迟，不该独自决定成绩。 */
const BIAS_MIN_MULTIPLIER = 0.55;
/** 偏移大到这个程度基本不是人打出来的，提示去做延迟校准。 */
const BIAS_SUSPECT_MS = 120;

/**
 * 速度稳定性：**小节到小节**的变异系数，≤6% 满分，≥26% 零分。
 *
 * 按小节而不是按拍，是因为逐拍抖动已经在「拍点准确度」里罚过了（见文件头）。
 * 跨 `meter` 拍取一次间隔，独立噪声被摊薄到原来的 1/meter，剩下的才是真的
 * 「速度在飘」。阈值随之放宽：一段真实录制里，光是检测噪声就要占掉 3% 左右。
 */
const CV_PERFECT = 0.06;
const CV_ZERO = 0.26;
/**
 * 速度**漂移**：后段平均拍长与前段之差占全段的比例，≤5% 不罚，≥22% 零分。
 *
 * 单看变异系数抓不到「越打越快」：一段匀速加速的录制，局部速度是均匀铺开的，
 * CV 只有 9% 左右（实测 30 秒里快了 20% 的那个例子），照 CV 算还能拿 84 分。
 * 而这恰恰是这一维最该抓的毛病 —— 依据写的就是「不该变的时候就不能变」。
 * 所以两条一起看，取低的那个。
 */
const DRIFT_PERFECT = 0.02;
const DRIFT_ZERO = 0.18;
/** 平均拍长与音乐拍长的相对偏差：≤6% 不罚，≥35% 归零。作为稳定性分的乘数。 */
const TEMPO_MATCH_PERFECT = 0.06;
const TEMPO_MATCH_ZERO = 0.35;
/** 拍型 DTW 距离：≤0.08 满分，≥0.30 零分（归一化后的平均每点距离）。 */
const SHAPE_PERFECT = 0.08;
const SHAPE_ZERO = 0.3;
/** 平面一致性：拍点高度标准差占拍型高度的比例，≤7% 满分，≥28% 零分。 */
const PLANE_PERFECT = 0.07;
const PLANE_ZERO = 0.28;
/**
 * 拍点清晰度：达到标准拍型锐度的这个比例就算满分。
 *
 * 留出的 15% 是给**测量**的，不是给用户的。`templateClarity` 已经按录制的帧率
 * 去采样模板（解析精度 2.74 倍 vs 30fps 采样 2.33 倍，这一段补过了），但没有把
 * 关键点抖动算进去 —— 抖动会同时抬高平均速度、削平峰值，两头夹击。实测一个
 * 动作完全标准的人只能测到模板的 82%，那这条线定在 100% 就是谁也够不着。
 */
const CLARITY_HEADROOM = 0.85;

/** 漏拍：对上这个比例以上不扣分，往下线性罚到 0。 */
const COVERAGE_FREE = 0.92;

/**
 * 拍型小于画面对角线的这个比例，就单独提醒一句。
 *
 * 不是又加了一条评分标准，而是**把因果说清楚**。手只在画面里划拉一小块时，
 * 关键点抖动的绝对大小没变、拍型却小了，信噪比整个垮掉：实测一个动作完全正确、
 * 只是幅度缩到 12% 的人，拍点准确度 46、平面 50、清晰度 67 —— 三个维度一起塌，
 * 每一条的评语都在说别的事，用户照着改一辈子也改不对。
 *
 * 而且这本来就是教材上的第一课：手贴在身前打拍，后排乐手根本看不见。
 */
const PATTERN_SMALL = 0.22;

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
  /** 这一次打的是几拍。讲评页画时间线时要用它标小节线。 */
  meter: Meter;
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
  /**
   * 系统性偏移（中位数）：正数=拖拍，负数=抢拍，毫秒。
   * 里面可能大部分是设备延迟而不是本事问题，见 `suspectLatency`。
   */
  bias: number;
  /** 围绕自己中心的离散程度，毫秒。这一项才是「稳不稳」。 */
  spread: number;
  /**
   * 拍型的大小，占画面对角线的比例（每小节包围盒对角线的中位数）。
   * 太小的话下面那个标志会立起来 —— 这时候各维度的分数都不可信。
   */
  patternSize: number;
  /** 拍型小到会拖垮测量本身。UI 要把这句话摆在分数前面，不是藏在某一维里。 */
  tooSmall: boolean;
  /** 偏移又大又整齐，像是没校准的音频延迟而不是抢拍/拖拍。 */
  suspectLatency: boolean;
  /**
   * 每一个网格拍的偏差（毫秒，null = 这一拍没打出来）。
   * 讲评页画成一条时间线 —— 「哪几拍偏了」比「平均偏了多少」好用得多：
   * 一眼就能看出是每小节第 1 拍抢、还是打到后面越来越拖。
   */
  timeline: { beat: number; offsetMs: number | null }[];
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

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

const ramp = (v: number, perfect: number, zero: number) =>
  100 * (1 - clamp((v - perfect) / (zero - perfect), 0, 1));

/**
 * 速度漂移：后段的拍长比前段差多少（比例），以及**这个数字自身的噪声底**。
 *
 * ## 为什么在用户自己的拍点序列上算，不在对上网格的配对上算
 *
 * `matchIctus` 是「给每个网格拍找最近的拍点」。一个越打越快的人跑掉一整拍之后，
 * 网格第 b 拍会被匹配到他自己的第 b+1 拍 —— 配对跟着漂过去了，于是
 * `t[b+meter] - t[b]` 又变回了网格的拍长。实测：30 秒里加速 20% 的录制，
 * 这么算出来的漂移是 **0.1%**，等于没测。
 *
 * ## 为什么要连噪声底一起返回
 *
 * 前后两段各自的平均值都带采样误差，差值的标准差是 `sd·√(2/n)`。一个速度完全
 * 稳定、只是每拍随机抖 ±110ms 的人，光靠这份随机性就能凑出 8% 的「漂移」——
 * 不减掉这一截，就会把「手抖」判成「越打越快」，而手抖在「拍点准确度」里
 * 已经罚过了。调用方拿 `drift - 2·noise` 作为真正需要解释的那部分。
 *
 * 漏拍会造出双倍长的间隔、误检会造出半长的间隔，先按中位数把两头剔掉。
 */
interface Drift {
  /** 后段与前段的拍长差，占平均拍长的比例。 */
  drift: number;
  /** 同一个数字在「速度完全稳定、只有随机抖动」时的期望大小。 */
  noise: number;
  /** 后段更短 = 越打越快。 */
  speeding: boolean;
}

function driftOf(ictus: number[]): Drift | null {
  const d: number[] = [];
  for (let i = 1; i < ictus.length; i += 1) d.push(ictus[i] - ictus[i - 1]);
  if (d.length < 9) return null;
  const med = median(d);
  const kept = d.filter((v) => v > med * 0.7 && v < med * 1.4);
  if (kept.length < 9) return null;

  const third = Math.max(3, Math.floor(kept.length / 3));
  const m = mean(kept);
  if (m <= 0) return null;
  const head = mean(kept.slice(0, third));
  const tail = mean(kept.slice(-third));
  return {
    drift: Math.abs(tail - head) / m,
    noise: (stdev(kept) * Math.sqrt(2 / third)) / m,
    speeding: tail < head,
  };
}

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
  const p = motionPattern(meter);
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

  // 系统性偏移取**中位数**不取平均：漏掉的那一两拍会被匹配到相邻拍上，
  // 产生接近半拍的离群值，平均数会被它拽着走。
  const bias = median(offsets);
  // 离散程度是围绕**用户自己的中心**算的，不是围绕网格 —— 这两件事分开评，
  // 理由见文件头「为什么系统性偏移要单独看」。
  const spread = mean(offsets.map((o) => Math.abs(o - bias)));
  const absMae = mean(offsets.map(Math.abs));
  const coverage = pairs.length ? offsets.length / pairs.length : 0;
  const covMul = clamp(coverage / COVERAGE_FREE, 0, 1);

  const raw = new Map<RubricDimension, Omit<DimensionScore, "weight" | "label" | "dimension">>();

  // 1. 拍点准确度 = 离散程度（主项）× 系统性偏移（有免罚区的乘数）× 漏拍
  if (offsets.length >= 4) {
    // 满分容差不小于测量下限 —— 快速曲目下 10% 拍长会低于摄像头本身的分辨率
    const perfect = Math.max(TIMING_PERFECT_RATIO, MEASUREMENT_FLOOR_MS / beatMs);
    const zero = Math.max(TIMING_ZERO_RATIO, perfect * 3.8);
    const precision = ramp(spread / beatMs, perfect, zero);

    const absBias = Math.abs(bias);
    const biasMul =
      absBias <= BIAS_FREE_MS
        ? 1
        : 1 - (1 - BIAS_MIN_MULTIPLIER) *
            clamp((absBias - BIAS_FREE_MS) / (beatMs * MATCH_WINDOW_RATIO - BIAS_FREE_MS), 0, 1);

    // 偏移又大又整齐 = 设备延迟的特征（人的抢拍是散的）。这时候别怪用户。
    const looksLikeLatency = absBias > BIAS_SUSPECT_MS && spread < absBias * 0.6;

    raw.set("ictusTiming", {
      score: precision * biasMul * covMul,
      detail:
        `围绕自己的中心偏差 ${spread.toFixed(0)}ms（拍长 ${beatMs.toFixed(0)}ms 的 ${((spread / beatMs) * 100).toFixed(0)}%）` +
        `，整体${bias < 0 ? "早" : "晚"} ${absBias.toFixed(0)}ms，对上 ${offsets.length}/${pairs.length} 拍`,
      advice: looksLikeLatency
        ? `你的每一拍都稳定地${bias > 0 ? "晚" : "早"}了 ${absBias.toFixed(0)}ms —— 这么整齐的偏移通常不是人打出来的，` +
          "而是声音传到耳朵的延迟（蓝牙耳机常见 150~250ms）。先做一次延迟校准，再看这一维的分数。"
        : coverage < 0.8
          ? `有 ${pairs.length - offsets.length} 拍没打出来或偏得太远，先保证每一拍都有一个明确的落点。`
          : absBias <= BIAS_FREE_MS
            ? spread / beatMs <= perfect
              ? "拍点很准，落点也稳。"
              : "落点的中心是对的，就是每一拍散了一点。放慢速度打几遍，先把手的路线练到不用想。"
            : bias < 0
              ? `你整体早了 ${absBias.toFixed(0)}ms —— 在抢拍。等音乐先响再落手，别用手去追。`
              : `你整体晚了 ${absBias.toFixed(0)}ms —— 在拖拍。拍点要落在音上，不是听到音再落手。`,
    });
  } else {
    raw.set("ictusTiming", {
      score: null,
      detail: `只对上 ${offsets.length} 拍`,
      advice: "打够 4 拍以上才能评。",
      unavailable: "拍点太少",
    });
  }

  // 2. 速度稳定性 —— 量的是**趋势**，不是抖动
  //
  // 间隔按**跨一小节**取（第 i 拍到第 i+meter 拍，再除以 meter），不按相邻拍取。
  //
  // 相邻拍那种算法的问题是它主要在量检测噪声：每个拍点时刻带 σ 的误差，相邻两
  // 拍相减就得到 √2·σ 的间隔误差，除以一个只有一拍长的基线，噪声被放到最大。
  // 实测（合成轨迹，真实速度波动恒为 CV 3.6%）：按相邻拍算出来是 4.7%~26.7%，
  // 抖动大的时候八成以上是噪声，分数被打到 9。而那份噪声在「拍点准确度」里
  // 已经罚过一次了 —— 在这里再罚就是重复计分。
  //
  // 跨小节取，基线长了 meter 倍，独立噪声被摊薄到 1/meter，剩下的才是「越打
  // 越快 / 越打越慢」这类真的速度问题 —— 也正是这一维的依据所说的
  // 「不该变的时候就不能变」。
  //
  // 漏拍不参与：断掉的那一段平均值说明不了速度稳不稳。
  const byBeat = new Map<number, number>();
  for (const h of hits) byBeat.set(h.beat, h.t);
  const intervals: number[] = [];
  for (const h of hits) {
    const later = byBeat.get(h.beat + rec.grid.meter);
    if (later !== undefined) intervals.push((later - h.t) / rec.grid.meter);
  }
  // 一小节都跨不过去（漏拍太多）时退回相邻拍，总比评不了强
  if (intervals.length < 4) {
    for (let i = 1; i < hits.length; i += 1) {
      const span = hits[i].beat - hits[i - 1].beat;
      if (span >= 1 && span <= 4) intervals.push((hits[i].t - hits[i - 1].t) / span);
    }
  }
  if (intervals.length >= 4) {
    const m = mean(intervals);
    const cv = m > 0 ? stdev(intervals) / m : 1;
    // 漂移：前三分之一和后三分之一的平均拍长差多少。匀速加速时 CV 很小但
    // 这一项很大，正好补上 CV 抓不到的那种毛病。
    //
    // 在**用户自己的拍点序列**上算，不在对上网格的配对上算 —— 理由见 `ownTempos`。
    // 同样跨小节取，逐拍的随机抖动被摊薄，不会被误判成「越打越快」。
    // 漏拍多的时候不算漂移：一个漏拍会让那一段的「局部拍长」凭空变长，漏拍
    // 又往往扎堆出现，于是「有几段没认到手」会被读成「越打越慢」。实测一个
    // 速度完全稳定、只是拍点忽高忽低（认不全）的人会被判到 27 分。
    // 漏拍本身已经在「拍点准确度」里按覆盖率罚过了，这里不该再罚一次。
    const dr = coverage >= 0.85 ? driftOf(ictus) : null;
    const driftUsable = dr !== null;
    // 只追究「大到不像是抖出来的」那一部分。2σ ≈ 95% 的把握。
    const drift = dr ? Math.max(0, dr.drift - 2 * dr.noise) : 0;
    const speeding = dr ? dr.speeding : false;
    // 稳，但稳在错的速度上，一样是跟不上乐队 —— 这一维的依据本来就是「跟上乐队」，
    // 只看自洽性的话，一个人全程稳定地慢 30% 也能拿满分。
    const ratio = m > 0 ? m / beatMs : 1;
    const off = Math.abs(ratio - 1);
    const tempoPenalty = ramp(off, TEMPO_MATCH_PERFECT, TEMPO_MATCH_ZERO) / 100;
    const userBpm = m > 0 ? 60000 / m : 0;
    const driftScore = driftUsable ? ramp(drift, DRIFT_PERFECT, DRIFT_ZERO) : 100;
    const wobbleScore = ramp(cv, CV_PERFECT, CV_ZERO);
    raw.set("tempoStability", {
      score: Math.min(wobbleScore, driftScore) * tempoPenalty,
      detail:
        `小节间波动 ${(cv * 100).toFixed(1)}%` +
        (driftUsable ? `，前后段漂移 ${(drift * 100).toFixed(1)}%` : "，漏拍太多，没算漂移") +
        `，平均拍长 ${m.toFixed(0)}ms（约 ${userBpm.toFixed(0)} BPM，音乐是 ${rec.grid.bpm} BPM）`,
      advice:
        off > TEMPO_MATCH_PERFECT
          ? ratio > 1
            ? `你整体比音乐慢了 ${((ratio - 1) * 100).toFixed(0)}%${ratio > 1.7 ? "（像是在打半速）" : ""} —— 稳是稳的，但不是这首的速度。`
            : `你整体比音乐快了 ${((1 - ratio) * 100).toFixed(0)}%${ratio < 0.6 ? "（像是在打双倍拍）" : ""} —— 稳是稳的，但不是这首的速度。`
          : driftUsable && driftScore < wobbleScore
            ? `你越打越${speeding ? "快" : "慢"}了：后半段的拍长比前半段${speeding ? "短" : "长"} ${(drift * 100).toFixed(0)}%。` +
              `${speeding ? "赶拍通常是因为反弹越抬越小 —— 手来不及走完就急着落下。" : "拖是因为反弹越抬越高，回来的路变长了。"}` +
              "把注意力放在反弹的「顶点高度」上，让它每一拍都一样。"
            : cv <= CV_PERFECT
              ? "速度非常稳。"
              : cv < 0.14
                ? "小节之间的速度有一点飘。注意反弹的速度 —— 乐手是靠它预判下一拍什么时候到的，反弹忽快忽慢，速度就跟着变。"
                : "速度在飘。先不管拍型好不好看，把注意力放在「每一小节走完的时间一样长」上。",
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
    // 达到模板锐度的 CLARITY_HEADROOM 就算满分，留出的那一截是给测量噪声的
    const target = ref * CLARITY_HEADROOM;
    raw.set("ictusClarity", {
      score: clamp((clarity / target) * 100, 0, 100),
      detail: `拍点处速度是平均速度的 ${clarity.toFixed(2)} 倍（标准拍型 ${ref.toFixed(2)} 倍，达到 ${target.toFixed(2)} 倍算满分）`,
      advice:
        clarity >= target
          ? "拍点很清楚，乐手一眼就能看出哪一下是拍。"
          : clarity >= target * 0.75
            ? "拍点还能看出来，但不够干脆。落下的最后一小段要再加速一点 —— 是「砸」到平面上，不是「放」上去。"
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

  const barSizes = bars.map((b) => {
    const xs = b.points.map((p) => p.x);
    const ys = b.points.map((p) => p.y);
    return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  });
  const patternSize = barSizes.length ? median(barSizes) : 0;

  return {
    total: Math.round(total),
    meter: opts.meter,
    dimensions,
    beats: { expected: pairs.length, detected: ictus.length, matched: offsets.length },
    bars: bars.length,
    bias,
    spread,
    patternSize,
    tooSmall: barSizes.length >= 2 && patternSize < PATTERN_SMALL,
    suspectLatency: offsets.length >= 4 && Math.abs(bias) > BIAS_SUSPECT_MS
      && spread < Math.abs(bias) * 0.6,
    timeline: pairs,
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
