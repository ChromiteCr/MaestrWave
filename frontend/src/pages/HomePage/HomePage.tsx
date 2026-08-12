import { AgentChat } from "../../components/AgentChat/AgentChat";
import { ConductingTrace } from "../../components/ConductingTrace/ConductingTrace";
import { LESSONS, UNITS } from "../../lib/teaching/curriculum";
import { useAppStore, type PageId } from "../../state/store";
import styles from "./HomePage.module.css";

/**
 * 首页：第一次打开软件时看到的那一屏。
 *
 * 在此之前落地页是「文件」—— 那一页假设了你已经知道这软件是干什么的，
 * 上来就问你要项目名和时长。首页负责补上前面那一步：这是什么、能做什么、
 * 从哪进去。
 *
 * 刻意不用 `PageHeader`：其余页面都是「工作台」，需要统一的页眉；首页是
 * 门厅，页眉在这里只会把招牌视觉挤下去。
 */

/** 「指挥体验」是一条真实的流水线，顺序本身是信息，所以编号。 */
const PIPELINE: { page: PageId; label: string; what: string }[] = [
  { page: "file", label: "文件", what: "新建或打开一个项目" },
  { page: "formation", label: "构型", what: "定下乐器编配与段落走向" },
  { page: "generate", label: "生成", what: "逐件乐器生成音轨" },
  { page: "browse", label: "浏览", what: "试听全曲，不满意就重做某一件" },
  { page: "output", label: "输出", what: "打开摄像头，指挥它演奏" },
];

const SUGGESTIONS = [
  "这个软件能做什么？",
  "我完全不会指挥，从哪开始？",
  "「构型」和「生成」有什么区别？",
  "指挥需要什么设备？",
];

export function HomePage() {
  const setActivePage = useAppStore((s) => s.setActivePage);

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.heroText}>
          <p className="eyebrow">MaestrWave</p>
          <h1 className={styles.title}>
            生成一支管弦乐队，
            <br />
            然后用手指挥它。
          </h1>
          <p className={styles.lede}>
            摄像头认你的手，音量、力度、进出场跟着你走。不会指挥也没关系，
            这里从第一课开始教，练完还能给你打分。
          </p>
          <div className={styles.heroActions}>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => setActivePage("teach")}
            >
              从第一课开始
            </button>
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={() => setActivePage("file")}
            >
              我想直接做曲子
            </button>
          </div>
        </div>

        {/* 招牌视觉。用的是课程与评分共用的那份拍型轨迹，不是另画的装饰图 */}
        <div className={styles.heroArt}>
          <ConductingTrace height={228} />
        </div>
      </header>

      <div className={styles.columns}>
        <div className={styles.doors}>
          <section className={styles.door}>
            <div className={styles.doorHead}>
              <div>
                <p className="eyebrow">指挥教学</p>
                <h2 className={styles.doorTitle}>从零学怎么打拍</h2>
              </div>
              <span className="mono-chip">{LESSONS.length} 课</span>
            </div>
            <p className={styles.doorLede}>
              按行业通行的指挥法教程编排。每课有标准依据、动画示范，跟练完按六个维度打分，
              告诉你差在哪一拍。
            </p>
            {/* 单元不是分类而是依赖链：右手拍型稳了才谈左手，左手能独立了才谈力度 */}
            <ol className={styles.units}>
              {UNITS.map((u) => (
                <li key={u.unit}>
                  <span className={styles.unitNo}>{u.unit}</span>
                  <span className={styles.unitTitle}>{u.title}</span>
                </li>
              ))}
            </ol>
            <div className={styles.doorFoot}>
              <button
                type="button"
                className={styles.doorBtn}
                onClick={() => setActivePage("teach")}
              >
                进入课程 →
              </button>
              <button
                type="button"
                className={styles.doorBtnQuiet}
                onClick={() => setActivePage("teach-exam")}
              >
                或者直接考试，用示例曲目给你打分
              </button>
            </div>
          </section>

          <section className={styles.door}>
            <div className={styles.doorHead}>
              <div>
                <p className="eyebrow">指挥体验</p>
                <h2 className={styles.doorTitle}>做一首，再指挥它</h2>
              </div>
              <span className="mono-chip">5 步</span>
            </div>
            <p className={styles.doorLede}>
              每件乐器一条独立音轨，所以指挥时你能单独控制某一个声部，而不只是整体音量。
            </p>
            <ol className={styles.pipeline}>
              {PIPELINE.map((s, i) => (
                <li key={s.page}>
                  <button type="button" onClick={() => setActivePage(s.page)}>
                    <span className={styles.stepNo}>{String(i + 1).padStart(2, "0")}</span>
                    <span className={styles.stepText}>
                      <span className={styles.stepLabel}>{s.label}</span>
                      <span className={styles.stepWhat}>{s.what}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        </div>

        {/*
          首页的助手入口。和右侧侧栏、课程页内嵌的是**同一段对话**（状态在 store 里）——
          在首页问完「这软件能做什么」，进到课程页接着追问，上下文是连着的。
        */}
        <aside className={styles.askCard}>
          <p className="eyebrow">问助手</p>
          <p className={styles.askSub}>指挥知识和这个软件怎么用，都可以问</p>
          <AgentChat suggestions={SUGGESTIONS} maxHeight={300} />
        </aside>
      </div>
    </div>
  );
}
