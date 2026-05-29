class SensorInput {
    constructor() {
        this.alpha = 0;   // z轴旋转 (0-360)
        this.beta = 0;    // 前后倾斜 (-180~180)
        this.gamma = 0;   // 左右倾斜 (-90~90)
        this.acceleration = { x: 0, y: 0, z: 0 };
        this.rotationRate = { alpha: 0, beta: 0, gamma: 0 };
        this.listeners = [];
    }

    async requestPermission() {
        /** iOS 13+ 需要显式请求权限 */
        if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
            const permission = await DeviceMotionEvent.requestPermission();
            if (permission !== 'granted') {
                throw new Error('传感器权限被拒绝');
            }
        }
    }

    start() {
        window.addEventListener('deviceorientation', (e) => {
            this.alpha = e.alpha || 0;
            this.beta = e.beta || 0;
            this.gamma = e.gamma || 0;
        });

        window.addEventListener('devicemotion', (e) => {
            const acc = e.accelerationIncludingGravity || e.acceleration || { x: 0, y: 0, z: 0 };
            this.acceleration = { x: acc.x || 0, y: acc.y || 0, z: acc.z || 0 };
            this.rotationRate = {
                alpha: (e.rotationRate && e.rotationRate.alpha) || 0,
                beta: (e.rotationRate && e.rotationRate.beta) || 0,
                gamma: (e.rotationRate && e.rotationRate.gamma) || 0,
            };
            this._notify();
        });
    }

    onUpdate(callback) {
        this.listeners.push(callback);
    }

    _notify() {
        const data = {
            orientation: { alpha: this.alpha, beta: this.beta, gamma: this.gamma },
            acceleration: this.acceleration,
            rotationRate: this.rotationRate,
            timestamp: performance.now(),
        };
        this.listeners.forEach(cb => cb(data));
    }
}
