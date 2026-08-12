import { useEffect, useRef } from "react";
import { cssVar, withAlpha } from "../../lib/canvasColor";
import { PATTERNS, patternPointAt, type Meter } from "../../lib/teaching/patterns";
import styles from "./ConductingTrace.module.css";

/**
 * 首页的招牌视觉：指挥棒尖端的**长曝光光迹**。
 *
 * 和 `BeatPatternDemo` 用的是同一份轨迹数据（`lib/teaching/patterns.ts`），但两者
 * 的职责相反：那边是教学图解，要标出拍点编号、身体中线、每一段的走向；这里什么
 * 都不标，只留下手走过的那条光。第一次打开软件的人不需要读图，需要的是一眼看出
 * 「这东西和挥手有关」。
 *
 * 为什么是长曝光而不是一个跑动的点：一个点只能说明「有东西在动」，而拖尾把**手势
 * 的形状**留在画面上 —— 那才是这个软件的主题。长曝光拍指挥棒也是这个领域里真实
 * 存在的一种影像。
 */

interface Props {
  /** 循环展示的拍号。默认 4 → 3 → 2，从最常见的开始。 */
  meters?: Meter[];
  bpm?: number;
  /** 每种拍号连打几小节再换下一个。 */
  barsPerMeter?: number;
  height?: number;
}

/** 拖尾保留多少拍。约一小节，正好能看全一个完整的图形。 */
const TRAIL_BEATS = 3.6;
/** 每拍采多少个点。够密才不会在快速段落断成虚线。 */
const SAMPLES_PER_BEAT = 26;

export function ConductingTrace({
  meters = [4, 3, 2],
  bpm = 66,
  barsPerMeter = 2,
  height = 300,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    /* 每帧重取：主题可以随时切，写死在 effect 里抓一次的话，
       切过去之后这块 canvas 会保持上一套主题的颜色直到下次重挂。 */
    const readColors = () => ({
      ink: cssVar("--ink", "#f3eddd"),
      accent: cssVar("--accent", "#7cb2e8"),
      wave: cssVar("--wave-4", "#bcdcf7"),
    });

    // 尊重「减少动态效果」：直接画一个静止的完整四拍图形，不做任何动画。
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    // clientWidth 首帧可能是 0（父容器还没布局完），所以用 ResizeObserver 而不是读一次
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

    // 把**所有**要展示的拍号的轨迹合起来算一个包围盒，用它做坐标映射。
    //
    // 两个原因：一是 patterns.ts 的坐标是有物理含义的（第 1 拍在 y=0.12 的最低处，
    // 二三拍只在身体中线右侧活动），直接按 0..1 铺满画布的话图形会缩在左下角；
    // 二是**必须所有拍号共用一个盒子** —— 各算各的话，四拍切到三拍的瞬间整个
    // 图形会突然缩放一下，像是页面抖了一下。
    const bbox = (() => {
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (const m of meters) {
        for (let b = 0; b < m; b += 0.02) {
          const p = patternPointAt(PATTERNS[m], b);
          if (p.x < x0) x0 = p.x;
          if (p.x > x1) x1 = p.x;
          if (p.y < y0) y0 = p.y;
          if (p.y > y1) y1 = p.y;
        }
      }
      return { x0, y0, w: Math.max(1e-6, x1 - x0), h: Math.max(1e-6, y1 - y0) };
    })();

    // 全局连续拍数。用它同时决定「现在打第几拍」和「现在是哪个拍号」。
    //
    // **从一整条拖尾的长度起步**，不是从 0。从 0 起的话前 3.6 拍里 `head - d`
    // 全是负数、整条拖尾被跳过 —— 页面打开头三秒招牌位置是空的，而这正是
    // 第一次打开软件的人唯一会看的三秒。
    let beats = TRAIL_BEATS;
    let lastTs = 0;

    /** 第 n 拍（全局）属于哪个拍号，以及它在那一小节里的第几拍。 */
    const locate = (globalBeat: number) => {
      let acc = 0;
      const cycle = meters.reduce((s, m) => s + m * barsPerMeter, 0);
      const inCycle = ((globalBeat % cycle) + cycle) % cycle;
      for (const m of meters) {
        const span = m * barsPerMeter;
        if (inCycle < acc + span) return { meter: m, beat: (inCycle - acc) % m };
        acc += span;
      }
      return { meter: meters[0], beat: 0 };
    };

    const draw = (ts: number) => {
      const colors = readColors();
      rafRef.current = requestAnimationFrame(draw);
      if (!w || !h) return;

      const dt = lastTs ? Math.min(ts - lastTs, 100) : 0;
      lastTs = ts;
      if (!reduced) beats += (dt / 1000) * (bpm / 60);

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // 留白要够放下笔尖那圈光晕（半径 22），否则光晕会被画布边缘切掉
      const padX = 30;
      const padY = 30;
      const iw = w - padX * 2;
      const ih = h - padY * 2;
      const px = (x: number) => padX + ((x - bbox.x0) / bbox.w) * iw;
      // patterns.ts 的坐标是「y 向上为正」（指挥自己的视角），canvas 是向下，所以翻一下
      const py = (y: number) => padY + (1 - (y - bbox.y0) / bbox.h) * ih;

      // 关掉动效时停在一个完整的四拍图形上（拖尾恰好画满一圈），不是停在起点
      const head = reduced ? TRAIL_BEATS + 0.399 : beats;
      const step = 1 / SAMPLES_PER_BEAT;

      // 拖尾：从最旧的一段画到最新，越新越亮越粗。
      // 一段一段画而不是一条 path 走到底 —— 单条 path 只能有一个 strokeStyle，
      // 渐隐就没了，而渐隐正是「长曝光」的全部意思。
      let prev: { x: number; y: number } | null = null;
      for (let d = TRAIL_BEATS; d >= 0; d -= step) {
        const at = head - d;
        if (at < 0) {
          prev = null;
          continue;
        }
        const { meter, beat } = locate(at);
        const p = patternPointAt(PATTERNS[meter], beat);
        const pt = { x: px(p.x), y: py(p.y) };
        if (prev) {
          const k = 1 - d / TRAIL_BEATS; // 0 = 最旧，1 = 笔尖
          ctx.strokeStyle = withAlpha(colors.accent, 0.06 + k * k * 0.62);
          ctx.lineWidth = 0.6 + k * k * 2.6;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(pt.x, pt.y);
          ctx.stroke();
        }
        prev = pt;
      }

      // 笔尖：一个亮点加一圈很淡的光晕
      if (prev) {
        const glow = ctx.createRadialGradient(prev.x, prev.y, 0, prev.x, prev.y, 22);
        glow.addColorStop(0, withAlpha(colors.wave, 0.5));
        glow.addColorStop(1, withAlpha(colors.wave, 0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(prev.x, prev.y, 22, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = colors.wave;
        ctx.beginPath();
        ctx.arc(prev.x, prev.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // 唯一的文字：当前是几拍。不写「拍号」二字，一个数字加一条斜杠就够了。
      const { meter } = locate(head);
      ctx.font = `600 12px ${cssVar("--font-mono", "Georgia, serif")}`;
      ctx.fillStyle = withAlpha(colors.ink, 0.34);
      ctx.fillText(`${meter}/4`, padX, h - 10);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [meters, bpm, barsPerMeter]);

  return (
    <canvas
      ref={canvasRef}
      className={styles.canvas}
      style={{ height }}
      role="img"
      aria-label="指挥拍型的动态示意：光点沿标准图形拍型移动，留下渐隐的轨迹"
    />
  );
}
