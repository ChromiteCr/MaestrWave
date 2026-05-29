document.addEventListener('DOMContentLoaded', () => {
  const genBtn = document.getElementById('generateBtn');
  const info = document.getElementById('genInfo');

  genBtn.addEventListener('click', async () => {
    const desc = document.getElementById('description').value;
    const duration = parseInt(document.getElementById('duration').value) || 60;
    const bpm = parseInt(document.getElementById('bpm').value) || 80;
    const key = document.getElementById('key').value || 'D major';

    info.textContent = '正在生成... (可能需要数十秒到数分钟)';
    try {
      const session = await app.generateStems(desc, duration, bpm, key);
      info.innerHTML = `Session: <strong>${session.session_id}</strong>`;
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = session.full_mix_url;
      info.appendChild(document.createElement('br'));
      info.appendChild(audio);
    } catch (e) {
      info.textContent = '生成失败: ' + (e.message || e);
    }
  });
});
