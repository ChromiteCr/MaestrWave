import { useEffect, useState } from "react";
import { sharedAudioEngine } from "../../lib/audioEngine";
import { BeatPatternDemo } from "../BeatPatternDemo/BeatPatternDemo";
import { PATTERNS, type Meter } from "../../lib/teaching/patterns";
import styles from "./BeatIndicator.module.css";

/**
 * 乐曲现在走到第几小节第几拍 —— 画成**图形拍型**，不是一排圆点。
 *
 * 指挥的时候光看音量条是不够的：那些条只说「响不响」，说不出**这一拍是小节里的
 * 哪一拍**。而拍号一错，后面整段都是错的，用户却往往到结束才发现。
 *
 * 一排圆点能回答「第几拍」，但答不了紧接着的那个问题：**手该往哪儿走**。
 * 图形拍型两个都答得了 —— 亮的那个点就是当前拍，而它在图上的位置就是手该到的
 * 地方。用的是 `lib/teaching/patterns.ts` 里那份轨迹，和「指挥教学」示范的、
 * 跟练时叠在轨迹上的、评分时比对的是同一份：教你的和考你的必须是一个东西。
 *
 * 位置取自 `AudioEngine.musicSeconds()` —— 按倍速积分出来的**曲子时间**，
 * 不是墙上时间。指挥把速度压到 0.7 倍时两者每秒差 0.3 秒，用墙上时间的话
 * 指示器会越走越前，那比不显示更糟。
 *
 * 拍号不在 1/2/3/4 之内（6/8 之类）时没有对应图形，退回一排圆点 ——
 * 少一层信息好过整块不显示。
 */
export function BeatIndicator({ bpm, beatsPerBar, running }: {
  bpm: number;
  beatsPerBar: number;
  running: boolean;
}) {
  /** 从起播算起的绝对拍数（0 起）。`BeatPatternDemo` 自己会对小节取模。 */
  const [beat, setBeat] = useState(0);

  useEffect(() => {
    if (!running || bpm <= 0 || beatsPerBar <= 0) return;
    // 50ms 一次：比一拍（最快也有 300ms）密得多，够看出跳变；又不至于每帧重渲染。
    // 中间那些帧由 BeatPatternDemo 自己按 bpm 插值，光点是连续走的。
    // 不用 requestAnimationFrame —— 页面被切到后台时它会被节流甚至停掉，
    // 而指挥时用户完全可能把窗口放到一边看手机。
    const id = setInterval(() => {
      setBeat(Math.max(0, Math.floor(sharedAudioEngine.musicSeconds() / (60 / bpm))));
    }, 50);
    return () => clearInterval(id);
  }, [running, bpm, beatsPerBar]);

  if (!running) return null;

  const bar = Math.floor(beat / beatsPerBar) + 1;
  const inBar = (beat % beatsPerBar) + 1;
  const meter = (beatsPerBar >= 1 && beatsPerBar <= 4 ? beatsPerBar : null) as Meter | null;

  return (
    <div className={styles.wrap}>
      <span className={styles.title}>乐曲拍位</span>
      {meter ? (
        <BeatPatternDemo meter={meter} bpm={bpm} playing compact beat={beat} height={104} />
      ) : (
        <div className={styles.dots}>
          {Array.from({ length: beatsPerBar }, (_, i) => (
            <span
              key={i}
              className={[
                styles.dot,
                i + 1 === inBar ? styles.dotOn : "",
                // 强拍单独标出来。指挥最要紧的信息不是「第几拍」而是「小节从哪儿起」
                i === 0 ? styles.dotDown : "",
              ].join(" ")}
            />
          ))}
        </div>
      )}
      <span className={styles.readout}>
        第 {bar} 小节 · 第 <strong>{inBar}</strong> / {beatsPerBar} 拍
      </span>
    </div>
  );
}
