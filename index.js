const express = require('express');
const app = express();
app.use(express.json());

// CORS для Chrome Extension
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const API_KEY = process.env.API_KEY || 'logidesk2024';
const PORT = process.env.PORT || 3000;

const { Client } = require('pg');

async function getDb() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  return client;
}

async function initDb() {
  const db = await getDb();
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT,
      raw_text TEXT,
      data JSONB,
      status VARCHAR(20) DEFAULT 'new',
      posted_lardi BOOLEAN DEFAULT false,
      posted_della BOOLEAN DEFAULT false,
      last_refresh_lardi TIMESTAMP,
      last_refresh_della TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Добавляем новые колонки если их нет (миграция)
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS posted_lardi BOOLEAN DEFAULT false`).catch(() => {});
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS posted_della BOOLEAN DEFAULT false`).catch(() => {});
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_refresh_lardi TIMESTAMP`).catch(() => {});
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_refresh_della TIMESTAMP`).catch(() => {});
  await db.end();
  console.log('DB initialized');
}

// ===== ИИ ПАРСИНГ =====
async function parseCargo(text) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: `Ти парсер заявок на вантажоперевезення. З тексту витягни дані і поверни ТІЛЬКИ валідний JSON без markdown.
Поля: from, fromCountry, to, toCountry, cargoName, weight (тонни), volume (м³), dateFrom (DD.MM.YYYY), dateTo (DD.MM.YYYY), truckType (Тент/Рефрижератор/Відкритий/Контейнер/Борт/Цистерна/Самоскид/Зерновоз/Автовоз/Критий), loadType (Повна/Часткова), price (число), currency (EUR/USD/UAH), paymentType (Готівка/Безнал/Картка), phone, notes. Якщо поле не знайдено — порожній рядок. ТІЛЬКИ JSON.`,
      messages: [{ role: 'user', content: text }]
    })
  });
  const data = await response.json();
  const raw = data.content[0].text.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

function formatReply(p) {
  const line = (icon, label, val) => val ? `${icon} *${label}:* ${val}\n` : '';
  let msg = `✅ *Заявку розібрано*\n\n`;
  msg += `📍 *Маршрут:* ${p.from || '?'}${p.fromCountry ? ' (' + p.fromCountry + ')' : ''} → ${p.to || '?'}${p.toCountry ? ' (' + p.toCountry + ')' : ''}\n`;
  msg += line('📦', 'Вантаж', p.cargoName);
  msg += line('⚖️', 'Вага', p.weight ? p.weight + ' т' : '');
  msg += line('📐', "Об'єм", p.volume ? p.volume + ' м³' : '');
  msg += line('🚛', 'Кузов', p.truckType);
  msg += line('🔄', 'Завантаження', p.loadType);
  msg += line('📅', 'Дата від', p.dateFrom);
  msg += line('📅', 'Дата до', p.dateTo && p.dateTo !== p.dateFrom ? p.dateTo : '');
  msg += line('💰', 'Ставка', p.price ? p.price + ' ' + (p.currency || '') : '');
  msg += line('💳', 'Оплата', p.paymentType);
  msg += line('📞', 'Телефон', p.phone);
  msg += line('📝', 'Примітки', p.notes);
  return msg;
}

// ===== TELEGRAM =====
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

async function sendMessage(chatId, text, extra = {}) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
}

// ===== АВТО-НАПОМИНАНИЯ ОБ ОБНОВЛЕНИИ =====
function startRefreshReminders() {
  setInterval(async () => {
    try {
      const db = await getDb();

      // Lardi: напомнить если > 61 минуты
      const lardiOrders = await db.query(`
        SELECT id, chat_id FROM orders
        WHERE status = 'active' AND posted_lardi = true
        AND (last_refresh_lardi IS NULL OR last_refresh_lardi < NOW() - INTERVAL '61 minutes')
      `);
      for (const order of lardiOrders.rows) {
        await sendMessage(order.chat_id,
          `⏰ *Час оновити заявку #${order.id} на Lardi-Trans!*\n\nВідкрий Extension → натисни "Оновити Lardi"`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: '🟦 Відкрити Lardi', url: 'https://lardi-trans.com/log/mygruztrans/' }
              ]]
            }
          }
        );
        await db.query('UPDATE orders SET last_refresh_lardi = NOW() WHERE id = $1', [order.id]);
      }

      // Della: напомнить если > 30 минут
      const dellaOrders = await db.query(`
        SELECT id, chat_id FROM orders
        WHERE status = 'active' AND posted_della = true
        AND (last_refresh_della IS NULL OR last_refresh_della < NOW() - INTERVAL '30 minutes')
      `);
      for (const order of dellaOrders.rows) {
        await sendMessage(order.chat_id,
          `⏰ *Час оновити заявку #${order.id} на Della.ua!*\n\nВідкрий Extension → натисни "Оновити Della"`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: '🟩 Відкрити Della', url: 'https://della.ua/myorders/' }
              ]]
            }
          }
        );
        await db.query('UPDATE orders SET last_refresh_della = NOW() WHERE id = $1', [order.id]);
      }

      await db.end();
    } catch (e) {
      console.error('Refresh reminder error:', e.message);
    }
  }, 5 * 60 * 1000); // Проверяем каждые 5 минут

  console.log('Refresh reminders started');
}

// ===== TELEGRAM WEBHOOK =====
app.post(`/webhook/${TOKEN}`, async (req, res) => {
  res.sendStatus(200);
  const update = req.body;

  // Обработка кнопок
  if (update.callback_query) {
    const cq = update.callback_query;
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'OK' });
    const [action, orderId] = (cq.data || '').split(':');
    const chatId = cq.message.chat.id;

    if (action === 'cancel') {
      const db = await getDb();
      await db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [orderId]);
      await db.end();
      await sendMessage(chatId, `❌ Заявку #${orderId} скасовано. Зніміть з сайтів!`);
    } else if (action === 'complete') {
      const db = await getDb();
      await db.query("UPDATE orders SET status = 'completed' WHERE id = $1", [orderId]);
      await db.end();
      await sendMessage(chatId, `✅ Заявку #${orderId} виконано!`);
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text;

  // Команды
  if (text === '/start') {
    return sendMessage(chatId, `👋 *Ласкаво просимо до LogiDesk!*\n\nПишіть заявку в будь-якій формі:\n\n_Львів → Одеса, 0.7 т, 2 паллети, тент, 8000 грн нал, +38099..._\n\n📊 Команди:\n/list — активні заявки\n/stats — статистика\n/dashboard — посилання на дашборд`);
  }

  if (text === '/list') {
    const db = await getDb();
    const result = await db.query(
      "SELECT id, data, status, created_at FROM orders WHERE status IN ('new', 'active') ORDER BY created_at DESC LIMIT 10"
    );
    await db.end();
    if (result.rows.length === 0) return sendMessage(chatId, '📋 Немає активних заявок.');
    let reply = '📋 *Активні заявки:*\n\n';
    for (const row of result.rows) {
      const d = row.data || {};
      const icon = row.status === 'active' ? '🟢' : '🆕';
      reply += `${icon} *#${row.id}* ${d.from || '?'} → ${d.to || '?'} | ${d.weight || '?'}т | ${d.price || '?'} ${d.currency || ''}\n`;
    }
    return sendMessage(chatId, reply);
  }

  if (text === '/stats') {
    const db = await getDb();
    const result = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'new') as new_count,
        COUNT(*) FILTER (WHERE status = 'active') as active_count,
        COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
        COUNT(*) as total
      FROM orders WHERE chat_id = $1
    `, [chatId]);
    await db.end();
    const s = result.rows[0];
    return sendMessage(chatId, `📊 *Статистика:*\n\n🆕 Нових: ${s.new_count}\n🟢 Активних: ${s.active_count}\n✅ Виконаних: ${s.completed_count}\n📋 Всього: ${s.total}`);
  }

  if (text === '/dashboard') {
    return sendMessage(chatId, `📊 *Дашборд LogiDesk:*\n\nhttps://logidesk-bot-production.up.railway.app/dashboard`);
  }

  // Парсинг новой заявки
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    const parsed = await parseCargo(text);
    const db = await getDb();
    const result = await db.query(
      'INSERT INTO orders (chat_id, raw_text, data) VALUES ($1, $2, $3) RETURNING id',
      [chatId, text, JSON.stringify(parsed)]
    );
    await db.end();
    const orderId = result.rows[0].id;

    await sendMessage(chatId, formatReply(parsed) + `\n🆔 ID: \`${orderId}\`\n\n📌 _Відкрий Extension у Chrome — заявка вже там. Натисни "Розмістити" щоб опублікувати на сайтах._`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🟦 Відкрити Lardi вручну', url: 'https://lardi-trans.com/log/mygruztrans/v2/add/gruz/' },
            { text: '🟩 Відкрити Della вручну', url: 'https://della.ua/placecargo/' }
          ]
        ]
      }
    });
  } catch (e) {
    console.error('Parse error:', e.message);
    await sendMessage(chatId, `❌ Помилка парсингу: ${e.message.slice(0, 100)}\n\nСпробуйте ще раз або перефразуйте заявку.`);
  }
});

// ===== API для Chrome Extension =====

function auth(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Все заявки (для дашборда)
app.get('/api/orders', auth, async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query("SELECT * FROM orders ORDER BY created_at DESC LIMIT 100");
    await db.end();
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Только новые заявки (для Extension)
app.get('/api/orders/pending', auth, async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query("SELECT * FROM orders WHERE status = 'new' ORDER BY created_at ASC");
    await db.end();
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Активные заявки (для напоминаний об обновлении)
app.get('/api/orders/active', auth, async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query("SELECT * FROM orders WHERE status = 'active' ORDER BY created_at DESC");
    await db.end();
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Обновить статус заявки
app.post('/api/orders/:id/status', auth, async (req, res) => {
  try {
    const db = await getDb();
    const { status, platform } = req.body;
    const id = req.params.id;

    if (platform === 'lardi') {
      await db.query(
        "UPDATE orders SET status = $1, posted_lardi = true, last_refresh_lardi = NOW() WHERE id = $2",
        [status, id]
      );
    } else if (platform === 'della') {
      await db.query(
        "UPDATE orders SET status = $1, posted_della = true, last_refresh_della = NOW() WHERE id = $2",
        [status, id]
      );
    } else {
      await db.query("UPDATE orders SET status = $1 WHERE id = $2", [status, id]);
    }

    await db.end();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Отметить что заявку обновили на сайте
app.post('/api/orders/:id/refreshed', auth, async (req, res) => {
  try {
    const db = await getDb();
    const { platform } = req.body;
    if (platform === 'lardi') {
      await db.query('UPDATE orders SET last_refresh_lardi = NOW() WHERE id = $1', [req.params.id]);
    } else if (platform === 'della') {
      await db.query('UPDATE orders SET last_refresh_della = NOW() WHERE id = $1', [req.params.id]);
    }
    await db.end();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Статистика
app.get('/api/stats', auth, async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'new') as new_count,
        COUNT(*) FILTER (WHERE status = 'active') as active_count,
        COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
        COUNT(*) as total
      FROM orders
    `);
    await db.end();
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ВЕБ ДАШБОРД =====
app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LogiDesk — Дашборд</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, -apple-system, sans-serif; background: #f0f2f5; color: #1a1a1a; min-height: 100vh; }
header { background: #1e3a5f; color: white; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 10; }
header h1 { font-size: 18px; font-weight: 800; letter-spacing: -0.5px; }
header span { font-size: 12px; opacity: 0.6; }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; padding: 16px; }
.stat { background: white; border-radius: 10px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.07); }
.stat-num { font-size: 26px; font-weight: 800; }
.stat-label { font-size: 11px; color: #888; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.3px; }
.stat.new .stat-num { color: #3b82f6; }
.stat.active .stat-num { color: #22c55e; }
.stat.done .stat-num { color: #8b5cf6; }
.stat.total .stat-num { color: #f59e0b; }
.section { padding: 0 16px 20px; }
.section-title { font-size: 12px; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }
.card { background: white; border-radius: 10px; padding: 14px; margin-bottom: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.07); display: flex; gap: 10px; }
.card-id { font-size: 11px; font-weight: 700; color: #aaa; background: #f3f4f6; padding: 4px 8px; border-radius: 6px; height: fit-content; min-width: 36px; text-align: center; }
.card-body { flex: 1; min-width: 0; }
.route { font-size: 15px; font-weight: 700; margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tags { display: flex; flex-wrap: wrap; gap: 5px; }
.tag { font-size: 11px; background: #f3f4f6; padding: 2px 8px; border-radius: 20px; color: #555; }
.refresh-info { display: flex; gap: 8px; margin-top: 6px; }
.rt { font-size: 11px; color: #aaa; }
.rt.warn { color: #f59e0b; font-weight: 700; }
.rt.urgent { color: #ef4444; font-weight: 700; }
.card-right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; min-width: 80px; }
.badge { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 20px; white-space: nowrap; }
.badge.new { background: #dbeafe; color: #1d4ed8; }
.badge.active { background: #dcfce7; color: #16a34a; }
.badge.completed { background: #f3e8ff; color: #7c3aed; }
.badge.cancelled { background: #fee2e2; color: #dc2626; }
.platforms { display: flex; gap: 3px; }
.pb { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; }
.pb.on { background: #1e3a5f; color: white; }
.pb.off { background: #e5e7eb; color: #aaa; }
.pb.della-on { background: #166534; color: white; }
.actions { display: flex; gap: 4px; }
.btn { font-size: 11px; padding: 4px 10px; border-radius: 6px; border: 1px solid #e5e7eb; cursor: pointer; background: white; transition: background 0.15s; }
.btn:hover { background: #f3f4f6; }
.btn.ok { color: #16a34a; border-color: #86efac; }
.btn.del { color: #dc2626; border-color: #fca5a5; }
.empty { text-align: center; padding: 30px; color: #aaa; font-size: 14px; }
</style>
</head>
<body>
<header>
  <h1>🚛 LogiDesk</h1>
  <span id="last-upd">Завантаження...</span>
</header>

<div class="stats">
  <div class="stat new"><div class="stat-num" id="s-new">—</div><div class="stat-label">Нових</div></div>
  <div class="stat active"><div class="stat-num" id="s-active">—</div><div class="stat-label">Активних</div></div>
  <div class="stat done"><div class="stat-num" id="s-done">—</div><div class="stat-label">Виконаних</div></div>
  <div class="stat total"><div class="stat-num" id="s-total">—</div><div class="stat-label">Всього</div></div>
</div>

<div class="section">
  <div class="section-title">Заявки</div>
  <div id="orders-list"><div class="empty">Завантаження...</div></div>
</div>

<script>
const API_KEY = '${API_KEY}';

function minSince(ts) {
  if (!ts) return 9999;
  return Math.floor((Date.now() - new Date(ts)) / 60000);
}
function timeSince(ts) {
  const m = minSince(ts);
  if (m < 1) return 'тільки що';
  if (m < 60) return m + ' хв тому';
  return Math.floor(m / 60) + ' год тому';
}

const STATUS_LABEL = { new: 'Нова', active: 'Активна', completed: 'Виконана', cancelled: 'Скасована' };

async function load() {
  try {
    const [oRes, sRes] = await Promise.all([
      fetch('/api/orders', { headers: { 'x-api-key': API_KEY } }),
      fetch('/api/stats', { headers: { 'x-api-key': API_KEY } })
    ]);
    const orders = await oRes.json();
    const stats = await sRes.json();

    document.getElementById('s-new').textContent = stats.new_count || 0;
    document.getElementById('s-active').textContent = stats.active_count || 0;
    document.getElementById('s-done').textContent = stats.completed_count || 0;
    document.getElementById('s-total').textContent = stats.total || 0;
    document.getElementById('last-upd').textContent = new Date().toLocaleTimeString('uk-UA');

    const visible = orders.filter(o => o.status !== 'cancelled');
    const list = document.getElementById('orders-list');

    if (!visible.length) { list.innerHTML = '<div class="empty">Немає заявок</div>'; return; }

    list.innerHTML = visible.map(o => {
      const d = o.data || {};
      const mL = minSince(o.last_refresh_lardi);
      const mD = minSince(o.last_refresh_della);
      const lWarn = o.posted_lardi && mL > 50;
      const lUrgent = o.posted_lardi && mL > 60;
      const dWarn = o.posted_della && mD > 25;
      const dUrgent = o.posted_della && mD > 30;

      const lClass = lUrgent ? 'urgent' : lWarn ? 'warn' : 'rt';
      const dClass = dUrgent ? 'urgent' : dWarn ? 'warn' : 'rt';

      return \`<div class="card">
        <div class="card-id">#\${o.id}</div>
        <div class="card-body">
          <div class="route">\${d.from || '?'} → \${d.to || '?'}</div>
          <div class="tags">
            \${d.weight ? \`<span class="tag">⚖️ \${d.weight}т</span>\` : ''}
            \${d.volume ? \`<span class="tag">📐 \${d.volume}м³</span>\` : ''}
            \${d.truckType ? \`<span class="tag">🚛 \${d.truckType}</span>\` : ''}
            \${d.price ? \`<span class="tag">💰 \${d.price} \${d.currency || ''}</span>\` : ''}
            \${d.paymentType ? \`<span class="tag">\${d.paymentType}</span>\` : ''}
            <span class="tag">🕐 \${timeSince(o.created_at)}</span>
          </div>
          \${o.status === 'active' ? \`<div class="refresh-info">
            \${o.posted_lardi ? \`<span class="\${lClass}">\${lUrgent ? '⚠️ ' : ''}Lardi: \${mL === 9999 ? '—' : mL + ' хв'}</span>\` : ''}
            \${o.posted_della ? \`<span class="\${dClass}">\${dUrgent ? '⚠️ ' : ''}Della: \${mD === 9999 ? '—' : mD + ' хв'}</span>\` : ''}
          </div>\` : ''}
        </div>
        <div class="card-right">
          <span class="badge \${o.status}">\${STATUS_LABEL[o.status] || o.status}</span>
          <div class="platforms">
            <span class="pb \${o.posted_lardi ? 'on' : 'off'}">L</span>
            <span class="pb \${o.posted_della ? 'della-on' : 'off'}">D</span>
          </div>
          \${o.status !== 'completed' && o.status !== 'cancelled' ? \`
          <div class="actions">
            <button class="btn ok" onclick="setStatus(\${o.id},'completed')">✅</button>
            <button class="btn del" onclick="setStatus(\${o.id},'cancelled')">❌</button>
          </div>\` : ''}
        </div>
      </div>\`;
    }).join('');
  } catch (e) {
    document.getElementById('last-upd').textContent = 'Помилка: ' + e.message;
  }
}

async function setStatus(id, status) {
  await fetch('/api/orders/' + id + '/status', {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  load();
}

load();
setInterval(load, 30000);
</script>
</body>
</html>`);
});

// ===== SETUP WEBHOOK =====
app.get('/setup', async (req, res) => {
  const webhookUrl = `https://logidesk-bot-production.up.railway.app/webhook/${TOKEN}`;
  const result = await tg('setWebhook', { url: webhookUrl });
  res.json({ webhookUrl, result });
});

app.get('/', (req, res) => {
  res.send('LogiDesk ✅ | <a href="/dashboard">📊 Дашборд</a>');
});

// ===== СТАРТ =====
initDb().then(() => {
  startRefreshReminders();
  app.listen(PORT, () => console.log(`LogiDesk started on port ${PORT}`));
});
