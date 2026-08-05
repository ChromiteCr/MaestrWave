/**
 * 构型的纯函数层：时长、段落时间轴、参与度包络、情绪柱状图分桶。
 *
 * 这里全部是纯函数，没有 React、没有网络、不碰音频引擎 —— 因为同一套逻辑要被三处
 * 消费：构型页的柱状图、指挥期的音量包络、以及后端的 prompt 结构提示（后端有一份
 * 等价实现，两边逻辑必须一致）。
 *
 * 一条贯穿设计的原则：**sections 是唯一真源**。柱状图不存任何图表数据、
 * 出声时间段不存 {start,end} 副本、高潮起止时间不做独立字段 —— 它们全都是
 * sections 的投影。同一事实存两份，用户改一次段落边界另一份就错，而且错得很安静：
 * 不报错，只是播出来不对。
 */
import type { FormationInstrument, MusicFormation, FormationSection, Project } from "./api";

/** 一段参与区间：[t0, t1) 秒内以 weight 的权重出声。 */
export interface Span {
  t0: number;
  t1: number;
  weight: number;
}

/** 低于此权重视为「不出声」，用于算出声时间段的支撑集。 */
export const SILENT_THRESHOLD = 0.05;

/**
 * 全曲时长（秒）。读新字段，回退老字段。
 *
 * 历史包袱见 backend/project.py 的同名函数：segment_duration 一个字段曾被当两个
 * 概念用（UI 写「总时长」、后端当「单次生成时长」）。M4d 起 total_duration 是正式
 * 字段，segment_duration 是后端同步写入的影子副本。
 */
export function totalDuration(project: Project): number {
  return project.total_duration ?? project.segment_duration ?? 16;
}

/** 每段的起始时刻（秒）。sections 存 duration，start 由前缀和算出来。 */
export function sectionStarts(sections: FormationSection[]): number[] {
  const starts: number[] = [];
  let acc = 0;
  for (const s of sections) {
    starts.push(acc);
    acc += s.duration;
  }
  return starts;
}

/** 段落覆盖的总时长。不变式：应当等于 formation.global.total_duration。 */
export function sectionsSpan(sections: FormationSection[]): number {
  return sections.reduce((a, s) => a + s.duration, 0);
}

/**
 * 某件乐器的参与度包络，按时间升序、相邻同权重段已合并。
 *
 * ⚠️ 这里有一处**极易写反**的语义：`participation` 为空数组时表示**全程满参与**，
 * 不是全程静音。老项目（M4d 之前建的）和还没做构型的项目都是空数组 —— 若解释成
 * 静音，用户打开老项目会一点声音都没有，而且不报任何错，极难排查。
 */
export function participationEnvelope(
  formation: MusicFormation | null | undefined,
  instrumentId: string,
  fallbackDuration: number,
): Span[] {
  const full: Span[] = [{ t0: 0, t1: fallbackDuration, weight: 1 }];
  if (!formation || formation.sections.length === 0) return full;

  const inst = formation.instruments.find((i) => i.id === instrumentId);
  // 构型里没有这件乐器（用户在生成页手动加的），按满参与处理 —— 不能让它静音。
  if (!inst || inst.participation.length === 0) return full;

  const starts = sectionStarts(formation.sections);
  const spans: Span[] = [];
  formation.sections.forEach((s, i) => {
    // participation 比 sections 短时，缺的段按满参与补，同样是「宁可响不可哑」。
    const w = i < inst.participation.length ? inst.participation[i] : 1;
    const last = spans[spans.length - 1];
    if (last && Math.abs(last.weight - w) < 1e-6) {
      last.t1 = starts[i] + s.duration;
    } else {
      spans.push({ t0: starts[i], t1: starts[i] + s.duration, weight: w });
    }
  });
  return spans;
}

/** 在某个播放位置上的参与权重。position 应已对全曲时长取模。 */
export function weightAt(spans: Span[], position: number): number {
  for (const s of spans) {
    if (position >= s.t0 && position < s.t1) return s.weight;
  }
  return spans.length ? spans[spans.length - 1].weight : 1;
}

/**
 * 出声时间段 = 包络中权重高于阈值的区间。
 *
 * 注意它是包络的**支撑集**，不是另一份数据 —— 不要把结果存回构型里。
 */
export function audibleWindows(spans: Span[]): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const s of spans) {
    if (s.weight <= SILENT_THRESHOLD) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.end - s.t0) < 1e-6) last.end = s.t1;
    else out.push({ start: s.t0, end: s.t1 });
  }
  return out;
}

/** 高潮区间 = is_climax 段的并集。与柱状图双向绑定，不做独立字段。 */
export function climaxWindow(sections: FormationSection[]): { start: number; end: number } | null {
  const starts = sectionStarts(sections);
  let start: number | null = null;
  let end = 0;
  sections.forEach((s, i) => {
    if (!s.is_climax) return;
    if (start === null) start = starts[i];
    end = starts[i] + s.duration;
  });
  return start === null ? null : { start, end };
}

// ---------------- 情绪柱状图 ----------------

/** 目标柱数。固定「每秒一根」在 16 秒曲子上只有 16 根太粗、4 分钟上 240 根太密。 */
const TARGET_BARS = 40;
const MAX_BARS = 64;

/**
 * 按小节自适应选一个分桶单位（秒），让柱数接近 TARGET_BARS。
 *
 * 候选是「拍 / 1 小节 / 2 小节 / 4 小节 / 8 小节」，取柱数不超过 MAX_BARS 且最接近
 * 目标的那个。段落边界会吸附到柱边界，因此这个单位同时也是段落时间的量化精度 ——
 * 好处是段落边界自动落在小节线上，音乐上本来就该如此。
 */
export function bucketSeconds(bpm: number, timeSignature: string, total: number): number {
  const beat = 60 / (bpm || 80);
  const beatsPerBar = Number(timeSignature?.split("/")[0]) || 4;
  const bar = beat * beatsPerBar;
  const candidates = [beat, bar, bar * 2, bar * 4, bar * 8];

  let best = candidates[0];
  let bestScore = Infinity;
  for (const unit of candidates) {
    const bars = Math.ceil(total / unit);
    if (bars > MAX_BARS) continue;
    const score = Math.abs(bars - TARGET_BARS);
    if (score < bestScore) {
      bestScore = score;
      best = unit;
    }
  }
  return best;
}

/** 段内按 shape 插值。t 是段内进度 0..1，prev 是上一段的平台值。 */
function shapeValue(s: FormationSection, t: number, prev: number): number {
  const v = s.intensity;
  switch (s.shape) {
    case "rise":
      return prev + (v - prev) * t;
    case "fall":
      return prev + (v - prev) * t; // 目标值本身更低，线性过去即可
    case "arch":
      return v - (v * 0.25) * Math.abs(2 * t - 1);
    case "dip":
      return v - (v * 0.25) * (1 - Math.abs(2 * t - 1));
    case "flat":
    default:
      return v;
  }
}

export interface EmotionBar {
  /** 桶中心时刻（秒） */
  t: number;
  value: number;
  /** 这根柱子落在哪个段落，用于整段联动拖拽与高亮 */
  sectionIndex: number;
  isClimax: boolean;
}

/**
 * 情绪柱状图数据 —— sections 的纯函数投影，不存任何图表数据。
 *
 * 不让语言模型直接返回逐点数值：长数组容易长度错、单调性乱、出现锯齿噪声，还得
 * 后处理平滑；更要命的是逐点数值会和段落结构互相矛盾，又成了双真源。模型只需要给
 * 每段的 intensity 和 shape —— 几十个 token，而且这两个量它给得比较靠谱。
 */
export function emotionBars(
  sections: FormationSection[],
  bpm: number,
  timeSignature: string,
): EmotionBar[] {
  const total = sectionsSpan(sections);
  if (total <= 0 || sections.length === 0) return [];

  const unit = bucketSeconds(bpm, timeSignature, total);
  const starts = sectionStarts(sections);
  const bars: EmotionBar[] = [];

  for (let t = 0; t < total - 1e-6; t += unit) {
    const center = Math.min(t + unit / 2, total);
    let idx = sections.length - 1;
    for (let i = 0; i < sections.length; i++) {
      if (center >= starts[i] && center < starts[i] + sections[i].duration) {
        idx = i;
        break;
      }
    }
    const s = sections[idx];
    const prev = idx > 0 ? sections[idx - 1].intensity : 0;
    const progress = s.duration > 0 ? (center - starts[idx]) / s.duration : 0;
    bars.push({
      t: center,
      value: Math.max(0, Math.min(1, shapeValue(s, progress, prev))),
      sectionIndex: idx,
      isClimax: s.is_climax,
    });
  }
  return bars;
}

/**
 * 改全曲时长：按比例缩放所有段落，让 Σduration 恒等于新总长。
 *
 * 四舍五入到 0.1 秒、误差由最后一段吸收 —— 否则反复改时长会让不变式慢慢漂掉。
 */
export function rescaleSections(sections: FormationSection[], newTotal: number): FormationSection[] {
  const old = sectionsSpan(sections);
  if (old <= 0 || sections.length === 0) return sections;
  const k = newTotal / old;
  const out = sections.map((s) => ({ ...s, duration: Math.round(s.duration * k * 10) / 10 }));
  const drift = newTotal - sectionsSpan(out);
  out[out.length - 1].duration = Math.max(0.1, out[out.length - 1].duration + drift);
  return out;
}

/** 构型里声明了但在整首曲子里全程不出声的乐器（生成时应跳过）。 */
export function silentInstruments(formation: MusicFormation): FormationInstrument[] {
  return formation.instruments.filter(
    (i) => i.participation.length > 0 && i.participation.every((w) => w <= SILENT_THRESHOLD),
  );
}
