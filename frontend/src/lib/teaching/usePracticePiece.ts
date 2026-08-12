/**
 * 后台准备练习曲：提交规格 → 轮询 → 拿到可播的 URL 与拍网格。
 *
 * 「用学习时间掩盖等待」是 M6 计划里就定下的（进课程页即发起生成，讲解和示范
 * 照常进行）。符号路线下这件事便宜得多：一首二十几秒的曲子渲染大约五秒，
 * 而且**渲染过一次就永远缓存**，同一课重练是秒开。
 *
 * spec 变了就重新发起 —— 换拍号、换速度都会算出不同的 piece_id，也就是另一首。
 */

import { useEffect, useRef, useState } from "react";
import { api, type PracticeSpec, type PracticeStatus } from "../api";

/**
 * 曲子从哪来。
 *
 * - `spec`：照规格写谱（`backend/practice.py`），同一份 spec 永远是同一首。
 * - `repertoire`：随仓库分发的真实交响乐（`backend/repertoire.py`），同一个文件截同一段。
 *
 * 两条路的**产出是同形的**（同样的 wav/mid/网格/力度曲线），所以除了这里发起
 * 请求的那一行，底下的轮询、播放、录制、评分全都不分辨曲子是哪来的。
 */
export type PieceSource =
  | { kind: "spec"; spec: PracticeSpec }
  | { kind: "repertoire"; id: string };

export interface PreparedPiece {
  pieceId: string;
  audioUrl: string;
  midiUrl: string;
  bpm: number;
  meter: number;
  /** 音频开头到正曲第一拍的秒数。 */
  gridOffsetSec: number;
  /** 数拍小节数。界面上要照实说「开头有几小节数拍」—— 它随拍号变，不是恒等于 1。 */
  countInBars: number;
  /** 正曲小节数 —— 打满就停。 */
  bars: number;
  /** 每小节的力度真值，喂给「力度对应」那一维。 */
  loudnessPerBar: number[];
  /**
   * 这条力度曲线是**谱面写的**还是**从配器推导的**。
   *
   * 必须一路带到界面上：推导出来的曲线是我们算的，不是作曲家写的，
   * 让用户以为自己在跟贝多芬的力度是不诚实的。
   */
  dynamicsSource: "score" | "derived";
}

export type PieceState = "idle" | "preparing" | "ready" | "error";

/** 轮询间隔。渲染是几秒的量级，一秒一问既不迟钝也不吵。 */
const POLL_MS = 1000;
/** 等这么久还没好就报错，免得界面永远转圈。 */
const TIMEOUT_MS = 120_000;

export function usePracticePiece(source: PieceSource | null): {
  state: PieceState;
  piece: PreparedPiece | null;
  error: string;
  retry: () => void;
} {
  const [state, setState] = useState<PieceState>("idle");
  const [piece, setPiece] = useState<PreparedPiece | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  // source 是每次渲染新建的对象，直接进依赖数组会无限重发。序列化成字符串比较。
  const key = source ? JSON.stringify(source) : "";
  const specRef = useRef(source);
  specRef.current = source;

  useEffect(() => {
    const current = specRef.current;
    if (!current) {
      setState("idle");
      setPiece(null);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = Date.now() + TIMEOUT_MS;

    // 曲目那条路没有本地 spec 可退，一切都以后端返回的为准；写谱那条路保留
    // 原有的「后端没给就用 spec 里的」兜底
    const fallback = current.kind === "spec" ? current.spec : null;

    const settle = (s: PracticeStatus) => {
      if (s.state !== "ready" || !s.grid) return false;
      setPiece({
        pieceId: s.piece_id,
        audioUrl: api.practiceAudioUrl(s.piece_id),
        midiUrl: api.practiceMidiUrl(s.piece_id),
        bpm: s.grid.bpm,
        meter: s.grid.beats_per_bar,
        gridOffsetSec: s.grid.offset,
        countInBars: s.count_in_bars ?? fallback?.count_in_bars ?? 0,
        bars: s.music_bars ?? fallback?.bars ?? 0,
        loudnessPerBar: s.loudness_per_bar ?? fallback?.dynamics ?? [],
        dynamicsSource: s.dynamics_source ?? "score",
      });
      setState("ready");
      return true;
    };

    const fail = (msg: string) => {
      setError(msg);
      setState("error");
    };

    const poll = async (pieceId: string) => {
      if (cancelled) return;
      try {
        const s = await api.practiceStatus(pieceId);
        if (cancelled) return;
        if (settle(s)) return;
        if (s.state === "error") return fail(s.error || "渲染失败");
        // 超时判断要放在 missing 之前：missing 会重新发起一次，
        // 后端要是每次都立刻丢回 missing，这两句换个顺序就是个死循环
        if (Date.now() > deadline) return fail("练习曲渲染超时了。");
        // missing：缓存被删了或进程重启过，重新发起一次而不是干等
        if (s.state === "missing") return void start();
        timer = setTimeout(() => void poll(pieceId), POLL_MS);
      } catch (e) {
        if (!cancelled) fail(e instanceof Error ? e.message : String(e));
      }
    };

    const start = async () => {
      setState("preparing");
      setError("");
      setPiece(null);
      try {
        const s = current.kind === "spec"
          ? await api.practiceGenerate(current.spec)
          : await api.repertoirePrepare(current.id);
        if (cancelled) return;
        if (settle(s)) return;
        if (s.state === "error") return fail(s.error || "渲染失败");
        timer = setTimeout(() => void poll(s.piece_id), POLL_MS);
      } catch (e) {
        if (!cancelled) fail(e instanceof Error ? e.message : String(e));
      }
    };

    void start();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key, attempt]);

  return { state, piece, error, retry: () => setAttempt((n) => n + 1) };
}
