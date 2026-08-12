/**
 * 移植自 legacy/js/audio-engine.js，扩展了多轨 solo 预览和"统一起播时钟"
 * （浏览页"播放全部"要用），并加入按 track 查询当前播放位置的能力
 * （波形组件画播放头要用）。核心 Web Audio 图结构不变：
 * source -> gain -> panner -> masterGain -> destination。
 */
import { VOLUME_TIME_CONSTANT } from "./gestureConstants";

export interface TrackInfo {
  id: string;
  buffer: AudioBuffer;
  gain: GainNode;
  panner: StereoPannerNode;
  source: AudioBufferSourceNode | null;
  startedAtCtxTime: number;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  masterGain: GainNode | null = null;
  private tracks = new Map<string, TrackInfo>();
  isPlaying = false;

  async init(): Promise<void> {
    if (this.ctx) return;
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new Ctor();
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);
  }

  async resume(): Promise<void> {
    if (this.ctx?.state === "suspended") await this.ctx.resume();
  }

  /**
   * 取回音频并解码成一条可播的轨。
   *
   * **解码失败会重试。** `decodeAudioData` 在同时解好几条长音轨时会偶发
   * `EncodingError: Unable to decode audio data`，而同一个文件隔一会儿再解就是好的
   * （实测：失败那条重新 fetch + decode 立刻成功，文件本身完好）。真实交响乐一次
   * 进来十几个声部、每条四五兆，正好是最容易撞上的场景。
   *
   * 失败一次就放弃的代价不是「少一条轨」而是**整页卡死**：波形永远停在呼吸动画、
   * 指挥启动时那一条抛出来会让整个 `start()` 挂掉。
   */
  async loadTrack(id: string, url: string, pan = 0): Promise<AudioBuffer> {
    if (!this.ctx || !this.masterGain) throw new Error("AudioEngine 未初始化");

    let buffer: AudioBuffer | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3 && !buffer; attempt++) {
      // 隔一会儿再试。等的是解码器让出资源，不是网络 —— 所以第二次也重新 fetch：
      // decodeAudioData 会把 ArrayBuffer 置为 detached，同一份数据没法重解
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * attempt));
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
        buffer = await this.ctx.decodeAudioData(await resp.arrayBuffer());
      } catch (e) {
        lastErr = e;
      }
    }
    if (!buffer) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));

    this.tracks.get(id)?.source?.stop();

    const gain = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    gain.connect(panner);
    panner.connect(this.masterGain);

    this.tracks.set(id, { id, buffer, gain, panner, source: null, startedAtCtxTime: 0 });
    return buffer;
  }

  getBuffer(id: string): AudioBuffer | null {
    return this.tracks.get(id)?.buffer ?? null;
  }

  unload(id: string): void {
    const t = this.tracks.get(id);
    if (t?.source) {
      try {
        t.source.stop();
      } catch {
        /* already stopped */
      }
    }
    this.tracks.delete(id);
  }

  /**
   * 只留下这些 id，其余全部卸掉。**换项目时必须调**。
   *
   * 两个理由，都不是省内存那么轻：
   * 1. `playAll()` 播的是「所有已加载的轨」。不卸的话，在 A 项目听过的声部会跟着
   *    B 项目一起响 —— 十四个声部的交响乐叠在别人的曲子上。
   * 2. AudioBuffer 是解码后的 32 位浮点，一条 46 秒的轨就是 8MB。项目开多了
   *    就一路堆着，而解码器撑不住时的表现正是那个偶发的 EncodingError
   *    （见 `loadTrack`）。
   */
  keepOnly(ids: Iterable<string>): void {
    const keep = new Set(ids);
    for (const id of Array.from(this.tracks.keys())) {
      if (!keep.has(id)) this.unload(id);
    }
  }

  duration(id: string): number {
    return this.tracks.get(id)?.buffer.duration ?? 0;
  }

  /** 统一起播所有已加载的轨道（浏览页"播放全部"）。 */
  playAll(): void {
    if (!this.ctx) return;
    const startTime = this.ctx.currentTime + 0.05;
    for (const track of this.tracks.values()) {
      this._start(track, startTime);
    }
    this.isPlaying = true;
  }

  /** 只播放某一轨（生成页单乐器预览 / 浏览页点击单独试听）。 */
  playOne(id: string): void {
    if (!this.ctx) return;
    const track = this.tracks.get(id);
    if (!track) return;
    this.stop();
    const startTime = this.ctx.currentTime + 0.03;
    this._start(track, startTime);
    this.isPlaying = true;
  }

  private _start(track: TrackInfo, startTime: number): void {
    if (!this.ctx) return;
    track.source?.stop();
    const source = this.ctx.createBufferSource();
    source.buffer = track.buffer;
    source.loop = true;
    source.connect(track.gain);
    source.start(startTime);
    track.source = source;
    track.startedAtCtxTime = startTime;
  }

  stop(): void {
    for (const track of this.tracks.values()) {
      if (track.source) {
        try {
          track.source.stop();
        } catch {
          /* already stopped */
        }
        track.source = null;
      }
    }
    this.isPlaying = false;
  }

  /** 播放头位置（秒），供波形组件渲染；轨道未播放时返回 0。 */
  playheadSeconds(id: string): number {
    const track = this.tracks.get(id);
    if (!this.ctx || !track?.source) return 0;
    const elapsed = this.ctx.currentTime - track.startedAtCtxTime;
    const dur = track.buffer.duration || 1;
    return ((elapsed % dur) + dur) % dur;
  }

  setTrackVolume(id: string, value: number): void {
    const track = this.tracks.get(id);
    if (track && this.ctx) {
      track.gain.gain.setTargetAtTime(value, this.ctx.currentTime, VOLUME_TIME_CONSTANT);
    }
  }

  setMasterVolume(value: number): void {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(value, this.ctx.currentTime, VOLUME_TIME_CONSTANT);
    }
  }

  setPlaybackRate(rate: number): void {
    if (!this.ctx) return;
    for (const track of this.tracks.values()) {
      track.source?.playbackRate.linearRampToValueAtTime(rate, this.ctx.currentTime + 0.1);
    }
  }

  trackIds(): string[] {
    return Array.from(this.tracks.keys());
  }
}

/** 全局唯一实例：AudioContext 数量有限，整个 app 共用一个引擎。 */
export const sharedAudioEngine = new AudioEngine();
