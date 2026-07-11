/**
 * 增强的 SensorInput：
 *  - 兼容 iOS 13+ 的显式权限请求
 *  - 桌面/不支持 DeviceMotion 的浏览器自动 noop
 *  - 暴露 isAvailable() / hasReceivedData() 供 UI 判断
 */
class SensorInput {
    constructor() {
        this.alpha = 0;
        this.beta = 0;
        this.gamma = 0;
        this.acceleration = { x: 0, y: 0, z: 0 };
        this.rotationRate = { alpha: 0, beta: 0, gamma: 0 };
        this.listeners = [];
        this._started = false;
        this._receivedData = false;
    }

    static isAvailable() {
        return typeof window !== 'undefined'
            && (typeof DeviceMotionEvent !== 'undefined'
                || typeof DeviceOrientationEvent !== 'undefined');
    }

    hasReceivedData() { return this._receivedData; }

    async requestPermission() {
        // iOS 13+ DeviceMotion 权限
        if (typeof DeviceMotionEvent !== 'undefined'
            && typeof DeviceMotionEvent.requestPermission === 'function') {
            const p = await DeviceMotionEvent.requestPermission();
            if (p !== 'granted') throw new Error('DeviceMotion 权限被拒绝');
        }
        if (typeof DeviceOrientationEvent !== 'undefined'
            && typeof DeviceOrientationEvent.requestPermission === 'function') {
            try {
                const p = await DeviceOrientationEvent.requestPermission();
                if (p !== 'granted') throw new Error('DeviceOrientation 权限被拒绝');
            } catch (e) {
                // Android / 其他浏览器没有该 API，忽略
            }
        }
    }

    start() {
        if (this._started) return;
        this._started = true;

        window.addEventListener('deviceorientation', (e) => {
            this.alpha = e.alpha || 0;
            this.beta = e.beta || 0;
            this.gamma = e.gamma || 0;
            this._receivedData = true;
        });

        window.addEventListener('devicemotion', (e) => {
            const acc = e.accelerationIncludingGravity || e.acceleration || { x: 0, y: 0, z: 0 };
            this.acceleration = { x: acc.x || 0, y: acc.y || 0, z: acc.z || 0 };
            const rr = e.rotationRate || {};
            this.rotationRate = {
                alpha: rr.alpha || 0,
                beta: rr.beta || 0,
                gamma: rr.gamma || 0,
            };
            this._receivedData = true;
            this._notify();
        });
    }

    onUpdate(callback) { this.listeners.push(callback); }

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

window.SensorInput = SensorInput;
