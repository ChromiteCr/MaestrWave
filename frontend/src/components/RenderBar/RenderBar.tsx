import type { RenderProgress } from "../../lib/api";
import styles from "./RenderBar.module.css";

/**
 * 渲染进度条。
 *
 * 真实曲目要逐声部渲十几条音轨，几十秒起步。只写一句「渲染中…」的话，用户分不出
 * 「在动」和「卡死了」—— 这是唯一的理由，不是装饰。所以它必须**说出正在渲哪个
 * 声部**：一个只会走的条和一句会变的话，后者才证明后端还活着。
 *
 * 后端没回报进度时（旧后端、刚发起还没渲到第一步）退回一条来回扫的不定长条 ——
 * 假装知道进度比承认不知道更糟。
 */
export function RenderBar({ progress, hint }: { progress: RenderProgress | null; hint?: string }) {
  const pct = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : null;

  return (
    <div className={styles.wrap}>
      <div className={`${styles.track} ${pct === null ? styles.indeterminate : ""}`}>
        <div
          className={styles.fill}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      <div className={styles.line}>
        <span className={styles.label}>{progress?.label ?? hint ?? "渲染中…"}</span>
        {pct !== null && (
          <span className="mono-chip">
            {progress!.done}/{progress!.total}
          </span>
        )}
      </div>
    </div>
  );
}
