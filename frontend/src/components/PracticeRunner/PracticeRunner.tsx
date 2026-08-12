import { useEffect, useRef, useState } from "react";
import { CameraIntentSource } from "../../lib/camera/cameraIntentSource";
import { HandTracker } from "../../lib/camera/handTracker";
import type { RubricItem } from "../../lib/teaching/curriculum";
import { getLatencyMs, shiftGrid } from "../../lib/teaching/latency";
import { beatIndexAt, Metronome, type BeatGrid } from "../../lib/teaching/metronome";
import { PiecePlayer } from "../../lib/teaching/piecePlayer";
import { SessionRecorder, type Recording } from "../../lib/teaching/recorder";
import { scoreSession, type SessionScore } from "../../lib/teaching/scoring";
import type { PreparedPiece } from "../../lib/teaching/usePracticePiece";
import { PATTERNS, type Meter } from "../../lib/teaching/patterns";
import { countInBarsFor } from "../../lib/teaching/piece";
import { BeatPatternDemo } from "../BeatPatternDemo/BeatPatternDemo";
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
  /**
   * 节拍器的数拍小节数。跟练习曲时以曲子为准（`piece.countInBars`）。
   *
   * 默认取 `countInBarsFor(meter)`，和练习曲用的是同一个函数 —— 不这么写的话，
   * 同一课「跟曲子」给两小节数拍、「跟节拍器」给一小节，同一个人两次练习的
   * 起手时机不一样，而他会以为是自己没数准。
   */
  countInBars?: number;
  /** 打分出来之后回调，考试页拿它判及格。 */
  onScored?: (score: SessionScore) => void;
}

type Phase = "idle" | "arming" | "countIn" | "running" | "done" | "error";

export function PracticeRunner({
  meter, bpm, rubric, piece = null, targetBars = 8,
  countInBars = countInBarsFor(meter), onScored,
}: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [beat, setBeat] = useState<number | null>(null);
  const [ictusCount, setIctusCount] = useState(0);
  const [lastOffset, setLastOffset] = useState<number | null>(null);
  const [score, setScore] = useState<SessionScore | null>(null);
  const [guideOpen, setGuideOpen] = useState(true);
  /** 上一个已经显示过的拍点时刻，用来只对「新的那一拍」做反馈。 */
  const seenIctusRef = useRef(0);

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
      setError("没录到任何画面，摄像头可能没认到手。");
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

    // 把校准出来的音画延迟加到网格原点上。不做这一步，戴蓝牙耳机的人每一拍
    // 都会被判成拖了两百毫秒（见 lib/teaching/latency.ts）。
    grid = shiftGrid(grid, getLatencyMs());

    const rec = new SessionRecorder();
    recorderRef.current = rec;
    rec.start(grid);
    src.onSample(rec.push);

    setPhase("countIn");
    setLastOffset(null);
    seenIctusRef.current = 0;
    const beatNow = () => (piece ? playerRef.current?.beatNow() : metroRef.current?.beatNow());
    tickRef.current = setInterval(() => {
      const b = beatNow();
      setBeat(b === null || b === undefined ? null : Math.floor(b));
      setIctusCount(rec.ictusCount);

      // 现打现看：刚打下去那一拍偏了多少。
      //
      // 这是整个跟练里唯一的**即时**反馈，也是学节拍最需要的东西 —— 一轮打完
      // 才知道「平均晚了 60ms」是没法照着改的，你根本不记得是哪几下晚了。
      const at = rec.lastIctusAt;
      if (at !== null && at !== seenIctusRef.current) {
        seenIctusRef.current = at;
        const idx = beatIndexAt(grid, at);
        const off = (idx - Math.round(idx)) * (60000 / grid.bpm);
        // 差半拍以上说明它没对上任何一拍，显示出来只会误导
        if (Math.abs(off) < 30000 / grid.bpm) setLastOffset(off);
      }

      if (b === null || b === undefined) return;
      if (b >= 0) setPhase("running");
      if (b >= useBars * useMeter) finish();
    }, 100);
  };

  const running = phase === "countIn" || phase === "running";
  const barsDone = beat !== null && beat >= 0 ? Math.floor(beat / useMeter) : 0;
  // 数拍期间 beat 是负的，换算成「还有几拍开始」
  const countdown = beat !== null && beat < 0 ? -beat : 0;
  // 跟曲子时数拍长度由曲子定；跟节拍器时用传进来的
  const useCountIn = piece?.countInBars ?? countInBars;

  /**
   * 小窗里的光点跟谁走：正曲期间跟真实网格，数拍期间停在预备位置。
   *
   * 数拍那几拍不计分，光点跟着跑只会让人以为该打了。而正曲一旦开始就必须交给
   * 网格 —— 让小窗自己按 BPM 转的话，它和用户真正在跟的那条音轨是两个时间源，
   * 几十秒下来必然错开，那时它指的就是另一拍了。
   */
  const guideBeat = phase === "running" && beat !== null && beat >= 0 ? beat : null;

  const envProblem = !HandTracker.isSupported()
    ? "这个浏览器不支持摄像头采集。"
    : !HandTracker.isSecureContextOk()
      ? "摄像头需要安全上下文。用 localhost 访问，或以 HTTPS 启动（npm run dev:https）。"
      : "";
  if (envProblem) return <p className={styles.error}>{envProblem}</p>;

  return (
    <div className={styles.wrap}>
      {/*
        这一首是几拍子，在**按下开始之前**就要说清楚。
        跟练时人是听着音乐挥手的，拍号错了整段都白打，而听出拍号并不是初学者
        该在跟练时顺便完成的任务 —— 那是另一门功课。
      */}
      <div className={styles.brief}>
        <span className={styles.meterBadge}>{useMeter}/4</span>
        <div>
          <p className={styles.briefTitle}>
            {useMeter === 1 ? "一小节打一下" : `每小节 ${useMeter} 拍`}
            <span className={styles.briefDim}>
              {" · "}{piece ? "练习曲" : "节拍器"}{" · "}{useBpm} BPM{" · "}{useBars} 小节
            </span>
          </p>
          <p className={styles.briefSub}>
            {useMeter === 1
              ? "拍点在最低处，手抬起来的那一程就是下一小节的预备。"
              : `走向是「${PATTERNS[useMeter].mnemonic.join("、")}」。`}
            开头有 {useCountIn} 小节数拍，共 {useCountIn * useMeter} 声，数完接第 1 拍。
          </p>
        </div>
      </div>

      <div className={styles.stage}>
        <CameraPreview
          source={running ? sourceRef.current : null}
          swapHands={false}
          height={running ? 300 : 180}
          placeholder={
            piece
              ? `点「开始跟练」，练习曲会先给 ${useCountIn} 小节数拍`
              : "点「开始跟练」打开摄像头"
          }
        />

        {/*
          拍型小窗。压在画面角上而不是摆在旁边：跟练时眼睛盯着自己的手在画面里的
          位置，视线离开摄像头去别处对照，手就跟着歪了。
          可收起 —— 它确实挡住一块画面，而已经打熟的人不需要它。

          只在打的时候出来：没开始时画面里是「点开始跟练」那行字，小窗正好压在
          它上面 —— 挡住的偏偏是**告诉人下一步做什么**的那句话。
        */}
        {!running ? null : guideOpen ? (
          <div className={styles.guide}>
            <div className={styles.guideHead}>
              <span className={styles.guideTitle}>{useMeter}/4 怎么打</span>
              <button type="button" className={styles.guideToggle} onClick={() => setGuideOpen(false)}>
                收起
              </button>
            </div>
            <BeatPatternDemo
              meter={useMeter}
              bpm={useBpm}
              playing
              compact
              beat={guideBeat}
              height={116}
            />
            <p className={styles.guideMnemonic}>{PATTERNS[useMeter].mnemonic.join(" → ")}</p>
          </div>
        ) : (
          <button type="button" className={styles.guideOpen} onClick={() => setGuideOpen(true)}>
            拍型
          </button>
        )}
      </div>

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

      {running && phase === "running" && <OffsetMeter offsetMs={lastOffset} beatMs={60000 / useBpm} />}

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
          {piece
            ? "跟练习曲，力度也在评分之内"
            : "跟节拍器，只有点没有音乐，评不了「力度对应」"}
        </span>
      </div>

      {score && <ScoreReport score={score} beatMs={60000 / useBpm} />}
    </div>
  );
}

/**
 * 「刚才那一下」偏了多少 —— 一根指针，左边抢拍右边拖拍，中间那段是准。
 *
 * 学节拍靠的是**闭环**：打一下、立刻看到偏在哪边、下一拍改过来。一轮打完才给
 * 一个「平均晚了 60ms」是学不会的 —— 那时候人已经不记得是哪几下晚了。
 *
 * 刻度用拍长的百分比而不是固定毫秒：慢曲子里偏 60ms 几乎看不出来，快曲子里
 * 同样的 60ms 已经是四分之一拍。指针要和「听起来差多少」一致，不是和绝对时间一致。
 */
function OffsetMeter({ offsetMs, beatMs }: { offsetMs: number | null; beatMs: number }) {
  // 满量程 = 四分之一拍。再远就不是「偏了」而是「打错拍了」
  const full = beatMs * 0.25;
  const pos = offsetMs === null ? 0 : clampPct((offsetMs / full) * 50);
  // 免罚区和评分里的 TIMING 满分容差同源，别让指针说「准」而分数说「不准」
  const goodHalf = clampPct((Math.max(45, beatMs * 0.07) / full) * 50);
  return (
    <div className={styles.meter} aria-hidden>
      <div className={styles.meterTrack}>
        <span className={styles.meterGood} style={{ left: `${50 - goodHalf}%`, width: `${goodHalf * 2}%` }} />
        <span className={styles.meterCenter} />
        {offsetMs !== null && (
          <span className={styles.meterNeedle} style={{ left: `${50 + pos}%` }} />
        )}
      </div>
      <div className={styles.meterLabels}>
        <span>抢拍</span>
        <span className={styles.meterValue}>
          {offsetMs === null
            ? "打一拍看看"
            : Math.abs(offsetMs) <= Math.max(45, beatMs * 0.07)
              ? "准"
              : `${offsetMs > 0 ? "晚" : "早"} ${Math.abs(offsetMs).toFixed(0)}ms`}
        </span>
        <span>拖拍</span>
      </div>
    </div>
  );
}

const clampPct = (v: number) => Math.max(-50, Math.min(50, v));
