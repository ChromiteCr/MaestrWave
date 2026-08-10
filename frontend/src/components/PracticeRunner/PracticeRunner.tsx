import { useEffect, useRef, useState } from "react";
import { CameraIntentSource } from "../../lib/camera/cameraIntentSource";
import { HandTracker } from "../../lib/camera/handTracker";
import type { RubricItem } from "../../lib/teaching/curriculum";
import { Metronome } from "../../lib/teaching/metronome";
import { SessionRecorder, type Recording } from "../../lib/teaching/recorder";
import { scoreSession, type SessionScore } from "../../lib/teaching/scoring";
import type { Meter } from "../../lib/teaching/patterns";
import { Button } from "../Button/Button";
import { CameraPreview } from "../CameraPreview/CameraPreview";
import { ScoreReport } from "../ScoreReport/ScoreReport";
import styles from "./PracticeRunner.module.css";

/**
 * 跟练：摄像头 + 节拍器 + 录制 + 打分，一整轮。
 *
 * 用节拍器而不是练习曲，是因为练习曲端点还没做（M6 第 4 步）—— 但这不是凑合：
 * 节拍器是采样级精确的严格网格，拍网格的原点就是我们自己写下的时刻，
 * 不需要再去检测音频起始点，评分反而比接了音乐更干净。音乐接上之后，
 * 这个组件换掉声源即可，录制与评分一行都不用动。
 */

interface Props {
  meter: Meter;
  bpm: number;
  rubric: RubricItem[];
  /** 打满这么多小节自动停。 */
  targetBars?: number;
  /** 数拍小节数。网格原点在数拍之后，数拍期间的拍不计分。 */
  countInBars?: number;
}

type Phase = "idle" | "arming" | "countIn" | "running" | "done" | "error";

export function PracticeRunner({ meter, bpm, rubric, targetBars = 8, countInBars = 1 }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [beat, setBeat] = useState<number | null>(null);
  const [ictusCount, setIctusCount] = useState(0);
  const [score, setScore] = useState<SessionScore | null>(null);

  const sourceRef = useRef<CameraIntentSource | null>(null);
  const metroRef = useRef<Metronome | null>(null);
  const recorderRef = useRef<SessionRecorder | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [, force] = useState(0);

  const envProblem = !HandTracker.isSupported()
    ? "这个浏览器不支持摄像头采集。"
    : !HandTracker.isSecureContextOk()
      ? "摄像头需要安全上下文。用 localhost 访问，或以 HTTPS 启动（npm run dev:https）。"
      : "";

  const cleanup = () => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    metroRef.current?.stop();
    metroRef.current = null;
    sourceRef.current?.stop();
    sourceRef.current = null;
    recorderRef.current = null;
  };

  useEffect(() => cleanup, []);
  // 换课时把上一课的结果清掉，否则会看着别人的分数练这一课
  useEffect(() => {
    cleanup();
    setPhase("idle");
    setScore(null);
    setBeat(null);
    setIctusCount(0);
  }, [meter, bpm]);

  const finish = () => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    metroRef.current?.stop();
    metroRef.current = null;

    const rec: Recording | null = recorderRef.current?.stop() ?? null;
    sourceRef.current?.stop();
    sourceRef.current = null;
    recorderRef.current = null;

    if (!rec) {
      setError("没录到任何画面 —— 摄像头可能没认到手。");
      setPhase("error");
      return;
    }
    setScore(scoreSession(rec, { meter, rubric }));
    setPhase("done");
  };

  const start = async () => {
    setError("");
    setScore(null);
    setPhase("arming");

    const src = new CameraIntentSource({ mirrored: true });
    sourceRef.current = src;
    src.setBaseBpm(bpm);
    force((n) => n + 1);

    try {
      await src.start();
    } catch (e) {
      sourceRef.current = null;
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
      return;
    }

    const metro = new Metronome();
    metroRef.current = metro;
    let grid;
    try {
      grid = await metro.start(bpm, meter, countInBars);
    } catch (e) {
      cleanup();
      setError(`节拍器启动失败：${e instanceof Error ? e.message : e}`);
      setPhase("error");
      return;
    }

    const rec = new SessionRecorder();
    recorderRef.current = rec;
    rec.start(grid);
    src.onSample(rec.push);

    setPhase("countIn");
    tickRef.current = setInterval(() => {
      const b = metro.beatNow();
      setBeat(b === null ? null : Math.floor(b));
      setIctusCount(rec.ictusCount);
      if (b === null) return;
      if (b >= 0) setPhase("running");
      if (b >= targetBars * meter) finish();
    }, 100);
  };

  const running = phase === "countIn" || phase === "running";
  const barsDone = beat !== null && beat >= 0 ? Math.floor(beat / meter) : 0;
  // 数拍期间 beat 是负的，换算成「还有几拍开始」
  const countdown = beat !== null && beat < 0 ? -beat : 0;

  if (envProblem) return <p className={styles.error}>{envProblem}</p>;

  return (
    <div className={styles.wrap}>
      <CameraPreview
        source={running ? sourceRef.current : null}
        swapHands={false}
        height={running ? 300 : 180}
        placeholder="点「开始跟练」打开摄像头"
      />

      {running && (
        <div className={styles.hud}>
          <span className={`mono-chip ${styles.big}`}>
            {phase === "countIn" ? `预备 ${countdown}` : `第 ${(beat! % meter) + 1} 拍`}
          </span>
          <span className="mono-chip">
            第 {barsDone + 1} / {targetBars} 小节
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
          {meter}/4 · {bpm} BPM · {targetBars} 小节，节拍器会先给 {countInBars} 小节数拍
        </span>
      </div>

      {score && <ScoreReport score={score} />}
    </div>
  );
}
