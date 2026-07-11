import type { SensorSample } from "./sensor";

export type InstrumentRole = "melody" | "harmony" | "bass" | "rhythm";

export interface GestureParams {
  roles: Record<InstrumentRole, number>;
  dynamics: number;
  tempo: number;
  density: number;
  expression: "crescendo" | "decrescendo" | "cutoff" | null;
}

/**
 * 移植自 legacy/js/gesture.js。原版把空间方向直接映射到写死的 5 个乐器名
 * （violin/cello/trumpet/woodwind/percussion）；新架构下项目乐器是任意的，
 * 所以这里改成映射到 4 个通用角色（melody/harmony/bass/rhythm，对应
 * backend/config.py 里 INSTRUMENT_LIBRARY 的 role 字段），调用方按每个
 * 乐器的 role 去查对应的激活度。手势解析算法本身（sigmoid 平滑、节拍检测、
 * 密度/表情识别）完全不变。
 */
export class GestureInterpreter {
  private history: SensorSample[] = [];
  private readonly historySize = 60;
  private lastBeatTime = 0;
  private bpm = 80;
  baseBpm = 80;
  private filtered = { energy: 0, gamma: 0, beta: 0 };

  process(sample: SensorSample): GestureParams {
    this.history.push(sample);
    if (this.history.length > this.historySize) this.history.shift();

    const { orientation, acceleration } = sample;
    const energy = Math.sqrt(acceleration.x ** 2 + acceleration.y ** 2 + acceleration.z ** 2) - 9.81;
    this.filtered.energy = this.smooth(this.filtered.energy, Math.max(0, energy), 0.3);
    this.filtered.gamma = this.smooth(this.filtered.gamma, orientation.gamma, 0.2);
    this.filtered.beta = this.smooth(this.filtered.beta, orientation.beta, 0.2);

    return {
      roles: this.calcRoleActivation(),
      dynamics: this.calcDynamics(),
      tempo: this.calcTempo(acceleration),
      density: this.calcDensity(),
      expression: this.detectExpression(),
    };
  }

  private calcRoleActivation(): Record<InstrumentRole, number> {
    const g = this.filtered.gamma; // 左右倾斜
    const b = this.filtered.beta; // 前后倾斜
    const smooth = 15;
    return {
      melody: this.sigmoid((-g - 20) / smooth), // 左倾 -> 主旋律
      harmony: this.sigmoid((g - 20) / smooth), // 右倾 -> 和声
      bass: this.sigmoid((-b - 15) / smooth), // 上仰 -> 低音
      rhythm: this.sigmoid((b - 15) / smooth), // 下俯 -> 节奏
    };
  }

  private calcDynamics(): number {
    const REST = 0.5;
    const MAX = 15;
    return Math.min(1, Math.max(0, (this.filtered.energy - REST) / (MAX - REST)));
  }

  private calcTempo(acceleration: SensorSample["acceleration"]): number {
    const now = performance.now();
    if (this.history.length >= 2) {
      const prev = this.history[this.history.length - 2].acceleration.y;
      const curr = acceleration.y;
      if (prev < 0 && curr >= 0 && this.filtered.energy > 2) {
        const interval = now - this.lastBeatTime;
        if (interval > 200 && interval < 2000) {
          const detected = 60000 / interval;
          const minBpm = this.baseBpm * 0.7;
          const maxBpm = this.baseBpm * 1.3;
          const clamped = Math.min(maxBpm, Math.max(minBpm, detected));
          this.bpm = this.smooth(this.bpm, clamped, 0.15);
        }
        this.lastBeatTime = now;
      }
    }
    return this.bpm / this.baseBpm;
  }

  private calcDensity(): number {
    const recent = this.history.slice(-30);
    if (recent.length < 5) return 0.5;
    const energies = recent.map((d) => Math.sqrt(d.acceleration.x ** 2 + d.acceleration.y ** 2 + d.acceleration.z ** 2));
    return Math.min(1, this.variance(energies) / 50);
  }

  private detectExpression(): GestureParams["expression"] {
    if (this.history.length < 30) return null;
    const recent = this.history.slice(-30);
    const trend = recent.map((d) => Math.sqrt(d.acceleration.x ** 2 + d.acceleration.y ** 2 + d.acceleration.z ** 2));
    if (this.isRising(trend)) return "crescendo";
    if (this.isFalling(trend)) return "decrescendo";
    const last = trend[trend.length - 1];
    const avg = trend.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
    if (avg > 5 && last < 1) return "cutoff";
    return null;
  }

  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
  }
  private smooth(prev: number, curr: number, factor: number): number {
    return prev * (1 - factor) + curr * factor;
  }
  private variance(arr: number[]): number {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / arr.length;
  }
  private isRising(arr: number[]): boolean {
    let rises = 0;
    for (let i = 1; i < arr.length; i++) if (arr[i] > arr[i - 1]) rises++;
    return rises / (arr.length - 1) > 0.7;
  }
  private isFalling(arr: number[]): boolean {
    let falls = 0;
    for (let i = 1; i < arr.length; i++) if (arr[i] < arr[i - 1]) falls++;
    return falls / (arr.length - 1) > 0.7;
  }
}
