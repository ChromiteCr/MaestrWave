document.addEventListener('DOMContentLoaded', () => {
  const loadBtn = document.getElementById('loadBtn');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const info = document.getElementById('conductInfo');

  loadBtn.addEventListener('click', async () => {
    if (!app.currentSession) { alert('请先生成分轨'); return; }
    info.textContent = '加载中...';
    try {
      await app.audioEngine.loadStems(app.currentSession.stems);
      info.textContent = '分轨加载完成';
    } catch (e) {
      info.textContent = '加载失败: ' + (e.message || e);
    }
  });

  startBtn.addEventListener('click', async () => {
    if (!app.currentSession) { alert('请先生成或加载分轨'); return; }
    info.textContent = '启动指挥，准备传感器权限请求';
    try {
      await app.startConducting();
      info.textContent = '正在指挥...';
    } catch (e) {
      info.textContent = '启动失败: ' + (e.message || e);
    }
  });

  stopBtn.addEventListener('click', () => {
    app.stopConducting();
    info.textContent = '已停止';
  });
});
