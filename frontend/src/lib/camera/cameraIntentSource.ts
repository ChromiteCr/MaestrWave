/**
 * 摄像头意图源：HandTracker + ConductingModel 组装成一个 IntentSource。
 *
 * 对 useConductor 而言，它和 IMU 源没有任何区别 —— 两者都只产出 ConductIntent。
 * 这正是 M4c 把手势解析拆成两层时预留的接口。
 */
import type { ConductIntent } from "../gesture";
import type { IntentSource, IntentSourceKind } from "../intentSource";
import type { Point } from "../teaching/patterns";
import { ConductingModel, type CameraModelOptions } from "./conductingModel";
import { HandTracker, type HandFrame } from "./handTracker";

/**
 * 一帧的完整产出，给录制与评分用。
 *
 * `IntentSource` 的 `onIntent` 只给 ConductIntent —— 混音需要的就是这些。但评分
 * 还要坐标和「这一帧是不是拍点」，而 ConductIntent 里没有时间戳、轨迹也是 private。
 * 所以另开一条 `onSample`，混音路径完全不受影响。
 *
 * 只有摄像头源产出它：评分的六个维度里有三个需要手的位置，加速度计给不出来，
 * 所以教学与考试都只走摄像头（见 docs/M6_PLAN.md 里第 6 步为什么被砍掉）。
 */
export interface ConductSample {
  /** performance.now()，和 HandFrame.t 同源。 */
  t: number;
  intent: ConductIntent;
  /** 指挥视角坐标（x 左→右、y 下→上），与 lib/teaching/patterns.ts 同坐标系。 */
  beat: Point | null;
  expr: Point | null;
  /** 这一帧是否**确认**了一个拍点。 */
  ictus: boolean;
  /**
   * 该拍点的真实时刻（拐角本身，不是确认它的这一帧）。没有拍点时为 null。
   *
   * 必须单独带出来：多边形拐角要等出边够长才敢认，确认得比实际晚约 120ms。
   * 拿 `t` 当拍点时刻的话，每一拍都会被系统性地记晚 120ms，评分会一致地
   * 判成「你在拖拍」—— 而人其实没拖。
   */
  ictusAt: number | null;
}

export class CameraIntentSource implements IntentSource {
  readonly kind: IntentSourceKind = "camera";
  readonly tracker = new HandTracker();
  readonly model: ConductingModel;
  private listeners: ((i: ConductIntent) => void)[] = [];
  private sampleListeners: ((s: ConductSample) => void)[] = [];
  private lastSeenIctusAt = 0;
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

      if (this.sampleListeners.length) {
        // 拍点靠 lastIctusAt 变没变来判断，不是靠 beatPulse 的大小 ——
        // 脉冲有 200ms 衰减尾巴，用阈值判会把同一个拍点连报好几帧。
        const ictus = this.model.lastIctusAt > 0 && this.model.lastIctusAt !== this.lastSeenIctusAt;
        if (ictus) this.lastSeenIctusAt = this.model.lastIctusAt;
        const view = this.model.lastView;
        const ictusAt = ictus ? this.model.lastIctusAt : null;
        this.sampleListeners.forEach((cb) =>
          cb({ t: frame.t, intent, beat: view.beat, expr: view.expr, ictus, ictusAt }),
        );
      }
    });
  }

  stop(): void {
    this.tracker.stop();
    this.model.reset();
    this.listeners = [];
    this.sampleListeners = [];
    this.lastSeenIctusAt = 0;
    this.lastFrame = null;
  }

  onIntent(cb: (intent: ConductIntent) => void): void {
    this.listeners.push(cb);
  }

  /** 录制与评分用。混音只关心 ConductIntent，那条路走 onIntent。 */
  onSample(cb: (s: ConductSample) => void): void {
    this.sampleListeners.push(cb);
  }
}
