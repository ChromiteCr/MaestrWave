import { useEffect, useRef, useState } from "react";
import { Logo } from "../../components/Logo";
import { ConductLink, type LinkStatus } from "../../lib/conductLink";
import { LocalSensorSource } from "../../lib/sensorSource";
import styles from "./RemotePage.module.css";

/** 传感器事件约 60Hz，节流到 ~50Hz 已经远超挥动手势需要的精度。 */
const SEND_INTERVAL_MS = 20;

type StageState = "unknown" | "ready" | "absent" | "gone";

const LINK_LABEL: Record<LinkStatus, string> = {
  idle: "未连接",
  connecting: "连接中…",
  open: "已连接",
  closed: "连接断开",
  error: "连接错误",
};

/**
 * 手机端遥控界面（M4）。
 *
 * 通过扫码进入（URL 带 ?conduct=<房间码>），刻意不复用主界面的侧栏布局——
 * 手机上不需要文件/生成/训练那些页面，而且这一端**完全不加载音频**，
 * 只采传感器往电脑发，省流量也省解码开销。
 */
export function RemotePage({ roomId }: { roomId: string }) {
  const [linkStatus, setLinkStatus] = useState<LinkStatus>("idle");
  const [stageState, setStageState] = useState<StageState>("unknown");
  const [sending, setSending] = useState(false);
  const [energy, setEnergy] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const linkRef = useRef<ConductLink | null>(null);
  const sourceRef = useRef<LocalSensorSource | null>(null);
  const lastSentRef = useRef(0);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

  useEffect(() => {
    const link = new ConductLink(roomId, "remote");
    linkRef.current = link;
    link.onStatus(setLinkStatus);
    link.onMessage((msg) => {
      if (msg.t === "stage_ready") setStageState("ready");
      else if (msg.t === "no_stage") setStageState("absent");
      else if (msg.t === "stage_gone") setStageState("gone");
    });
    link.connect();
    return () => {
      link.close();
      linkRef.current = null;
    };
  }, [roomId]);

  // 手机息屏后传感器事件就停了，指挥会中断，所以主动请求屏幕常亮。
  const acquireWakeLock = async () => {
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
    };
    if (!nav.wakeLock) return;
    try {
      wakeLockRef.current = await nav.wakeLock.request("screen");
    } catch {
      /* 不支持或被拒绝时忽略，只是屏幕会自己灭 */
    }
  };

  useEffect(() => {
    if (!sending) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") acquireWakeLock();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [sending]);

  const handleStart = async () => {
    setError(null);
    const source = new LocalSensorSource();
    try {
      await source.start();
    } catch (e) {
      setError((e as Error).message || "传感器权限被拒绝");
      return;
    }
    sourceRef.current = source;
    setSending(true);
    acquireWakeLock();

    source.onSample((sample) => {
      const now = performance.now();
      if (now - lastSentRef.current < SEND_INTERVAL_MS) return;
      lastSentRef.current = now;
      linkRef.current?.sendSensor(sample);

      const { x, y, z } = sample.acceleration;
      const mag = Math.sqrt(x * x + y * y + z * z) - 9.81;
      setEnergy(Math.min(1, Math.max(0, mag / 15)));
    });
  };

  const handleStop = async () => {
    sourceRef.current?.stop();
    sourceRef.current = null;
    setSending(false);
    setEnergy(0);
    await wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  };

  const stageHint =
    stageState === "ready"
      ? "电脑已就绪"
      : stageState === "absent"
        ? "等待电脑打开「输出」页…"
        : stageState === "gone"
          ? "电脑已断开"
          : "…";

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Logo size={28} />
        <span className={styles.roomCode}>{roomId}</span>
      </header>

      <div className={styles.statusRow}>
        <span className={`${styles.dot} ${linkStatus === "open" ? styles.dotOk : styles.dotBad}`} />
        <span className={styles.statusText}>{LINK_LABEL[linkStatus]}</span>
        <span className={styles.divider} />
        <span className={styles.statusText}>{stageHint}</span>
      </div>

      <div className={styles.center}>
        <div className={styles.energyRing} style={{ transform: `scale(${1 + energy * 0.35})`, opacity: 0.25 + energy * 0.75 }} />
        <button
          className={`${styles.bigBtn} ${sending ? styles.bigBtnActive : ""}`}
          onClick={() => (sending ? handleStop() : handleStart())}
          disabled={linkStatus !== "open" && !sending}
        >
          {sending ? "停止" : "开始指挥"}
        </button>
      </div>

      <p className={styles.hint}>
        {sending
          ? "挥动手机即可指挥。左右倾斜切换声部，挥动力度控制强弱，打拍改变速度。"
          : "把手机当作指挥棒。点击开始后需要授权运动传感器权限。"}
      </p>

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
