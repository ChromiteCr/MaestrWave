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

/** 电脑模式下手机怎么连过来：同一局域网，还是走公网隧道。 */
type PairMethod = "lan" | "tunnel";

/** 常见隧道域名后缀，用来自动识别"当前就是通过隧道打开的"。 */
const TUNNEL_HOST_PATTERN = /(trycloudflare\.com|ngrok-free\.app|ngrok\.io|ngrok\.app|loca\.lt)$/i;

/** 隧道地址存本地：cloudflared 每次重启换域名，但用户中途刷新页面不该丢。 */
const TUNNEL_URL_KEY = "maestrwave.tunnelUrl";

function readStoredTunnelUrl(): string {
  try {
    return localStorage.getItem(TUNNEL_URL_KEY) ?? "";
  } catch {
    return ""; // 隐私模式下 localStorage 可能不可用
  }
}

export function OutputPage() {
  const project = useAppStore((s) => s.project);
  const { status, roleActivation, dynamics, start, stop } = useConductor();

  const [mode, setMode] = useState<ConductMode>("solo");
  const [roomId] = useState(() => newRoomCode());
  const [linkStatus, setLinkStatus] = useState<LinkStatus>("idle");
  const [remoteCount, setRemoteCount] = useState(0);
  const [netInfo, setNetInfo] = useState<NetworkInfo | null>(null);
  const [selectedHost, setSelectedHost] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  // 如果这台电脑本身就是通过隧道域名打开的，默认直接进隧道方式并预填地址。
  const openedViaTunnel = TUNNEL_HOST_PATTERN.test(window.location.hostname);
  const [pairMethod, setPairMethod] = useState<PairMethod>(openedViaTunnel ? "tunnel" : "lan");
  const [tunnelUrl, setTunnelUrl] = useState<string>(() =>
    openedViaTunnel ? window.location.origin : readStoredTunnelUrl(),
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      if (tunnelUrl.trim()) localStorage.setItem(TUNNEL_URL_KEY, tunnelUrl.trim());
      else localStorage.removeItem(TUNNEL_URL_KEY);
    } catch {
      /* 隐私模式下忽略 */
    }
  }, [tunnelUrl]);

  const linkRef = useRef<ConductLink | null>(null);
  const running = status !== "idle" && status !== "error";

  const readyCount = project?.instruments.filter((i) => i.current_take_id).length ?? 0;
  const soloSensorAvailable = LocalSensorSource.isAvailable();

  useEffect(() => {
    api.networkInfo().then(setNetInfo).catch(() => setNetInfo(null));
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

  /**
   * 手机该访问哪个地址，取决于这台电脑自己是怎么被访问的：
   *   - 电脑开的是 localhost  → 手机连不上 localhost，必须换成后端探测到的局域网 IP
   *   - 电脑开的是局域网 IP / 隧道域名（cloudflared、ngrok）→ 这个地址手机本来就能用，
   *     直接沿用当前 origin。隧道场景下绝不能拼局域网 IP：那台手机可能根本不在同一个网里。
   */
  const hostOptions = useMemo(() => {
    const loc = window.location;
    const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(loc.hostname);
    const port = loc.port ? `:${loc.port}` : "";
    const options: { host: string; label: string }[] = [];

    if (!isLoopback) options.push({ host: loc.host, label: `${loc.host}（当前地址）` });
    for (const ip of netInfo?.lan_ips ?? []) {
      const host = `${ip}${port}`;
      if (!options.some((o) => o.host === host)) options.push({ host, label: `${host}（局域网）` });
    }
    return options;
  }, [netInfo]);

  useEffect(() => {
    setSelectedHost((prev) => (prev && hostOptions.some((o) => o.host === prev) ? prev : hostOptions[0]?.host ?? ""));
  }, [hostOptions]);

  /** 用户可能只粘贴了域名、或带了路径/末尾斜杠，统一归一成 origin。 */
  const tunnelOrigin = useMemo(() => {
    const raw = tunnelUrl.trim();
    if (!raw) return null;
    try {
      return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin;
    } catch {
      return null;
    }
  }, [tunnelUrl]);

  const phoneUrl = useMemo(() => {
    if (pairMethod === "tunnel") {
      return tunnelOrigin ? `${tunnelOrigin}/?conduct=${roomId}` : "";
    }
    return selectedHost ? `${window.location.protocol}//${selectedHost}/?conduct=${roomId}` : "";
  }, [pairMethod, tunnelOrigin, selectedHost, roomId]);

  // iOS 只在安全上下文里给运动传感器权限，走 http 时手机会连权限框都不弹。
  // 判断依据是**手机实际要访问的地址**而不是这台电脑当前的地址——隧道模式下
  // 本地是 http，但手机走的是隧道的 https，不该误报。
  const insecureWarning = phoneUrl.startsWith("http://");

  const cloudflaredCmd = `cloudflared tunnel --url http://localhost:${window.location.port || "5173"}`;

  const copyCmd = async () => {
    try {
      await navigator.clipboard.writeText(cloudflaredCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 无剪贴板权限时用户仍可手动选中复制 */
    }
  };

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
              : "手机扫码当指挥棒，声音从这台电脑放出。手机可以走局域网，也可以走公网隧道。"}
          </p>

          {mode === "stage" && (
            <>
              <div className={styles.methodToggle}>
                <button
                  type="button"
                  className={`${styles.methodBtn} ${pairMethod === "lan" ? styles.methodActive : ""}`}
                  onClick={() => setPairMethod("lan")}
                >
                  局域网
                </button>
                <button
                  type="button"
                  className={`${styles.methodBtn} ${pairMethod === "tunnel" ? styles.methodActive : ""}`}
                  onClick={() => setPairMethod("tunnel")}
                >
                  隧道
                </button>
              </div>
              <p className={styles.methodHint}>
                {pairMethod === "lan"
                  ? "手机和电脑连同一个 Wi-Fi。延迟最低；iPhone 需要先装 mkcert 根证书。"
                  : "把本机通过公网隧道暴露出去。证书是公开受信任的，任何手机零安装，也不要求同一网络。"}
              </p>

              <div className={styles.pairCard}>
                <div className={styles.pairLeft}>
                  {phoneUrl ? (
                    <QrCode value={phoneUrl} size={190} />
                  ) : (
                    <div className={styles.qrPlaceholder}>
                      {pairMethod === "tunnel" ? "粘贴隧道地址后生成二维码" : "探测局域网地址…"}
                    </div>
                  )}
                </div>
                <div className={styles.pairRight}>
                  <div className={styles.field}>
                    <span className="field-label">房间码</span>
                    <span className={styles.roomCode}>{roomId}</span>
                  </div>

                  {pairMethod === "lan" && hostOptions.length > 1 && (
                    <div className={styles.field}>
                      <span className="field-label">手机走哪个地址</span>
                      <select value={selectedHost} onChange={(e) => setSelectedHost(e.target.value)}>
                        {hostOptions.map((o) => (
                          <option key={o.host} value={o.host}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {pairMethod === "tunnel" && (
                    <>
                      <div className={styles.field}>
                        <span className="field-label">1. 另开一个终端运行</span>
                        <div className={styles.cmdRow}>
                          <code className={styles.cmd}>{cloudflaredCmd}</code>
                          <button type="button" className={styles.copyBtn} onClick={copyCmd}>
                            {copied ? "已复制" : "复制"}
                          </button>
                        </div>
                      </div>
                      <div className={styles.field}>
                        <span className="field-label">2. 把它输出的网址粘到这里</span>
                        <input
                          value={tunnelUrl}
                          onChange={(e) => setTunnelUrl(e.target.value)}
                          placeholder="https://xxx-yyy-zzz.trycloudflare.com"
                          spellCheck={false}
                          autoComplete="off"
                        />
                      </div>
                      {tunnelUrl.trim() && !tunnelOrigin && (
                        <p className={styles.warn}>这个地址解析不了，检查一下有没有粘全。</p>
                      )}
                    </>
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

                  {pairMethod === "lan" && hostOptions.length === 0 && (
                    <p className={styles.warn}>
                      没探测到手机可达的地址。请确认已连上 Wi-Fi，或改用「隧道」方式。
                    </p>
                  )}
                  {pairMethod === "tunnel" && (
                    <p className={styles.note}>
                      隧道要求 dev server 放行它的域名，用 <code>npm run dev:tunnel</code> 启动即可（普通{" "}
                      <code>npm run dev</code> 会被 Vite 以 Host 不匹配拒绝）。走隧道时不需要 mkcert 证书。
                      <br />
                      ⚠️ 这个网址<strong>公网可访问</strong>，拿到链接的人都能接进来指挥。演示完记得关掉隧道。
                    </p>
                  )}
                  {insecureWarning && (
                    <p className={styles.warn}>
                      手机访问地址是 HTTP。iOS 只在 HTTPS 下才允许运动传感器权限——
                      {pairMethod === "lan"
                        ? "用 npm run dev:https 启动，并在 iPhone 上装 mkcert 根证书（见 README「手机指挥」）。"
                        : "隧道地址应该是 https://，检查一下粘贴的网址。"}
                    </p>
                  )}
                </div>
              </div>
            </>
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
