/**
 * 指挥意图源抽象（M5）。
 *
 * M4 的 SensorSource 抽象的是「传感器采样从哪来」，但它的产物是 SensorSample ——
 * 一个 IMU 形状的结构（欧拉角 + 三轴加速度）。摄像头给的是手部关键点坐标，硬塞进
 * SensorSample 就得伪造出「度数的 beta/gamma」和「基线 9.81 的加速度」，那是把
 * 一种传感器伪装成另一种，早晚会在某个假设不成立的地方崩掉。
 *
 * 所以这一层往上提一级：抽象「指挥意图从哪来」。IMU 和摄像头各自实现自己的适配器，
 * 都产出 M4c 定义的 ConductIntent，混音层（mixIntent）对传感器一无所知。
 *
 *   IMU 适配器：SensorSample → GestureInterpreter.readIntent() → ConductIntent
 *   摄像头适配器：手部关键点 → CameraInterpreter.read() → ConductIntent
 */
import type { ConductIntent } from "./gesture";
import { GestureInterpreter } from "./gesture";
import type { SensorSource } from "./sensorSource";

export type IntentSourceKind = "local" | "remote" | "camera";

export interface IntentSource {
  readonly kind: IntentSourceKind;
  /** 可能需要向用户申请权限（iOS 的运动传感器、摄像头），失败时抛错。 */
  start(): Promise<void>;
  stop(): void;
  onIntent(cb: (intent: ConductIntent) => void): void;
  /** 这个源需要项目的基准速度才能算 tempoRatio。 */
  setBaseBpm(bpm: number): void;
}

/**
 * IMU 意图源：包一层现有的 SensorSource + GestureInterpreter。
 *
 * 单机模式和电脑模式的差别只在注入哪个 SensorSource，解析逻辑完全共用 —— 这是
 * M4 就有的性质，这里原样保留。
 */
export class ImuIntentSource implements IntentSource {
  readonly kind: IntentSourceKind;
  private readonly gesture = new GestureInterpreter();
  private listeners: ((i: ConductIntent) => void)[] = [];

  constructor(private readonly source: SensorSource) {
    this.kind = source.kind;
  }

  setBaseBpm(bpm: number): void {
    this.gesture.baseBpm = bpm;
  }

  async start(): Promise<void> {
    await this.source.start();
    this.source.onSample((sample) => {
      const intent = this.gesture.readIntent(sample);
      this.listeners.forEach((cb) => cb(intent));
    });
  }

  stop(): void {
    this.source.stop();
    this.listeners = [];
  }

  onIntent(cb: (intent: ConductIntent) => void): void {
    this.listeners.push(cb);
  }
}
