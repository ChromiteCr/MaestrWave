/**
 * 移植自 legacy/js/audio-engine.js，扩展了多轨 solo 预览和"统一起播时钟"
 * （浏览页"播放全部"要用），并加入按 track 查询当前播放位置的能力
 * （波形组件画播放头要用）。核心 Web Audio 图结构不变：
 * source -> gain -> panner -> masterGain -> destination。
 */
import { VOLUME_TIME_CONSTANT } from "./gestureConstants";
import { looksLikeWav } from "./wavDecode";

export interface TrackInfo {
  id: string;
  buffer: AudioBuffer;
  gain: GainNode;
  panner: StereoPannerNode;
  source: AudioBufferSourceNode | null;
  startedAtCtxTime: number;
}

/**
 * 「取回来的不是音频」得说清是哪一种，否则查不下去：拿到 HTML（dev server 顶上来的
 * 首页）、拿到空响应、和拿到半截文件，是三个完全不同的原因。
 */
function describeNotAudio(buf: ArrayBuffer, resp: Response): string {
  const ct = resp.headers.get("content-type") || "未知类型";
  if (buf.byteLength === 0) return `取回来是空的（${ct}）`;
  const head = new TextDecoder().decode(buf.slice(0, 12)).replace(/[^\x20-\x7e]/g, ".");
  return `取回来的不是音频：${resp.url || "?"} → ${buf.byteLength} 字节、${ct}、开头 ${JSON.stringify(head)}`;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  masterGain: GainNode | null = null;
  private tracks = new Map<string, TrackInfo>();
  /** 解码排队用的尾指针。理由见 `loadTrack`：并发解码正是失败的病因。 */
  private decodeChain: Promise<unknown> = Promise.resolve();
  /** 总线上的移调节点。拿不到（浏览器不支持 AudioWorklet）就是 null，变速会变调。 */
  private pitchNode: AudioWorkletNode | null = null;
  isPlaying = false;

  // ---- 曲子走到第几秒 ----
  // 不能用「墙上时间 × 1」算：变速之后墙上一秒不等于曲子一秒。这里按**倍速积分**，
  // 每次改速度先把上一段按旧倍速结算掉。拍号指示器和播放头都依赖它。
  private rate = 1;
  private rateSince = 0;
  private musicElapsed = 0;

  async init(): Promise<void> {
    if (this.ctx) return;
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new Ctor();
    this.masterGain = this.ctx.createGain();
    await this.attachPitchShifter();
  }

  /**
   * 总线接上移调节点，把变速带来的音高变化抵消掉（见 `pitchShifter.worklet.js`）。
   *
   * 接不上就直连 —— 变速会变调，但至少有声音。这条退路是认真的：AudioWorklet 要
   * 安全上下文，而这个软件在局域网 http 下用手机访问是**正常用法**（扫码指挥）。
   */
  private async attachPitchShifter(): Promise<void> {
    const ctx = this.ctx!;
    const master = this.masterGain!;
    try {
      const url = new URL("./pitchShifter.worklet.js", import.meta.url);
      await ctx.audioWorklet.addModule(url);
      this.pitchNode = new AudioWorkletNode(ctx, "pitch-shifter", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      });
      master.connect(this.pitchNode);
      this.pitchNode.connect(ctx.destination);
    } catch (e) {
      console.warn("移调节点没装上，变速时音高会跟着变", e);
      this.pitchNode = null;
      master.connect(ctx.destination);
    }
  }

  async resume(): Promise<void> {
    if (this.ctx?.state === "suspended") await this.ctx.resume();
  }

  /**
   * 取回音频并解码成一条可播的轨。
   *
   * **解码之前先认一眼取回来的是不是音频**（`looksLikeWav`）。少了这一步，一个
   * 拼错的 URL 会以「Decoding failed」的面目出现 —— dev server 对认不出的路径
   * 会拿首页顶上并且给 200，于是浏览器拿到 871 字节 HTML，报的却是解码错误，
   * 而人会照着这条消息去查音频文件。真实的例子见 `wavDecode.looksLikeWav`。
   *
   * 解码串行化（`decodeChain`）：十几条长音轨同时解，`decodeAudioData` 在某些
   * 浏览器上会成片失败。本地文件四五兆解一条只要几十毫秒，排十四条也就一秒出头，
   * 用不着冒这个险。
   *
   * 取数据失败重试一次，第二次绕开 HTTP 缓存 —— 万一坏响应被缓存住了，
   * 后端好了也没用，重试多少次拿到的都是它。
   *
   * 失败一次就放弃的代价不是「少一条轨」而是**整页卡死**：波形永远停在呼吸动画、
   * 指挥启动时那一条抛出来会让整个 `start()` 挂掉。
   */
  async loadTrack(id: string, url: string, pan = 0): Promise<AudioBuffer> {
    if (!this.ctx || !this.masterGain) throw new Error("AudioEngine 未初始化");
    const ctx = this.ctx;

    let raw: ArrayBuffer | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2 && !raw; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200));
      try {
        const resp = await fetch(url, attempt > 0 ? { cache: "reload" } : undefined);
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
        const buf = await resp.arrayBuffer();
        if (!looksLikeWav(buf)) throw new Error(describeNotAudio(buf, resp));
        raw = buf;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!raw) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    const bytes = raw;

    // 排到解码队列后面。链上任何一环失败都不能让后面的排队者一起挂，所以
    // catch 掉再往下传
    const decode = this.decodeChain.then(() => ctx.decodeAudioData(bytes));
    this.decodeChain = decode.catch(() => undefined);
    const buffer = await decode;

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
    this._resetClock(startTime);
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
    this._resetClock(startTime);
    this.isPlaying = true;
  }

  private _resetClock(startTime: number): void {
    this.musicElapsed = 0;
    this.rateSince = startTime;
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
    this.rate = 1;
    this.musicElapsed = 0;
    this.pitchNode?.parameters.get("ratio")?.setValueAtTime(1, this.ctx?.currentTime ?? 0);
  }

  /**
   * 从起播到现在，**曲子**走了多少秒（没取模，会一直涨）。
   *
   * 按倍速积分而不是数墙上时间：指挥把速度压到 0.7 倍时，墙上一秒只走了 0.7 秒
   * 音乐 —— 拿墙上时间去算第几拍，拍号指示器会越走越前。
   */
  musicSeconds(): number {
    if (!this.ctx || !this.isPlaying) return 0;
    return this.musicElapsed + Math.max(0, this.ctx.currentTime - this.rateSince) * this.rate;
  }

  /** 播放头位置（秒），供波形组件渲染；轨道未播放时返回 0。 */
  playheadSeconds(id: string): number {
    const track = this.tracks.get(id);
    if (!this.ctx || !track?.source) return 0;
    const dur = track.buffer.duration || 1;
    const elapsed = this.musicSeconds();
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

  /**
   * 变速。十几个声部共用同一个倍速，所以彼此的相位关系不变。
   *
   * **同时把音高按 1/rate 移回去**：`playbackRate` 改的是「放磁带的速度」，速度和
   * 音高一起变。指挥的速度范围是 0.7–1.3 倍，换算成音高是 ±5 个半音 —— 一首曲子
   * 被拖慢就换了个调，乐队不会这样。移调节点见 `pitchShifter.worklet.js`；
   * 装不上时这一步是空操作，退回「变速也变调」。
   */
  setPlaybackRate(rate: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // 先按旧倍速把这一段结算掉，再换新倍速。顺序反了的话，刚才那段会被按新倍速
    // 重算一遍，拍号指示器会跟着手势抖
    if (this.isPlaying) {
      this.musicElapsed += Math.max(0, now - this.rateSince) * this.rate;
      this.rateSince = now;
    }
    this.rate = rate;
    for (const track of this.tracks.values()) {
      track.source?.playbackRate.linearRampToValueAtTime(rate, now + 0.1);
    }
    this.pitchNode?.parameters.get("ratio")?.linearRampToValueAtTime(1 / rate, now + 0.1);
  }

  /** 当前倍速。界面上要照实说 —— 用户得知道自己把乐队带快了还是带慢了。 */
  playbackRate(): number {
    return this.rate;
  }

  trackIds(): string[] {
    return Array.from(this.tracks.keys());
  }
}

/** 全局唯一实例：AudioContext 数量有限，整个 app 共用一个引擎。 */
export const sharedAudioEngine = new AudioEngine();
