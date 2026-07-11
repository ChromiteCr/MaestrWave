/** 移植自 legacy/js/sensor.js，逻辑不变，仅加了类型。 */
export interface SensorSample {
  orientation: { alpha: number; beta: number; gamma: number };
  acceleration: { x: number; y: number; z: number };
  rotationRate: { alpha: number; beta: number; gamma: number };
  timestamp: number;
}

type Listener = (data: SensorSample) => void;

export class SensorInput {
  private alpha = 0;
  private beta = 0;
  private gamma = 0;
  private acceleration = { x: 0, y: 0, z: 0 };
  private rotationRate = { alpha: 0, beta: 0, gamma: 0 };
  private listeners: Listener[] = [];
  private started = false;
  private receivedData = false;

  static isAvailable(): boolean {
    return (
      typeof window !== "undefined" &&
      (typeof DeviceMotionEvent !== "undefined" || typeof DeviceOrientationEvent !== "undefined")
    );
  }

  hasReceivedData(): boolean {
    return this.receivedData;
  }

  async requestPermission(): Promise<void> {
    const DME = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof DME?.requestPermission === "function") {
      const p = await DME.requestPermission();
      if (p !== "granted") throw new Error("DeviceMotion 权限被拒绝");
    }
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof DOE?.requestPermission === "function") {
      try {
        const p = await DOE.requestPermission();
        if (p !== "granted") throw new Error("DeviceOrientation 权限被拒绝");
      } catch {
        // Android / 其他浏览器没有该 API，忽略
      }
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    window.addEventListener("deviceorientation", (e) => {
      this.alpha = e.alpha || 0;
      this.beta = e.beta || 0;
      this.gamma = e.gamma || 0;
      this.receivedData = true;
    });

    window.addEventListener("devicemotion", (e) => {
      const acc = e.accelerationIncludingGravity || e.acceleration || { x: 0, y: 0, z: 0 };
      this.acceleration = { x: acc.x || 0, y: acc.y || 0, z: acc.z || 0 };
      const rr = e.rotationRate || ({} as DeviceMotionEventRotationRate);
      this.rotationRate = { alpha: rr.alpha || 0, beta: rr.beta || 0, gamma: rr.gamma || 0 };
      this.receivedData = true;
      this.notify();
    });
  }

  onUpdate(callback: Listener): void {
    this.listeners.push(callback);
  }

  private notify(): void {
    const data: SensorSample = {
      orientation: { alpha: this.alpha, beta: this.beta, gamma: this.gamma },
      acceleration: this.acceleration,
      rotationRate: this.rotationRate,
      timestamp: performance.now(),
    };
    this.listeners.forEach((cb) => cb(data));
  }
}
