import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button/Button";
import { CameraPreview } from "../../components/CameraPreview/CameraPreview";
import { PageHeader } from "../../components/PageHeader/PageHeader";
import { LatencyCalibration } from "../../components/LatencyCalibration/LatencyCalibration";
import { PracticeRunner } from "../../components/PracticeRunner/PracticeRunner";
import { CameraIntentSource } from "../../lib/camera/cameraIntentSource";
import { HandTracker } from "../../lib/camera/handTracker";
import { findLesson } from "../../lib/teaching/curriculum";
import {
  EXAM_PIECES, GOOD_SCORE, PASS_SCORE, examDimensions, examDurationSec, type ExamPiece,
} from "../../lib/teaching/exam";
import { buildSpec } from "../../lib/teaching/piece";
import type { SessionScore } from "../../lib/teaching/scoring";
import { usePracticePiece } from "../../lib/teaching/usePracticePiece";
import { useAppStore } from "../../state/store";
import styles from "./ExamPage.module.css";

/**
 * 「考试」：用固定的曲目给用户打分，摄像头采集。
 *
 * 和「课程」里的跟练分开，是因为**可比性**：练习曲跟着本课的拍号速度走，换一课
 * 就换一首，分数没法横向比；考试用同一批曲目、同一个速度，分数才有意义。
 *
 * 「固定」不是靠往仓库里塞音频文件，而是靠 `exam.ts` 里写死的曲目规格 +
 * 后端可复现的写谱渲染（见 `backend/practice.py`）。所以这三首曲子不需要配密钥、
 * 不需要联网，第一次考的时候渲染几秒，之后永远秒开。
 *
 * 考前**先自检再开考**：环境检查、开摄像头、认手、看帧率。考到一半发现摄像头
 * 认不到手，那一次就白考了。
 */

type CamState = "idle" | "starting" | "ready" | "error";

/** 认到手之后再等这么久才判定「就绪」，避免一帧误检就报绿灯。 */
const CONFIRM_MS = 800;

export function ExamPage() {
  const openLesson = useAppStore((s) => s.openLesson);
  const [selected, setSelected] = useState<ExamPiece>(EXAM_PIECES[0]);
  const [examing, setExaming] = useState(false);
  const [result, setResult] = useState<SessionScore | null>(null);

  const [cam, setCam] = useState<CamState>("idle");
  const [camError, setCamError] = useState("");
  const [hands, setHands] = useState({ left: false, right: false, fps: 0 });
  const sourceRef = useRef<CameraIntentSource | null>(null);
  const [, force] = useState(0);

  // 选中哪一首就渲染哪一首。切曲目时上一首已经在缓存里，切回去是秒开。
  const piece = usePracticePiece(
    buildSpec(selected.music, { meter: selected.meter, bpm: selected.bpm, id: selected.id }),
  );

  // 环境检查是同步的，不用开摄像头就知道结果 —— 先把「这台机器根本不行」挡在前面
  const envProblem = !HandTracker.isSupported()
    ? "这个浏览器不支持摄像头采集。"
    : !HandTracker.isSecureContextOk()
      ? "摄像头需要安全上下文。用 localhost 访问，或以 HTTPS 启动（npm run dev:https）。"
      : "";

  useEffect(() => {
    return () => {
      sourceRef.current?.stop();
      sourceRef.current = null;
    };
  }, []);

  // 摄像头开着时轮询状态。用轮询而不是每帧回调：这里只是给人看的指示灯，
  // 30fps 刷新一个「已认到手」的绿点没有意义，反而每帧都触发 React 重渲染。
  useEffect(() => {
    if (cam !== "starting" && cam !== "ready") return;
    let seenSince = 0;
    const id = setInterval(() => {
      const src = sourceRef.current;
      if (!src) return;
      const f = src.lastFrame;
      const left = !!f?.left;
      const right = !!f?.right;
      setHands({ left, right, fps: src.tracker.fps });
      if (left || right) {
        if (!seenSince) seenSince = performance.now();
        if (performance.now() - seenSince > CONFIRM_MS) setCam("ready");
      } else {
        seenSince = 0;
      }
    }, 200);
    return () => clearInterval(id);
  }, [cam]);

  const startCamera = async () => {
    setCamError("");
    setCam("starting");
    const src = new CameraIntentSource({ mirrored: true });
    sourceRef.current = src;
    force((n) => n + 1); // 让 CameraPreview 拿到 source
    try {
      await src.start();
    } catch (e) {
      sourceRef.current = null;
      setCamError(e instanceof Error ? e.message : String(e));
      setCam("error");
    }
  };

  const stopCamera = () => {
    sourceRef.current?.stop();
    sourceRef.current = null;
    setHands({ left: false, right: false, fps: 0 });
    setCam("idle");
  };

  const pickPiece = (p: ExamPiece) => {
    if (examing) return; // 考到一半换卷子就没有可比性了
    setSelected(p);
    setResult(null);
  };

  const beginExam = () => {
    // 自检占着摄像头，考试要自己开一路 —— 同一个设备开两次会失败
    stopCamera();
    setResult(null);
    setExaming(true);
  };

  const dims = examDimensions(selected);
  const verdict =
    result === null ? null : result.total >= GOOD_SCORE ? "优秀" : result.total >= PASS_SCORE ? "及格" : "不及格";

  return (
    <div>
      <PageHeader
        eyebrow="指挥教学"
        title="考试"
        meta={
          <>
            <span className="mono-chip">{EXAM_PIECES.length} 首曲目</span>
            <span className="mono-chip">及格 {PASS_SCORE} · 优秀 {GOOD_SCORE}</span>
          </>
        }
      />

      <div className={styles.body}>
        <p className={styles.intro}>
          考试用固定的曲目，所有人考同一首、同一个速度 —— 练习曲跟着课程走，每一课
          都不一样，分数没法比；考试曲目固定，分数才有意义。曲子由后端照着写死的规格
          写谱渲染，同一份规格永远是同一首，所以不需要联网也不需要配密钥。
          全程用摄像头采集，按行业标准的几个维度给出具体数字与建议。
        </p>

        <div className={styles.grid}>
          <section className={styles.col}>
            <p className="eyebrow">选择曲目</p>
            <div className={styles.pieces}>
              {EXAM_PIECES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={examing && p.id !== selected.id}
                  className={`${styles.piece} ${selected.id === p.id ? styles.pieceActive : ""}`}
                  onClick={() => pickPiece(p)}
                >
                  <div className={styles.pieceHead}>
                    <span className={styles.pieceTitle}>{p.title}</span>
                    <span className="mono-chip">{p.levelLabel}</span>
                  </div>
                  <p className={styles.pieceTests}>{p.tests}</p>
                  <div className={styles.pieceMeta}>
                    <span className="mono-chip">
                      {p.meter}/4 · {p.bpm} BPM
                    </span>
                    <span className="mono-chip">{p.music.bars} 小节 · {examDurationSec(p)} 秒</span>
                  </div>
                </button>
              ))}
            </div>

            <p className="eyebrow" style={{ marginTop: 26 }}>
              《{selected.title}》考什么
            </p>
            <ul className={styles.dims}>
              {dims.map((d) => (
                <li key={d.key}>
                  <div className={styles.dimHead}>
                    <span className={styles.dimLabel}>{d.label}</span>
                    <span className="mono-chip">{Math.round(d.weight * 100)}%</span>
                  </div>
                  <p className={styles.dimHow}>{d.how}</p>
                </li>
              ))}
            </ul>

            <p className={styles.covers}>
              对应课程：
              {selected.covers.map((id, i) => {
                const l = findLesson(id);
                if (!l) return null;
                return (
                  <span key={id}>
                    {i > 0 && "、"}
                    <button type="button" className={styles.link} onClick={() => openLesson(id)}>
                      {l.title}
                    </button>
                  </span>
                );
              })}
            </p>

            {piece.state === "ready" && piece.piece && (
              <p className={styles.covers}>
                想看这首的谱子：
                <a className={styles.link} href={piece.piece.midiUrl} download>
                  下载 MIDI
                </a>
                —— 曲子本来就是写出来的，拖进 MuseScore 就能对着看。
              </p>
            )}
          </section>

          <section className={styles.col}>
            {envProblem ? (
              <>
                <p className="eyebrow">摄像头自检</p>
                <p className={styles.error}>{envProblem}</p>
              </>
            ) : examing ? (
              <>
                <p className="eyebrow">正在考试 · 《{selected.title}》</p>
                <p className={styles.checkHint}>
                  跟着数拍进，打满 {selected.music.bars} 小节自动结束并出分。
                </p>
                <PracticeRunner
                  meter={selected.meter}
                  bpm={selected.bpm}
                  rubric={selected.rubric}
                  piece={piece.piece}
                  onScored={setResult}
                />
                {verdict && (
                  <p className={`${styles.verdict} ${result!.total >= PASS_SCORE ? styles.pass : styles.fail}`}>
                    {verdict} · {result!.total} 分（及格 {PASS_SCORE}、优秀 {GOOD_SCORE}）
                  </p>
                )}
                <div className={styles.camActions}>
                  <Button onClick={() => setExaming(false)}>退出考试</Button>
                </div>
              </>
            ) : (
              <>
                <p className="eyebrow">摄像头自检</p>
                <p className={styles.checkHint}>
                  考前先确认摄像头能认到手。站远一点，让上半身和两只手都进画面。
                </p>

                <CameraPreview
                  source={cam === "idle" || cam === "error" ? null : sourceRef.current}
                  swapHands={false}
                  placeholder="点下面的「打开摄像头自检」"
                />

                <div className={styles.checks}>
                  <Check on={cam === "starting" || cam === "ready"} label="摄像头已打开" />
                  <Check on={hands.right} label="看到打拍手（右手）" />
                  <Check on={hands.left} label="看到表情手（左手）" />
                  <Check on={hands.fps >= 20} label={`帧率 ${hands.fps} fps（需要 ≥ 20）`} />
                  <Check
                    on={piece.state === "ready"}
                    label={
                      piece.state === "ready"
                        ? "曲目就绪"
                        : piece.state === "error"
                          ? `曲目没准备好：${piece.error}`
                          : "曲目渲染中…"
                    }
                  />
                </div>

                {camError && <p className={styles.error}>{camError}</p>}

                <div className={styles.camActions}>
                  {cam === "idle" || cam === "error" ? (
                    <Button variant="primary" onClick={startCamera}>
                      打开摄像头自检
                    </Button>
                  ) : (
                    <Button onClick={stopCamera}>关闭摄像头</Button>
                  )}
                  <Button
                    variant="primary"
                    onClick={beginExam}
                    disabled={piece.state !== "ready"}
                    title={piece.state === "ready" ? undefined : "曲目还没渲染好"}
                  >
                    开始考试
                  </Button>
                  {piece.state === "error" && (
                    <Button onClick={piece.retry}>重试渲染</Button>
                  )}
                </div>

                <p className="eyebrow" style={{ marginTop: 26 }}>音画延迟校准</p>
                <p className={styles.checkHint}>
                  戴无线耳机或用外接音箱的话，先做这一步。声音晚到多少，你的拍点就会
                  被判成晚了多少 —— 这是分数无缘无故很低的头号原因。
                </p>
                <LatencyCalibration compact />

                <p className={styles.todo}>
                  挡住「开始考试」的只有曲目 —— 曲子没渲染完，考了也没有拍网格可对。
                  摄像头那四项和校准都不挡：认不到手照样让你开，但强烈建议先看到绿点，
                  不然一整轮打完只会得到一句「没录到任何画面」。
                </p>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Check({ on, label }: { on: boolean; label: string }) {
  return (
    <div className={`${styles.check} ${on ? styles.checkOn : ""}`}>
      <span className={styles.dot} />
      {label}
    </div>
  );
}
