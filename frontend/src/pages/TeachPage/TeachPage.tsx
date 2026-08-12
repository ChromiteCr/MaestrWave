import { PageHeader } from "../../components/PageHeader/PageHeader";
import { LESSONS, UNITS, lessonIndex, lessonsOfUnit } from "../../lib/teaching/curriculum";
import { useAppStore } from "../../state/store";
import styles from "./TeachPage.module.css";

/**
 * 「指挥教学」的课程列表。
 *
 * 单元的顺序不是装饰性的分组，是必须按序学的依赖链：左手要能做别的事，前提是右手
 * 已经不用想就能走完拍型；力度变化又建立在拍型稳定之上。所以按单元分栏而不是排成
 * 一个长列表 —— 长列表会让人以为可以随便挑一课开始。
 */
export function TeachPage() {
  const openLesson = useAppStore((s) => s.openLesson);

  return (
    <div>
      <PageHeader
        eyebrow="MaestrWave"
        title="指挥教学"
        meta={<span className="mono-chip">{LESSONS.length} 课</span>}
      />

      <div className={styles.body}>
        <p className={styles.intro}>
          按行业通行的指挥法教程编排：先把打拍手的图形拍型练稳，再谈两只手的独立性，
          最后才是力度与速度变化。这个顺序有先后依赖，表情手要能做别的事，前提是打拍手
          已经能自己走完拍型；力度变化又建立在拍型稳定之上。每课都有标准依据、动画示范、
          现场生成的练习曲，以及打完之后按维度给出的分数和讲评。
        </p>

        <div className={styles.units}>
          {UNITS.map((u) => (
            <section key={u.unit} className={styles.unit}>
              <p className="eyebrow">单元 {u.unit}</p>
              <h2 className={styles.unitTitle}>{u.title}</h2>
              <p className={styles.unitSummary}>{u.summary}</p>

              <div className={styles.lessons}>
                {lessonsOfUnit(u.unit).map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    className={styles.lesson}
                    onClick={() => openLesson(l.id)}
                  >
                    <span className={styles.lessonNo}>{String(lessonIndex(l.id)).padStart(2, "0")}</span>
                    <span className={styles.lessonText}>
                      <span className={styles.lessonTitle}>{l.title}</span>
                      <span className={styles.lessonGoal}>{l.goal}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
