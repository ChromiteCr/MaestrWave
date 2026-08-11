import { useEffect, useRef, useState } from "react";
import { CameraIntentSource } from "../../lib/camera/cameraIntentSource";
import { HandTracker } from "../../lib/camera/handTracker";
import type { RubricItem } from "../../lib/teaching/curriculum";
import { Metronome, type BeatGrid } from "../../lib/teaching/metronome";
import { PiecePlayer } from "../../lib/teaching/piecePlayer";
import { SessionRecorder, type Recording } from "../../lib/teaching/recorder";
import { scoreSession, type SessionScore } from "../../lib/teaching/scoring";
import type { PreparedPiece } from "../../lib/teaching/usePracticePiece";
import type { Meter } from "../../lib/teaching/patterns";
import { Button } from "../Button/Button";
import { CameraPreview } from "../CameraPreview/CameraPreview";
import { ScoreReport } from "../ScoreReport/ScoreReport";
import styles from "./PracticeRunner.module.css";

/**
 * 跟练：采集 + 出声 + 录制 + 打分，一整轮。
 *
 * 声源有两个，评分那边完全不知道用的是哪个：
 *
 *   - **练习曲**（`piece`）—— 后端写谱渲染出来的一段管弦乐（`backend/practice.py`）。
 *     拍网格由谱面算出来，误差为零；每小节的力度是写下的，所以「力度对应」评得了。
 *   - **节拍器** —— 曲子还没渲染好、或者调用方压根没给曲子时的退路。它同样是
 *     采样级精确的严格网格，不是凑合；只是没有音乐，也就没有力度可跟。
 *
 * 两条路都在起播时记一对「performance.now() ↔ AudioContext.currentTime」锚点，
 * 并补上输出延迟 —— 用户跟的是听到的声音，不补就是给每个人加一个几十毫秒的
 * 系统性拖拍。
 *
 * **只走摄像头**。六个评分维度里有三个（拍型、平面、拍点清晰度）需要手在空间里的
 * 位置，加速度计给不出来，手机兜底能评的只剩两维 —— 分数会失真到没有参考价值，
 * 所以教学与考试都不做手机模式（见 docs/M6_PLAN.md）。
 */

interface Props {
  meter: Meter;
  bpm: number;
  rubric: RubricItem[];
  /** 练习曲。没有或还没就绪就退到节拍器。 */
  piece?: PreparedPiece | null;
  /** 打满这么多小节自动停。给了 piece 时以曲子的长度为准。 */
  targetBars?: number;
  /** 数拍小节数。网格原点在数拍之后，数拍期间的拍不计分。跟练习曲时由曲子决定。 */
  countInBars?: number;
  /** 打分出来之后回调，考试页拿它判及格。 */
  onScored?: (score: SessionScore) => void;
}

type Phase = "idle" | "arming" | "countIn" | "running" | "done" | "error";

export function PracticeRunner({
  meter, bpm, rubric, piece = null, targetBars = 8, countInBars = 1, onScored,
}: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [beat, setBeat] = useState<number | null>(null);
  const [ictusCount, setIctusCount] = useState(0);
  const [score, setScore] = useState<SessionScore | null>(null);

  const sourceRef = useRef<CameraIntentSource | null>(null);
  const metroRef = useRef<Metronome | null>(null);
  const playerRef = useRef<PiecePlayer | null>(null);
  const recorderRef = useRef<SessionRecorder | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [, force] = useState(0);

  // 跟着曲子练时，拍号速度小节数全部以曲子为准 —— 曲子是照着某一份 spec 渲染的，
  // 用别处的数字去解释它，差一点就是整段评分错位。
  const useBpm = piece?.bpm ?? bpm;
  const useMeter = (piece?.meter as Meter) ?? meter;
  const useBars = piece?.bars ?? targetBars;

  const cleanup = () => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    metroRef.current?.stop();
    metroRef.current = null;
    playerRef.current?.stop();
    playerRef.current = null;
    sourceRef.current?.stop();
    sourceRef.current = null;
    recorderRef.current = null;
  };

  useEffect(() => cleanup, []);
  // 换课、换曲子时清掉上一次的结果，否则会看着上一课的分数练这一课
  useEffect(() => {
    cleanup();
    setPhase("idle");
    setScore(null);
    setBeat(null);
    setIctusCount(0);
  }, [meter, bpm, piece?.pieceId]);

  const finish = () => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    metroRef.current?.stop();
    metroRef.current = null;
    playerRef.current?.stop();
    playerRef.current = null;

    const rec: Recording | null = recorderRef.current?.stop() ?? null;
    sourceRef.current?.stop();
    sourceRef.current = null;
    recorderRef.current = null;

    if (!rec) {
      setError("没录到任何画面 —— 摄像头可能没认到手。");
      setPhase("error");
      return;
    }
    const s = scoreSession(rec, {
      meter: useMeter,
      rubric,
      loudnessPerBar: piece?.loudnessPerBar,
    });
    setScore(s);
    setPhase("done");
    onScored?.(s);
  };

  const start = async () => {
    setError("");
    setScore(null);
    setPhase("arming");

    const src = new CameraIntentSource({ mirrored: true });
    sourceRef.current = src;
    src.setBaseBpm(useBpm);
    force((n) => n + 1);

    try {
      await src.start();
    } catch (e) {
      sourceRef.current = null;
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
      return;
    }

    let grid: BeatGrid;
    try {
      if (piece) {
        const player = new PiecePlayer();
        playerRef.current = player;
        grid = await player.start(piece.audioUrl, {
          bpm: piece.bpm,
          meter: piece.meter,
          gridOffsetSec: piece.gridOffsetSec,
        });
      } else {
        const metro = new Metronome();
        metroRef.current = metro;
        grid = await metro.start(useBpm, useMeter, countInBars);
      }
    } catch (e) {
      cleanup();
      setError(`${piece ? "练习曲" : "节拍器"}启动失败：${e instanceof Error ? e.message : e}`);
      setPhase("error");
      return;
    }

    const rec = new SessionRecorder();
    recorderRef.current = rec;
    rec.start(grid);
    src.onSample(rec.push);

    setPhase("countIn");
    const beatNow = () => (piece ? playerRef.current?.beatNow() : metroRef.current?.beatNow());
    tickRef.current = setInterval(() => {
      const b = beatNow();
      setBeat(b === null || b === undefined ? null : Math.floor(b));
      setIctusCount(rec.ictusCount);
      if (b === null || b === undefined) return;
      if (b >= 0) setPhase("running");
      if (b >= useBars * useMeter) finish();
    }, 100);
  };

  const running = phase === "countIn" || phase === "running";
  const barsDone = beat !== null && beat >= 0 ? Math.floor(beat / useMeter) : 0;
  // 数拍期间 beat 是负的，换算成「还有几拍开始」
  const countdown = beat !== null && beat < 0 ? -beat : 0;

  const envProblem = !HandTracker.isSupported()
    ? "这个浏览器不支持摄像头采集。"
    : !HandTracker.isSecureContextOk()
      ? "摄像头需要安全上下文。用 localhost 访问，或以 HTTPS 启动（npm run dev:https）。"
      : "";
  if (envProblem) return <p className={styles.error}>{envProblem}</p>;

  return (
    <div className={styles.wrap}>
      <CameraPreview
        source={running ? sourceRef.current : null}
        swapHands={false}
        height={running ? 300 : 180}
        placeholder={piece ? "点「开始跟练」，练习曲会先给一小节数拍" : "点「开始跟练」打开摄像头"}
      />

      {running && (
        <div className={styles.hud}>
          <span className={`mono-chip ${styles.big}`}>
            {phase === "countIn" ? `预备 ${countdown}` : `第 ${(beat! % useMeter) + 1} 拍`}
          </span>
          <span className="mono-chip">
            第 {barsDone + 1} / {useBars} 小节
          </span>
          <span className="mono-chip">已认到 {ictusCount} 拍</span>
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.actions}>
        {running ? (
          <Button onClick={finish}>结束并评分</Button>
        ) : (
          <Button variant="primary" onClick={start} disabled={phase === "arming"}>
            {phase === "arming" ? "正在打开摄像头…" : score ? "再来一次" : "开始跟练"}
          </Button>
        )}
        <span className={styles.hint}>
          {useMeter}/4 · {useBpm} BPM · {useBars} 小节
          {piece ? "，练习曲开头有一小节数拍" : `，节拍器会先给 ${countInBars} 小节数拍`}
        </span>
      </div>

      {score && <ScoreReport score={score} />}
    </div>
  );
}
