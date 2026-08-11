import { useEffect, useRef } from "react";
import styles from "./Waveform.module.css";

export type WaveformState = "empty" | "pending" | "ready";

interface WaveformProps {
  peaks: Float32Array | null;
  state: WaveformState;
  height?: number;
  accent?: string;
  isPlaying?: boolean;
  getProgress?: () => number;
  onClick?: () => void;
}

/**
 * 签名视觉元素：浅蓝色波形 + 带"指挥棒尖端"光点的播放头。
 * empty=虚线基线，pending=呼吸动画，ready=真实峰值。
 */
export function Waveform({ peaks, state, height = 72, accent, isPlaying, getProgress, onClick }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>();
  const pulseRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const accentColor = accent || getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7cb2e8";

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const mid = h / 2;

      if (state === "empty") {
        ctx.strokeStyle = "rgba(243,237,221,0.16)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(w, mid);
        ctx.stroke();
        ctx.setLineDash([]);
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      if (state === "pending" || !peaks) {
        pulseRef.current += 0.045;
        const bars = 48;
        const gap = w / bars;
        for (let i = 0; i < bars; i++) {
          const phase = pulseRef.current + i * 0.35;
          const amp = (Math.sin(phase) * 0.5 + 0.5) * 0.55 + 0.08;
          const barH = amp * h * 0.6;
          ctx.fillStyle = `rgba(124,178,232,${0.18 + amp * 0.22})`;
          ctx.fillRect(i * gap, mid - barH / 2, Math.max(1.5, gap - 2), barH);
        }
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      // ready：真实峰值
      const progress = getProgress ? getProgress() : 0;
      const n = peaks.length;
      const gap = w / n;
      for (let i = 0; i < n; i++) {
        const amp = Math.max(0.03, peaks[i]);
        const barH = amp * h * 0.86;
        const played = i / n < progress;
        ctx.fillStyle = played ? accentColor : "rgba(243,237,221,0.22)";
        ctx.fillRect(i * gap, mid - barH / 2, Math.max(1, gap - 1), barH);
      }

      // 播放头 + "指挥棒尖端"光点
      const x = progress * w;
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 2);
      ctx.lineTo(x, h - 2);
      ctx.stroke();

      ctx.shadowColor = accentColor;
      ctx.shadowBlur = isPlaying ? 8 : 0;
      ctx.fillStyle = accentColor;
      ctx.beginPath();
      ctx.arc(x, 4, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (isPlaying) rafRef.current = requestAnimationFrame(draw);
    };

    draw();

    /**
     * 尺寸变了要重画。**首帧宽度可能是 0**（父容器还没布局完，或者所在的页面
     * 刚切过来），那一次画出来的 canvas 后备位图就只有 1px 宽，再被 CSS 拉成
     * 几百像素 —— 屏幕上是一整片糊掉的色块。而 draw 只在依赖变化时跑，没有别的
     * 时机会把它救回来，于是这个波形就一直是坏的。BeatPatternDemo 早就踩过同一个坑。
     */
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peaks, state, isPlaying, accent]);

  return (
    <div
      className={`${styles.wrap} ${onClick ? styles.clickable : ""}`}
      style={{ height }}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      <canvas ref={canvasRef} className={styles.canvas} />
    </div>
  );
}
