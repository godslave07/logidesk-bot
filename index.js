const express = require('express');
const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
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
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.end();
  console.log('DB initialized');
}

// ─── Claude: парсинг заявки ───────────────────────────────────────────────────
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
      system: `Ты парсер заявок на грузоперевозки. Из текста извлеки данные и верни ТОЛЬКО валидный JSON без markdown.
Поля: from, fromCountry, to, toCountry, cargoName, weight (тонни), volume (м³), dateFrom (DD.MM.YYYY), dateTo (DD.MM.YYYY), truckType (Тент/Рефрижератор/Відкритий/Контейнер/Борт/Цистерна/Самоскид/Зерновоз/Автовоз/Критий), loadType (Повна/Часткова), price (число), currency (EUR/USD/UAH), paymentType (Готівка/Безнал/Картка), phone, notes. Якщо поле не знайдено — порожній рядок. ТІЛЬКИ JSON.`,
      messages: [{ role: 'user', content: text }]
    })
  });
  const data = await response.json();
  const raw = data.content[0].text.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

// ─── Форматирование ───────────────────────────────────────────────────────────
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
  msg += `\n_Заявку збережено. Extension розмістить автоматично._`;
  return msg;
}

// ─── Telegram API ─────────────────────────────────────────────────────────────
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

// ─── Webhook ──────────────────────────────────────────────────────────────────
app.post(`/webhook/${TOKEN}`, async (req, res) => {
  res.sendStatus(200);
  const update = req.body;

  if (update.callback_query) {
    await tg('answerCallbackQuery', { callback_query_id: update.callback_query.id, text: 'OK' });
    return;
  }

  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === '/start') {
    return sendMessage(chatId, `👋 *Привіт! Я LogiDesk бот.*\n\nПиши заявку в будь-якій формі:\n\n_Харків → Варшава, 10 тонн, тент, 15 травня, 1200 євро нал, +380671234567_\n\nЯ розберу і збережу. Chrome Extension розмістить на Lardi і Della автоматично.`);
  }

  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });

  try {
    const parsed = await parseCargo(text);

    // Зберігаємо в БД
    const db = await getDb();
    const result = await db.query(
      'INSERT INTO orders (chat_id, raw_text, data) VALUES ($1, $2, $3) RETURNING id',
      [chatId, text, JSON.stringify(parsed)]
    );
    await db.end();
    const orderId = result.rows[0].id;

    await sendMessage(chatId, formatReply(parsed) + `\n🆔 ID заявки: \`${orderId}\``, {
      reply_markup: {
        inline_keyboard: [[
          { text: '🟦 Lardi-Trans', url: 'https://lardi-trans.com/log/mygruztrans/v2/add/gruz/' },
          { text: '🟩 Della.ua', url: 'https://della.ua/placecargo/' }
        ]]
      }
    });
  } catch (e) {
    console.error('Error:', e.message);
    await sendMessage(chatId, `❌ Помилка: ${e.message.slice(0, 100)}`);
  }
});

// ─── API для Chrome Extension ─────────────────────────────────────────────────
// Отримати нові заявки
app.get('/api/orders/pending', async (req, res) => {
  const key = req.headers['x-api-key'];
  if (key !== process.env.API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const db = await getDb();
    const result = await db.query(
      "SELECT * FROM orders WHERE status = 'new' ORDER BY created_at ASC"
    );
    await db.end();
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Оновити статус заявки
app.post('/api/orders/:id/status', async (req, res) => {
  const key = req.headers['x-api-key'];
  if (key !== process.env.API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const db = await getDb();
    await db.query('UPDATE orders SET status = $1 WHERE id = $2', [req.body.status, req.params.id]);
    await db.end();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/setup', async (req, res) => {
  const webhookUrl = `https://logidesk-bot-production.up.railway.app/webhook/${TOKEN}`;
  const result = await tg('setWebhook', { url: webhookUrl });
  res.json({ webhookUrl, result });
});

app.get('/', (req, res) => res.send('LogiDesk Bot is running ✅'));

initDb().then(() => {
  app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
});
