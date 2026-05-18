// LogiDesk — Lardi-Trans /log/mygruztrans/ — авто-оновлення через API

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'refresh_lardi_all') {
    refreshAllLardi()
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(e => {
        console.error('[LogiDesk] refreshAllLardi error:', e);
        sendResponse({ ok: false, error: e.message });
      });
    return true; // async
  }
});

async function refreshAllLardi() {
  console.log('[LogiDesk] Lardi refresh: starting on', location.href);
  await sleep(2000);

  // 1. Збираємо proposalId через React fiber з кнопок "Повторити"
  const allIds   = extractProposalIds(false); // всі
  const activeIds = extractProposalIds(true);  // тільки не disabled

  console.log('[LogiDesk] Lardi refresh: total proposals:', allIds.length, '| ready to repeat:', activeIds.length);

  if (!activeIds.length) {
    const msg = allIds.length
      ? `⏳ LogiDesk: всі ${allIds.length} заявок ще не готові до повтору`
      : '⚠️ LogiDesk: заявок на сторінці не знайдено';
    console.warn('[LogiDesk] Lardi refresh:', msg);
    showNotification(msg);
    return { count: 0, total: allIds.length };
  }

  showNotification(`🔄 LogiDesk: оновлюю ${activeIds.length} заявок на Lardi...`);

  // 2. Один POST-запит на всі активні заявки
  try {
    const res = await fetch('/webapi/proposal/my/repeat/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gruzIds: activeIds, proposalStatus: 'published' })
    });

    const text = await res.text();
    console.log('[LogiDesk] Lardi repeat API response:', res.status, text.slice(0, 200));

    let data = null;
    try { data = JSON.parse(text); } catch (_) {}

    const repeated = data?.repeated || data?.result || activeIds.length;
    showNotification(`✅ LogiDesk: ${activeIds.length} заявок оновлено на Lardi!`);
    return { count: activeIds.length, ids: activeIds };

  } catch (e) {
    console.error('[LogiDesk] Lardi repeat API error:', e.message);
    showNotification('❌ LogiDesk: помилка оновлення Lardi: ' + e.message);
    return { count: 0, error: e.message };
  }
}

// Витягує proposalId через React fiber з кнопок .proposal-table--column--repeat__repeat
// activeOnly=true — тільки кнопки без disabled
function extractProposalIds(activeOnly) {
  const btns = Array.from(document.querySelectorAll('.proposal-table--column--repeat__repeat'));
  const ids = [];
  for (const btn of btns) {
    if (activeOnly && btn.disabled) continue;
    const fk = Object.keys(btn).find(k => k.startsWith('__reactFiber'));
    let f = fk ? btn[fk] : null;
    while (f) {
      const p = f.memoizedProps;
      if (p && p.proposalId) { ids.push(p.proposalId); break; }
      f = f.return;
    }
  }
  return ids;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function showNotification(text) {
  const existing = document.getElementById('logidesk-notification');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.id = 'logidesk-notification';
  div.style.cssText = [
    'position:fixed', 'top:20px', 'right:20px', 'z-index:99999',
    'background:#1e3a5f', 'color:white', 'padding:14px 18px',
    'border-radius:10px', 'font-size:14px', 'font-weight:600',
    'box-shadow:0 4px 20px rgba(0,0,0,.3)', 'max-width:320px',
    'line-height:1.6', 'white-space:pre-line', 'cursor:pointer'
  ].join(';');
  div.textContent = text;
  div.onclick = () => div.remove();
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 8000);
}
