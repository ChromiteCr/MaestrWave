import { create } from "zustand";
import { api, type HealthInfo, type Instrument, type InstrumentLibrary, type Project } from "../lib/api";

export type PageId =
  | "teach"
  | "teach-lesson"
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
  teach: "teach",
  "teach-lesson": "teach",
  file: "perform",
  formation: "perform",
  generate: "perform",
  browse: "perform",
  output: "perform",
  train: "global",
  settings: "global",
};

/** 点一级导航时落到哪一页。 */
export const SECTION_HOME: Record<Exclude<Section, "global">, PageId> = {
  teach: "teach",
  perform: "file",
};

interface AppState {
  activePage: PageId;
  setActivePage: (page: PageId) => void;
  /**
   * 侧栏当前展开的一级。跳到训练/设置这种 global 页时**保持不变** —— 从「输出」点
   * 「设置」再看侧栏，二级列表还应该是指挥体验那五项，否则回不去。
   */
  navSection: Exclude<Section, "global">;

  /** 当前打开的课程（`teach-lesson` 页读它）。 */
  activeLessonId: string | null;
  openLesson: (id: string) => void;

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
  activePage: "file",
  navSection: "perform",
  setActivePage: (page) => {
    const section = PAGE_SECTION[page];
    set(section === "global" ? { activePage: page } : { activePage: page, navSection: section });
  },

  activeLessonId: null,
  openLesson: (id) => set({ activeLessonId: id, activePage: "teach-lesson", navSection: "teach" }),

  project: null,
  setProject: (project) => set({ project, selectedInstrumentId: project?.instruments[0]?.id ?? null }),
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
