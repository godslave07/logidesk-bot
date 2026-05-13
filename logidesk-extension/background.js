const API_URL = 'https://logidesk-bot-production.up.railway.app';
const API_KEY = 'logidesk2024';
const LARDI_SEARCH_URL = 'https://lardi-trans.com/log/search/gruz/wf1i640iwt1i640ipc4pv5000pt1';

let pendingOrders = [];
let activeOrders = [];

// Черга на авто-розміщення Della: orderId → order
// Della відкривається тільки після отримання mark_posted від Lardi
const pendingDellaMap = new Map();

// IDs заявок що вже були авто-розміщені.
// Зберігаємо в session storage — не втрачаємо при перезапуску SW.
const autoPostedIds = new Set();

chrome.storage.session.get(['autoPostedIds']).then(result => {
  (result.autoPostedIds || []).forEach(id => autoPostedIds.add(id));
  console.log('[LogiDesk] Loaded autoPostedIds from session:', autoPostedIds.size);
}).catch(() => {});

function persistAutoPostedIds() {
  chrome.storage.session.set({ autoPostedIds: [...autoPostedIds] }).catch(() => {});
}

// ===== ALARMS — надійний polling в MV3 =====
// setInterval вбивається через 5 хв коли SW засинає. Alarms — ні.
chrome.alarms.create('fetchOrders',        { periodInMinutes: 0.5 });
chrome.alarms.create('refreshDellaAuto',   { periodInMinutes: 10  });
// chrome.alarms.create('importLardiSearch',  { periodInMinutes: 2   }); // вимкнено — скрейпер дає некоректні назви міст

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'fetchOrders')       fetchOrders();
  if (alarm.name === 'refreshDellaAuto')  maybeRefreshDella();
  // if (alarm.name === 'importLardiSearch') importFromLardiSearch(); // вимкнено
});

// ===== АВТО-ОНОВЛЕННЯ DELLA (8:00–18:00 за Берліном) =====
function isBerlinWorkHours() {
  const now = new Date();
  const hourStr = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: 'numeric',
    hour12: false
  }).format(now);
  const hour = parseInt(hourStr, 10); // '12 Uhr' → 12, not NaN
  return hour >= 8 && hour < 18;
}

async function maybeRefreshDella() {
  if (!isBerlinWorkHours()) {
    console.log('[LogiDesk] Della auto-refresh skipped — outside working hours (Berlin 8:00–18:00)');
    return;
  }

  console.log('[LogiDesk] Della auto-refresh triggered');

  // Шукаємо вже відкриту вкладку della.ua/my/
  const tabs = await chrome.tabs.query({ url: 'https://della.ua/my/*' });

  if (tabs.length > 0) {
    // Є відкрита вкладка — перезавантажуємо щоб content script точно завантажився
    const tabId = tabs[0].id;
    chrome.tabs.reload(tabId);
    const listenerExisting = (tId, changeInfo) => {
      if (tId !== tabId || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(listenerExisting);
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { type: 'refresh_della_all' }, (resp) => {
          console.log('[LogiDesk] Della auto-refresh result (reloaded tab):', resp);
        });
      }, 5000);
    };
    chrome.tabs.onUpdated.addListener(listenerExisting);
  } else {
    // Відкриваємо нову вкладку, чекаємо завантаження, шлемо повідомлення, закриваємо
    chrome.tabs.create({ url: 'https://della.ua/my/' }, (tab) => {
      const autoTabId = tab.id;
      const listener = (tabId, changeInfo) => {
        if (tabId !== autoTabId || changeInfo.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(listener);
        // Чекаємо 5 сек щоб сторінка відрендерила всі заявки
        setTimeout(() => {
          // Fallback: закрити вкладку якщо content script не відповів за 60 сек
          const closeTimer = setTimeout(() => chrome.tabs.remove(autoTabId).catch(() => {}), 60000);
          chrome.tabs.sendMessage(autoTabId, { type: 'refresh_della_all' }, (resp) => {
            clearTimeout(closeTimer);
            console.log('[LogiDesk] Della auto-refresh result (new tab):', resp);
            // Закриваємо вкладку тільки після отримання відповіді
            chrome.tabs.remove(autoTabId).catch(() => {});
          });
        }, 5000);
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }
}

// ===== ІМПОРТ ЧУЖИХ ЗАЯВОК З LARDI (веб-скрейпінг, вкладка не закривається) =====
async function importFromLardiSearch() {
  try {
    // Шукаємо вже відкриту вкладку з пошуком Lardi
    const tabs = await chrome.tabs.query({ url: 'https://lardi-trans.com/log/search/gruz/*' });
    let tabId;

    if (tabs.length > 0) {
      // Вкладка є — навігуємо на правильний URL (може бути старий URL з фільтрами)
      tabId = tabs[0].id;
      await new Promise(resolve => {
        chrome.tabs.update(tabId, { url: LARDI_SEARCH_URL });
        const listener = (tId, changeInfo) => {
          if (tId !== tabId || changeInfo.status !== 'complete') return;
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
    } else {
      // Відкриваємо нову вкладку (active: false — у фоні)
      tabId = await new Promise(resolve => {
        chrome.tabs.create({ url: LARDI_SEARCH_URL, active: false }, tab => {
          const listener = (tId, changeInfo) => {
            if (tId !== tab.id || changeInfo.status !== 'complete') return;
            chrome.tabs.onUpdated.removeListener(listener);
            resolve(tab.id);
          };
          chrome.tabs.onUpdated.addListener(listener);
        });
      });
    }

    // Чекаємо 12 секунд — React повинен відрендерити список
    await new Promise(r => setTimeout(r, 12000));

    // Скрейпимо заявки
    chrome.tabs.sendMessage(tabId, { type: 'scrape_lardi_search' }, async (resp) => {
      if (chrome.runtime.lastError) {
        console.log('[LogiDesk] Lardi scrape error:', chrome.runtime.lastError.message);
        return;
      }
      if (!resp?.ok || !resp.proposals?.length) {
        console.log('[LogiDesk] Lardi search: 0 proposals found');
        return;
      }
      console.log(`[LogiDesk] Lardi search: got ${resp.proposals.length} proposals`);

      try {
        const res = await fetch(`${API_URL}/api/import/proposals`, {
          method: 'POST',
          headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ proposals: resp.proposals }),
        });
        const data = await res.json();
        console.log(`[LogiDesk] Imported ${data.imported}/${data.total} new proposals`);
      } catch (e) {
        console.error('[LogiDesk] Import proposals error:', e.message);
      }
    });

  } catch (e) {
    console.error('[LogiDesk] importFromLardiSearch error:', e.message);
  }
}

// ===== ОПРОС СЕРВЕРА =====
async function fetchOrders() {
  try {
    const [pendingRes, activeRes] = await Promise.all([
      fetch(`${API_URL}/api/orders/pending`, { headers: { 'x-api-key': API_KEY } }),
      fetch(`${API_URL}/api/orders/active`,  { headers: { 'x-api-key': API_KEY } })
    ]);

    if (!pendingRes.ok) throw new Error(`HTTP ${pendingRes.status}`);
    if (!activeRes.ok)  throw new Error(`HTTP ${activeRes.status}`);

    pendingOrders = await pendingRes.json();
    activeOrders  = await activeRes.json();

    // Бейдж — кількість нових заявок
    const count = pendingOrders.length;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#1e3a5f' });

    // Повідомляємо popup якщо він відкритий
    chrome.runtime.sendMessage({
      type: 'orders_updated',
      pending: pendingOrders,
      active: activeOrders
    }).catch(() => {});

    // ===== АВТО-РОЗМІЩЕННЯ НОВИХ ЗАЯВОК =====
    let autoPostDelay = 0;
    for (const order of pendingOrders) {
      if (!autoPostedIds.has(order.id)) {
        autoPostedIds.add(order.id);
        persistAutoPostedIds();
        console.log(`[LogiDesk] Auto-posting order #${order.id}: ${order.data?.from} → ${order.data?.to} (delay: ${autoPostDelay * 2}s)`);
        setTimeout(() => autoPostOrder(order), autoPostDelay * 2000);
        autoPostDelay++;
      }
    }

  } catch (e) {
    console.error('[LogiDesk] Fetch error:', e.message);
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  }
}

// ===== АВТО-РОЗМІЩЕННЯ: спочатку Lardi (якщо не через API), потім Della =====
async function autoPostOrder(order) {
  console.log(`[LogiDesk] Starting auto-post for order #${order.id}`);

  if (order.posted_lardi) {
    // Lardi вже виставлено через API — відкриваємо тільки Della
    console.log(`[LogiDesk] Order #${order.id} already posted to Lardi via API → Della only`);
    await openAndFill('della', order);
  } else {
    // Lardi ще не виставлено — відкриваємо через розширення, Della — після підтвердження
    pendingDellaMap.set(order.id, order);
    await openAndFill('lardi', order);
  }
}

// ===== ВІДКРИТИ САЙТ І ЗАПОВНИТИ ФОРМУ =====
function openAndFill(platform, order) {
  const urls = {
    lardi: 'https://lardi-trans.com/log/mygruztrans/v2/add/gruz/',
    della: 'https://della.ua/placecargo/'
  };

  return new Promise((resolve) => {
    chrome.tabs.create({ url: urls[platform] }, (tab) => {
      const listener = (tabId, changeInfo) => {
        if (tabId !== tab.id || changeInfo.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(listener);

        // Чекаємо 3 сек поки React відрендерить форму
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, { type: 'fill_form', order }, (resp) => {
            console.log(`[LogiDesk] fill_form sent to ${platform} tab #${tab.id}`, resp);
          });

          // Fallback: позначаємо як active через 40 сек
          // (якщо content script не відповів — форма заповнюється ~25 сек)
          setTimeout(() => {
            markPosted(order.id, platform);
          }, 40000);

          resolve(tab);
        }, 3000);
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// ===== ПОЗНАЧИТИ ЯК РОЗМІЩЕНУ =====
async function markPosted(orderId, platform) {
  try {
    const res = await fetch(`${API_URL}/api/orders/${orderId}/status`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', platform })
    });
    if (res.ok) {
      console.log(`[LogiDesk] Order #${orderId} marked as active on ${platform}`);
      await fetchOrders();
    }
  } catch (e) {
    console.error('[LogiDesk] markPosted error:', e.message);
  }
}

// ===== ПОЗНАЧИТИ ЯК ОНОВЛЕНУ =====
async function markRefreshed(orderId, platform) {
  try {
    await fetch(`${API_URL}/api/orders/${orderId}/refreshed`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform })
    });
    await fetchOrders();
  } catch (e) {
    console.error('[LogiDesk] markRefreshed error:', e.message);
  }
}

// ===== ОБРОБКА ПОВІДОМЛЕНЬ ВІД POPUP І CONTENT SCRIPTS =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'get_orders') {
    sendResponse({ pending: pendingOrders, active: activeOrders });
    return true;
  }

  if (msg.type === 'post_lardi') {
    openAndFill('lardi', msg.order);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'post_della') {
    openAndFill('della', msg.order);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'mark_posted') {
    const { orderId, platform } = msg;
    markPosted(orderId, platform);

    // Якщо Lardi підтверджено → відкриваємо Della (тільки для авто-постів)
    if (platform === 'lardi') {
      const order = pendingDellaMap.get(orderId);
      if (order) {
        pendingDellaMap.delete(orderId);
        console.log(`[LogiDesk] Lardi confirmed → opening Della for order #${orderId} in 3s`);
        setTimeout(() => openAndFill('della', order), 3000);
      }
    }

    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'refresh_lardi') {
    markRefreshed(msg.orderId, 'lardi');
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'refresh_della') {
    markRefreshed(msg.orderId, 'della');
    sendResponse({ ok: true });
    return true;
  }
});

// ===== СТАРТ: опитування одразу при запуску SW =====
fetchOrders();
