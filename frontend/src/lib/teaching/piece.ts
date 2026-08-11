/**
 * 练习曲 / 考试曲目的规格。
 *
 * 曲子从 M7e 起是**写谱渲染**出来的（`backend/practice.py`），不再喂提示词给
 * 音频生成模型。前端这边只需要知道一件事：**spec 就是曲子本身** —— 同一份 spec
 * 后端永远渲染出同一份音频。于是
 *
 *   - 课程的练习曲：spec 由课程数据算出来，同一课重练拿到的是同一首（缓存命中，
 *     秒开），换个拍号练就是另一首。
 *   - 考试曲目：spec 是写死的常量，所以「所有人考同一首」不需要往仓库里塞音频
 *     文件，也不需要相信生成模型两次给出一样的东西。
 *
 * 拍网格由 spec 决定而不是从音频里检测：`count_in_bars` 个小节的数拍之后就是
 * 第 0 拍，误差为零。
 */

import type { PracticeSpec } from "../api";
import type { Meter } from "./patterns";

/** 课程/考试数据里声明的那部分，其余（拍号、速度）由课程本身给。 */
export interface PieceMusic {
  /** 织体与配器：march=进行曲，waltz=圆舞曲（蓬-恰-恰），lyric=抒情长句。 */
  style: PracticeSpec["style"];
  /** 正曲小节数，不含数拍。跟练打满这么多小节就停。 */
  bars: number;
  /**
   * 每小节的目标力度 0~1。
   *
   * 这是「力度对应」那一维的**真值** —— 写下的，不是从音频里测的。拿渲染出来的
   * 音频算 RMS 只能得到一个被混响和配器染过的近似值，而这里直接就是作曲时的意图。
   */
  dynamics: number[];
  /** 弱起：正曲第一个强拍之前先出一个音。 */
  pickup?: boolean;
  key?: string;
}

/** 数拍小节数。一小节是教材里的通行做法，够用户把手抬起来。 */
export const COUNT_IN_BARS = 1;

/**
 * 字符串 → 稳定的种子。
 *
 * 不能用 JS 里随手写的那种带 `Math.random` 或依赖对象顺序的做法：种子一变，
 * piece_id 就变，缓存全部失效、而且「同一课两次练的是同一首」这个承诺就没了。
 * FNV-1a，32 位，跨浏览器跨版本结果一致。
 */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 1; // 后端按 31 位截，这里先去掉符号位免得两边对不上
}

/** 课程/考试数据 + 拍号速度 → 完整 spec。 */
export function buildSpec(music: PieceMusic, opts: {
  meter: Meter;
  bpm: number;
  /** 种子的来源文本（课程 id、考试曲目 id）。同样的文本永远得到同一首。 */
  id: string;
}): PracticeSpec {
  return {
    style: music.style,
    meter: opts.meter,
    bpm: opts.bpm,
    bars: music.bars,
    count_in_bars: COUNT_IN_BARS,
    key: music.key ?? "D major",
    dynamics: music.dynamics,
    pickup: music.pickup ?? false,
    // 拍号进种子：同一课换个拍号练，旋律也该换一条，否则三拍和四拍听起来是同一首
    seed: seedOf(`${opts.id}/${opts.meter}/${opts.bpm}`),
  };
}
