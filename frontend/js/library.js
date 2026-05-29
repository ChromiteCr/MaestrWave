/**
 * 音乐库（无手机模式 / 历史片段浏览）
 *
 * 列出 /api/sessions 的所有 session，渲染卡片。每张卡片提供：
 *  - full_mix 音频试听
 *  - "加载到指挥台" 按钮：把该 session 设为 app.currentSession
 */
(function () {
  const listEl = () => document.getElementById('sessionsList');

  async function refresh() {
    const el = listEl();
    if (!el) return;
    el.innerHTML = '<em>加载中…</em>';
    try {
      const r = await fetch('/api/sessions');
      const data = await r.json();
      const sessions = data.sessions || [];
      if (!sessions.length) {
        el.innerHTML = '<em>暂无历史会话，先在上方生成一段试试。</em>';
        return;
      }
      el.innerHTML = '';
      for (const s of sessions) {
        el.appendChild(renderCard(s));
      }
    } catch (e) {
      el.innerHTML = '<em>加载失败: ' + (e.message || e) + '</em>';
    }
  }

  function renderCard(s) {
    const card = document.createElement('div');
    card.className = 'session-card';
    const title = s.description ? escapeHtml(s.description) : '(无描述)';
    const meta = [
      s.bpm ? `BPM ${s.bpm}` : null,
      s.key || null,
      s.duration ? `${s.duration}s` : null,
      s.lora_path ? `LoKr: ${escapeHtml(s.lora_path.split('/').pop())}` : 'LoKr: 无',
    ].filter(Boolean).join(' · ');

    card.innerHTML = `
      <h3>${s.session_id}</h3>
      <div class="meta">${meta}</div>
      <div class="meta">${escapeHtml(s.created_at || '')}</div>
      <div class="meta" title="${title}">${truncate(title, 80)}</div>
    `;

    if (s.full_mix_url) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = s.full_mix_url;
      card.appendChild(audio);
    }

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const loadBtn = document.createElement('button');
    loadBtn.textContent = '加载到指挥台';
    loadBtn.className = 'primary';
    loadBtn.addEventListener('click', async () => {
      try {
        await app.loadSessionById(s.session_id);
        const info = document.getElementById('conductInfo');
        if (info) info.textContent = `已加载 ${s.session_id}，可点击"开始指挥"。`;
        window.scrollTo({ top: document.getElementById('stage2').offsetTop, behavior: 'smooth' });
      } catch (e) {
        alert('加载失败: ' + (e.message || e));
      }
    });
    actions.appendChild(loadBtn);

    // 分轨试听
    for (const [inst, url] of Object.entries(s.stems || {})) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.textContent = inst;
      a.style.cssText = 'font-size:12px;color:#2563eb;text-decoration:none;border:1px solid #c7d2fe;border-radius:3px;padding:2px 6px;';
      actions.appendChild(a);
    }

    card.appendChild(actions);
    return card;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

  window.MTXLibrary = { refresh };

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('refreshSessionsBtn');
    if (btn) btn.addEventListener('click', refresh);
  });
})();
