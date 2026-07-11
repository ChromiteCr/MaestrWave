class GestureInterpreter {
    constructor() {
        this.history = [];       // 最近 N 帧传感器数据
        this.historySize = 60;   // 1秒 @60Hz
        this.lastBeatTime = 0;
        this.bpm = 80;           // 当前检测到的 BPM
        this.baseBpm = 80;       // 原始生成时的 BPM

        // 平滑状态
        this.filtered = { energy: 0, gamma: 0, beta: 0 };
    }

    process(sensorData) {
        this.history.push(sensorData);
        if (this.history.length > this.historySize) this.history.shift();

        const { orientation, acceleration } = sensorData;

        // 运动能量（去重力）
        const energy = Math.sqrt(
            acceleration.x ** 2 + acceleration.y ** 2 + acceleration.z ** 2
        ) - 9.81;
        this.filtered.energy = this._smooth(this.filtered.energy, Math.max(0, energy), 0.3);

        // 方向平滑
        this.filtered.gamma = this._smooth(this.filtered.gamma, orientation.gamma, 0.2);
        this.filtered.beta = this._smooth(this.filtered.beta, orientation.beta, 0.2);

        return {
            sections: this._calcSectionActivation(),
            dynamics: this._calcDynamics(),
            tempo: this._calcTempo(acceleration),
            density: this._calcDensity(),
            expression: this._detectExpression(),
        };
    }

    _calcSectionActivation() {
        const g = this.filtered.gamma;  // 左右倾斜
        const b = this.filtered.beta;   // 前后倾斜
        const smooth = 15;  // sigmoid 平滑系数

        return {
            violin: this._sigmoid((-g - 20) / smooth),
            cello: this._sigmoid((-g - 10) / smooth) * 0.8,
            trumpet: this._sigmoid((g - 20) / smooth),
            woodwind: this._sigmoid((-b - 15) / smooth),
            percussion: this._sigmoid((b - 15) / smooth),
        };
    }

    _calcDynamics() {
        const REST = 0.5;   // 静止阈值
        const MAX = 15;     // 最大能量
        return Math.min(1, Math.max(0, (this.filtered.energy - REST) / (MAX - REST)));
    }

    _calcTempo(acceleration) {
        const now = performance.now();

        if (this.history.length >= 2) {
            const prev = this.history[this.history.length - 2].acceleration.y;
            const curr = acceleration.y;

            if (prev < 0 && curr >= 0 && this.filtered.energy > 2) {
                const interval = now - this.lastBeatTime;
                if (interval > 200 && interval < 2000) {
                    const detectedBpm = 60000 / interval;
                    const minBpm = this.baseBpm * 0.7;
                    const maxBpm = this.baseBpm * 1.3;
                    const clamped = Math.min(maxBpm, Math.max(minBpm, detectedBpm));
                    this.bpm = this._smooth(this.bpm, clamped, 0.15);
                }
                this.lastBeatTime = now;
            }
        }

        return this.bpm / this.baseBpm;  // playbackRate
    }

    _calcDensity() {
        const recent = this.history.slice(-30);
        if (recent.length < 5) return 0.5;

        const energies = recent.map(d =>
            Math.sqrt(d.acceleration.x**2 + d.acceleration.y**2 + d.acceleration.z**2)
        );
        const variance = this._variance(energies);
        return Math.min(1, variance / 50);
    }

    _detectExpression() {
        if (this.history.length < 30) return null;

        const recent = this.history.slice(-30);
        const energyTrend = recent.map(d =>
            Math.sqrt(d.acceleration.x**2 + d.acceleration.y**2 + d.acceleration.z**2)
        );

        if (this._isRising(energyTrend)) return 'crescendo';
        if (this._isFalling(energyTrend)) return 'decrescendo';

        const lastEnergy = energyTrend[energyTrend.length - 1];
        const avgEnergy = energyTrend.slice(0, 20).reduce((a,b) => a+b, 0) / 20;
        if (avgEnergy > 5 && lastEnergy < 1) return 'cutoff';

        return null;
    }

    _sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
    _smooth(prev, curr, factor) { return prev * (1 - factor) + curr * factor; }
    _variance(arr) {
        const mean = arr.reduce((a,b) => a+b, 0) / arr.length;
        return arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / arr.length;
    }
    _isRising(arr) {
        let rises = 0;
        for (let i = 1; i < arr.length; i++) if (arr[i] > arr[i-1]) rises++;
        return rises / (arr.length - 1) > 0.7;
    }
    _isFalling(arr) {
        let falls = 0;
        for (let i = 1; i < arr.length; i++) if (arr[i] < arr[i-1]) falls++;
        return falls / (arr.length - 1) > 0.7;
    }
}
