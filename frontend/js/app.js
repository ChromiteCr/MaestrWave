class MTXApp {
    constructor() {
        this.audioEngine = new AudioEngine();
        this.sensor = new SensorInput();
        this.gesture = new GestureInterpreter();
        this.currentSession = null;
        this.selectedLora = 'none';
        this.health = null;
        this._sensorActiveSince = 0;
    }

    async init() {
        await this.audioEngine.init();
        await this._refreshHealth();
        await this._refreshLoraList();
        // 启动时自动加载音乐库，便于"无手机"模式直接试听
        if (window.MTXLibrary) {
            await window.MTXLibrary.refresh();
        }
        // 监听传感器实际开始上报数据，更新状态徽章
        this.sensor.onUpdate(() => {
            if (!this._sensorActiveSince) {
                this._sensorActiveSince = performance.now();
                this._setPhoneStatus('ok', '手机传感器: 已连接');
            }
        });
    }

    async _refreshHealth() {
        try {
            const r = await fetch('/api/health');
            this.health = await r.json();
            this._setBadge('backendStatus', 'ok', '后端: 正常');
            if (this.health.acestep_reachable) {
                this._setBadge('aceStatus', 'ok', 'ACE-Step: 已连接');
            } else if (this.health.synth_fallback_enabled) {
                this._setBadge('aceStatus', 'warn', 'ACE-Step: 不可达（将使用兜底合成）');
            } else {
                this._setBadge('aceStatus', 'err', 'ACE-Step: 不可达');
            }
        } catch (e) {
            this._setBadge('backendStatus', 'err', '后端: 不可达');
        }
    }

    async _refreshLoraList() {
        const sel = document.getElementById('loraSelect');
        if (!sel) return;
        try {
            const r = await fetch('/api/lokr');
            const data = await r.json();
            sel.innerHTML = '';
            for (const opt of data.options) {
                const o = document.createElement('option');
                o.value = opt.id;
                o.textContent = opt.size_mb
                    ? `${opt.name}  (${opt.size_mb} MB)`
                    : opt.name;
                sel.appendChild(o);
            }
            // 记录 weights_dir 提示
            sel.title = `权重目录：${data.weights_dir}`;
        } catch (e) {
            sel.innerHTML = '<option value="none">无（加载失败）</option>';
        }
    }

    _setBadge(id, kind, text) {
        const el = document.getElementById(id);
        if (!el) return;
        el.className = 'badge badge-' + kind;
        el.textContent = text;
    }

    _setPhoneStatus(kind, text) {
        this._setBadge('phoneStatus', kind, text);
        const hint = document.getElementById('libraryHint');
        if (hint) {
            hint.textContent = kind === 'ok'
                ? '已检测到手机传感器。下方仍可作为"音乐库"浏览历史生成。'
                : '未检测到手机连接，下面列出所有历史生成的音乐片段，可直接试听 / 加载到指挥台。';
        }
    }

    async generateStems(description, duration, bpm, key, loraPath) {
        const resp = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                description,
                duration,
                bpm,
                key,
                lora_path: loraPath || 'none',
            })
        });
        if (!resp.ok) {
            const t = await resp.text();
            throw new Error('生成失败: ' + t);
        }
        this.currentSession = await resp.json();
        return this.currentSession;
    }

    /**
     * 流式生成：通过 SSE (text/event-stream) 拿到实时进度。
     * onEvent({type, ...}) 每条进度事件都会回调。
     * 返回最终 session 对象（type === 'done' 的事件内容）。
     */
    async generateStemsStream({ description, duration, bpm, key, loraPath }, onEvent) {
        const resp = await fetch('/api/generate/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                description, duration, bpm, key,
                lora_path: loraPath || 'none',
            })
        });
        if (!resp.ok || !resp.body) {
            const t = await resp.text().catch(() => '');
            throw new Error('生成失败: ' + (t || resp.status));
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buf = '';
        let finalSession = null;
        let lastError = null;

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });

            // SSE 以 \n\n 分隔事件
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
                const chunk = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                // 取出 data: 行
                const lines = chunk.split('\n');
                const dataLines = lines
                    .filter(l => l.startsWith('data:'))
                    .map(l => l.slice(5).trimStart());
                if (!dataLines.length) continue;
                let evt;
                try {
                    evt = JSON.parse(dataLines.join('\n'));
                } catch (_) {
                    continue;
                }
                if (typeof onEvent === 'function') {
                    try { onEvent(evt); } catch (_) {}
                }
                if (evt.type === 'done') {
                    finalSession = {
                        session_id: evt.session_id,
                        full_mix_url: evt.full_mix_url,
                        stems: evt.stems,
                        metadata: evt.metadata || {},
                    };
                } else if (evt.type === 'error') {
                    lastError = evt.error || 'unknown error';
                }
            }
        }

        if (lastError && !finalSession) throw new Error(lastError);
        if (!finalSession) throw new Error('生成失败：未收到 done 事件');
        this.currentSession = finalSession;
        return finalSession;
    }

    async loadSessionById(sessionId) {
        const r = await fetch('/api/sessions/' + encodeURIComponent(sessionId));
        if (!r.ok) throw new Error('会话不存在');
        const s = await r.json();
        this.currentSession = {
            session_id: s.session_id,
            full_mix_url: s.full_mix_url,
            stems: s.stems,
            metadata: s,
        };
        return this.currentSession;
    }

    async repaintSegment({ sessionId, target, prompt, startTime, endTime, loraPath }) {
        const resp = await fetch('/api/repaint', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: sessionId,
                target: target || 'full_mix',
                prompt,
                start_time: startTime,
                end_time: endTime,
                lora_path: loraPath || 'none',
            })
        });
        if (!resp.ok) {
            const t = await resp.text();
            throw new Error('Repaint 失败: ' + t);
        }
        return await resp.json();
    }

    async startConducting() {
        if (!this.currentSession) throw new Error('请先生成或加载分轨');
        if (this.audioEngine.ctx.state === 'suspended') {
            await this.audioEngine.ctx.resume();
        }
        await this.audioEngine.loadStems(this.currentSession.stems);
        this.gesture.baseBpm = (this.currentSession.metadata && this.currentSession.metadata.bpm) || 80;

        // 请求权限 -> 启动 -> 监听
        try {
            await this.sensor.requestPermission();
        } catch (e) {
            // iOS 权限拒绝
            this._setPhoneStatus('err', '手机传感器: 权限被拒绝');
            throw e;
        }
        this.sensor.start();
        this._setPhoneStatus('warn', '手机传感器: 等待数据…');

        // 5 秒内未收到任何 motion 事件 -> 提示无手机
        setTimeout(() => {
            if (!this._sensorActiveSince) {
                this._setPhoneStatus('warn', '手机传感器: 无数据（可能桌面端）');
            }
        }, 5000);

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
