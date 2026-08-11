import { useEffect, useRef } from "react";
import { canvasFont } from "../../lib/canvasFont";
import { PATTERNS, patternPointAt, samplePattern, type Meter } from "../../lib/teaching/patterns";
import styles from "./BeatPatternDemo.module.css";

/**
 * 图形拍型示范：画出标准轨迹，一个光点按 BPM 沿着它走，每到拍点闪一下。
 *
 * 静态的拍型图（教材里那种箭头图）说不清最要紧的两件事：拍点在时间上落在哪一刻，
 * 以及拍与拍之间是加速再减速的。这两件事只有动起来才看得见，所以示范必须是动画。
 *
 * 轨迹数据来自 lib/teaching/patterns.ts —— 和之后跟练时的参考叠加、评分时的 DTW
 * 模板是同一份，示范给你看的就是评分照着比的。
 */

interface Props {
  meter: Meter;
  bpm: number;
  playing: boolean;
  /** 数拍回调，给上层显示「现在第几拍」。 */
  onBeat?: (beat: number) => void;
  height?: number;
  /**
   * 外部驱动的当前拍（0 起）。给了就以它为准，不给就自己按 BPM 走。
   *
   * 跟练时的小窗要用这个：示范自己那套时钟和用户真正在跟的那条音轨是两个独立的
   * 时间源，各走各的，几十秒下来必然错开 —— 小窗那时指的就是**另一拍**了，
   * 而它存在的全部意义就是告诉人现在该打哪一拍。传 `null` 表示还没开始（数拍中）。
   */
  beat?: number | null;
  /** 小窗模式：去掉走向文字与箭头，缩小留白和标记，只留「图形 + 第几拍」。 */
  compact?: boolean;
}

/** 拍点闪光的持续时间。比 CameraPreview 的 160ms 长一点，示范要看得清。 */
const FLASH_MS = 220;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * canvas 里不用 `color-mix()`：它是 CSS 的颜色函数，canvas 的颜色解析对它的支持
 * 各家不一，而解析失败时 `fillStyle` 是**静默保留上一个值**的 —— 会变成一个
 * 「某些浏览器上颜色全错」且完全没有报错的 bug。自己按 token 的十六进制算 rgba。
 */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function BeatPatternDemo({
  meter, bpm, playing, onBeat, height = 300, beat: extBeat, compact = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  /** 小节内的连续拍数（可为小数）。暂停时保留，继续播放从原处走。 */
  const beatRef = useRef(0);
  const lastTsRef = useRef(0);
  const lastBeatIndexRef = useRef(-1);
  const flashAtRef = useRef(-Infinity);
  const onBeatRef = useRef(onBeat);
  onBeatRef.current = onBeat;
  // 外部拍号每 100ms 变一次，进依赖数组就是每 100ms 重建一次 rAF 循环
  const extBeatRef = useRef(extBeat);
  extBeatRef.current = extBeat;
  /** 上一次已经对过的外部拍。用来只在**变化时**校准，中间照常自己往前走。 */
  const syncedRef = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    // 换拍号时从第 1 拍重新开始，否则会从上一个拍号的半途接上，看着莫名其妙
    beatRef.current = 0;
    lastBeatIndexRef.current = -1;
  }, [meter]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const colors = {
      ink: cssVar("--ink", "#f3eddd"),
      accent: cssVar("--accent", "#7cb2e8"),
      bg: cssVar("--bg", "#15130f"),
    };

    const pattern = PATTERNS[meter];
    const path = samplePattern(pattern, 40);
    // 拍点编号往「远离图形重心」的方向让开。拍点逐拍升高之后，四拍的第 2→3 拍
    // 横扫会从第 4 拍落下的那一笔上穿过去，编号固定标在点正下方就会压在线上。
    const centroid = {
      x: pattern.ictus.reduce((s, p) => s + p.x, 0) / pattern.ictus.length,
      y: pattern.ictus.reduce((s, p) => s + p.y, 0) / pattern.ictus.length,
    };

    // clientWidth 在首帧可能还是 0（父容器尚未布局），所以用 ResizeObserver 而不是读一次
    let w = 0;
    let h = 0;
    const ro = new ResizeObserver(() => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
    });
    ro.observe(canvas);

    const draw = (ts: number) => {
      rafRef.current = requestAnimationFrame(draw);
      if (!w || !h) return;

      const dt = lastTsRef.current ? Math.min(ts - lastTsRef.current, 100) : 0;
      lastTsRef.current = ts;
      const ext = extBeatRef.current;
      if (ext !== undefined) {
        // 外部驱动。校准只在拍号变的那一刻做，两次校准之间照常按 BPM 往前走 ——
        // 上游的心跳是 100ms 一次，直接照它跳的话光点是一格一格挪的。
        if (ext !== syncedRef.current) {
          syncedRef.current = ext;
          if (ext !== null) {
            beatRef.current = ((ext % meter) + meter) % meter;
            lastBeatIndexRef.current = Math.floor(beatRef.current);
            flashAtRef.current = ts;
          } else {
            beatRef.current = 0;
            lastBeatIndexRef.current = -1;
          }
        }
        if (ext !== null) {
          // 不许跑过这一拍的末尾：校准最晚会迟到一个心跳，跑过头就得往回跳，
          // 而往回跳比在弧线尾巴上多停 100ms 显眼得多
          const limit = Math.floor(beatRef.current) + 0.97;
          beatRef.current = Math.min(beatRef.current + (dt / 1000) * (bpm / 60), limit);
        }
      } else if (playing) {
        beatRef.current = (beatRef.current + (dt / 1000) * (bpm / 60)) % meter;
        const idx = Math.floor(beatRef.current);
        if (idx !== lastBeatIndexRef.current) {
          lastBeatIndexRef.current = idx;
          flashAtRef.current = ts;
          onBeatRef.current?.(idx + 1);
        }
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // 上下留白不对称：顶部要放反弹顶点，底部要放拍点编号。
      // 小窗里没有走向文字要摆，留白只需要够编号不被裁掉
      const padX = compact ? 24 : 46;
      const padTop = compact ? 12 : 22;
      const padBottom = compact ? 18 : 34;
      const iw = w - padX * 2;
      const ih = h - padTop - padBottom;
      const px = (x: number) => padX + x * iw;
      const py = (y: number) => padTop + (1 - y) * ih;

      // 这里**不画**「拍点平面」那条横线：图式的拍点是逐拍升高的（见 patterns.ts
      // 文件头），一条横线只穿得过第 1 拍，标上「拍点平面」四个字反而是在教错。
      // 平面是**手**该守的，不是图该守的，那件事由课程文字和「平面一致性」评分讲。

      // 身体中线。二拍与三拍只在中线右侧活动，四拍才跨到左边 —— 不画这条线的话，
      // 三拍图看起来像是「整个挤到右边去了」的排版事故，其实那正是它该在的位置。
      ctx.strokeStyle = withAlpha(colors.ink, 0.1);
      ctx.setLineDash([2, 7]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px(0.5), padTop);
      ctx.lineTo(px(0.5), h - padBottom);
      ctx.stroke();
      ctx.setLineDash([]);
      if (!compact) {
        ctx.font = canvasFont(10);
        ctx.fillStyle = withAlpha(colors.ink, 0.3);
        const midLabel = "身体中线";
        ctx.fillText(midLabel, px(0.5) - ctx.measureText(midLabel).width / 2, padTop - 6);
      }

      // 标准轨迹
      const isOneBeat = meter === 1;
      ctx.strokeStyle = isOneBeat ? withAlpha(colors.ink, 0.55) : withAlpha(colors.accent, 0.42);
      ctx.lineWidth = isOneBeat ? 2.0 : 1.6;
      if (isOneBeat) {
        ctx.shadowColor = withAlpha(colors.ink, 0.35);
        ctx.shadowBlur = 6;
      }
      ctx.beginPath();
      path.forEach((p, i) => (i ? ctx.lineTo(px(p.x), py(p.y)) : ctx.moveTo(px(p.x), py(p.y))));
      ctx.stroke();
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;

      // 行进方向箭头 + 该段的走向说法 —— 1 拍跳过（两段式轨迹的箭头位置需要
      // 单独算，且动画方向已经够清楚，不标比标错好）
      if (!isOneBeat && !compact) {
        pattern.strokes.forEach((word, i) => {
          const a = patternPointAt(pattern, i + 0.42);
          const b = patternPointAt(pattern, i + 0.58);
          const ang = Math.atan2(py(b.y) - py(a.y), px(b.x) - px(a.x));
          const mx = px((a.x + b.x) / 2);
          const my = py((a.y + b.y) / 2);
          ctx.strokeStyle = withAlpha(colors.accent, 0.7);
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(mx - Math.cos(ang - 0.5) * 7, my - Math.sin(ang - 0.5) * 7);
          ctx.lineTo(mx, my);
          ctx.lineTo(mx - Math.cos(ang + 0.5) * 7, my - Math.sin(ang + 0.5) * 7);
          ctx.stroke();

          // 走向文字沿着这一段的**法线**往图形外侧让开，不是固定往上挪。
          // 四拍的第 2→3 拍横扫和第 4 拍落下的那一笔在中间交叉，两段的中点几乎
          // 重合，固定往上挪会让「向右」和「上提·预备」叠印成一团。
          ctx.font = canvasFont(10);
          ctx.fillStyle = withAlpha(colors.ink, 0.42);
          const tw = ctx.measureText(word).width;
          let nx = -Math.sin(ang);
          let ny = Math.cos(ang);
          if (nx * (mx - px(centroid.x)) + ny * (my - py(centroid.y)) < 0) {
            nx = -nx;
            ny = -ny;
          }
          // 法线接近水平时只挪 14px 仍会有半个词压在线上，按横向分量补上半个词宽
          const off = 14 + (tw / 2) * Math.abs(nx);
          ctx.fillText(word, mx + nx * off - tw / 2, my + ny * off + 4);
        });
      }

      // 拍点标记
      pattern.ictus.forEach((p, i) => {
        const cx = px(p.x);
        const cy = py(p.y);
        const isCurrent = Math.floor(beatRef.current) === i;
        ctx.beginPath();
        ctx.arc(cx, cy, compact ? 4 : 5.5, 0, Math.PI * 2);
        ctx.fillStyle = isCurrent ? colors.accent : colors.bg;
        ctx.fill();
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 1.6;
        ctx.stroke();

        const label = isOneBeat ? (compact ? "1" : "拍点") : String(i + 1);
        ctx.font = canvasFont(compact ? 10 : 12, isCurrent ? 600 : 400);
        ctx.fillStyle = isCurrent ? colors.accent : withAlpha(colors.ink, 0.52);
        const tw = ctx.measureText(label).width;
        // 从重心指向该拍点的方向，再往外挪 —— 编号就永远落在图形外侧
        const dx = cx - px(centroid.x);
        const dy = cy - py(centroid.y);
        const len = Math.hypot(dx, dy) || 1;
        const lx = cx + (dx / len) * (compact ? 12 : 18);
        const ly = cy + (dy / len) * (compact ? 12 : 18);
        ctx.fillText(label, lx - tw / 2, ly + 4);
      });

      // 拍点闪光
      const since = ts - flashAtRef.current;
      if (since < FLASH_MS) {
        const i = Math.floor(beatRef.current);
        const p = pattern.ictus[i] ?? pattern.ictus[0];
        const k = since / FLASH_MS;
        ctx.strokeStyle = withAlpha(colors.accent, (1 - k) * 0.8);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px(p.x), py(p.y), (compact ? 4 : 6) + k * (compact ? 13 : 20), 0, Math.PI * 2);
        ctx.stroke();
      }

      // 手的位置，带一小段尾迹表示速度：尾迹长就是走得快
      const TAIL = 14;
      for (let i = TAIL; i > 0; i -= 1) {
        const p = patternPointAt(pattern, beatRef.current - i * 0.02);
        ctx.beginPath();
        ctx.arc(px(p.x), py(p.y), compact ? 1.7 : 2.2, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(colors.accent, (1 - i / TAIL) * 0.45);
        ctx.fill();
      }
      const now = patternPointAt(pattern, beatRef.current);
      ctx.beginPath();
      ctx.arc(px(now.x), py(now.y), compact ? 5 : 7, 0, Math.PI * 2);
      ctx.fillStyle = colors.ink;
      ctx.fill();
    };
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      lastTsRef.current = 0;
      ro.disconnect();
    };
  }, [meter, bpm, playing, compact]);

  return (
    <canvas
      ref={canvasRef}
      className={`${styles.canvas} ${compact ? styles.canvasCompact : ""}`}
      style={{ height }}
    />
  );
}
