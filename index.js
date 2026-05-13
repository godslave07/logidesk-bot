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

const TOKEN         = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL  = process.env.DATABASE_URL;
const API_KEY       = process.env.API_KEY || 'logidesk2024';
const PORT          = process.env.PORT || 3000;
const LARDI_TOKEN   = process.env.LARDI_API_TOKEN || null;
const LARDI_BASE    = 'https://api.lardi-trans.com/v2';

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
  // Міграція — додаємо нові колонки якщо їх нема
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS posted_lardi BOOLEAN DEFAULT false`).catch(() => {});
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS posted_della BOOLEAN DEFAULT false`).catch(() => {});
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_refresh_lardi TIMESTAMP`).catch(() => {});
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_refresh_della TIMESTAMP`).catch(() => {});
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS lardi_proposal_id BIGINT`).catch(() => {});
  await db.query(`ALTER TABLE orders ALTER COLUMN lardi_proposal_id TYPE BIGINT`).catch(() => {});
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_lardi_id BIGINT`).catch(() => {});
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS orders_source_lardi_id_idx ON orders(source_lardi_id) WHERE source_lardi_id IS NOT NULL`).catch(() => {});

  // Очищуємо записи першої синхронізації (вона включала Лену) — при старті sync повторно
  // імпортує тільки заявки Валентина завдяки фільтру owner.face
  const deleted = await db.query(
    `DELETE FROM orders WHERE chat_id = 0 AND data->>'_source' = 'lardi_sync'`
  ).catch(() => ({ rowCount: 0 }));
  if (deleted.rowCount > 0) {
    console.log(`[DB Init] Cleaned up ${deleted.rowCount} old lardi_sync records (will re-import filtered)`);
  }

  // Скасовуємо тестові заявки бота (розміщені під час налагодження)
  const cancelled = await db.query(
    `UPDATE orders SET status = 'cancelled'
     WHERE lardi_proposal_id IN (213524581561, 267071521718) AND status != 'cancelled'`
  ).catch(() => ({ rowCount: 0 }));
  if (cancelled.rowCount > 0) {
    console.log(`[DB Init] Marked ${cancelled.rowCount} test bot orders as cancelled`);
  }

  await db.end();
  console.log('DB initialized');
}

// ===== LARDI API =====

// In-memory reference data cache (refreshed every hour)
let _lardiRefs = null;
let _lardiRefsTs = 0;

// Lardi API may return arrays directly OR wrapped: {data:[...]}, {items:[...]}, {result:[...]}
function extractArr(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.data))   return raw.data;
  if (raw && Array.isArray(raw.items))  return raw.items;
  if (raw && Array.isArray(raw.result)) return raw.result;
  // Some endpoints return a plain object map — convert to array
  if (raw && typeof raw === 'object') {
    const vals = Object.values(raw);
    if (vals.length && typeof vals[0] === 'object') return vals;
  }
  return [];
}

async function loadLardiRefs() {
  if (!LARDI_TOKEN) return null;
  if (_lardiRefs && (Date.now() - _lardiRefsTs) < 3600000) return _lardiRefs;

  try {
    const h = { 'Authorization': LARDI_TOKEN, 'Content-Type': 'application/json' };
    const lang = 'uk';
    const get = url => fetch(url, { headers: h }).then(r => r.json());

    const [rawBody, rawCur, rawMoments, rawUnits, rawTypes] = await Promise.all([
      get(`${LARDI_BASE}/references/body/types?language=${lang}`),
      get(`${LARDI_BASE}/references/currencies?language=${lang}`),
      get(`${LARDI_BASE}/references/payment/moments?language=${lang}`),
      get(`${LARDI_BASE}/references/payment/units?language=${lang}`),
      get(`${LARDI_BASE}/references/payment/types?language=${lang}`),
    ]);

    const bodyTypes     = extractArr(rawBody);
    const currencies    = extractArr(rawCur);
    const paymentMoments= extractArr(rawMoments);
    const paymentUnits  = extractArr(rawUnits);
    const paymentTypes  = extractArr(rawTypes);

    _lardiRefs = { bodyTypes, currencies, paymentMoments, paymentUnits, paymentTypes,
                   _raw: { rawBody, rawCur, rawMoments, rawUnits, rawTypes } };
    _lardiRefsTs = Date.now();
    console.log(`[Lardi] Refs loaded — body:${bodyTypes.length} cur:${currencies.length} moments:${paymentMoments.length} units:${paymentUnits.length} types:${paymentTypes.length}`);
    return _lardiRefs;
  } catch (e) {
    console.error('[Lardi] loadLardiRefs error:', e.message);
    return null;
  }
}

async function lookupLardiCity(cityName) {
  if (!LARDI_TOKEN || !cityName) return null;
  try {
    const url = `${LARDI_BASE}/references/towns?query=${encodeURIComponent(cityName)}&language=uk`;
    const res = await fetch(url, { headers: { 'Authorization': LARDI_TOKEN } });
    const raw  = await res.json();
    // API може повернути масив або paginated об'єкт {content:[...]}
    const list = Array.isArray(raw) ? raw : extractArr(raw.content ?? raw);
    if (!list.length) {
      console.warn('[Lardi] lookupLardiCity: no results for', cityName, '| raw:', JSON.stringify(raw).slice(0, 200));
      return null;
    }
    const lower = cityName.toLowerCase().trim();
    const found = list.find(c => (c.name || '').toLowerCase() === lower) || list[0];
    console.log('[Lardi] lookupLardiCity', cityName, '→', JSON.stringify(found));
    return found;
  } catch (e) {
    console.error('[Lardi] lookupLardiCity error:', e.message);
    return null;
  }
}

function _findInList(list, ...keywords) {
  return list.find(item =>
    keywords.some(kw => item.name.toLowerCase().includes(kw.toLowerCase()))
  );
}

function getBodyTypeIds(refs, truckTypeStr) {
  // Keyword → body type name fragments
  const TRUCK_MAP = [
    { keys: ['тент', 'шторн', 'крит'],         frags: ['тент', 'шторн'] },
    { keys: ['ізотерм', 'изотерм'],             frags: ['ізотерм', 'изотерм'] },
    { keys: ['реф', 'холодильн'],               frags: ['реф', 'холодильн'] },
    { keys: ['цільно', 'цельн', 'закрит', 'закры'], frags: ['цільно', 'цельно', 'закри', 'закры'] },
    { keys: ['борт', 'відкр', 'открыт'],        frags: ['борт', 'відкрит', 'открыт'] },
    { keys: ['платформ', 'низьк'],              frags: ['платформ', 'низьк'] },
    { keys: ['зерновоз'],                       frags: ['зерновоз'] },
    { keys: ['автовоз'],                        frags: ['автовоз'] },
    { keys: ['контейнер'],                      frags: ['контейнер'] },
    { keys: ['самоскид', 'самосвал'],           frags: ['самоскид', 'самосвал'] },
    { keys: ['цистерн'],                        frags: ['цистерн'] },
  ];

  if (!refs?.bodyTypes?.length) {
    // Hardcoded fallback (from API docs samples + common knowledge)
    // IDs verified against live Lardi API /v2/references/body/types
    const FALLBACK = { тент: 34, ізотерм: 25, реф: 18, цільно: 36, борт: 63, платформ: 64, контейнер: 27, автовоз: 20, зерновоз: 21, самоскид: 20, цистерн: 15 };
    if (!truckTypeStr) return [34]; // тент default
    const lower = truckTypeStr.toLowerCase();
    for (const [kw, id] of Object.entries(FALLBACK)) {
      if (lower.includes(kw)) return [id];
    }
    return [34];
  }

  if (!truckTypeStr) {
    // Default: Тент
    const tent = _findInList(refs.bodyTypes, 'тент');
    return tent ? [tent.id] : [refs.bodyTypes[0].id];
  }

  const lower = truckTypeStr.toLowerCase();
  for (const { keys, frags } of TRUCK_MAP) {
    if (keys.some(k => lower.includes(k))) {
      const match = refs.bodyTypes.find(b => frags.some(f => b.name.toLowerCase().includes(f)));
      if (match) return [match.id];
    }
  }
  // last resort — first type
  return [refs.bodyTypes[0].id];
}

function getCurrencyId(refs, currencyStr) {
  const c = (currencyStr || '').toLowerCase();
  if (!refs?.currencies?.length) {
    if (c.includes('usd') || c === '$') return 4;
    if (c.includes('eur') || c === '€') return 6;
    return 2;
  }
  if (c.includes('usd') || c === '$') return (_findInList(refs.currencies, '$', 'usd', 'дол') || { id: 4 }).id;
  if (c.includes('eur') || c === '€') return (_findInList(refs.currencies, '€', 'eur', 'євр') || { id: 6 }).id;
  return (_findInList(refs.currencies, 'грн', 'uah') || { id: 2 }).id;
}

function getPaymentUnitId(refs) {
  // Lardi only has km(2) and t(4) as units — no "per trip".
  // Return null so we skip this field (price is treated as total for the route).
  if (!refs?.paymentUnits?.length) return null;
  const unit = _findInList(refs.paymentUnits, 'рейс', 'trip', 'journey', 'поїзд');
  return unit ? unit.id : null; // don't default to km/ton — just omit
}

function getPaymentMomentId(refs, momentStr) {
  if (!momentStr) return null;
  const lower = momentStr.toLowerCase();
  if (!refs?.paymentMoments?.length) {
    if (lower.includes('розвантаж') || lower.includes('выгруз')) return 4;
    if (lower.includes('завантаж')  || lower.includes('загруз'))  return 2;
    return null;
  }
  if (lower.includes('розвантаж') || lower.includes('выгруз'))
    return (_findInList(refs.paymentMoments, 'розвантаж', 'вигруз', 'выгруз') || { id: 4 }).id;
  if (lower.includes('завантаж') || lower.includes('загруз'))
    return (_findInList(refs.paymentMoments, 'завантаж', 'загруз') || { id: 2 }).id;
  if (lower.includes('передоплат') || lower.includes('предоплат'))
    return _findInList(refs.paymentMoments, 'передоплат', 'предоплат')?.id || null;
  return null;
}

function getPaymentFormIds(refs, paymentTypeStr) {
  if (!paymentTypeStr) return null;
  const lower = paymentTypeStr.toLowerCase();
  if (!refs?.paymentTypes?.length) {
    if (lower.includes('готів') || lower.includes('нал'))   return [2];
    if (lower.includes('безгот') || lower.includes('безнал')) return [4];
    if (lower.includes('картк'))                             return [10];
    return null;
  }
  const kw = lower.includes('готів') || lower.includes('нал') ? ['готів', 'cash', 'нал']
           : lower.includes('безгот') || lower.includes('безнал') ? ['безгот', 'wire', 'безнал', 'перерах']
           : lower.includes('картк') ? ['картк', 'card']
           : null;
  if (!kw) return null;
  const match = refs.paymentTypes.find(t => kw.some(k => t.name.toLowerCase().includes(k)));
  return match ? [match.id] : null;
}

function parseISODate(str) {
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(str)) {
    const [d, m, y] = str.split('.');
    return `${y}-${m}-${d}`;
  }
  return null;
}

async function postToLardiAPI(order) {
  if (!LARDI_TOKEN) return null;

  const d = order.data || order;

  // Load refs (cached)
  const refs = await loadLardiRefs();

  // City lookup
  const [fromCity, toCity] = await Promise.all([
    lookupLardiCity(d.from),
    lookupLardiCity(d.to),
  ]);
  console.log('[Lardi API] fromCity:', JSON.stringify(fromCity));
  console.log('[Lardi API] toCity:',   JSON.stringify(toCity));

  const mkWaypoint = (city, fallbackName) => {
    if (!city) {
      // Fallback: місто не знайдено — відправляємо назву текстом
      return { address: fallbackName || '', countrySign: 'UA' };
    }
    const townId = parseInt(city.id ?? city.townId, 10);
    if (!townId || isNaN(townId)) {
      // ID не вийшов — fallback на текст
      console.warn('[Lardi API] mkWaypoint: invalid city.id:', city.id, '— using address fallback');
      return { address: city.name || fallbackName || '', countrySign: 'UA' };
    }
    // Передаємо тільки townId — areaId не потрібен і може конфліктувати
    return { townId };
  };

  const waypointSource = [mkWaypoint(fromCity, d.from)];
  const waypointTarget = [mkWaypoint(toCity, d.to)];

  const today     = new Date().toISOString().slice(0, 10);
  const dateFromStr = parseISODate(d.dateFrom) || today;
  const dateToStr   = parseISODate(d.dateTo)   || dateFromStr;

  // Lardi API очікує дати як рядки yyyy-MM-dd (НЕ Unix timestamp!)
  const payload = {
    dateFrom:           dateFromStr,
    dateTo:             dateToStr,
    contentName:        d.cargoName || d.cargo || 'ТНВ',  // Lardi вимагає непорожнє поле
    cargoBodyTypeIds:   getBodyTypeIds(refs, d.truckType),
    waypointListSource: waypointSource,
    waypointListTarget: waypointTarget,
    sizeMass:           parseFloat(d.weight) > 0 ? parseFloat(d.weight) : 1, // required
  };

  // Ціна — передаємо тільки якщо вказана (0 відхиляється Lardi API з 400)
  const priceVal = parseFloat(d.price);
  if (priceVal > 0) {
    payload.paymentValue      = priceVal;
    payload.paymentCurrencyId = getCurrencyId(refs, d.currency);
    // paymentUnitId required when price set — шукаємо "рейс/trip" або перший доступний
    const unitId = (refs?.paymentUnits?.find(u =>
      ['рейс','trip','journey'].some(k => (u.name||'').toLowerCase().includes(k))
    ) || refs?.paymentUnits?.[0])?.id || 2;
    payload.paymentUnitId = unitId;
  }

  if (d.volume) payload.sizeVolume = parseFloat(d.volume);
  const momentId = getPaymentMomentId(refs, d.paymentMoment);
  if (momentId)  payload.paymentMomentId = momentId;
  // paymentForms — Lardi очікує [{id, vat: false}], не просто [id]
  const formIds = getPaymentFormIds(refs, d.paymentType);
  if (formIds)   payload.paymentForms = formIds.map(id => ({ id, vat: false }));
  // Збираємо нотатку: loadPlaces + unloadPlaces + notes
  const noteParts = [];
  if (parseInt(d.loadPlaces) > 1)   noteParts.push(`${d.loadPlaces} точки завантаження`);
  if (parseInt(d.unloadPlaces) > 1) noteParts.push(`${d.unloadPlaces} точки розвантаження`);
  if (d.notes) noteParts.push(d.notes);
  if (noteParts.length) payload.note = noteParts.join('; ');

  console.log('[Lardi API] Posting:', JSON.stringify(payload));

  // language — query param, not body field
  const res = await fetch(`${LARDI_BASE}/proposals/my/add/cargo?language=uk`, {
    method: 'POST',
    headers: {
      'Authorization': LARDI_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const result = await res.json();
  console.log('[Lardi API] Response:', JSON.stringify(result));

  if (!res.ok) {
    throw new Error(`Lardi API ${res.status}: ${JSON.stringify(result).slice(0, 500)}`);
  }

  return result; // { id: <proposal_id> }
}

// ===== ПАРСЕР =====
async function parseCargo(text) {
  // Сьогоднішня дата для парсера — щоб він міг розрахувати "чт", "пн", "наступна п'ятниця" тощо
  const today = new Date();
  const todayStr = today.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' }); // DD.MM.YYYY

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
      system: `Ты парсер заявок на грузоперевозки. Сьогодні ${todayStr}. Из текста извлеки данные и верни ТОЛЬКО валидный JSON без markdown.
Поля: from, fromCountry, to, toCountry, cargoName, weight (тонни), volume (м³), dateFrom (DD.MM.YYYY), dateTo (DD.MM.YYYY), truckType (Тент/Рефрижератор/Відкритий/Контейнер/Борт/Цистерна/Самоскид/Зерновоз/Автовоз/Критий), loadType (Повна/Часткова), price (число), currency (EUR/USD/UAH), paymentType (Готівка/Безнал/Картка), paymentMoment (після розвантаження/після завантаження/передоплата/часткова передоплата — витягуй з тексту коли/як відбувається оплата), phone, loadPlaces (число точок завантаження якщо більше 1, наприклад "2 точки забору", "дві точки завантаження" → "2"; якщо не вказано — порожньо), unloadPlaces (число точок розвантаження якщо більше 1, наприклад "2 розвантаження" → "2"; якщо не вказано — порожньо), notes (ТІЛЬКИ якщо є реальна примітка про вантаж — НЕ про оплату і НЕ про кількість точок; інакше порожній рядок). Якщо поле не знайдено — порожній рядок. ВАЖЛИВО: якщо дата вказана як день тижня ("чт", "пт", "пн" тощо) — розрахуй конкретну дату DD.MM.YYYY відносно сьогодні (наступний такий день тижня). ТІЛЬКИ JSON.`,
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
  msg += line('⏱', 'Час оплати', p.paymentMoment);
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

// ===== TELEGRAM WEBHOOK =====
app.post(`/webhook/${TOKEN}`, async (req, res) => {
  res.sendStatus(200);
  const update = req.body;

  // Обробка кнопок
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

  // Команди
  if (text === '/start') {
    return sendMessage(chatId, `👋 *Ласкаво просимо до LogiDesk!*\n\nПишіть заявку в будь-якій формі:\n\n_Львів → Одеса, 0.7 т, в паллеті, тент, 8000 грн нал, +380999..._\n\n📋 Команди:\n/list — активні заявки\n/stats — статистика\n/dashboard — посилання на дашборд\n/оновити — оновити заявки на Lardi зараз`);
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
      const icon = row.status === 'active' ? '🟢' : '🔵';
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
    return sendMessage(chatId, `📊 *Статистика:*\n\n🔵 Нових: ${s.new_count}\n🟢 Активних: ${s.active_count}\n✅ Виконаних: ${s.completed_count}\n📋 Всього: ${s.total}`);
  }

  if (text === '/dashboard') {
    return sendMessage(chatId, `📊 *Дашборд LogiDesk:*\n\nhttps://logidesk-bot-production.up.railway.app/dashboard`);
  }

  if (text === '/оновити') {
    await sendMessage(chatId, '🔄 Оновлюю заявки на Lardi...');
    try {
      const result = await refreshLardiOrders(true); // force=true — ігноруємо часові обмеження
      if (result.skipped) {
        return sendMessage(chatId, `⏸ Оновлення пропущено: ${result.reason}`);
      }
      if (result.refreshed === 0 && result.attempted === 0) {
        return sendMessage(chatId, '📋 Немає активних заявок на Lardi для оновлення.');
      }
      const errText = result.errors?.length
        ? `\n⚠️ Помилки: ${result.errors.length}`
        : '';
      return sendMessage(chatId, `✅ Оновлено ${result.success} з ${result.attempted} заявок на Lardi.${errText}`);
    } catch (e) {
      return sendMessage(chatId, `❌ Помилка оновлення: ${e.message.slice(0, 100)}`);
    }
  }

  // Парсинг нової заявки
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    const parsed = await parseCargo(text);
    const db = await getDb();
    const result = await db.query(
      'INSERT INTO orders (chat_id, raw_text, data) VALUES ($1, $2, $3) RETURNING id',
      [chatId, text, JSON.stringify(parsed)]
    );
    const orderId = result.rows[0].id;
    await db.end();

    // Post to Lardi API if token is configured
    let lardiMsg = '';
    if (LARDI_TOKEN) {
      try {
        const lardiResult = await postToLardiAPI({ id: orderId, data: parsed });
        if (lardiResult?.id) {
          const db2 = await getDb();
          await db2.query(
            'UPDATE orders SET posted_lardi = true, lardi_proposal_id = $1, last_refresh_lardi = NOW(), status = \'active\' WHERE id = $2',
            [lardiResult.id, orderId]
          );
          await db2.end();
          lardiMsg = `\n✅ *Lardi:* розміщено #${lardiResult.id}`;
        }
      } catch (le) {
        console.error('[Lardi API] Post error:', le.message);
        lardiMsg = `\n⚠️ *Lardi API:* ${le.message.slice(0, 250)}`;
      }
    }

    await sendMessage(chatId,
      formatReply(parsed) +
      `\n🆔 ID заявки: \`${orderId}\`` +
      lardiMsg +
      `\n\n_Відкрий Extension у Chrome — заявка вже там. Натисни "Розмістити" щоб опублікувати на сайтах._`
    );
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

// Всі заявки (для дашборда)
app.get('/api/orders', auth, async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query("SELECT * FROM orders ORDER BY created_at DESC LIMIT 100");
    await db.end();
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Тільки нові заявки (для Extension)
app.get('/api/orders/pending', auth, async (req, res) => {
  try {
    const db = await getDb();
    // Pending = нові заявки АБО заявки де Lardi вже є (через API) але Della ще не виставлена
    const result = await db.query(`
      SELECT * FROM orders
      WHERE status = 'new'
         OR (status = 'active' AND posted_lardi = true AND posted_della = false)
      ORDER BY created_at ASC
    `);
    await db.end();
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Активні заявки (для нагадувань про оновлення)
app.get('/api/orders/active', auth, async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query("SELECT * FROM orders WHERE status = 'active' ORDER BY created_at DESC");
    await db.end();
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Оновити статус заявки
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

// Відмітити що заявку оновили на сайті
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

// ===== ДАШБОРД =====
app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LogiDesk Дашборд</title>
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
  <div class="stat new"><div class="stat-num" id="s-new"> </div><div class="stat-label">Нових</div></div>
  <div class="stat active"><div class="stat-num" id="s-active"> </div><div class="stat-label">Активних</div></div>
  <div class="stat done"><div class="stat-num" id="s-done"> </div><div class="stat-label">Виконаних</div></div>
  <div class="stat total"><div class="stat-num" id="s-total"> </div><div class="stat-label">Всього</div></div>
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
  if (m < 1) return 'щойно';
  if (m < 60) return m + ' хв тому';
  return Math.floor(m / 60) + ' год тому';
}

const STATUS_LABEL = { new: 'Нова', active: 'Активна', completed: 'Виконана', cancelled: 'Скасована' };

async function load() {
  try {
    const [oRes, sRes] = await Promise.all([
      fetch('/api/orders', { headers: { 'x-api-key': API_KEY } }),
      fetch('/api/stats',  { headers: { 'x-api-key': API_KEY } })
    ]);
    const orders = await oRes.json();
    const stats  = await sRes.json();

    document.getElementById('s-new').textContent    = stats.new_count    || 0;
    document.getElementById('s-active').textContent = stats.active_count || 0;
    document.getElementById('s-done').textContent   = stats.completed_count || 0;
    document.getElementById('s-total').textContent  = stats.total        || 0;
    document.getElementById('last-upd').textContent = new Date().toLocaleTimeString('uk-UA');

    const visible = orders.filter(o => o.status !== 'cancelled');
    const list = document.getElementById('orders-list');

    if (!visible.length) { list.innerHTML = '<div class="empty">Немає заявок</div>'; return; }

    list.innerHTML = visible.map(o => {
      const d = o.data || {};
      return \`<div class="card">
        <div class="card-id">#\${o.id}</div>
        <div class="card-body">
          <div class="route">\${d.from || '?'} → \${d.to || '?'}</div>
          <div class="tags">
            \${d.weight     ? \`<span class="tag">⚖️ \${d.weight}т</span>\`       : ''}
            \${d.volume     ? \`<span class="tag">📐 \${d.volume}м³</span>\`      : ''}
            \${d.truckType  ? \`<span class="tag">🚛 \${d.truckType}</span>\`     : ''}
            \${d.price      ? \`<span class="tag">💰 \${d.price} \${d.currency||''}</span>\` : ''}
            \${d.paymentType ? \`<span class="tag">\${d.paymentType}</span>\`     : ''}
            <span class="tag">🕐 \${timeSince(o.created_at)}</span>
          </div>
        </div>
        <div class="card-right">
          <span class="badge \${o.status}">\${STATUS_LABEL[o.status] || o.status}</span>
          <div class="platforms">
            <span class="pb \${o.posted_lardi ? 'on' : 'off'}" title="\${o.lardi_proposal_id ? 'Lardi #'+o.lardi_proposal_id : 'Не розміщено'}">L\${o.lardi_proposal_id ? ' #'+o.lardi_proposal_id : ''}</span>
            <span class="pb \${o.posted_della ? 'della-on' : 'off'}">D</span>
          </div>
          \${o.status !== 'completed' && o.status !== 'cancelled' ? \`
          <div class="actions">
            <button class="btn ok" onclick="setStatus(\${o.id},'completed')">✓</button>
            <button class="btn del" onclick="setStatus(\${o.id},'cancelled')">✕</button>
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

// ===== LARDI API STATUS =====
app.get('/api/lardi-status', auth, async (req, res) => {
  if (!LARDI_TOKEN) return res.json({ enabled: false, message: 'LARDI_API_TOKEN not set' });
  try {
    const refs = await loadLardiRefs();
    if (!refs) return res.json({ enabled: true, status: 'error', message: 'Failed to load reference data' });
    res.json({
      enabled: true,
      status: 'ok',
      refs: {
        bodyTypes:      refs.bodyTypes.length,
        currencies:     refs.currencies.map(c => `${c.id}=${c.name||c.sign||JSON.stringify(c)}`),
        paymentMoments: refs.paymentMoments.map(m => `${m.id}=${m.name||JSON.stringify(m)}`),
        paymentUnits:   refs.paymentUnits.map(u => `${u.id}=${u.name||JSON.stringify(u)}`),
        paymentTypes:   refs.paymentTypes.map(t => `${t.id}=${t.name||JSON.stringify(t)}`),
        bodyTypesSample: refs.bodyTypes.slice(0, 20).map(b => `${b.id}=${b.name||JSON.stringify(b)}`),
      },
      rawSample: {
        currency0: refs._raw?.rawCur ? JSON.stringify(refs._raw.rawCur).slice(0, 300) : null,
        moment0:   refs._raw?.rawMoments ? JSON.stringify(refs._raw.rawMoments).slice(0, 200) : null,
        unit0:     refs._raw?.rawUnits ? JSON.stringify(refs._raw.rawUnits).slice(0, 200) : null,
      }
    });
  } catch (e) {
    res.status(500).json({ enabled: true, status: 'error', message: e.message });
  }
});

// Debug: показати payload без відправки (GET)
app.get('/api/orders/:id/lardi-debug', auth, async (req, res) => {
  try {
    const db = await getDb();
    const row = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    await db.end();
    if (!row.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = row.rows[0];
    const refs = await loadLardiRefs();
    const d = order.data;
    const [fromCity, toCity] = await Promise.all([lookupLardiCity(d.from), lookupLardiCity(d.to)]);
    const today = new Date().toISOString().slice(0, 10);
    const dateFromStr = parseISODate(d.dateFrom) || today;
    const dateToStr   = parseISODate(d.dateTo)   || dateFromStr;
    const toMs = iso => new Date(iso + 'T00:00:00Z').getTime();
    const mkWp = (city) => {
      if (!city) return { address: '', countrySign: 'UA' };
      const townId = parseInt(city.id ?? city.townId, 10);
      if (!townId || isNaN(townId)) return { address: city.name || '', countrySign: 'UA' };
      return { townId }; // тільки townId, без areaId
    };
    const payload = {
      dateFrom: toMs(dateFromStr), dateTo: toMs(dateToStr),
      contentName: d.cargoName || d.cargo || '',
      cargoBodyTypeIds: getBodyTypeIds(refs, d.truckType),
      waypointListSource: [mkWp(fromCity)],
      waypointListTarget: [mkWp(toCity)],
    };
    if (parseFloat(d.weight) > 0) payload.sizeMass = parseFloat(d.weight);
    if (parseFloat(d.price)  > 0) { payload.paymentValue = parseFloat(d.price); payload.paymentCurrencyId = getCurrencyId(refs, d.currency); }
    if (d.volume) payload.sizeVolume = parseFloat(d.volume);
    const momentId = getPaymentMomentId(refs, d.paymentMoment);
    if (momentId) payload.paymentMomentId = momentId;
    const formIds = getPaymentFormIds(refs, d.paymentType);
    if (formIds) payload.paymentForms = formIds;
    if (d.notes) payload.note = d.notes;
    res.json({ fromCity, toCity, payload, orderData: d,
      refs: {
        paymentMoments: refs?.paymentMoments?.map(m => `${m.id}=${m.name}`),
        paymentTypes:   refs?.paymentTypes?.map(t => `${t.id}=${t.name}`),
        currencies:     refs?.currencies?.map(c => `${c.id}=${c.name||c.sign}`),
        bodyTypesSample: refs?.bodyTypes?.slice(0, 10).map(b => `${b.id}=${b.name}`),
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ручне розміщення заявки на Lardi
app.post('/api/orders/:id/post-lardi', auth, async (req, res) => {
  try {
    const db = await getDb();
    const row = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    await db.end();
    if (!row.rows.length) return res.status(404).json({ error: 'Order not found' });

    const order = row.rows[0];
    const debug = req.query.debug === '1';

    // Debug: show cities and payload without posting
    if (debug) {
      const refs = await loadLardiRefs();
      const d = order.data;
      const [fromCity, toCity] = await Promise.all([
        lookupLardiCity(d.from), lookupLardiCity(d.to)
      ]);
      // Build the same payload postToLardiAPI would build
      const today = new Date().toISOString().slice(0, 10);
      const dateFromStr = parseISODate(d.dateFrom) || today;
      const dateToStr   = parseISODate(d.dateTo)   || dateFromStr;
      const toMs = iso => new Date(iso + 'T00:00:00Z').getTime();
      const mkWp = (city, fb) => {
        if (!city) return { countrySign: 'UA' };
        const wp = { townId: parseInt(city.id, 10) };
        if (city.areaId)   wp.areaId   = parseInt(city.areaId,   10);
        if (city.regionId) wp.regionId = parseInt(city.regionId, 10);
        return wp;
      };
      const debugPayload = {
        dateFrom: toMs(dateFromStr), dateTo: toMs(dateToStr),
        contentName: d.cargoName || d.cargo || '',
        cargoBodyTypeIds: getBodyTypeIds(refs, d.truckType),
        waypointListSource: [mkWp(fromCity, d.from)],
        waypointListTarget: [mkWp(toCity,   d.to)],
      };
      if (parseFloat(d.weight) > 0) debugPayload.sizeMass = parseFloat(d.weight);
      if (parseFloat(d.price)  > 0) { debugPayload.paymentValue = parseFloat(d.price); debugPayload.paymentCurrencyId = getCurrencyId(refs, d.currency); }
      if (d.volume) debugPayload.sizeVolume = parseFloat(d.volume);
      return res.json({ fromCity, toCity, orderData: d, payload: debugPayload, refs: { bodyTypes: refs?.bodyTypes?.slice(0,5) } });
    }

    const result = await postToLardiAPI({ id: order.id, data: order.data });

    if (result?.id) {
      const db2 = await getDb();
      await db2.query(
        "UPDATE orders SET posted_lardi = true, lardi_proposal_id = $1, last_refresh_lardi = NOW(), status = 'active' WHERE id = $2",
        [result.id, order.id]
      );
      await db2.end();
    }

    res.json({ ok: true, lardi_proposal_id: result?.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== СИНХРОНІЗАЦІЯ ЗАЯВОК З LARDI API =====
async function syncLardiProposals() {
  if (!LARDI_TOKEN) return { skipped: true, reason: 'no token' };

  console.log('[Lardi Sync] Fetching active proposals from Lardi API...');

  // Збираємо заявки з двох статусів: published + confirmed
  const fetchStatus = async (status) => {
    const r = await fetch(`${LARDI_BASE}/proposals/my/cargoes/${status}?language=uk&size=100`, {
      headers: { 'Authorization': LARDI_TOKEN }
    });
    if (!r.ok) { console.warn(`[Lardi Sync] Status ${status} → HTTP ${r.status}`); return []; }
    const raw = await r.json();
    return extractArr(raw.content ?? raw);
  };

  const [published, confirmed] = await Promise.all([
    fetchStatus('published'),
    fetchStatus('confirmed'),
  ]);
  const proposals = [...published, ...confirmed];
  console.log(`[Lardi Sync] Got ${proposals.length} proposals (published:${published.length} confirmed:${confirmed.length})`);
  if (proposals.length) console.log('[Lardi Sync] First proposal keys:', JSON.stringify(Object.keys(proposals[0])));
  if (proposals.length) console.log('[Lardi Sync] Sample:', JSON.stringify(proposals[0]).slice(0, 400));

  if (!proposals.length) return { synced: 0, total: 0 };

  const db = await getDb();

  // Отримуємо всі вже відомі lardi_proposal_id
  const existing = await db.query('SELECT lardi_proposal_id FROM orders WHERE lardi_proposal_id IS NOT NULL');
  const knownIds = new Set(existing.rows.map(r => String(r.lardi_proposal_id)));

  let synced = 0;
  for (const p of proposals) {
    // Lardi може повертати id як 'id', 'cargoId', 'proposalId' тощо
    const propId = String(p.id ?? p.cargoId ?? p.proposalId ?? p.offerId ?? '');
    if (!propId || propId === 'undefined') {
      console.warn('[Lardi Sync] Proposal has no id, keys:', Object.keys(p));
      continue;
    }

    // Синхронізуємо тільки заявки Валентина (Герус В.В., ФЛ-П) — Лену пропускаємо
    const ownerFace = p.owner?.face || p.ownerFace || '';
    if (ownerFace === 'Лена') {
      console.log(`[Lardi Sync] Skipping proposal #${propId} (owner: Лена)`);
      continue;
    }

    if (knownIds.has(propId)) continue; // вже є в БД

    // Витягуємо дані з пропозиції для зручного відображення
    const from = p.waypointListSource?.[0]?.town?.name || p.waypointListSource?.[0]?.address || '';
    const to   = p.waypointListTarget?.[0]?.town?.name || p.waypointListTarget?.[0]?.address || '';
    const data = {
      from,
      to,
      cargoName:  p.contentName || '',
      weight:     p.sizeMass    || '',
      volume:     p.sizeVolume  || '',
      price:      p.paymentValue || '',
      truckType:  p.cargoBodyTypeIds ? 'Тент' : '',
      _source:    'lardi_sync',
    };

    await db.query(
      `INSERT INTO orders (chat_id, raw_text, data, status, posted_lardi, lardi_proposal_id, last_refresh_lardi)
       VALUES ($1, $2, $3, 'active', true, $4, NOW())`,
      [0, `Lardi sync: ${from} → ${to}`, JSON.stringify(data), propId]
    );

    synced++;
    console.log(`[Lardi Sync] Imported proposal #${propId}: ${from} → ${to}`);
  }

  await db.end();
  console.log(`[Lardi Sync] Done — imported ${synced} new, skipped ${proposals.length - synced} existing`);
  return { synced, skipped: proposals.length - synced, total: proposals.length };
}

// Тимчасовий debug — показує сирий відповідь Lardi
app.get('/api/lardi/raw-proposals', auth, async (req, res) => {
  try {
    const st = req.query.status || 'published';
    const url = `${LARDI_BASE}/proposals/my/cargoes/${st}?language=uk&size=5`;
    const r = await fetch(url, { headers: { 'Authorization': LARDI_TOKEN } });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) {}
    res.json({ url, httpStatus: r.status, rawText: text.slice(0, 1000), parsed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== DEBUG: що повертає пошук Lardi і чому не імпортується =====
app.get('/api/lardi/import-debug', async (req, res) => {
  if (req.headers['x-api-key'] !== API_KEY && req.query.key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!LARDI_TOKEN) return res.json({ error: 'LARDI_TOKEN not set' });
  try {
    const searchBody = {
      waypointListSource: [{ countrySign: 'UA' }],
      waypointListTarget: [{ countrySign: 'UA' }],
      paymentCurrencyId: 2,
      size: 10, page: 0,
    };
    const r = await fetch(`${LARDI_BASE}/proposals/search/cargo?language=uk`, {
      method: 'POST',
      headers: { 'Authorization': LARDI_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(searchBody),
    });
    const rawText = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(rawText); } catch (_) {}
    const proposals = extractArr(parsed?.content ?? parsed ?? []);

    // Для кожної пропозиції показуємо ключові поля
    const db = await getDb();
    const ownRes = await db.query('SELECT lardi_proposal_id FROM orders WHERE lardi_proposal_id IS NOT NULL');
    const importedRes = await db.query('SELECT source_lardi_id FROM orders WHERE source_lardi_id IS NOT NULL');
    await db.end();
    const ownIds      = new Set(ownRes.rows.map(r2 => String(r2.lardi_proposal_id)));
    const importedIds = new Set(importedRes.rows.map(r2 => String(r2.source_lardi_id)));

    const debug = proposals.slice(0, 5).map(p => {
      const propId = String(p.id ?? p.cargoId ?? p.proposalId ?? '');
      const price  = p.payment?.price ?? p.paymentValue ?? p.payment?.value ?? null;
      const currId = p.payment?.currencyId ?? p.paymentCurrencyId ?? null;
      return {
        id: propId,
        isOwn:     ownIds.has(propId),
        imported:  importedIds.has(propId),
        price,
        currencyId: currId,
        from: p.waypointListSource?.[0]?.town?.name || p.waypointListSource?.[0]?.address,
        to:   p.waypointListTarget?.[0]?.town?.name || p.waypointListTarget?.[0]?.address,
        allKeys: Object.keys(p),
        paymentObj: p.payment || null,
      };
    });

    res.json({
      httpStatus: r.status,
      totalFound: proposals.length,
      ownIdsCount: ownIds.size,
      importedIdsCount: importedIds.size,
      sample: debug,
      rawSnippet: rawText.slice(0, 500),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ендпоінт ручної синхронізації
app.post('/api/lardi/sync', auth, async (req, res) => {
  try {
    const result = await syncLardiProposals();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== АВТО-ОНОВЛЕННЯ LARDI (щогодини, 8:00–18:00 за Берліном) =====
function isBerlinWorkHours() {
  const hourStr = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: 'numeric',
    hour12: false
  }).format(new Date());
  const hour = parseInt(hourStr, 10); // '12 Uhr' → 12, not NaN
  return hour >= 8 && hour < 18;
}

async function refreshLardiOrders(force = false) {
  if (!LARDI_TOKEN) {
    console.log('[Lardi Refresh] Skipped — no LARDI_API_TOKEN');
    return { skipped: true, reason: 'no token' };
  }
  if (!force && !isBerlinWorkHours()) {
    const hour = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: 'numeric', hour12: false }).format(new Date());
    console.log(`[Lardi Refresh] Skipped — outside working hours (Berlin ${hour}:xx)`);
    return { skipped: true, reason: 'outside hours' };
  }

  const db = await getDb();
  const result = await db.query(
    "SELECT id, chat_id, lardi_proposal_id FROM orders WHERE status NOT IN ('cancelled','done','archived') AND posted_lardi = true AND lardi_proposal_id IS NOT NULL"
  );
  await db.end();

  if (!result.rows.length) {
    console.log('[Lardi Refresh] No active Lardi orders to refresh');
    return { refreshed: 0 };
  }

  const cargoIds = result.rows.map(r => Number(r.lardi_proposal_id));
  console.log(`[Lardi Refresh] Refreshing ${cargoIds.length} proposals:`, cargoIds);

  const res = await fetch(`${LARDI_BASE}/proposals/my/repeat`, {
    method: 'POST',
    headers: { 'Authorization': LARDI_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cargoIds }),
  });

  const text = await res.text();
  console.log('[Lardi Refresh] Raw response:', text.slice(0, 500));

  if (!res.ok) {
    throw new Error(`Lardi API ${res.status}: ${text.slice(0, 200)}`);
  }

  let data = null;
  try { data = JSON.parse(text); } catch (_) {}

  // Lardi повертає: { cargoes: { success: [...], errors: [...] } }
  const successIds = data?.cargoes?.success || data?.cargo?.success || data?.success || [];
  const errors     = data?.cargoes?.errors  || data?.cargo?.errors  || data?.errors  || [];

  if (successIds.length) {
    const db2 = await getDb();
    for (const propId of successIds) {
      await db2.query(
        'UPDATE orders SET last_refresh_lardi = NOW() WHERE lardi_proposal_id = $1',
        [propId]
      );
    }
    await db2.end();
    console.log(`[Lardi Refresh] Updated last_refresh_lardi for ${successIds.length} orders`);

    // Telegram notification to all unique chat_ids of refreshed orders
    const refreshedPropIds = new Set(successIds.map(Number));
    const chatIds = [...new Set(
      result.rows
        .filter(r => refreshedPropIds.has(Number(r.lardi_proposal_id)) && r.chat_id)
        .map(r => r.chat_id)
    )];
    const timeStr = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
    for (const cid of chatIds) {
      sendMessage(cid, `🔄 *Lardi:* оновлено ${successIds.length} заявок (${timeStr})`).catch(() => {});
    }
  }

  return {
    attempted: cargoIds.length,
    success:   successIds.length,
    errors:    errors.map(e => ({ id: e.id, message: e.message, code: e.errorCode })),
  };
}

// Запускаємо перевірку кожні 5 хвилин, але виконуємо не частіше ніж раз на 30 хвилин.
// Так при редеплої Railway не чекаємо повну годину — оновлення відбудеться протягом 5 хв після старту.
let _lastAutoRefresh = 0;
setInterval(async () => {
  if (!isBerlinWorkHours()) return;
  const now = Date.now();
  if (now - _lastAutoRefresh < 30 * 60 * 1000) return; // менше 30 хв від останнього запуску
  _lastAutoRefresh = now;
  try {
    const result = await refreshLardiOrders();
    console.log('[Lardi Refresh] Scheduled result:', result);
  } catch (e) {
    console.error('[Lardi Refresh] Scheduled error:', e.message);
  }
}, 5 * 60 * 1000); // перевіряємо кожні 5 хвилин

// Ручне оновлення через API (для тесту)
// ?force=1 — пропустити перевірку часу
app.post('/api/lardi/refresh', auth, async (req, res) => {
  try {
    const force = req.query.force === '1';
    const result = await refreshLardiOrders(force);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ІМПОРТ ЧУЖИХ ЗАЯВОК З LARDI → DELLA (через веб-скрейпінг розширенням) =====

// In-memory dedup: source_lardi_id заявок що вже були імпортовані
const _importedLardiIds = new Set();

async function loadImportedLardiIds() {
  try {
    const db = await getDb();
    const res = await db.query('SELECT source_lardi_id FROM orders WHERE source_lardi_id IS NOT NULL');
    await db.end();
    res.rows.forEach(r => _importedLardiIds.add(String(r.source_lardi_id)));
    console.log(`[Lardi Import] Loaded ${_importedLardiIds.size} already-imported IDs`);
  } catch (e) {
    console.error('[Lardi Import] loadImportedLardiIds error:', e.message);
  }
}

// ===== СЕРВЕРНИЙ ІМПОРТ ЧУЖИХ ЗАЯВОК З LARDI (API, без браузера) =====
async function importLardiOrders() {
  if (!LARDI_TOKEN) return;

  try {
    // Пошук вантажних пропозицій: Україна → Україна, гривня, готівка, мінімум 11000 грн
    const searchBody = {
      waypointListSource: [{ countrySign: 'UA' }],
      waypointListTarget: [{ countrySign: 'UA' }],
      paymentCurrencyId: 2,   // UAH
      paymentFormIds:    [2], // готівка (cash) — Lardi form ID 2
      size: 100,
      page: 0,
    };

    const res = await fetch(`${LARDI_BASE}/proposals/search/cargo?language=uk`, {
      method: 'POST',
      headers: { 'Authorization': LARDI_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(searchBody),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[Lardi Import] Search API error: HTTP ${res.status} ${errText.slice(0, 200)}`);
      return;
    }

    const raw = await res.json();
    const proposals = extractArr(raw.content ?? raw);
    if (!proposals.length) return;

    // Завантажуємо поточні власні lardi_proposal_id та вже імпортовані source_lardi_id прямо з БД
    // (не з кешу — щоб виключення завжди було актуальним)
    const db = await getDb();
    const [ownRes, importedRes] = await Promise.all([
      db.query('SELECT lardi_proposal_id FROM orders WHERE lardi_proposal_id IS NOT NULL'),
      db.query('SELECT source_lardi_id    FROM orders WHERE source_lardi_id    IS NOT NULL'),
    ]);
    const ownIds      = new Set(ownRes.rows.map(r => String(r.lardi_proposal_id)));
    const importedIds = new Set(importedRes.rows.map(r => String(r.source_lardi_id)));
    // Оновлюємо in-memory set (на випадок якщо він не встиг завантажитись при старті)
    importedRes.rows.forEach(r => _importedLardiIds.add(String(r.source_lardi_id)));

    let imported = 0;
    for (const p of proposals) {
      // ID пропозиції — пробуємо всі відомі поля
      const propId = String(p.id ?? p.cargoId ?? p.proposalId ?? p.offerId ?? '');
      if (!propId || propId === 'undefined' || propId === 'null') continue;

      // Пропускаємо власні заявки та вже імпортовані
      if (ownIds.has(propId))      continue;
      if (importedIds.has(propId)) continue;

      // Тільки гривня
      const currencyId = p.payment?.currencyId ?? p.paymentCurrencyId ?? 0;
      if (currencyId && currencyId !== 2) continue;

      // Тільки готівка (cash) — якщо є інфо про форму оплати
      const paymentForms = p.paymentForms || p.payment?.forms || [];
      if (paymentForms.length > 0) {
        const hasCash = paymentForms.some(f => {
          const fid  = typeof f === 'object' ? f?.id : f;
          const fname = (f?.name || '').toLowerCase();
          return fid === 2 || fname.includes('готів') || fname.includes('нал') || fname.includes('cash');
        });
        if (!hasCash) {
          console.log(`[Lardi Import] Skipping #${propId} — not cash payment`);
          continue;
        }
      }

      // Мінімальна ціна 11000 грн готівка
      const price = parseFloat(p.payment?.price ?? p.paymentValue ?? 0);
      if (!price || price < 11000) continue;

      const from = p.waypointListSource?.[0]?.town?.name || p.waypointListSource?.[0]?.address || '';
      const to   = p.waypointListTarget?.[0]?.town?.name || p.waypointListTarget?.[0]?.address || '';
      if (!from || !to) continue;

      // Виставляємо в Делла на 1000 грн менше ніж ціна в Ларді
      const dellaPrice = price - 1000;
      const data = {
        from,
        to,
        cargoName:   p.contentName || 'ТНВ',
        weight:      p.sizeMass    || '',
        volume:      p.sizeVolume  || '',
        price:       dellaPrice,
        currency:    'UAH',
        paymentType: 'Готівка',
        dateFrom:    p.dateFrom    || '',
        _source:     'lardi_import',
        _origPrice:  price,
        _lardiId:    propId,
      };

      try {
        const r = await db.query(
          `INSERT INTO orders (chat_id, raw_text, data, status, posted_lardi, posted_della, source_lardi_id, created_at)
           VALUES ($1, $2, $3, 'active', true, false, $4, NOW())
           ON CONFLICT (source_lardi_id) WHERE source_lardi_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [0, `Lardi import: ${from} → ${to} (${price} UAH)`, JSON.stringify(data), propId]
        );
        if (r.rowCount > 0) {
          _importedLardiIds.add(propId);
          importedIds.add(propId);
          imported++;
          console.log(`[Lardi Import] #${propId}: ${from} → ${to}, ${price}→${dellaPrice} UAH`);
        }
      } catch (e) {
        if (e.code !== '23505') console.error('[Lardi Import] Insert error:', e.message);
      }
    }

    await db.end();
    if (imported > 0) console.log(`[Lardi Import] Done — imported ${imported} new out of ${proposals.length}`);

  } catch (e) {
    console.error('[Lardi Import] Error:', e.message);
  }
}

// Запускаємо кожну хвилину
setInterval(() => {
  importLardiOrders().catch(e => console.error('[Lardi Import] Interval error:', e.message));
}, 60 * 1000);

// Ендпоінт для прийому пропозицій які скрейпнуло розширення зі сторінки пошуку Lardi
app.post('/api/import/proposals', auth, async (req, res) => {
  const { proposals } = req.body;
  if (!Array.isArray(proposals) || !proposals.length) {
    return res.json({ ok: true, imported: 0, total: 0 });
  }

  let imported = 0;
  for (const p of proposals) {
    const price = parseFloat(p.price);
    if (!price || price < 11000) continue;  // мінімум 11000 грн готівка
    if (!p.from) continue;

    // Тільки готівка
    const pt = (p.paymentType || '').toLowerCase();
    if (pt && !pt.includes('готів') && !pt.includes('нал') && !pt.includes('cash')) continue;

    const sourceId = p.id ? String(p.id) : null;

    // Dedup через in-memory set
    if (sourceId && _importedLardiIds.has(sourceId)) continue;

    const dellaPrice = price - 1000;
    const data = {
      from:        p.from   || '',
      to:          p.to     || '',
      cargoName:   p.cargoName || 'ТНВ',
      weight:      p.weight || '',
      volume:      p.volume || '',
      truckType:   p.truckType || '',
      price:       dellaPrice,
      currency:    'UAH',
      paymentType: 'Готівка',
      dateFrom:    p.dateFrom || '',
      _source:     'lardi_scrape',
      _origPrice:  price,
      _lardiId:    sourceId || '',
    };

    try {
      const db = await getDb();
      if (sourceId) {
        const r = await db.query(
          `INSERT INTO orders (chat_id, raw_text, data, status, posted_lardi, posted_della, source_lardi_id, created_at)
           VALUES ($1, $2, $3, 'active', true, false, $4, NOW())
           ON CONFLICT (source_lardi_id) WHERE source_lardi_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [0, `Lardi scrape: ${p.from} → ${p.to} (${price} UAH)`, JSON.stringify(data), sourceId]
        );
        await db.end();
        if (r.rowCount > 0) {
          _importedLardiIds.add(sourceId);
          imported++;
          console.log(`[Lardi Import] #${sourceId}: ${p.from} → ${p.to}, ${price}→${dellaPrice} UAH`);
        }
      } else {
        // Без ID — вставляємо тільки якщо немає схожого за маршрутом за останню годину
        const dup = await db.query(
          `SELECT 1 FROM orders WHERE data->>'from' = $1 AND data->>'to' = $2
           AND data->>'_source' = 'lardi_scrape' AND created_at > NOW() - INTERVAL '1 hour' LIMIT 1`,
          [p.from, p.to]
        );
        if (!dup.rows.length) {
          await db.query(
            `INSERT INTO orders (chat_id, raw_text, data, status, posted_lardi, posted_della, created_at)
             VALUES ($1, $2, $3, 'active', true, false, NOW())`,
            [0, `Lardi scrape: ${p.from} → ${p.to} (${price} UAH)`, JSON.stringify(data)]
          );
          imported++;
        }
        await db.end();
      }
    } catch (e) {
      if (e.code !== '23505') console.error('[Lardi Import] Insert error:', e.message);
    }
  }

  console.log(`[Lardi Import] Received ${proposals.length} proposals, imported ${imported} new`);
  res.json({ ok: true, imported, total: proposals.length });
});

// ===== SETUP WEBHOOK =====
app.get('/setup', async (req, res) => {
  const webhookUrl = `https://logidesk-bot-production.up.railway.app/webhook/${TOKEN}`;
  const result = await tg('setWebhook', { url: webhookUrl });
  res.json({ webhookUrl, result });
});

app.get('/', (req, res) => res.send('LogiDesk ✅ | <a href="/dashboard">📊 Дашборд</a>'));

// ===== СТАРТ =====
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`LogiDesk started on port ${PORT}`);

    // Синхронізуємо заявки з Lardi при старті (імпортуємо невідомі пропозиції)
    syncLardiProposals()
      .then(r => console.log('[Lardi Sync] Startup sync:', r))
      .catch(e => console.error('[Lardi Sync] Startup sync error:', e.message));

    // Завантажуємо вже імпортовані ID (для дедуплікації при прийомі від розширення)
    loadImportedLardiIds()
      .then(() => console.log('[Lardi Import] Dedup IDs loaded'))
      .catch(e => console.error('[Lardi Import] loadImportedLardiIds error:', e.message));

    // Перший імпорт чужих заявок — через 10 сек після старту
    setTimeout(() => {
      importLardiOrders().catch(e => console.error('[Lardi Import] Startup error:', e.message));
    }, 10000);

    // При старті сервера в робочий час — одразу запускаємо оновлення.
    // Так редеплой не зміщує розклад оновлень.
    if (isBerlinWorkHours()) {
      _lastAutoRefresh = Date.now();
      refreshLardiOrders()
        .then(r => console.log('[Lardi Refresh] Startup refresh:', r))
        .catch(e => console.error('[Lardi Refresh] Startup refresh error:', e.message));
    }
  });
});
