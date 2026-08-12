import { useEffect, useRef } from "react";
import { canvasFont } from "../../lib/canvasFont";
import { cssVar, withAlpha } from "../../lib/canvasColor";
import type { ProjectScore, ScoreNote, ScorePart } from "../../lib/api";
import styles from "./PianoRoll.module.css";

/**
 * 只读钢琴卷帘：写谱模式下把「这件乐器到底写了什么」摊开给人看。
 *
 * 关键在于**其它声部淡色叠在后面**，而不是只画当前这一件。单看一条声部只能知道
 * 音符长什么样；叠在一起才看得出配合得上配合不上 —— 低音和大提琴撞在同一个音区、
 * 旋律和木管抢同一拍，这些是它真正的用处。所以纵轴的音高范围是**所有声部合起来
 * 算的一个刻度**，各画各的刻度就完全没法比。
 *
 * 打击乐（channel 9）的数字是鼓件编号不是音高，和有音高声部共用一把纵向刻度只是
 * 为了让它们能画在一起；它落在最下面一带，读起来不至于误导。
 */

interface Props {
  score: ProjectScore | null;
  /** 实色显示的那一件；其余淡色。传 null 则全部淡色。 */
  instrumentId: string | null;
  isPlaying?: boolean;
  /** 0..1，和 `Waveform` 同一套写法：内部 rAF 去读，不进 React 状态。 */
  getProgress?: () => number;
  height?: number;
}

/** 音高刻度至少铺这么多个半音，否则单音声部会被拉成一条又粗又假的横杠。 */
const MIN_SPAN = 14;
/** 上下各留出的半音数，免得最高最低那个音贴着边框。 */
const PAD_SEMITONES = 2;

const noteStart = (n: ScoreNote, beatsPerBar: number) =>
  (n[0] - 1) * beatsPerBar + (n[1] - 1);

function pitchBounds(parts: ScorePart[]): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of parts) {
    for (const n of p.notes) {
      if (n[3] < lo) lo = n[3];
      if (n[3] > hi) hi = n[3];
    }
  }
  if (!Number.isFinite(lo)) return { lo: 48, hi: 48 + MIN_SPAN };
  lo -= PAD_SEMITONES;
  hi += PAD_SEMITONES;
  const short = MIN_SPAN - (hi - lo);
  if (short > 0) {
    lo -= Math.floor(short / 2);
    hi += Math.ceil(short / 2);
  }
  return { lo, hi };
}

export function PianoRoll({ score, instrumentId, isPlaying, getProgress, height = 200 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  // 播放头要用最新的取值函数，但换函数不该重启整个绘制副作用
  const progressRef = useRef(getProgress);
  progressRef.current = getProgress;

  useEffect(() => {
    const canvas = canvasRef.current;
    const bp = score?.blueprint;
    if (!canvas || !bp) return;

    /* 每帧重取：主题可以随时切，写死在 effect 里抓一次的话，
       切过去之后这块 canvas 会保持上一套主题的颜色直到下次重挂。 */
    const readColors = () => ({
      ink: cssVar("--ink", "#f3eddd"),
      accent: cssVar("--accent", "#7cb2e8"),
    });

    const parts = score.parts;
    const mine = parts.find((p) => p.instrument_id === instrumentId) ?? null;
    const others = parts.filter((p) => p !== mine);
    const { lo, hi } = pitchBounds(parts);
    const totalBeats = Math.max(1, bp.bars * bp.beats_per_bar);

    // clientWidth 在首帧可能还是 0（父容器尚未布局），所以用 ResizeObserver 而不是读一次
    let w = 0;
    let h = 0;
    const ro = new ResizeObserver(() => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      draw();
    });
    ro.observe(canvas);

    function draw() {
      const colors = readColors();
      const ctx = canvas?.getContext("2d");
      if (!ctx || !canvas || !bp || !w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const padL = 8;
      const padR = 8;
      const padTop = 16; // 段落名
      const padBottom = 16; // 小节号
      const iw = w - padL - padR;
      const ih = h - padTop - padBottom;
      const bx = (beat: number) => padL + (Math.min(Math.max(beat, 0), totalBeats) / totalBeats) * iw;
      const rowH = ih / (hi - lo + 1);
      const by = (pitch: number) => padTop + (hi - pitch) * rowH;

      // 八度参考线：每个 C 一条。没有它，卷帘上一堆方块看不出音区
      ctx.lineWidth = 1;
      for (let p = Math.ceil(lo / 12) * 12; p <= hi; p += 12) {
        ctx.strokeStyle = withAlpha(colors.ink, 0.07);
        ctx.beginPath();
        ctx.moveTo(padL, by(p) + rowH);
        ctx.lineTo(w - padR, by(p) + rowH);
        ctx.stroke();
      }

      // 段落：交替底色 + 名字。分隔线比小节线重，一眼能看出结构在哪里换
      ctx.font = canvasFont(10);
      bp.sections.forEach((s, i) => {
        const x0 = bx((s.start_bar - 1) * bp.beats_per_bar);
        const x1 = bx(s.end_bar * bp.beats_per_bar);
        if (i % 2 === 1) {
          ctx.fillStyle = withAlpha(colors.ink, 0.035);
          ctx.fillRect(x0, padTop, x1 - x0, ih);
        }
        if (i > 0) {
          ctx.strokeStyle = withAlpha(colors.ink, 0.22);
          ctx.beginPath();
          ctx.moveTo(x0, padTop - 4);
          ctx.lineTo(x0, h - padBottom);
          ctx.stroke();
        }
        ctx.fillStyle = withAlpha(colors.ink, 0.4);
        ctx.fillText(s.label, x0 + 4, padTop - 5);
      });

      // 小节线 + 小节号。小节多了就隔几根标一个号，否则数字会糊成一条
      const step = bp.bars > 24 ? 4 : bp.bars > 12 ? 2 : 1;
      for (let bar = 1; bar <= bp.bars; bar += 1) {
        const x = bx((bar - 1) * bp.beats_per_bar);
        ctx.strokeStyle = withAlpha(colors.ink, 0.1);
        ctx.beginPath();
        ctx.moveTo(x, padTop);
        ctx.lineTo(x, h - padBottom);
        ctx.stroke();
        if ((bar - 1) % step === 0) {
          ctx.fillStyle = withAlpha(colors.ink, 0.32);
          ctx.fillText(String(bar), x + 3, h - 5);
        }
      }

      const drawNotes = (part: ScorePart, fill: (vel: number) => string) => {
        for (const n of part.notes) {
          const x0 = bx(noteStart(n, bp.beats_per_bar));
          const x1 = bx(noteStart(n, bp.beats_per_bar) + Math.max(n[2], 0.125));
          const y = by(n[3]);
          ctx.fillStyle = fill(n[4]);
          // 至少 2px 宽高，否则密集的十六分音符和打击乐会整段消失
          ctx.fillRect(x0, y + 0.5, Math.max(2, x1 - x0 - 1), Math.max(2, rowH - 1));
        }
      };

      // 先画别人再画自己，当前声部才压得住
      for (const p of others) {
        drawNotes(p, () => withAlpha(colors.ink, 0.17));
      }
      if (mine) {
        // 力度映射到不透明度：卷帘上也能看出强弱，不用另开一栏
        drawNotes(mine, (vel) => withAlpha(colors.accent, 0.45 + (Math.min(vel, 127) / 127) * 0.5));
      }

      const progress = progressRef.current?.() ?? 0;
      if (progress > 0) {
        const x = padL + Math.min(Math.max(progress, 0), 1) * iw;
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, padTop);
        ctx.lineTo(x, h - padBottom);
        ctx.stroke();
      }

      if (isPlaying) rafRef.current = requestAnimationFrame(draw);
    }

    draw();
    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [score, instrumentId, isPlaying]);

  if (!score?.blueprint) {
    return <div className={styles.empty}>生成第一件乐器后，这里会显示谱面。</div>;
  }

  return (
    <div className={styles.wrap} style={{ height }}>
      <canvas ref={canvasRef} className={styles.canvas} />
    </div>
  );
}
