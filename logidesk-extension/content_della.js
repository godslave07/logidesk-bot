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

// React/jQuery-compatible value setter:
// Uses native input value descriptor so React internal state also updates.
function setVal(el, value) {
  if (!el || value === undefined || value === null || value === '') return;
  const strVal = String(value);
  try {
    const proto = (el.tagName === 'TEXTAREA')
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, strVal);
    else el.value = strVal;
  } catch (_) {
    el.value = strVal;
  }
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// Wait until the city-from input exists (form fully rendered)
async function waitForForm() {
  const sel = 'input[name="request[cityNameFrom][0]"]';
  for (let i = 0; i < 40; i++) {       // up to 20 seconds
    if (document.querySelector(sel)) return true;
    await sleep(500);
  }
  console.warn('[LogiDesk Della] Form not found after 20s — filling anyway');
  return false;
}

// ===== CITY LOOKUP via Della AJAX API =====
// POST to /ajax_drop_down.php?mode=city_hint
// Returns {js:{hint_cities:[html,...]}}
// FIX: use URLSearchParams instead of escape() — correctly encodes Cyrillic as %D0%...

async function lookupCity(cityName) {
  // Clean up city name: strip anything after a comma or parenthesis (region info)
  const cleanName = cityName.replace(/[,(].*/, '').trim();

  const body = new URLSearchParams({
    name:               cleanName,
    allow_wp:           '0',
    is_trans:           '0',
    filter_country_uid: '0',
    filter_region_uid:  '0'
  }).toString();

  console.log('[LogiDesk Della] City lookup:', cleanName, '| body:', body);

  try {
    const res = await fetch('/ajax_drop_down.php?mode=city_hint&JsHttpRequest=1-xml', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const text = await res.text();
    console.log('[LogiDesk Della] City API raw:', text.slice(0, 300));

    let data = null;
    try { data = JSON.parse(text); } catch (_) {}
    const items = data?.js?.hint_cities || [];

    // Parse each HTML snippet — handle both single and double quotes
    const cities = items.map(html => {
      // City name: content of <span id='spanN'> or <span id="spanN">
      const nameM = html.match(/id=["']span\d+["'][^>]*>\s*([^<]+?)\s*<\/span>/i);
      // City ID from hidden input value attribute
      const idM   = html.match(/value=["'](\d+)["']/);
      const ridM  = html.match(/rid=["'](\d+)["']/);
      const cidM  = html.match(/cid=["'](\d+)["']/);

      return {
        name: nameM?.[1]?.trim() || '',
        id:   idM?.[1]   || '',
        rid:  ridM?.[1]  || '0',
        cid:  cidM?.[1]  || '0'
      };
    }).filter(c => c.id && c.name);

    console.log('[LogiDesk Della] City lookup results:', cities.length, cities.map(c => c.name));
    return cities;
  } catch (e) {
    console.error('[LogiDesk Della] City lookup error:', e.message);
    return [];
  }
}

async function fillCity(nameInpSel, hiddenInpSel, cityName) {
  const nameInp   = document.querySelector(nameInpSel);
  const hiddenInp = document.querySelector(hiddenInpSel);
  if (!nameInp || !cityName) return false;

  console.log('[LogiDesk Della] fillCity:', cityName);
  const cities = await lookupCity(cityName);

  if (!cities.length) {
    console.warn('[LogiDesk Della] No results for:', cityName, '— setting name only');
    setVal(nameInp, cityName);
    return false;
  }

  // Best match: exact, then starts-with first 4 chars, then first result
  const lower = cityName.toLowerCase().trim().replace(/[,(].*/, '').trim();
  const best = cities.find(c => c.name.toLowerCase() === lower)
            || cities.find(c => c.name.toLowerCase().startsWith(lower.slice(0, 4)))
            || cities[0];

  // Set name field with events so Della's handlers fire
  setVal(nameInp, best.name);

  // Set hidden ID field
  if (hiddenInp) setVal(hiddenInp, best.id);

  console.log(`[LogiDesk Della] City resolved: "${best.name}" (id=${best.id})`);
  return true;
}

// ===== TRUCK TYPE MAPPING (Lardi names → Della truck_id) =====
const TRUCK_MAP = [
  [['тент', 'тентов', 'шторн', 'крит'],    11],
  [['ізотерм', 'изотерм'],                  4],
  [['реф', 'холодильн', 'холод'],          10],
  [['цільно', 'цільнометал', 'цельн'],     19],
  [['борт', 'бортов'],                      7],
  [['платформ', 'низьк'],                   9],
  [['зерновоз'],                            3],
  [['автовоз'],                            17],
  [['контейнер'],                          24],
  [['самоскид', 'самосвал'],               13],
  [['цистерн'],                             8],
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

// ===== HELPERS: find form fields by label text =====
// Used for checkboxes/radios/selects that are inside modals (Деталі оплати, Додаткова інформація).
// These elements ARE in the DOM even when the modal is closed — just hidden via CSS.

function findInputByLabel(labelText, inputType) {
  // Strategy 1: <label for="id">labelText</label> → get element by id
  const labels = document.querySelectorAll('label');
  for (const lbl of labels) {
    if (lbl.textContent.trim() === labelText) {
      const forId = lbl.getAttribute('for');
      if (forId) {
        const el = document.getElementById(forId);
        if (el && (!inputType || el.type === inputType)) return el;
      }
      // label wraps the input
      const inner = lbl.querySelector(inputType ? `input[type="${inputType}"]` : 'input');
      if (inner) return inner;
    }
  }
  // Strategy 2: text node next to input
  const inputs = inputType
    ? document.querySelectorAll(`input[type="${inputType}"]`)
    : document.querySelectorAll('input');
  for (const inp of inputs) {
    const parent = inp.parentElement;
    if (!parent) continue;
    const txt = parent.textContent.trim();
    if (txt === labelText || txt.startsWith(labelText)) return inp;
    // check next sibling text
    let sib = inp.nextSibling;
    while (sib) {
      if (sib.nodeType === 3 && sib.textContent.trim() === labelText) return inp;
      if (sib.nodeType === 1) break;
      sib = sib.nextSibling;
    }
  }
  return null;
}

function findSelectByLabel(labelText) {
  const labels = document.querySelectorAll('label');
  for (const lbl of labels) {
    if (lbl.textContent.trim().includes(labelText)) {
      const forId = lbl.getAttribute('for');
      if (forId) {
        const el = document.getElementById(forId);
        if (el && el.tagName === 'SELECT') return el;
      }
      const inner = lbl.querySelector('select');
      if (inner) return inner;
    }
  }
  // Also try select immediately after a label-like element
  const selects = document.querySelectorAll('select');
  for (const sel of selects) {
    const prev = sel.previousElementSibling;
    if (prev && prev.textContent.trim().includes(labelText)) return sel;
    const parent = sel.parentElement;
    if (parent && parent.textContent.includes(labelText)) return sel;
  }
  return null;
}

// ===== MAIN FORM FILL =====
async function fillDellaForm(order) {
  const d = order.data || order;
  const orderId = order.id;
  console.log('[LogiDesk Della] Filling form for order #' + orderId, d);

  // Wait until form is fully rendered (up to 20s)
  await waitForForm();
  await sleep(500); // extra settle time

  // === FROM CITY ===
  if (d.from) {
    await fillCity(
      'input[name="request[cityNameFrom][0]"]',
      'input[name="request[cityIdFrom][0]"]',
      d.from
    );
    await sleep(300);
  }

  // === TO CITY ===
  if (d.to) {
    await fillCity(
      'input[name="request[cityNameTo][0]"]',
      'input[name="request[cityIdTo][0]"]',
      d.to
    );
    await sleep(300);
  }

  // === CARGO NAME ===
  setVal(document.querySelector('input[name="request[cargo]"]'), d.cargoName || d.cargo || 'ТНВ');

  // === WEIGHT ===
  if (d.weight) setVal(document.querySelector('input[name="request[weight]"]'), d.weight);

  // === VOLUME (field is named "cube" on Della) ===
  if (d.volume) setVal(document.querySelector('input[name="request[cube]"]'), d.volume);

  // === TRUCK TYPE ===
  const truckSel = document.querySelector('select[name="request[truck_id]"]');
  if (truckSel) {
    const tid = String(truckId(d.truckType));
    truckSel.value = tid;
    truckSel.dispatchEvent(new Event('change', { bubbles: true }));
    console.log('[LogiDesk Della] Truck type set:', d.truckType, '→ id', tid);
  }

  // === PRICE ===
  if (d.price) {
    setVal(document.querySelector('input[name="request[price]"]'), d.price);
  }

  // === CURRENCY (1=грн, 2=USD, 3=EUR) ===
  const currSel = document.querySelector('select[name="request_absolute_currency"]');
  if (currSel) {
    const c = (d.currency || 'грн').toLowerCase();
    const currVal = (c.includes('usd') || c === '$') ? '2'
                  : (c.includes('eur') || c === '€') ? '3'
                  : '1'; // грн
    currSel.value = currVal;
    currSel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // === PAYMENT TYPE (Готівка radio в "Деталі оплати") ===
  const pVal = paymentValue(d.paymentType);
  if (pVal) {
    // Try by name attribute (standard form)
    let radio = document.querySelector(`input[name="request[price_cash]"][value="${pVal}"]`);
    // Fallback: find by label text
    if (!radio) radio = findInputByLabel('Готіка', 'radio') || findInputByLabel('Готівка', 'radio');
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('[LogiDesk Della] Payment type set:', d.paymentType);
    }
  }

  // === PAYMENT MOMENT (Термін розрахунку) ===
  if (d.paymentMoment) {
    const pm = d.paymentMoment.toLowerCase();
    // Known IDs: 30=При розвантаженні, 29=При завантаженні, 28=Передоплата
    const momentIdMap = {
      'розвантаж': 'request[extra][30]',
      'завантаж':  'request[extra][29]',
      'передоплат':'request[extra][28]',
    };
    let momentId = null;
    for (const [key, id] of Object.entries(momentIdMap)) {
      if (pm.includes(key)) { momentId = id; break; }
    }
    if (momentId) {
      const chk = document.getElementById(momentId)
               || findInputByLabel('При розвантаженні', 'checkbox')
               || findInputByLabel('При завантаженні',  'checkbox');
      if (chk && !chk.checked) {
        chk.checked = true;
        chk.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[LogiDesk Della] Payment moment set:', d.paymentMoment);
      }
    }
  }

  // === LOADING TYPE (Збоку / Зверху / Задня) ===
  if (d.loadingType) {
    const lt = d.loadingType.toLowerCase();
    const labelText = lt.includes('збок') || lt.includes('бічн') ? 'Збоку'
                    : lt.includes('верх')                        ? 'Зверху'
                    : lt.includes('задн')                        ? 'Задня'
                    : '';
    if (labelText) {
      const chk = findInputByLabel(labelText, 'checkbox');
      if (chk && !chk.checked) {
        chk.checked = true;
        chk.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[LogiDesk Della] Loading type set:', labelText);
      }
    }
  }

  // === PALLET TYPE (Тип палет — select у "Додаткова інформація") ===
  if (d.palletType) {
    const palletSel = findSelectByLabel('Тип палет');
    if (palletSel) {
      // Find matching option by text (EURO, FIN, etc.)
      const opt = Array.from(palletSel.options).find(o =>
        o.text.toUpperCase().includes(d.palletType.toUpperCase())
      );
      if (opt) {
        palletSel.value = opt.value;
        palletSel.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[LogiDesk Della] Pallet type set:', d.palletType, '→ option', opt.text);
      }
    }
  }

  // === PALLET COUNT (Кількість палет) ===
  if (d.palletCount) {
    const palletInp = findInputByLabel('Кількість палет', 'text')
                   || findInputByLabel('Кільк. палет', 'text');
    if (palletInp) {
      setVal(palletInp, d.palletCount);
      console.log('[LogiDesk Della] Pallet count set:', d.palletCount);
    }
  }

  // === МІСЦЬ ЗАВАНТАЖЕННЯ ===
  if (d.loadPlaces && parseInt(d.loadPlaces) > 1) {
    const chkL = document.getElementById('request[extra][66]');
    if (chkL && !chkL.checked) {
      chkL.checked = true;
      chkL.dispatchEvent(new Event('change', { bubbles: true }));
    }
    setVal(document.getElementById('request[extra][66][value]'), String(d.loadPlaces));
  }

  // === МІСЦЬ ВИВАНТАЖЕННЯ ===
  if (d.unloadPlaces && parseInt(d.unloadPlaces) > 1) {
    const chk = document.getElementById('request[extra][67]');
    if (chk && !chk.checked) {
      chk.checked = true;
      chk.dispatchEvent(new Event('change', { bubbles: true }));
    }
    setVal(document.getElementById('request[extra][67][value]'), String(d.unloadPlaces));
  }

  // === NOTES ===
  if (d.notes) setVal(document.querySelector('textarea[name="request[memo]"]'), d.notes);

  // === DATES ===
  function toDellaDate(str) {
    if (!str) return null;
    // YYYY-MM-DD → DD.MM.YYYY
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      const [y, m, day] = str.split('-');
      return `${day}.${m}.${y}`;
    }
    // DD.MM.YYYY — pass through
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(str)) return str;
    return null;
  }

  if (d.dateFrom) {
    const df = toDellaDate(d.dateFrom);
    if (df) {
      setVal(document.getElementById('CalendarDateFrom'), df);
      // If dateTo not specified — set same as dateFrom
      const dt = toDellaDate(d.dateTo || d.dateFrom);
      if (dt) setVal(document.getElementById('CalendarDateTo'), dt);
    }
  }

  // Log what was actually set in the form
  console.log('[LogiDesk Della] Form filled:', {
    from:  document.querySelector('input[name="request[cityNameFrom][0]"]')?.value,
    fromId: document.querySelector('input[name="request[cityIdFrom][0]"]')?.value,
    to:    document.querySelector('input[name="request[cityNameTo][0]"]')?.value,
    toId:  document.querySelector('input[name="request[cityIdTo][0]"]')?.value,
    cargo: document.querySelector('input[name="request[cargo]"]')?.value,
    price: document.querySelector('input[name="request[price]"]')?.value,
    dateFrom: document.getElementById('CalendarDateFrom')?.value,
  });

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
