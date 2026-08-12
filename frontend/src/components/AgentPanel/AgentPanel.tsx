import { useCallback, useEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useAppStore } from "../../state/store";
import { AgentChat } from "../AgentChat/AgentChat";
import { AgentIcon, CloseIcon } from "../icons";
import styles from "./AgentPanel.module.css";

/**
 * 助手入口：一颗可以拖着走的悬浮球，点开morph成对话框。
 *
 * ## 为什么不是原来那条竖边栏
 *
 * 原来收起态是右侧一条 40px 的竖条，展开是 340px 的侧栏。问题不在样子而在**代价**：
 * 它占的是布局宽度，任何时候都在从内容里切走一块 —— 而指挥台那一屏正需要整屏。
 * 于是那条边栏平时既不敢做大（怕挤内容）又没人看（太窄），成了个摆设。
 * 浮起来就没有这个矛盾：不占布局，想放哪儿放哪儿。
 *
 * ## 那颗球和那个框是同一个东西
 *
 * 展开不是「球消失、框出现」，是**同一个盒子把自己撑开**：宽高在变，圆角从头到尾
 * 都是 28px —— 也就是球的半径。所以球的那一圈弧和框的四个角是同一条曲线，
 * 中间任何一帧都对得上，看起来是长开的而不是换掉的。这也是为什么球的直径必须是
 * 圆角的两倍（`BALL` = 2 × `RADIUS`），改一个就得改另一个。
 *
 * ## 往哪边长
 *
 * 从**球所在的那个角**往屏幕中间长：球在右下就朝左上撑开，在左上就朝右下。
 * 这样球贴着的那条边不动，用户把球放在哪儿，框就从哪儿冒出来。往固定方向长的话，
 * 球被拖到右边缘时框会长到屏幕外面去。
 */

const SUGGESTIONS = [
  "四拍的拍型怎么打？",
  "渐强和渐弱怎么用手表达？",
  "「构型」页是做什么的？",
  "怎么用摄像头指挥？",
];

/** 圆角半径。球的半径、框的圆角，同一个数 —— 见文件头。 */
const RADIUS = 28;
const BALL = RADIUS * 2;
const PANEL_W = 360;
/** 对话框最高多少。太高会在小屏上顶到边，`geometry()` 里还会再按视口收一次。 */
const PANEL_MAX_H = 560;
/** 离视口边缘至少留这么多，拖到边上也不会贴死。 */
const MARGIN = 16;
/** 按下到松开之间移动超过这么多像素就算拖动，不算点击。 */
const DRAG_SLOP = 4;

const POS_KEY = "mw.agent.pos";

interface Point {
  x: number;
  y: number;
}

/** 球心坐标，视口像素。存起来：拖到顺手的位置之后，刷新一次就弹回去是很烦的。 */
function readPos(): Point | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Point;
    return typeof p?.x === "number" && typeof p?.y === "number" ? p : null;
  } catch {
    return null; // 隐私模式下 localStorage 会抛
  }
}

function defaultPos(): Point {
  return {
    x: window.innerWidth - MARGIN - RADIUS,
    y: window.innerHeight - MARGIN - RADIUS,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 球心永远留在视口里。换窗口大小、或者上次存的位置来自更大的屏幕，都要拉回来。 */
function clampPos(p: Point): Point {
  return {
    x: clamp(p.x, MARGIN + RADIUS, Math.max(MARGIN + RADIUS, window.innerWidth - MARGIN - RADIUS)),
    y: clamp(p.y, MARGIN + RADIUS, Math.max(MARGIN + RADIUS, window.innerHeight - MARGIN - RADIUS)),
  };
}

/** 当前该是多大、在哪儿。收起和展开共用一套 left/top/width/height，所以能直接过渡。 */
function geometry(pos: Point, open: boolean) {
  if (!open) {
    return { left: pos.x - RADIUS, top: pos.y - RADIUS, width: BALL, height: BALL };
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(PANEL_W, vw - MARGIN * 2);
  const h = Math.min(PANEL_MAX_H, vh - MARGIN * 2);
  // 球贴着哪条边，就把框的那条边钉在球上，往屏幕中间长
  const left = pos.x < vw / 2 ? pos.x - RADIUS : pos.x + RADIUS - w;
  const top = pos.y < vh / 2 ? pos.y - RADIUS : pos.y + RADIUS - h;
  return {
    left: clamp(left, MARGIN, Math.max(MARGIN, vw - w - MARGIN)),
    top: clamp(top, MARGIN, Math.max(MARGIN, vh - h - MARGIN)),
    width: w,
    height: h,
  };
}

export function AgentPanel() {
  const open = useAppStore((s) => s.agentOpen);
  const setOpen = useAppStore((s) => s.setAgentOpen);
  const hasMessages = useAppStore((s) => s.agentMessages.length > 0);
  const clearAgent = useAppStore((s) => s.clearAgent);

  /**
   * `null` = 用户还没自己放过，位置每次渲染按当前视口现算（右下角）。
   *
   * 不能在首帧算完就存进 state：页面在后台标签里挂载时 `innerWidth` 可能还是 0，
   * 算出来的「右下角」会被 `clampPos` 夹成左上角 —— 而夹紧是幂等的，视口后来
   * 变正常了它也回不来，球就永久停在左上角压着品牌区。现算就没有这个问题。
   */
  const [pos, setPos] = useState<Point | null>(() => readPos());
  const [dragging, setDragging] = useState(false);
  /** 这一次按下有没有真的移动过。用来分辨「拖」和「点」。 */
  const movedRef = useRef(false);
  /**
   * 视口一变就重算位置。
   *
   * `visibilitychange` 和 `resize` 一起听：标签页在后台时 `innerWidth` 报 0，
   * 切回前台拿到真实尺寸的那一下不一定发 resize，而这正是上面说的「球停在
   * 左上角」会发生的时刻。
   */
  const [, bumpViewport] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    window.addEventListener("resize", bumpViewport);
    document.addEventListener("visibilitychange", bumpViewport);
    return () => {
      window.removeEventListener("resize", bumpViewport);
      document.removeEventListener("visibilitychange", bumpViewport);
    };
  }, []);

  /** 真正用的位置。夹紧放在**渲染时**做而不是存进 state：存进去就再也松不开了。 */
  const anchor = pos ? clampPos(pos) : defaultPos();

  /** 松手时要落盘的是**最新**位置，而 onUp 的闭包里那个是按下那一刻的。 */
  const posRef = useRef(anchor);
  posRef.current = anchor;

  const startDrag = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const el = e.currentTarget as HTMLElement;
    // 指针捕获：手速快到移出球外面时，move/up 事件还得继续送到这里来，
    // 否则球会卡在半路上、而按钮以为自己还被按着。
    el.setPointerCapture(e.pointerId);
    movedRef.current = false;
    setDragging(true);

    const start = { x: e.clientX, y: e.clientY };
    const origin = anchor;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!movedRef.current && Math.hypot(dx, dy) > DRAG_SLOP) movedRef.current = true;
      if (movedRef.current) setPos(clampPos({ x: origin.x + dx, y: origin.y + dy }));
    };
    const onUp = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      setDragging(false);
      // 位置只在松手时落盘，不是每一帧 —— 拖一次会产生上百次 move
      if (movedRef.current) {
        try {
          localStorage.setItem(POS_KEY, JSON.stringify(posRef.current));
        } catch {
          /* 存不下就只在本次会话里生效 */
        }
      }
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }, [anchor]);

  const geo = geometry(anchor, open);

  return (
    <div
      className={`${styles.shell} ${open ? styles.shellOpen : ""} ${dragging ? styles.shellDragging : ""}`}
      style={geo}
    >
      {/*
        球面。展开之后它不再接事件（`shellOpen` 里 pointer-events: none），
        但节点留着 —— 卸掉的话收起时它要重新挂载，淡入就没有起点了。
      */}
      <button
        type="button"
        className={styles.ball}
        title="问问助手（可拖动）"
        aria-label="打开助手"
        aria-expanded={open}
        onPointerDown={startDrag}
        onClick={() => {
          // 拖完松手浏览器还会补一个 click，不拦住的话拖一下就顺带打开了
          if (movedRef.current) return;
          setOpen(true);
        }}
      >
        <AgentIcon size={22} />
      </button>

      <div className={styles.body} aria-hidden={!open}>
        <header className={styles.head}>
          <div>
            <p className="eyebrow">助手</p>
            <p className={styles.sub}>指挥知识与软件操作</p>
          </div>
          <div className={styles.headActions}>
            {hasMessages && (
              <button type="button" className={styles.textBtn} onClick={clearAgent}>
                清空
              </button>
            )}
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="收起"
              onClick={() => setOpen(false)}
            >
              <CloseIcon size={14} />
            </button>
          </div>
        </header>

        <AgentChat suggestions={SUGGESTIONS} emptyHint="问我指挥怎么打，或者这个软件怎么用。" />
      </div>
    </div>
  );
}
