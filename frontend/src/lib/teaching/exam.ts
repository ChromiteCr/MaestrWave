/**
 * 考试曲目。
 *
 * 和「课程」里的练习曲是两回事，区别就在**固定**两个字：
 * 练习曲是现场按本课需要生成的，每次都不一样，用来练；考试曲目是**同一批示例歌曲**，
 * 每个人考的是同一首、同一个速度、同一个拍号。不固定就没法比较，分数也就没有意义。
 *
 * 所以考试曲目不走 `/api/practice/generate`，而是随应用附带的音频文件。
 * 音频尚未提供时 `audio` 为 null，UI 要明说「曲目未就绪」而不是装作能考。
 */

import { DIMENSIONS, type RubricDimension, type RubricItem } from "./curriculum";
import type { Meter } from "./patterns";

export interface ExamPiece {
  id: string;
  title: string;
  level: 1 | 2 | 3;
  levelLabel: string;
  /** 这首考什么 —— 选它的理由。 */
  tests: string;
  meter: Meter;
  bpm: number;
  durationSec: number;
  /** 覆盖哪几课（curriculum 的 lesson id）。 */
  covers: string[];
  rubric: RubricItem[];
  /**
   * 示例音频的路径。null = 曲目音频还没做好，这一首不能考。
   * 之所以留成显式字段而不是「有文件就有」，是为了让「未就绪」这件事在数据里就看得见。
   */
  audio: string | null;
}

/**
 * 及格与优秀线。
 *
 * 定在 70/85 而不是更高，是因为初学者的拍点偏差天然就大：跟着音乐打拍时，
 * 人的听觉—动作延迟本身就有几十毫秒，要求太严会把「已经能带起乐队」的人判成不及格。
 * 这两个数应当在真机试考之后按实际分布回调。
 */
export const PASS_SCORE = 70;
export const GOOD_SCORE = 85;

export const EXAM_PIECES: ExamPiece[] = [
  {
    id: "exam-march",
    title: "进行曲（四拍）",
    level: 1,
    levelLabel: "初级",
    tests: "速度全程不变、拍型清楚。这一首不考表情，只考「乐队能不能跟住你」。",
    meter: 4,
    bpm: 88,
    durationSec: 60,
    covers: ["posture", "patterns"],
    rubric: [
      { dimension: "ictusTiming", weight: 0.35 },
      { dimension: "tempoStability", weight: 0.25 },
      { dimension: "patternShape", weight: 0.25 },
      { dimension: "planeConsistency", weight: 0.15 },
    ],
    audio: null,
  },
  {
    id: "exam-waltz",
    title: "圆舞曲（三拍，带渐强）",
    level: 2,
    levelLabel: "中级",
    tests: "三拍型 + 一段渐强。左手要开始做事，拍型大小得跟着音乐变。",
    meter: 3,
    bpm: 116,
    durationSec: 75,
    covers: ["patterns", "left-hand", "dynamics"],
    rubric: [
      { dimension: "patternShape", weight: 0.3 },
      { dimension: "dynamicsMatch", weight: 0.25 },
      { dimension: "ictusTiming", weight: 0.25 },
      { dimension: "tempoStability", weight: 0.2 },
    ],
    audio: null,
  },
  {
    id: "exam-lyric",
    title: "抒情段落（弱起、渐慢）",
    level: 3,
    levelLabel: "高级",
    tests: "从非第一拍进、结尾渐慢，力度变化贯穿全曲。三个单元的内容一次全考。",
    meter: 4,
    bpm: 76,
    durationSec: 90,
    covers: ["patterns", "upbeat-start", "dynamics", "tempo-change"],
    rubric: [
      { dimension: "ictusTiming", weight: 0.3 },
      { dimension: "ictusClarity", weight: 0.25 },
      { dimension: "dynamicsMatch", weight: 0.25 },
      { dimension: "patternShape", weight: 0.2 },
    ],
    audio: null,
  },
];

export function examDimensions(piece: ExamPiece): { key: RubricDimension; label: string; how: string; weight: number }[] {
  return piece.rubric.map((r) => ({
    key: r.dimension,
    label: DIMENSIONS[r.dimension].label,
    how: DIMENSIONS[r.dimension].how,
    weight: r.weight,
  }));
}

export function findExamPiece(id: string | null): ExamPiece | null {
  if (!id) return null;
  return EXAM_PIECES.find((p) => p.id === id) ?? null;
}
