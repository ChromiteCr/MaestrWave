class MTXApp {
    constructor() {
        this.audioEngine = new AudioEngine();
        this.sensor = new SensorInput();
        this.gesture = new GestureInterpreter();
        this.currentSession = null;
    }

    async init() {
        await this.audioEngine.init();
    }

    async generateStems(description, duration = 60, bpm = 80, key = "D major") {
        const resp = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description, duration, bpm, key })
        });
        if (!resp.ok) throw new Error('生成失败');
        this.currentSession = await resp.json();
        return this.currentSession;
    }

    async previewFullMix() {
        const audio = new Audio(this.currentSession.full_mix_url);
        audio.play();
        return audio;
    }

    async startConducting() {
        await this.audioEngine.loadStems(this.currentSession.stems);

        // 设置基准 BPM（可从 session metadata 获取）
        this.gesture.baseBpm = 80;

        await this.sensor.requestPermission();
        this.sensor.start();

        this.audioEngine.play();

        this.sensor.onUpdate((sensorData) => {
            const params = this.gesture.process(sensorData);
            this._applyToAudio(params);
        });
    }

    _applyToAudio(params) {
        for (const [instrument, activation] of Object.entries(params.sections)) {
            const volume = activation * params.dynamics;
            this.audioEngine.setTrackVolume(instrument, volume);
        }

        this.audioEngine.setPlaybackRate(params.tempo);

        if (params.density < 0.3) {
            const sorted = Object.entries(params.sections).sort((a, b) => b[1] - a[1]);
            sorted.slice(2).forEach(([inst]) => {
                this.audioEngine.setTrackVolume(inst, 0);
            });
        }

        if (params.expression === 'cutoff') {
            this.audioEngine.setMasterVolume(0);
            setTimeout(() => this.audioEngine.setMasterVolume(1), 100);
        }
    }

    stopConducting() {
        this.audioEngine.stop();
    }
}

window.MTXApp = MTXApp;
