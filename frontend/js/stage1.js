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
