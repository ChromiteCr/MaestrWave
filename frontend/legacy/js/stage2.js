document.addEventListener('DOMContentLoaded', () => {
  const loadBtn = document.getElementById('loadBtn');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const info = document.getElementById('conductInfo');

  loadBtn.addEventListener('click', async () => {
    if (!app.currentSession) {
      info.textContent = '请先在阶段一生成，或从下方"音乐库"加载一段。';
      return;
    }
    info.textContent = '加载中…';
    try {
      await app.audioEngine.loadStems(app.currentSession.stems);
      info.textContent = `分轨加载完成（session=${app.currentSession.session_id}）`;
    } catch (e) {
      info.textContent = '加载失败: ' + (e.message || e);
    }
  });

  startBtn.addEventListener('click', async () => {
    if (!app.currentSession) {
      info.textContent = '请先生成或从音乐库加载一段。';
      return;
    }
    info.textContent = '启动指挥…（如在手机请允许传感器权限）';
    try {
      await app.startConducting();
      const tip = SensorInput.isAvailable()
        ? '正在指挥…（挥动手机）'
        : '正在播放…（当前设备无传感器，将以默认混音播放）';
      info.textContent = tip;
    } catch (e) {
      info.textContent = '启动失败: ' + (e.message || e) + '。可使用下方音乐库直接试听。';
    }
  });

  stopBtn.addEventListener('click', () => {
    app.stopConducting();
    info.textContent = '已停止';
  });
});
