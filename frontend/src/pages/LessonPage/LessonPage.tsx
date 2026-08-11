import { useEffect, useState } from "react";
import { BeatPatternDemo } from "../../components/BeatPatternDemo/BeatPatternDemo";
import { Button } from "../../components/Button/Button";
import { AgentChat } from "../../components/AgentChat/AgentChat";
import { PageHeader } from "../../components/PageHeader/PageHeader";
import { PracticeRunner } from "../../components/PracticeRunner/PracticeRunner";
import { DIMENSIONS, findLesson, lessonIndex, LESSONS, type Lesson } from "../../lib/teaching/curriculum";
import { PATTERNS, type Meter } from "../../lib/teaching/patterns";
import { buildSpec } from "../../lib/teaching/piece";
import { usePracticePiece } from "../../lib/teaching/usePracticePiece";
import { useAppStore } from "../../state/store";
import styles from "./LessonPage.module.css";

/**
 * 单课页：讲解 → 示范 → 跟练 → 评分。
 *
 * 讲解与示范刻意做成**不依赖后端、不依赖摄像头**：没配天琴密钥、没插摄像头的人
 * 也应该能把一课看完。练习曲与打分是加分项，不是前置条件 —— 曲子没渲染好的时候
 * 跟练照样能开始，只是跟的是节拍器。
 *
 * 练习曲在**进页面时就开始渲染**（M6 计划：用学习时间掩盖等待）。符号路线下
 * 这件事很便宜：二十几秒的曲子五秒左右，而且渲染过一次就永久缓存。
 */
/**
 * 本课的建议问题。用课程数据拼，不写死 —— 写死的话加一课就得回来改一次，
 * 而且必然有人忘。第一条永远指向「常见错误」：那是学的人最想问、教材上又最少
 * 展开讲的部分。
 */
function lessonQuestions(lesson: Lesson): string[] {
  const qs = [
    `《${lesson.title}》最常见的错误怎么改？`,
    // 刻意不把 goal 拼进问句 —— goal 是完整的一句话，塞进「为什么要…？」里语法很别扭
    "这一课的标准依据是什么意思？举个例子。",
  ];
  if (lesson.meters.length > 1) {
    qs.push(`${lesson.meters.join("、")} 拍的拍型分别往哪些方向走？`);
  } else if (lesson.meters.length === 1) {
    qs.push(`${lesson.meters[0]} 拍拍型每一拍往哪个方向走？`);
  }
  qs.push("我练的时候该先注意什么？");
  return qs;
}

export function LessonPage() {
  const lessonId = useAppStore((s) => s.activeLessonId);
  const setActivePage = useAppStore((s) => s.setActivePage);
  const openLesson = useAppStore((s) => s.openLesson);
  const hasAgentMessages = useAppStore((s) => s.agentMessages.length > 0);
  const clearAgent = useAppStore((s) => s.clearAgent);
  const lesson = findLesson(lessonId);

  const [meter, setMeter] = useState<Meter>(4);
  const [bpm, setBpm] = useState(88);
  const [playing, setPlaying] = useState(true);
  const [beat, setBeat] = useState(1);

  // 进页面就开始渲染本课的练习曲。拍号是可切的，切了就是另一首 —— 三拍和四拍
  // 的练习曲不该是同一条旋律。
  //
  // 速度用**本课的** bpm，不用下面那个滑块：滑块是「示范速度」，拖一下就是一个
  // 新的 spec，也就是一次新的渲染和一个新的缓存文件 —— 从 40 拖到 180 会留下
  // 一百多首没人再听的曲子。练习曲该有的速度是课程定的那个。
  const spec = lesson
    ? buildSpec(lesson.music, { meter, bpm: lesson.bpm, id: lesson.id })
    : null;
  const practice = usePracticePiece(spec);

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

              {lesson.id !== "one-beat" && (
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
              )}
            </section>
          ) : (
            <section className={styles.card}>
              <p className="eyebrow">示范</p>
              <p className={styles.demoHint}>这一课练的是姿势本身，没有图形拍型可以示范。</p>
            </section>
          )}

          {/* 跟练放主列而不是侧栏：摄像头画面和讲评都需要宽度，320px 的侧栏挤不下 */}
          <section className={styles.card}>
            <p className="eyebrow">跟练</p>
            {lesson.meters.length > 0 ? (
              <>
                <p className={styles.todo}>
                  {practice.state === "ready"
                    ? `跟着练习曲打 ${meter} 拍，${lesson.bpm} BPM，结束后按标准给你打分。曲子开头有一小节数拍。`
                    : practice.state === "preparing"
                      ? "练习曲正在生成 —— 先看讲解和示范，好了会自动换上。现在开始跟练的话跟的是节拍器。"
                      : practice.state === "error"
                        ? `练习曲没生成出来（${practice.error}），跟节拍器一样能练与打分，只是评不了「力度对应」。`
                        : `跟着节拍器打 ${meter} 拍，结束后按标准给你打分。`}
                </p>
                <PracticeRunner
                  meter={meter}
                  bpm={lesson.bpm}
                  rubric={lesson.rubric}
                  piece={practice.piece}
                />
              </>
            ) : (
              <p className={styles.todo}>这一课练的是姿势本身，没有可打分的拍型，照着要点对镜子调整。</p>
            )}
          </section>
        </div>

        <aside className={styles.side}>
          {/*
            课程页内嵌的问答入口。和右侧侧栏是**同一段对话**（状态在 store 里），
            放在这里是因为看讲解时最容易冒出问题，让人先去右边展开侧栏就打断了。
            Agent 的上下文里会自动带上当前这一课的全文，所以可以直接问「这一课」。
          */}
          <section className={styles.card}>
            <div className={styles.askHead}>
              <div>
                <p className="eyebrow">问助手</p>
                <p className={styles.askSub}>关于《{lesson.title}》，随时问</p>
              </div>
              {hasAgentMessages && (
                <button type="button" className={styles.askClear} onClick={clearAgent}>
                  清空
                </button>
              )}
            </div>
            <AgentChat suggestions={lessonQuestions(lesson)} maxHeight={280} />
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
