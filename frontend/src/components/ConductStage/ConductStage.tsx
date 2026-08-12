import type { CSSProperties } from "react";
import { BeatIndicator } from "../BeatIndicator/BeatIndicator";
import { CameraPreview } from "../CameraPreview/CameraPreview";
import type { CameraIntentSource } from "../../lib/camera/cameraIntentSource";
import type { ConductMode } from "../../lib/conductMode";
import type { InstrumentRole } from "../../lib/gesture";
import styles from "./ConductStage.module.css";

/**
 * 指挥台：占满整屏宽度的一块，指挥时该看的东西全在这里面。
 *
 * ## 为什么要铺满整屏
 *
 * 指挥时人是站着的、手在动、眼睛离屏幕一两米。这个距离上，一列 14px 宽、140px
 * 高的音量条基本等于不存在 —— 原来的四条音量条挤在页面正中央、一根手指就能盖住。
 * 而指挥恰恰是**余光**在工作：视线要跟着自己的手走，界面只能靠画面边缘的明暗
 * 变化传信息。所以音量条搬到屏幕最左最右两条边、拉到整屏高，拍点确认闪的是整块
 * 屏幕的边框。这些都是余光看得见的东西。
 *
 * ## 音量条为什么是这个左右顺序
 *
 * 摄像头画面里画着席位分区线（见 `CameraPreview` 的 `ZONES`）：主旋律在左
 * (x=0.16)、和声居中 (0.5)、低音在右 (0.84)。所以最外侧那两条留给主旋律（最左）
 * 和低音（最右）——**手往哪边指，哪边的边条就亮**，位置对得上。和声在正中、节奏
 * 跟拍点走没有方位，两者放内侧。
 *
 * ## 两个「拍」不是一回事，所以分开显示
 *
 * - **乐曲的拍**（右上角的拍型小窗）：曲子现在放到第几小节第几拍，来自播放位置。
 * - **你打的拍**（整块屏幕闪一下）：手势解析确认了一个拍点，来自 `beatCount`。
 *
 * 两者对齐的时候就是跟上了。合成一个显示的话，这件最要紧的事恰恰看不出来。
 */

const ROLE_LABELS: Record<InstrumentRole, string> = {
  melody: "主旋律",
  harmony: "和声",
  bass: "低音",
  rhythm: "节奏",
};

/** 外侧 → 内侧。最外那条对应画面里最靠边的那个席位区。 */
const LEFT_RAIL: InstrumentRole[] = ["melody", "harmony"];
const RIGHT_RAIL: InstrumentRole[] = ["rhythm", "bass"];

interface Props {
  mode: ConductMode;
  running: boolean;
  /** 摄像头模式的意图源；没开摄像头时传 null，预览会显示占位文字。 */
  camera: CameraIntentSource | null;
  swapHands: boolean;
  roleActivation: Record<InstrumentRole, number>;
  dynamics: number;
  /** 相对基准速度的倍率。 */
  tempo: number;
  baseBpm: number;
  beatsPerBar: number;
  /** 用户打完的拍数，每确认一拍 +1。只用它的「变没变」。 */
  beatCount: number;
  /** 画面中央该说的一句话。调用方按状态给（它才知道手机接没接进来）。 */
  hint: string;
}

function Meter({ role, level }: { role: InstrumentRole; level: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, level)) * 100);
  return (
    <div className={styles.meter}>
      <div className={styles.meterTrack}>
        <div className={styles.meterFill} style={{ height: `${pct}%` }} />
      </div>
      <span className={styles.meterLabel}>{ROLE_LABELS[role]}</span>
    </div>
  );
}

export function ConductStage({
  mode, running, camera, swapHands, roleActivation, dynamics,
  tempo, baseBpm, beatsPerBar, beatCount, hint,
}: Props) {
  const level = (role: InstrumentRole) => roleActivation[role] * dynamics;
  const bpm = Math.round(baseBpm * tempo);

  return (
    <div
      className={`${styles.stage} ${running ? styles.stageLive : ""}`}
      // 力度直接驱动整块的辉光。手挥大一点整个屏幕就亮一点 —— 这是余光唯一
      // 读得到的「我现在给的力度」，比任何数字都快。
      style={{ "--dyn": dynamics } as CSSProperties}
    >
      {/*
        拍点提示：整块屏幕的边框闪一下。
        用 key 强制换节点来重放动画 —— 同一个节点上改 class 的话，两拍打得快时
        第二拍的动画不会从头开始（浏览器认为它已经在跑了），快速段落里就没反馈了。
      */}
      {running && beatCount > 0 && (
        <span key={beatCount} className={styles.beatFlash} aria-hidden="true" />
      )}

      <div className={styles.rail}>
        {LEFT_RAIL.map((r) => <Meter key={r} role={r} level={level(r)} />)}
      </div>

      <div className={styles.center}>
        <div className={styles.viewport}>
          {mode === "camera" ? (
            <CameraPreview
              source={camera}
              swapHands={swapHands}
              height="100%"
              placeholder={hint}
            />
          ) : (
            <div className={styles.pulse}>
              {/*
                电脑模式下没有画面可看：手机给的是姿态和加速度，没有「手在哪儿」
                这回事，画一条轨迹出来就是编的。所以这里只呈现引擎**真的**收到的
                东西 —— 力度（光晕大小）和拍点（闪一下）。
              */}
              <div
                className={styles.pulseHalo}
                style={{ transform: `scale(${0.55 + dynamics * 0.85})`, opacity: 0.2 + dynamics * 0.65 }}
              />
              <div className={styles.pulseCore} />
              <span className={styles.pulseHint}>{hint}</span>
            </div>
          )}

          <div className={styles.hud}>
            <div className={styles.hudLeft}>
              {running && (
                <>
                  {/*
                    说「现在的速度」而不是「你打的速度」：起播到手势进来之前
                    tempo 就是 1，那时它是曲子的基准速度，不是任何人打出来的。
                    底下并排给基准值 —— 两个数一样就说明跟上了。
                  */}
                  <span className={styles.hudNum}>{bpm}</span>
                  <span className={styles.hudUnit}>BPM · 现在的速度</span>
                  <span className={styles.hudSub}>基准 {baseBpm}</span>
                </>
              )}
            </div>
            <div className={styles.hudRight}>
              <BeatIndicator bpm={baseBpm} beatsPerBar={beatsPerBar} running={running} />
            </div>
          </div>
        </div>
      </div>

      <div className={styles.rail}>
        {RIGHT_RAIL.map((r) => <Meter key={r} role={r} level={level(r)} />)}
      </div>
    </div>
  );
}
