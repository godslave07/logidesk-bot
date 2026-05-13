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

  // ===== Attempt 1: table rows (classic + new Lardi) =====
  // First try specific selectors, then fall back to ALL tr rows with enough cells
  let tableRows = Array.from(document.querySelectorAll(
    'tr[data-id], tr[data-cargo], tr.trHover, tr[class*="cargo"], tr[class*="Cargo"]'
  ));

  // If no specific rows found — try ALL tr that look like data rows (5+ cells, has price)
  if (!tableRows.length) {
    tableRows = Array.from(document.querySelectorAll('tr')).filter(tr => {
      const cells = tr.querySelectorAll('td');
      if (cells.length < 5) return false;
      const text = tr.innerText || '';
      return /\d[\d\s]{2,8}\s*(грн|UAH)/i.test(text) || /₴\s*\d/.test(text);
    });
  }

  console.log(`[LogiDesk Search] Attempt1: ${tableRows.length} table rows`);
  for (const row of tableRows) {
    addUnique(parseTableRow(row));
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
      addUnique(parseProposalFromText(text, card));
    }
  }

  // ===== Attempt 3: any div/li/article with route+price =====
  if (proposals.length < 3) {
    console.log('[LogiDesk Search] Attempt3: scanning div/li/article elements');
    const candidates = document.querySelectorAll('div, li, article');
    for (const el of candidates) {
      if (el.children.length > 8) continue;
      const text = el.innerText || '';
      if (text.length < 15 || text.length > 600) continue;
      addUnique(parseProposalFromText(text, el));
    }
  }

  console.log(`[LogiDesk Search] Total extracted: ${proposals.length}`, proposals.map(p => `${p.from}→${p.to} ${p.price}грн`));
  return proposals;
}

// ===== Parse a TABLE ROW by column position (robust, no regex for cities) =====
function parseTableRow(row) {
  const cells = Array.from(row.querySelectorAll('td'));
  if (cells.length < 5) return null;

  const rowText = row.innerText || '';

  // Skip безготівка immediately
  const lower = rowText.toLowerCase();
  if (lower.includes('безгот') || lower.includes('безнал')) return null;

  // Find city cells: look for cells that contain location pins (svg/img) or "обл."
  // Lardi table column order: Country | Date | Transport | From | To | Cargo | Price | Contact
  // Try by cells with map pin icons first
  const cityСells = cells.filter(td => {
    const html = td.innerHTML;
    return html.includes('svg') || html.includes('pin') || html.includes('marker') ||
           td.querySelector('svg') || td.querySelector('[class*="pin"]') ||
           td.querySelector('[class*="city"]') || td.querySelector('[class*="location"]');
  });

  let fromText = '', toText = '';

  if (cityСells.length >= 2) {
    fromText = cleanCity(cityСells[0].innerText);
    toText   = cleanCity(cityСells[1].innerText);
  } else {
    // Fallback: assume columns 3 and 4 (standard Lardi table)
    // Try multiple offsets since some tables have an extra status column
    for (const offset of [3, 2, 4]) {
      const f = cleanCity(cells[offset]?.innerText || '');
      const t = cleanCity(cells[offset + 1]?.innerText || '');
      if (isCity(f) && isCity(t) && f !== t) {
        fromText = f;
        toText = t;
        break;
      }
    }
  }

  if (!fromText || !toText || !isCity(fromText) || !isCity(toText)) return null;

  // Price: find cell with грн/UAH/₴
  let price = 0;
  for (const td of cells) {
    const t = td.innerText;
    const m = t.match(/(\d[\d\s]{2,8})\s*(грн|UAH)/i) || t.match(/₴\s*(\d[\d\s]{2,8})/);
    if (m) {
      price = parseFloat(m[1].replace(/\s+/g, ''));
      if (price >= 11000) break;
      price = 0; // keep looking for higher price
    }
  }
  if (!price || price < 11000) return null;

  const id = row.dataset?.id || row.dataset?.cargo ||
             row.getAttribute('data-id') || row.getAttribute('data-cargo-id') || null;

  return {
    id,
    from: fromText,
    to:   toText,
    price,
    paymentType: lower.includes('готів') || lower.includes('нал') ? 'Готівка' : 'Готівка',
    weight:    (rowText.match(/(\d+(?:[.,]\d+)?)\s*т\b/i) || [])[1]?.replace(',', '.') || '',
    volume:    (rowText.match(/(\d+(?:[.,]\d+)?)\s*м[³3]/i) || [])[1]?.replace(',', '.') || '',
    truckType: extractTruckType(rowText),
    dateFrom:  extractDate(rowText),
    cargoName: extractCargo(rowText),
  };
}

// ===== Parse from text block (for cards/divs) — uses arrow separators only =====
function parseProposalFromText(text, el) {
  if (!text || text.length < 8) return null;

  // Route: City → City  (тільки стрілки і тире-довгі; НЕ дефіс щоб не хапати назви компаній типу "Годен-Авто")
  const routeMatch = text.match(
    /([А-ЯЁІЇЄA-ZÀ-Ü][а-яёіїє\w\s\.]{1,30}?)\s*[→–—]\s*([А-ЯЁІЇЄA-ZÀ-Ü][а-яёіїє\w\s\.]{1,30})/u
  );
  if (!routeMatch) return null;

  const from = routeMatch[1].trim();
  const to   = routeMatch[2].trim();
  if (!isCity(from) || !isCity(to) || from === to) return null;

  const lower = text.toLowerCase();
  if (lower.includes('безгот') || lower.includes('безнал')) return null;

  const priceMatch = text.match(/(?:₴\s*)?(\d[\d\s]{2,8})\s*(грн|UAH|₴)/i)
                  || text.match(/₴\s*(\d[\d\s]{2,8})/);
  if (!priceMatch) return null;

  const price = parseFloat(priceMatch[1].replace(/\s+/g, ''));
  if (!price || price < 11000) return null;

  const id = el?.dataset?.id || el?.dataset?.cargo ||
             el?.getAttribute?.('data-id') || el?.getAttribute?.('data-cargo-id') || null;

  return {
    id,
    from,
    to,
    price,
    paymentType: lower.includes('готів') || lower.includes('нал') ? 'Готівка' : 'Готівка',
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

// Strip region info from city name: "Житомир (Житомирська обл.)" → "Житомир"
function cleanCity(str) {
  if (!str) return '';
  return str.replace(/\(.*?\)/g, '').replace(/,.*$/, '').trim();
}

function isCity(str) {
  if (!str || str.length < 2 || str.length > 50) return false;
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
  if (m) return `${m[1]}.${m[2]}.${m[3]}`;
  // DD.MM format (without year)
  const m2 = text.match(/(\d{2})\.(\d{2})/);
  if (m2) {
    const year = new Date().getFullYear();
    return `${m2[1]}.${m2[2]}.${year}`;
  }
  return '';
}

function extractCargo(text) {
  const m = text.match(/вантаж[:\s]+([^\n,;]{2,30})/i)
           || text.match(/груз[:\s]+([^\n,;]{2,30})/i);
  return m?.[1]?.trim() || 'ТНВ';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
