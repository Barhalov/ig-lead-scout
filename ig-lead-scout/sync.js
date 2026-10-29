// sync.js — изолированный фундамент «базы» для будущего подключения телефона.
//
// Задуман так, чтобы НЕ трогать основной код: по умолчанию ВЫКЛЮЧЕН (ключ
// `igx_sync_on` !== true) и пока выключен — ни на что не влияет. Он только
// ЧИТАЕТ существующую базу (`igx_profile:*`) и пишет в СОБСТВЕННЫЕ новые ключи.
// Ни одна существующая функция отсюда не вызывается и не переопределяется.
//
// Назначение: копить «журнал находок» (`igx_sync_outbox`) по единой схеме лида —
// это тот общий слой, который позже станет мостом между ПК и телефоном. Сам мост
// (транспорт до телефона / приёмник на ПК) — отдельный следующий шаг; здесь лишь
// договорённость о данных + источник изменений.
//
// Подключается ОДНОЙ строкой в background.js (importScripts('sync.js')); слушатели
// воркера навешиваются синхронно при загрузке этого файла, как требует MV3.

const IGX_SYNC_ON = 'igx_sync_on';         // true — включить сбор журнала (default: выкл)
const IGX_SYNC_OUTBOX = 'igx_sync_outbox'; // { cursor, events:[{ seq, at, op, lead }] } — append-only, cap
const IGX_SYNC_SEEN = 'igx_sync_seen';     // { username(lower): хэш релевантных полей } — что уже отдали
const IGX_SYNC_ALARM = 'igx_sync_tick';    // фоновый будильник: пересобрать журнал раз в минуту
const IGX_SYNC_CAP = 500;                  // сколько событий хранить (старые обрезаются с головы)

// Ключ «досье профиля» в базе (тот же префикс, что во всём проекте).
const IGX_SYNC_PROFILE_PREFIX = 'igx_profile:';

// ---------- приёмник телефона (мост «телефон → ПК»): по умолчанию ВЫКЛЮЧЕН ----------
const IGX_SYNC_IMPORT_ON = 'igx_sync_import_on';                 // true — опрашивать контроллер и ставить находки в быструю проверку
const IGX_SYNC_IMPORT_URL = 'igx_sync_import_url';              // откуда тянуть (дефолт ниже)
const IGX_SYNC_IMPORT_DEFAULT_URL = 'http://localhost:8799/new-leads';
const IGX_SYNC_INBOX = 'igx_sync_inbox';                        // { queue:[nick], pending:{nick:at}, done:{nick:at} }
const IGX_SYNC_IMPORT_ALARM = 'igx_sync_import_tick';
const IGX_SYNC_QC_KEY = 'igx_quickcheck_tabs';                  // та же session-мапа, что ведёт background.js
const IGX_SYNC_IMPORT_BATCH = 5;                                // максимум фоновых quickCheck-вкладок за тик
const IGX_SYNC_IMPORT_GAP_MS = 5000;                            // пауза между открытием вкладок внутри тика
const IGX_SYNC_IMPORT_PENDING_MS = 90000;                       // сколько считать ник «в работе»

function igxSyncHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}

// Каноническая запись лида. Смысл: и ПК-дашборд, и будущий телефон оперируют ОДНОЙ
// схемой, чтобы находки с телефона можно было влить в базу без «перевода». Поля —
// ровно те, что уже есть в профиле (включая tgName/tgBio из чек-пола).
function igxSyncLead(p) {
  const u = String((p && p.username) || '').toLowerCase();
  return {
    username: u,
    fullName: (p && p.fullName) || '',
    bio: (p && p.bio) || '',
    followers: p && p.followers != null ? Number(p.followers) || 0 : null,
    telegram: (p && p.telegram) || '',
    tgKind: (p && p.tgKind) || '',
    // tgReal нормализуем к true/false/null: в базе там может быть и 'unknown'.
    tgReal: (p && p.tgReal === true) ? true : (p && p.tgReal === false) ? false : null,
    tgName: (p && p.tgName) || '',
    tgBio: (p && p.tgBio) || '',
    checkedAt: Number(p && p.checkedAt) || 0,
    updatedAt: Date.now(),
  };
}

// Хэш только значимых полей (без updatedAt): событие в журнал идёт, когда профиль
// РЕАЛЬНО изменился, а не на каждое его касание.
function igxSyncFieldsHash(l) {
  return igxSyncHash([
    l.username, l.fullName, l.bio, l.followers, l.telegram,
    l.tgKind, String(l.tgReal), l.tgName, l.tgBio,
  ].join('\u0001'));
}

async function igxSyncEnabled() {
  try {
    const d = await chrome.storage.local.get(IGX_SYNC_ON);
    return !!(d && d[IGX_SYNC_ON] === true);
  } catch (_) { return false; }
}

// Одна сборка журнала: сравнили базу с «что уже отдали» и дописали изменение.
// Пишем ТОЛЬКО в свои ключи — существующие записи профиля не трогаем.
async function igxSyncTick() {
  if (!(await igxSyncEnabled())) return;
  let all = {};
  try { all = await chrome.storage.local.get(null); } catch (_) { return; }
  const seen = (all[IGX_SYNC_SEEN] && typeof all[IGX_SYNC_SEEN] === 'object') ? all[IGX_SYNC_SEEN] : {};
  let ob = (all[IGX_SYNC_OUTBOX] && typeof all[IGX_SYNC_OUTBOX] === 'object' && Array.isArray(all[IGX_SYNC_OUTBOX].events))
    ? all[IGX_SYNC_OUTBOX]
    : { cursor: 0, events: [] };
  if (typeof ob.cursor !== 'number') ob.cursor = 0;

  let added = 0;
  const nextSeen = Object.assign({}, seen);
  for (const k of Object.keys(all)) {
    if (!k.startsWith(IGX_SYNC_PROFILE_PREFIX)) continue;
    const p = all[k];
    if (!p || typeof p !== 'object') continue;
    const lead = igxSyncLead(p);
    if (!lead.username) continue;
    const h = igxSyncFieldsHash(lead);
    if (seen[lead.username] === h) continue; // без изменений — не дублируем
    nextSeen[lead.username] = h;
    ob.cursor += 1;
    ob.events.push({ seq: ob.cursor, at: Date.now(), op: 'upsert', lead });
    added++;
  }
  // Cap: удерживаем только последние IGX_SYNC_CAP событий (хвост журнала).
  if (ob.events.length > IGX_SYNC_CAP) ob.events.splice(0, ob.events.length - IGX_SYNC_CAP);

  if (added) {
    try { await chrome.storage.local.set({ [IGX_SYNC_OUTBOX]: ob, [IGX_SYNC_SEEN]: nextSeen }); } catch (_) {}
  }
}

// ================= ПРИЁМНИК ТЕЛЕФОНА (мост «телефон → ПК») =================
// Телефон (другой аккаунт, ADB+CDP-контроллер) делает тяжёлую и «банобосную»
// часть — листает списки подписчиков и собирает ники. Проверка TG и разбор остаются
// на ПК. MV3 не умеет принимать входящие пуши, поэтому ПК сам ОПОРАШИВАЕТ локальный
// эндпоинт контроллера и для каждой новой находки открывает фоновую quickCheck-вкладку —
// ровно тот же путь, что и ручная «быстрая проверка»: content.js извлечёт профиль,
// проверит TG, сохранит в igx_profile:* и закроет вкладку. sync.js НЕ пишет igx_profile:*
// сам — он лишь дёргает существующий механизм, поэтому основной код не затронут.
// По умолчанию ВЫКЛЮЧЕНО (igx_sync_import_on !== true).

function igxSyncSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function igxSyncImportEnabled() {
  try { const d = await chrome.storage.local.get(IGX_SYNC_IMPORT_ON); return !!(d && d[IGX_SYNC_IMPORT_ON] === true); } catch (_) { return false; }
}
async function igxSyncImportUrl() {
  try {
    const d = await chrome.storage.local.get(IGX_SYNC_IMPORT_URL);
    const u = d && d[IGX_SYNC_IMPORT_URL];
    return (typeof u === 'string' && u.trim()) ? u.trim() : IGX_SYNC_IMPORT_DEFAULT_URL;
  } catch (_) { return IGX_SYNC_IMPORT_DEFAULT_URL; }
}

// ник → lower, без «@». Лид может быть строкой или объектом { username }.
function igxSyncLeadUser(x) {
  if (!x) return '';
  const raw = (typeof x === 'string') ? x : String(x.username || x.user || '');
  return raw.replace(/^@/, '').trim().toLowerCase();
}

// Терпимо к формату: массив лидов ИЛИ { leads:[...] }.
async function igxSyncFetchLeads(url) {
  let ctrl, timer;
  try {
    ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : (data && Array.isArray(data.leads) ? data.leads : []);
  } catch (_) { return []; }
  finally { if (timer) clearTimeout(timer); }
}

function igxSyncNormalizeInbox(box) {
  const b = (box && typeof box === 'object') ? box : {};
  if (!Array.isArray(b.queue)) b.queue = [];
  if (!b.pending || typeof b.pending !== 'object') b.pending = {};
  if (!b.done || typeof b.done !== 'object') b.done = {};
  return b;
}
function igxSyncTrimDone(inbox, cap) {
  const keys = Object.keys(inbox.done);
  if (keys.length <= cap) return;
  keys.sort((a, b) => (inbox.done[a] || 0) - (inbox.done[b] || 0));
  for (let i = 0; i < keys.length - cap; i++) delete inbox.done[keys[i]];
}

// Регистрация во ВСЁ ТОМ ЖЕ session-мапе quickCheck, что и background.js: иначе content.js
// не сможет закрыть вкладку через checkDone (тот ищет tab.id именно в этой мапе).
async function igxSyncQcRegister(tabId, username) {
  try {
    const data = await chrome.storage.session.get(IGX_SYNC_QC_KEY);
    const map = data[IGX_SYNC_QC_KEY] || {};
    map[tabId] = { username, createdAt: Date.now() };
    await chrome.storage.session.set({ [IGX_SYNC_QC_KEY]: map });
  } catch (_) {}
}

async function igxSyncImportTick() {
  if (!(await igxSyncImportEnabled())) return;
  let store = {};
  try { store = await chrome.storage.local.get(IGX_SYNC_INBOX); } catch (_) { return; }
  const inbox = igxSyncNormalizeInbox(store[IGX_SYNC_INBOX]);
  const now = Date.now();
  for (const u of Object.keys(inbox.pending)) if (now - (inbox.pending[u] || 0) > IGX_SYNC_IMPORT_PENDING_MS) delete inbox.pending[u];

  // 1) пополняем очередь из эндпоинта контроллера
  const url = await igxSyncImportUrl();
  const leads = await igxSyncFetchLeads(url);
  for (const lead of leads) {
    const u = igxSyncLeadUser(lead);
    if (!u || u.length > 30) continue;
    if (inbox.done[u] || inbox.pending[u]) continue;      // уже гоняли / гоняется сейчас
    if (!inbox.queue.includes(u)) inbox.queue.push(u);
  }

  // 2) дроим очередь фоновыми quickCheck (кап за тик + пауза между вкладками)
  let opened = 0;
  while (inbox.queue.length && opened < IGX_SYNC_IMPORT_BATCH) {
    const u = inbox.queue.shift();
    if (inbox.pending[u] || inbox.done[u]) continue;
    let tab = null;
    try {
      tab = await chrome.tabs.create({ url: `https://www.instagram.com/${encodeURIComponent(u)}/`, active: false });
    } catch (_) { break; }
    if (tab && tab.id != null) {
      await igxSyncQcRegister(tab.id, u);
      const tabId = tab.id;
      // подстраховка: content не отчитался — закрываем сами (как делает background)
      setTimeout(async () => {
        try {
          const d = await chrome.storage.session.get(IGX_SYNC_QC_KEY);
          const m = d[IGX_SYNC_QC_KEY] || {};
          if (m[tabId]) { delete m[tabId]; await chrome.storage.session.set({ [IGX_SYNC_QC_KEY]: m }); chrome.tabs.remove(tabId).catch(() => {}); }
        } catch (_) {}
      }, 30000);
    }
    inbox.pending[u] = Date.now();
    inbox.done[u] = Date.now();
    opened++;
    await igxSyncSleep(IGX_SYNC_IMPORT_GAP_MS);
  }

  igxSyncTrimDone(inbox, 8000);
  try { await chrome.storage.local.set({ [IGX_SYNC_INBOX]: inbox }); } catch (_) {}
}

// ---------- саморегистрация в служебном воркере (MV3: слушатели вешаем на загрузке) ----------
try {
  // Будильник раз в минуту — страховка, что журнал соберётся даже без событий storage.
  chrome.alarms.create(IGX_SYNC_ALARM, { periodInMinutes: 1 });
  // Будильник приёмника телефона (реально работает только при igx_sync_import_on===true).
  chrome.alarms.create(IGX_SYNC_IMPORT_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (!a) return;
    if (a.name === IGX_SYNC_ALARM) igxSyncTick().catch(() => {});
    else if (a.name === IGX_SYNC_IMPORT_ALARM) igxSyncImportTick().catch(() => {});
  });
  // Живой триггер: как только в базе меняется хоть один профиль — дебаунсом пересобираем
  // журнал (не на каждую запись, чтобы не долбить storage на масс-прогоне).
  let _syncDebounce = null;
  chrome.storage.onChanged.addListener((chg, area) => {
    if (area !== 'local' || !chg) return;
    let touched = false;
    for (const k of Object.keys(chg)) {
      if (k.startsWith(IGX_SYNC_PROFILE_PREFIX) || k === IGX_SYNC_ON) { touched = true; break; }
    }
    if (!touched) return;
    if (_syncDebounce) clearTimeout(_syncDebounce);
    _syncDebounce = setTimeout(() => { _syncDebounce = null; igxSyncTick().catch(() => {}); }, 4000);
  });
} catch (_) {}
