const express = require('express');
const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

// ─── Claude: парсинг заявки ───────────────────────────────────────────────────
async function parseCargo(text) {
  const system = `Ты парсер заявок на грузоперевозки. Из текста извлеки данные и верни ТОЛЬКО валидный JSON без markdown.
Поля:
- from: город отправления
- fromCountry: страна отправления  
- to: город назначения
- toCountry: страна назначения
- cargoName: название/тип груза
- weight: вес (только число, тонны)
- volume: объём (только число, м³)
- dateFrom: дата загрузки от (DD.MM.YYYY)
- dateTo: дата загрузки до (DD.MM.YYYY)
- truckType: тип кузова (Тент/Рефрижератор/Открытый/Контейнер/Борт/Цистерна/Самосвал/Зерновоз/Автовоз)
- loadType: Повна/Часткова
- price: ставка (только число)
- currency: EUR/USD/UAH
- paymentType: Готівка/Безнал/Картка
- phone: телефон
- notes: примечания

Если поле не найдено — пустая строка. Отвечай ТОЛЬКО JSON.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system,
      messages: [{ role: 'user', content: text }]
    })
  });

  const data = await response.json();
  const raw = data.content[0].text.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

// ─── Форматирование ответа ────────────────────────────────────────────────────
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

async function sendTyping(chatId) {
  return tg('sendChatAction', { chat_id: chatId, action: 'typing' });
}

// ─── Webhook ──────────────────────────────────────────────────────────────────
app.post(`/webhook/${TOKEN}`, async (req, res) => {
  res.sendStatus(200); // быстро отвечаем Telegram

  const update = req.body;
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text;

  // Команды
  if (text === '/start') {
    return sendMessage(chatId,
      `👋 *Привіт! Я LogiDesk бот.*\n\nПиши заявку в будь-якій формі, наприклад:\n\n_Харків → Варшава, 10 тонн, тент, 15 травня, 1200 євро нал, +380671234567_\n\nЯ розберу і розміщу на Lardi-Trans та Della.ua`
    );
  }

  if (text === '/help') {
    return sendMessage(chatId,
      `📋 *Що я вмію:*\n\n• Приймаю заявку текстом у будь-якому форматі\n• Розбираю маршрут, вагу, дати, тип кузова, ставку\n• Даю кнопки для розміщення на Lardi і Della\n\n*Приклад:*\n_Київ Польща, 5т зерно, зерновоз, 20-21.05, 800 USD безнал_`
    );
  }

  // Парсинг заявки
  await sendTyping(chatId);

  try {
    const parsed = await parseCargo(text);
    const replyText = formatReply(parsed);

    // Inline кнопки для размещения
    await sendMessage(chatId, replyText, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🟦 Lardi-Trans', url: 'https://lardi-trans.com/log/mygruztrans/v2/add/gruz/' },
            { text: '🟩 Della.ua', url: 'https://della.ua/placecargo/' }
          ],
          [
            { text: '✅ Обидва сайти', callback_data: 'post_both' }
          ]
        ]
      }
    });

  } catch (e) {
    console.error('Parse error:', e);
    await sendMessage(chatId, '❌ Не зміг розібрати. Спробуй ще раз або перефразуй заявку.');
  }
});

// Callback для inline кнопок
app.post(`/webhook/${TOKEN}`, async (req, res) => {
  const update = req.body;
  if (update.callback_query) {
    await tg('answerCallbackQuery', {
      callback_query_id: update.callback_query.id,
      text: 'Відкрий обидва сайти та вставте дані'
    });
  }
});

// ─── Установка webhook ────────────────────────────────────────────────────────
app.get('/setup', async (req, res) => {
  const webhookUrl = `${process.env.WEBHOOK_URL}/webhook/${TOKEN}`;
  const result = await tg('setWebhook', { url: webhookUrl });
  res.json({ webhookUrl, result });
});

app.get('/', (req, res) => res.send('LogiDesk Bot is running ✅'));

app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
