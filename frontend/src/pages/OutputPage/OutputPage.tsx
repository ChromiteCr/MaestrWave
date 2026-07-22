import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../../components/PageHeader/PageHeader";
import { QrCode } from "../../components/QrCode/QrCode";
import { useConductor } from "../../lib/useConductor";
import { ConductLink, newRoomCode, type LinkStatus } from "../../lib/conductLink";
import { LocalSensorSource, RemoteSensorSource, type SensorSource } from "../../lib/sensorSource";
import type { InstrumentRole } from "../../lib/gesture";
import { api, type NetworkInfo } from "../../lib/api";
import { useAppStore } from "../../state/store";
import styles from "./OutputPage.module.css";

const ROLE_LABELS: Record<InstrumentRole, string> = {
  melody: "主旋律",
  harmony: "和声",
  bass: "低音",
  rhythm: "节奏",
};

const STATUS_LABEL: Record<string, string> = {
  idle: "未开始",
  requesting: "请求权限…",
  waiting: "等待手势…",
  active: "指挥中",
  nodata: "无传感器数据",
  error: "权限被拒绝",
};

/** 单机 = 手机自己采自己放；电脑 = 手机采、这台电脑放。 */
type ConductMode = "solo" | "stage";

export function OutputPage() {
  const project = useAppStore((s) => s.project);
  const { status, roleActivation, dynamics, start, stop } = useConductor();

  const [mode, setMode] = useState<ConductMode>("solo");
  const [roomId] = useState(() => newRoomCode());
  const [linkStatus, setLinkStatus] = useState<LinkStatus>("idle");
  const [remoteCount, setRemoteCount] = useState(0);
  const [netInfo, setNetInfo] = useState<NetworkInfo | null>(null);
  const [selectedIp, setSelectedIp] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const linkRef = useRef<ConductLink | null>(null);
  const running = status !== "idle" && status !== "error";

  const readyCount = project?.instruments.filter((i) => i.current_take_id).length ?? 0;
  const soloSensorAvailable = LocalSensorSource.isAvailable();

  useEffect(() => {
    api.networkInfo()
      .then((info) => {
        setNetInfo(info);
        setSelectedIp((prev) => prev || info.lan_ips[0] || "");
      })
      .catch(() => setNetInfo(null));
  }, []);

  // 电脑模式下，这台电脑作为舞台端常驻连着房间，手机随时可以扫码接入。
  useEffect(() => {
    if (mode !== "stage") return;
    const link = new ConductLink(roomId, "stage");
    linkRef.current = link;
    link.onStatus(setLinkStatus);
    link.onMessage((msg) => {
      if (msg.t === "joined") setRemoteCount(Number(msg.remotes ?? 0));
      else if (msg.t === "remote_joined") setRemoteCount((c) => c + 1);
      else if (msg.t === "remote_left") setRemoteCount((c) => Math.max(0, c - 1));
    });
    link.connect();
    return () => {
      link.close();
      linkRef.current = null;
      setLinkStatus("idle");
      setRemoteCount(0);
    };
  }, [mode, roomId]);

  const phoneUrl = useMemo(() => {
    if (!selectedIp) return "";
    const port = window.location.port ? `:${window.location.port}` : "";
    return `${window.location.protocol}//${selectedIp}${port}/?conduct=${roomId}`;
  }, [selectedIp, roomId]);

  // iOS 只在安全上下文里给运动传感器权限，局域网 IP 走 http 时手机会连权限框都不弹。
  const insecureWarning = window.location.protocol !== "https:" && !!selectedIp;

  const handleToggle = async () => {
    if (running) {
      stop();
      return;
    }
    if (!project) return;
    setError(null);
    let source: SensorSource;
    if (mode === "stage") {
      const link = linkRef.current;
      if (!link) return;
      source = new RemoteSensorSource(link);
    } else {
      source = new LocalSensorSource();
    }
    try {
      await start(project, source);
    } catch (e) {
      setError((e as Error).message || "启动失败");
    }
  };

  const switchMode = (next: ConductMode) => {
    if (next === mode) return;
    if (running) stop();
    setError(null);
    setMode(next);
  };

  return (
    <div>
      <PageHeader
        eyebrow={project?.name || "MaestrWave"}
        title="输出"
        meta={<span className="mono-chip">{readyCount} 件乐器就绪</span>}
      />

      {!project ? (
        <div className={styles.emptyState}>先在「文件」页打开一个项目。</div>
      ) : (
        <div className={styles.body}>
          <div className={styles.modeToggle}>
            <button
              type="button"
              className={`${styles.modeBtn} ${mode === "solo" ? styles.modeActive : ""}`}
              onClick={() => switchMode("solo")}
            >
              单机模式
            </button>
            <button
              type="button"
              className={`${styles.modeBtn} ${mode === "stage" ? styles.modeActive : ""}`}
              onClick={() => switchMode("stage")}
            >
              电脑模式
            </button>
          </div>
          <p className={styles.modeHint}>
            {mode === "solo"
              ? "用手机打开本页面，手机自己采集手势并出声。零延迟、不依赖网络。"
              : "手机扫码当指挥棒，声音从这台电脑放出。需要手机和电脑在同一局域网。"}
          </p>

          {mode === "stage" && (
            <div className={styles.pairCard}>
              <div className={styles.pairLeft}>
                {phoneUrl ? <QrCode value={phoneUrl} size={190} /> : <div className={styles.qrPlaceholder}>探测局域网地址…</div>}
              </div>
              <div className={styles.pairRight}>
                <div className={styles.field}>
                  <span className="field-label">房间码</span>
                  <span className={styles.roomCode}>{roomId}</span>
                </div>

                {netInfo && netInfo.lan_ips.length > 1 && (
                  <div className={styles.field}>
                    <span className="field-label">局域网地址</span>
                    <select value={selectedIp} onChange={(e) => setSelectedIp(e.target.value)}>
                      {netInfo.lan_ips.map((ip) => (
                        <option key={ip} value={ip}>{ip}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div className={styles.field}>
                  <span className="field-label">手机访问地址</span>
                  <code className={styles.url}>{phoneUrl || "—"}</code>
                </div>

                <div className={styles.linkRow}>
                  <span className={`${styles.dot} ${linkStatus === "open" ? styles.dotOk : styles.dotBad}`} />
                  <span className={styles.linkText}>
                    {linkStatus === "open" ? "中转已连接" : "中转未连接"} · {remoteCount} 台手机
                  </span>
                </div>

                {netInfo && netInfo.lan_ips.length === 0 && (
                  <p className={styles.warn}>没探测到局域网地址，请检查是否连上了 Wi-Fi。</p>
                )}
                {insecureWarning && (
                  <p className={styles.warn}>
                    当前是 HTTP。iOS 只在 HTTPS 下才允许运动传感器权限，iPhone 需先启用 HTTPS（见 README「手机指挥」）。
                  </p>
                )}
              </div>
            </div>
          )}

          <span className={`${styles.statusBadge} ${status === "active" ? styles.statusActive : ""} ${status === "error" ? styles.statusError : ""}`}>
            {STATUS_LABEL[status]}
          </span>

          <button
            className={`${styles.startBtn} ${running ? styles.startBtnActive : ""}`}
            disabled={readyCount === 0}
            onClick={handleToggle}
          >
            {running ? "停止" : "开始指挥"}
          </button>

          <div className={styles.meters}>
            {(Object.keys(ROLE_LABELS) as InstrumentRole[]).map((role) => (
              <div className={styles.meter} key={role}>
                <div className={styles.meterTrack}>
                  <div className={styles.meterFill} style={{ height: `${Math.round(roleActivation[role] * dynamics * 100)}%` }} />
                </div>
                <span className={styles.meterLabel}>{ROLE_LABELS[role]}</span>
              </div>
            ))}
          </div>

          {error && <span className={styles.warn}>{error}</span>}
          {status === "nodata" && mode === "solo" && (
            <span className="label">没有收到传感器数据。这台设备可能没有传感器——用手机打开本页面，或切换到「电脑模式」。</span>
          )}
          {status === "nodata" && mode === "stage" && (
            <span className="label">还没有手机在发送数据。用手机扫上面的二维码接入。</span>
          )}
          {mode === "solo" && !soloSensorAvailable && (
            <span className="label">当前设备没有传感器，用手机打开本页面可获得完整指挥体验。</span>
          )}
        </div>
      )}
    </div>
  );
}
