// LogiDesk — Lardi search page scraper
// Runs on https://lardi-trans.com/log/search/gruz/*

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'scrape_lardi_search') {
    scrapeLardiSearch()
      .then(proposals => {
        console.log(`[LogiDesk Search] Sending ${proposals.length} proposals`);
        sendResponse({ ok: true, proposals });
      })
      .catch(e => {
        console.error('[LogiDesk Search] Error:', e.message);
        sendResponse({ ok: false, error: e.message, proposals: [] });
      });
    return true; // async
  }
});

async function scrapeLardiSearch() {
  await waitForContent();

  const proposals = [];
  const seen = new Set();

  function addUnique(p) {
    if (!p) return;
    const key = (p.id || '') + '|' + p.from + '|' + p.to + '|' + p.price;
    if (!seen.has(key)) { seen.add(key); proposals.push(p); }
  }

  // ===== Attempt 1: table rows (classic Lardi) =====
  const tableRows = document.querySelectorAll(
    'tr[data-id], tr[data-cargo], tr.trHover, tr[class*="cargo"], tr[class*="Cargo"]'
  );
  if (tableRows.length) {
    console.log(`[LogiDesk Search] Attempt1: ${tableRows.length} table rows`);
    for (const row of tableRows) {
      addUnique(parseProposal(row.innerText || '', row));
    }
  }

  // ===== Attempt 2: card/item elements (React UI) =====
  if (proposals.length < 3) {
    const cardSel = [
      '[class*="SearchResult"]', '[class*="search-result"]',
      '[class*="CargoItem"]',    '[class*="cargo-item"]',
      '[class*="cargo__item"]',  '[class*="cargo-card"]',
      '[class*="CargoCard"]',    '[class*="OfferItem"]',
      '[class*="offer-item"]',   '[class*="RequestItem"]',
      '[class*="request-item"]', '[class*="ListItem"]',
      '[class*="list-item"]',    '[class*="item-row"]',
      '[class*="order-item"]',   '[class*="OrderItem"]',
      '[class*="result-item"]',  '[class*="b-search-result"]',
      '.b-search-result__item',  '.b-cargo-item'
    ].join(', ');

    const cards = document.querySelectorAll(cardSel);
    console.log(`[LogiDesk Search] Attempt2: ${cards.length} card elements`);
    for (const card of cards) {
      const text = card.innerText || '';
      if (text.length > 2000) continue;
      addUnique(parseProposal(text, card));
    }
  }

  // ===== Attempt 3: any smallish div/li/article that contains route+price =====
  if (proposals.length < 3) {
    console.log('[LogiDesk Search] Attempt3: scanning div/li/article elements');
    const candidates = document.querySelectorAll('div, li, article');
    for (const el of candidates) {
      if (el.children.length > 8) continue; // skip large containers
      const text = el.innerText || '';
      if (text.length < 15 || text.length > 600) continue;
      addUnique(parseProposal(text, el));
    }
  }

  // ===== Attempt 4: full page text scan (last resort) =====
  if (proposals.length < 3) {
    console.log('[LogiDesk Search] Attempt4: full page text scan');
    const lines = (document.body.innerText || '').split('\n')
      .map(l => l.trim()).filter(l => l.length > 2);

    for (let i = 0; i < lines.length; i++) {
      // Try blocks of 3–8 consecutive lines
      for (let len = 3; len <= 8; len++) {
        const block = lines.slice(i, i + len).join('\n');
        const p = parseProposal(block, null);
        if (p) { addUnique(p); break; }
      }
    }
  }

  console.log(`[LogiDesk Search] Total extracted: ${proposals.length}`);
  return proposals;
}

// ===== Parse a text block into a proposal =====
function parseProposal(text, el) {
  if (!text || text.length < 8) return null;

  // Route: City → City  (тільки стрілки і тире-довгі; НЕ дефіс щоб не хапати назви компаній типу "Годен-Авто")
  const routeMatch = text.match(
    /([А-ЯЁІЇЄA-ZÀ-Ü][а-яёіїє\w\s\.]{1,30}?)\s*[→–—]\s*([А-ЯЁІЇЄA-ZÀ-Ü][а-яёіїє\w\s\.]{1,30})/u
  );
  if (!routeMatch) return null;

  const from = routeMatch[1].trim();
  const to   = routeMatch[2].trim();
  if (!isCity(from) || !isCity(to) || from === to) return null;

  // Price in UAH — грн / UAH / ₴
  // Match patterns like: "15 000 грн", "15000 грн", "15000UAH", "₴15000"
  const priceMatch = text.match(/(?:₴\s*)?(\d[\d\s]{2,8})\s*(грн|UAH|₴)/i)
                  || text.match(/₴\s*(\d[\d\s]{2,8})/);
  if (!priceMatch) return null;

  const price = parseFloat(priceMatch[1].replace(/\s+/g, ''));
  if (!price || price < 11000) return null;  // мінімум 11000 грн

  // Тип оплати — тільки готівка
  const paymentType = extractPaymentType(text);
  // Якщо явно вказано безготівка — пропускаємо
  if (paymentType === 'Безготівка') return null;

  const id = el?.dataset?.id
          || el?.dataset?.cargo
          || el?.getAttribute?.('data-id')
          || el?.getAttribute?.('data-cargo-id')
          || null;

  return {
    id,
    from,
    to,
    price,
    paymentType: paymentType || 'Готівка',
    weight:    (text.match(/(\d+(?:[.,]\d+)?)\s*т\b/i) || [])[1]?.replace(',', '.') || '',
    volume:    (text.match(/(\d+(?:[.,]\d+)?)\s*м[³3]/i) || [])[1]?.replace(',', '.') || '',
    truckType: extractTruckType(text),
    dateFrom:  extractDate(text),
    cargoName: extractCargo(text),
  };
}

// ===== Wait for page content =====
async function waitForContent() {
  const selectors = [
    'tr[data-id]', 'tr.trHover', '.b-search-result__item',
    '[class*="SearchResult"]', '[class*="CargoItem"]',
    '[class*="cargo-item"]', '[class*="cargo__item"]',
    '[class*="ListItem"]', '[class*="RequestItem"]',
    '[class*="result-item"]', '[class*="b-search-result"]',
  ];

  for (let i = 0; i < 60; i++) {   // wait up to 30 seconds
    for (const sel of selectors) {
      if (document.querySelector(sel)) {
        console.log('[LogiDesk Search] Content found:', sel);
        return;
      }
    }
    // Generic check: at least one table row or result div
    if (document.querySelector('tr td')
        || document.querySelector('[class*="result"]')
        || document.querySelector('[class*="cargo"]')
        || document.querySelector('[class*="search"]')) {
      console.log('[LogiDesk Search] Generic content detected');
      return;
    }
    await sleep(500);
  }
  console.warn('[LogiDesk Search] Timeout — scraping whatever is on the page');
}

// ===== Helpers =====

function isCity(str) {
  if (!str || str.length < 2 || str.length > 50) return false;
  // Starts with uppercase Cyrillic, Latin or accented character
  return /^[А-ЯЁІЇЄA-ZÀ-Ü][а-яёіїєa-zA-Zà-ü\w\s\-\.]{1,49}$/u.test(str.trim());
}

function extractTruckType(text) {
  const t = text.toLowerCase();
  if (t.includes('реф') || t.includes('холод'))         return 'Рефрижератор';
  if (t.includes('ізотерм') || t.includes('изотерм'))   return 'Ізотерм';
  if (t.includes('борт') || t.includes('відкр'))        return 'Борт';
  if (t.includes('платформ'))                           return 'Платформа';
  if (t.includes('контейнер'))                          return 'Контейнер';
  if (t.includes('зерновоз'))                           return 'Зерновоз';
  if (t.includes('автовоз'))                            return 'Автовоз';
  if (t.includes('самоскид') || t.includes('самосвал')) return 'Самоскид';
  if (t.includes('цистерн'))                            return 'Цистерна';
  if (t.includes('тент') || t.includes('шторн'))       return 'Тент';
  return '';
}

function extractDate(text) {
  const m = text.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return '';
  return `${m[1]}.${m[2]}.${m[3]}`;
}

function extractCargo(text) {
  const m = text.match(/вантаж[:\s]+([^\n,;]{2,30})/i)
           || text.match(/груз[:\s]+([^\n,;]{2,30})/i);
  return m?.[1]?.trim() || 'ТНВ';
}

function extractPaymentType(text) {
  const t = text.toLowerCase();
  if (t.includes('безгот') || t.includes('безнал')) return 'Безготівка';
  if (t.includes('готів') || t.includes('нал'))     return 'Готівка';
  return '';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
