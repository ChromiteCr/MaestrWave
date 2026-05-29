class AudioEngine {
    constructor() {
        this.ctx = null;
        this.masterGain = null;
        this.tracks = {};  // {instrument: {buffer, source, gain, panner}}
        this.isPlaying = false;
    }

    async init() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.masterGain = this.ctx.createGain();
        this.masterGain.connect(this.ctx.destination);
    }

    async loadStems(stems) {
        const positions = {
            violin: -0.8,
            cello: -0.4,
            trumpet: 0.7,
            woodwind: 0.0,
            percussion: 0.3,
        };

        for (const [instrument, url] of Object.entries(stems)) {
            const resp = await fetch(url);
            const buffer = await resp.arrayBuffer();
            const audioBuffer = await this.ctx.decodeAudioData(buffer);

            const gain = this.ctx.createGain();
            const panner = this.ctx.createStereoPanner();
            panner.pan.value = positions[instrument] || 0;

            gain.connect(panner);
            panner.connect(this.masterGain);

            this.tracks[instrument] = {
                buffer: audioBuffer,
                gain: gain,
                panner: panner,
                source: null,
            };
        }
    }

    play() {
        const startTime = this.ctx.currentTime + 0.05;

        for (const [instrument, track] of Object.entries(this.tracks)) {
            const source = this.ctx.createBufferSource();
            source.buffer = track.buffer;
            source.connect(track.gain);
            source.loop = true;
            source.start(startTime);
            track.source = source;
        }
        this.isPlaying = true;
    }

    stop() {
        for (const track of Object.values(this.tracks)) {
            if (track.source) {
                try { track.source.stop(); } catch (e) {}
                track.source = null;
            }
        }
        this.isPlaying = false;
    }

    setTrackVolume(instrument, value) {
        if (this.tracks[instrument]) {
            this.tracks[instrument].gain.gain.linearRampToValueAtTime(
                value, this.ctx.currentTime + 0.05
            );
        }
    }

    setMasterVolume(value) {
        this.masterGain.gain.linearRampToValueAtTime(
            value, this.ctx.currentTime + 0.05
        );
    }

    setPlaybackRate(rate) {
        for (const track of Object.values(this.tracks)) {
            if (track.source && track.source.playbackRate) {
                track.source.playbackRate.linearRampToValueAtTime(
                    rate, this.ctx.currentTime + 0.1
                );
            }
        }
    }
}
