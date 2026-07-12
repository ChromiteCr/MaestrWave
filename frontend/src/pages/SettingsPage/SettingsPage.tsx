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
              <span className={`${styles.dot} ${health?.acestep_reachable ? styles.dotOk : styles.dotErr}`} />
              ACE-Step
            </span>
            <span className={styles.statValue}>{health?.acestep_api_url ?? "—"}</span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>生成后端</span>
            <span className={styles.statValue}>{health?.generation_backend ?? "—"}</span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>兜底合成</span>
            <span className={styles.statValue}>{health?.synth_fallback_enabled ? "已启用" : "已关闭"}</span>
          </div>
          <Button variant="ghost" onClick={refreshHealth}>
            刷新
          </Button>
        </div>

        <div className={styles.card}>
          <p className={styles.cardTitle}>LoKr / LoRA</p>
          <div className={styles.field}>
            <span className="field-label">生成时使用的权重</span>
            <select value={loraPath} onChange={(e) => setLoraPath(e.target.value)}>
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
