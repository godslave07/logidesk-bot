// LogiDesk — Della.ua /my/ page: auto-refresh all active orders

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'refresh_della_all') {
    refreshAllDella()
      .then(count => sendResponse({ ok: true, count }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }
});

async function refreshAllDella() {
  // Della shows a "Повторити" (refresh) button per order card.
  // Try several selectors — pick whichever finds buttons.
  const SELECTORS = [
    'button[title="Повторити"]',
    'button[title="Обновить"]',
    'a[title="Повторити"]',
    '.icon-repeat',
    '.fa-repeat',
    '.fa-sync',
    '.fa-redo',
    // Generic: small circular-arrow buttons inside order cards
    // Della uses Bootstrap-style buttons; the refresh icon sits in .btn-group or similar
    '.active-list .btn:not(.btn-danger):not(.btn-primary):first-child',
  ];

  let buttons = [];
  for (const sel of SELECTORS) {
    const found = Array.from(document.querySelectorAll(sel));
    if (found.length) {
      console.log(`[LogiDesk] Della refresh: found ${found.length} buttons via "${sel}"`);
      buttons = found;
      break;
    }
  }

  // Fallback: find all buttons that have only an SVG child (icon-only buttons)
  // and are NOT red/delete buttons. These are typically the action icon buttons.
  if (!buttons.length) {
    const allBtns = Array.from(document.querySelectorAll('button, a.btn'));
    buttons = allBtns.filter(b => {
      const txt = b.textContent.trim();
      const hasSvg = b.querySelector('svg') || b.querySelector('i');
      // Exclude delete buttons (red), primary buttons, and text buttons
      const isIcon = hasSvg && txt.length < 5;
      const isNotDanger = !b.classList.contains('btn-danger') && !b.style.color?.includes('red');
      // Look for buttons in cards that likely have a repeat/refresh SVG
      // Della typically uses SVG with a path for the refresh icon
      const svgPath = b.querySelector('svg path')?.getAttribute('d') || '';
      const looksLikeRefresh = svgPath.includes('M') && svgPath.length > 20;
      return isIcon && isNotDanger && looksLikeRefresh;
    });
    console.log(`[LogiDesk] Della refresh: fallback found ${buttons.length} icon buttons`);
  }

  if (!buttons.length) {
    console.warn('[LogiDesk] Della refresh: no refresh buttons found on this page');
    showNotification('⚠️ LogiDesk: кнопки оновлення не знайдено.\nВідкрий della.ua/my/ вручну.');
    return 0;
  }

  console.log(`[LogiDesk] Della refresh: clicking ${buttons.length} buttons...`);
  showNotification(`🔄 LogiDesk: оновлюю ${buttons.length} заявок на Della...`);

  for (let i = 0; i < buttons.length; i++) {
    buttons[i].click();
    console.log(`[LogiDesk] Della refresh: clicked button ${i + 1}/${buttons.length}`);
    // Wait 3s between clicks to avoid rate limiting
    if (i < buttons.length - 1) {
      await sleep(3000);
    }
  }

  showNotification(`✅ LogiDesk: ${buttons.length} заявок оновлено на Della!`);
  return buttons.length;
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
