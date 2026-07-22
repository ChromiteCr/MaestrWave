/**
 * 手机遥控指挥的 WebSocket 客户端（M4）。
 *
 * 两端共用这一个类，靠 role 区分：
 *   - stage  ：电脑，收传感器采样，负责出声
 *   - remote ：手机，发传感器采样，不加载任何音频
 *
 * 后端是纯转发（见 backend/conduct.py），所以这里除了收发还要自己管
 * 重连和心跳——手机息屏/切后台会断，回来时要能自动接上。
 */
import type { SensorSample } from "./sensor";

export type ConductRole = "stage" | "remote";
export type LinkStatus = "idle" | "connecting" | "open" | "closed" | "error";

/** 后端与对端可能发来的消息，t 是类型标签。 */
export interface ConductMessage {
  t: string;
  [key: string]: unknown;
}

const HEARTBEAT_MS = 15000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;

/** 房间码用去掉易混淆字符（0/O、1/I/L）的字母表，方便用户口头念或手输。 */
const ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newRoomCode(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join("");
}

export function conductWsUrl(roomId: string, role: ConductRole): string {
  // 页面是 https 时必须用 wss，否则浏览器会以混合内容为由拒绝连接。
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/conduct/${encodeURIComponent(roomId)}?role=${role}`;
}

export class ConductLink {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private closedByUser = false;
  private messageListeners: ((msg: ConductMessage) => void)[] = [];
  private statusListeners: ((status: LinkStatus) => void)[] = [];

  status: LinkStatus = "idle";

  constructor(
    readonly roomId: string,
    readonly role: ConductRole,
  ) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(conductWsUrl(this.roomId, this.role));
    } catch {
      this.setStatus("error");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus("open");
      this.startHeartbeat();
    };

    ws.onmessage = (event) => {
      let msg: ConductMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.t === "pong") return;
      this.messageListeners.forEach((cb) => cb(msg));
    };

    ws.onerror = () => {
      this.setStatus("error");
    };

    ws.onclose = () => {
      this.stopHeartbeat();
      this.ws = null;
      if (this.closedByUser) {
        this.setStatus("closed");
      } else {
        this.setStatus("closed");
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    // 指数退避，封顶 8 秒——手机在电梯里断网时不至于疯狂重试耗电。
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.open();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.send({ t: "ping" }), HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private setStatus(status: LinkStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusListeners.forEach((cb) => cb(status));
  }

  send(payload: ConductMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  /** 手机端专用：发一帧传感器采样。 */
  sendSensor(sample: SensorSample): void {
    this.send({ t: "sensor", d: sample as unknown as Record<string, unknown> });
  }

  onMessage(cb: (msg: ConductMessage) => void): void {
    this.messageListeners.push(cb);
  }

  onStatus(cb: (status: LinkStatus) => void): void {
    this.statusListeners.push(cb);
  }

  close(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setStatus("closed");
  }
}
