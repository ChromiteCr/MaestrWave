/** 对接 backend/app.py 里 M1 新增的 project API（见 backend/project.py / project_gen.py）。 */

export interface InstrumentSpec {
  display_name: string;
  role: "melody" | "harmony" | "bass" | "rhythm";
  prompt: string;
  family?: string;
}

export interface InstrumentLibrary {
  default_instruments: string[];
  library: Record<string, InstrumentSpec>;
}

export interface Take {
  take_id: string;
  created_at: string;
  audio_file: string;
  task_type_used: "text2music" | "lego" | "repaint";
  params: Record<string, unknown>;
  url: string;
}

export interface Instrument {
  id: string;
  library_key: string;
  display_name: string;
  family: string;
  role: "melody" | "harmony" | "bass" | "rhythm";
  takes: Take[];
  current_take_id: string | null;
}

export interface Project {
  project_id: string;
  name: string;
  created_at: string;
  style_description: string;
  key: string;
  bpm: number;
  time_signature: string;
  segment_duration: number;
  instruments: Instrument[];
}

export interface HealthInfo {
  backend: string;
  acestep_api_url: string;
  acestep_reachable: boolean;
  synth_fallback_enabled: boolean;
  generation_backend: string;
}

/** 见 backend/netinfo.py：浏览器拿不到本机局域网 IP，只能问后端。 */
export interface NetworkInfo {
  hostname: string;
  lan_ips: string[];
  conduct_rooms: Record<string, { stage: boolean; remotes: number }>;
}

/** 见 backend/tunnel.py：后端代管的 cloudflared 进程状态。 */
export interface TunnelStatus {
  available: boolean;
  running: boolean;
  url: string | null;
  port: number | null;
  error: string | null;
  log_tail: string[];
}

export interface LokrOption {
  id: string;
  name: string;
  path: string;
  size_mb?: number;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `${resp.status} ${resp.statusText}`);
  }
  return resp.json() as Promise<T>;
}

export const api = {
  health: () => req<HealthInfo>("/api/health"),
  networkInfo: () => req<NetworkInfo>("/api/network-info"),

  tunnelStatus: () => req<TunnelStatus>("/api/tunnel"),
  tunnelStart: (port: number) =>
    req<TunnelStatus>("/api/tunnel/start", { method: "POST", body: JSON.stringify({ port }) }),
  tunnelStop: () => req<TunnelStatus>("/api/tunnel/stop", { method: "POST" }),

  instrumentLibrary: () => req<InstrumentLibrary>("/api/instrument-library"),
  lokrOptions: () => req<{ options: LokrOption[]; weights_dir: string }>("/api/lokr"),

  createProject: (body: {
    style_description: string;
    key: string;
    bpm: number;
    time_signature: string;
    segment_duration: number;
    name?: string;
  }) => req<Project>("/api/projects", { method: "POST", body: JSON.stringify(body) }),

  listProjects: () => req<{ projects: Project[] }>("/api/projects"),

  getProject: (projectId: string) => req<Project>(`/api/projects/${projectId}`),

  updateProject: (
    projectId: string,
    body: Partial<Pick<Project, "style_description" | "key" | "bpm" | "time_signature" | "segment_duration" | "name">>,
  ) => req<Project>(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify(body) }),

  exportProjectUrl: (projectId: string) => `/api/projects/${projectId}/export`,

  addInstrument: (projectId: string, body: { library_key: string; display_name?: string }) =>
    req<Instrument>(`/api/projects/${projectId}/instruments`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  removeInstrument: (projectId: string, instrumentId: string) =>
    req<{ ok: boolean }>(`/api/projects/${projectId}/instruments/${instrumentId}`, { method: "DELETE" }),

  generateInstrument: (projectId: string, instrumentId: string, loraPath?: string) =>
    req<Take>(`/api/projects/${projectId}/instruments/${instrumentId}/generate`, {
      method: "POST",
      body: JSON.stringify({ lora_path: loraPath || null }),
    }),

  repaintInstrument: (
    projectId: string,
    instrumentId: string,
    body: { prompt: string; start_time: number; end_time: number; lora_path?: string },
  ) =>
    req<Take>(`/api/projects/${projectId}/instruments/${instrumentId}/repaint`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
