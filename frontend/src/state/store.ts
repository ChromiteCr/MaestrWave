import { create } from "zustand";
import { buildAgentContext } from "../lib/agentContext";
import { sharedAudioEngine } from "../lib/audioEngine";
import { DEFAULT_CONDUCT_MODE, type ConductMode } from "../lib/conductMode";
import {
  api,
  ApiError,
  type AgentMessage,
  type HealthInfo,
  type Instrument,
  type InstrumentLibrary,
  type Project,
} from "../lib/api";

/**
 * 助手报错时给一句**能照着做**的话。
 *
 * 404 值得单独说：它几乎只有一个成因 —— 后端进程是加这个接口之前起的。
 * 原样显示 `{"detail":"Not Found"}` 的话，看到的人完全无从下手。
 */
function agentErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404) {
      return "后端上没有这个接口，多半是后端进程还是旧的。重启后端再试。";
    }
    if (e.status === 403) {
      return `${e.message}（隧道开着时调用语言模型要令牌，在「设置」页填）`;
    }
    if (e.status === 502) {
      return `语言模型那边出错了：${e.message}`;
    }
    return e.message;
  }
  // fetch 本身失败（后端没起、端口不通）不会有状态码
  if (e instanceof TypeError) return "连不上后端，确认它还在运行。";
  return e instanceof Error ? e.message : String(e);
}

export type PageId =
  | "home"
  | "teach"
  | "teach-lesson"
  | "teach-exam"
  | "file"
  | "formation"
  | "generate"
  | "browse"
  | "output"
  | "train"
  | "settings";

/**
 * 一级导航。「指挥教学」教你怎么指挥，「指挥体验」是原有的建项目→构型→生成→浏览→输出。
 * `global` 是不属于任何一级的工具页（训练、设置），侧栏固定放在底部。
 */
export type Section = "teach" | "perform" | "global";

/**
 * 一级归属从 activePage 推导，**不单独存一份 section**。
 * 存两份就得让每一处 setActivePage 都记得同步，而跨页跳转有好几处（打开项目、
 * 应用到生成页、编辑乐器）—— 少一处就是一个"侧栏高亮和内容对不上"的 bug。
 */
export const PAGE_SECTION: Record<PageId, Section> = {
  // 首页归 global：它在两条路径之上，进它**不该**把侧栏已经展开的那一级收回去。
  home: "global",
  teach: "teach",
  "teach-lesson": "teach",
  "teach-exam": "teach",
  file: "perform",
  formation: "perform",
  generate: "perform",
  browse: "perform",
  output: "perform",
  train: "global",
  settings: "global",
};

const AGENT_OPEN_KEY = "mw.agent.open";
const CONDUCT_MODE_KEY = "mw.conductMode";

function readConductMode(): ConductMode {
  try {
    const v = localStorage.getItem(CONDUCT_MODE_KEY);
    return v === "camera" || v === "stage" ? v : DEFAULT_CONDUCT_MODE;
  } catch {
    return DEFAULT_CONDUCT_MODE; // 隐私模式下 localStorage 会抛
  }
}

function readAgentOpen(): boolean {
  try {
    return localStorage.getItem(AGENT_OPEN_KEY) === "1";
  } catch {
    // 这一行原来是裸的，而它在 store 工厂里**同步执行** —— 抛出来就不是
    // 「助手面板不记得展开状态」，是整个 app 白屏。
    return false;
  }
}

/**
 * 提问轮次。「清空」把它 +1，在飞的那一轮回来时就知道自己已经不算数了。
 *
 * 放在模块作用域而不是 state 里：它是个纯粹的并发标记，没有任何界面读它，
 * 进了 state 只会让每个订阅者白白多一次重渲染。
 */
let agentEpoch = 0;

/** 点一级导航时落到哪一页。 */
export const SECTION_HOME: Record<Exclude<Section, "global">, PageId> = {
  teach: "teach",
  perform: "file",
};

/**
 * 去过的地方。课程页的返回键要回到**真正的上一页**，而不是写死的课程列表 ——
 * 一节课能从课程列表进，也能从首页的入口卡直接进，还能从侧栏的课程树跳过来。
 * 写死的话，从首页点进一课再返回，会被送到一个自己从没打开过的列表。
 *
 * 记 `lessonId` 是因为「上一页」可能就是另一节课（在树里连着点两课）。
 */
interface NavEntry {
  page: PageId;
  lessonId: string | null;
}

/** 栈深度。够覆盖一次连续浏览，又不至于让「返回」变成走不完的迷宫。 */
const NAV_DEPTH = 20;

function pushNav(stack: NavEntry[], entry: NavEntry): NavEntry[] {
  const top = stack[stack.length - 1];
  // 同一个地方连着进两次不入栈，否则要按两下返回才动一格
  if (top && top.page === entry.page && top.lessonId === entry.lessonId) return stack;
  return [...stack, entry].slice(-NAV_DEPTH);
}

interface AppState {
  activePage: PageId;
  setActivePage: (page: PageId) => void;
  /**
   * 侧栏当前展开的一级。跳到训练/设置这种 global 页时**保持不变** —— 从「输出」点
   * 「设置」再看侧栏，二级列表还应该是指挥体验那五项，否则回不去。
   */
  navSection: Exclude<Section, "global">;

  /** 去过的地方，见上方 `NavEntry`。空栈表示没地方可退。 */
  navHistory: NavEntry[];
  /** 退回上一页。栈空时回落到 `fallback`（不给就什么都不做）。 */
  goBack: (fallback?: PageId) => void;

  /** 当前打开的课程（`teach-lesson` 页读它）。 */
  activeLessonId: string | null;
  openLesson: (id: string) => void;

  /**
   * 用什么设备打拍子（见 lib/conductMode.ts）。存 localStorage：这是个装好就不
   * 再动的选择，每次打开软件都要重挑一遍的话，等于没搬进「设置」。
   */
  conductMode: ConductMode;
  setConductMode: (mode: ConductMode) => void;

  /**
   * 对话式 Agent。
   *
   * 状态放 store 而不是组件里，是因为它有**两个入口**：右侧常驻侧栏，和课程页里
   * 内嵌的那一块。两处必须是同一段对话 —— 各存一份的话，用户会想不起来刚才那句
   * 是在哪儿问的，「清空」也会只清掉一半。
   */
  agentOpen: boolean;
  setAgentOpen: (open: boolean) => void;
  agentMessages: AgentMessage[];
  agentBusy: boolean;
  agentError: string;
  /** 返回是否成功。失败时调用方可以把问题原文放回输入框。 */
  askAgent: (question: string) => Promise<boolean>;
  clearAgent: () => void;
  /**
   * 语言模型配置改过几次。设置页保存成功后 +1。
   *
   * 助手面板是**常驻挂载**的（App.tsx 里和页面平级，展开收起走 CSS），
   * 它那句「还没配 key，问不了」只在挂载时查一次 —— 没有这个信号，
   * 用户配好 key 回来看到的仍然是「问不了」，而其实已经能用了。
   */
  llmConfigRev: number;
  bumpLlmConfig: () => void;

  project: Project | null;
  setProject: (project: Project | null) => void;
  refreshProject: () => Promise<void>;

  selectedInstrumentId: string | null;
  setSelectedInstrumentId: (id: string | null) => void;

  pendingInstruments: Set<string>;
  beginPending: (instrumentId: string) => void;
  endPending: (instrumentId: string) => void;

  instrumentLibrary: InstrumentLibrary | null;
  loadInstrumentLibrary: () => Promise<void>;

  health: HealthInfo | null;
  refreshHealth: () => Promise<void>;

  loraPath: string;
  setLoraPath: (path: string) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  // 第一眼看到的是首页而不是「文件」——「文件」假设了你已经知道这软件是干什么的。
  activePage: "home",
  // 首页是 global 页，不会改 navSection，所以这里的初值决定了侧栏二级默认展开哪一条。
  navSection: "perform",
  navHistory: [],
  goBack: (fallback) => {
    const s = get();
    const prev = s.navHistory[s.navHistory.length - 1];
    if (!prev) {
      if (fallback) s.setActivePage(fallback);
      return;
    }
    const section = PAGE_SECTION[prev.page];
    set({
      activePage: prev.page,
      activeLessonId: prev.lessonId,
      navHistory: s.navHistory.slice(0, -1),
      ...(section === "global" ? {} : { navSection: section }),
    });
  },

  setActivePage: (page) => {
    const s = get();
    if (s.activePage === page) return;
    const section = PAGE_SECTION[page];
    set({
      activePage: page,
      navHistory: pushNav(s.navHistory, { page: s.activePage, lessonId: s.activeLessonId }),
      ...(section === "global" ? {} : { navSection: section }),
    });
  },

  activeLessonId: null,
  openLesson: (id) =>
    set((s) => {
      // 和 setActivePage 同一个守卫：已经在这一课上就什么都不做。
      // 少了它，点侧栏里那条已经高亮的课会往历史栈里压一条**指向自己**的记录
      // （pushNav 只跟栈顶去重，不知道新条目和目的地是同一个），
      // 于是「返回」第一次原地不动，得按第二次才真的离开。
      if (s.activePage === "teach-lesson" && s.activeLessonId === id) return {};
      return {
        activeLessonId: id,
        activePage: "teach-lesson",
        navSection: "teach",
        navHistory: pushNav(s.navHistory, { page: s.activePage, lessonId: s.activeLessonId }),
      };
    }),

  conductMode: readConductMode(),
  setConductMode: (mode) => {
    try {
      localStorage.setItem(CONDUCT_MODE_KEY, mode);
    } catch {
      // 存不下就只在本次会话里生效，不值得为此报错
    }
    set({ conductMode: mode });
  },

  // 折叠状态是个长期偏好，记在 localStorage，别每次刷新都弹回来
  agentOpen: readAgentOpen(),
  setAgentOpen: (open) => {
    try {
      localStorage.setItem(AGENT_OPEN_KEY, open ? "1" : "0");
    } catch {
      // 隐私模式下 localStorage 会抛，折叠状态不值得为此中断
    }
    set({ agentOpen: open });
  },
  agentMessages: [],
  agentBusy: false,
  agentError: "",
  askAgent: async (question) => {
    const q = question.trim();
    const s = get();
    if (!q || s.agentBusy) return false;

    const next: AgentMessage[] = [...s.agentMessages, { role: "user", content: q }];
    // 这一轮提问的编号。回复回来时若已经不是当前这一轮（中途点了「清空」），
    // 就什么都别写 —— 下面两个分支都是**整体覆盖** agentMessages 的，
    // 不拦住的话被清掉的历史会原样复活，而用户根本不知道自己点的清空被撤销了。
    const epoch = agentEpoch;
    set({ agentMessages: next, agentBusy: true, agentError: "" });
    try {
      // 上下文在这里现算：用户可能问到一半切了页，要以**发问那一刻**的位置为准
      const ctx = buildAgentContext(s.activePage, s.project, s.activeLessonId);
      const { reply } = await api.agentChat(next, ctx);
      // 一个字段都不能碰：这时可能已经有新的一轮在飞，连 agentBusy 都是它的
      if (epoch !== agentEpoch) return false;
      set({ agentMessages: [...next, { role: "assistant", content: reply }], agentBusy: false });
      return true;
    } catch (e) {
      if (epoch !== agentEpoch) return false;
      // 失败就把这一轮整个撤回，别在对话里留一句没人回答的话
      set({
        agentMessages: s.agentMessages,
        agentBusy: false,
        agentError: agentErrorMessage(e),
      });
      return false;
    }
  },
  clearAgent: () => {
    // 作废在飞的那一轮，并且**自己把 agentBusy 落下来** —— 那一轮回来时会
    // 直接 return，不再有人负责关掉「正在想…」。
    agentEpoch++;
    set({ agentMessages: [], agentError: "", agentBusy: false });
  },
  llmConfigRev: 0,
  bumpLlmConfig: () => set((s) => ({ llmConfigRev: s.llmConfigRev + 1 })),

  project: null,
  setProject: (project) => {
    // 换项目时把上一个项目的音频从引擎里卸掉。只在 project_id 真的变了时做 ——
    // 同一个项目内每生成一条 take 都会走这里，那时声部表本来就该原样留着。
    // 不卸的代价见 `AudioEngine.keepOnly`：上一首的声部会跟着这一首一起响。
    if (get().project?.project_id !== project?.project_id) {
      sharedAudioEngine.stop();
      sharedAudioEngine.keepOnly(project?.instruments.map((i) => i.id) ?? []);
    }
    set({ project, selectedInstrumentId: project?.instruments[0]?.id ?? null });
  },
  refreshProject: async () => {
    const current = get().project;
    if (!current) return;
    const fresh = await api.getProject(current.project_id);
    set({ project: fresh });
  },

  selectedInstrumentId: null,
  setSelectedInstrumentId: (id) => set({ selectedInstrumentId: id }),

  pendingInstruments: new Set<string>(),
  beginPending: (id) =>
    set((s) => {
      const next = new Set(s.pendingInstruments);
      next.add(id);
      return { pendingInstruments: next };
    }),
  endPending: (id) =>
    set((s) => {
      const next = new Set(s.pendingInstruments);
      next.delete(id);
      return { pendingInstruments: next };
    }),

  instrumentLibrary: null,
  loadInstrumentLibrary: async () => {
    if (get().instrumentLibrary) return;
    const lib = await api.instrumentLibrary();
    set({ instrumentLibrary: lib });
  },

  health: null,
  refreshHealth: async () => {
    try {
      const health = await api.health();
      set({ health });
    } catch {
      set({ health: null });
    }
  },

  loraPath: "none",
  setLoraPath: (path) => set({ loraPath: path }),
}));

export function findInstrument(project: Project | null, instrumentId: string | null): Instrument | null {
  if (!project || !instrumentId) return null;
  return project.instruments.find((i) => i.id === instrumentId) ?? null;
}

export function currentTake(instrument: Instrument | null) {
  if (!instrument?.current_take_id) return null;
  return instrument.takes.find((t) => t.take_id === instrument.current_take_id) ?? null;
}
