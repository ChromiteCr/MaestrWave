import { useEffect, useRef } from "react";
import type { CameraIntentSource } from "../../lib/camera/cameraIntentSource";
import { cssVar, withAlpha } from "../../lib/canvasColor";
import styles from "./CameraPreview.module.css";
import { canvasFont } from "../../lib/canvasFont";

/**
 * 摄像头指挥的实时预览：画面 + 手的光迹 + 拍点水波纹。
 *
 * ## 为什么要画这一层
 *
 * 手的识别本身已经很准了，但用户是**蒙的** —— 画面里只有自己，看不出软件到底认
 * 没认到手、认的是哪只、刚才那一下算不算一拍。三件事一层解决：
 *
 * - **光迹**：手走过的路留一小段渐隐的尾巴。一个点只能说明「有东西在动」，
 *   尾巴才把**手势的形状**留在画面上 —— 而这正是用户要练的东西。视觉语言和
 *   首页的 `ConductingTrace` 一致（长曝光的指挥棒尖），两处是同一件事的两种场合。
 * - **拍点闪一下**：确认一拍的瞬间光点变亮变大，回答「刚才那下算数了吗」。
 * - **水波纹**：从拍点位置扩散出去的一圈涟漪。它比原来那个「整个画面描一圈边」
 *   强的地方在于**有位置** —— 用户能看出软件认为拍点落在哪儿，落歪了自己就看得见。
 *
 * ## 波纹画在哪一帧的位置上
 *
 * 画在**拍点真正发生**的位置，不是确认它的那一帧。多边形拐角要等出边够长才敢认，
 * 确认比实际晚约 120ms（见 `ictusDetector.ts`），那时候手已经走出去一截了 ——
 * 照确认帧画的话，波纹会明显地冒在拍点后面。光迹缓存里存了时间戳，回查一下即可。
 *
 * ## 为什么不订阅 onSample
 *
 * `CameraIntentSource.onSample` 是只进不出的监听器列表，没有退订。这个组件的
 * effect 会随 props 重跑，订阅就会一次次叠加。它只是个观察者，轮询
 * `lastFrame` 与 `model.lastIctusAt` 就够了 —— 判新拍点用「lastIctusAt 变没变」，
 * 和 `cameraIntentSource` 内部同一个办法。
 */

const ZONES = [
  { center: 0.16, label: "主旋律" },
  { center: 0.5, label: "和声" },
  { center: 0.84, label: "低音" },
];

/** 光迹保留多久。约两拍（88 BPM 下 1.4 秒）会糊成一团，0.7 秒刚好看清当前这一笔。 */
const TRAIL_MS = 700;
/** 水波纹的寿命。太长会和下一拍的波纹叠在一起。 */
const RIPPLE_MS = 620;
/** 波纹最大半径（像素）。够醒目又不至于盖住手。 */
const RIPPLE_MAX_R = 46;
/** 拍点闪光的时长。 */
const FLASH_MS = 200;
/** 同时最多留几圈波纹 —— 快速段落里别堆成一片。 */
const MAX_RIPPLES = 3;

interface Props {
  source: CameraIntentSource | null;
  /** 打拍手与表情手是否互换，只影响标记的文字。 */
  swapHands: boolean;
  height?: number;
  /** 摄像头没开时显示什么。默认是「输出」页的说法，考试页那边的按钮叫别的名字。 */
  placeholder?: string;
}

interface TrailPoint {
  x: number;
  y: number;
  t: number;
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

    const colors = {
      accent: cssVar("--accent", "#7cb2e8"),
      wave: cssVar("--wave-4", "#bcdcf7"),
      expr: "#6fd6c4",
      ink: cssVar("--ink", "#f3eddd"),
    };
    // 「减少动态效果」：波纹不扩散，改成一圈定尺寸的淡环。光迹保留 —— 它跟的是
    // 用户自己的手，不是我们凭空加的动画，去掉反而让人不知道识别到没有。
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    /** 归一化坐标 → 画布像素。画面做了镜像，标记也要镜像才对得上。 */
    const trail: TrailPoint[] = [];
    /**
     * 波纹的**位置**取自拍点真正发生的那一刻，**动画时钟**却从我们看见它的那一刻
     * 起算。两者必须分开：拐角要晚约 120ms 才确认，拿 `ictusAt` 当动画起点的话，
     * 620ms 的波纹一出场就已经放完了五分之一，闪光更是只剩 80ms —— 看着像卡了一下。
     */
    const ripples: { x: number; y: number; shownAt: number }[] = [];
    let lastFrameT = 0;
    let seenIctusAt = 0;
    let flashAt = 0;

    /** 回查某个时刻手在哪 —— 用于把波纹画在拍点真正发生的位置上。 */
    const positionAt = (t: number): TrailPoint | null => {
      if (!trail.length) return null;
      let best = trail[trail.length - 1];
      let bestD = Math.abs(best.t - t);
      for (const p of trail) {
        const d = Math.abs(p.t - t);
        if (d < bestD) {
          best = p;
          bestD = d;
        }
      }
      return best;
    };

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

      const now = performance.now();
      const frame = source.lastFrame;
      const beatHand = frame ? (swapHands ? frame.left : frame.right) : null;
      const exprHand = frame ? (swapHands ? frame.right : frame.left) : null;

      // ---- 采样光迹 ----
      // 摄像头约 30fps 而 rAF 约 60fps，同一帧会被看到两次；按 frame.t 去重，
      // 否则缓存里一半是重复点，「保留 700ms」就变成了保留 350ms。
      if (beatHand && frame && frame.t !== lastFrameT) {
        lastFrameT = frame.t;
        trail.push({ x: (1 - beatHand.x) * w, y: beatHand.y * h, t: frame.t });
      }
      while (trail.length && now - trail[0].t > TRAIL_MS) trail.shift();

      // ---- 新拍点 ----
      const ictusAt = source.model.lastIctusAt;
      if (ictusAt > 0 && ictusAt !== seenIctusAt) {
        seenIctusAt = ictusAt;
        flashAt = now;
        const at = positionAt(ictusAt);
        if (at) {
          ripples.push({ x: at.x, y: at.y, shownAt: now });
          if (ripples.length > MAX_RIPPLES) ripples.shift();
        }
      }
      while (ripples.length && now - ripples[0].shownAt > RIPPLE_MS) ripples.shift();

      // ---- 席位分区参考线（画面已镜像，直接用指挥自己的左右）----
      ctx.font = canvasFont(11);
      ZONES.forEach((z) => {
        const x = z.center * w;
        ctx.strokeStyle = withAlpha(colors.ink, 0.1);
        ctx.setLineDash([4, 5]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = withAlpha(colors.ink, 0.34);
        const tw = ctx.measureText(z.label).width;
        ctx.fillText(z.label, x - tw / 2, h - 8);
      });

      // ---- 光迹 ----
      // 一段一段画而不是一条 path 走到底：单条 path 只能有一个 strokeStyle，
      // 渐隐就没了，而渐隐正是「这是刚刚走过的路」的全部意思。
      // 透明度按 k **线性**渐隐并留一个下限，不用 k² —— 平方的尾巴掉得太快，
      // 在纯黑画布上（首页那条光迹）好看，压在摄像头画面上就基本看不见了：
      // 实测尾段落到 0.05~0.15，而画面本身就是中等亮度的花花背景。
      // 颜色也用更亮的 wave 而不是 accent，同样是为了压得住视频。
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (let i = 1; i < trail.length; i += 1) {
        const a = trail[i - 1];
        const b = trail[i];
        const k = 1 - (now - b.t) / TRAIL_MS; // 0 = 最旧，1 = 手的当前位置
        if (k <= 0) continue;
        ctx.strokeStyle = withAlpha(colors.wave, 0.1 + k * 0.6);
        ctx.lineWidth = 1.2 + k * k * 3.2;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // ---- 水波纹 ----
      for (const r of ripples) {
        const age = (now - r.shownAt) / RIPPLE_MS;
        if (age < 0 || age > 1) continue;
        // 先快后慢地铺开（1 - (1-t)³），像水面扩散而不是匀速放大的圆
        const ease = 1 - Math.pow(1 - age, 3);
        const radius = reduced ? RIPPLE_MAX_R * 0.55 : 6 + ease * RIPPLE_MAX_R;
        // 同样要压得住视频画面，比在纯黑背景上该给的亮一截
        const alpha = (1 - age) * 0.8;
        ctx.strokeStyle = withAlpha(colors.wave, alpha);
        ctx.lineWidth = reduced ? 2 : 3 * (1 - age) + 0.8;
        ctx.beginPath();
        ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
        ctx.stroke();
        // 第二圈跟在后面一点，两圈才像涟漪，一圈像个光环
        if (!reduced && ease > 0.22) {
          ctx.strokeStyle = withAlpha(colors.wave, alpha * 0.45);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(r.x, r.y, 6 + (ease - 0.22) * RIPPLE_MAX_R, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // ---- 手 ----
      const flash = flashAt > 0 ? Math.max(0, 1 - (now - flashAt) / FLASH_MS) : 0;
      // 光点画在**当前**手的位置，不取光迹缓存的末端。摄像头卡一下（或帧率掉到
      // 每秒一两帧）时缓存会在 700ms 后清空，跟着缓存画的话光点就凭空消失了 ——
      // 而那时候手明明还认得到，用户只会以为「又跟丢了」。
      const head = beatHand ? { x: (1 - beatHand.x) * w, y: beatHand.y * h } : null;
      if (head) {
        // 拍点瞬间变亮变大：回答「刚才那下算数了吗」
        const r = 4.5 + flash * 4;
        const glowR = 20 + flash * 16;
        const glow = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, glowR);
        glow.addColorStop(0, withAlpha(colors.wave, 0.36 + flash * 0.4));
        glow.addColorStop(1, withAlpha(colors.wave, 0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(head.x, head.y, glowR, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = flash > 0 ? "#ffffff" : colors.wave;
        ctx.beginPath();
        ctx.arc(head.x, head.y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // 表情手：只给一个小点，不给光迹 —— 它不打拍子，留尾巴只会和主光迹抢注意力
      if (exprHand && exprHand !== beatHand) {
        const x = (1 - exprHand.x) * w;
        const y = exprHand.y * h;
        ctx.fillStyle = withAlpha(colors.expr, 0.85);
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = canvasFont(10);
        ctx.fillStyle = withAlpha(colors.expr, 0.7);
        ctx.fillText("表情手", x + 8, y + 3.5);
      }

      // 认不到手时明说是哪一种情况，别让人对着画面猜。
      //
      // 「只认到表情手」要单独说：这时画面上只有一个小绿点、既没有光迹也没有
      // 光点，看起来和「整个功能坏了」一模一样，而实际上只是打拍的那只手没进
      // 画面（或者惯用手反了，该去把「交换双手」打开）。
      const missing = !beatHand && !exprHand
        ? "没认到手 —— 站远一点，让上半身和手都完整进画面"
        : !beatHand
          ? `只认到另一只手 —— 打拍的${swapHands ? "左" : "右"}手没进画面（惯用手相反的话，去把「交换双手」打开）`
          : "";
      if (missing) {
        ctx.font = canvasFont(12);
        const tw = ctx.measureText(missing).width;
        ctx.fillStyle = withAlpha(colors.ink, 0.62);
        ctx.fillText(missing, Math.max(8, (w - tw) / 2), h / 2);
      }
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
