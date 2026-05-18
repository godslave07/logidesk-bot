const API_URL = 'https://logidesk-bot-production.up.railway.app';
const API_KEY = 'logidesk2024';

let pendingOrders = [];
let activeOrders = [];

function minSince(ts) {
  if (!ts) return 9999;
  return Math.floor((Date.now() - new Date(ts)) / 60000);
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function(t, i) {
    t.classList.toggle('active', ['pending', 'active'][i] === name);
  });
  document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
  document.getElementById('tab-' + name).classList.add('active');
}

function renderPending(orders) {
  var el = document.getElementById('tab-pending');
  var countEl = document.getElementById('tab-pending-count');

  if (!orders || !orders.length) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">📭</div>Нових заявок немає</div>';
    countEl.textContent = '';
    return;
  }

  countEl.textContent = '(' + orders.length + ')';
  el.innerHTML = orders.map(function(o) {
    var d = o.data || {};
    var meta = [
      d.weight ? '⚖️ ' + d.weight + 'т' : '',
      d.volume ? '📐 ' + d.volume + 'м³' : '',
      d.truckType || '',
      d.price ? '💰 ' + d.price + ' ' + (d.currency || '') : '',
      d.paymentType || '',
      d.phone ? '📞 ' + d.phone : '',
      d.notes ? '📝 ' + d.notes : ''
    ].filter(Boolean).join(' · ');

    return '<div class="order-card">' +
      '<div class="order-header">' +
        '<span class="order-id">#' + o.id + '</span>' +
        '<span class="order-status status-new">Нова</span>' +
      '</div>' +
      '<div class="order-route">' + (d.from || '?') + ' → ' + (d.to || '?') + '</div>' +
      '<div class="order-meta">' + meta + '</div>' +
      '<div class="buttons">' +
        '<button class="btn btn-lardi" data-action="post_lardi" data-id="' + o.id + '">🟦 Розмістити Lardi</button>' +
        '<button class="btn btn-della" data-action="post_della" data-id="' + o.id + '">🟩 Розмістити Della</button>' +
        '<button class="btn btn-done" data-action="mark_done" data-id="' + o.id + '">✅ Виконано</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function renderActive(orders) {
  var el = document.getElementById('tab-active');
  var countEl = document.getElementById('tab-active-count');

  if (!orders || !orders.length) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">📋</div>Активних заявок немає</div>';
    countEl.textContent = '';
    return;
  }

  countEl.textContent = '(' + orders.length + ')';
  el.innerHTML = orders.map(function(o) {
    var d = o.data || {};
    var mL = minSince(o.last_refresh_lardi);
    var mD = minSince(o.last_refresh_della);
    var lClass = mL > 60 ? 'urgent' : mL > 50 ? 'warn' : 'rt';
    var dClass = mD > 30 ? 'urgent' : mD > 25 ? 'warn' : 'rt';

    var lardiInfo = o.posted_lardi
      ? '<span class="' + lClass + '">' + (mL > 60 ? '⚠️ ' : '') + 'Lardi: ' + (mL === 9999 ? '—' : mL + ' хв') + '</span>'
      : '';
    var dellaInfo = o.posted_della
      ? '<span class="' + dClass + '">' + (mD > 30 ? '⚠️ ' : '') + 'Della: ' + (mD === 9999 ? '—' : mD + ' хв') + '</span>'
      : '';

    var lardiBtn = o.posted_lardi
      ? '<button class="btn btn-refresh" data-action="refresh_lardi" data-id="' + o.id + '">🔄 Lardi</button>'
      : '<button class="btn btn-lardi" data-action="post_lardi" data-id="' + o.id + '">🟦 Lardi</button>';
    var dellaBtn = o.posted_della
      ? '<button class="btn btn-refresh" data-action="refresh_della" data-id="' + o.id + '">🔄 Della</button>'
      : '<button class="btn btn-della" data-action="post_della" data-id="' + o.id + '">🟩 Della</button>';

    return '<div class="order-card">' +
      '<div class="order-header">' +
        '<span class="order-id">#' + o.id + '</span>' +
        '<span class="order-status status-active">Активна</span>' +
      '</div>' +
      '<div class="order-route">' + (d.from || '?') + ' → ' + (d.to || '?') + '</div>' +
      '<div class="order-meta">' + [
        (d.weight ? '⚖️ ' + d.weight + 'т' : ''),
        (d.truckType || ''),
        (d.price ? '💰 ' + d.price + ' ' + (d.currency || '') : ''),
        (d.notes ? '📝 ' + d.notes : '')
      ].filter(Boolean).join(' · ') + '</div>' +
      '<div class="platforms">' +
        '<span class="pb ' + (o.posted_lardi ? 'on-l' : 'off') + '">' + (o.posted_lardi ? 'Lardi ✓' : 'Lardi —') + '</span>' +
        '<span class="pb ' + (o.posted_della ? 'on-d' : 'off') + '">' + (o.posted_della ? 'Della ✓' : 'Della —') + '</span>' +
      '</div>' +
      '<div class="refresh-timer">' + lardiInfo + dellaInfo + '</div>' +
      '<div class="buttons" style="margin-top:8px">' +
        lardiBtn + dellaBtn +
        '<button class="btn btn-done" data-action="mark_done" data-id="' + o.id + '">✅ Виконано</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function loadOrders() {
  document.getElementById('status-text').textContent = 'Завантаження...';

  Promise.all([
    fetch(API_URL + '/api/orders/pending', { headers: { 'x-api-key': API_KEY } }),
    fetch(API_URL + '/api/orders/active',  { headers: { 'x-api-key': API_KEY } })
  ]).then(function(responses) {
    if (!responses[0].ok) throw new Error('HTTP ' + responses[0].status);
    if (!responses[1].ok) throw new Error('HTTP ' + responses[1].status);
    return Promise.all([responses[0].json(), responses[1].json()]);
  }).then(function(data) {
    pendingOrders = data[0];
    activeOrders  = data[1];
    renderPending(pendingOrders);
    renderActive(activeOrders);
    document.getElementById('status-text').textContent =
      '🆕' + pendingOrders.length + ' 🟢' + activeOrders.length;
  }).catch(function(e) {
    document.getElementById('status-text').textContent = '❌ ' + e.message;
    console.error('[LogiDesk popup]', e);
  });
}

function postTo(platform, orderId) {
  var order = pendingOrders.concat(activeOrders).find(function(o) { return o.id === orderId; });
  if (!order) return;
  chrome.runtime.sendMessage({ type: 'post_' + platform, order: order });
  setTimeout(function() {
    fetch(API_URL + '/api/orders/' + orderId + '/status', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', platform: platform })
    }).then(loadOrders).catch(console.error);
  }, 3000);
}

function refreshSite(platform, orderId) {
  var urls = { lardi: 'https://lardi-trans.com/log/mygruztrans/', della: 'https://della.ua/myorders/' };
  chrome.tabs.create({ url: urls[platform] });
  fetch(API_URL + '/api/orders/' + orderId + '/refreshed', {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: platform })
  }).then(function() { setTimeout(loadOrders, 1000); }).catch(console.error);
}

function markDone(orderId) {
  fetch(API_URL + '/api/orders/' + orderId + '/status', {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'completed' })
  }).then(loadOrders).catch(console.error);
}

// Event delegation замість onclick=""
document.addEventListener('click', function(e) {
  var btn = e.target.closest('[data-action]');
  if (!btn) return;
  var action = btn.dataset.action;
  var id = parseInt(btn.dataset.id, 10);
  if (action === 'post_lardi')    postTo('lardi', id);
  if (action === 'post_della')    postTo('della', id);
  if (action === 'refresh_lardi') refreshSite('lardi', id);
  if (action === 'refresh_della') refreshSite('della', id);
  if (action === 'mark_done')     markDone(id);
});

// Слухаємо background.js
chrome.runtime.onMessage.addListener(function(msg) {
  if (msg.type === 'orders_updated') {
    pendingOrders = msg.pending || [];
    activeOrders  = msg.active  || [];
    renderPending(pendingOrders);
    renderActive(activeOrders);
    document.getElementById('status-text').textContent =
      '🆕' + pendingOrders.length + ' 🟢' + activeOrders.length;
  }
});

// ===== АВТО-РОЗМІЩЕННЯ TOGGLE =====
function applyAutoPostUI(enabled) {
  var block = document.getElementById('auto-block');
  var sub   = document.getElementById('auto-sub');
  if (enabled) {
    block.classList.add('on');
    sub.textContent = '● Працює';
  } else {
    block.classList.remove('on');
    sub.textContent = '○ Зупинено';
  }
}

function toggleAutoPost() {
  chrome.storage.local.get(['autoPostEnabled'], function(res) {
    var current = res.autoPostEnabled !== false; // default true
    var next = !current;
    chrome.storage.local.set({ autoPostEnabled: next }, function() {
      applyAutoPostUI(next);
      chrome.runtime.sendMessage({ type: 'set_auto_post', enabled: next });
    });
  });
}

// Старт
document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('tab-btn-pending').addEventListener('click', function() { switchTab('pending'); });
  document.getElementById('tab-btn-active').addEventListener('click',  function() { switchTab('active'); });
  document.getElementById('btn-refresh').addEventListener('click', loadOrders);
  document.getElementById('auto-block').addEventListener('click', toggleAutoPost);

  // Завантажити стан тогла
  chrome.storage.local.get(['autoPostEnabled'], function(res) {
    var enabled = res.autoPostEnabled !== false; // default true
    applyAutoPostUI(enabled);
  });

  loadOrders();
});
