import { useEffect, useRef } from "react";
import type { CameraIntentSource } from "../../lib/camera/cameraIntentSource";
import styles from "./CameraPreview.module.css";
import { canvasFont } from "../../lib/canvasFont";

/**
 * 摄像头指挥的实时预览：画面 + 双手标记 + 拍点闪烁。
 *
 * 指挥时看不到自己的手在哪就没法用 —— 尤其是横向的席位分区（左主旋律／中和声／
 * 右低音），没有可视参照根本对不准。所以这里除了画面本身，还画出三个分区的参考线。
 *
 * 画面做水平镜像（CSS scaleX(-1)）：人对着摄像头时，镜像画面才符合直觉 —— 抬左手
 * 画面里的手也在左边。ConductingModel 的 mirrored 选项要与此保持一致。
 */

const ZONES = [
  { center: 0.16, label: "主旋律" },
  { center: 0.5, label: "和声" },
  { center: 0.84, label: "低音" },
];

interface Props {
  source: CameraIntentSource | null;
  /** 打拍手与表情手是否互换，只影响标记的文字。 */
  swapHands: boolean;
  height?: number;
  /** 摄像头没开时显示什么。默认是「输出」页的说法，考试页那边的按钮叫别的名字。 */
  placeholder?: string;
}

export function CameraPreview({
  source,
  swapHands,
  height = 260,
  placeholder = "点「开始指挥」后打开摄像头",
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !source) return;

    const video = source.tracker.videoElement;
    if (video) {
      video.className = styles.video;
      wrap.appendChild(video);
    }

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== w * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // 席位分区参考线（画面已镜像，所以直接用指挥自己的左右）
      ctx.font = canvasFont(11);
      ZONES.forEach((z) => {
        const x = z.center * w;
        ctx.strokeStyle = "rgba(243,237,221,0.14)";
        ctx.setLineDash([4, 5]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(243,237,221,0.4)";
        const tw = ctx.measureText(z.label).width;
        ctx.fillText(z.label, x - tw / 2, h - 8);
      });

      const frame = source.lastFrame;
      if (!frame) return;
      const beatHand = swapHands ? frame.left : frame.right;
      const exprHand = swapHands ? frame.right : frame.left;

      const dot = (p: { x: number; y: number } | null, color: string, label: string) => {
        if (!p) return;
        // 画面镜像了，标记也要镜像才对得上
        const x = (1 - p.x) * w;
        const y = p.y * h;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(21,19,15,0.9)";
        ctx.font = canvasFont(10);
        const tw = ctx.measureText(label).width;
        ctx.fillText(label, x - tw / 2, y + 3.5);
      };

      // 拍点闪一下，给使用者一个明确的「刚才那下算数了」的反馈
      const sinceIctus = performance.now() - source.model.lastIctusAt;
      if (sinceIctus < 160) {
        ctx.strokeStyle = `rgba(124,178,232,${1 - sinceIctus / 160})`;
        ctx.lineWidth = 3;
        ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
      }

      dot(beatHand, "#7cb2e8", "拍");
      dot(exprHand && exprHand !== beatHand ? exprHand : null, "#6fd6c4", "表情");
    };
    draw();

    return () => {
      cancelAnimationFrame(rafRef.current);
      if (video && video.parentElement === wrap) wrap.removeChild(video);
    };
  }, [source, swapHands]);

  return (
    <div className={styles.wrap} ref={wrapRef} style={{ height }}>
      <canvas ref={canvasRef} className={styles.overlay} />
      {!source && <div className={styles.placeholder}>{placeholder}</div>}
    </div>
  );
}
