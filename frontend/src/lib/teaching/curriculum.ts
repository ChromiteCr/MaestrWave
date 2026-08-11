/**
 * 指挥教学的课程数据。
 *
 * 全部是静态内容 —— 不走后端、不需要联网、不需要摄像头。没配天琴密钥、没插摄像头的
 * 人也应该能把讲解和示范完整看完，这是「降低门槛」的最低要求。
 *
 * ## 编排依据
 *
 * 顺序取自 ConductIT（欧盟指挥教育项目）的单元划分：先把右手的图形拍型练到不用想，
 * 再谈两只手的独立性，最后才是力度与速度的变化。这个顺序不是随便排的 —— 左手要能
 * 做别的事，前提是右手已经能自己走完拍型；力度变化又建立在拍型稳定之上。
 *
 * `standard` 一栏是对教材要点的中文转述，不是原文照抄。
 */

import type { Meter } from "./patterns";
import type { PieceMusic } from "./piece";

/** 评分维度。第 5 步实现打分时按这些维度算，这里先把「本课评什么」定下来。 */
export type RubricDimension =
  | "ictusTiming"
  | "tempoStability"
  | "patternShape"
  | "ictusClarity"
  | "planeConsistency"
  | "dynamicsMatch";

export const DIMENSIONS: Record<RubricDimension, { label: string; how: string; basis: string }> = {
  ictusTiming: {
    label: "拍点准确度",
    how: "你的拍点与音乐拍网格的平均绝对时间偏差",
    basis: "拍点是「拍落在哪一刻」的确切位置，乐手靠它预判，偏差直接等于乐队跟不跟得上",
  },
  tempoStability: {
    label: "速度稳定性",
    how: "相邻两拍间隔的变异系数",
    basis: "速度变化是靠改变打拍速度来表达的 —— 不该变的时候变了，就是在给乐队错误指令",
  },
  patternShape: {
    label: "拍型准确度",
    how: "你的轨迹与标准图形拍型的 DTW 距离",
    basis: "图形拍型是乐手辨认「现在是第几拍」的唯一视觉线索",
  },
  ictusClarity: {
    label: "拍点清晰度",
    how: "拍点处速度反转的锐度",
    basis: "拍点要由一个明确的加速与制动给出，含糊的拍点等于没有拍点",
  },
  planeConsistency: {
    label: "平面一致性",
    how: "各拍点高度的离散程度",
    basis: "拍点应落在同一个想象中的水平面（conducting plane）上",
  },
  dynamicsMatch: {
    label: "力度对应",
    how: "拍型大小与乐曲力度的相关性",
    basis: "力度由拍型的大小表达，拍型在高度与宽度上一起变大就是渐强",
  },
};

export interface RubricItem {
  dimension: RubricDimension;
  /** 本课这一项占多少权重，同一课加起来为 1。 */
  weight: number;
}

export interface Lesson {
  id: string;
  unit: 1 | 2 | 3;
  title: string;
  /** 一句话说清这节课要练成什么。 */
  goal: string;
  /** 行业标准依据（中文转述）。教学价值主要在这一栏。 */
  standard: string;
  /** 讲解要点，逐条列出。 */
  points: string[];
  /** 常见错误，写出来比只讲对的更有用。 */
  pitfalls: string[];
  /** 本课示范哪些拍型。空数组表示这一课没有图形拍型可示范（如站姿）。 */
  meters: Meter[];
  /** 练习曲与示范动画的默认速度。 */
  bpm: number;
  /**
   * 本课练习曲怎么写。
   *
   * M7e 之前这里是一段喂给音频生成模型的提示词（`practicePrompt`），要求它
   * 「BPM 必须准、要有打击乐、开头带一小节数拍」—— 三条都是**请求**，模型给不给
   * 是另一回事，所以还得配一套能量起始点检测去猜拍网格在哪。现在练习曲是自己
   * 写谱渲染的，这三条从请求变成了事实，那套检测也就不需要了。
   */
  music: PieceMusic;
  rubric: RubricItem[];
}

export const UNITS: { unit: 1 | 2 | 3; title: string; summary: string }[] = [
  { unit: 1, title: "拍子怎么打", summary: "右手的基本功：站姿、图形拍型" },
  { unit: 2, title: "两只手分开用", summary: "左手不再跟着右手镜像，开始做自己的事" },
  { unit: 3, title: "把音乐讲出来", summary: "力度、速度变化 —— 让拍子变成音乐" },
];

/** 一条平的力度曲线。绝大多数课不考力度，写成常量比每课抄一串数字清楚。 */
const flat = (bars: number, level = 0.6): number[] => Array.from({ length: bars }, () => level);

export const LESSONS: Lesson[] = [
  {
    id: "posture",
    unit: 1,
    title: "站姿与手的位置",
    goal: "找到一个能连站二十分钟、并且让全乐队都看得见你的手的姿势。",
    standard:
      "指挥的身体是乐手唯一的信息来源。教材把站姿放在第一课，是因为含胸、耸肩、手贴着身体这些毛病一旦形成，后面所有拍型都会被压扁在一个乐手看不清的小范围里。",
    points: [
      "双脚与肩同宽，重量均匀落在两只脚上，膝盖不锁死。",
      "肩放松下沉。耸肩会让手臂只能从肘部以下活动，拍型立刻缩水。",
      "手抬到胸口与肩之间的高度，手肘离开身体，前臂大致水平 —— 这个高度就是之后所有拍点要落回的「平面」。",
      "手掌自然半开，不握拳。持棒与否都可以，棒只是把手的动作延长了一截。",
    ],
    pitfalls: [
      "手贴在肚子前面打拍 —— 后排乐手根本看不到。",
      "身体前倾盯着谱子，抬头次数比低头少。",
    ],
    meters: [],
    bpm: 84,
    music: { style: "lyric", bars: 8, dynamics: flat(8, 0.5) },
    rubric: [
      { dimension: "planeConsistency", weight: 0.6 },
      { dimension: "ictusClarity", weight: 0.4 },
    ],
  },
  {
    id: "patterns",
    unit: 1,
    title: "基本图形拍型（2 / 3 / 4 拍）",
    goal: "手能自己走完拍型，不用想下一拍往哪去。",
    standard:
      "图形拍型是乐手辨认「现在是第几拍」的唯一视觉线索，三种拍号的走向是通用约定：二拍「下 → 右上」，三拍「下 → 右 → 上」构成三角形，四拍「下 → 左 → 右 → 上」。第 1 拍永远向下 —— 这是全世界通行的一条，乐手就靠它找小节线。",
    points: [
      "每一拍都是三段：预备（离开上一个拍点）→ 拍点（ictus）→ 反弹（rebound）。真正传达信息的是拍点，反弹只是为了去下一个拍点。",
      "图式逐拍升高：第 1 拍最低，最后一拍最高。最后一拍同时是下一小节的预备 —— 手先到得了高处，下一个第 1 拍才砸得下来。",
      "拍与拍之间不是匀速：离开拍点后减速，到弧线中段最慢，再加速砸向下一个拍点。这个加速就是拍点清晰的来源。",
      "示范图上的左右是「指挥自己的」左右。教材图多半画的是乐手看你的样子，左右正好相反，照着抄会打反。",
    ],
    pitfalls: [
      "一小节一小节整体往上爬，几小节下来手飘到了脸前面 —— 每小节的第 1 拍都要回到同一个低点。",
      "匀速划圈，看不出哪一下是拍。",
      "四拍的第 2 拍往右打（应该往指挥自己的左边）—— 这是最常见的方向错误。",
    ],
    meters: [4, 3, 2],
    bpm: 88,
    music: { style: "march", bars: 8, dynamics: flat(8) },
    rubric: [
      { dimension: "patternShape", weight: 0.4 },
      { dimension: "ictusTiming", weight: 0.25 },
      { dimension: "planeConsistency", weight: 0.2 },
      { dimension: "tempoStability", weight: 0.15 },
    ],
  },
  {
    id: "left-hand",
    unit: 2,
    title: "非持棒手的职责",
    goal: "让左手停止模仿右手，开始说自己的话。",
    standard:
      "右手管拍子与速度，左手管别的：给声部进入的提示、调力度、做分句、平衡音量。教材反对两手镜像 —— 镜像等于把左手浪费掉了，同时让画面变得没有重点。持棒手放左放右都可以，重要的是分工，不是哪只手。",
    points: [
      "左手默认应该是静止的。它一动，乐手就知道「这是给我的」。",
      "手心向上、向上向外抬 = 渐强；手心向下、向下压 = 渐弱。",
      "给某个声部提示时，要看着他们 —— 手势加眼神才算一个 cue。",
      "在本软件里，左手的横向位置对应乐队席位：偏左是主旋律（第一小提琴一侧），中间是和声（木管），偏右是低音（大提琴与低音提琴一侧）。",
    ],
    pitfalls: [
      "两手完全镜像，全程一起画同一个拍型。",
      "左手一直在动，于是它什么也没说。",
    ],
    meters: [],
    bpm: 84,
    // 力度一路起伏，左手才有事可做 —— 这一课的 rubric 里「力度对应」占一半
    music: { style: "lyric", bars: 8, dynamics: [0.3, 0.35, 0.55, 0.75, 0.75, 0.5, 0.4, 0.3] },
    rubric: [
      { dimension: "dynamicsMatch", weight: 0.5 },
      { dimension: "patternShape", weight: 0.3 },
      { dimension: "tempoStability", weight: 0.2 },
    ],
  },
  {
    id: "one-beat",
    unit: 2,
    title: "打 1 拍",
    goal: "速度快到一小节只能给一下时，怎么打。",
    standard:
      "快速的三拍子（如谐谑曲）逐拍打会又累又乱，通行做法是整小节只打一下。此时拍点仍然要清晰，只是小节内部的第 2、3 拍交给乐手自己数。",
    points: [
      "动作变成单纯的上下，但拍点仍然落在同一平面。",
      "反弹的高度承担了「这一小节有多长」的信息 —— 反弹越慢越高，乐手数出来的内部拍就越慢。",
      "开始与结束、以及任何需要精确对齐的地方，仍然要临时拆回逐拍。",
    ],
    pitfalls: ["一小节打一下之后速度开始飘 —— 因为唯一的时间参照只剩反弹曲线。"],
    meters: [3],
    bpm: 168,
    // 168 BPM 的三拍一小节才 1.07 秒，8 小节太短，给到 16
    music: { style: "waltz", bars: 16, dynamics: flat(16, 0.5) },
    rubric: [
      { dimension: "tempoStability", weight: 0.5 },
      { dimension: "ictusClarity", weight: 0.3 },
      { dimension: "ictusTiming", weight: 0.2 },
    ],
  },
  {
    id: "upbeat-start",
    unit: 2,
    title: "从非第一拍起",
    goal: "乐曲不从第 1 拍开始时，预备拍该打哪一下。",
    standard:
      "弱起（anacrusis）很常见。规则是固定的：预备拍打的是**入声那一拍的前一拍**，并且要用它在拍型中的正确位置。从第 4 拍入，就打第 3 拍的位置；从第 2 拍入，就打第 1 拍的位置。",
    points: [
      "先数清楚第一个音落在第几拍，再决定预备拍打在拍型的哪个位置。",
      "预备拍的方向必须和拍型一致 —— 打第 3 拍位置就要往右走，不能随手往下一挥。",
      "弱起通常较弱，预备拍的幅度也要相应收小。",
    ],
    pitfalls: ["不管从第几拍入，预备拍一律往下挥，乐队会当成第 1 拍。"],
    meters: [],
    bpm: 88,
    music: { style: "march", bars: 8, dynamics: flat(8), pickup: true },
    rubric: [
      { dimension: "ictusTiming", weight: 0.5 },
      { dimension: "patternShape", weight: 0.3 },
      { dimension: "ictusClarity", weight: 0.2 },
    ],
  },

  {
    id: "dynamics",
    unit: 3,
    title: "力度：拍型的大小",
    goal: "不靠说话、不靠表情，只靠拍型的尺寸改变音量。",
    standard:
      "力度由拍型的大小表达：渐强时拍型在高度和宽度上一起变大，渐弱则一起变小。左手可以补充（手心向上向外抬 = 渐强），但主要载体是右手拍型本身的尺寸。",
    points: [
      "变化要连续。想要八小节的渐强，就让拍型在八小节里逐格变大，不能第七小节才突然放大。",
      "高度和宽度要一起变。只变高不变宽，看起来像速度变了而不是音量变了。",
      "极弱的时候拍型可以小到只剩手腕，但拍点仍然必须清晰。",
    ],
    pitfalls: ["渐强时不自觉地越打越快 —— 力度和速度是两件事。"],
    meters: [4],
    bpm: 80,
    // 八小节从极弱推到齐奏再收回来，正是本课要用拍型大小表达的东西
    music: { style: "lyric", bars: 8, dynamics: [0.12, 0.28, 0.44, 0.6, 0.78, 0.92, 0.6, 0.28] },
    rubric: [
      { dimension: "dynamicsMatch", weight: 0.5 },
      { dimension: "tempoStability", weight: 0.3 },
      { dimension: "patternShape", weight: 0.2 },
    ],
  },
  {
    id: "tempo-change",
    unit: 3,
    title: "渐慢与渐快",
    goal: "让整个乐队跟着你一起变速，而不是散掉。",
    standard:
      "速度变化就是改变打拍的速度本身。关键在于变化必须可预测：乐手是靠上一拍的反弹速度推算下一拍什么时候到的，所以每一拍的变化量要均匀，不能一步跳到位。",
    points: [
      "渐慢时反弹要相应地拉长、拉高，让乐手看出「下一拍会晚一点」。",
      "变化要摊在整段里均匀发生，一拍比一拍慢一点点。",
      "渐慢到很慢时可以临时细分（把一拍拆成两下），否则拍与拍之间空得太久，乐队会各走各的。",
      "本软件的教学模式里音乐速度是固定的，练的是「你能不能跟上音乐的变速」，方向和真实排练相反 —— 但对拍点判断的训练是一样的。",
    ],
    pitfalls: ["渐慢时只是把手停在半空等，没有把等待做成可读的动作。"],
    meters: [4, 3],
    bpm: 84,
    // 音乐速度固定，练的是「你能不能跟住」，见本课讲解最后一条
    music: { style: "march", bars: 8, dynamics: flat(8) },
    rubric: [
      { dimension: "ictusTiming", weight: 0.4 },
      { dimension: "tempoStability", weight: 0.3 },
      { dimension: "patternShape", weight: 0.3 },
    ],
  },
];

export function findLesson(id: string | null): Lesson | null {
  if (!id) return null;
  return LESSONS.find((l) => l.id === id) ?? null;
}

export function lessonsOfUnit(unit: 1 | 2 | 3): Lesson[] {
  return LESSONS.filter((l) => l.unit === unit);
}

/** 课程列表里的序号（跨单元连续），讲解页也用它。 */
export function lessonIndex(id: string): number {
  return LESSONS.findIndex((l) => l.id === id) + 1;
}
