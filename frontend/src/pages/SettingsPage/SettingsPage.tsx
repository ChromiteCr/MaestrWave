import { useEffect, useState } from "react";
import { PageHeader } from "../../components/PageHeader/PageHeader";
import { Button } from "../../components/Button/Button";
import { api, type LokrOption, type LLMStatus } from "../../lib/api";
import { useAppStore } from "../../state/store";
import styles from "./SettingsPage.module.css";

export function SettingsPage() {
  const health = useAppStore((s) => s.health);
  const refreshHealth = useAppStore((s) => s.refreshHealth);
  const loraPath = useAppStore((s) => s.loraPath);
  const setLoraPath = useAppStore((s) => s.setLoraPath);

  const [lokrOptions, setLokrOptions] = useState<LokrOption[]>([]);
  const caps = health?.capabilities;

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
