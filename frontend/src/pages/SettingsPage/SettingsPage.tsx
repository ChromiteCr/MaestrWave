import { useEffect, useState } from "react";
import { PageHeader } from "../../components/PageHeader/PageHeader";
import { Button } from "../../components/Button/Button";
import { api, type LokrOption } from "../../lib/api";
import { useAppStore } from "../../state/store";
import styles from "./SettingsPage.module.css";

export function SettingsPage() {
  const health = useAppStore((s) => s.health);
  const refreshHealth = useAppStore((s) => s.refreshHealth);
  const loraPath = useAppStore((s) => s.loraPath);
  const setLoraPath = useAppStore((s) => s.setLoraPath);

  const [lokrOptions, setLokrOptions] = useState<LokrOption[]>([]);
  const caps = health?.capabilities;

  useEffect(() => {
    refreshHealth();
    api.lokrOptions().then((r) => setLokrOptions(r.options));
  }, [refreshHealth]);

  return (
    <div>
      <PageHeader eyebrow="MaestrWave" title="设置" />
      <div className={styles.body}>
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
