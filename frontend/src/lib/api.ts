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
  task_type_used: "text2music" | "lego" | "repaint" | "score";
  params: Record<string, unknown>;
  url: string;
}

export type InstrumentRole = "melody" | "harmony" | "bass" | "rhythm";

// ---------------- 构型（「构型」页产出，挂在 project.formation）----------------

export type SectionKind =
  | "intro" | "build" | "main" | "bridge" | "climax" | "breakdown" | "outro";

/** 段内情绪走向。柱状图在段内按这个形状插值，不画成一条水平线。 */
export type SectionShape = "flat" | "rise" | "fall" | "arch" | "dip";

export interface FormationSection {
  id: string;
  kind: SectionKind;
  /** 中文显示名，如「铜管齐奏」 */
  label: string;
  /**
   * 这一段的时长（秒）。存 duration 而非 start/end —— 「无缝、无重叠、并集恰好
   * 等于全曲时长」这条不变式由结构本身保证，不需要校验器去追。start 由前缀和算。
   */
  duration: number;
  /** 0..1，情绪强度平台值。柱状图的高度由它算出来。 */
  intensity: number;
  shape: SectionShape;
  /** 高潮起止时间 = is_climax 段的并集，不做独立字段（两份数据必然会漂移）。 */
  is_climax: boolean;
  /** 段落级英文描述，进 prompt 的 structure hint */
  prompt_hint?: string;
}

export interface FormationInstrument {
  id: string;
  library_key: string;
  display_name: string;
  role: InstrumentRole;
  family?: string;
  /** core 贯穿主干 / climax 只在高潮加入 / accent 点缀 */
  tier: "core" | "climax" | "accent";
  /** 0..1，编配里的重要度，决定生成顺序与默认基准音量 */
  prominence: number;
  /** 在每个段落的参与权重，长度必须等于 sections.length */
  participation: number[];
  /** 英文，这件乐器的专属描述 */
  instrument_prompt: string;
  /** 名字是怎么映射进乐器库的，用于 UI 标注「自定义」角标 */
  resolution?: {
    matched: "exact" | "alias" | "family_fallback" | "custom";
    llm_raw_name: string;
  };
}

export interface FormationWarning {
  code: string;
  /** 中文，直接展示给用户 */
  message: string;
}

export interface FormationTemplate {
  id: string;
  name: string;
  description: string;
  key: string;
  bpm: number;
  time_signature: string;
  instrument_count: number;
  has_climax: boolean;
}

/** 用户填的骨架。语言模型在模版基线上按它调整，而不是从零构建。 */
export interface FormationSkeleton {
  style_description?: string;
  mood_tags?: string[];
  ensemble_size?: string;
  climax_hint?: string;
  template_id?: string;
}

/** 「设置」页看到的 BYOK 状态。**永远不含明文 key。** */
// ---------------- 对话式 Agent ----------------

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * 随每次提问带上的上下文。**服务端不另存一份指挥知识库** ——
 * 课程数据是 TS 写的（lib/teaching/curriculum.ts），后端再抄一份 Python 版必然漂移，
 * 结果就是「Agent 教的和课程教的不一样」。所以由前端把摘要传上去。
 */
export interface AgentContext {
  /** 课程摘要：每课的标题、目标、标准依据。 */
  curriculum?: unknown;
  /** 用户此刻在哪一页、项目是什么样子。 */
  state?: unknown;
}

export interface LLMStatus {
  has_key: boolean;
  key_masked: string;
  base_url: string;
  model: string;
  host_allowed: boolean;
  host_reason: string;
  ready: boolean;
  allowed_hosts: string[];
  tunnel_running?: boolean;
}

export interface MusicFormation {
  schema_version: 1;
  /** 每次「应用到生成页」+1。take.params 记录当时的 revision，
   *  用来标出「这条音轨是按旧构型生成的」。 */
  revision: number;
  created_by: "template" | "llm" | "manual";
  source_template_id?: string;
  updated_at: string;
  /** 用户手动改过 LLM 的输出之后置 true，之后不再声称「这是 AI 编的」 */
  dirty: boolean;

  global: {
    total_duration: number;
    key: string;
    time_signature: string;
    bpm: number;
    /** 中文，给人看的一句话（进 UI，不直接进模型） */
    style_description: string;
    /** 英文，替换 project.style_description 作为乐器 prompt 模板的 {style} 填充值。
     *  这是「全程使用构型的全局提示词」的落地点。 */
    global_prompt: string;
    mood_tags: string[];
    ensemble_size: "solo" | "chamber" | "orchestral" | "cinematic";
    dynamic_range: "narrow" | "medium" | "wide";
    reference_note?: string;
  };
  sections: FormationSection[];
  instruments: FormationInstrument[];
  warnings: FormationWarning[];
}

/** 生成模式。multitrack=每乐器一条轨；separate=云端整曲再分轨；
 *  score=AI 写谱再用采样器渲染（M7）。见 backend/project.py */
export type GenerationMode = "multitrack" | "separate" | "score";

/** 见 backend/render.py 与 backend/composer.py：符号乐谱模式当前用哪套流水线。 */
export interface ScoreStatus {
  renderer: "sf2" | "fluidsynth" | "builtin";
  renderer_configured: string;
  fluidsynth_found: boolean;
  soundfont_found: boolean;
  soundfont_path: string;
  soundfont_dir: string;
  sample_rate: number;
  composer: "llm" | "remote" | "algorithmic";
  composer_configured: string;
  llm_ready: boolean;
  remote_url: string;
}

/**
 * 一个音符：`[小节, 拍, 时值(拍), MIDI 音高, 力度]`。见 backend/score.py。
 *
 * 定长数组而不是对象 —— 一首 32 小节 8 声部的曲子上千个音符，写成
 * `{"bar":1,"beat":1,…}` 光键名就吃掉几千 token。小节与拍都从 1 起，拍可以是小数。
 */
export type ScoreNote = [number, number, number, number, number];

export interface ScoreSection {
  id: string;
  label: string;
  start_bar: number;
  end_bar: number;
  intensity: number;
}

/** 全曲一份，存 project.score_blueprint。改 bpm/调/拍号/时长会让它的 revision +1。 */
export interface ScoreBlueprint {
  schema_version: number;
  revision: number;
  bpm: number;
  key: string;
  time_signature: string;
  bars: number;
  beats_per_bar: number;
  exact_duration: number;
  sections: ScoreSection[];
  /** 每小节一个和弦，长度等于 bars。 */
  chords: string[];
}

/** 每件乐器一份谱子。存在 PROJECTS_DIR/{pid}/scores/{take_id}.json。 */
export interface ScorePart {
  instrument_id: string;
  library_key: string;
  gm_program: number;
  channel: number;
  blueprint_revision: number;
  notes: ScoreNote[];
  take_id?: string;
  warnings?: FormationWarning[];
}

export interface ProjectScore {
  /** 还没生成过任何乐器时是 null —— 蓝图是第一次生成时才立的。 */
  blueprint: ScoreBlueprint | null;
  parts: ScorePart[];
}

export interface Instrument {
  id: string;
  library_key: string;
  display_name: string;
  family: string;
  role: InstrumentRole;
  takes: Take[];
  current_take_id: string | null;
  /** 每个段落的参与权重，长度=formation.sections.length。
   *  空数组 = 全程满参与（不是全程静音）。M4d 起由后端迁移补齐。 */
  participation?: number[];
  /** 用户在「生成」页写的针对这件乐器的补充描述 */
  prompt_extra?: string;
  tier?: "core" | "climax" | "accent";
  bound_stem_id?: string | null;
  origin?: "planned" | "stem";
}

export interface Project {
  project_id: string;
  name: string;
  created_at: string;
  style_description: string;
  key: string;
  bpm: number;
  time_signature: string;
  /** @deprecated M4d 起用 total_duration。这里保留为后端同步写入的影子副本，
   *  老项目与老代码路径仍在读它。取值请用 lib/duration.ts 的 totalDuration()。 */
  segment_duration: number;
  instruments: Instrument[];

  // ---- M4d 新增（老项目由后端 migrate_project 补齐，前端一律按可选处理）----
  schema_version?: number;
  total_duration?: number;
  generation_mode?: GenerationMode;
  formation?: MusicFormation | null;
  generation_order?: string[];
  master?: { audio_file: string; duration: number; provider: string; url?: string } | null;
  stems?: Array<{ stem_id: string; label_raw: string; audio_file: string; duration: number }>;
}

/** 见 backend/generation_backend.py 的 backend_capabilities()：
 *  不同生成后端能力不同（天琴没有 lego / repaint），前端据此禁用相应按钮。 */
export interface BackendCapabilities {
  name: string;
  display_name: string;
  text2music: boolean;
  lego: boolean;
  repaint: boolean;
  lora: boolean;
  note: string;
}

export interface HealthInfo {
  backend: string;
  acestep_api_url: string;
  acestep_reachable: boolean;
  synth_fallback_enabled: boolean;
  generation_backend: string;
  generation_backend_ready: boolean;
  capabilities: BackendCapabilities;
  /** M7 起才有；老后端返回的 health 里没有这一项，一律按可选处理。 */
  score?: ScoreStatus;
}

/** 见 backend/netinfo.py：浏览器拿不到本机局域网 IP，只能问后端。 */
export interface NetworkInfo {
  hostname: string;
  lan_ips: string[];
  /** 开发证书状态，用于「输出」页自检 HTTPS 是否真的能用。 */
  cert: { exists: boolean; covers: string[]; path: string };
  /** 仓库根目录绝对路径，用来拼出在任何目录下都能跑的命令。 */
  repo_root: string;
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

/** 带状态码的请求错误，调用方可以据此区分「接口不存在」和「接口报错」。 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly path: string) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 从错误响应体里抠出**给人看的**那句话。
 *
 * FastAPI 的 HTTPException 一律回 `{"detail": "..."}`，原样抛出去的话用户
 * 看到的就是 `{"detail":"Not Found"}` 这种东西 —— 既不知道发生了什么，
 * 也不知道该干什么。
 */
function errorMessage(body: string, resp: Response): string {
  const text = body.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      const detail = parsed?.detail ?? parsed?.message ?? parsed?.error;
      if (typeof detail === "string" && detail.trim()) return detail.trim();
      // 422 的 detail 是数组（Pydantic 校验错误），拼成一行
      if (Array.isArray(detail)) {
        const parts = detail
          .map((d) => (typeof d?.msg === "string" ? d.msg : null))
          .filter(Boolean);
        if (parts.length) return parts.join("；");
      }
    } catch {
      // 不是合法 JSON 就按纯文本处理
    }
  }
  return text || `${resp.status} ${resp.statusText}`;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new ApiError(errorMessage(text, resp), resp.status, path);
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
    /** 不传时后端默认 multitrack。见 backend/project.py 的 PROJECT_DEFAULTS。 */
    generation_mode?: GenerationMode;
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

  // ---- BYOK 语言模型 ----
  llmConfig: () => req<LLMStatus>("/api/llm/config"),
  saveLlmConfig: (body: { base_url?: string; model?: string; api_key?: string }) =>
    req<LLMStatus>("/api/llm/config", { method: "POST", body: JSON.stringify(body) }),

  // ---- 写谱演奏模式：音源与作曲器 ----
  /** 选择在设置页做，落到后端的偏好文件；env 只作为默认值。 */
  setScorePrefs: (body: { renderer?: string; composer?: string; symbolic_url?: string }) =>
    req<ScoreStatus>("/api/score/prefs", { method: "POST", body: JSON.stringify(body) }),

  /** 蓝图 + 各声部音符，喂「生成」页的钢琴卷帘。非 score 项目会返回 blueprint: null。 */
  projectScore: (projectId: string) => req<ProjectScore>(`/api/projects/${projectId}/score`),

  /** 全部声部合成一个 MIDI 文件，各声部一个 track。丢进 MuseScore / DAW 里能直接开。 */
  scoreMidiUrl: (projectId: string) => `/api/projects/${projectId}/score.mid`,

  // ---- 对话式 Agent ----
  /** 和构型页共用同一条 BYOK 通路，所以同样要带隧道令牌。 */
  agentChat: (messages: AgentMessage[], context: AgentContext, token?: string) =>
    req<{ reply: string }>("/api/agent/chat", {
      method: "POST",
      body: JSON.stringify({ messages, context }),
      headers: token ? { "X-MW-Token": token } : undefined,
    }),

  // ---- 构型 ----
  formationTemplates: () =>
    req<{ templates: FormationTemplate[] }>("/api/formation/templates"),
  applyFormationTemplate: (projectId: string, templateId: string) =>
    req<MusicFormation>(
      `/api/projects/${projectId}/formation/template?template_id=${encodeURIComponent(templateId)}`,
      { method: "POST" },
    ),
  generateFormation: (projectId: string, skeleton: FormationSkeleton, token?: string) =>
    req<MusicFormation>(`/api/projects/${projectId}/formation/generate`, {
      method: "POST",
      body: JSON.stringify(skeleton),
      headers: token ? { "X-MW-Token": token } : undefined,
    }),
  refineFormation: (projectId: string, instruction: string, scope?: string, token?: string) =>
    req<MusicFormation>(`/api/projects/${projectId}/formation/refine`, {
      method: "POST",
      body: JSON.stringify({ instruction, scope }),
      headers: token ? { "X-MW-Token": token } : undefined,
    }),
  saveFormation: (projectId: string, formation: MusicFormation) =>
    req<MusicFormation>(`/api/projects/${projectId}/formation`, {
      method: "PUT",
      body: JSON.stringify(formation),
    }),
  applyFormation: (projectId: string) =>
    req<{ project: Project; created: number; unmatched: Array<{ id: string; display_name: string }> }>(
      `/api/projects/${projectId}/formation/apply`,
      { method: "POST" },
    ),

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
