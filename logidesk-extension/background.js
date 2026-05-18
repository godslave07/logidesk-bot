const API_URL = 'https://logidesk-bot-production.up.railway.app';
const API_KEY = 'logidesk2024';
const LARDI_SEARCH_URL = 'https://lardi-trans.com/log/search/gruz/wf3i640-27ii3i640-17ii3i640-29iwt3i640-23ipc2pv1000000pt1';

let pendingOrders = [];
let activeOrders = [];

// ===== АВТО-РОЗМІЩЕННЯ: стан тогла =====
let autoPostEnabled = true;
chrome.storage.local.get(['autoPostEnabled']).then(res => {
  if (res.autoPostEnabled === false) autoPostEnabled = false;
  console.log('[LogiDesk] autoPostEnabled loaded:', autoPostEnabled);
}).catch(() => {});

// Для ручного post_lardi з попапа: orderId → order (щоб потім відкрити Della)
const pendingDellaMap = new Map();

// IDs заявок що вже були авто-розміщені
const autoPostedIds = new Set();

// Відстеження відкритих форм-вкладок: tabId → { orderId, platform, fallbackTimer, resolve }
const formTabsMap = new Map();

// ===== ЧЕРГА АВТО-РОЗМІЩЕННЯ (один запис за раз) =====
const autoPostQueue = [];
let autoPostBusy = false;

function enqueueAutoPost(order) {
  autoPostQueue.push(order);
  if (!autoPostBusy) drainAutoPostQueue();
}

async function drainAutoPostQueue() {
  if (autoPostBusy) return;
  autoPostBusy = true;
  while (autoPostQueue.length > 0) {
    const order = autoPostQueue.shift();
    try {
      await autoPostOrder(order);
    } catch (e) {
      console.error('[LogiDesk] autoPostOrder error:', e.message);
    }
  }
  autoPostBusy = false;
}

// ===== ЗАВАНТАЖЕННЯ autoPostedIds + СТАРТ =====
chrome.storage.session.get(['autoPostedIds']).then(result => {
  (result.autoPostedIds || []).forEach(id => autoPostedIds.add(id));
  console.log('[LogiDesk] Loaded autoPostedIds from session:', autoPostedIds.size);
  fetchOrders();
}).catch(() => {
  fetchOrders();
});

function persistAutoPostedIds() {
  chrome.storage.session.set({ autoPostedIds: [...autoPostedIds] }).catch(() => {});
}

// ===== ALARMS =====
chrome.alarms.create('fetchOrders',        { periodInMinutes: 0.5 });
chrome.alarms.create('refreshDellaAuto',   { periodInMinutes: 10  });
chrome.alarms.create('importLardiSearch',  { periodInMinutes: 3   });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'fetchOrders')       fetchOrders();
  if (alarm.name === 'refreshDellaAuto')  maybeRefreshDella();
  if (alarm.name === 'importLardiSearch') importFromLardiSearch();
});

// ===== АВТО-ОНОВЛЕННЯ DELLA (8:00-18:00 за Берліном) =====
function isBerlinWorkHours() {
  const now = new Date();
  const hourStr = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: 'numeric',
    hour12: false
  }).format(now);
  const hour = parseInt(hourStr, 10);
  return hour >= 8 && hour < 18;
}

async function maybeRefreshDella() {
  if (!isBerlinWorkHours()) {
    console.log('[LogiDesk] Della auto-refresh skipped — outside working hours (Berlin 8:00-18:00)');
    return;
  }

  console.log('[LogiDesk] Della auto-refresh triggered');
  const tabs = await chrome.tabs.query({ url: 'https://della.ua/my/*' });

  if (tabs.length > 0) {
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
    chrome.tabs.create({ url: 'https://della.ua/my/' }, (tab) => {
      const autoTabId = tab.id;
      const listener = (tabId, changeInfo) => {
        if (tabId !== autoTabId || changeInfo.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => {
          const closeTimer = setTimeout(() => chrome.tabs.remove(autoTabId).catch(() => {}), 60000);
          chrome.tabs.sendMessage(autoTabId, { type: 'refresh_della_all' }, (resp) => {
            clearTimeout(closeTimer);
            console.log('[LogiDesk] Della auto-refresh result (new tab):', resp);
            chrome.tabs.remove(autoTabId).catch(() => {});
          });
        }, 5000);
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }
}

// ===== ІМПОРТ З LARDI SEARCH =====
async function importFromLardiSearch() {
  if (!autoPostEnabled) {
    console.log('[LogiDesk] importFromLardiSearch skipped — auto-post disabled');
    return;
  }
  try {
    const tabs = await chrome.tabs.query({ url: 'https://lardi-trans.com/log/search/gruz/*' });
    let tabId;

    if (tabs.length > 0) {
      tabId = tabs[0].id;
      const currentUrl = tabs[0].url || '';

      await new Promise(resolve => {
        if (currentUrl === LARDI_SEARCH_URL) {
          chrome.tabs.reload(tabId);
        } else {
          chrome.tabs.update(tabId, { url: LARDI_SEARCH_URL });
        }
        const listener = (tId, changeInfo) => {
          if (tId !== tabId || changeInfo.status !== 'complete') return;
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
    } else {
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

    await new Promise(r => setTimeout(r, 12000));

    chrome.tabs.sendMessage(tabId, { type: 'scrape_lardi_search' }, async (resp) => {
      if (chrome.runtime.lastError) {
        console.log('[LogiDesk] Lardi scrape error:', chrome.runtime.lastError.message);
        return;
      }
      if (!resp?.ok || !resp.proposals?.length) {
        console.log('[LogiDesk] Lardi search: 0 proposals found');
        return;
      }
      console.log('[LogiDesk] Lardi search: got ' + resp.proposals.length + ' proposals');

      try {
        const res = await fetch(API_URL + '/api/import/proposals', {
          method: 'POST',
          headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ proposals: resp.proposals }),
        });
        const data = await res.json();
        console.log('[LogiDesk] Imported ' + data.imported + '/' + data.total + ' new proposals');
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
      fetch(API_URL + '/api/orders/pending', { headers: { 'x-api-key': API_KEY } }),
      fetch(API_URL + '/api/orders/active',  { headers: { 'x-api-key': API_KEY } })
    ]);

    if (!pendingRes.ok) throw new Error('HTTP ' + pendingRes.status);
    if (!activeRes.ok)  throw new Error('HTTP ' + activeRes.status);

    pendingOrders = await pendingRes.json();
    activeOrders  = await activeRes.json();

    const count = pendingOrders.length;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#1e3a5f' });

    chrome.runtime.sendMessage({
      type: 'orders_updated',
      pending: pendingOrders,
      active: activeOrders
    }).catch(() => {});

    // ===== АВТО-РОЗМІЩЕННЯ — кладемо в чергу по одному =====
    for (const order of pendingOrders) {
      const source = order.data?._source || '';
      const isImported = source === 'lardi_import' || source === 'lardi_scrape';
      if (!isImported) continue;

      if (!autoPostedIds.has(order.id)) {
        autoPostedIds.add(order.id);
        persistAutoPostedIds();
        if (!autoPostEnabled) {
          console.log('[LogiDesk] Auto-post disabled — skipping order #' + order.id);
          continue;
        }
        console.log('[LogiDesk] Queuing auto-post for order #' + order.id + ': ' + order.data?.from + ' -> ' + order.data?.to);
        enqueueAutoPost(order);
      }
    }

  } catch (e) {
    console.error('[LogiDesk] Fetch error:', e.message);
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  }
}

// ===== АВТО-РОЗМІЩЕННЯ (послідовно: Lardi чекаємо → потім Della) =====
async function autoPostOrder(order) {
  console.log('[LogiDesk] Auto-post start: order #' + order.id);
  if (order.posted_lardi) {
    // Вже є на Lardi — виставляємо тільки на Della
    await openAndFill('della', order);
  } else {
    // Спочатку Lardi (чекаємо завершення), потім Della
    await openAndFill('lardi', order);
    await openAndFill('della', order);
  }
  console.log('[LogiDesk] Auto-post done: order #' + order.id);
}

// ===== ВІДКРИТИ ВКЛАДКУ З ФОРМОЮ =====
// Повертає Promise що резолвиться коли вкладка ЗАКРИТА (форма відправлена або fallback 45s)
function openAndFill(platform, order) {
  const urls = {
    lardi: 'https://lardi-trans.com/log/mygruztrans/v2/add/gruz/',
    della: 'https://della.ua/placecargo/'
  };

  return new Promise((resolve) => {
    chrome.tabs.create({ url: urls[platform] }, (tab) => {
      const tabId = tab.id;

      const listener = (tId, changeInfo) => {
        if (tId !== tabId || changeInfo.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(listener);

        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { type: 'fill_form', order }, (resp) => {
            console.log('[LogiDesk] fill_form sent to ' + platform + ' tab #' + tabId, resp);
          });

          // Fallback: якщо content script не відповів за 45 сек — закриваємо і рухаємось далі
          const fallbackTimer = setTimeout(() => {
            const info = formTabsMap.get(tabId);
            if (info) {
              formTabsMap.delete(tabId);
              console.log('[LogiDesk] Fallback close: ' + platform + ' tab #' + tabId + ' for order #' + order.id);
              chrome.tabs.remove(tabId).catch(() => {});
              markPosted(order.id, platform);
              info.resolve(); // черга рухається далі
            }
          }, 45000);

          formTabsMap.set(tabId, { orderId: order.id, platform, fallbackTimer, resolve });
        }, 3000);
      };

      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// ===== ЗАКРИТИ ВКЛАДКУ ФОРМИ (після підтвердження від content script) =====
function closeFormTab(tabId) {
  const info = formTabsMap.get(tabId);
  if (!info) return;
  clearTimeout(info.fallbackTimer);
  formTabsMap.delete(tabId);
  // Затримка щоб content script встиг завершити роботу, потім резолвимо чергу
  setTimeout(() => {
    chrome.tabs.remove(tabId).catch(() => {});
    info.resolve(); // черга рухається далі
  }, 1500);
}

// ===== ПОЗНАЧИТИ ЯК РОЗМІЩЕНУ =====
async function markPosted(orderId, platform) {
  try {
    const res = await fetch(API_URL + '/api/orders/' + orderId + '/status', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', platform })
    });
    if (res.ok) {
      console.log('[LogiDesk] Order #' + orderId + ' marked as active on ' + platform);
      await fetchOrders();
    }
  } catch (e) {
    console.error('[LogiDesk] markPosted error:', e.message);
  }
}

// ===== ПОЗНАЧИТИ ЯК ОНОВЛЕНУ =====
async function markRefreshed(orderId, platform) {
  try {
    await fetch(API_URL + '/api/orders/' + orderId + '/refreshed', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform })
    });
    await fetchOrders();
  } catch (e) {
    console.error('[LogiDesk] markRefreshed error:', e.message);
  }
}

// ===== ОБРОБКА ПОВІДОМЛЕНЬ =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'get_orders') {
    sendResponse({ pending: pendingOrders, active: activeOrders });
    return true;
  }

  if (msg.type === 'set_auto_post') {
    autoPostEnabled = msg.enabled;
    chrome.storage.local.set({ autoPostEnabled: autoPostEnabled });
    console.log('[LogiDesk] autoPostEnabled set to:', autoPostEnabled);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'post_lardi') {
    // Ручне розміщення: зберігаємо щоб після Lardi відкрити Della
    pendingDellaMap.set(msg.order.id, msg.order);
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

    // Закриваємо вкладку і резолвимо Promise (черга або ручний потік рухається далі)
    if (sender.tab?.id) {
      closeFormTab(sender.tab.id);
    }

    markPosted(orderId, platform);

    // Тільки для РУЧНОГО розміщення (post_lardi): після Lardi відкриваємо Della
    // Авто-розміщення цього не потребує — autoPostOrder сам чекає через await
    if (platform === 'lardi') {
      const order = pendingDellaMap.get(orderId);
      if (order) {
        pendingDellaMap.delete(orderId);
        console.log('[LogiDesk] Manual Lardi confirmed -> opening Della for order #' + orderId + ' in 3s');
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
