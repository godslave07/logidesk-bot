// LogiDesk — Della.ua form filler (isolated world)
// Uses fetch() to directly query city API — reliable, no dropdown hacks needed.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'fill_form' && msg.order) {
    fillDellaForm(msg.order).catch(e => console.error('[LogiDesk Della]', e));
    sendResponse({ ok: true });
    return true;
  }
});

// ===== HELPERS =====

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function setVal(el, value) {
  if (!el || value === undefined || value === null || value === '') return;
  el.value = String(value);
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// ===== CITY LOOKUP via Della AJAX API =====
// POST to /ajax_drop_down.php?mode=city_hint — returns {js:{hint_cities:[html,...]}}
// Each HTML item: <input type='hidden' id='citidN' value='ID' rid='RID' cid='CID'>

async function lookupCity(cityName) {
  const body = [
    'name=' + escape(cityName),   // server expects escape()-encoded strings
    'allow_wp=0',
    'is_trans=0',
    'filter_country_uid=0',
    'filter_region_uid=0'
  ].join('&');

  try {
    const res = await fetch('/ajax_drop_down.php?mode=city_hint&JsHttpRequest=1-xml', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await res.json();
    const items = data.js?.hint_cities || [];

    // Parse each HTML snippet: extract display name and city ID
    return items.map(html => {
      const nameM = html.match(/id='span\d+'[^>]*>([^<]+)<\/span>/);
      const idM   = html.match(/value='(\d+)'\s+rid='(\d+)'\s+cid='(\d+)'/);
      return {
        name: nameM?.[1] || '',
        id:   idM?.[1]   || '',
        rid:  idM?.[2]   || '0',
        cid:  idM?.[3]   || '0'
      };
    }).filter(c => c.id);
  } catch (e) {
    console.error('[LogiDesk Della] City lookup error:', e.message);
    return [];
  }
}

async function fillCity(nameInpSel, hiddenInpSel, cityName) {
  const nameInp   = document.querySelector(nameInpSel);
  const hiddenInp = document.querySelector(hiddenInpSel);
  if (!nameInp || !cityName) return false;

  console.log('[LogiDesk Della] Looking up city:', cityName);
  const cities = await lookupCity(cityName);

  if (!cities.length) {
    console.warn('[LogiDesk Della] No results for:', cityName, '— setting name only');
    nameInp.value = cityName;
    return false;
  }

  // Best match: exact name, then starts-with (first 4 chars)
  const lower = cityName.toLowerCase().trim();
  const best = cities.find(c => c.name.toLowerCase() === lower)
            || cities.find(c => c.name.toLowerCase().startsWith(lower.slice(0, 4)))
            || cities[0];

  nameInp.value = best.name;
  if (hiddenInp) hiddenInp.value = best.id;

  console.log(`[LogiDesk Della] City resolved: "${best.name}" (id=${best.id})`);
  return true;
}

// ===== TRUCK TYPE MAPPING (Lardi names → Della truck_id) =====
const TRUCK_MAP = [
  [['тент', 'тентов', 'шторн', 'крит'],    11],
  [['ізотерм'],                              4],
  [['реф', 'холодильн'],                    10],
  [['цільно', 'цільнометал', 'цельн'],      19],
  [['борт', 'бортов'],                       7],
  [['платформ', 'низьк'],                    9],
  [['зерновоз'],                             3],
  [['автовоз'],                             17],
  [['контейнер'],                           24],
];

function truckId(truckType) {
  if (!truckType) return 11; // default: тент
  const lower = truckType.toLowerCase();
  for (const [keys, id] of TRUCK_MAP) {
    if (keys.some(k => lower.includes(k))) return id;
  }
  return 11;
}

// ===== PAYMENT TYPE MAPPING =====
// request[price_cash]: 0=default, 1=готівка, 2=безготівковий, 3=комбі, 4=софт, 5=будь-яка, 6=картка
function paymentValue(paymentType) {
  if (!paymentType) return null;
  const lower = paymentType.toLowerCase();
  if (lower.includes('готів') || lower.includes('нал'))     return '1';
  if (lower.includes('безгот') || lower.includes('безнал')) return '2';
  if (lower.includes('комбін'))                             return '3';
  if (lower.includes('картк') || lower.includes('карт'))    return '6';
  if (lower.includes('будь'))                               return '5';
  return null;
}

// ===== MAIN FORM FILL =====
async function fillDellaForm(order) {
  const d = order.data || order;
  const orderId = order.id;
  console.log('[LogiDesk Della] Filling form for order #' + orderId, d);

  await sleep(800); // let the page settle

  // === FROM CITY ===
  if (d.from) {
    await fillCity(
      'input[name="request[cityNameFrom][0]"]',
      'input[name="request[cityIdFrom][0]"]',
      d.from
    );
  }

  // === TO CITY ===
  if (d.to) {
    await fillCity(
      'input[name="request[cityNameTo][0]"]',
      'input[name="request[cityIdTo][0]"]',
      d.to
    );
  }

  // === CARGO NAME ===
  setVal(document.querySelector('input[name="request[cargo]"]'), d.cargoName || d.cargo || 'тнв');

  // === WEIGHT ===
  setVal(document.querySelector('input[name="request[weight]"]'), d.weight);

  // === VOLUME (field is named "cube" on Della) ===
  setVal(document.querySelector('input[name="request[cube]"]'), d.volume);

  // === TRUCK TYPE ===
  const truckSel = document.querySelector('select[name="request[truck_id]"]');
  if (truckSel) {
    truckSel.value = String(truckId(d.truckType));
    truckSel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // === PRICE ===
  setVal(document.querySelector('input[name="request[price]"]'), d.price);

  // === CURRENCY (1=грн, 2=USD, 3=EUR) ===
  const currSel = document.querySelector('select[name="request_absolute_currency"]');
  if (currSel) {
    const c = (d.currency || 'грн').toLowerCase();
    currSel.value = (c.includes('usd') || c === '$') ? '2'
                  : (c.includes('eur') || c === '€') ? '3'
                  : '1'; // грн
    currSel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // === PAYMENT TYPE ===
  const pVal = paymentValue(d.paymentType);
  if (pVal) {
    const radio = document.querySelector(`input[name="request[price_cash]"][value="${pVal}"]`);
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // === PAYMENT MOMENT (Термін розрахунку) ===
  // extra[29] = При завантаженні, extra[30] = При розвантаженні, extra[28] = Передоплата
  if (d.paymentMoment) {
    const lower = d.paymentMoment.toLowerCase();
    let momentId = null;
    if (lower.includes('розвантаж'))       momentId = 'request[extra][30]';
    else if (lower.includes('завантаж'))   momentId = 'request[extra][29]';
    else if (lower.includes('передоплат')) momentId = 'request[extra][28]';

    if (momentId) {
      const chk = document.getElementById(momentId);
      if (chk && !chk.checked) {
        chk.checked = true;
        chk.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[LogiDesk Della] Payment moment checked:', momentId, d.paymentMoment);
      }
    }
  }

  // === МІСЦЬ ВИВАНТАЖЕННЯ (Місць вивант.) ===
  // Checkbox: request[extra][67][checked], Value input: request[extra][67][value]
  if (d.unloadPlaces && parseInt(d.unloadPlaces) > 1) {
    const chk = document.getElementById('request[extra][67]');
    if (chk && !chk.checked) {
      chk.checked = true;
      chk.dispatchEvent(new Event('change', { bubbles: true }));
    }
    setVal(document.getElementById('request[extra][67][value]'), String(d.unloadPlaces));
    console.log('[LogiDesk Della] Місць вивант. set to:', d.unloadPlaces);
  }

  // === NOTES ===
  setVal(document.querySelector('textarea[name="request[memo]"]'), d.notes);

  // === DATE ===
  if (d.dateFrom) {
    // Convert YYYY-MM-DD → DD.MM.YYYY if needed
    let date = d.dateFrom;
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const [y, m, day] = date.split('-');
      date = `${day}.${m}.${y}`;
    }
    setVal(document.getElementById('CalendarDateFrom'), date);
  }

  console.log('[LogiDesk Della] Form filled ✅ — submitting in 3s...');
  showNotification('✅ LogiDesk: форму Della заповнено!\nВідправка через 3 секунди...');

  // Mark posted BEFORE navigating away (page changes URL after submit)
  await sleep(2000);
  chrome.runtime.sendMessage({
    type: 'mark_posted',
    orderId: orderId,
    platform: 'della'
  }).catch(() => {});

  await sleep(1000);

  // Submit
  const submitBtn = document.getElementById('submitFromBtn');
  if (submitBtn) {
    console.log('[LogiDesk Della] Clicking submit...');
    submitBtn.click();
  } else {
    console.warn('[LogiDesk Della] Submit button #submitFromBtn not found');
    showNotification('⚠️ LogiDesk: не знайдено кнопку відправки.\nНатисніть "Додати вантаж" вручну.');
  }
}

// ===== NOTIFICATION =====
function showNotification(text) {
  const existing = document.getElementById('logidesk-notification');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.id = 'logidesk-notification';
  div.style.cssText = [
    'position:fixed', 'top:20px', 'right:20px', 'z-index:99999',
    'background:#166534', 'color:white', 'padding:14px 18px',
    'border-radius:10px', 'font-size:14px', 'font-weight:600',
    'box-shadow:0 4px 20px rgba(0,0,0,.3)', 'max-width:320px',
    'line-height:1.6', 'white-space:pre-line', 'cursor:pointer'
  ].join(';');
  div.textContent = text;
  div.onclick = () => div.remove();
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 7000);
}
