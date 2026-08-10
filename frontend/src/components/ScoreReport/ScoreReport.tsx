import { PASS_SCORE, GOOD_SCORE } from "../../lib/teaching/exam";
import type { SessionScore } from "../../lib/teaching/scoring";
import styles from "./ScoreReport.module.css";

/**
 * 讲评。
 *
 * 刻意不做成一个大分数配几颗星：文献承认人工评审的问题常常出在评语说不清楚，
 * 所以这里每一维都摆出**具体数字**（偏了多少毫秒、变异系数多少、DTW 距离多少）
 * 和**一句能照着改的建议**。总分只是顺带给的。
 */

function grade(total: number): { label: string; tone: string } {
  if (total >= GOOD_SCORE) return { label: "优秀", tone: styles.good };
  if (total >= PASS_SCORE) return { label: "及格", tone: styles.pass };
  return { label: "还需再练", tone: styles.fail };
}

export function ScoreReport({ score }: { score: SessionScore }) {
  const g = grade(score.total);
  return (
    <section className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.totalBox}>
          <span className={`${styles.total} ${g.tone}`}>{score.total}</span>
          <span className={styles.grade}>{g.label}</span>
        </div>
        <div className={styles.summary}>
          <span className="mono-chip">
            拍点 {score.beats.matched}/{score.beats.expected}
          </span>
          <span className="mono-chip">完整小节 {score.bars}</span>
          <span className="mono-chip">
            {Math.abs(score.bias) < 15 ? "无系统性偏移" : score.bias > 0 ? `平均晚 ${score.bias.toFixed(0)}ms` : `平均早 ${Math.abs(score.bias).toFixed(0)}ms`}
          </span>
        </div>
      </div>

      <ul className={styles.dims}>
        {score.dimensions.map((d) => (
          <li key={d.dimension} className={d.score === null ? styles.dimOff : ""}>
            <div className={styles.dimHead}>
              <span className={styles.dimLabel}>{d.label}</span>
              <span className={styles.dimScore}>
                {d.score === null ? d.unavailable : Math.round(d.score)}
              </span>
            </div>
            {d.score !== null && (
              <div className={styles.bar}>
                <span style={{ width: `${Math.round(d.score)}%` }} />
              </div>
            )}
            <p className={styles.detail}>{d.detail}</p>
            <p className={styles.advice}>{d.advice}</p>
            {d.score !== null && (
              <p className={styles.weight}>占本课总分 {Math.round(d.weight * 100)}%</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
