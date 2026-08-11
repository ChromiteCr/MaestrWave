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

/**
 * 逐拍的偏差时间线。
 *
 * 「平均偏了 40ms」这句话没法照着改 —— 用户不知道是哪几下偏的。画出来就一眼
 * 看得见：是每小节第 1 拍抢、还是打到后面越来越拖、还是某几拍整个没打出来。
 * 这是讲评页里唯一能指出**具体某一拍**的东西。
 */
function BeatTimeline({ timeline, beatMs, meter }: {
  timeline: SessionScore["timeline"]; beatMs: number; meter: number;
}) {
  // 满量程 = 四分之一拍，和跟练时那根指针同一把尺子
  const full = beatMs * 0.25;
  const good = Math.max(45, beatMs * 0.07);
  const missed = timeline.filter((p) => p.offsetMs === null).length;
  return (
    <div className={styles.timeline}>
      <div className={styles.timelineHead}>
        <span className="eyebrow">每一拍偏在哪</span>
        <span className={styles.timelineLegend}>
          上=拖　下=抢　空=没打出来{missed ? `（${missed} 拍）` : ""}
        </span>
      </div>
      <div className={styles.timelineTrack}>
        <span className={styles.timelineZero} />
        {timeline.map((p) => {
          // 半格 = 从中线到顶。h 是有符号的：正数往上（拖），负数往下（抢）
          const h = p.offsetMs === null ? 0 : Math.max(-50, Math.min(50, (p.offsetMs / full) * 50));
          const downbeat = p.beat % meter === 0;
          const where = `第 ${Math.floor(p.beat / meter) + 1} 小节第 ${(p.beat % meter) + 1} 拍`;
          return (
            <span
              key={p.beat}
              className={styles.tick}
              title={
                p.offsetMs === null
                  ? `${where}：没打出来`
                  : `${where}：${p.offsetMs > 0 ? "晚" : "早"} ${Math.abs(p.offsetMs).toFixed(0)}ms`
              }
            >
              <span
                className={
                  `${styles.tickBar} ${p.offsetMs === null ? styles.tickMiss : ""} ` +
                  `${downbeat ? styles.tickDown : ""} ` +
                  `${p.offsetMs !== null && Math.abs(p.offsetMs) <= good ? styles.tickGood : ""}`
                }
                // 柱子绝对定位在全高的格子里，一端钉在中线上，另一端按偏差长出去。
                // 用相对定位 + bottom:50% 是不行的：那是「相对自己原位平移」，
                // 偏差一大柱子就整根跑到框外去了。
                style={
                  p.offsetMs === null
                    ? { top: "calc(50% - 2px)", height: 4 }
                    : h >= 0
                      ? { bottom: "50%", height: `${Math.max(3, h)}%` }
                      : { top: "50%", height: `${Math.max(3, -h)}%` }
                }
              />
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function ScoreReport({ score, beatMs }: { score: SessionScore; beatMs?: number }) {
  const g = grade(score.total);
  return (
    <section className={styles.wrap}>
      {/*
        两条「先看这个」的提示。放在分数**上面**而不是塞进某一维里：
        它们说的是「这次的分数为什么不该照字面理解」，看完再看分数才有意义。
      */}
      {score.suspectLatency && (
        <p className={styles.banner}>
          你的每一拍都稳定地{score.bias > 0 ? "晚" : "早"} {Math.abs(score.bias).toFixed(0)}ms，
          而彼此之间只差 {score.spread.toFixed(0)}ms —— 这么整齐的偏移通常是声音的传输延迟
          （蓝牙耳机常见 150~250ms），不是你的问题。去「设置」里做一次音画延迟校准，
          再打一遍看看。
        </p>
      )}
      {score.tooSmall && (
        <p className={styles.banner}>
          你的拍型只占画面的 {(score.patternSize * 100).toFixed(0)}% ——
          太小了，摄像头看不清，几个维度的分数都会跟着失真。
          手抬到胸口与肩之间，把动作放大到画面的三分之一左右再来一遍。
        </p>
      )}

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
            {Math.abs(score.bias) < 15 ? "无系统性偏移" : score.bias > 0 ? `整体晚 ${score.bias.toFixed(0)}ms` : `整体早 ${Math.abs(score.bias).toFixed(0)}ms`}
          </span>
          <span className="mono-chip">落点散度 {score.spread.toFixed(0)}ms</span>
        </div>
      </div>

      {beatMs && score.timeline.length >= 4 && (
        <BeatTimeline timeline={score.timeline} beatMs={beatMs} meter={score.meter} />
      )}

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
