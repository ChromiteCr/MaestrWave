/**
 * 移植自 legacy/js/audio-engine.js，扩展了多轨 solo 预览和"统一起播时钟"
 * （浏览页"播放全部"要用），并加入按 track 查询当前播放位置的能力
 * （波形组件画播放头要用）。核心 Web Audio 图结构不变：
 * source -> gain -> panner -> masterGain -> destination。
 */
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

  async loadTrack(id: string, url: string, pan = 0): Promise<AudioBuffer> {
    if (!this.ctx || !this.masterGain) throw new Error("AudioEngine 未初始化");
    const resp = await fetch(url);
    const arrayBuffer = await resp.arrayBuffer();
    const buffer = await this.ctx.decodeAudioData(arrayBuffer);

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
      track.gain.gain.linearRampToValueAtTime(value, this.ctx.currentTime + 0.05);
    }
  }

  setMasterVolume(value: number): void {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.linearRampToValueAtTime(value, this.ctx.currentTime + 0.05);
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
