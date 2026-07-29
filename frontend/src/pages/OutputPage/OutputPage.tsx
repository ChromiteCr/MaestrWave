import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../../components/PageHeader/PageHeader";
import { QrCode } from "../../components/QrCode/QrCode";
import { useConductor } from "../../lib/useConductor";
import { ConductLink, newRoomCode, type LinkStatus } from "../../lib/conductLink";
import { LocalSensorSource, RemoteSensorSource, type SensorSource } from "../../lib/sensorSource";
import type { InstrumentRole } from "../../lib/gesture";
import { api, type NetworkInfo, type TunnelStatus } from "../../lib/api";
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
  const [copied, setCopied] = useState<string | null>(null);
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus | null>(null);
  const [tunnelBusy, setTunnelBusy] = useState(false);

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

  const devPort = Number(window.location.port) || 5173;
  const cloudflaredCmd = `cloudflared tunnel --url http://localhost:${devPort}`;

  /**
   * 局域网模式的 HTTPS 自检。
   *
   * 这里有两个坑，之前都是**静默失败**：页面照样给出二维码，手机扫了却连不上，
   * 界面上一点线索都没有。
   *   - notStarted：证书生成过了，但 dev server 是用 `npm run dev`（HTTP）起的
   *   - ipNotCovered：换了 Wi-Fi 导致局域网 IP 变了，证书里签的还是旧 IP
   */
  const lanHttps = useMemo(() => {
    if (pairMethod !== "lan") return null;
    const cert = netInfo?.cert;
    const isHttps = window.location.protocol === "https:";
    // selectedHost 形如 "192.168.1.5:5173"，证书里记的是不带端口的地址
    const selectedIp = selectedHost.replace(/:\d+$/, "");
    // 拿不到覆盖列表时（没装 openssl）不误报，按"覆盖了"处理
    const covered = !cert?.covers?.length || cert.covers.includes(selectedIp);

    if (isHttps) {
      return covered
        ? { kind: "ok" as const }
        : { kind: "ipNotCovered" as const, ip: selectedIp, covers: cert!.covers };
    }
    if (!cert?.exists) return { kind: "noCert" as const };
    if (!covered) return { kind: "ipNotCovered" as const, ip: selectedIp, covers: cert.covers };
    return { kind: "notStarted" as const };
  }, [pairMethod, netInfo, selectedHost]);

  // 命令里带上仓库绝对路径：这几条是给用户直接复制去终端跑的，只写
  // `npm run dev:https` 的话，在 backend/ 之类的目录下执行会 ENOENT。
  const root = netInfo?.repo_root;
  const httpsCmd = root ? `npm --prefix ${root}/frontend run dev:https` : "npm run dev:https";
  const certsCmd = root ? `bash ${root}/scripts/dev-certs.sh` : "bash scripts/dev-certs.sh";

  // 进「隧道」方式时轮询后端代管的 cloudflared 状态：域名要几秒才分配下来，
  // 而且隧道中途挂掉也要能反映出来。
  useEffect(() => {
    if (pairMethod !== "tunnel") return;
    let alive = true;
    const tick = () => {
      api.tunnelStatus()
        .then((s) => {
          if (!alive) return;
          setTunnelStatus(s);
          // 后端一拿到域名就自动填进输入框，用户不用手动复制粘贴。
          if (s.url) setTunnelUrl((prev) => (prev === s.url ? prev : s.url!));
        })
        .catch(() => alive && setTunnelStatus(null));
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pairMethod]);

  const toggleTunnel = async () => {
    setTunnelBusy(true);
    try {
      const s = tunnelStatus?.running ? await api.tunnelStop() : await api.tunnelStart(devPort);
      setTunnelStatus(s);
      if (!s.running) setTunnelUrl("");
    } catch (e) {
      setError((e as Error).message || "隧道操作失败");
    } finally {
      setTunnelBusy(false);
    }
  };

  const copyCmd = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      /* 无剪贴板权限时用户仍可手动选中复制 */
    }
  };

  /** 一行可复制的命令。自检提示和隧道说明都用它。 */
  const CmdLine = ({ cmd }: { cmd: string }) => (
    <div className={styles.cmdRow}>
      <code className={styles.cmd}>{cmd}</code>
      <button type="button" className={styles.copyBtn} onClick={() => copyCmd(cmd)}>
        {copied === cmd ? "已复制" : "复制"}
      </button>
    </div>
  );

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
                        <span className="field-label">隧道</span>
                        {tunnelStatus && !tunnelStatus.available ? (
                          <>
                            <p className={styles.note}>
                              没检测到 cloudflared。装上就能在这里一键启停：
                              <code>brew install cloudflared</code>
                              <br />
                              或者自己开个终端跑下面这条命令，再把网址粘到下面。
                            </p>
                            <CmdLine cmd={cloudflaredCmd} />
                          </>
                        ) : (
                          <div className={styles.cmdRow}>
                            <button
                              type="button"
                              className={`${styles.tunnelBtn} ${tunnelStatus?.running ? styles.tunnelBtnOn : ""}`}
                              onClick={toggleTunnel}
                              disabled={tunnelBusy || !tunnelStatus}
                            >
                              {tunnelBusy
                                ? "处理中…"
                                : tunnelStatus?.running
                                  ? "停止隧道"
                                  : "启动隧道"}
                            </button>
                            <span className={styles.linkText}>
                              {!tunnelStatus
                                ? "检测中…"
                                : tunnelStatus.running && tunnelStatus.url
                                  ? "隧道已就绪"
                                  : tunnelStatus.running
                                    ? "正在分配域名…"
                                    : "未启动"}
                            </span>
                          </div>
                        )}
                      </div>

                      <div className={styles.field}>
                        <span className="field-label">隧道地址（启动后自动填入，也可手填）</span>
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
                      {tunnelStatus?.error && <p className={styles.warn}>{tunnelStatus.error}</p>}
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

                  {/* HTTPS 自检：把原本静默失败的两种情况说清楚，并给出可复制的命令 */}
                  {lanHttps?.kind === "notStarted" && (
                    <div className={styles.diag}>
                      <p className={styles.warn}>
                        证书已就绪，但 dev server 当前是以 HTTP 启动的，二维码里也就只能是 http://。
                        iPhone 在 HTTP 下拿不到运动传感器权限。改用下面的命令重启：
                      </p>
                      <CmdLine cmd={httpsCmd} />
                    </div>
                  )}

                  {lanHttps?.kind === "noCert" && (
                    <div className={styles.diag}>
                      <p className={styles.warn}>
                        还没有生成 HTTPS 证书。iPhone 需要 HTTPS 才能授权运动传感器，先生成证书、再用 HTTPS 启动：
                      </p>
                      <CmdLine cmd={certsCmd} />
                      <CmdLine cmd={httpsCmd} />
                    </div>
                  )}

                  {lanHttps?.kind === "ipNotCovered" && (
                    <div className={styles.diag}>
                      <p className={styles.warn}>
                        证书没有覆盖 {lanHttps.ip}（它签的是 {lanHttps.covers.join("、")}）。
                        多半是换过 Wi-Fi 导致局域网 IP 变了，手机会因为证书不匹配而连不上。
                        重新生成证书并重启即可（根证书不用在手机上重装）：
                      </p>
                      <CmdLine cmd={certsCmd} />
                      <CmdLine cmd={httpsCmd} />
                    </div>
                  )}
                  {pairMethod === "tunnel" && (
                    <p className={styles.note}>
                      隧道要求 dev server 放行它的域名，用 <code>npm run dev:tunnel</code> 启动即可（普通{" "}
                      <code>npm run dev</code> 会被 Vite 以 Host 不匹配拒绝）。走隧道时不需要 mkcert 证书。
                      <br />
                      ⚠️ 这个网址<strong>公网可访问</strong>，拿到链接的人都能接进来指挥。演示完记得关掉隧道。
                    </p>
                  )}
                  {/* 隧道模式的 HTTP 提醒；局域网模式已由上面的自检覆盖，不重复报 */}
                  {insecureWarning && pairMethod === "tunnel" && (
                    <p className={styles.warn}>
                      手机访问地址是 HTTP。iOS 只在 HTTPS 下才允许运动传感器权限——隧道地址应该是
                      https://，检查一下粘贴的网址。
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
