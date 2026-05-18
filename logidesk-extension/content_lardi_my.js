// LogiDesk — Lardi-Trans /log/mygruztrans/ — авто-оновлення всіх активних заявок

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

  // Чекаємо повного рендерингу сторінки
  await sleep(2000);

  // Спроба 1: знайти кнопки "Підняти" / "Поднять" / "Актуалізувати"
  const buttons = findRaiseButtons();
  console.log('[LogiDesk] Lardi refresh: found', buttons.length, 'raise buttons');

  if (!buttons.length) {
    console.warn('[LogiDesk] Lardi refresh: no raise buttons found');
    showNotification('⚠️ LogiDesk: кнопки оновлення Lardi не знайдено.\nВідкрий lardi-trans.com/log/mygruztrans/ вручну.');
    return { count: 0 };
  }

  showNotification(`🔄 LogiDesk: оновлюю ${buttons.length} заявок на Lardi...`);

  let clicked = 0;
  for (let i = 0; i < buttons.length; i++) {
    const btn = buttons[i];
    try {
      btn.click();
      clicked++;
      console.log(`[LogiDesk] Lardi refresh: clicked ${clicked}/${buttons.length} —`, btn.textContent.trim().slice(0, 40));
    } catch (e) {
      console.warn('[LogiDesk] Lardi refresh: click error', e.message);
    }
    // Затримка між кліками щоб сервер не заблокував
    if (i < buttons.length - 1) await sleep(3500);
  }

  showNotification(`✅ LogiDesk: ${clicked} заявок оновлено на Lardi!`);
  return { count: clicked };
}

function findRaiseButtons() {
  const result = [];
  const seen = new Set();

  function add(el) {
    if (!el || seen.has(el)) return;
    seen.add(el);
    result.push(el);
  }

  // 1. Класові селектори
  const classSelectors = [
    '[class*="raise"]',
    '[class*="renew"]',
    '[class*="actualize"]',
    '[class*="refresh-btn"]',
    '[class*="update-btn"]',
    '[class*="bump"]',
  ];
  for (const sel of classSelectors) {
    document.querySelectorAll(sel).forEach(el => add(el));
  }

  // 2. onclick-селектори
  const onclickSelectors = [
    '[onclick*="raise"]',
    '[onclick*="renew"]',
    '[onclick*="actualize"]',
    '[onclick*="Raise"]',
    '[onclick*="Renew"]',
  ];
  for (const sel of onclickSelectors) {
    document.querySelectorAll(sel).forEach(el => add(el));
  }

  // 3. За текстом кнопки / посилання
  const textTargets = ['підняти', 'поднять', 'оновити', 'обновить', 'актуалізувати', 'актуализировать'];
  document.querySelectorAll('button, a, span, div').forEach(el => {
    const text = (el.textContent || '').trim().toLowerCase();
    if (textTargets.some(t => text === t || text.startsWith(t))) {
      add(el);
    }
  });

  console.log('[LogiDesk] findRaiseButtons: total', result.length);
  return result;
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
