import { useEffect, useRef } from "react";
import { canvasFont } from "../../lib/canvasFont";
import { cssVar, withAlpha } from "../../lib/canvasColor";
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
}

/** 拍点闪光的持续时间。比 CameraPreview 的 160ms 长一点，示范要看得清。 */
const FLASH_MS = 220;

export function BeatPatternDemo({ meter, bpm, playing, onBeat, height = 300 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  /** 小节内的连续拍数（可为小数）。暂停时保留，继续播放从原处走。 */
  const beatRef = useRef(0);
  const lastTsRef = useRef(0);
  const lastBeatIndexRef = useRef(-1);
  const flashAtRef = useRef(-Infinity);
  const onBeatRef = useRef(onBeat);
  onBeatRef.current = onBeat;

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
      if (playing) {
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

      // 四周留白：编号沿图形向外让 18px，四边都得留得下
      const padX = 46;
      const padTop = 26;
      const padBottom = 34;
      const iw = w - padX * 2;
      const ih = h - padTop - padBottom;
      const px = (x: number) => padX + x * iw;
      const py = (y: number) => padTop + (1 - y) * ih;

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
      ctx.font = canvasFont(10);
      ctx.fillStyle = withAlpha(colors.ink, 0.3);
      const midLabel = "身体中线";
      ctx.fillText(midLabel, px(0.5) - ctx.measureText(midLabel).width / 2, padTop - 9);

      // 标准轨迹
      ctx.strokeStyle = withAlpha(colors.accent, 0.42);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      path.forEach((p, i) => (i ? ctx.lineTo(px(p.x), py(p.y)) : ctx.moveTo(px(p.x), py(p.y))));
      ctx.stroke();

      // 图形中心，用来把文字一律往外侧甩开。四拍的「第 2→3 拍长扫」正好和
      // 「落下」那一笔交叉，两段的中点几乎重合 —— 都按老写法压在箭头正上方的话，
      // 两个词会叠成一团。
      const cxs = pattern.ictus.map((p) => px(p.x));
      const cys = pattern.ictus.map((p) => py(p.y));
      const gx = cxs.reduce((s, v) => s + v, 0) / cxs.length;
      const gy = cys.reduce((s, v) => s + v, 0) / cys.length;

      // 行进方向箭头 + 该段的走向说法，放在两个拍点之间 —— 走向属于「段」不属于「点」。
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

        // 沿该段的**法线**让开，取背离图形中心的那一侧：文字不会压在自己这条线上，
        // 交叉的两段也会被推向相反方向
        let nx = -Math.sin(ang);
        let ny = Math.cos(ang);
        if (nx * (mx - gx) + ny * (my - gy) < 0) {
          nx = -nx;
          ny = -ny;
        }

        ctx.font = canvasFont(10);
        ctx.fillStyle = withAlpha(colors.ink, 0.42);
        // 再按法线的水平分量让开半个词宽：只挪中心的话，法线接近水平时文字仍有
        // 一半压在线上（三拍的「落下·预备」就是这样被那条竖笔穿过去的）
        const tw = ctx.measureText(word).width;
        ctx.fillText(word, mx + nx * (14 + tw / 2) - tw / 2, my + ny * 14 + 3);
      });

      // 拍点标记：圆点 + 序号。
      //
      // 序号一律沿图形中心向外让开，不能像以前那样统一放正下方 —— 拍点现在
      // 逐拍升高，正下方常常正好压在轨迹上（四拍的第 2、3 拍尤其明显）。
      pattern.ictus.forEach((_, i) => {
        const cx = cxs[i];
        const cy = cys[i];
        const isCurrent = Math.floor(beatRef.current) === i;
        ctx.beginPath();
        ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = isCurrent ? colors.accent : colors.bg;
        ctx.fill();
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 1.6;
        ctx.stroke();

        const len = Math.hypot(cx - gx, cy - gy) || 1;
        const ox = ((cx - gx) / len) * 18;
        const oy = ((cy - gy) / len) * 18;

        const label = String(i + 1);
        ctx.font = canvasFont(12, isCurrent ? 600 : 400);
        ctx.fillStyle = isCurrent ? colors.accent : withAlpha(colors.ink, 0.52);
        const tw = ctx.measureText(label).width;
        ctx.fillText(label, cx + ox - tw / 2, cy + oy + 4);
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
        ctx.arc(px(p.x), py(p.y), 6 + k * 20, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 手的位置，带一小段尾迹表示速度：尾迹长就是走得快
      const TAIL = 14;
      for (let i = TAIL; i > 0; i -= 1) {
        const p = patternPointAt(pattern, beatRef.current - i * 0.02);
        ctx.beginPath();
        ctx.arc(px(p.x), py(p.y), 2.2, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(colors.accent, (1 - i / TAIL) * 0.45);
        ctx.fill();
      }
      const now = patternPointAt(pattern, beatRef.current);
      ctx.beginPath();
      ctx.arc(px(now.x), py(now.y), 7, 0, Math.PI * 2);
      ctx.fillStyle = colors.ink;
      ctx.fill();
    };
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      lastTsRef.current = 0;
      ro.disconnect();
    };
  }, [meter, bpm, playing]);

  return <canvas ref={canvasRef} className={styles.canvas} style={{ height }} />;
}
