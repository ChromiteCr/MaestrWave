/**
 * 考试曲目。
 *
 * 和「课程」里的练习曲是两回事，区别就在**固定**两个字：
 * 练习曲跟着本课的拍号速度走，换一课就换一首；考试曲目是**同一批曲子**，
 * 每个人考的是同一首、同一个速度、同一个拍号。不固定就没法比较，分数也就没有意义。
 *
 * ## 「固定」是怎么做到的
 *
 * 不是往仓库里塞音频文件，而是把 `music` 这份规格写死。曲子由
 * `backend/practice.py` 照着规格**写谱渲染**，同一份规格永远出同一份音频 ——
 * 于是「所有人考同一首」这件事由代码保证，而不是由「记得别改那个 wav」保证。
 * 顺带解决了三件事：不用配密钥、不用等生成、拍网格精确到零误差。
 *
 * ## 关于渐慢
 *
 * 三级曲目原本还要考渐慢。**暂时没做**：渲染链路（`score.py` 的时间换算、
 * `midi_out` 的 set_tempo）目前只支持全曲一个速度，加速度曲线要动的是项目那条
 * 链路的公共代码。与其摆一首「说是渐慢其实匀速」的曲子，不如老实少考一项。
 */

import { DIMENSIONS, type RubricDimension, type RubricItem } from "./curriculum";
import type { Meter } from "./patterns";
import { countInBarsFor, type PieceMusic } from "./piece";

/**
 * 考卷的曲子从哪来。**两者取其一**，用可辨识联合而不是两个可选字段 ——
 * 后者允许「都给」和「都不给」两种非法状态，而每多一种非法状态就是一份渲染
 * 不出来的考卷。
 *
 * - `spec`：照规格写谱，同一份规格永远渲染出同一首（`backend/practice.py`）。
 * - `repertoire`：随仓库分发的真实交响乐选段（`backend/repertoire.py`）。
 */
export type ExamSource =
  | { kind: "spec"; music: PieceMusic }
  | {
      kind: "repertoire";
      id: string;
      /** 正曲小节数与时长。写在这里，免得「清单还没加载完就显示不出时长」。 */
      bars: number;
      durationSec: number;
    };

export interface ExamPiece {
  id: string;
  title: string;
  level: 1 | 2 | 3;
  levelLabel: string;
  /** 这首考什么 —— 选它的理由。 */
  tests: string;
  meter: Meter;
  bpm: number;
  /** 覆盖哪几课（curriculum 的 lesson id）。 */
  covers: string[];
  rubric: RubricItem[];
  /**
   * 这首曲子从哪来。**改动它等于换了一份考卷**，历史分数就不再可比 ——
   * 规格（或曲目文件与截取窗口）进 piece_id，改一个数字后端就会渲染出另一首。
   */
  source: ExamSource;
}

/** 正曲小节数。真实曲目由清单给，写谱的由规格给。 */
export function examBars(p: ExamPiece): number {
  return p.source.kind === "spec" ? p.source.music.bars : p.source.bars;
}

/** 整段音频有多长（这里给的是用户要打的那段）。 */
export function examDurationSec(p: ExamPiece): number {
  if (p.source.kind === "repertoire") return p.source.durationSec;
  return Math.round(((p.source.music.bars + countInBarsFor(p.meter)) * p.meter * 60) / p.bpm);
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

/** 一条平的力度曲线。 */
function flat(n: number, v: number): number[] {
  return Array.from({ length: n }, () => v);
}

export const EXAM_PIECES: ExamPiece[] = [
  {
    id: "exam-march",
    title: "进行曲（四拍）",
    level: 1,
    levelLabel: "初级",
    tests:
      "速度全程不变，拍子被喂到嘴边，力度也一路不变。这一首不考表情，只考「乐队能不能跟住你」：拍点落得准不准、四拍拍型的走向对不对、拍点有没有落回同一个平面。打完这首拿不到分的话，问题一定在基本功上，回单元一重练。",
    meter: 4,
    bpm: 88,
    covers: ["posture", "patterns"],
    rubric: [
      { dimension: "ictusTiming", weight: 0.35 },
      { dimension: "tempoStability", weight: 0.25 },
      { dimension: "patternShape", weight: 0.25 },
      { dimension: "planeConsistency", weight: 0.15 },
    ],
    // 力度全程不变：这一首不考力度，那就别让力度在暗中影响别的维度
    source: { kind: "spec", music: {
      style: "march",
      bars: 20,
      dynamics: flat(20, 0.62),
      key: "Bb major",
    } },
  },
  {
    id: "exam-waltz",
    title: "圆舞曲（三拍，带渐强）",
    level: 2,
    levelLabel: "中级",
    tests:
      "三拍型加一段渐强，速度也比进行曲快一截。除了拍型本身，这一首开始考拍型的尺寸：音乐涨起来的时候手要跟着长大，高度和宽度一起变。表情手可以帮忙抬，主要还是看打拍手的拍型。",
    meter: 3,
    bpm: 116,
    covers: ["patterns", "left-hand", "dynamics"],
    rubric: [
      { dimension: "patternShape", weight: 0.3 },
      { dimension: "dynamicsMatch", weight: 0.25 },
      { dimension: "ictusTiming", weight: 0.25 },
      { dimension: "tempoStability", weight: 0.2 },
    ],
    // 中段一次完整的渐强再收回来。八小节推上去、再八小节退下来，
    // 两端各留几小节平的 —— 不给缓冲的话「渐强」和「起手」会混在一起评。
    source: { kind: "spec", music: {
      style: "waltz",
      bars: 24,
      dynamics: [
        0.4, 0.4, 0.4, 0.4,
        0.5, 0.6, 0.7, 0.8, 0.9, 0.95,
        0.95, 0.9, 0.8, 0.7, 0.6, 0.5,
        0.4, 0.45, 0.55, 0.65, 0.55, 0.45, 0.4, 0.35,
      ],
      key: "A major",
    } },
  },
  {
    id: "exam-lyric",
    title: "抒情段落（弱起）",
    level: 3,
    levelLabel: "高级",
    // 这一栏是纯文本渲染，不走 Markdown —— 写 ** 会原样显示出来
    tests:
      "从非第一拍进，力度变化贯穿全曲十六小节，而且拍子不再被喂到嘴边：打击乐只在强拍上给一记三角铁，中间三拍得自己数。速度只有 76，慢速最容易暴露拍点含糊的毛病，所以这一首拍点清晰度的权重也拉高了。",
    meter: 4,
    bpm: 76,
    covers: ["patterns", "upbeat-start", "dynamics"],
    rubric: [
      { dimension: "ictusTiming", weight: 0.3 },
      { dimension: "ictusClarity", weight: 0.25 },
      { dimension: "dynamicsMatch", weight: 0.25 },
      { dimension: "patternShape", weight: 0.2 },
    ],
    source: { kind: "spec", music: {
      style: "lyric",
      bars: 16,
      pickup: true,
      dynamics: [
        0.3, 0.4, 0.5, 0.45,
        0.55, 0.7, 0.85, 0.7,
        0.5, 0.4, 0.35, 0.45,
        0.6, 0.5, 0.35, 0.2,
      ],
      key: "F major",
    } },
  },
  {
    id: "exam-beethoven-7",
    title: "贝多芬 第七交响曲 第二乐章（选段）",
    level: 2,
    levelLabel: "中级",
    // 纯文本渲染，别写 **
    tests:
      "第一次带真正的管弦乐作品。速度全程不变，拍子清楚到不可能听错，但织体从五个弦乐声部一层层涨到全奏，拍型得跟着长大。力度只占 15%，因为这一首的力度曲线是从配器反推的，并非贝多芬写下的记号，不该和谱面写死的东西占一样的分量。",
    meter: 2,
    bpm: 76,
    covers: ["posture", "patterns", "dynamics"],
    /*
     * 力度只占 0.15：这首的力度曲线是**从配器反推的**，不是贝多芬写下的
     * （源文件所有音符 velocity 恒为 127，LilyPond 没写 \dynamics 时的默认导出）。
     * 推导的东西不该和谱面写死的东西占一样的分量。
     *
     * 但也不能不考 —— 反推曲线同时用于渲染，用户听到的渐强就是被考的渐强，
     * 两者同源，不存在「照着听到的打却被判错」。
     */
    rubric: [
      { dimension: "ictusTiming", weight: 0.32 },
      { dimension: "patternShape", weight: 0.27 },
      { dimension: "tempoStability", weight: 0.26 },
      { dimension: "dynamicsMatch", weight: 0.15 },
    ],
    source: {
      kind: "repertoire",
      id: "beethoven-7-ii",
      bars: 26,
      // 26 小节正曲 + 2 小节数拍 + 1 小节余韵，2/4 @ 76 BPM
      durationSec: 46,
    },
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
