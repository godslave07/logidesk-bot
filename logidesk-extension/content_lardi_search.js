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

  console.log(`[LogiDesk Search] Total extracted: ${proposals.length}`,
    proposals.map(p => `${p.from}→${p.to} ${p.price}грн (${p.cargoName})`));
  return proposals;
}

// ===== Parse a TABLE ROW by column position =====
// Lardi column order: [Country] [Date] [Transport+Loading] [FromCity] [ToCity] [Cargo+Pallets] [Price] [Contact]
function parseTableRow(row) {
  const cells = Array.from(row.querySelectorAll('td'));
  if (cells.length < 5) return null;

  const rowText = row.innerText || '';
  const lower = rowText.toLowerCase();
  if (lower.includes('безгот') || lower.includes('безнал')) return null;

  // === CITIES — find by SVG/pin icons, fall back to column index ===
  const cityCells = cells.filter(td => {
    const hasPinLike = td.querySelector('svg') ||
      td.querySelector('[class*="pin"]') ||
      td.querySelector('[class*="city"]') ||
      td.querySelector('[class*="location"]') ||
      td.innerHTML.includes('pin') || td.innerHTML.includes('marker');
    if (!hasPinLike) return false;
    // Only count as city cell if text contains lowercase Cyrillic (real city name)
    return /[а-яёіїє]/u.test(td.innerText);
  });

  let fromText = '', toText = '', fromIdx = -1, toIdx = -1;

  if (cityCells.length >= 2) {
    fromText = cleanCity(cityCells[0].innerText);
    toText   = cleanCity(cityCells[1].innerText);
    fromIdx  = cells.indexOf(cityCells[0]);
    toIdx    = cells.indexOf(cityCells[1]);
  } else {
    for (const offset of [3, 2, 4]) {
      const f = cleanCity(cells[offset]?.innerText || '');
      const t = cleanCity(cells[offset + 1]?.innerText || '');
      if (isCity(f) && isCity(t) && f !== t) {
        fromText = f; toText = t;
        fromIdx = offset; toIdx = offset + 1;
        break;
      }
    }
  }

  if (!fromText || !toText || !isCity(fromText) || !isCity(toText)) return null;

  // === PRICE ===
  let price = 0;
  for (const td of cells) {
    const t = td.innerText;
    const m = t.match(/(\d[\d\s]{2,8})\s*(грн|UAH)/i) || t.match(/₴\s*(\d[\d\s]{2,8})/);
    if (m) {
      price = parseFloat(m[1].replace(/\s+/g, ''));
      if (price >= 11000) break;
      price = 0;
    }
  }
  if (!price || price < 11000) return null;

  // === TRANSPORT CELL (usually fromIdx−1, i.e. column 2) ===
  // Contains: truck type ("Тент") + loading side ("бічне")
  const transportIdx = fromIdx > 0 ? fromIdx - 1 : 2;
  const transportText = cells[transportIdx]?.innerText || cells[2]?.innerText || '';
  const truckType   = extractTruckType(transportText || rowText);
  const loadingType = extractLoadingType(transportText || rowText);

  // === CARGO CELL (usually toIdx+1, i.e. column 5) ===
  // Contains: cargo name ("сухі будівельні суміші") + pallet info ("EURO 1,2x0,8м 914шт")
  let cargoName   = 'ТНВ';
  let palletType  = '';
  let palletCount = '';

  const cargoIdx  = toIdx > 0 ? toIdx + 1 : 5;
  const cargoCell = cells[cargoIdx] || cells[5] || null;
  if (cargoCell) {
    const raw = cargoCell.innerText.trim();
    if (raw.length > 0) {
      // First non-empty line is the cargo name
      const firstLine = raw.split(/[\n\r]/)[0].trim();
      if (firstLine.length >= 2 && firstLine.length <= 80) {
        cargoName = firstLine;
      }
      // Pallet type: EURO / FIN
      const ptM = raw.match(/\b(EURO|EUR|FIN|Євро|Фін)\b/i);
      if (ptM) {
        const ptRaw = ptM[1].toLowerCase();
        palletType = (ptRaw === 'євро' || ptRaw === 'euro' || ptRaw === 'eur') ? 'EURO'
                   : (ptRaw === 'фін'  || ptRaw === 'fin')                      ? 'FIN'
                   : ptM[1].toUpperCase();
      }
      // Pallet count: "914шт"
      const pcM = raw.match(/(\d{1,5})\s*шт/i);
      if (pcM) palletCount = pcM[1];
    }
  }

  // === PAYMENT MOMENT (from full row text) ===
  const paymentMoment = extractPaymentMoment(rowText);

  const id = row.dataset?.id || row.dataset?.cargo ||
             row.getAttribute('data-id') || row.getAttribute('data-cargo-id') || null;

  return {
    id,
    from:         fromText,
    to:           toText,
    price,
    paymentType:  'Готівка',
    paymentMoment,
    weight:       (rowText.match(/(\d+(?:[.,]\d+)?)\s*т\b/i) || [])[1]?.replace(',', '.') || '',
    volume:       (rowText.match(/(\d+(?:[.,]\d+)?)\s*м[³3]/i) || [])[1]?.replace(',', '.') || '',
    truckType,
    loadingType,
    cargoName,
    palletType,
    palletCount,
    dateFrom:     extractDate(rowText),
  };
}

// ===== Parse from text block (for cards/divs) — uses arrow separators only =====
function parseProposalFromText(text, el) {
  if (!text || text.length < 8) return null;

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

  // Pallet type from text
  let palletType = '';
  const ptM = text.match(/\b(EURO|EUR|FIN|Євро|Фін)\b/i);
  if (ptM) {
    const ptRaw = ptM[1].toLowerCase();
    palletType = (ptRaw === 'євро' || ptRaw === 'euro' || ptRaw === 'eur') ? 'EURO'
               : (ptRaw === 'фін'  || ptRaw === 'fin')                      ? 'FIN'
               : ptM[1].toUpperCase();
  }
  const pcM = text.match(/(\d{1,5})\s*шт/i);

  return {
    id,
    from,
    to,
    price,
    paymentType:  'Готівка',
    paymentMoment: extractPaymentMoment(text),
    weight:       (text.match(/(\d+(?:[.,]\d+)?)\s*т\b/i) || [])[1]?.replace(',', '.') || '',
    volume:       (text.match(/(\d+(?:[.,]\d+)?)\s*м[³3]/i) || [])[1]?.replace(',', '.') || '',
    truckType:    extractTruckType(text),
    loadingType:  extractLoadingType(text),
    cargoName:    'ТНВ',   // can't reliably extract cargo from freeform text without structure
    palletType,
    palletCount:  pcM ? pcM[1] : '',
    dateFrom:     extractDate(text),
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

  for (let i = 0; i < 60; i++) {
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

// Strip region info: "Житомир (Житомирська обл.)" → "Житомир"
// Also handles multiline innerText: "Київ\nКиївська обл." → "Київ"
function cleanCity(str) {
  if (!str) return '';
  return str.split(/[\n\r]/)[0].replace(/\(.*?\)/g, '').replace(/,.*$/, '').trim();
}

function isCity(str) {
  if (!str || str.length < 2 || str.length > 50) return false;
  const t = str.trim();
  if (!/[а-яёіїє]/u.test(t)) return false; // must contain lowercase Cyrillic
  return /^[А-ЯЁІЇЄA-ZÀ-Ü][а-яёіїєa-zA-Zà-ü\w\s\-\.]{1,49}$/u.test(t);
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

// Loading side — "бічне" on Lardi → "збоку" for Della
function extractLoadingType(text) {
  const t = text.toLowerCase();
  if (t.includes('збоку') || t.includes('бічн') || t.includes('боків') || t.includes('бок'))  return 'збоку';
  if (t.includes('зверху') || t.includes('верх') || t.includes('top'))                         return 'зверху';
  if (t.includes('задн')   || t.includes('ззаду') || t.includes('rear'))                       return 'задня';
  return '';
}

// Payment moment: "на розвантаженні" → 'розвантаження'
function extractPaymentMoment(text) {
  const t = text.toLowerCase();
  if (t.includes('розвантаж'))  return 'розвантаження';
  if (t.includes('завантаж'))   return 'завантаження';
  if (t.includes('передоплат')) return 'передоплата';
  return '';
}

function extractDate(text) {
  const m = text.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) return `${m[1]}.${m[2]}.${m[3]}`;
  const m2 = text.match(/(\d{2})\.(\d{2})/);
  if (m2) {
    const year = new Date().getFullYear();
    return `${m2[1]}.${m2[2]}.${year}`;
  }
  return '';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
