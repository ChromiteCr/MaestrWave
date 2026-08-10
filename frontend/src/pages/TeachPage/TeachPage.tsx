import { PageHeader } from "../../components/PageHeader/PageHeader";
import styles from "./TeachPage.module.css";

/**
 * 「指挥教学」的落地页。目前是占位 —— M6 第 3 步会把 ConductIT 单元一二三的课程
 * 数据接进来，替换掉下面这份大纲。先立住一级导航的另一半，导航改动才能独立验证。
 */

const UNITS: { unit: string; title: string; lessons: string[] }[] = [
  {
    unit: "单元一",
    title: "拍子怎么打",
    lessons: ["站姿与手的位置", "预备拍", "基本图形拍型（2/3/4 拍）", "收拍"],
  },
  {
    unit: "单元二",
    title: "两只手分开用",
    lessons: ["非持棒手的职责", "主动拍与被动拍", "打 1 拍", "从非第一拍起"],
  },
  {
    unit: "单元三",
    title: "把音乐讲出来",
    lessons: ["延音", "力度：拍型的大小", "渐慢与渐快"],
  },
];

export function TeachPage() {
  return (
    <div>
      <PageHeader
        eyebrow="MaestrWave"
        title="指挥教学"
        meta={<span className="mono-chip">11 课 · 建设中</span>}
      />

      <div className={styles.body}>
        <p className={styles.intro}>
          按行业通行的指挥法教程编排：先把右手的图形拍型练稳，再谈两只手的独立性，
          最后才是力度与速度变化。每课都会现场生成一首针对本课的练习曲，指挥完按
          拍点准确度、速度稳定性、拍型准确度等维度给出具体数字与建议。
        </p>

        <div className={styles.units}>
          {UNITS.map((u) => (
            <section key={u.unit} className={styles.unit}>
              <p className="eyebrow">{u.unit}</p>
              <h2 className={styles.unitTitle}>{u.title}</h2>
              <ol className={styles.lessons}>
                {u.lessons.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ol>
            </section>
          ))}
        </div>

        <p className={styles.note}>课程内容与摄像头跟练还在开发中，先从「指挥体验」开始试。</p>
      </div>
    </div>
  );
}
