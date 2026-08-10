/**
 * 摄像头手部追踪：getUserMedia + MediaPipe HandLandmarker。
 *
 * 只做「取图 → 出关键点」，不含任何音乐语义 —— 怎么把手的位置解释成指挥意图是
 * conductingModel.ts 的事。
 *
 * 资源来源：WASM 由 npm 装进 node_modules，predev/prebuild 自动复制到
 * public/mediapipe/wasm/（见 frontend/scripts/sync-mediapipe-wasm.mjs）；模型文件
 * public/mediapipe/models/hand_landmarker.task 进仓库（npm 不提供它）。两者都在本地，
 * 断网也能用 —— 演示现场没网是常态。
 *
 * 性能：必须走 GPU delegate。纯 CPU 只有 10~15fps，GPU 下能到 60+。MediaPipe 的
 * Vision Tasks 目前还不支持 WebGPU，所以这里是 WebGL。
 */
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";

const WASM_PATH = "/mediapipe/wasm";
const MODEL_PATH = "/mediapipe/models/hand_landmarker.task";

/** 手部关键点里我们真正要用的两个。 */
// 手腕。抖动较大，只用来兜底。
const WRIST = 0;
// 中指掌指关节。比手腕稳得多，是整只手位置的最佳单点代表。
const MIDDLE_MCP = 9;
const INDEX_TIP = 8;
const PINKY_MCP = 17;
const THUMB_TIP = 4;

export interface HandPoint {
  /** 0..1，图像坐标系。注意 y 向下为正。 */
  x: number;
  y: number;
  /** 手张开的程度（拇指尖到食指尖的距离，按手掌宽度归一化），0..1 左右。 */
  spread: number;
  /** MediaPipe 给的置信度。 */
  score: number;
}

export interface HandFrame {
  /** 接收侧时钟（performance.now），不是视频帧时间戳。 */
  t: number;
  /** MediaPipe 判定的左右手。null 表示这一帧没看到手。 */
  left: HandPoint | null;
  right: HandPoint | null;
}

export class HandTrackerError extends Error {}

function toPoint(lm: HandLandmarkerResult["landmarks"][number], score: number): HandPoint {
  const p = lm[MIDDLE_MCP] ?? lm[WRIST];
  const palm = Math.hypot(
    (lm[MIDDLE_MCP]?.x ?? 0) - (lm[PINKY_MCP]?.x ?? 0),
    (lm[MIDDLE_MCP]?.y ?? 0) - (lm[PINKY_MCP]?.y ?? 0),
  ) || 0.05;
  const pinch = Math.hypot(
    (lm[THUMB_TIP]?.x ?? 0) - (lm[INDEX_TIP]?.x ?? 0),
    (lm[THUMB_TIP]?.y ?? 0) - (lm[INDEX_TIP]?.y ?? 0),
  );
  return { x: p.x, y: p.y, spread: Math.min(2, pinch / palm) / 2, score };
}

export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private raf = 0;
  private running = false;
  private lastVideoTime = -1;
  private listeners: ((f: HandFrame) => void)[] = [];
  /** 最近一次推理耗时（毫秒），给 UI 显示性能用。 */
  fps = 0;
  private frameTimes: number[] = [];

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  }

  /** getUserMedia 要求安全上下文：https 或 localhost。 */
  static isSecureContextOk(): boolean {
    return typeof window !== "undefined" && (window.isSecureContext || location.hostname === "localhost");
  }

  onFrame(cb: (f: HandFrame) => void): void {
    this.listeners.push(cb);
  }

  /** 供 UI 显示画面用。start() 之后才有值。 */
  get videoElement(): HTMLVideoElement | null {
    return this.video;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!HandTracker.isSupported()) {
      throw new HandTrackerError("这个浏览器不支持摄像头采集（navigator.mediaDevices 缺失）。");
    }
    if (!HandTracker.isSecureContextOk()) {
      throw new HandTrackerError(
        "摄像头需要安全上下文。用 localhost 访问，或以 HTTPS 启动（npm run dev:https）。",
      );
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
        audio: false,
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === "NotAllowedError") throw new HandTrackerError("摄像头权限被拒绝。");
      if (name === "NotFoundError") throw new HandTrackerError("没有找到可用的摄像头。");
      throw new HandTrackerError(`摄像头打开失败：${name || e}`);
    }

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = this.stream;
    await video.play();
    this.video = video;

    try {
      const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    } catch (e) {
      this.stop();
      throw new HandTrackerError(
        `手部识别模型加载失败：${e instanceof Error ? e.message : e}。` +
        `确认 public/mediapipe/ 下有 wasm 与模型文件（跑一次 npm run predev）。`,
      );
    }

    this.running = true;
    this.loop();
  }

  private loop = (): void => {
    if (!this.running || !this.video || !this.landmarker) return;
    const video = this.video;

    // 同一帧不重复推理 —— 视频 30fps 而 rAF 60fps，不判会白跑一半算力。
    if (video.currentTime !== this.lastVideoTime && video.readyState >= 2) {
      this.lastVideoTime = video.currentTime;
      const now = performance.now();
      try {
        const res = this.landmarker.detectForVideo(video, now);
        this.emit(res, now);
      } catch {
        // 单帧推理失败不该让整个循环停掉（切后台、设备被抢占都可能触发）
      }
      this.frameTimes.push(now);
      while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
      this.fps = this.frameTimes.length;
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private emit(res: HandLandmarkerResult, t: number): void {
    let left: HandPoint | null = null;
    let right: HandPoint | null = null;
    res.landmarks.forEach((lm, i) => {
      const cat = res.handedness[i]?.[0];
      if (!cat) return;
      const pt = toPoint(lm, cat.score);
      // MediaPipe 的 handedness 是按「自拍镜像视角」判定的，也就是它说的 Left
      // 对应用户自己的左手。这里保持它的语义，是否交换由上层决定（左撇子指挥、
      // 以及摄像头是否做了镜像，都可能需要换）。
      if (cat.categoryName === "Left") left = pt;
      else right = pt;
    });
    const frame: HandFrame = { t, left, right };
    this.listeners.forEach((cb) => cb(frame));
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.landmarker?.close();
    this.landmarker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.listeners = [];
    this.lastVideoTime = -1;
  }
}
