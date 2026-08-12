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
  | "dynamicsMatch"
  | "handIndependence"
  | "cueAccuracy"
  | "gesturePurpose";

export const DIMENSIONS: Record<RubricDimension, { label: string; how: string; basis: string }> = {
  ictusTiming: {
    label: "拍点准确度",
    how: "你的拍点与音乐拍网格的平均绝对时间偏差",
    basis: "拍点是「拍落在哪一刻」的确切位置，乐手靠它预判，偏差直接等于乐队跟不跟得上",
  },
  tempoStability: {
    label: "速度稳定性",
    how: "相邻两拍间隔的变异系数",
    basis: "打拍速度本身就是你给乐队的速度指令。不该变的时候变了，乐队就会跟着你一起飘",
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
  handIndependence: {
    label: "双手独立性",
    how: "表情手能否独立工作而不干扰打拍手",
    basis: "打拍手维持拍型的同时，表情手要能独立完成 cue 与声部沟通，既不镜像也不拖累拍型",
  },
  cueAccuracy: {
    label: "Cue 准确性",
    how: "目标和时间点是否清晰",
    basis: "一个能用的 cue 要有准备动作、明确目标、准确时间点，三样缺一样乐手就接不住",
  },
  gesturePurpose: {
    label: "动作信息性",
    how: "每个动作是否都有明确目的",
    basis: "表情手越克制，它真正动起来的那一下越显眼。没有目的的持续晃动只是噪声",
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
   * 写谱渲染的（`backend/practice.py`），这三条从请求变成了事实。
   */
  music: PieceMusic;
  rubric: RubricItem[];
}

export const UNITS: { unit: 1 | 2 | 3; title: string; summary: string }[] = [
  { unit: 1, title: "拍子怎么打", summary: "打拍手的基本功：站姿、图形拍型、打 1 拍" },
  { unit: 2, title: "两只手分开用", summary: "表情手不再镜像打拍手，开始做自己的事" },
  { unit: 3, title: "把音乐讲出来", summary: "用力度和速度的变化，把拍子变成音乐" },
];

/** 一条平的力度曲线。绝大多数课不考力度，写成常量比每课抄一串数字清楚。 */
const flat = (bars: number, level = 0.6): number[] => Array.from({ length: bars }, () => level);

export const LESSONS: Lesson[] = [
  {
    id: "posture",
    unit: 1,
    title: "站姿与手的位置",
    goal: "找到一个能站住整场排练、并且让最后一排也看得清你的手的姿势。",
    standard:
      "乐手看不到你的想法，只看得到你的身体。教材把站姿排在第一课，是因为含胸、耸肩、手贴着身体这几个毛病一旦长在身上，后面所有拍型都会被压扁在一个后排根本看不清的小范围里。姿势还决定你能撑多久。靠肩膀发力的人打不满一场，手会越抬越低，速度跟着一起散。",
    points: [
      "双脚与肩同宽，重量均匀落在两只脚上，膝盖不要锁死。锁死的膝盖站久了会发抖，那个抖会顺着身体一路传到手上。",
      "肩放松下沉，发力点放在背和上臂。耸着肩的人只能从肘部以下活动，拍型当场缩水一圈。",
      "手抬到胸口与肩之间，手肘离开身体，前臂大致水平。这个高度就是「平面」，往后每一课的拍点都要落回它。",
      "手掌自然半开，不要握拳。握拳会把腕关节锁住，而拍点靠的正是手腕那一下轻弹。",
      "持棒与否都可以，棒只是把手的动作延长了一截，它不改变任何一条规则。",
      "头要抬得起来。视线大部分时间给乐手，谱子是余光扫一眼的东西。",
    ],
    pitfalls: [
      "手贴在肚子前面打拍，后排乐手根本看不到。",
      "盯着谱子，抬头的次数比低头少。乐队会跟着你的注意力走，你看谱，他们也看谱。",
      "整个人绷成一根直棍。前两分钟看不出问题，半场下来手就抬不动了。",
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
      "图形拍型是乐手辨认「现在是第几拍」的唯一视觉线索。三种拍号的走向是通用约定：二拍走「下 → 右上」，三拍走「下 → 右 → 上」画出一个三角，四拍走「下 → 左 → 右 → 上」。第 1 拍永远向下，这一条全世界通行，乐手就靠它找小节线。方向打错比不打更糟，因为乐队会照着错的方向往下数。",
    points: [
      "每一拍分三段：预备（离开上一个拍点）、拍点（ictus）、反弹（rebound）。真正传达信息的只有拍点，预备和反弹都是为了让拍点落得准。",
      "拍与拍之间不匀速。离开拍点后减速，到反弹顶点最慢，再加速砸向下一个拍点。拍点清不清晰，就取决于这个加速。",
      "示范图上的拍点一拍比一拍高，那是画给眼睛看的：几条弧线挤在同一高度就分不清谁压着谁。真手不这么走，所有拍点都落回站姿那一课找到的同一个平面。图上要照做的是左右走向，高低只是画法。",
      "最后一拍的反弹明显更高，它同时充当下一小节第 1 拍的预备。",
      "先把 4 拍打熟，再换 3 拍和 2 拍。三种拍型共用同一套预备与反弹逻辑，换掉的只是中间几拍往哪走。",
    ],
    pitfalls: [
      "拍点越打越高，一小节下来手飘到了脸前面。",
      "匀速划圈，看不出哪一下是拍。",
      "四拍的第 2 拍往右打。它应该往指挥自己的左边走，这是最常见的方向错误。",
      "拍型越打越小，到后半段缩成手腕的一点抖动。",
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
    id: "one-beat",
    unit: 1,
    title: "打 1 拍",
    goal: "速度快到逐拍打就会糊的时候，把一整小节归成一下。",
    standard:
      "快速的三拍子，比如谐谑曲，逐拍打既累又乱，通行做法是整小节只给一个拍点，小节内部的第 2、3 拍交给乐手自己数。本课练习曲写的正是这种快速三拍：乐队照常演奏三拍，你只打小节头那一下。所以你听到的音符密度是你手上动作的三倍，这是对的。",
    points: [
      "动作简化成上下，拍点仍然落在同一平面。",
      "反弹承担了「这一小节有多长」的全部信息。反弹越慢越高，乐手数出来的内部拍就越慢。打 1 拍时，这是你唯一能控制速度的手段。",
      "心里要数满三拍，手再动。内部拍只存在于你脑子里，一旦停止默数，手上的间隔很快就会飘。",
      "起拍、收尾、以及任何需要精确对齐的地方，仍然要临时拆回逐拍。",
    ],
    pitfalls: [
      "一小节打一下之后速度开始飘，因为唯一的时间参照只剩反弹曲线。",
      "把反弹打成随手的回抽，高度每小节都不一样，乐队跟着忽快忽慢。",
    ],
    meters: [1],
    bpm: 90,
    music: { style: "waltz", bars: 24, dynamics: flat(24, 0.5) },
    rubric: [
      { dimension: "tempoStability", weight: 0.5 },
      { dimension: "ictusClarity", weight: 0.3 },
      { dimension: "ictusTiming", weight: 0.2 },
    ],
  },
  {
    id: "left-hand",
    unit: 2,
    title: "表情手的职责",
    goal: "让表情手停止镜像打拍手，开始说它自己的话。",
    standard:
      "传统教材把两只手称作持棒手与非持棒手，本软件按职能叫它们打拍手和表情手，默认右手打拍。打拍手建立拍子与时间框架，表情手负责 cue、声部沟通、进入与结束提示。两只手同时表达同一件事，等于把一半的表达能力扔掉了。摄像头模式下软件读的也是这套分工：表情手抬高是渐强，落下是渐弱，横向位置决定强调哪一片声部。",
    points: [
      "表情手默认安静。没有信息要传的时候，不要让它持续晃动。",
      "每个动作都要能回答「谁、什么时候、做什么」。答不上来的动作，删掉。",
      "Cue 不只是指向。一个能用的 cue 要有准备动作、明确的目标、准确的时间点，缺一样乐手就接不住。",
      "两只手可以同时做不同的事。打拍手维持拍型不停，表情手独立完成 cue，这一课练的就是这件事。",
      "静止本身就是信息。表情手越克制，它真正动起来的那一下越显眼。",
    ],
    pitfalls: [
      "两只手完全镜像，表情手重复打拍手已经说过的话。",
      "表情手一直在动，却说不出它在说什么。",
      "Cue 只剩一个指向，没有准备动作，乐手来不及反应。",
      "表情手动作过大，反而盖住了打拍手的拍型。",
    ],
    // 左手要练的是「不跟着右手镜像」，右手仍然得有拍型在走，否则无从对照。
    meters: [4],
    bpm: 84,
    // 力度一路起伏，左手才有事可做
    music: { style: "lyric", bars: 8, dynamics: [0.3, 0.35, 0.55, 0.75, 0.75, 0.5, 0.4, 0.3] },
    rubric: [
      { dimension: "handIndependence", weight: 0.4 },
      { dimension: "cueAccuracy", weight: 0.3 },
      { dimension: "gesturePurpose", weight: 0.3 },
    ],
  },
  {
    id: "upbeat-start",
    unit: 2,
    title: "从非第一拍起",
    goal: "乐曲不从第 1 拍开始时，预备拍该打哪一下。",
    standard:
      "弱起（anacrusis）很常见，规则是固定的：预备拍打入声那一拍的前一拍，并且要用它在拍型里的正确位置。从第 4 拍入，就打第 3 拍的位置；从第 2 拍入，就打第 1 拍的位置。乐手认的是方向，位置错了他们会从错的小节开始数。",
    points: [
      "先数清楚第一个音落在第几拍，再决定预备拍打在拍型的哪个位置。",
      "预备拍的方向必须和拍型一致。打第 3 拍位置就往右走，随手往下一挥会被当成第 1 拍。",
      "弱起通常较弱，预备拍的幅度要跟着收小。预备拍多大，同时也在告诉乐手第一个音该多响。",
      "预备拍的速度就是全曲的起速。它走多快，乐队的第一拍就多快，这一下没有补救机会。",
    ],
    pitfalls: [
      "不管从第几拍入，预备拍一律往下挥，乐队会当成第 1 拍。",
      "预备拍打得又大又慢，然后正曲突然快起来，开头必乱。",
    ],
    // 弱起讲的就是「预备拍打在拍型的哪个位置」，没有拍型这一课无从谈起。
    meters: [4, 3],
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
    goal: "不靠说话、不靠表情，只用拍型的尺寸改变音量。",
    standard:
      "力度由拍型的大小表达：渐强时拍型在高度和宽度上一起变大，渐弱一起变小。表情手可以补充，手心向上向外抬表示渐强，主要载体始终是打拍手拍型本身的尺寸。摄像头模式下软件量的也是这个，它取的是你这一段轨迹的包围盒对角线。",
    points: [
      "变化要连续。想要八小节的渐强，就让拍型在八小节里逐格变大。第七小节才突然放大，乐队已经来不及了。",
      "高度和宽度一起变。只变高不变宽，看起来更像速度变了。",
      "极弱时拍型可以小到只剩手腕，拍点仍然必须清晰。小不等于糊。",
      "推到最大之后要守得住。顶到头还继续加大，后面真正的高潮就没有余地了。",
    ],
    pitfalls: [
      "渐强时不自觉地越打越快。力度和速度是两回事，手上要分得开。",
      "渐弱打成停手。音量确实小下去了，拍子也一起没了。",
    ],
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
      "速度变化就是改变打拍的速度本身。关键在于可预测：乐手靠上一拍的反弹速度推算下一拍什么时候到，所以每一拍的变化量要均匀，一步跳到位没人跟得上。",
    points: [
      "渐慢时反弹要跟着拉长、拉高，让乐手提前看出下一拍会晚一点。",
      "变化摊在整段里均匀发生，一拍比一拍慢一点点。",
      "渐慢到很慢时可以临时细分，把一拍拆成两下。否则拍与拍之间空得太久，乐队会各走各的。",
      "渐快时拍型别跟着缩小。手一快就容易变小，而变小在乐手眼里是渐弱的指令。",
      "本课练习曲的速度是固定的，你练的是能不能跟上音乐的变速。方向和真实排练相反，对拍点判断的训练一样有效。",
    ],
    pitfalls: [
      "渐慢时只是把手停在半空等，没有把等待做成可读的动作。",
      "变速时盯着自己的手看。速度是给乐队的，眼睛离开他们，他们就不知道该不该跟。",
    ],
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
