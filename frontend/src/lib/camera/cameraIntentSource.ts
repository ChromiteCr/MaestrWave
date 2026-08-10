/**
 * 摄像头意图源：HandTracker + ConductingModel 组装成一个 IntentSource。
 *
 * 对 useConductor 而言，它和 IMU 源没有任何区别 —— 两者都只产出 ConductIntent。
 * 这正是 M4c 把手势解析拆成两层时预留的接口。
 */
import type { ConductIntent } from "../gesture";
import type { IntentSource, IntentSourceKind } from "../intentSource";
import { ConductingModel, type CameraModelOptions } from "./conductingModel";
import { HandTracker, type HandFrame } from "./handTracker";

export class CameraIntentSource implements IntentSource {
  readonly kind: IntentSourceKind = "camera";
  readonly tracker = new HandTracker();
  readonly model: ConductingModel;
  private listeners: ((i: ConductIntent) => void)[] = [];
  /** 最近一帧的手部数据，供 UI 画骨架/状态用。 */
  lastFrame: HandFrame | null = null;

  constructor(opts: CameraModelOptions = {}) {
    this.model = new ConductingModel(opts);
  }

  setOptions(opts: CameraModelOptions): void {
    this.model.setOptions(opts);
  }

  setBaseBpm(bpm: number): void {
    this.model.setBaseBpm(bpm);
  }

  async start(): Promise<void> {
    await this.tracker.start();
    this.tracker.onFrame((frame) => {
      this.lastFrame = frame;
      // 一只手都没看到时不产出意图 —— 让 useConductor 的「无数据」检测接管，
      // 而不是喂一串空意图把音量悄悄压下去。
      if (!frame.left && !frame.right) return;
      const intent = this.model.read(frame);
      this.listeners.forEach((cb) => cb(intent));
    });
  }

  stop(): void {
    this.tracker.stop();
    this.model.reset();
    this.listeners = [];
    this.lastFrame = null;
  }

  onIntent(cb: (intent: ConductIntent) => void): void {
    this.listeners.push(cb);
  }
}
