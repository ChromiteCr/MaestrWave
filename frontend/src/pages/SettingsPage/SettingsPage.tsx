import { useEffect, useState } from "react";
import { PageHeader } from "../../components/PageHeader/PageHeader";
import { Button } from "../../components/Button/Button";
import { api, type LokrOption, type LLMStatus, type ScoreStatus } from "../../lib/api";
import { useAppStore } from "../../state/store";
import styles from "./SettingsPage.module.css";

export function SettingsPage() {
  const health = useAppStore((s) => s.health);
  const refreshHealth = useAppStore((s) => s.refreshHealth);
  const loraPath = useAppStore((s) => s.loraPath);
  const setLoraPath = useAppStore((s) => s.setLoraPath);

  const [lokrOptions, setLokrOptions] = useState<LokrOption[]>([]);
  const caps = health?.capabilities;

  // 写谱演奏模式的音源与作曲器。选择存后端（双击启动包的用户改不了环境变量）。
  const [score, setScore] = useState<ScoreStatus | null>(null);
  const [scoreSaving, setScoreSaving] = useState(false);
  useEffect(() => {
    if (health?.score) setScore(health.score);
  }, [health?.score]);

  const [symbolicUrl, setSymbolicUrl] = useState("");
  const [scoreError, setScoreError] = useState<string | null>(null);
  useEffect(() => {
    if (health?.score) setSymbolicUrl(health.score.remote_url);
  }, [health?.score?.remote_url]);

  const saveScorePrefs = async (patch: { renderer?: string; composer?: string; symbolic_url?: string }) => {
    setScoreSaving(true);
    setScoreError(null);
    try {
      setScore(await api.setScorePrefs(patch));
      await refreshHealth();
    } catch (e) {
      // 地址不合法这类错误要显示在卡片里，不能用 alert —— 用户改的就是这个输入框
      setScoreError((e as Error).message);
    } finally {
      setScoreSaving(false);
    }
  };

  // BYOK 语言模型。key 只存后端，这里拿到的永远是掩码，没有明文。
  const [llm, setLlm] = useState<LLMStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [llmToken, setLlmToken] = useState(() => localStorage.getItem("mw_llm_token") || "");
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);

  useEffect(() => {
    refreshHealth();
    api.lokrOptions().then((r) => setLokrOptions(r.options));
    api.llmConfig().then((s) => {
      setLlm(s);
      setBaseUrl(s.base_url);
      setModel(s.model);
    }).catch(() => {});
  }, [refreshHealth]);

  const saveLlm = async () => {
    setLlmSaving(true);
    setLlmError(null);
    try {
      // api_key 传空字符串 = 保持原 key 不动，这样可以只改 base_url 不必重填
      const s = await api.saveLlmConfig({ base_url: baseUrl, model, api_key: apiKey });
      setLlm(s);
      setApiKey("");
      if (!s.host_allowed) setLlmError(s.host_reason);
    } catch (e) {
      setLlmError(e instanceof Error ? e.message : String(e));
    } finally {
      setLlmSaving(false);
    }
  };

  return (
    <div>
      <PageHeader eyebrow="MaestrWave" title="设置" />
      <div className={styles.body}>
        <div className={styles.card}>
          <p className={styles.cardTitle}>语言模型（构型页用）</p>
          <p className={styles.note}>
            自带 API key，用来把你的意图翻译成段落结构与乐器编配。只支持 <strong>OpenAI 兼容</strong>
            的端点（DeepSeek、智谱、Kimi、OpenRouter、Ollama、OpenAI 都可以，换 base_url 即用）。
            <br />
            key <strong>只存在后端</strong>、文件权限 600、不进仓库、任何接口都不会回显明文 ——
            这个项目的隧道功能会把服务暴露到公网，存在浏览器里等于直接泄露。
          </p>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>base_url</span>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.deepseek.com/v1" />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>模型名</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>
              API key {llm?.has_key && <span className={styles.masked}>已配置：{llm.key_masked}</span>}
            </span>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder={llm?.has_key ? "留空表示不修改" : "sk-…"} />
          </label>

          {llm?.tunnel_running && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>本机令牌（隧道运行中才需要）</span>
              <input value={llmToken}
                onChange={(e) => { setLlmToken(e.target.value); localStorage.setItem("mw_llm_token", e.target.value); }}
                placeholder="见后端启动日志" />
            </label>
          )}

          {llmError && <p className={styles.errorNote}>{llmError}</p>}

          <div className={styles.statRow}>
            <span className={styles.statLabel}>
              <span className={`${styles.dot} ${llm?.ready ? styles.dotOk : styles.dotErr}`} />
              {llm?.ready ? "已就绪" : "未配置完整"}
            </span>
            <Button onClick={saveLlm} disabled={llmSaving}>{llmSaving ? "保存中…" : "保存"}</Button>
          </div>
        </div>

        {score && (
          <div className={styles.card}>
            <p className={styles.cardTitle}>音源（写谱演奏模式）</p>
            <p className={styles.note}>
              谱子是同一份，换音源只换演奏它的乐器音色。
            </p>
            <div className={styles.rendererList}>
              {([
                { id: "auto", label: "自动", hint: "有音源就用内置采样，否则内置合成" },
                {
                  id: "sf2", label: "内置采样音源",
                  hint: score.soundfont_found
                    ? `真实录音采样，随项目自带。${score.soundfont_path.split("/").pop()}`
                    : "需要在 backend/soundfonts/ 放一个 .sf2",
                  disabled: !score.soundfont_found,
                },
                {
                  id: "fluidsynth", label: "FluidSynth",
                  hint: score.fluidsynth_found
                    ? "外部合成器，和内置采样同源，混响更丰富"
                    : "没检测到 fluidsynth 可执行文件",
                  disabled: !score.fluidsynth_found || !score.soundfont_found,
                },
                { id: "builtin", label: "内置合成", hint: "不用任何音源文件，音色朴素但到哪都能跑" },
              ] as const).map((r) => (
                <button
                  key={r.id}
                  type="button"
                  disabled={scoreSaving || ("disabled" in r && r.disabled)}
                  aria-pressed={score.renderer_configured === r.id}
                  className={`${styles.renderer} ${
                    score.renderer_configured === r.id ? styles.rendererActive : ""}`}
                  onClick={() => saveScorePrefs({ renderer: r.id })}
                >
                  <span className={styles.rendererLabel}>{r.label}</span>
                  <span className={styles.rendererHint}>{r.hint}</span>
                </button>
              ))}
            </div>
            <div className={styles.statRow}>
              <span className={styles.statLabel}>
                <span className={`${styles.dot} ${styles.dotOk}`} />
                实际生效
              </span>
              <span className={styles.statValue}>
                {score.renderer === "sf2" ? "内置采样音源"
                  : score.renderer === "fluidsynth" ? "FluidSynth" : "内置合成"}
              </span>
            </div>
          </div>
        )}

        {score && (
          <div className={styles.card}>
            <p className={styles.cardTitle}>作曲器（写谱演奏模式）</p>
            <p className={styles.note}>
              谁来写这份谱子。和弦走向与段落结构一律本地算，作曲器只负责填音符。
            </p>
            <div className={styles.rendererList}>
              {([
                { id: "auto", label: "自动", hint: "配了语言模型就用它，否则规则作曲" },
                {
                  id: "llm", label: "大模型写谱",
                  hint: score.llm_ready
                    ? "用你配的语言模型逐件乐器写，看得见其它声部写了什么"
                    : "需要先在上面配好语言模型",
                  disabled: !score.llm_ready,
                },
                {
                  id: "remote", label: "外部符号模型",
                  hint: score.remote_url
                    ? `POST 到 ${score.remote_url}/compose_part`
                    : "先在下面填服务地址",
                  disabled: !score.remote_url,
                },
                { id: "algorithmic", label: "规则作曲", hint: "不联网、不花额度，声部进行与音区分离都按规则来" },
              ] as const).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={scoreSaving || ("disabled" in c && c.disabled)}
                  aria-pressed={score.composer_configured === c.id}
                  className={`${styles.renderer} ${
                    score.composer_configured === c.id ? styles.rendererActive : ""}`}
                  onClick={() => saveScorePrefs({ composer: c.id })}
                >
                  <span className={styles.rendererLabel}>{c.label}</span>
                  <span className={styles.rendererHint}>{c.hint}</span>
                </button>
              ))}
            </div>

            <div className={styles.field} style={{ marginTop: 14 }}>
              <span className={styles.fieldLabel}>符号模型服务地址</span>
              <div className={styles.urlRow}>
                <input
                  value={symbolicUrl}
                  onChange={(e) => setSymbolicUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8002"
                  spellCheck={false}
                />
                <Button
                  disabled={scoreSaving}
                  onClick={() => saveScorePrefs({ symbolic_url: symbolicUrl.trim() })}
                >
                  {scoreSaving ? "保存中…" : "保存"}
                </Button>
              </div>
              <p className={styles.note}>
                只接受本机或局域网地址。接口契约见 docs/SYMBOLIC_COMPOSER_API.md ——
                任何符号音乐模型自己包一层薄服务就能接进来，后端不用改。
              </p>
            </div>

            {scoreError && <p className={styles.errorNote}>{scoreError}</p>}

            <div className={styles.statRow}>
              <span className={styles.statLabel}>
                <span className={`${styles.dot} ${styles.dotOk}`} />
                实际生效
              </span>
              <span className={styles.statValue}>
                {score.composer === "llm" ? "大模型写谱"
                  : score.composer === "remote" ? "外部符号模型" : "规则作曲"}
              </span>
            </div>
          </div>
        )}

        <div className={styles.card}>
          <p className={styles.cardTitle}>状态</p>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>
              <span className={`${styles.dot} ${health?.generation_backend_ready ? styles.dotOk : styles.dotErr}`} />
              生成后端
            </span>
            <span className={styles.statValue}>{caps?.display_name ?? health?.generation_backend ?? "—"}</span>
          </div>
          {health?.generation_backend !== "tme" && (
            <div className={styles.statRow}>
              <span className={styles.statLabel}>
                <span className={`${styles.dot} ${health?.acestep_reachable ? styles.dotOk : styles.dotErr}`} />
                ACE-Step
              </span>
              <span className={styles.statValue}>{health?.acestep_api_url ?? "—"}</span>
            </div>
          )}
          <div className={styles.statRow}>
            <span className={styles.statLabel}>兜底合成</span>
            <span className={styles.statValue}>{health?.synth_fallback_enabled ? "已启用" : "已关闭"}</span>
          </div>
          <Button variant="ghost" onClick={refreshHealth}>
            刷新
          </Button>
        </div>

        {caps && (
          <div className={styles.card}>
            <p className={styles.cardTitle}>当前后端能力</p>
            <div className={styles.statRow}>
              <span className={styles.statLabel}>文生乐（生成）</span>
              <span className={styles.statValue}>{caps.text2music ? "支持" : "不支持"}</span>
            </div>
            <div className={styles.statRow}>
              <span className={styles.statLabel}>音频层面协同（lego）</span>
              <span className={styles.statValue}>{caps.lego ? "支持" : "降级为文字对齐"}</span>
            </div>
            <div className={styles.statRow}>
              <span className={styles.statLabel}>局部重绘（Repaint）</span>
              <span className={styles.statValue}>{caps.repaint ? "支持" : "不支持"}</span>
            </div>
            <p className={styles.capNote}>{caps.note}</p>
            {!health?.generation_backend_ready && health?.generation_backend === "tme" && (
              <p className={styles.capWarn}>
                天琴密钥未配置。设置环境变量 TME_APP_ID / TME_APP_KEY 后重启后端，见 README「用云端 API 生成」。
              </p>
            )}
          </div>
        )}

        <div className={styles.card}>
          <p className={styles.cardTitle}>LoKr / LoRA</p>
          {caps && !caps.lora && (
            <p className={styles.capNote}>当前后端不支持自定义权重，这里的选择不会生效。</p>
          )}
          <div className={styles.field}>
            <span className="field-label">生成时使用的权重</span>
            <select value={loraPath} disabled={caps ? !caps.lora : false} onChange={(e) => setLoraPath(e.target.value)}>
              <option value="none">无（原始模型）</option>
              {lokrOptions
                .filter((o) => o.id !== "none")
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                    {o.size_mb ? ` (${o.size_mb}MB)` : ""}
                  </option>
                ))}
            </select>
          </div>
        </div>

        <div className={styles.card}>
          <p className={styles.cardTitle}>维护</p>
          <Button variant="ghost" disabled title="需要先确认本机 acestep-api 的进程管理方式，见 README 里的 Open Items">
            重启 ACE-Step 服务
          </Button>
        </div>
      </div>
    </div>
  );
}
