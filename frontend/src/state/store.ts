import { create } from "zustand";
import { api, type HealthInfo, type Instrument, type InstrumentLibrary, type Project } from "../lib/api";

export type PageId = "file" | "formation" | "generate" | "browse" | "output" | "train" | "settings";

interface AppState {
  activePage: PageId;
  setActivePage: (page: PageId) => void;

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
  setActivePage: (page) => set({ activePage: page }),

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
