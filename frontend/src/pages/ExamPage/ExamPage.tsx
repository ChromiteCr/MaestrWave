import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button/Button";
import { CameraPreview } from "../../components/CameraPreview/CameraPreview";
import { PageHeader } from "../../components/PageHeader/PageHeader";
import { CameraIntentSource } from "../../lib/camera/cameraIntentSource";
import { HandTracker } from "../../lib/camera/handTracker";
import { findLesson } from "../../lib/teaching/curriculum";
import { EXAM_PIECES, GOOD_SCORE, PASS_SCORE, examDimensions, type ExamPiece } from "../../lib/teaching/exam";
import { useAppStore } from "../../state/store";
import styles from "./ExamPage.module.css";

/**
 * 「考试」：用固定的示例歌曲给用户打分，摄像头采集。
 *
 * 和「课程」里的跟练分开，是因为**可比性**：练习曲是现场生成的，每次都不一样，
 * 分数没法横向比；考试用同一批曲目、同一个速度，分数才有意义。
 *
 * 当前状态：曲目音频与打分尚未接入（M6 第 5 步），但**摄像头自检是真的**——
 * 环境检查、开摄像头、认手、看帧率都跑通了，考前该踩的坑现在就能踩完。
 * 页面明说哪部分没做好，而不是摆一个点了没反应的「开始考试」。
 */

type CamState = "idle" | "starting" | "ready" | "error";

/** 认到手之后再等这么久才判定「就绪」，避免一帧误检就报绿灯。 */
const CONFIRM_MS = 800;

export function ExamPage() {
  const openLesson = useAppStore((s) => s.openLesson);
  const [selected, setSelected] = useState<ExamPiece>(EXAM_PIECES[0]);

  const [cam, setCam] = useState<CamState>("idle");
  const [camError, setCamError] = useState("");
  const [hands, setHands] = useState({ left: false, right: false, fps: 0 });
  const sourceRef = useRef<CameraIntentSource | null>(null);
  const [, force] = useState(0);

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

  const dims = examDimensions(selected);

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
          考试用固定的示例歌曲，所有人考同一首、同一个速度 —— 练习曲是现场生成的，
          每次都不一样，分数没法比；考试曲目固定，分数才有意义。全程用摄像头采集，
          按行业标准的几个维度给出具体数字与建议。
        </p>

        <div className={styles.grid}>
          <section className={styles.col}>
            <p className="eyebrow">选择曲目</p>
            <div className={styles.pieces}>
              {EXAM_PIECES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`${styles.piece} ${selected.id === p.id ? styles.pieceActive : ""}`}
                  onClick={() => setSelected(p)}
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
                    <span className="mono-chip">{p.durationSec} 秒</span>
                    <span className={`mono-chip ${styles.notReady}`}>
                      {p.audio ? "曲目就绪" : "曲目未就绪"}
                    </span>
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
          </section>

          <section className={styles.col}>
            <p className="eyebrow">摄像头自检</p>
            <p className={styles.checkHint}>
              考前先确认摄像头能认到手。站远一点，让上半身和两只手都进画面。
            </p>

            {envProblem ? (
              <p className={styles.error}>{envProblem}</p>
            ) : (
              <>
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
                  <Button variant="primary" disabled title="曲目音频与打分尚未接入">
                    开始考试
                  </Button>
                </div>

                <p className={styles.todo}>
                  「开始考试」还点不了：示例歌曲的音频与打分（录制层、DTW 拍型识别、
                  六个维度的计算）是 M6 第 5 步的内容，见 <code>docs/M6_PLAN.md</code>。
                  自检本身是真的，现在就能确认设备行不行。
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
