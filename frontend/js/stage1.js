document.addEventListener('DOMContentLoaded', () => {
  const genBtn = document.getElementById('generateBtn');
  const refreshLoraBtn = document.getElementById('refreshLoraBtn');
  const repaintBtn = document.getElementById('repaintBtn');
  const info = document.getElementById('genInfo');
  const repaintInfo = document.getElementById('repaintInfo');
  const repaintSessionId = document.getElementById('repaintSessionId');

  genBtn.addEventListener('click', async () => {
    const desc = document.getElementById('description').value;
    const duration = parseInt(document.getElementById('duration').value) || 30;
    const bpm = parseInt(document.getElementById('bpm').value) || 80;
    const key = document.getElementById('key').value || 'D major';
    const loraPath = document.getElementById('loraSelect').value || 'none';
<<<<<<< HEAD

    genBtn.disabled = true;

    // 渲染进度条骨架
    info.innerHTML = `
      <div class="gen-progress">
        <div class="gen-progress-label">准备生成（LoKr=<code>${loraPath}</code>）…</div>
        <div class="gen-progress-bar"><div class="gen-progress-fill" style="width:0%"></div></div>
        <ul class="gen-stage-list"></ul>
      </div>
    `;
    const labelEl = info.querySelector('.gen-progress-label');
    const fillEl = info.querySelector('.gen-progress-fill');
    const listEl = info.querySelector('.gen-stage-list');
    const stageLi = {};
    let total = 6; // 默认值，会被 start 事件覆盖
    const t0 = performance.now();

    const setProgress = (idx) => {
      const pct = Math.max(0, Math.min(100, Math.round((idx / total) * 100)));
      fillEl.style.width = pct + '%';
    };

    const onEvent = (evt) => {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      switch (evt.type) {
        case 'start': {
          total = evt.total || total;
          (evt.stages || []).forEach((stage) => {
            const li = document.createElement('li');
            li.dataset.stage = stage;
            li.innerHTML = `<span class="dot pending"></span><span class="name">${stage}</span><span class="state">等待</span>`;
            listEl.appendChild(li);
            stageLi[stage] = li;
          });
          labelEl.textContent = `开始生成 ${total} 个轨道（Session=${evt.session_id}）…`;
          break;
        }
        case 'stage_start': {
          const li = stageLi[evt.stage];
          if (li) {
            li.querySelector('.dot').className = 'dot running';
            li.querySelector('.state').textContent = '生成中…';
          }
          labelEl.textContent = `[${elapsed}s] 正在生成 ${evt.stage}（${evt.index + 1}/${evt.total}）`;
          setProgress(evt.index);
          break;
        }
        case 'stage_done': {
          const li = stageLi[evt.stage];
          if (li) {
            li.querySelector('.dot').className = 'dot done';
            li.querySelector('.state').textContent = '完成';
          }
          setProgress(evt.index);
          break;
        }
        case 'stage_error': {
          const li = stageLi[evt.stage];
          if (li) {
            li.querySelector('.dot').className = 'dot error';
            li.querySelector('.state').textContent = '失败';
          }
          break;
        }
        case 'done':
          setProgress(total);
          labelEl.textContent = `[${elapsed}s] 全部完成`;
          break;
        case 'error':
          labelEl.textContent = `[${elapsed}s] 生成失败：${evt.error || ''}`;
          break;
      }
    };

    try {
      const session = await app.generateStemsStream(
        { description: desc, duration, bpm, key, loraPath },
        onEvent,
      );
      if (repaintSessionId) repaintSessionId.value = session.session_id;
      const usedLora = (session.metadata && session.metadata.lora_path) || '(无)';
      const summary = document.createElement('div');
      summary.innerHTML = `Session: <strong>${session.session_id}</strong>　使用权重: <code>${usedLora || '(无)'}</code>`;
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = session.full_mix_url;
      summary.appendChild(document.createElement('br'));
      summary.appendChild(audio);
      info.appendChild(summary);
      // 刷新音乐库
      if (window.MTXLibrary) await window.MTXLibrary.refresh();
    } catch (e) {
      const err = document.createElement('div');
      err.className = 'gen-error';
      err.textContent = '生成失败: ' + (e.message || e);
      info.appendChild(err);
=======

    genBtn.disabled = true;
    info.textContent = `正在生成（LoKr=${loraPath}）…`;
    try {
      const session = await app.generateStems(desc, duration, bpm, key, loraPath);
      if (repaintSessionId) repaintSessionId.value = session.session_id;
      const usedLora = (session.metadata && session.metadata.lora_path) || '(无)';
      info.innerHTML = `Session: <strong>${session.session_id}</strong>　使用权重: <code>${usedLora || '(无)'}</code>`;
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = session.full_mix_url;
      info.appendChild(document.createElement('br'));
      info.appendChild(audio);
      // 刷新音乐库
      if (window.MTXLibrary) await window.MTXLibrary.refresh();
    } catch (e) {
      info.textContent = '生成失败: ' + (e.message || e);
>>>>>>> dae77008d3d21757083961899b4d89bbbdab2add
    } finally {
      genBtn.disabled = false;
    }
  });

  if (refreshLoraBtn) {
    refreshLoraBtn.addEventListener('click', async () => {
      await app._refreshLoraList();
      info.textContent = '已刷新 LoKr 列表';
    });
  }

  if (repaintBtn) {
    repaintBtn.addEventListener('click', async () => {
      const sessionId = (document.getElementById('repaintSessionId').value || '').trim() || (app.currentSession && app.currentSession.session_id);
      const target = document.getElementById('repaintTarget').value || 'full_mix';
      const prompt = document.getElementById('repaintPrompt').value || '';
      const startTime = parseFloat(document.getElementById('repaintStart').value || '0');
      const endTime = parseFloat(document.getElementById('repaintEnd').value || '0');
      const loraPath = document.getElementById('loraSelect').value || 'none';

      if (!sessionId) {
        repaintInfo.textContent = '请先生成或加载一个会话，再执行 Repaint。';
        return;
      }
      if (!prompt.trim()) {
        repaintInfo.textContent = '请填写 Repaint Prompt。';
        return;
      }
      if (!(startTime >= 0 && endTime > startTime)) {
        repaintInfo.textContent = '时间范围无效，请确保 end > start 且 start >= 0。';
        return;
      }

      repaintBtn.disabled = true;
      repaintInfo.textContent = '正在执行 Repaint...';
      try {
        const result = await app.repaintSegment({
          sessionId, target, prompt, startTime, endTime, loraPath,
        });
        repaintInfo.innerHTML = `Repaint 完成：<strong>${result.repaint_file}</strong>`;
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = result.repaint_url;
        repaintInfo.appendChild(document.createElement('br'));
        repaintInfo.appendChild(audio);
        if (window.MTXLibrary) await window.MTXLibrary.refresh();
      } catch (e) {
        repaintInfo.textContent = 'Repaint 失败: ' + (e.message || e);
      } finally {
        repaintBtn.disabled = false;
      }
    });
  }
});
