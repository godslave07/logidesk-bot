const express = require('express');
const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;

// ─── Gemini: парсинг заявки ───────────────────────────────────────────────────
async function parseCargo(text) {
  const prompt = `Ты парсер заявок на грузоперевозки. Из текста извлеки данные и верни ТОЛЬКО валидный JSON без markdown и без пояснений.
Поля: from, fromCountry, to, toCountry, cargoName, weight (тонны), volume (м³), dateFrom (DD.MM.YYYY), dateTo (DD.MM.YYYY), truckType (Тент/Рефрижератор/Открытый/Контейнер/Борт/Цистерна/Самосвал/Зерновоз/Автовоз), loadType (Повна/Часткова), price (число), currency (EUR/USD/UAH), paymentType (Готівка/Безнал/Картка), phone, notes.
Если поле не найдено — пустая строка. ТОЛЬКО JSON без обёртки.

Текст: ${text}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 }
      })
    }
  );

  const data = await response.json();
  const raw = data.candidates[0].content.parts[0].text
    .trim().replace(/```json|```/g, '').trim();
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
  msg += `\n_Натисни кнопку нижче щоб розмістити:_`;
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
    await tg('answerCallbackQuery', { callback_query_id: update.callback_query.id, text: 'Відкрий сайт та заповни дані' });
    return;
  }

  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === '/start') {
    return sendMessage(chatId, `👋 *Привіт! Я LogiDesk бот.*\n\nПиши заявку в будь-якій формі:\n\n_Харків Варшава, 10 тонн, тент, 15 травня, 1200 євро нал, +380671234567_\n\nЯ розберу і дам кнопки для розміщення.`);
  }

  if (text === '/help') {
    return sendMessage(chatId, `📋 Пиши заявку текстом — маршрут, вага, дати, кузов, ставка, телефон. Я все розберу автоматично.`);
  }

  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });

  try {
    const parsed = await parseCargo(text);
    await sendMessage(chatId, formatReply(parsed), {
      reply_markup: {
        inline_keyboard: [[
          { text: '🟦 Lardi-Trans', url: 'https://lardi-trans.com/log/mygruztrans/v2/add/gruz/' },
          { text: '🟩 Della.ua', url: 'https://della.ua/placecargo/' }
        ]]
      }
    });
  } catch (e) {
    console.error('Error:', e);
    await sendMessage(chatId, '❌ Не зміг розібрати. Спробуй переформулювати заявку.');
  }
});

app.get('/setup', async (req, res) => {
  const webhookUrl = `${process.env.WEBHOOK_URL}/webhook/${TOKEN}`;
  const result = await tg('setWebhook', { url: webhookUrl });
  res.json({ webhookUrl, result });
});

app.get('/', (req, res) => res.send('LogiDesk Bot is running ✅'));
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
