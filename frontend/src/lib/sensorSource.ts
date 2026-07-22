/**
 * 传感器源抽象（M4）。
 *
 * 原来 useConductor 里「采集传感器」和「出声」是焊死在一起的，所以只能
 * 单机玩。这里把「采集」抽成可替换的源，让同一套指挥逻辑同时支持：
 *   - 单机模式：手机自己采、自己放  → LocalSensorSource
 *   - 电脑模式：手机采、电脑放      → RemoteSensorSource（数据来自 WebSocket）
 *
 * 出声那一侧（audioEngine + applyToAudio）两种模式完全共用，不需要分支。
 */
import { SensorInput, type SensorSample } from "./sensor";
import type { ConductLink } from "./conductLink";

export type SensorSourceKind = "local" | "remote";

export interface SensorSource {
  readonly kind: SensorSourceKind;
  /** 可能需要向用户申请权限（iOS），失败时抛错。 */
  start(): Promise<void>;
  stop(): void;
  onSample(cb: (sample: SensorSample) => void): void;
}

/** 单机模式：直接读本机传感器。 */
export class LocalSensorSource implements SensorSource {
  readonly kind = "local" as const;
  private sensor = new SensorInput();
  private listeners: ((s: SensorSample) => void)[] = [];

  static isAvailable(): boolean {
    return SensorInput.isAvailable();
  }

  async start(): Promise<void> {
    await this.sensor.requestPermission();
    this.sensor.start();
    this.sensor.onUpdate((sample) => this.listeners.forEach((cb) => cb(sample)));
  }

  stop(): void {
    // SensorInput 的事件监听是进程级的，停掉分发即可（不再驱动音频）。
    this.listeners = [];
  }

  onSample(cb: (sample: SensorSample) => void): void {
    this.listeners.push(cb);
  }
}

/**
 * 电脑模式的舞台端：采样来自手机，经后端 WebSocket 转发过来。
 * 这一侧不申请任何权限——电脑本来就没有传感器。
 */
export class RemoteSensorSource implements SensorSource {
  readonly kind = "remote" as const;
  private listeners: ((s: SensorSample) => void)[] = [];
  private bound = false;

  constructor(private readonly link: ConductLink) {}

  async start(): Promise<void> {
    if (this.bound) return;
    this.bound = true;
    this.link.onMessage((msg) => {
      if (msg.t !== "sensor" || !msg.d) return;
      const sample = msg.d as unknown as SensorSample;
      this.listeners.forEach((cb) => cb(sample));
    });
  }

  stop(): void {
    this.listeners = [];
  }

  onSample(cb: (sample: SensorSample) => void): void {
    this.listeners.push(cb);
  }
}
