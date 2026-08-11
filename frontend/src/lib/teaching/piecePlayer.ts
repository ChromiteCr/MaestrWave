/**
 * 播放练习曲 / 考试曲目，并给出拍网格。
 *
 * 和 `Metronome` 是同一个位置上的两个实现：都负责「出声 + 告诉评分第 0 拍在
 * 哪一刻」。`PracticeRunner` 按曲子准备好没有二选一，录制与评分那边一行都不用改。
 *
 * ## 为什么网格是算出来的而不是检测出来的
 *
 * 曲子是我们自己写的谱（`backend/practice.py`），第一小节第一拍精确落在数拍
 * 结束那一刻，速度是写进 MIDI 的常数。所以只要知道**音频从哪一刻开始播**，
 * 整条网格就确定了 —— M6 计划里那套「能量起始点检测 + 置信度低时让用户跟拍
 * 手动校准」在符号路线下整个不需要。
 *
 * ## 两个时钟
 *
 * 和 `Metronome` 完全一样：手势用 `performance.now()`，音频用
 * `AudioContext.currentTime`，起播时记一对锚点。输出延迟同样要补 —— 用户跟的是
 * **听到的**声音，不补就是给每个人加一个几十毫秒的系统性「拖拍」。
 */

import { outputLatency, type BeatGrid } from "./metronome";

/** 排程提前量，和 Metronome 保持一致。 */
const LEAD_S = 0.12;

export class PiecePlayer {
  private ctx: AudioContext | null = null;
  private node: AudioBufferSourceNode | null = null;
  private startCtx = 0;

  grid: BeatGrid | null = null;
  /** 音频总长（秒）。含数拍与尾巴，比正曲长。 */
  duration = 0;

  get running(): boolean {
    return this.node !== null;
  }

  /**
   * 下载、解码、起播，返回拍网格。
   *
   * @param gridOffsetSec 音频开头到**正曲第一拍**的秒数（整段数拍的长度）。
   *   后端 `beat_grid.offset` 给的就是它。
   */
  async start(url: string, opts: {
    bpm: number;
    meter: number;
    gridOffsetSec: number;
    signal?: AbortSignal;
  }): Promise<BeatGrid> {
    this.stop();

    // 先下载解码，再建 AudioContext —— 反过来的话，解码这段时间里 context 已经
    // 在走，`currentTime` 早就跑过了我们算出来的起播时刻。
    const res = await fetch(url, { signal: opts.signal });
    if (!res.ok) throw new Error(`取练习曲失败：HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();

    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    if (ctx.state === "suspended") await ctx.resume();
    this.ctx = ctx;

    const buffer = await ctx.decodeAudioData(bytes);
    this.duration = buffer.duration;

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);

    this.startCtx = ctx.currentTime + LEAD_S;
    node.start(this.startCtx);
    this.node = node;

    // 网格原点 = 音频起播 + 数拍时长 + 输出延迟
    const originPerf =
      performance.now() + (LEAD_S + opts.gridOffsetSec + outputLatency(ctx)) * 1000;
    this.grid = { bpm: opts.bpm, meter: opts.meter, originPerf };
    return this.grid;
  }

  stop(): void {
    if (this.node) {
      try {
        this.node.stop();
      } catch {
        // 还没 start 过就 stop 会抛，无所谓
      }
      this.node.disconnect();
    }
    this.node = null;
    void this.ctx?.close();
    this.ctx = null;
    this.grid = null;
  }

  /** 当前拍号（含小数，数拍期间为负）。没起播时返回 null。 */
  beatNow(): number | null {
    if (!this.grid) return null;
    return ((performance.now() - this.grid.originPerf) / 1000) * (this.grid.bpm / 60);
  }

  /** 音频是不是已经放完了。 */
  get finished(): boolean {
    if (!this.ctx) return false;
    return this.ctx.currentTime >= this.startCtx + this.duration;
  }
}
