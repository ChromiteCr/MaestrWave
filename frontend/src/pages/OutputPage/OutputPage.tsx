import { PageHeader } from "../../components/PageHeader/PageHeader";
import { useConductor } from "../../lib/useConductor";
import type { InstrumentRole } from "../../lib/gesture";
import { useAppStore } from "../../state/store";
import styles from "./OutputPage.module.css";

const ROLE_LABELS: Record<InstrumentRole, string> = {
  melody: "主旋律",
  harmony: "和声",
  bass: "低音",
  rhythm: "节奏",
};

const STATUS_LABEL: Record<string, string> = {
  idle: "未连接",
  requesting: "请求权限…",
  waiting: "等待手势…",
  active: "指挥中",
  error: "权限被拒绝",
};

export function OutputPage() {
  const project = useAppStore((s) => s.project);
  const { status, roleActivation, dynamics, start, stop, sensorAvailable } = useConductor();

  const readyCount = project?.instruments.filter((i) => i.current_take_id).length ?? 0;

  return (
    <div>
      <PageHeader eyebrow={project?.name || "MaestrWave"} title="输出" meta={<span className="mono-chip">{readyCount} 件乐器就绪</span>} />

      {!project ? (
        <div className={styles.emptyState}>先在「文件」页打开一个项目。</div>
      ) : (
        <div className={styles.body}>
          <span className={`${styles.statusBadge} ${status === "active" ? styles.statusActive : ""} ${status === "error" ? styles.statusError : ""}`}>
            {STATUS_LABEL[status]}
          </span>

          <button
            className={`${styles.startBtn} ${status !== "idle" && status !== "error" ? styles.startBtnActive : ""}`}
            disabled={readyCount === 0}
            onClick={() => (status === "idle" || status === "error" ? start(project) : stop())}
          >
            {status === "idle" || status === "error" ? "开始指挥" : "停止"}
          </button>

          <div className={styles.meters}>
            {(Object.keys(ROLE_LABELS) as InstrumentRole[]).map((role) => (
              <div className={styles.meter} key={role}>
                <div className={styles.meterTrack}>
                  <div className={styles.meterFill} style={{ height: `${Math.round((roleActivation[role] * dynamics) * 100)}%` }} />
                </div>
                <span className={styles.meterLabel}>{ROLE_LABELS[role]}</span>
              </div>
            ))}
          </div>

          {!sensorAvailable && <span className="label">当前设备没有传感器，用手机打开本页面可获得完整指挥体验。</span>}
          <span className={styles.originChip}>{typeof window !== "undefined" ? window.location.origin : ""}</span>
        </div>
      )}
    </div>
  );
}
