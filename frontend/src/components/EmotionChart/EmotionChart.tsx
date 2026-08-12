import { useEffect, useRef, useState } from "react";
import type { FormationSection } from "../../lib/api";
import { emotionBars, sectionStarts, sectionsSpan } from "../../lib/formation";
import styles from "./EmotionChart.module.css";
import { canvasFont } from "../../lib/canvasFont";

/**
 * 乐曲情绪柱状图：横轴时间、纵轴情绪强度。高潮时间的高、一般时间的低。
 *
 * 交互上有一处关键取舍：**拖一根柱子等于调整它所属段落的强度，整段联动**，
 * 段内保持 shape 的形状不变、只平移平台值。
 *
 * 不做「自由拖曲线、段落从曲线反推」：峰值检测不稳定，拖一根柱子可能让段落边界整体
 * 跳动；更要命的是下游（提示词、参与度、出声时间段）全都依赖 sections，曲线一旦成为
 * 第二真源，一致性就守不住了。段落边界的调整是另一个手势（底部把手）。
 *
 * 拖动**不反向改编配** —— 用户把某段拉高了，系统不会自动往里加乐器。那种「我只是想
 * 看看」却被改掉编配的行为最招人烦。取而代之的是段落上方浮出一个「按新强度重编这一段」
 * 按钮，点了才走局部重问，主动权在用户手里。
 */

interface Props {
  sections: FormationSection[];
  bpm: number;
  timeSignature: string;
  /** 拖动柱子改段落强度 */
  onIntensityChange?: (sectionIndex: number, intensity: number) => void;
  /** 拖动底部把手改段落边界（秒） */
  onBoundaryChange?: (boundaryIndex: number, seconds: number) => void;
  selectedSection?: number | null;
  onSelectSection?: (index: number | null) => void;
  height?: number;
}

const PAD_L = 34;
const PAD_R = 12;
const PAD_T = 14;
const HANDLE_H = 22;

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

export function EmotionChart({
  sections, bpm, timeSignature,
  onIntensityChange, onBoundaryChange,
  selectedSection, onSelectSection, height = 220,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const dragRef = useRef<{ kind: "bar" | "boundary"; index: number } | null>(null);

  const total = sectionsSpan(sections);
  const bars = emotionBars(sections, bpm, timeSignature);
  const starts = sectionStarts(sections);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 用 ResizeObserver 而不是量一次：首次 effect 时容器宽度可能还是 0。
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    draw();
    return () => ro.disconnect();

    function draw() {
      if (!canvas || total <= 0) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const plotW = w - PAD_L - PAD_R;
      const plotH = h - PAD_T - HANDLE_H;
      const x = (t: number) => PAD_L + (t / total) * plotW;
      const y = (v: number) => PAD_T + plotH - v * plotH;

      const css = getComputedStyle(canvas);
      const grid = css.getPropertyValue("--chart-grid").trim() || "#e3e8f0";
      const label = css.getPropertyValue("--chart-label").trim() || "#9aa6b8";
      const barColor = css.getPropertyValue("--chart-bar").trim() || "#8fb4f2";
      const climaxColor = css.getPropertyValue("--chart-climax").trim() || "#2f6fed";
      const selColor = css.getPropertyValue("--chart-selected").trim() || "#18a999";

      // 纵轴刻度
      ctx.strokeStyle = grid;
      ctx.fillStyle = label;
      ctx.lineWidth = 1;
      ctx.font = canvasFont(10);
      for (const v of [0, 0.5, 1]) {
        ctx.beginPath();
        ctx.moveTo(PAD_L, y(v));
        ctx.lineTo(w - PAD_R, y(v));
        ctx.stroke();
        ctx.fillText(v.toFixed(1), 6, y(v) + 3);
      }

      // 高潮区间底色
      sections.forEach((s, i) => {
        if (!s.is_climax) return;
        ctx.fillStyle = climaxColor + "1a";
        ctx.fillRect(x(starts[i]), PAD_T, (s.duration / total) * plotW, plotH);
      });

      // 柱子
      const barW = bars.length ? Math.max(2, (plotW / bars.length) * 0.78) : 2;
      bars.forEach((b) => {
        const isSel = selectedSection === b.sectionIndex;
        const isHover = hover === b.sectionIndex;
        ctx.fillStyle = isSel ? selColor : b.isClimax ? climaxColor : barColor;
        ctx.globalAlpha = isHover && !isSel ? 0.75 : 1;
        const bh = Math.max(1.5, b.value * plotH);
        ctx.fillRect(x(b.t) - barW / 2, PAD_T + plotH - bh, barW, bh);
        ctx.globalAlpha = 1;
      });

      // 段落边界 + 名称
      ctx.strokeStyle = grid;
      ctx.setLineDash([3, 3]);
      sections.forEach((s, i) => {
        if (i === 0) return;
        ctx.beginPath();
        ctx.moveTo(x(starts[i]), PAD_T);
        ctx.lineTo(x(starts[i]), PAD_T + plotH);
        ctx.stroke();
      });
      ctx.setLineDash([]);

      ctx.font = canvasFont(11);
      sections.forEach((s, i) => {
        const cx = x(starts[i] + s.duration / 2);
        const tw = ctx.measureText(s.label).width;
        if (tw < (s.duration / total) * plotW - 4) {
          ctx.fillStyle = selectedSection === i ? selColor : label;
          ctx.fillText(s.label, cx - tw / 2, h - 8);
        }
      });

      // 段落边界把手
      sections.forEach((s, i) => {
        if (i === 0) return;
        ctx.fillStyle = grid;
        ctx.fillRect(x(starts[i]) - 3, PAD_T + plotH + 3, 6, 10);
      });

      // 时间刻度
      ctx.fillStyle = label;
      ctx.font = canvasFont(10);
      ctx.fillText("0s", PAD_L, PAD_T - 4);
      const tt = fmtTime(total);
      ctx.fillText(tt, w - PAD_R - ctx.measureText(tt).width, PAD_T - 4);
    }
  }, [sections, bars, starts, total, hover, selectedSection]);

  const pointerToTime = (e: React.PointerEvent): number => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const plotW = rect.width - PAD_L - PAD_R;
    return ((e.clientX - rect.left - PAD_L) / plotW) * total;
  };

  const sectionAt = (t: number): number => {
    for (let i = 0; i < sections.length; i++) {
      if (t >= starts[i] && t < starts[i] + sections[i].duration) return i;
    }
    return sections.length - 1;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (total <= 0) return;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const localY = e.clientY - rect.top;
    const t = pointerToTime(e);
    const plotW = rect.width - PAD_L - PAD_R;

    // 底部把手区：拖段落边界
    if (localY > rect.height - HANDLE_H) {
      let nearest = -1;
      let best = Infinity;
      for (let i = 1; i < sections.length; i++) {
        const px = (starts[i] / total) * plotW + PAD_L;
        const d = Math.abs(px - (e.clientX - rect.left));
        if (d < best && d < 12) { best = d; nearest = i; }
      }
      if (nearest > 0) {
        dragRef.current = { kind: "boundary", index: nearest };
        canvas.setPointerCapture(e.pointerId);
      }
      return;
    }

    const idx = sectionAt(t);
    onSelectSection?.(idx);
    dragRef.current = { kind: "bar", index: idx };
    canvas.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas || total <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const drag = dragRef.current;

    if (!drag) {
      const t = pointerToTime(e);
      setHover(t >= 0 && t <= total ? sectionAt(t) : null);
      return;
    }
    if (drag.kind === "bar") {
      const plotH = rect.height - PAD_T - HANDLE_H;
      const v = 1 - (e.clientY - rect.top - PAD_T) / plotH;
      onIntensityChange?.(drag.index, Math.max(0, Math.min(1, v)));
    } else {
      onBoundaryChange?.(drag.index, Math.max(0, Math.min(total, pointerToTime(e))));
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    dragRef.current = null;
    canvasRef.current?.releasePointerCapture(e.pointerId);
  };

  if (total <= 0) {
    return <div className={styles.empty}>还没有段落结构。选一个模版，或者让 AI 生成构型。</div>;
  }

  return (
    <div className={styles.wrap}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        style={{ height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHover(null)}
      />
      <p className={styles.hint}>
        上下拖柱子调整整段的情绪强度；拖底部的把手移动段落边界。
      </p>
    </div>
  );
}
