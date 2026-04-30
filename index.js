const express = require('express');
const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;

// ─── Gemini: парсинг заявки ───────────────────────────────────────────────────
async function parseCargo(text) {
  const prompt = `Ты парсер заявок на грузоперевозки. Из текста извлеки данные.
Верни ТОЛЬКО JSON объект, без markdown, без \`\`\`, без пояснений, просто { ... }

Поля JSON:
from - город отправления
fromCountry - страна отправления
to - город назначения
toCountry - страна назначения
cargoName - тип груза
weight - вес в тоннах (только число)
volume - объём м³ (только число)
dateFrom - дата от DD.MM.YYYY
dateTo - дата до DD.MM.YYYY
truckType - тип кузова: Тент, Рефрижератор, Відкритий, Контейнер, Борт, Цистерна, Самоскид, Зерновоз, Автовоз, Криті
loadType - Повна або Часткова
price - ставка число
currency - EUR USD UAH
paymentType - Готівка Безнал Картка
phone - телефон
notes - примітки

Якщо поле не знайдено - порожній рядок "".
Текст заявки: "${text}"`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0 }
      })
    }
  );

  const data = await response.json();
  console.log('Gemini raw:', JSON.stringify(data).slice(0, 500));
  
  if (!data.candidates || !data.candidates[0]) {
    throw new Error('Gemini no candidates: ' + JSON.stringify(data).slice(0, 200));
  }
  
  let raw = data.candidates[0].content.parts[0].text.trim();
  console.log('Raw text:', raw);
  
  // Чистим от markdown
  raw = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  
  // Находим JSON объект
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    raw = raw.slice(start, end + 1);
  }
  
  console.log('Cleaned JSON:', raw);
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
    console.error('Error:', e.message);
    await sendMessage(chatId, `❌ Помилка розбору. Деталі: ${e.message.slice(0,100)}`);
  }
});

app.get('/setup', async (req, res) => {
  const webhookUrl = `https://logidesk-bot-production.up.railway.app/webhook/${TOKEN}`;
  const result = await tg('setWebhook', { url: webhookUrl });
  res.json({ webhookUrl, result });
});

app.get('/', (req, res) => res.send('LogiDesk Bot is running ✅'));
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

