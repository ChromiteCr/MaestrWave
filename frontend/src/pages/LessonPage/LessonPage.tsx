import { useEffect, useState } from "react";
import { BeatPatternDemo } from "../../components/BeatPatternDemo/BeatPatternDemo";
import { Button } from "../../components/Button/Button";
import { PageHeader } from "../../components/PageHeader/PageHeader";
import { DIMENSIONS, findLesson, lessonIndex, LESSONS } from "../../lib/teaching/curriculum";
import { PATTERNS, type Meter } from "../../lib/teaching/patterns";
import { useAppStore } from "../../state/store";
import styles from "./LessonPage.module.css";

/**
 * 单课页：讲解 → 示范 → （跟练 → 评分，后两步待实现）。
 *
 * 讲解与示范刻意做成**不依赖后端、不依赖摄像头**：没配天琴密钥、没插摄像头的人
 * 也应该能把一课看完。练习曲与打分是加分项，不是前置条件。
 */
export function LessonPage() {
  const lessonId = useAppStore((s) => s.activeLessonId);
  const setActivePage = useAppStore((s) => s.setActivePage);
  const openLesson = useAppStore((s) => s.openLesson);
  const lesson = findLesson(lessonId);

  const [meter, setMeter] = useState<Meter>(4);
  const [bpm, setBpm] = useState(88);
  const [playing, setPlaying] = useState(true);
  const [beat, setBeat] = useState(1);

  // 换课时把示范参数拉回本课的默认值，否则会带着上一课的 168 BPM 进来
  useEffect(() => {
    if (!lesson) return;
    setMeter(lesson.meters[0] ?? 4);
    setBpm(lesson.bpm);
    setPlaying(true);
    setBeat(1);
  }, [lesson?.id]);

  if (!lesson) {
    return (
      <div>
        <PageHeader eyebrow="指挥教学" title="课程" />
        <div className={styles.body}>
          <p className={styles.empty}>没有选中的课程。</p>
          <Button onClick={() => setActivePage("teach")}>回到课程列表</Button>
        </div>
      </div>
    );
  }

  const idx = lessonIndex(lesson.id);
  const prev = LESSONS[idx - 2];
  const next = LESSONS[idx];

  return (
    <div>
      <PageHeader
        eyebrow={`单元 ${lesson.unit} · 第 ${idx} 课`}
        title={lesson.title}
        meta={
          <>
            <span className="mono-chip">{lesson.bpm} BPM</span>
            {lesson.meters.length > 0 && (
              <span className="mono-chip">{lesson.meters.map((m) => `${m}/4`).join(" · ")}</span>
            )}
          </>
        }
        actions={
          <Button variant="ghost" onClick={() => setActivePage("teach")}>
            课程列表
          </Button>
        }
      />

      <div className={styles.body}>
        <div className={styles.main}>
          <section className={styles.card}>
            <p className="eyebrow">这一课要练成什么</p>
            <p className={styles.goal}>{lesson.goal}</p>

            <p className="eyebrow" style={{ marginTop: 24 }}>
              标准依据
            </p>
            <p className={styles.standard}>{lesson.standard}</p>

            <p className="eyebrow" style={{ marginTop: 24 }}>
              要点
            </p>
            <ol className={styles.points}>
              {lesson.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ol>

            <p className="eyebrow" style={{ marginTop: 24 }}>
              常见错误
            </p>
            <ul className={styles.pitfalls}>
              {lesson.pitfalls.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </section>

          {lesson.meters.length > 0 ? (
            <section className={styles.card}>
              <div className={styles.demoHead}>
                <div>
                  <p className="eyebrow">示范</p>
                  <p className={styles.demoHint}>
                    {PATTERNS[meter].mnemonic.join(" → ")} · 第 {beat} 拍 ——
                    光点走的就是标准轨迹，跟练与评分照着比的也是它。
                  </p>
                </div>
                <div className={styles.demoControls}>
                  {lesson.meters.length > 1 && (
                    <div className={styles.tabs}>
                      {lesson.meters.map((m) => (
                        <button
                          key={m}
                          type="button"
                          className={`${styles.tab} ${meter === m ? styles.tabActive : ""}`}
                          onClick={() => setMeter(m)}
                        >
                          {m}/4
                        </button>
                      ))}
                    </div>
                  )}
                  <Button variant="ghost" onClick={() => setPlaying((p) => !p)}>
                    {playing ? "暂停" : "播放"}
                  </Button>
                </div>
              </div>

              <BeatPatternDemo meter={meter} bpm={bpm} playing={playing} onBeat={setBeat} />

              <label className={styles.speed}>
                <span className="field-label">示范速度</span>
                <input
                  type="range"
                  min={40}
                  max={180}
                  value={bpm}
                  onChange={(e) => setBpm(Number(e.target.value))}
                />
                <span className="mono-chip">{bpm} BPM</span>
              </label>
            </section>
          ) : (
            <section className={styles.card}>
              <p className="eyebrow">示范</p>
              <p className={styles.demoHint}>这一课练的是姿势本身，没有图形拍型可以示范。</p>
            </section>
          )}
        </div>

        <aside className={styles.side}>
          <section className={styles.card}>
            <p className="eyebrow">跟练</p>
            <p className={styles.todo}>
              {lesson.meters.length > 0
                ? "摄像头跟练与练习曲生成还在开发中。现在可以先对着示范空手比划，把拍型走顺再上摄像头。"
                : "摄像头跟练与练习曲生成还在开发中。这一课先照着要点对镜子调整姿势。"}
            </p>
          </section>

          <section className={styles.card}>
            <p className="eyebrow">本课评什么</p>
            <ul className={styles.rubric}>
              {lesson.rubric.map((r) => {
                const d = DIMENSIONS[r.dimension];
                return (
                  <li key={r.dimension}>
                    <div className={styles.rubricHead}>
                      <span className={styles.rubricLabel}>{d.label}</span>
                      <span className="mono-chip">{Math.round(r.weight * 100)}%</span>
                    </div>
                    <p className={styles.rubricHow}>{d.how}</p>
                    <p className={styles.rubricBasis}>{d.basis}</p>
                  </li>
                );
              })}
            </ul>
          </section>
        </aside>

        <nav className={styles.pager}>
          {prev ? (
            <Button variant="ghost" onClick={() => openLesson(prev.id)}>
              ← {prev.title}
            </Button>
          ) : (
            <span />
          )}
          {next && (
            <Button variant="primary" onClick={() => openLesson(next.id)}>
              {next.title} →
            </Button>
          )}
        </nav>
      </div>
    </div>
  );
}
