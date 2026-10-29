// tg.js — Telegram-интеграция IG Lead Scout (часть service worker'а).
// Режимы проверки:
//   "site" — быстрый, без аккаунта: t.me превью + t.me/s/ (посты публичных каналов).
//   "tg"   — точный, через залогиненный web.telegram.org (читает любые каналы/чаты).
// Бот принимает команды /start, /mode, /st и ссылки t.me — и кидает отчёты.
// Маркер сборки: нет этой строки в консоли service worker'а — воркер крутит старый tg.js,
// а значит обработчика «🛑 бан» ниже тоже нет (нужен ⟳ на chrome://extensions).
console.log('[IG Lead Scout] tg.js build=ban-alert-2 loaded'); // 2: бан-карточка теперь называет вкладку (@хозяин списка) и честный вердикт цикла («остываю N мин» / «остановлен со сводкой») вместо вечно «пауза 15 мин»; 1: сам обработчик tgBanAlert

const TG_SETTINGS_KEY = 'igx_tg_settings';
const TG_OFFSET_KEY = 'igx_tg_offset';
const TG_REPORTED_KEY = 'igx_tg_reported';
const TG_TAB_KEY = 'igx_tg_tab';
const TG_POLL_ALARM = 'igx-tg-poll';

const TG_DEFAULT_SETTINGS = {
  token: '',
  chatId: 0,
  chatQuery: '', // введённый юзернейм/ID получателя — чтобы поле в попапе восстанавливалось
  mode: 'site', // 'site' | 'tg'
  msgLimit: 20, // сколько сообщений читать в режиме "тг"
  delaySec: 10, // пауза между пачками запросов, сек
  autoReport: true, // слать отчёт в ТГ сразу при подтверждении лида
  safeMode: true, // безопасный режим: автоподбор щадящих значений
};

const TG_SAFE = { msgLimit: 10, delaySec: 30 };

const TG_RESERVED_USERS = new Set([
  'telegram', 'bot', 'username', 'stickers', 'addstickers', 'addemoji',
  'addtheme', 'settheme', 'share', 'proxy', 'socks', 'boost', 'm', 's',
  'invoice', 'game', 'confirmphone', 'login', 'iv', 'bg',
]);

function tgSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tgApi(method, params, timeoutMs) {
  const s = await getTgSettings();
  if (!s.token) throw new Error('no-token');
  // Жёсткий таймаут: без него бот «зависал» на минуты при проблемах с сетью.
  // getUpdates сам по себе длинный (20с), ему даём запас.
  const limit = timeoutMs || (method === 'getUpdates' ? 30000 : 12000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), limit);
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${s.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error('network');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error((data.description || 'api-error').slice(0, 200));
  return data.result;
}

async function tgSay(chatId, text, extra) {
  if (!chatId) return;
  try {
    await tgApi('sendMessage', Object.assign({ chat_id: chatId, text }, extra || {}));
  } catch (_) {}
}

// HTML-утилиты для красивых ответов: экранирование, ссылка-в-скобках при отказе parse_mode
function tgEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function tgStripHtml(t) {
  return String(t)
    .replace(/<a\s+(?:[^>]*\s)?href="([^"]*)"[^>]*>(.*?)<\/a>/g, '$2 ($1)')
    .replace(/<\/?\s*(?:b|i|u|s|code|pre|blockquote)>/g, '');
}
// Telegram-ссылка/хэндл → { kind, handle, href, label }. kind:
//  'bot'   — суффикс _bot;
//  'other' — не юзернейм вообще /c/123 (приватка, подписываем по ID), инвайт +xxx, телефон, мусор;
//  null    — похож на юзернейм, но тип надо определить (tgClassifyHandle).
function tgHandleInfo(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: 'other', handle: null, href: '', label: '' };
  const toHref = (u) => (/^https?:\/\//i.test(u) ? u : 'https://' + u.replace(/^\/+/, ''));
  const mc = s.match(/(?:t\.me|telegram\.me)\/c\/(\d+)/i);
  if (mc) return { kind: 'other', handle: null, href: toHref(s), label: 'ID:' + mc[1] };
  const mp = s.match(/(?:t\.me|telegram\.me)\/(\+\d[\d ]*)/i);
  if (mp) return { kind: 'other', handle: null, href: toHref(s), label: mp[1].trim() };
  const m = s.match(/(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{2,31})/i) || s.match(/^@?([A-Za-z][A-Za-z0-9_]{2,31})$/);
  if (!m) return { kind: 'other', handle: null, href: toHref(s), label: s };
  const handle = m[1].toLowerCase();
  const href = 'https://t.me/' + handle;
  if (/_bot$/.test(handle)) return { kind: 'bot', handle, href, label: handle };
  return { kind: null, handle, href, label: handle };
}
// Последняя причина, по которой tgClassifyHandle не смог определить хэндл (null).
// Нужна, чтобы «проверить не удалось» в UI было с конкретным объяснением (403/Cloudflare/
// таймаут/страница без разметки), а не глухой «сеть/лимит t.me».
let tgLastClassifyDiag = '';
// Профильная карточка последнего успешного fetch в tgClassifyHandle: имя и bio с
// превью t.me. Нужна чек-пола: у человека в IG может не быть имени в fullName и
// только латинский ник, но TG-отображаемое имя («Даниил Сорокин») решает исход.
// пишем ТОЛЬКО когда kind==='user' — у каналов имя это название канала, а не человека.
let tgLastProfileCard = { name: '', bio: '' };
// Классификация хэндла по превью t.me: у каналов/групп есть шапка tgme_channel_info,
// у личных аккаунтов — строчка tgme_page_extra с @handle. Результат кэшируется в tgKind профиля.
async function tgClassifyHandle(handle) {
  const h = String(handle || '').toLowerCase();
  tgLastClassifyDiag = '';
  tgLastProfileCard = { name: '', bio: '' };
  if (!h) { tgLastClassifyDiag = 'пустой @юз'; return null; }
  if (/_bot$/.test(h)) return 'bot';
  // Два захода с паузой: под масс-проверкой t.me иногда отвечает 429/5xx или таймаутит,
  // а одна такая волна молча превращала бы целую пачку юзов в «проверить не удалось».
  // Повторяем ТОЛЬКО сетевые сбои/не-200 — страницу, которую не удалось распознать,
  // второй запрос даст такой же результат, крутить её бессмысленно.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 7000);
      // Accept как в браузере: по умолчанию fetch шлёт «*/*», и t.me отдаёт JS-оболочку
      // без серверной разметки tgme_* (отсюда «страница без разметки профиля»). С явным
      // text/html Telegram возвращает классическое превью, которое мы умеем читать.
      const res = await fetch('https://t.me/' + h, { signal: ctrl.signal, headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
      clearTimeout(timer);
      if (!res.ok) {
        tgLastClassifyDiag = 't.me HTTP ' + res.status;
        // 429 = нас режут по частоте. Засвечиваем это в общий риск-стейт (лампочка
        // «Telegram» на шкале дашборда): это не бан аккаунта, но сигнал притормозить.
        if (res.status === 429) { try { const d = await chrome.storage.local.get('igx_risk_state'); const s = (d && d.igx_risk_state && typeof d.igx_risk_state === 'object') ? d.igx_risk_state : {}; s.tgFloodAt = Date.now(); await chrome.storage.local.set({ igx_risk_state: s }); } catch (_) {} }
        await tgSleep(600 + attempt * 900);
        continue;
      }
      const html = await res.text();
      // Побочный продукт того же html: имя/bio для чек-пола. Разделитель tgme_page_title
      // и tgme_page_description ловим так же, как tgProfileCard (везде свой clean —
      // продублирован специально, чтобы не тянуть лишнюю fetch на карточку).
      try {
        const clean = (t) => String(t || '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ').trim();
        const mt = html.match(/tgme_page_title[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)
          || html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
        const md = html.match(/tgme_page_description[^>]*>([\s\S]*?)<\/div>/i)
          || html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
        tgLastProfileCard = { name: clean(mt && mt[1]).slice(0, 120), bio: clean(md && md[1]).slice(0, 400) };
      } catch (_) { tgLastProfileCard = { name: '', bio: '' }; }
      if (/tgme_channel_info/i.test(html)) return 'channel';
      // Несуществующий юзернейм: Telegram отдаёт страницу-зазыв «If you have Telegram,
      // you can contact @... right away» («Если у вас есть Telegram...»). Такой юз НЕ найден —
      // несуществующий юз помечаем отдельным статусом 'none', чтобы не кидать битую ссылку и не показывать в /list.
      if (/If you have Telegram|Если у вас есть Telegram|can contact @|может связаться/i.test(html) && !/tgme_profile_photo|tgme_page_title/i.test(html)) {
        return 'none';
      }
      if (/tgme_page_extra/i.test(html)) return 'user';
      // Страница 200, но ни одна разметка не совпала — это заглушка/челлендж/мягкий
      // лимит t.me: по частоте или по IP режут, отдавая пустую оболочку вместо превью
      // (заголовок пустой, байт мало). Раньше такой stub возвращал null СРАЗУ — без
      // ретрая и без тормоза, и каждый прогон только глубже загонял IP в блок.
      const cfLike = /just a moment|cf-browser-verification|challenge-platform|cloudflare|attention required/i.test(html);
      const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const titleTxt = titleM ? titleM[1].trim().replace(/\s+/g, ' ').slice(0, 60) : '—';
      tgLastClassifyDiag = cfLike
        ? 't.me отдаёт проверку Cloudflare (челлендж вместо превью — анонимный fetch не проходит; включите режим «t.me + web-сессия» и залогиньтесь в web.telegram.org)'
        : 't.me вернул страницу без разметки профиля (title="' + titleTxt + '", ' + html.length + ' байт) — мягкий лимит/заглушка по IP; включите «t.me + web-сессия»';
      // Подсветить флуд на шкале риска (тот же сигнал, что и для 429) и дать ПОВТОР
      // с бо́льшим откатом: одиночный stub чаще всего проходит со второго захода.
      try { const d = await chrome.storage.local.get('igx_risk_state'); const s = (d && d.igx_risk_state && typeof d.igx_risk_state === 'object') ? d.igx_risk_state : {}; s.tgFloodAt = Date.now(); await chrome.storage.local.set({ igx_risk_state: s }); } catch (_) {}
      if (attempt + 1 < 2) { await tgSleep(1600 + attempt * 1600); continue; }
      return null;
    } catch (e) {
      tgLastClassifyDiag = 't.me запрос упал: ' + (e && e.name === 'AbortError' ? 'таймаут 7с' : String((e && (e.name || e.message)) || e || 'сеть'));
      await tgSleep(600 + attempt * 900); // сеть/таймаут — ещё попытка
    }
  }
  return null;
}
// Карточка TG-профиля со страницы t.me/<handle>: отображаемое имя, @юз, описание,
// для канала — ещё подписчики. Нужна разборам: экспертная ИИшка обращается к лиду
// по транслиту IG-ника («Dansor» → «дансор»), а настоящее имя в ТГ — «Даниил Сорокин».
// Только чтение: никто ничего не решает и не пишет.
async function tgProfileCard(handle) {
  const h = String(handle || '').toLowerCase();
  if (!h) return null;
  const clean = (t) => String(t || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    const res = await fetch('https://t.me/' + h, { signal: ctrl.signal, headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    const info = { handle: h, kind: null, name: '', user: '', bio: '', subscribers: '' };
    // Несуществующий юз: та же страница-зазыв, что ловит tgClassifyHandle.
    if (/If you have Telegram|Если у вас есть Telegram|can contact @|может связаться/i.test(html) && !/tgme_profile_photo|tgme_page_title/i.test(html)) {
      info.kind = 'none';
      return info;
    }
    const mt = html.match(/tgme_page_title[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i) || html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    const mx = html.match(/tgme_page_extra[^>]*>([\s\S]*?)<\/div>/i);
    const md = html.match(/tgme_page_description[^>]*>([\s\S]*?)<\/div>/i)
      || html.match(/tgme_channel_info_description[^>]*>([\s\S]*?)<\/div>/i)
      || html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
    info.name = clean(mt && mt[1]).slice(0, 120);
    info.user = clean(mx && mx[1]).replace(/^@/, '').slice(0, 40);
    info.bio = clean(md && md[1]).slice(0, 400);
    const mc = html.match(/tgme_channel_info/i);
    if (/_bot$/i.test(info.user || h)) info.kind = 'bot';
    else if (mc) info.kind = 'channel';
    else if (mx || info.user) info.kind = 'user';
    if (mc) {
      const ms = html.match(/counter_value[^>]*>([\s\S]*?)<\/span>[\s\S]*?counter_type[^>]*>([\s\S]*?)<\/span>/i);
      if (ms) info.subscribers = (clean(ms[1]) + ' ' + clean(ms[2])).slice(0, 40);
    }
    if (!info.name && !info.user && !info.bio) return null; // разметка поехала — честный null
    return info;
  } catch (_) {
    return null;
  }
}
// Для вывода в сообщениях: {href, label} (ссылка спрятана за текстом; не юз — по айди).
function tgPretty(raw) {
  const i = tgHandleInfo(raw);
  if (!i.href) return null;
  return { href: i.href, label: i.label };
}
async function tgSayHtml(chatId, html, extra) {
  if (!chatId) return;
  try {
    await tgApi('sendMessage', Object.assign({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }, extra || {}));
  } catch (_) {
    // фолбэком терялась клавиатура: пробрасываем те же extra, иначе кнопки «исчезнут»
    await tgSay(chatId, tgStripHtml(html), extra);
  }
}

// Реестр всех чатов, которые бот когда-либо видел. getUpdates съедается поллингом
// (offset уползает), поэтому юзернейм->chat_id сохраняем здесь, чтобы кнопка
// «Привязать» могла найти получателя даже после того, как апдейт уже обработан.
const TG_CHATS_KEY = 'igx_tg_chats';
async function tgRememberChat(from, chat) {
  try {
    if (!chat || chat.id == null) return;
    const data = await chrome.storage.local.get(TG_CHATS_KEY);
    const map = data[TG_CHATS_KEY] || {};
    const uname = (from && from.username) || chat.username || null;
    map[String(chat.id)] = {
      chatId: chat.id,
      username: uname,
      title: chat.title || [from && from.first_name, from && from.last_name].filter(Boolean).join(' ') || '',
      ts: Date.now(),
    };
    // чистим записи старше 180 дней
    for (const k of Object.keys(map)) {
      if (Date.now() - (map[k] && map[k].ts ? map[k].ts : 0) > 180 * 24 * 3600 * 1000) delete map[k];
    }
    await chrome.storage.local.set({ [TG_CHATS_KEY]: map });
  } catch (_) {}
}

// Превращает введённый юзернейм / числовой chat_id в рабочий chat_id.
// Числовой ID принимаем как есть; по юзернейму ищем в реестре виденных чатов,
// а если там нет — последний шанс: свежий getUpdates (переписка есть, но реестр пуст).
async function tgResolveChat(query) {
  const qRaw = String(query || '').trim();
  const q = qRaw.replace(/^@/, '').toLowerCase();
  if (!q) return { ok: false, error: 'не заполнено поле получателя' };
  if (/^-?\d{3,}$/.test(qRaw)) return { ok: true, chatId: Number(qRaw) };
  try {
    const data = await chrome.storage.local.get(TG_CHATS_KEY);
    const map = data[TG_CHATS_KEY] || {};
    for (const k of Object.keys(map)) {
      const rec = map[k];
      if (rec && rec.username && String(rec.username).toLowerCase() === q) {
        return { ok: true, chatId: rec.chatId };
      }
    }
  } catch (_) {}
  try {
    const updates = await tgApi('getUpdates', { timeout: 0, allowed_updates: ['message', 'callback_query', 'my_chat_member', 'inline_query', 'edited_message'] }, 12000);
    for (const u of updates || []) {
      const from = (u.message && u.message.from) || (u.edited_message && u.edited_message.from) || (u.callback_query && u.callback_query.from) || (u.my_chat_member && u.my_chat_member.from) || (u.inline_query && u.inline_query.from);
      const chat = (u.message && u.message.chat) || (u.edited_message && u.edited_message.chat) || (u.callback_query && u.callback_query.message && u.callback_query.message.chat) || (u.my_chat_member && u.my_chat_member.chat);
      if (from && String(from.username || '').toLowerCase() === q && chat && chat.id != null) {
        await tgRememberChat(from, chat);
        return { ok: true, chatId: chat.id };
      }
    }
  } catch (_) {}
  return { ok: false, error: `Переписки с @${q} у бота не найдено. Пусть этот юзер напишет боту /start, затем повтори привязку.` };
}

// Юзернейм бота (кэшируем, чтобы открывать чат с ним в приложении ТГ)
let tgBotUsernameCache = null;
async function tgBotUsername() {
  if (tgBotUsernameCache) return tgBotUsernameCache;
  try {
    const data = await chrome.storage.local.get('igx_tg_botname');
    if (data.igx_tg_botname) {
      tgBotUsernameCache = data.igx_tg_botname;
      return tgBotUsernameCache;
    }
    const me = await tgApi('getMe', {});
    tgBotUsernameCache = me.username;
    await chrome.storage.local.set({ igx_tg_botname: me.username });
    return me.username;
  } catch (_) {
    return null;
  }
}

// Открыть чат в приложении Телеграм через протокол tg://.
// force=true — открыть по явному клику пользователя всегда; иначе действует глобальный выключатель.
async function tgOpenApp(domain, force) {
  const d = String(domain || '').replace(/^[@+]/, '');
  if (!d) return false;
  if (!force) {
    // Центральный рубильник: если автооткрытие выключено — автоматом ТГ не дёргаем вообще.
    const flag = await chrome.storage.local.get('igx_auto_open_tg');
    if (flag.igx_auto_open_tg === false) return false;
  }
  try {
    const tab = await chrome.tabs.create({ url: `tg://resolve?domain=${encodeURIComponent(d)}`, active: true });
    // вкладка-пустышка с протоколом не нужна — прикрываем через пару секунд
    setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 4000);
    return true;
  } catch (_) {
    return false;
  }
}

async function getTgSettings() {
  const data = await chrome.storage.local.get(TG_SETTINGS_KEY);
  const s = Object.assign({}, TG_DEFAULT_SETTINGS, data[TG_SETTINGS_KEY] || {});
  if (s.safeMode) {
    s.msgLimit = TG_SAFE.msgLimit;
    s.delaySec = TG_SAFE.delaySec;
  }
  return s;
}

async function saveTgSettings(patch) {
  const data = await chrome.storage.local.get(TG_SETTINGS_KEY);
  const next = Object.assign({}, TG_DEFAULT_SETTINGS, data[TG_SETTINGS_KEY] || {}, patch);
  await chrome.storage.local.set({ [TG_SETTINGS_KEY]: next });
  return next;
}

// ---------- извлечение контактов из текста ----------
function tgExtractFromText(text, out, selfName) {
  if (!text) return;
  const low = (selfName || '').toLowerCase();
  for (const m of text.matchAll(/@([A-Za-z0-9_]{3,32})/g)) {
    const u = m[1].toLowerCase();
    if (TG_RESERVED_USERS.has(u) || u === low) continue;
    out.users.add(u);
  }
  for (const m of text.matchAll(/(?:t\.me|telegram\.me)\/\+([A-Za-z0-9_-]{4,64})/g)) {
    out.invites.add('+' + m[1]);
  }
  for (const m of text.matchAll(/instagram\.com\/([A-Za-z0-9._]{1,30})/gi)) {
    const u = m[1].toLowerCase();
    if (TG_RESERVED_USERS.has(u)) continue;
    out.instagram.add(u);
  }
  for (const m of text.matchAll(/(?:inst|ig|инст|инстаграм)[\s:—–-]+@?([A-Za-z0-9._]{2,30})/gi)) {
    const u = m[1].toLowerCase().replace(/[.,]+$/, '');
    if (!u || TG_RESERVED_USERS.has(u)) continue;
    out.instagram.add(u);
  }
}

function htmlToDoc(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

// ---------- проверка через Bot API (api.telegram.org) ----------
// Единственный путь, который гарантированно работает даже когда t.me в браузере
// заблокирован: бот и так через api.telegram.org общается. Ограничения:
//  - getChat видит публичные каналы/группы (тип, название, описание, счётчики);
//  - личку видит только если юз уже писал боту (иначе «неизвестно», но ссылку даём);
//  - посты канала без админки бота прочитать нельзя — читаем описание.
async function tgApiCheck(target) {
  const t = String(target || '').replace(/^[@+]/, '');
  if (!t || /^\+/.test(target)) return null;
  const out = { users: new Set(), invites: new Set(), instagram: new Set() };
  let chat;
  try {
    chat = await tgApi('getChat', { chat_id: '@' + t });
  } catch (_) {
    return null; // «chat not found» / личка не писала боту — не можем подтвердить/опровергнуть
  }
  if (!chat) return null;
  if (chat.type === 'channel' || chat.type === 'supergroup' || chat.type === 'group') {
    tgExtractFromText(chat.description || '', out, t);
    const members = chat.participant_count != null ? `${chat.participant_count} подписчиков` : '';
    return {
      ok: true,
      exists: true,
      isChannel: true,
      title: chat.title || t,
      members,
      desc: chat.description || '',
      postsRead: 0,
      viaApi: true,
      out,
    };
  }
  // type === 'private' -> это личный аккаунт, сам юз и есть личка.
  // (getChat отдаёт личку только если она писала боту, но раз отдал — значит существует)
  return { ok: true, exists: true, isChannel: false, title: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || t, viaApi: true, out };
}

// Быстрая классификация ссылки через Bot API: 'personal' | 'channel' | null.
async function tgClassify(target) {
  const r = await tgApiCheck(target);
  if (!r || !r.ok) return null;
  return r.isChannel ? 'channel' : 'personal';
}

// ---------- режим "сайт": t.me превью + публичные посты /s/ ----------
// Скан идёт fetch'ем ИЗНУТРИ фоновой вкладки, которая припаркована на главной t.me:
//  - трафик идёт через браузерный стек (через браузерные VPN/прокси), а не из SW;
//  - страницы НЕ открываются на виду — нет навигации, нет автозапуска приложения ТГ (tg://).
// Вкладка сворачивается в скрытую группу, чтобы не мозолить глаза.
const TG_SCAN_TAB_KEY = 'igx_tg_scan_tab';

// Ждём, пока DOM вкладки станет читаемым. ВАЖНО: не ждём tab.status==='complete' —
// Хром троттлит фоновые вкладки, и 'complete' может не наступать долго.
// executeScript работает уже на 'interactive', поэтому проверяем readyState напрямую.
// expectedPath — путь НОВОЙ страницы: иначе первый полл вернёт DOM предыдущей.
async function tgTabDomReady(tabId, timeoutMs, expectedPath) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 15000)) {
    await tgSleep(250);
    let st = null;
    try {
      const res = await chrome.scripting.executeScript({
        tabId,
        func: () => ({ rs: document.readyState, path: location.pathname }),
      });
      st = res && res[0] ? res[0].result : null;
    } catch (_) {}
    if (st && st.rs !== 'loading' && (!expectedPath || st.path === expectedPath)) return true;
  }
  return false;
}

async function tgWaitScanTabLoaded(tabId) {
  return tgTabDomReady(tabId, 9000, '/');
}

async function tgGetScanTab() {
  const data = await chrome.storage.session.get(TG_SCAN_TAB_KEY);
  const info = data[TG_SCAN_TAB_KEY];
  if (info) {
    try {
      const t = await chrome.tabs.get(info.id);
      // Вкладка жива — переиспользуем её, НИКОГДА не плодим вторую.
      if (t.discarded) {
        // уснула (экономия памяти) — будим на месте
        await chrome.tabs.reload(info.id).catch(() => {});
        await tgWaitScanTabLoaded(info.id);
      } else if (!/^https:\/\/t\.me\//.test(t.url || '')) {
        // ушла с t.me (страница ошибки сети и т.п.) — возвращаем на место на месте же
        await chrome.tabs.update(info.id, { url: 'https://t.me/' }).catch(() => {});
        await tgWaitScanTabLoaded(info.id);
      }
      return info.id;
    } catch (_) {}
  }
  // Вкладки совсем нет — создаём единственную.
  const tab = await chrome.tabs.create({ url: 'https://t.me/', active: false });
  try {
    const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { collapsed: true, title: 'IGX скан' });
  } catch (_) {}
  await tgWaitScanTabLoaded(tab.id);
  await chrome.storage.session.set({ [TG_SCAN_TAB_KEY]: { id: tab.id } });
  return tab.id;
}

// Навигация вкладки скана на страницу и ожидание читаемого DOM (таймаут 15с).
async function tgNavigateScanTab(tabId, url, timeoutMs) {
  const path = '/' + String(url).replace(/^https?:\/\/t\.me\//i, '').split('?')[0];
  await chrome.tabs.update(tabId, { url });
  return tgTabDomReady(tabId, timeoutMs || 15000, path);
}

// Читает ЖИВОЙ DOM страницы t.me/s/: шапка канала (имя/счётчик/описание) + посты.
// Страницы /s/ не дёргают tg:// — приложение ТГ во время скана не открывается.
// У личного аккаунта шапки канала нет — по этому и отличаем личку от канала.
function tgTabScanFn(limit) {
  const q = (sel) => document.querySelector(sel);
  const info = q('.tgme_channel_info');
  const titleEl = q('.tgme_channel_info_header_title');
  const counters = Array.from(document.querySelectorAll('.tgme_channel_info_counter'))
    .map((e) => e.textContent)
    .join(' ')
    .trim();
  const descEl = q('.tgme_channel_info_description');
  const posts = [];
  for (const el of document.querySelectorAll('.tgme_widget_message_text')) {
    posts.push(el.textContent);
    if (posts.length >= limit) break;
  }
  const ids = Array.from(document.querySelectorAll('.tgme_widget_message')).map((el) => el.getAttribute('data-post'));
  return {
    isChannel: !!info,
    title: titleEl ? titleEl.textContent.trim() : '',
    members: counters,
    desc: descEl ? descEl.textContent : '',
    posts,
    oldest: ids.length ? ids[ids.length - 1] : null,
  };
}

async function tgExtractScanTab(tabId, limit) {
  const res = await chrome.scripting.executeScript({
    tabId,
    func: tgTabScanFn,
    args: [limit || 50],
  });
  return res && res[0] ? res[0].result : null;
}

// quick=true — только первая страница (классификация канал/личка + описание).
async function tgScanSite(target, settings, quick) {
  const out = { users: new Set(), invites: new Set(), instagram: new Set() };
  const isInvite = /^\+/.test(target);
  const name = isInvite ? '' : target.toLowerCase();

  if (isInvite) {
    // Инвайт-ссылки без аккаунта не просматриваются
    return { ok: true, exists: null, privateOnly: true, out };
  }

  let tabId;
  try {
    tabId = await tgGetScanTab();
  } catch (_) {
    return { ok: false, error: 'Не удалось открыть вкладку для скана.' };
  }

  // Лента t.me/s/<name>: шапка канала + посты. Не дёргает tg://.
  let meta = null;
  let before = '';
  let collected = 0;
  let pages = 0;
  const maxPages = quick ? 1 : 6;
  while (pages < maxPages && collected < settings.msgLimit) {
    if (!(await tgNavigateScanTab(tabId, `https://t.me/s/${target}${before}`))) {
      if (pages === 0) return { ok: false, error: 't.me/s не открылся в браузере (сеть/блокировка/таймаут). Проверь, открывается ли сайт вручную.' };
      break;
    }
    let d = null;
    try {
      d = await tgExtractScanTab(tabId, settings.msgLimit - collected + 30);
    } catch (_) {}
    if (!d) {
      if (pages === 0) return { ok: false, error: 'Страница t.me/s открылась, но DOM не читается.' };
      break;
    }
    if (pages === 0) meta = d;
    if (!d.posts.length) break;
    for (const txt of d.posts) {
      if (collected >= settings.msgLimit) break;
      collected++;
      tgExtractFromText(txt, out, name);
    }
    pages++;
    if (!d.oldest || collected >= settings.msgLimit) break;
    before = `?before=${String(d.oldest).split('/').pop()}`;
    await tgSleep(400 + Math.random() * 500); // щадящие паузы между страницами
  }
  if (!meta) return { ok: false, error: 't.me/s не открылся (сеть/блокировка). Проверь вручную.' };

  if (meta.title) tgExtractFromText('@' + meta.title, out, name);
  tgExtractFromText(meta.desc, out, name);
  tgExtractFromText(meta.members, out, name);

  return {
    ok: true,
    // У личного аккаунта на /s/ шапки канала нет — существование не подтверждаем (null).
    exists: meta.isChannel || collected > 0 ? true : null,
    // Канал или ЛИЧКА: у каналов на /s/ есть шапка с именем и счётчиком, у лички — пусто.
    isChannel: meta.isChannel || collected > 0,
    title: meta.title || target,
    members: meta.members,
    postsRead: collected,
    out,
  };
}

// ---------- режим "тг": сканирование через web.telegram.org ----------
async function tgGetWebTab() {
  const data = await chrome.storage.session.get(TG_TAB_KEY);
  const info = data[TG_TAB_KEY];
  if (info && Date.now() - info.ts < 15 * 60 * 1000) {
    try {
      await chrome.tabs.get(info.id);
      return info.id;
    } catch (_) {}
  }
  const tab = await chrome.tabs.create({ url: 'https://web.telegram.org/a/', active: false });
  await chrome.storage.session.set({ [TG_TAB_KEY]: { id: tab.id, ts: Date.now() } });
  return tab.id;
}

async function tgScanFull(target, settings, onProgress) {
  const tabId = await tgGetWebTab();
  const send = (m) => chrome.tabs.sendMessage(tabId, m).catch(() => null);

  // Даем вкладке прогрузиться / залогиниться (не дольше 20 сек — бот не должен молчать)
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await tgSleep(1000);
    const r = await send({ type: 'tgPing' });
    if (r && r.ready) { ready = true; break; }
    if (r && r.needsLogin) return { ok: false, error: 'web.telegram.org не залогинен. Открой вкладку, войди в аккаунт и повтори.' };
  }
  if (!ready) return { ok: false, error: 'web.telegram.org не отвечает. Перезагрузи вкладку с телеграмом.' };

  if (onProgress) onProgress('Открываю чат…');
  await send({ type: 'tgScan', target, msgLimit: settings.msgLimit, delayMs: settings.delaySec * 1000 });

  for (let i = 0; i < 90; i++) {
    await tgSleep(1000);
    const r = await send({ type: 'tgGetResult' });
    if (!r) return { ok: false, error: 'Вкладка телеграма закрылась во время сканирования.' };
    if (r.progress && onProgress) onProgress(r.progress);
    if (r.done) {
      if (r.error) return { ok: false, error: r.error };
      const out = { users: new Set(r.users || []), invites: new Set(r.invites || []), instagram: new Set(r.instagram || []) };
      return { ok: true, exists: true, title: r.title || target, postsRead: r.postsRead || 0, out };
    }
  }
  return { ok: false, error: 'Таймаут сканирования в web.telegram.org.' };
}

// ---------- верификация юза (быстрая, для значков) ----------
async function tgVerify(username) {
  // Сначала ТОЛЬКО Bot API (api.telegram.org) — никаких вкладок.
  try {
    const r = await tgApiCheck(username);
    // isChannel важен профилю: канал — НЕ «реальный юз» (для /list tg кэш tgKind).
    if (r && r.ok) {
      const isChannel = typeof r.isChannel === 'boolean' ? r.isChannel : undefined;
      // Бот видит личку ТОЛЬКО если юзер сам ему писал, — тогда это железное
      // доказательство. Тип нераспознанным не превращаем в «человек».
      const verdict = isChannel === false
        ? { real: true, via: 'api', kind: 'user', why: '' }
        : isChannel === true
          ? { real: false, via: 'api', kind: 'channel', why: 'это канал/группа, а не человек' }
          : { real: 'unknown', via: 'api', kind: '', why: 'Bot API ответил, но тип не различил' };
      return { exists: true, isChannel, verdict, real: verdict.real };
    }
  } catch (_) {}
  // Bot API личку не видит (и «chat not found» у мёртвых юзов тоже тут) —
  // дешёвый превью t.me через fetch в воркере: JS страницы не выполняется,
  // tg:// не дёргается, приложение не открывается (в этом была причина запрета
  // браузерных проверок раньше — теперь проверено, путь безопасен).
  try {
    const info = tgHandleInfo(username);
    if (info.handle) {
      const k = await tgClassifyHandle(info.handle);
      if (k === 'none') return { exists: false, dead: true, kind: 'none', verdict: tgRealFromKind('none', 'tme'), real: false };
      if (k === 'user' || k === 'bot' || k === 'channel') {
        const verdict = tgRealFromKind(k, 'tme');
        return { exists: true, isChannel: k === 'channel', kind: k, verdict, real: verdict.real };
      }
    }
  } catch (_) {}
  return { exists: null, verdict: tgRealFromKind(null, '') }; // подтвердить не смогли — статус не ломаем
}

// ---------- поиск аккаунта в web.telegram.org (по номеру / по @нику) ----------
// Универсальный оркестратор: переиспользует вкладку tgGetWebTab(), кидает tgSearch
// в tg-web.js и опрашивает tgSearchResult. Возвращает { ok, handle, id, title }.
async function tgWebSearch(query) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'пустой запрос' };
  const tabId = await tgGetWebTab();
  const send = (m) => chrome.tabs.sendMessage(tabId, m).catch(() => null);

  let ready = false;
  for (let i = 0; i < 20; i++) {
    await tgSleep(1000);
    const r = await send({ type: 'tgPing' });
    if (r && r.ready) { ready = true; break; }
    if (r && r.needsLogin) return { ok: false, error: 'web.telegram.org не залогинен (нужен режим 📱 ТГ).' };
  }
  if (!ready) return { ok: false, error: 'web.telegram.org не отвечает.' };

  await send({ type: 'tgSearch', query: q });
  for (let i = 0; i < 30; i++) {
    await tgSleep(1000);
    const r = await send({ type: 'tgSearchResult' });
    if (!r) return { ok: false, error: 'Вкладка телеграма закрылась во время поиска.' };
    if (r.done) {
      if (!r.handle && !r.id) return { ok: true, handle: null, id: null, title: r.title || '', match: false, error: r.error || null };
      return { ok: true, handle: r.handle || null, id: r.id || null, title: r.title || '', match: !!r.match };
    }
  }
  return { ok: false, error: 'Таймаут поиска в web.telegram.org.' };
}

// Тип найденного хэндла: превью t.me, по умолчанию 'user' (по номеру ищутся люди).
async function tgResolveKind(handle) {
  try {
    const c = await tgClassifyHandle(handle);
    if (c === 'bot' || c === 'channel' || c === 'user' || c === 'none') return c;
  } catch (_) {}
  return 'user';
}

// Скрап «своего» сайта/таплинка профиля (idea 4): вытаскиваем опубликованные там
// телефоны, WA-номера и tg-хендлы. Один заход, таймаут, fail-open (пусто при сбое).
async function tgProbeSite(url) {
  const empty = { ok: false, phones: [], waNumbers: [], tgCandidates: [] };
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return empty;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    const res = await fetch(u, { signal: ctrl.signal, redirect: 'follow', headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' } });
    clearTimeout(timer);
    if (!res.ok) return { ok: true, phones: [], waNumbers: [], tgCandidates: [] };
    const html = await res.text();
    const phones = [];
    const waNumbers = [];
    const tgCandidates = [];
    const P_RE = /(?:\+?[78]|380|998|996|992)[\s\-()]*(?:\(?\d{3}\)?)[\s\-()]*\d{3}[\s\-()]*\d{2}[\s\-()]*\d{2}/g;
    for (const m of html.matchAll(P_RE)) {
      let d = m[0].replace(/\D/g, '');
      if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
      if (d.length >= 10 && d.length <= 15 && isPlausiblePhone(d) && !phones.includes('+' + d)) phones.push('+' + d);
    }
    for (const m of html.matchAll(/wa\.me\/(\d{7,15})|[?&]phone=(\+?\d{7,15})/gi)) {
      const d = (m[1] || m[2] || '').replace(/\D/g, '');
      if (d && isPlausiblePhone(d) && !waNumbers.includes(d)) waNumbers.push(d);
    }
    const TG_RE2 = /(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,32})/gi;
    // Страницу читаем целиком, а там всегда есть чужие линки (подвал, партнёрка,
    // «создано в taplink», реклама). Один и тот же юз на тысячах чужих страниц —
    // будущий «захватчик» базы, поэтому кандидатом считаем только личный юз, не
    // засвеченный нигде в базе как общий.
    try { await tgRefreshSpam(); } catch (_) {}
    for (const m of html.matchAll(TG_RE2)) {
      const h = m[1].toLowerCase();
      if (isGarbageTgHandle(h) || isTgSpamHandle(h)) continue;
      if (!tgCandidates.includes(h)) tgCandidates.push(h);
    }
    return { ok: true, phones, waNumbers, tgCandidates: tgCandidates.slice(0, 5) };
  } catch (_) {
    return { ok: true, phones: [], waNumbers: [], tgCandidates: [] };
  }
}

// Номер телефона -> реальный @юз. Возвращает формат, который ждёт content.js:
// { ok, found, telegram, tgKind }. Публичного @юза нет — found:false (кинуть ссылку нельзя).
async function tgResolvePhone(phone) {
  if (!isPlausiblePhone(phone)) return { ok: true, found: false };
  const r = await tgWebSearch(phone);
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.handle) return { ok: true, found: false };
  // КЛЮЧЕВОЙ ГЕЙТ: глобальный поиск web.telegram.org по номеру часто ставит сверху
  // случайный «глобальный» аккаунт с коротким премиум-юзом (@chat, @LIDERADD и т.п.),
  // а не владельца номера. tg-web сверяет, показаны ли цифры номера в результате;
  // без доказательства соответствия — не приписываем лиду чужой юз.
  if (r.match !== true) return { ok: true, found: false };
  const kind = await tgResolveKind(r.handle);
  // Глобальный поиск web.telegram.org по номеру может вернуть НЕ владельца номера,
  // а канал/группу/бота, где этот номер где-то упомянут (были случаи: приписывало
  // чужой канал вроде @moshenniki...). Номеру может принадлежать только живой юзер —
  // канал/бота/несуществующий юз контактом не считаем.
  if (kind !== 'user') return { ok: true, found: false };
  return { ok: true, found: true, telegram: `https://t.me/${r.handle}`, tgKind: 'user' };
}

// ================= РЕМОНТ БАЗЫ: перепроверка TG, полученного ПО НОМЕРУ =================
// Голый юз из ссылки 'https://t.me/<h>' (или 't.me/<h>?text=…') → '<h>'; не юзерпейдж
// (share/s/joinchat/…) — ''. Держим в так с валидатором content.js: тот же фильтр мусора.
function tgHandleFromUrl(u) {
  const m = String(u || '').match(/(?:t\.me|telegram\.me)\/([A-Za-z0-9_]+)/i);
  if (!m) return '';
  return m[1];
}
// Мусорные/служебные TG-юзы: пути t.me, которые не являются профилем, и частые
// спам/рекламные слова (@chat, @adfire, @chat123…). Копия того же списка из content.js —
// продублировано намеренно: контент-скрипт и фон — разные контексты, общего импорта нет.
const TG_RESERVED = new Set(['share', 's', 'joinchat', 'join', 'addstickers', 'addsticker', 'addlist', 'addtheme', 'addchain', 'addemoji', 'addaudio', 'addcolor', 'addmessage', 'proxy', 'iv', 'login', 'setlanguage', 'confirmphone', 'boost', 'gift', 'gifts', 'stories', 'profile', 'telegram', 'tg', 'me', 'app', 'desktop', 'macos', 'web', 'webk', 'contact', 'contacts', 'recent', 'saved', 'favorites', 'channels', 'groups', 'bot', 'telegramorg', 'ct', 'startapp', 'deep', 'deeplink', 'link', 'linkresolver', 'm', 'c', 'post', 'user', 'addcomment', 'addreaction', 'bg', 'savegas', 'invoice', 'wallet', 'business', 'verify', 'domain']);
const TG_GENERIC = new Set(['chat', 'chats', 'adfire', 'ad', 'ads', 'adv', 'promo', 'spam', 'free', 'sex', 'xxx', 'hot', 'vpn', 'casino', 'win', 'wining', 'lotery', 'lottery', 'crypto', 'bitcoin', 'binance', 'market', 'shop', 'store', 'support', 'help', 'admin', 'manager', 'info', 'office', 'team', 'staff', 'service', 'news', 'media', 'tv', 'club', 'game', 'games', 'giveaway', 'airdrop', 'nft', 'token', 'job', 'jobs', 'work', 'money', 'order', 'menu', 'buy', 'sale', 'call', 'sms', 'code', 'test', 'demo', 'example']);
function isGarbageTgHandle(h) {
  const x = String(h || '').toLowerCase().replace(/^@/, '').trim();
  if (!x || x.length < 4) return true;
  if (TG_RESERVED.has(x) || TG_GENERIC.has(x)) return true;
  if (/^(chat|chats|ad|ads|promo|free|hot|sex|xxx|vpn|casino|bot)[-_]?\d{0,4}$/.test(x)) return true;
  // Хвост «<спам-токен><цифры>» с любым префиксом (nexwire_bot80, my_chat12): копия правила из content.js.
  if (/(?:^|[-_.])(chat|chats|ad|ads|adv|promo|spam|vpn|casino|bot)[_.-]?\d{1,5}$/.test(x)) return true;
  return false;
}

// «Похож ли набор цифр на реальный номер», а не на счётчик/id/технические
// последовательности со страницы. Копия правила из content.js (контексты не шарят импорты).
const PHONE_REGION_FIRST = { '7': '34789', '380': '345679', '996': '23579', '998': '6789', '992': '4589' };
function isPlausiblePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length < 10 || d.length > 15) return false;
  if (/(\d)\1{4,}/.test(d)) return false;
  for (const cc of Object.keys(PHONE_REGION_FIRST)) {
    if (d.startsWith(cc)) { const nx = d[cc.length]; return nx != null && PHONE_REGION_FIRST[cc].includes(nx); }
  }
  return true;
}
// Ссылка/ник Instagram -> чистый lowercase-хендл. Срез /url.php?u и instagram.com/<x>/,
// запрет ведущей/хвостовой точки и '..' (точки есть в IG, но запрещены в ТГ).
function normalizeIg(raw) {
  let v = String(raw || '').trim();
  const m = v.match(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)\/.*/i);
  if (m) v = m[1];
  v = v.replace(/^@/, '').trim().toLowerCase();
  if (!v || v.startsWith('.') || v.endsWith('.') || v.includes('..')) return null;
  return /^[a-z0-9._]{1,30}$/.test(v) ? v : null;
}

// Единый гейт контакта (idea 1/2) — ЗЕРКАЛО хелпера из dashboard.js: фильтр /list
// живёт в фоне и не может импортировать дашборд, поэтому та же логика продублирована.
//
// «ЮЗ-ЗАХВАТЧИК» (зеркало dashboard.js): один TG-юз на множестве РАЗНЫХ IG-профилей —
// физически не личный контакт, а чужая ссылка (реклама/подвал таплинка, параша из
// поиска по номеру). По имени такой юз неотличим от лички, поэтому статический
// isGarbageTgHandle его не видит — ловим частотой появления по базе.
const TG_SPAM_MIN_PROFILES = 5;
let _tgSpamHandles = new Set();
function tgSpamHandleSet(all) {
  const owners = new Map();
  for (const k of Object.keys(all)) {
    if (!k.startsWith('igx_profile:')) continue;
    const p = all[k];
    if (!p || typeof p !== 'object') continue;
    const u = String(p.username || k.slice('igx_profile:'.length)).toLowerCase();
    const links = new Set();
    const h = p.telegram ? tgHandleFromUrl(p.telegram) : '';
    if (h) links.add(h.toLowerCase());
    if (Array.isArray(p.tgContacts)) {
      for (const c of p.tgContacts) { if (c && c.handle) links.add(String(c.handle).toLowerCase()); }
    }
    for (const hh of links) {
      if (!hh || isGarbageTgHandle(hh)) continue;
      if (!owners.has(hh)) owners.set(hh, new Set());
      owners.get(hh).add(u);
    }
  }
  const bad = new Set();
  for (const [hh, set] of owners) { if (set.size >= TG_SPAM_MIN_PROFILES) bad.add(hh); }
  return bad;
}
async function tgRefreshSpam() {
  try { _tgSpamHandles = tgSpamHandleSet(await chrome.storage.local.get(null)); } catch (_) {}
}
function isTgSpamHandle(h) { const x = String(h || '').toLowerCase(); return !!x && _tgSpamHandles.has(x); }
function tgContactIsSpam(p) {
  const best = tgPickBestContact(p);
  if (best && isTgSpamHandle(best.handle)) return true;
  const cur = p && p.telegram ? tgHandleFromUrl(p.telegram) : '';
  return !!cur && isTgSpamHandle(cur);
}
function tgPickBestContact(p) {
  const RANK = { published: 2, unverified: 1 };
  const list = Array.isArray(p.tgContacts) && p.tgContacts.length ? p.tgContacts : null;
  if (list) {
    let best = null;
    for (const c of list) { if (!c || !c.handle) continue; if (!best || (RANK[c.confidence] || 0) > (RANK[best.confidence] || 0)) best = c; }
    return best;
  }
  if (!p.telegram) return null;
  const guessed = !!p.tgFromHandle;
  return { handle: '', source: guessed ? 'nick_guess' : 'bio', confidence: 'unverified', corroborated: guessed ? (p.tgSpeculative !== true) : true };
}
function tgContactTier(p) {
  const best = tgPickBestContact(p);
  if (!best) return 0;
  const guessed = best.source === 'nick_guess';
  const nameOk = best.corroborated === true;
  if (!guessed) return nameOk ? 1 : 2;
  return nameOk ? 3 : 0;
}
function tgGateContact(p) {
  // Захватчик отсекается до tier и в любом режиме: «юз существует» ≠ «юз этого человека».
  if (tgContactIsSpam(p)) return { tier: 0, canUse: false, reason: 'TG-юз приписан многим профилям (захватчик/реклама)' };
  const tier = tgContactTier(p);
  if (tier === 0) return { tier, canUse: false, reason: 'ник угадан вслепую' };
  if (tier === 3) return { tier, canUse: (p.tgKind === 'user' && p.tgReal === true), reason: 'Tier3 требует доказанной лички' };
  return { tier, canUse: true, reason: 'ok' };
}

// Раньше глобальный поиск web.telegram.org по номеру приписывал лидам случайные
// премиум-юзы (@chat, @LIDERADD и т.п.). Резолвер теперь строгий; этот проход берёт
// ОДИН профиль, у которого TG пришёл именно из поиска по номеру (tgPhoneResolved==='user'),
// и гоняет tgResolvePhone заново: доказанный владелец номера остаётся/чинится, параша
// стирается. Поиск, который НЕ удалось выполнить (нет web-сессии/вкладки/таймаут),
// профиль НЕ трогает — чтобы не посносить годные ссылки из-за технических проблем.
// Единая безопасная запись профиля из ЧИСТКИ. Между чтением rec и записью всегда стоит
// долгий await сети (tgResolvePhone/tgClassifyHandle) — за это время автоанализ/ревизия могли
// обновить ту же запись, и set по СТАРОМУ снимку затёр бы их (потерянного обновления).
// Поэтому перечитываем профиль СВЕЖИМ прямо перед set и мержим патч поверх свежего; и НЕ
// трогаем профиль, если он успел стать доказанно живым (tgReal===true). Возвращает merged либо
// вердикт-объект {skipped}/{kept,proven} — вызывающий различает их по наличию этих полей.
async function tgCleaningWrite(profileKey, staleRec, patch) {
  let fresh = staleRec;
  try { const d = await chrome.storage.local.get(profileKey); if (d && d[profileKey]) fresh = d[profileKey]; } catch (_) {}
  if (!fresh || typeof fresh !== 'object') return { skipped: 'noref' };
  if (fresh.tgReal === true) return { kept: true, proven: true };
  const merged = Object.assign({}, fresh, patch);
  try { await chrome.storage.local.set({ [profileKey]: merged }); } catch (_) {}
  return merged;
}

async function tgRecheckPhoneOne(profileKey) {
  let rec = null;
  try {
    const d = await chrome.storage.local.get(profileKey);
    rec = d && d[profileKey];
  } catch (_) {}
  if (!rec || typeof rec !== 'object') return { skipped: 'noref' };
  // Явный мусор (@chat/@adfire/@chat123/служебные пути t.me) снимаем СРАЗУ, независимо от
  // того, откуда он пришёл (не только из номера) и без веба: фильтруем telegrams, если
  // остался вменяемый юз — повышаем его, иначе чистим TG-поля совсем.
  const curH = tgHandleFromUrl(rec.telegram);
  if (curH && isGarbageTgHandle(curH)) {
    const keepList = (Array.isArray(rec.telegrams) ? rec.telegrams : [])
      .filter((u) => { const h = tgHandleFromUrl(u); return h && !isGarbageTgHandle(h); });
    const gpatch = {
      telegram: keepList[0] || null,
      telegrams: keepList,
      tgExists: keepList.length > 0,
      tgKind: keepList.length ? (rec.tgKind || 'user') : null,
      tgRecheckedAt: Date.now(),
    };
    if (!keepList.length) {
      gpatch.tgReal = 'unknown'; gpatch.tgRealVia = 'webtg'; gpatch.tgRealAt = Date.now();
      gpatch.tgRealWhy = 'мусорный TG-юз снят при чистке';
    }
    // Защита «не снести доказанно живой» внутри tgCleaningWrite (перечитка свежего tgReal===true)
    // стоит ВЫШЕ мусорной ветки, поэтому профиль, успевный подтвердиться, не обнулится.
    const gres = await tgCleaningWrite(profileKey, rec, gpatch);
    if (gres && (gres.skipped || gres.proven)) return gres;
    return { purged: true, garbage: true };
  }
  // Доказанно живой юз не перепроверяем номером: глобальный TG-поиск по номеру
  // недетерминирован (премиум/приватность/лимит), и его «не нашёл» — не повод сносить
  // подтверждённую экспертизой личку.
  if (rec.tgReal === true) return { kept: true, proven: true };
  // Чиним только то, что пришло ИЗ номера. TG из дубля ника (tgFromHandle) или из
  // био — другой путь, он не порощал эту парашу, не трогаем.
  if (rec.tgPhoneResolved !== 'user') return { skipped: 'notphone' };
  const phone = rec.tgPhone;
  if (!phone) return { skipped: 'nophone' };

  const r = await tgResolvePhone(phone);
  if (!r || !r.ok) return { skipped: 'err', error: (r && r.error) || 'no-result' };

  if (r.found) {
    const goodTg = r.telegram || null;
    const same = !!goodTg && String(rec.telegram || '') === String(goodTg);
    const fpatch = {
      telegram: goodTg,
      telegrams: goodTg ? [goodTg] : [],
      tgExists: true,
      tgKind: r.tgKind || 'user',
      tgPhoneResolved: 'user',
      tgRecheckedAt: Date.now(),
    };
    const fres = await tgCleaningWrite(profileKey, rec, fpatch);
    if (fres && (fres.skipped || fres.proven)) return fres;   // успели доказать/профиль исчез — не пишем
    try { await tgWriteReal(profileKey, tgRealFromKind(r.tgKind || 'user', 'webtg')); } catch (_) {}
    return { kept: true, fixed: !same, telegram: goodTg };
  }

  // Поиск прошёл успешно, но доказанного владельца номера нет → стираем парашу.
  const ppatch = {
    telegram: null,
    telegrams: [],
    tgExists: false,
    tgKind: null,
    tgPhoneResolved: 'none',
    tgRecheckedAt: Date.now(),
    tgReal: 'unknown',
    tgRealVia: 'webtg',
    tgRealAt: Date.now(),
    tgRealWhy: 'номер не дал доказанного владельца — TG по номеру снят при перепроверке',
  };
  const pres = await tgCleaningWrite(profileKey, rec, ppatch);
  if (pres && (pres.skipped || pres.proven)) return pres;
  return { purged: true };
}

// Сплошная перепроверка: берёт ОДИН профиль с любым TG-юзом и проверяет анонимно через
// превью t.me, существует ли такой юз. 'none' (доказанно нет) → снимает TG; 'user/bot/
// channel' → оставляет и уточняет tgKind; null (сеть/челлендж/мягкий лимит) → НЕ трогает,
// чтобы не посносить годные ссылки из-за технических проблем t.me.
async function tgRecheckHandleOne(profileKey) {
  let rec = null;
  try { const d = await chrome.storage.local.get(profileKey); rec = d && d[profileKey]; } catch (_) {}
  if (!rec || typeof rec !== 'object') return { skipped: 'noref' };
  const h = tgHandleFromUrl(rec.telegram);
  if (!h) return { skipped: 'nohandle' };
  // Доказанно живой юз (web-сессия/тгк/номер ставили tgReal===true) не смеем сносить: один
  // flaky-ответ t.me («If you have Telegram…») под мягким лимитом — не повод удалять личку,
  // которую подтвердил эксперт. Пропускаем, ничего не переписываем.
  if (rec.tgReal === true) return { kept: true, proven: true };
  let kind = null;
  try { kind = await tgClassifyHandle(h); } catch (_) { kind = null; }
  if (kind === null) return { skipped: 'noclass' };   // не определились — не трогаем
  if (kind === 'none') {
    // «не нашёл» — самый частый ложняк под лимитом. Подтверждаем ВТОРЫМ запросом и сносим
    // только если повтор тоже сказал 'none'. Иначе — не рискуем.
    await tgSleep(1500);
    let kind2 = null; try { kind2 = await tgClassifyHandle(h); } catch (_) { kind2 = null; }
    if (kind2 === null) return { skipped: 'noclass' };               // повтор неясен — не трогаем
    if (kind2 !== 'none') {                                          // повтор противоречит — юз жив
      const kres = await tgCleaningWrite(profileKey, rec, { tgKind: kind2, tgExists: true, tgRecheckedAt: Date.now() });
      if (kres && (kres.skipped || kres.proven)) return kres;
      try { await tgWriteReal(profileKey, tgRealFromKind(kind2, 'webtg')); } catch (_) {}
      return { kept: true };
    }
    const dpatch = {
      telegram: null, telegrams: [], tgExists: false, tgKind: null, tgRecheckedAt: Date.now(),
      tgReal: 'unknown', tgRealVia: 'webtg', tgRealAt: Date.now(),
      tgRealWhy: 'юз не найден в t.me (двойная проверка) — снят при сплошной перепроверке',
    };
    const dres = await tgCleaningWrite(profileKey, rec, dpatch);
    if (dres && (dres.skipped || dres.proven)) return dres;   // успели доказать живость — не сносим
    return { purged: true, dead: true };
  }
  const eres = await tgCleaningWrite(profileKey, rec, { tgKind: kind, tgExists: true, tgRecheckedAt: Date.now() });
  if (eres && (eres.skipped || eres.proven)) return eres;
  try { await tgWriteReal(profileKey, tgRealFromKind(kind, 'webtg')); } catch (_) {}
  return { kept: true };
}

// Дубль ника из инсты: пробуем тот же @юзернейм в ТГ. Существование публичного @хэндла
// проверяется АНОНИМНО (превью t.me через fetch в воркере — без логина и без аккаунта).
// В аккаунт (web.telegram.org) идём ТОЛЬКО если анонимно не удалось определиться (сеть/редирект).
// Совпадение имени в карточке TG с IG-именем — доказательство, что «дубль ника»
// привёл к тому же человеку, а не к однофамильцу/докеру/боту, занявшему ник.
function tgNamesMatch(tgName, igName) {
  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/[^0-9a-z\u0400-\u04ff]+/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  const x = norm(tgName), y = norm(igName);
  if (!x || !y) return false;
  if (x === y) return true;
  // substring-правило только для достаточно длинных имён: иначе «Tom» ⊂ «Tomorrowland»
  // давало бы ложное подтверждение чужого человека под тем же ником.
  if (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))) return true;
  const tx = [...new Set(x.split(' ').filter((w) => w.length > 2))];
  const ty = [...new Set(y.split(' ').filter((w) => w.length > 2))];
  if (!tx.length || !ty.length) return false;
  const setY = new Set(ty);
  let inter = 0;
  for (const w of tx) if (setY.has(w)) inter++;
  return inter / Math.min(tx.length, ty.length) >= 0.5;
}
async function tgResolveHandle(handle, igName) {
  const h = (normalizeIg(handle) || String(handle || '')).toLowerCase();
  // 1) анонимно: превью t.me/<h> отвечает на «есть ли такой юзернейм и кто он».
  let kind = null;
  try { kind = await tgClassifyHandle(h); } catch (_) {}
  if (kind === 'none') return { ok: true, found: false };            // юза нет — проверено анонимно
  if (kind === 'user' || kind === 'bot' || kind === 'channel') {
    // Существование @ника ≠ тот же человек. Доказываем совпадением имени в карточке
    // TG (tgClassifyHandle заполнил tgLastProfileCard) с IG-именем; иначе — спекуляция.
    const corroborated = kind === 'user' && tgNamesMatch(tgLastProfileCard && tgLastProfileCard.name, igName);
    return { ok: true, found: true, telegram: `https://t.me/${h}`, tgKind: kind, corroborated };
  }
  // 2) анонимно неясно (null) — крайний случай: живой поиск аккаунтом.
  const r = await tgWebSearch(h);
  if (!r.ok) return { ok: false, error: r.error };
  // Живой поиск — крайний случай; берём только доказанное соответствие нику.
  if (r.match !== true) return { ok: true, found: false };
  const foundHandle = r.handle || (String(r.title || '').toLowerCase() === h ? h : null);
  if (!foundHandle) return { ok: true, found: false };
  const k2 = await tgResolveKind(foundHandle);
  if (k2 === 'none') return { ok: true, found: false }; // битая ссылка в отчёт не пойдёт
  const corroborated2 = k2 === 'user' && tgNamesMatch(tgLastProfileCard && tgLastProfileCard.name, igName);
  return { ok: true, found: true, telegram: `https://t.me/${foundHandle}`, tgKind: k2, corroborated: corroborated2 };
}

function tgTargetFromUrl(url) {
  const s = String(url || '').trim();
  const m = s.match(/(?:t\.me|telegram\.me)\/(\+?[A-Za-z0-9_]{3,64})/i);
  if (m) return m[1].startsWith('+') ? m[1] : m[1].toLowerCase();
  if (/^\+?[A-Za-z0-9_]{3,64}$/.test(s)) return s.toLowerCase();
  return null;
}

// Проверяет найденные юзы на существование (несуществующие не кидаем).
// Сначала дешёвый Bot API (лишние запросы к браузеру не делаем), потом сайт.
// Если верификация вообще не удалась (сеть/лимиты) — возвращаем как нашли, чтобы не терять лиды.
async function tgVerifyUsers(users, maxCount) {
  const list = users.slice(0, maxCount || 8);
  const confirmed = [];
  const rest = [];
  for (const u of list) {
    try {
      const r = await tgApiCheck(u);
      if (r && r.ok) {
        confirmed.push(u);
        continue;
      }
    } catch (_) {}
    rest.push(u);
  }
  const unknown = [];
  for (const u of rest) {
    try {
      const v = await tgVerify(u);
      if (v.exists === true) confirmed.push(u);
      else unknown.push(u);
    } catch (_) {
      unknown.push(u);
    }
    await tgSleep(200);
  }
  return confirmed.length ? confirmed : unknown;
}

// ---------- «реальность» TG-профиля: слой доказательности ----------
// tgKind отвечает на «КТО это» (юзер/канал/бот/никто), tgReal — на «ДОКАЗАНО ЛИ, что
// живой личный аккаунт». Раньше эти два вопроса смешивались: зелёная плашка «✅ ТГ»
// вешалась по наличию СТРОКИ telegram, а filter «реальные» пропускал профили, где
// tgKind вообще не считался. Отсюда и «на 5к человек с 100%-м TG ни одного».
// Решает только то, что реально умеет канал: Bot API произвольного человека НЕ ВИДИТ
// (getChat отдаёт каналы/группы и тех, кто сам писал боту), поэтому доказателем
// выступает анонимное превью t.me, а web.telegram.org — только коротким списком.
// TG_VERIFY_MODES / TG_VERIFY_MODE_KEY объявлены в qualify.js: тот же realm воркера и
// те же имена читают дашборд и сайт — вторая копия списка разъехалась бы молча.
const TG_REV_STATE_KEY = 'igx_tgrev_state';     // состояние массовой ревизии (водит дашборд)
const TG_MSG_CHUNK = 4000;                      // лимит сообщения Telegram ~4096, берём с запасом

// Единственное место, где verdict превью становится «реальностью». Ошибка сети/429
// обязана давать 'unknown', а НЕ false: иначе одна волна таймаутов молча похоронит
// половину базы как «мёртвые юзы», и отличить это от настоящих мёртвых будет нельзя.
function tgRealFromKind(kind, via) {
  if (kind === 'user') return { real: true, via: via || 'tme', kind: 'user', why: '' };
  if (kind === 'none') return { real: false, via: via || 'tme', kind: 'none', why: 'юза нет — t.me отдаёт страницу-зазыв вместо профиля' };
  if (kind === 'channel') return { real: false, via: via || 'tme', kind: 'channel', why: 'это канал/группа, а не человек' };
  if (kind === 'bot') return { real: false, via: via || 'tme', kind: 'bot', why: 'это бот, а не человек' };
  return { real: 'unknown', via: '', kind: kind || '', why: 'проверить не удалось (сеть/лимит t.me) — прежний вердикт не трогаем' };
}

// Запись вердикта в профиль. Смысл разделения tgRealAt / tgRealTryAt: неудачная
// попытка не должна делать запись «свежепроверенной» (иначе ревизия больше никогда
// к ней не вернётся) и не должна перетирать решительный вердикт.
async function tgWriteReal(key, v) {
  const now = Date.now();
  let cur = {};
  try {
    const d = await chrome.storage.local.get(key);
    cur = (d && d[key]) || {};
  } catch (_) { return null; }
  if (!cur || typeof cur !== 'object') return null;
  const patch = { tgRealTryAt: now };
  if (v.real === 'unknown') {
    if (cur.tgReal !== true && cur.tgReal !== false) {
      patch.tgReal = 'unknown';
      patch.tgRealWhy = v.why || 'не проверено';
    } else {
      // решительный вердикт был — оставляем его как доказательство, но пишем, что
      // перепроверка не удалась: UI покажет старый статус с пометкой о попытке.
      patch.tgRealWhy = String(cur.tgRealWhy || v.why || '') + ' (перепроверить не удалось)';
    }
  } else {
    patch.tgReal = v.real;
    patch.tgRealVia = v.via || 'tme';
    patch.tgRealAt = now;
    patch.tgRealWhy = v.why || '';
    if (v.kind) patch.tgKind = v.kind;
    if (v.kind === 'user') patch.tgExists = true;
    else if (v.kind === 'none') patch.tgExists = false;
    // Чек-пола: сохраняем имя/bio из карточки TG, но ТОЛЬКО когда подтверждён
    // личный аккаунт. Название канала или бота как «имя человека» в detectGender
    // попало бы ложно. Если в этой проверке имя не добыли — старое НЕ затираем
    // (одна волна 429 не должна сбрасывать уже доказанные данные).
    if (v.real === true && v.kind === 'user') {
      if (v.tgName) patch.tgName = String(v.tgName).slice(0, 120);
      if (v.tgBio) patch.tgBio = String(v.tgBio).slice(0, 400);
    }
  }
  const merged = Object.assign({}, cur, patch);
  try { await chrome.storage.local.set({ [key]: merged }); } catch (_) { return null; }
  return merged;
}

// Один хэндл → вердикт. Анонимно, без вкладок: fetch превью t.me в воркере.
// Личный аккаунт: дополнительно цепляем имя/bio из превью — tgWriteReal зальёт их
// в профиль как tgName/tgBio, и qualify.js будет строить пол по карточке TG.
async function tgVerifyHandleOnce(raw) {
  const info = tgHandleInfo(raw);
  if (!info.handle) {
    return { real: 'unknown', via: '', kind: '', why: 'в ссылке нет @юзернейма (приватный инвайт, номер или мусор)' };
  }
  let kind = null;
  try { kind = await tgClassifyHandle(info.handle); } catch (_) { kind = null; }
  const v = tgRealFromKind(kind, 'tme');
  if (kind === null && tgLastClassifyDiag) v.why = String(v.why || '') + ' · ' + tgLastClassifyDiag;
  if (kind === 'user' && tgLastProfileCard) {
    if (tgLastProfileCard.name) v.tgName = tgLastProfileCard.name;
    if (tgLastProfileCard.bio) v.tgBio = tgLastProfileCard.bio;
  }
  return v;
}

// Добор через залогиненный web.telegram.org: он видит то, чего не видит анонимное
// превью — удалённый/забаненный аккаунт и профиль без публичного хэндла. Медленный
// (секунды на профиль) и упирается в FloodWait, поэтому только для короткого списка.
async function tgConfirmViaWeb(raw) {
  const info = tgHandleInfo(raw);
  if (!info.handle) return { use: false };
  let r = null;
  try { r = await tgWebSearch(info.handle); } catch (e) { r = { ok: false, error: String(e.message || e) }; }
  if (!r || !r.ok) return { use: false, why: (r && r.error) || 'web.telegram.org не ответил' };
  if (!r.handle && !r.id) {
    return { use: true, verdict: { real: false, via: 'webtg', kind: 'none', why: 'web-сессия не нашла такой профиль (возможно, удалён или забанен)' } };
  }
  return { use: true, verdict: { real: true, via: 'webtg', kind: 'user', why: '', tgName: (r.title && String(r.title).slice(0, 120)) || '' } };
}

// Длинный разбор режем по строкам: рвать посреди слова нельзя, а Telegram на
// 4096 символов обрезает сообщение молча и без ошибки.
function tgChunkText(text, limit) {
  const max = limit || TG_MSG_CHUNK;
  const src = String(text || '');
  if (src.length <= max) return src ? [src] : [];
  const out = [];
  let buf = '';
  for (const line of src.split('\n')) {
    const add = (line.length > max ? line.match(new RegExp('.{1,' + max + '}', 'g')) || [] : [line]);
    for (const piece of add) {
      if (buf && (buf.length + 1 + piece.length) > max) { out.push(buf); buf = ''; }
      buf = buf ? buf + '\n' + piece : piece;
    }
  }
  if (buf) out.push(buf);
  return out;
}

async function readTgRevState() {
  try {
    const d = await chrome.storage.local.get(TG_REV_STATE_KEY);
    const s = d && d[TG_REV_STATE_KEY];
    return s && typeof s === 'object' ? s : {};
  } catch (_) { return {}; }
}

// Сколько времени прошло с проверки — словами, а не timestamp-ом: «мы нашли юза»
// и «мы недавно доказали, что он жив» для читателя отчёта — разные утверждения.
function tgAgo(ts) {
  const t = Number(ts) || 0;
  if (!t) return 'никогда';
  const d = Math.floor((Date.now() - t) / 86400000);
  if (d <= 0) {
    const h = Math.floor((Date.now() - t) / 3600000);
    return h <= 0 ? 'только что' : h + ' ч назад';
  }
  return d + ' дн назад';
}

// Честная строка статуса проверки для отчёта/UI. Три состояния, а не два:
// «не проверялся» обязан называться не проверявшимся — иначе отсутствие
// работы выглядит как результат работы (тот самый «жёлтый ноль» на 5k профилей).
function tgRealStatusHtml(p) {
  if (!p || !p.telegram) return '';
  const via = p.tgRealVia === 'webtg' ? ' + web-сессия' : p.tgRealVia === 'api' ? ' (Bot API)' : '';
  if (p.tgReal === true) return `✅ <b>TG подтверждён живым</b>${via} · ${tgAgo(p.tgRealAt)}`;
  if (p.tgReal === false) return `✖ <b>TG не жив</b>${via} · ${tgAgo(p.tgRealAt)}${p.tgRealWhy ? ' — ' + tgEsc(p.tgRealWhy) : ''}`;
  if (p.tgReal === 'unknown') return `❔ <b>Проверка не удалась</b>${p.tgRealWhy ? ' — ' + tgEsc(p.tgRealWhy) : ''}`;
  return '❔ <b>Реальность TG не проверялась</b> — прогоните «Ревизию TG» на второй странице сайта';
}

async function tgRealStatusNote(key) {
  let p = null;
  try {
    const d = await chrome.storage.local.get(key);
    p = d && d[key];
  } catch (_) { return ''; }
  return tgRealStatusHtml(p);
}

// Итоги по всей базе: сколько ссылок доказаны, сколько похоронено, сколько ещё
// не проходили ревизию. Нужен одной строкой в сводке, чтобы «ноль жёлтых»
// не читался как «ни у кого нет TG».
async function tgRealTotals() {
  const t = { withTg: 0, real: 0, dead: 0, unknown: 0, unchecked: 0 };
  let all = {};
  try { all = await chrome.storage.local.get(null); } catch (_) { return t; }
  for (const k of Object.keys(all)) {
    if (!k.startsWith('igx_profile:')) continue;
    const p = all[k];
    if (!p || !p.telegram) continue;
    t.withTg++;
    if (p.tgReal === true) t.real++;
    else if (p.tgReal === false) t.dead++;
    else if (p.tgReal === 'unknown') t.unknown++;
    else t.unchecked++;
  }
  return t;
}

// ---------- отчёт ----------
async function tgCheckTarget(target, mode, opts) {
  opts = opts || {};
  const s = await getTgSettings();
  const useMode = mode || s.mode;
  let r;
  if (useMode === 'tg') {
    r = await tgScanFull(target, s, opts.onProgress);
    if (!r.ok && opts.fallbackToSite !== false) {
      // Фоллбэк: если веб-телеграм не справился — пробуем сайтом
      r = await tgScanSite(target, s);
      if (r.ok && r.privateOnly) {
        return { ok: false, error: 'Приватная ссылка — без залогиненного web.telegram.org (режим ТГ) не прочитать.' };
      }
      if (!r.ok) {
        // И браузер не смог — последний шанс: Bot API (api.telegram.org).
        const api = await tgApiCheck(target);
        if (api) return Object.assign({ mode: useMode }, api);
      }
    }
  } else {
    r = await tgScanSite(target, s);
    // t.me не открылся в браузере (блокировка/сеть) — идём через Bot API: это надёжно.
    if (!r.ok) {
      const api = await tgApiCheck(target);
      if (api) return Object.assign({ mode: useMode }, api);
      return r;
    }
    if (r.privateOnly) {
      return { ok: false, error: 'Приватная ссылка (+...) — сайтом не читается. Переключи режим на ТГ (/mode в боте).' };
    }
  }
  if (!r.ok) return r;
  if (r.exists === false) {
    return { ok: false, error: `@${target} — не существует (t.me не подтверждает).` };
  }
  return Object.assign({ mode: useMode }, r);
}

function tgBuildReport(target, r, instaUrl, igFollowers, verifyNote) {
  const users = Array.from(r.out.users);
  const invites = Array.from(r.out.invites);
  const contacts = users.map((u) => '@' + u).concat(invites.map((i) => `t.me/${i}`));
  const ig = instaUrl || Array.from(r.out.instagram)[0];
  const clean = String(target).replace(/^@/, '');
  const fmtNum = (n) => (Number(n) || 0).toLocaleString('ru-RU');

  const lines = [];
  if (r.isChannel === true) {
    // Это КАНАЛ/группа, а не личка: сам канал и есть находка. Раньше для него
    // писали «Найдено контактов: 0» (внутри канала нет личного @юза), и это
    // выглядело как «не найдено». Показываем канал подтверждённым + ссылку.
    lines.push(`📢 <b>@${tgEsc(clean)}</b> — канал подтверждён ✅`);
    if (r.title && String(r.title).toLowerCase() !== clean.toLowerCase()) lines.push(`Название: <b>${tgEsc(r.title)}</b>`);
    if (r.members) lines.push(`👥 Подписчиков в ТГ: <code>${fmtNum(r.members)}</code>`);
  } else if (r.exists === null) {
    lines.push(`🟡 <b>@${tgEsc(clean)}</b> — TG найден <i>(статус не подтверждён)</i>`);
  } else {
    lines.push(`✅ <b>@${tgEsc(clean)}</b> — TG подтверждён`);
  }
  // Подписчики — сразу под ссылкой: только ИГ (счётчик ТГ в отчёте не нужен).
  const f = Number(igFollowers);
  if (isFinite(f) && f > 0) lines.push(`📸 Подписчиков в ИГ: <code>${fmtNum(f)}</code>`);
  if (r.isChannel === true) {
    lines.push(`🔗 <a href="https://t.me/${encodeURIComponent(clean)}">t.me/${tgEsc(clean)}</a>`);
    if (contacts.length) {
      lines.push('', `<b>Контакты внутри: ${contacts.length}</b>`);
      lines.push(...contacts.map((c) => '· ' + tgEsc(c)));
    }
  } else if (contacts.length) {
    lines.push('', `<b>Найдено контактов: ${contacts.length}</b>`);
    lines.push(...contacts.map((c) => '· ' + tgEsc(c)));
  } else {
    lines.push('Найдено контактов: 0');
  }
  if (ig) lines.push('', `🔥 Инста: <a href="https://instagram.com/${encodeURIComponent(String(ig).replace(/^\//, ''))}">${tgEsc(ig)}</a>`);
  // Строка статуса проверки — чтобы «нашлось» не читалось как «живо на 100%».
  if (verifyNote) lines.push('', '🔎 ' + verifyNote);
  return lines.join('\n');
}

async function tgSendReport(target, r, instaUrl, force, igFollowers, profileKey) {
  const s = await getTgSettings();
  if (!s.chatId) return false;

  const contacts = Array.from(r.out.users).concat(Array.from(r.out.invites)).sort().join(',');
  const key = String(target).toLowerCase();
  if (!force) {
    const data = await chrome.storage.local.get(TG_REPORTED_KEY);
    const reported = data[TG_REPORTED_KEY] || {};
    const prev = reported[key];
    if (prev && prev.contacts === contacts && Date.now() - prev.ts < 7 * 24 * 3600 * 1000) {
      return false; // уже отчитывались с тем же набором контактов за неделю
    }
    reported[key] = { contacts, ts: Date.now() };
    // подчистка старых записей
    for (const k of Object.keys(reported)) {
      if (Date.now() - reported[k].ts > 30 * 24 * 3600 * 1000) delete reported[k];
    }
    await chrome.storage.local.set({ [TG_REPORTED_KEY]: reported });
  }

  await tgSayHtml(s.chatId, tgBuildReport(target, r, instaUrl, igFollowers, profileKey ? await tgRealStatusNote(profileKey) : ''));
  return true;
}

// ---------- очередь бот-проверок (кинули ссылку в бота) ----------
let tgBotQueue = [];
let tgBotBusy = false;

async function tgQueueBotCheck(target, chatId) {
  tgBotQueue.push({ target, chatId });
  if (tgBotBusy) return;
  tgBotBusy = true;
  while (tgBotQueue.length) {
    const item = tgBotQueue.shift();
    const s = await getTgSettings();
    // Страховка: один таргет не может висеть дольше 50 секунд — ответ придёт всегда.
    const timeout = new Promise((res) => setTimeout(() => res({ ok: false, error: 'таймаут 50с — не успел проверить' }), 50000));
    try {
      const r = await Promise.race([tgCheckTarget(item.target, s.mode, {}), timeout]);
      if (!r.ok) {
        await tgSay(item.chatId, `${item.target}: ${r.error}`);
      } else {
        await tgSendReport(item.target, r, null, true);
      }
    } catch (e) {
      await tgSay(item.chatId, `${item.target}: ошибка (${e.message || e})`);
    }
    if (tgBotQueue.length) await tgSleep(Math.min(5000, s.delaySec * 1000));
  }
  tgBotBusy = false;
}

// ---------- поллинг бота (команды и ссылки) ----------
function tgModeKeyboard(mode) {
  return {
    inline_keyboard: [[
      { text: mode === 'site' ? '✅ 🌐 Сайт (быстрый)' : '🌐 Сайт (быстрый)', callback_data: 'mode:site' },
      { text: mode === 'tg' ? '✅ 📱 ТГ (точный)' : '📱 ТГ (точный)', callback_data: 'mode:tg' },
    ]],
  };
}

function tgHelpText() {
  return [
    '🛰 <b>IG Lead Scout</b> — команды:',
    '',
    '<b>/mode</b> — режим проверки (сайт / тг)',
    '<b>/st</b> <code>[сообщений] [задержка сек]</code> — настройки скана',
    '<b>/list</b> <code>[tg|tg100] [кол-во] [сабы от-до] [слова]</code> — зелёные эксперты (сначала свежие)',
    '     · <code>рассылка</code> — выборка под рассылку: <code>/list рассылка [кол-во] [сабы] [слова]</code>, отдаёт только тех, кому ты ещё не писал, и добавляет кнопку «📤 Разослать разборы»',
    '        <i>(фильтр «писал» опирается на снимок диалогов со страницы ④ сайта: не снимал — лид считается «не проверялся» и остаётся в выборке)</i>',
    '     · <code>tg</code> — только реальные личные юзы (без каналов, групп и ботов)',
    '     · <code>tg100</code> — только ДОКАЗАННО живые юзы: те, кого прогнали «Ревизию TG» на второй странице сайта',
    '     · страницы фиксированные: по <code>10</code> (кнопки ◀️ / ▶️), <code>кол-во</code> — сколько ВСЕГО показать',
    '     · под списком кнопки-переключатели (жмёшь — значение меняется по кругу, как на сайте):',
    '        <b>🗂 квал</b> (новый с ТГ / просмотренный / личка / выжатый / не подходит),',
    '        <b>🚻 пол</b> (👨 / 👩 / ❔ без пола) и <b>🆕 сортировка</b> (свежие / старые / сабы / ник / квал); <b>↺</b> — сброс',
    '     · в каждой строке бейджи: <b>цвет</b> = статус в инсте, <b>👩/👨/❔</b> = пол',
    'Просто кинь ссылку <code>t.me/...</code> — проверю и пришлю отчёт.',
    '',
    '<i>Проверки выполняются расширением в браузере — он должен быть открыт.</i>',
  ].join('\n');
}

// /list [tg] [рассылка] [количество всего] [подписчики от-до] [ключевые слова через запятую]
// Присылает «зелёных» экспертов из базы (у кого найден Telegram), отсортированных
// по свежести: недавно всех проверённые/найденные — первыми (по checkedAt). Одно число в сабах = «от и до бесконечности».
// Флажок «tg» первым аргументом — только профили с 100% подтверждённым TG (tgExists===true).
// Флажок «рассылка» — выборка под рассылку: по умолчанию ОТДАЁМ ТОЛЬКО тех, кому ещё не писал
// (отметки «писал» снимает страница ④ через мост tgbridge), плюс отсекаются «без TG»/«не личка»
// и появляется кнопка «📤 Разослать разборы».
// «кол-во» = сколько строк ВСЕГО показать (0/не указано = все найденные);
// лист разбит на страницы по LIST_PAGE_SIZE, перелистыв кнопками ◀️/▶️ (состояние — igx_list_q).
function tgParseListQuery(text) {
  const args = text.trim().split(/\s+/).slice(1);
  let idx = 0;
  // 0) флажки, в любом порядке: «tg» — только подтверждённые; «tg100» — только ДОКАЗАННО
  // живые личные юзы (tgReal === true по ревизии), без доклассификации на лету и без
  // «не проверялся»; «рассылка» — режим рассылки разборов.
  let onlyVerified = false;
  let strictReal = false;
  let rss = false;
  for (;;) {
    const a = args[idx];
    if (!a) break;
    if (/^tg(100)?$/i.test(a)) {
      onlyVerified = true;
      strictReal = /^tg100$/i.test(a);
      idx++;
      continue;
    }
    // Кириллица: «\b» в JS не считает кириллическую букву границей слова, поэтому флаг
    // сверяем целым токеном от начала до конца — иначе «рассылка» не матчился бы никогда.
    if (/^(рассылка|рассыл|рассл|rss)$/i.test(a)) {
      rss = true;
      idx++;
      continue;
    }
    break;
  }
  let count = 0; // сколько ВСЕГО показывать; 0 = все найденные
  let subsFrom = 0;
  let subsTo = 0; // 0 = без верха (Infinity в JSON не переживает storage — храним 0)
  const keywords = [];
  // 1) количество (простое целое число первым аргументом)
  if (args[idx] && /^\d+$/.test(args[idx])) {
    count = Math.max(0, Math.min(100000, parseInt(args[idx], 10) || 0));
    idx++;
  }
  // 2) подписчики: «N» = от N до ∞, «N-M» = диапазон
  if (args[idx]) {
    const m = args[idx].match(/^(\d+)(?:\s*[-–—]\s*(\d+))?$/);
    if (m) {
      subsFrom = parseInt(m[1], 10) || 0;
      subsTo = m[2] ? parseInt(m[2], 10) || 0 : 0;
      idx++;
    }
  }
  // 3) всё остальное — ключевые слова (можно через запятую)
  for (let i = idx; i < args.length; i++) {
    args[i].split(',').forEach((k) => {
      const w = k.trim().toLowerCase();
      if (w) keywords.push(w);
    });
  }
  return { onlyVerified, strictReal, count, subsFrom, subsTo, keywords, stat: 'all', gender: 'all', sort: 'new', wrote: rss ? 'not' : 'all', rss, page: 1 };
}

// ---------- /list: кнопки-переключатели (квал и сортировка) ----------
// Под списком три кнопки: нажал — значение сдвинулось на шаг по циклу, кнопка
// переименовалась. Циклы повторяют словарь боковой панели дашборда («Квал: статус»,
// «Квал: пол», «Сортировка»), чтобы в боте и на сайте одни и те же слова значили
// одно и то же. Дефолт — «все» + «сначала свежие», ровно как на сайте.
// Состояние живёт в igx_list_q вместе с пагинацией.
const LIST_STAT_CYCLE = [
  { v: 'all', t: '🗂 Квал: все' },
  { v: 'tgnew', t: '🟩 Новые с ТГ' },
  { v: 'viewed', t: '🟦 Просмотренные' },
  { v: 'gold', t: '🟨 Личка найдена' },
  // «выжатость» — три оттенка одного смысла (подписчики / подписки / оба), в одну кнопку,
  // чтобы цикл не расползался на восемь тычков.
  { v: 'squeezed', t: '🟪 Выжатые' },
  { v: 'nofit', t: '🟥 Неподходят' },
];
const LIST_SQUEEZED = new Set(['fol', 'fsg', 'both']);
const LIST_GENDER_CYCLE = [
  { v: 'all', t: '🚻 Пол: все' },
  { v: 'm', t: '👨 Мужской' },
  { v: 'f', t: '👩 Женский' },
  { v: 'u', t: '❔ Без пола' },
];
const LIST_SORT_CYCLE = [
  { v: 'new', t: '🆕 Свежие' },
  { v: 'old', t: '🕒 Старые' },
  { v: 'subs', t: '💰 По сабам' },
  { v: 'name', t: '🔤 По нику' },
  // «по квалу» = по «цвету строки» (личка → новый → просмотрен → … → не проверялся).
  { v: 'qual', t: '🏅 По квалу' },
];
// «Писал ли уже» — две кнопки не делаем: для рассылки важен ровно один вопрос
// «кому ещё не светил», а третий оттенок («не проверял») доступен на сайте в Истории.
const LIST_WROTE_CYCLE = [
  { v: 'all', t: '✍️ Писал: все' },
  { v: 'not', t: '📭 Только не писал' },
];
// Ключ состояния рассылки и приставка джобов автоанализа (тот же ключ, что у дашборда:
// PAA_JOB_PREFIX — дашборд пишет, бот только читает готовые разборы).
const TG_RSS_STATE_KEY = 'igx_rss_state';
const TG_RSS_ALARM = 'igx-rss-keep';
const TG_PAA_JOB_PREFIX = 'igx_paa_job:';
// Эмодзи = цвет строки в Instagram (ACC_COLORS), только в боте палитра ограничена
// юникодом: hex туда не передать.
const LIST_COLOR_EMOJI = {
  gold: '🟨', tgnew: '🟩', viewed: '🟦', nofit: '🟥',
  fol: '🟪', fsg: '🔷', both: '🟣', none: '⬜',
};

// Шаг цикла: следующее значение после текущего (неизвестное значение → первый шаг).
function tgCycleNext(cycle, cur) {
  const i = cycle.findIndex((x) => x.v === cur);
  return cycle[(i < 0 ? 0 : i + 1) % cycle.length].v;
}
function tgCycleItem(cycle, v) {
  return cycle.find((x) => x.v === v) || cycle[0];
}
// igx_list_q мог остаться в storage с прошлой версии (без кнопок) или после правки
// фильтров командой — дотягиваем дефолты, чтобы рендер не упал на undefined.
function tgNormalizeListQ(q) {
  const n = q && typeof q === 'object' ? q : {};
  n.onlyVerified = !!n.onlyVerified;
  n.strictReal = !!n.strictReal;
  n.count = Number(n.count) || 0;
  n.subsFrom = Number(n.subsFrom) || 0;
  n.subsTo = Number(n.subsTo) || 0;
  n.keywords = Array.isArray(n.keywords) ? n.keywords : [];
  n.page = Number(n.page) || 1;
  n.stat = tgCycleItem(LIST_STAT_CYCLE, n.stat).v;
  n.gender = tgCycleItem(LIST_GENDER_CYCLE, n.gender).v;
  n.sort = tgCycleItem(LIST_SORT_CYCLE, n.sort).v;
  // igx_list_q из старой версии не знает ни про рассылку, ни про «писал» — дефолты:
  // обычный список без фильтра по отметкам (иначе прошлый снапок «протух» бы в пустоту).
  n.rss = !!n.rss;
  n.wrote = tgCycleItem(LIST_WROTE_CYCLE, n.wrote).v;
  return n;
}
// Строка фильтров под списком + пагинация. Кнопки фильтров показываем и когда строк
// нет: иначе пользователь остаётся с «ничего не найдено» без возможности отжать фильтр.
function tgListKeyboard(q, page, pages, opts) {
  const o = opts || {};
  const btn = (cb, cycle, cur) => ({ text: tgCycleItem(cycle, cur).t, callback_data: cb });
  const rows = [[
    btn('lsc:s', LIST_STAT_CYCLE, q.stat),
    btn('lsc:g', LIST_GENDER_CYCLE, q.gender),
    btn('lsc:o', LIST_SORT_CYCLE, q.sort),
    { text: '↺', callback_data: 'lsreset' },
  ]];
  // Вторая строка: «писал / не писал» + (в режиме рассылки) кнопка самой рассылки.
  const second = [btn('lsc:w', LIST_WROTE_CYCLE, q.wrote)];
  if (q.rss) {
    if (o.pumping) second.push({ text: '✖ Стоп рассылка', callback_data: 'rss:stop' });
    else second.push({ text: '📤 Разослать разборы (' + (o.rssN || 0) + ')', callback_data: 'rss:go' });
  }
  rows.push(second);
  if (pages > 1) {
    rows.push([
      { text: '◀️', callback_data: `listp:${page - 1}` },
      { text: `${page}/${pages}`, callback_data: 'listnoop' },
      { text: '▶️', callback_data: `listp:${page + 1}` },
    ]);
  }
  return { inline_keyboard: rows };
}

// Выборка зелёных из базы по запросу q (без среза страницы).
// 'tg'-режим: только РЕАЛЬНЫЕ личные юзы — режем каналы/группы/ботов/инвайты.
// Тип берём из кэша tgKind; неклассифицированные допроверяем на лету, но не больше
// TG_LIST_CHECK_BUDGET за рендер (страница не должна висеть минуту).
const TG_LIST_CHECK_BUDGET = 12;
// Фиксированный размер страницы /list: влезает в лимит Telegram ~4096 символов.
const LIST_PAGE_SIZE = 10;
// Карта «нику → самый свежий завершённый джоб автоанализа с текстом разбора». Рассылка
// берёт из неё текст: бот НИЧЕГО не разбирает сам, он только раздаёт то, что уже готово.
// Ключи джобов — igx_paa_job:<случайный id>, поэтому ник читаем из самого джоба (j.username).
function tgRssReportMap(all) {
  const m = new Map();
  for (const k of Object.keys(all)) {
    if (!k.startsWith(TG_PAA_JOB_PREFIX)) continue;
    const j = all[k] || {};
    const u = String(j.username || '').toLowerCase();
    if (!u) continue;
    if (j.status === 'running') continue; // разбор ещё идёт — текст может быть не дописан
    if (!j.report || !String(j.report).trim()) continue;
    const prev = m.get(u);
    if (!prev || (Number(j.startedAt) || 0) > (Number(prev.startedAt) || 0)) m.set(u, j);
  }
  return m;
}
async function tgListRows(q) {
  let all = {};
  try { all = await chrome.storage.local.get(null); } catch (_) {}
  let tgModel = 'legacy';
  try { const m = await chrome.storage.local.get('igx_tg_model'); if (m && m.igx_tg_model === 'cascade') tgModel = 'cascade'; } catch (_) {}
  await tgRefreshSpam(); // юзы-захватчики считаем по только что прочитанной базе
  // Настройки страницы ④: «кого не брать в выборку». Режут ОНЛИ в режиме рассылки:
  // обычный /list ничего никуда не отправляет, и молча прятать от юзера каналы/боты
  // в простом списке — значит врать ему.
  const set = tgaccSettings(all);
  const reports = tgRssReportMap(all);
  const rows = [];
  let unclassified = 0;
  let unchecked = 0; // «tg100»: сколько профилей с ссылкой ещё не проходили ревизию
  let budget = q.onlyVerified ? TG_LIST_CHECK_BUDGET : 0;
  for (const k of Object.keys(all)) {
    if (!k.startsWith('igx_profile:')) continue;
    const p = all[k];
    if (!p || !p.telegram) continue; // только «зелёные» (с Telegram)
    if (p.tgKind === 'none') continue; // ссылку проверили — юза не существует, не показываем
    if (tgContactIsSpam(p)) continue; // захватчик-юз — не лид ни в legacy, ни в cascade
    if (tgModel === 'cascade') { if (!tgGateContact(p).canUse) continue; } else if (p.tgSpeculative) continue; // TG только по совпадению IG-ника — не доказано, что тот же человек
    if (q.strictReal) {
      // Здесь ничего не допроверяем на лету: «100%» обязан означать, что проверка
      // УЖЕ была и доказала. Иначе кнопка снова врёт, как врал фильтр «реальные».
      if (p.tgReal !== true || p.tgKind !== 'user') {
        if (!p.tgRealAt) unchecked++;
        continue;
      }
    } else if (q.onlyVerified) {
      const info = tgHandleInfo(p.telegram);
      let kind = p.tgKind || info.kind; // 'other'/'bot' — сразу не-юз
      if (!kind && budget > 0 && info.handle) {
        budget--;
        kind = await tgClassifyHandle(info.handle);
        if (kind) {
          // закешировать в запись профиля, чтобы следующий рендер был мгновенным
          try { await chrome.storage.local.set({ [k]: Object.assign({}, p, { tgKind: kind }) }); } catch (_) {}
        }
      }
      if (kind !== 'user') {
        if (!kind) unclassified++;
        continue;
      }
    }
    const f = Number(p.followers);
    const fol = isFinite(f) ? f : null;
    if (q.subsFrom > 0 && (fol == null || fol < q.subsFrom)) continue;
    if (q.subsTo > 0 && fol != null && fol > q.subsTo) continue;
    if (q.keywords && q.keywords.length) {
      const hay = [p.bio, p.fullName, p.username].filter(Boolean).join('\n').toLowerCase();
      if (!q.keywords.some((w) => hay.includes(w))) continue;
    }
    const username = p.username || k.slice('igx_profile:'.length);
    // «писал / не писал» — единый предикат из qualify.js: страница ④ ставит отметки им же,
    // фильтр Истории читает его же. Режем ТОЛЬКО решительное «писал»: две кнопки (все /
    // не писал) не различают «проверяли и не нашли» и «не проверяли», поэтому unknown
    // обязан проходить — иначе непроверенная база выглядела бы как «всем уже писали».
    const wroteSt = tgaccWroteState(p);
    if (q.wrote === 'not' && wroteSt === 'wrote') continue;
    if (q.rss) {
      // Хэндла нет из чего вытащить — матчить по диалогам нечем, рассылать некому.
      if (set.excl.noTG && !tgaccHandle(p)) continue;
      // Не-личка (классифицированный канал/бот/группа) — писать людям бессмысленно.
      if (set.excl.notUser && p.tgKind && p.tgKind !== 'user') continue;
    }
    // Квалификация — из общего qualify.js: цвет строки и пол считаются ровно так же,
    // как в истории на дашборде (пороги сабов берём из настроек сайта, не из запроса).
    const qual = qualifyAccount(p, all, username);
    if (q.gender !== 'all') {
      const g = qual.gender || '';
      if (q.gender === 'u' ? !!g : g !== q.gender) continue;
    }
    if (q.stat !== 'all') {
      if (q.stat === 'squeezed' ? !LIST_SQUEEZED.has(qual.color) : qual.color !== q.stat) continue;
    }
    rows.push({ username, followers: fol, telegram: p.telegram, at: Number(p.checkedAt) || Number(p.firstSeenAt) || 0, gender: qual.gender, color: qual.color, wrote: wroteSt, hasReport: reports.has(String(username).toLowerCase()) });
  }
  rows.sort(tgListComparator(q.sort));
  return { rows, unclassified, unchecked };
}

// Компаратор по режиму сортировки; внутри одного режима вторым ключом — свежесть,
// чтобы «по сабам»/«по квалу» не превращались в кашу из одинаковых значений.
function tgListComparator(mode) {
  const at = (a, b) => (b.at || 0) - (a.at || 0);
  if (mode === 'old') return (a, b) => (a.at || 0) - (b.at || 0);
  if (mode === 'subs') return (a, b) => ((b.followers == null ? -1 : b.followers) - (a.followers == null ? -1 : a.followers)) || at(a, b);
  if (mode === 'name') return (a, b) => String(a.username).localeCompare(String(b.username)) || at(a, b);
  if (mode === 'qual') {
    const rank = (r) => { const i = ACC_COLOR_ORDER.indexOf(r.color); return i < 0 ? ACC_COLOR_ORDER.length : i; };
    return (a, b) => (rank(a) - rank(b)) || at(a, b);
  }
  return at; // 'new' — дефолт сайта
}

// Рендер одной страницы. editMsgId задан → правим то же сообщение (пагинация),
// иначе шлём новое (команда /list). force=1 — перерисовать даже если страница та же
// (у фильтров результат другой, хотя номер страницы остался первым).
async function tgRenderListPage(chatId, q, page, editMsgId, force) {
  const res = await tgListRows(q);
  const allRows = res.rows;
  const unclassified = res.unclassified || 0;
  const unchecked = res.unchecked || 0;
  // «кол-во» = общий лимит выдачи, страница всегда LIST_PAGE_SIZE.
  const per = LIST_PAGE_SIZE;
  const rows = q.count > 0 ? allRows.slice(0, q.count) : allRows;
  const pages = Math.max(1, Math.ceil(rows.length / per));
  page = Math.max(1, Math.min(page, pages));
  // Кламппинг совпал с уже показанной страницей (тыкнули ◀️/▶️ за краем) — не трогаем:
  // editMessageText с тем же текстом упал бы ошибкой и ушёл дубликатом в sendMessage.
  if (editMsgId && q.page === page && !force) return;
  q.page = page;
  // Шпаргалка по команде — только на этом ответе (голый /list); в igx_list_q её не пишем,
  // иначе каждое нажатие кнопок повторяло бы «Полный вид: /list …».
  const showHint = !!q.hint;
  q.hint = false;
  try { await chrome.storage.local.set({ igx_list_q: q }); } catch (_) {}
  const start = (page - 1) * per;
  const top = rows.slice(start, start + per);
  // Кнопка рассылки показывает сколько лидов УЙДЁТ (весь срез с учётом «кол-во»), а
  // рядом честно пишем, у скольких из них есть готовый разбор — остальным пойдёт карточка.
  const rssN = rows.length;
  const rssRep = rows.reduce((n, r) => n + (r.hasReport ? 1 : 0), 0);
  let pumping = false;
  if (q.rss) { try { const st = (await chrome.storage.local.get(TG_RSS_STATE_KEY))[TG_RSS_STATE_KEY]; pumping = !!(st && st.on); } catch (_) {} }
  const kb = tgListKeyboard(q, page, pages, { rssN, rssRep, pumping });
  if (!rows.length) {
    const msg =
      (q.strictReal
        ? '✅ <b>Доказанно живых личных TG</b> по таким условиям в базе нет\n<i>(сюда попадают только профили, которых прогнали «Ревизию TG» на второй странице сайта, и только с вердиктом «юз жив». Не проверялся ≠ мёртв — таких тут нет намеренно)</i>.\n'
        : q.onlyVerified
        ? '✅ <b>Реальных личных TG</b> по таким условиям в базе нет\n<i>(каналы, группы и боты отсеяны; часть профилей ещё не классифицирована — полистай/повтори /list tg, бот допроверяет по ~12 за раз)</i>.\n'
        : '🟢 <b>Зелёных профилей</b> по таким условиям в базе нет.\n') +
      '<i>Кнопками ниже сдвинь квал / пол / сортировку или жал ↺ — фильтры сбрасываются.</i>\n' +
      (q.wrote === 'not'
        ? '<i>Включён фильтр «📭 только не писал»: он убирает лишь тех, кому УЖЕ светил хоть один аккаунт со страницы ④. Если там отметки сняли для всех — сдвинь кнопку ✍️ на «Писал: все».</i>\n'
        : '') +
      '<b>Полный вид:</b> <code>/list [tg|tg100] [рассылка] [кол-во] [сабы от-до] [слова]</code>\n'
      + '<b>Пример:</b> <code>/list 20 1000-50000 фитнес,йога</code> или <code>/list tg100 5000</code>';
    if (editMsgId) {
      try { await tgApi('editMessageText', { chat_id: chatId, message_id: editMsgId, text: msg, parse_mode: 'HTML', reply_markup: kb }); } catch (_) {
        try { await tgApi('editMessageText', { chat_id: chatId, message_id: editMsgId, text: tgStripHtml(msg), reply_markup: kb }); } catch (_) {}
      }
    } else {
      await tgSayHtml(chatId, msg, { reply_markup: kb });
    }
    return;
  }
  const fmtNum = (n) => (Number(n) || 0).toLocaleString('ru-RU');
  // Строки: «N. Инста: ник (ссылка)» / «сабов + квал-бейджи» / «ТГ: хэндл (ссылка спрятана, не юз — по айди)».
  // Бейджи — те же признаки, по которым фильтрится список: цвет строки в инсте и пол.
  const body = top
    .map((r, i) => {
      const owner = String(r.username || '').replace(/[^A-Za-z0-9._]/g, '');
      const head = `<b>${start + i + 1}.</b> Инста: <a href="https://www.instagram.com/${owner}">${owner}</a>`;
      const gen = r.gender === 'f' ? '👩' : r.gender === 'm' ? '👨' : '❔';
      const col = LIST_COLOR_EMOJI[r.color] || '';
      const subs = (r.followers != null ? `<code>${fmtNum(r.followers)}</code> сабов` : 'сабов: —') + `  ${col}${gen}`;
      const t = tgPretty(r.telegram);
      const tgLine = t ? `ТГ: <a href="${t.href}">${tgEsc(t.label)}</a>` : 'ТГ: —';
      return head + '\n' + subs + '\n' + tgLine;
    })
    .join('\n\n');
  const headLines = [`🟢 <b>${q.strictReal ? 'Живые юзы TG (100%)' : q.onlyVerified ? 'Реальные юзы TG' : 'Зелёные эксперты'}</b> · стр. <b>${page}/${pages}</b> <i>(${start + 1}–${start + top.length} из ${rows.length})</i>`];
  const subsTxt = `<code>${fmtNum(q.subsFrom)}${q.subsTo > 0 ? '–' + fmtNum(q.subsTo) : '+'}</code>`;
  const kwTxt = q.keywords && q.keywords.length ? `  ·  <b>Слова:</b> <code>${tgEsc(q.keywords.join(', '))}</code>` : '';
  headLines.push(`<b>Сабы:</b> ${subsTxt}${kwTxt}`);
  // Строка состояния кнопок — на случай, когда клавиатура ушла за экран (фильтр без
  // подписи выглядит как «бот сам решил показать странное»).
  const chips = [];
  if (q.stat !== 'all') chips.push(tgCycleItem(LIST_STAT_CYCLE, q.stat).t);
  if (q.gender !== 'all') chips.push(tgCycleItem(LIST_GENDER_CYCLE, q.gender).t);
  if (q.sort !== 'new') chips.push('сорт: ' + tgCycleItem(LIST_SORT_CYCLE, q.sort).t.toLowerCase());
  if (q.wrote !== 'all') chips.push(tgCycleItem(LIST_WROTE_CYCLE, q.wrote).t);
  if (chips.length) headLines.push('<b>Кнопки:</b> ' + chips.join(' · '));
  // Режим рассылки: говорим прямо, что это выборка «кому ещё не светили» и что у части
  // разбора нет (таким уйдёт компактная карточка, а не пустое сообщение).
  if (q.rss) headLines.push(`<b>📤 Рассылка:</b> ${rssN} лидов, из них с готовым разбором — ${rssRep}. Кому уже писал хоть с одного аккаунта — в список не попал.`);
  // «Просто /list» — подсвечиваем полный шаблон команды, чтобы было понятно, что дописывать.
  if (showHint) headLines.push('<b>Полный вид:</b> <code>/list [tg|tg100] [кол-во] [сабы от-до] [слова]</code>');
  // В tg-режиме честно говорим, что часть базы ещё без классификации (бюджет на рендер).
  if (q.onlyVerified && !q.strictReal && unclassified > 0) headLines.push(`<i>ещё ${unclassified} без проверки — повторите, бот доклассифицирует по ~${TG_LIST_CHECK_BUDGET} за раз</i>`);
  // В tg100-режиме не гадаем: непроверенные тут не показаны, но их надо назвать числом,
  // иначе пустой список выглядит как «ни у кого нет TG».
  if (q.strictReal && unchecked > 0) headLines.push(`<i>${unchecked} профилей(ей) с TG-ссылкой ещё не проходили ревизию на сайте — там их не режут, а проверяют</i>`);
  // Обычная (НЕ сворачиваемая) цитата: expandable требовал тыкать «показать» на каждой странице.
  const text = headLines.concat('', `<blockquote>${body}</blockquote>`).join('\n');
  const plain = tgStripHtml(text);
  if (editMsgId) {
    // «message is not modified» — Telegram отказывает, когда результат ровно тот же
    // (например, ↺ при уже дефолтных фильтрах). Дубликат в чат шить нельзя,
    // поэтому такой отказ считаем успехом, а все остальные — «сообщение не отредактировать».
    const notModified = (e) => /not modified|not changed/i.test(String((e && e.message) || ''));
    try {
      await tgApi('editMessageText', { chat_id: chatId, message_id: editMsgId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb });
      return;
    } catch (e) {
      if (notModified(e)) return;
      try {
        await tgApi('editMessageText', { chat_id: chatId, message_id: editMsgId, text: plain, disable_web_page_preview: true, reply_markup: kb });
        return;
      } catch (e2) {
        if (notModified(e2)) return;
      }
    }
  }
  try {
    await tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb });
  } catch (_) {
    await tgSay(chatId, plain, { disable_web_page_preview: true });
  }
}

// ================= /list рассылка: раздача готовых разборов подряд =================
// Бот НИЧЕГО не разбирает и лидам ничего не пишет: помпа просто шлёт В ЧАТ ВЛАДЕЛЬЦА
// уже готовые тексты автоанализа (igx_paa_job:*), по одному лиду за раз, с той же
// разбивкой на сообщения, что и tgPaReport. Выборка — tgListRows с фильтром «не писал»,
// поэтому повторить лида рассылка не может: кому светил хоть один аккаунт страницы ④ —
// тот в выборку не попадает.
let tgRssPumping = false; // один прогон на воркер; аларм только оживляет умерший

async function tgRssStateGet() {
  try { return (await chrome.storage.local.get(TG_RSS_STATE_KEY))[TG_RSS_STATE_KEY] || null; } catch (_) { return null; }
}
async function tgRssStateSave(st) {
  try { await chrome.storage.local.set({ [TG_RSS_STATE_KEY]: st }); } catch (_) {}
}
// Состояние читается помпой ПЕРЕД каждым лидом: «✖ Стоп» приходит отдельным апдейтом
// в тот же воркер, но перечитать storage — единственный способ честно поймать стоп
// посреди длинной пачки, не заводя общих переменных между контекстами.
async function tgRssStatePatch(patch) {
  const st = Object.assign({ on: false, stop: false, done: 0, total: 0, cur: 0, list: [], chatId: 0, msgId: 0, startedAt: 0, sent: 0, failed: 0 }, (await tgRssStateGet()) || {}, patch);
  await tgRssStateSave(st);
  return st;
}

// Одно сообщение-прогресс: правим его раз в 5 лидов, чтобы не упираться в лимит
// editMessageText (Telegram не любит частые правки одного и того же сообщения).
async function tgRssProgress(st, note) {
  if (!st.msgId || !st.chatId) return;
  const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
  const txt = '📤 <b>Рассылка разборов</b> · ' + st.done + '/' + st.total + ' (' + pct + '%)\n'
    + '<i>отправлено: ' + (st.sent || 0) + ' · сбоев: ' + (st.failed || 0) + '</i>\n'
    + (note ? tgRssNote(note) + '\n' : '')
    + '<i>✖ Стоп — кнопкой под списком /list. Проставленные отметки «писал» при этом не меняются: рассылка их не ставит.</i>';
  try { await tgApi('editMessageText', { chat_id: st.chatId, message_id: st.msgId, text: txt, parse_mode: 'HTML', disable_web_page_preview: true }); }
  catch (_) {
    try { await tgApi('editMessageText', { chat_id: st.chatId, message_id: st.msgId, text: tgStripHtml(txt), disable_web_page_preview: true }); } catch (_) {}
  }
}
function tgRssNote(s) { return tgEsc(String(s || '').slice(0, 200)); }

// Карточка лида, у которого разбора нет: пустое сообщение не шлём, но и молча пропускать
// нельзя — юзер решит, что лид «ушёл».
function tgRssCardHtml(row) {
  const owner = String(row.username || '').replace(/[^A-Za-z0-9._]/g, '');
  const links = ['IG: <a href="https://www.instagram.com/' + owner + '">' + owner + '</a>'];
  const t = tgPretty(row.telegram);
  if (t) links.push('TG: <a href="' + t.href + '">' + tgEsc(t.label) + '</a>');
  const fol = row.followers != null ? (Number(row.followers)).toLocaleString('ru-RU') + ' сабов' : 'сабов: —';
  const col = LIST_COLOR_EMOJI[row.color] || '';
  const gen = row.gender === 'f' ? '👩' : row.gender === 'm' ? '👨' : '❔';
  return '<b>📇 Карточка без разбора</b>\n' + links.join(' · ') + '\n' + col + gen + ' <code>' + fol + '</code>\n<i>Автоанализ этот профиль ещё не разбирал — текст разбора не готов.</i>';
}

// Имя для обращения — то же, что считает разбор (leadFirstName из qualify.js), а не
// догадка модели. В шапку оно попадает потому, что разборы, уже лежащие в базе,
// сгенерированы СТАРЫМ кодом (без блока «КАК ОБРАЩАТЬСЯ»): без этой строки юзер
// скопирует текст, где имя по-прежнему приходится выбирать самому.
function tgGreetLine(p) {
  let w = null;
  try { w = leadFirstName({ fullName: p && p.fullName, tgName: p && p.tgName, tgKind: p && p.tgKind }); } catch (_) {}
  if (!w || !w.name) return '👤 Имя: неизвестно — обращение без имени';
  return '👤 Имя: ' + tgEsc(w.name) + (w.like ? '' : ' (похоже на ник — можно без имени)')
    + (w.alt ? ' · НЕ брать: ' + tgEsc(w.alt) : '');
}

// Разбор одного лида = шапка-навигация + текст свёрнутыми цитатами (ровно как после
// автоанализа), либо компактная карточка. Возвращает число отправленных сообщений.
async function tgRssSendLead(chatId, row, job, s, p) {
  const gap = Math.max(400, Math.min(8000, (Number(s.delaySec) || 10) * 200));
  const owner = String(row.username || '');
  const t = tgPretty(row.telegram);
  const links = [];
  if (owner) links.push('IG: <a href="https://www.instagram.com/' + owner.replace(/[^A-Za-z0-9._]/g, '') + '">@' + tgEsc(owner) + '</a>');
  if (t) links.push('TG: <a href="' + t.href + '">' + tgEsc(t.label) + '</a>');
  const header = '<b>🧠 Разбор профиля</b>' + (links.length ? '\n' + links.join(' · ') : '') + '\n' + tgGreetLine(p) + '\n\n';
  const text = job && job.report ? String(job.report).trim() : '';
  if (!text) {
    await tgSayHtml(chatId, tgRssCardHtml(row));
    return 1;
  }
  const chunks = tgChunkText(tgEsc(text), TG_MSG_CHUNK - 400);
  const quote = (c) => '<blockquote expandable>' + c + '</blockquote>';
  const parts = chunks.map((c, i) => (i === 0 ? header + quote(c) : quote(c)));
  let sent = 0;
  for (let i = 0; i < parts.length; i++) {
    await tgSayHtml(chatId, parts[i]);
    sent++;
    if (i < parts.length - 1) await tgSleep(gap);
  }
  return sent;
}

// Главный цикл: идёт по списку ников из состояния, перед каждым лидом перечитывает
// storage (стоп/прогресс), после каждого — throttleMs со страницы ④.
async function tgRssPump() {
  if (tgRssPumping) return;
  const st0 = await tgRssStateGet();
  if (!st0 || !st0.on) return;
  tgRssPumping = true;
  let st = st0;
  try {
    const s = await getTgSettings();
    const all = await chrome.storage.local.get(null);
    const set = tgaccSettings(all);
    const reports = tgRssReportMap(all);
    const chatId = st.chatId || s.chatId;
    for (let i = Number(st.cur) || 0; i < (st.list || []).length; i++) {
      st = await tgRssStateGet() || st;
      if (!st.on || st.stop) break;
      const un = String(st.list[i] || '');
      if (!un) { await tgRssStatePatch({ cur: i + 1, done: (Number(st.done) || 0) + 1 }); continue; }
      const p = all['igx_profile:' + un.toLowerCase()] || null;
      // Квал для карточки считаем тем же qualifyAccount, что и списку /list: иначе
      // «карточка без разбора» показывала бы пустые бейджи там, где цвет строки известен.
      let color = '';
      let gender = '';
      if (p) { try { const qual = qualifyAccount(p, all, un); color = qual.color; gender = qual.gender; } catch (_) {} }
      const row = { username: un, telegram: (p && p.telegram) || '', followers: p ? Number(p.followers) || null : null, color, gender };
      const job = reports.get(un.toLowerCase()) || null;
      try {
        const sent = await tgRssSendLead(chatId, row, job, s, p);
        st = await tgRssStatePatch({ cur: i + 1, done: i + 1, sent: (Number(st.sent) || 0) + sent });
      } catch (e) {
        st = await tgRssStatePatch({ cur: i + 1, done: i + 1, failed: (Number(st.failed) || 0) + 1, note: String((e && e.message) || e) });
      }
      if ((i + 1) % 5 === 0 || i === st.total - 1) await tgRssProgress(st, st.note);
      await tgSleep(set.throttleMs);
    }
    st = await tgRssStateGet() || st;
    const fin = st.stop ? '⏹ Рассылка остановлена' : '✅ Рассылка закончена';
    await tgRssProgress(Object.assign({}, st, { total: st.total || st.done }), (st.stop ? 'остановлено вручную' : 'всем из выборки отправлено'));
    await tgRssStatePatch({ on: false, stop: false, finishedAt: Date.now(), finishedText: fin });
    try { await tgApi('editMessageText', { chat_id: st.chatId, message_id: st.msgId, text: fin + ' · ' + (st.done || 0) + '/' + (st.total || 0) + ' лидов, сообщений: ' + (st.sent || 0) + ', сбоев: ' + (st.failed || 0), disable_web_page_preview: true }); } catch (_) {}
  } finally {
    tgRssPumping = false;
    try { await chrome.alarms.clear(TG_RSS_ALARM); } catch (_) {}
  }
}

// Старт по кнопке «📤 Разослать разборы»: фиксируем список в storage СРАЗУ, чтобы
// перезапуск воркера продолжал с того же места (cur), а не начинал рассылку заново.
async function tgRssStart(chatId, q) {
  const cur = await tgRssStateGet();
  if (cur && cur.on) { await tgSay(chatId, 'Рассылка уже идёт: ' + (cur.done || 0) + '/' + (cur.total || 0) + '. Сначала «✖ Стоп».'); return; }
  const res = await tgListRows(q);
  let rows = res.rows || [];
  if (q.count > 0) rows = rows.slice(0, q.count);
  if (!rows.length) { await tgSay(chatId, 'Рассылать нечего: по этим условиям в базе нет лидов, которым ещё не писал. Сними фильтр «📭 Только не писал» или прогони проверку на странице ④.'); return; }
  const list = rows.map((r) => String(r.username || ''));
  const withRep = rows.reduce((n, r) => n + (r.hasReport ? 1 : 0), 0);
  await tgRssStateSave({ on: true, stop: false, done: 0, total: list.length, cur: 0, list, chatId, msgId: 0, startedAt: Date.now(), sent: 0, failed: 0, q });
  let msgId = 0;
  try {
    const r = await tgApi('sendMessage', { chat_id: chatId, text: '📤 Начинаю рассылку: ' + list.length + ' лидов (с готовым разбором — ' + withRep + ', остальным придёт карточка). Продвижение — в этом сообщении.', parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: '✖ Стоп рассылка', callback_data: 'rss:stop' }]] } });
    msgId = r && r.message_id ? Number(r.message_id) : 0;
  } catch (_) {}
  await tgRssStatePatch({ msgId });
  // Будильник: MV3 убивает воркер на паузе — аларм раз в 30с продолжает с st.cur.
  try { await chrome.alarms.create(TG_RSS_ALARM, { periodInMinutes: 0.5 }); } catch (_) {}
  // Помпа не должна блокировать поллинг апдейтов — уходим fire-and-forget, как tgPaReport.
  // (answerCallbackQuery уже отработал на входе в tgProcessBotUpdate.)
  tgRssPump();
}

async function tgHandleListCommand(chatId, text) {
  const q = tgParseListQuery(text);
  // Голый /list (без аргументов) — показываем под списком полную шпаргалку по команде.
  q.hint = text.trim().split(/\s+/).slice(1).length === 0;
  await tgRenderListPage(chatId, q, 1, null);
}

// Состояние последнего /list из storage + объяснимый ответ, если его нет
// (перезагрузка расширения, другой чат, бот обновился между нажатиями).
async function tgLoadListQ(chatId) {
  let q = null;
  try { q = (await chrome.storage.local.get('igx_list_q')).igx_list_q; } catch (_) {}
  if (!q) {
    await tgSay(chatId, 'Список уже «протух» (менялись фильтры?) — напиши /list заново.');
    return null;
  }
  return tgNormalizeListQ(q);
}

async function tgProcessBotUpdate(u) {
  if (u.callback_query) {
    const cb = u.callback_query;
    try { await tgApi('answerCallbackQuery', { callback_query_id: cb.id }); } catch (_) {}
    await tgRememberChat(cb.from, cb.message && cb.message.chat);
    const m = String(cb.data || '');
    if (m.startsWith('mode:')) {
      const mode = m.slice(5) === 'tg' ? 'tg' : 'site';
      await saveTgSettings({ mode });
      const chatId = cb.message && cb.message.chat ? cb.message.chat.id : null;
      if (chatId) {
        try {
          await tgApi('editMessageText', {
            chat_id: chatId,
            message_id: cb.message.message_id,
            text: `<b>Режим проверки:</b> ${mode === 'site' ? '🌐 Сайт (быстрый, без риска бана)' : '📱 ТГ (точный, через web.telegram.org)'}`,
            parse_mode: 'HTML',
            reply_markup: tgModeKeyboard(mode),
          });
        } catch (_) {}
      }
    }
    // Пагинация /list: [◀️][стр/всего][▶️] — фильтры берём из последнего запроса (igx_list_q).
    if (m.startsWith('listp:')) {
      const page = parseInt(m.slice(6), 10) || 1;
      const chatId = cb.message && cb.message.chat ? cb.message.chat.id : null;
      if (!chatId) return;
      const q = await tgLoadListQ(chatId);
      if (!q) return;
      if (q.page === page) return; // тыкнули край — ничего не меняем
      await tgRenderListPage(chatId, q, page, cb.message.message_id);
      return;
    }
    // Кнопки квала/пола/сортировки: сдвигаем значение на шаг цикла и перерисовываем
    // с первой страницы — под новым фильтром нумерация своя, старая страница бессмысленна.
    if (m === 'lsreset' || m.startsWith('lsc:')) {
      const chatId = cb.message && cb.message.chat ? cb.message.chat.id : null;
      if (!chatId) return;
      const q = await tgLoadListQ(chatId);
      if (!q) return;
      if (m === 'lsreset') {
        q.stat = 'all';
        q.gender = 'all';
        q.sort = 'new';
        // ↺ честный сброс ВСЕХ фильтров: иначе «только не писал» переживал сброс и юзер
        // видел урезанный список, думая что фильтр снят. Режим рассылки (q.rss) НЕ трогаем:
        // это не фильтр выдачи, а способ её отправить.
        q.wrote = 'all';
      } else {
        const what = m.slice(4);
        if (what === 's') q.stat = tgCycleNext(LIST_STAT_CYCLE, q.stat);
        else if (what === 'g') q.gender = tgCycleNext(LIST_GENDER_CYCLE, q.gender);
        else if (what === 'o') q.sort = tgCycleNext(LIST_SORT_CYCLE, q.sort);
        else if (what === 'w') q.wrote = tgCycleNext(LIST_WROTE_CYCLE, q.wrote);
      }
      await tgRenderListPage(chatId, q, 1, cb.message.message_id, true);
      return;
    }
    // Рассылка: «📤 Разослать разборы» стартует помпу, «✖ Стоп» рвёт цикл на ближайшем лиде.
    if (m === 'rss:go' || m === 'rss:stop') {
      const chatId = cb.message && cb.message.chat ? cb.message.chat.id : null;
      if (!chatId) return;
      if (m === 'rss:stop') {
        const st = await tgRssStateGet();
        if (!st || !st.on) { await tgSay(chatId, 'Рассылка и так не идёт.'); return; }
        await tgRssStatePatch({ stop: true });
        await tgSay(chatId, '⏹ Останавливаю на текущем лиде: ' + (st.done || 0) + '/' + (st.total || 0) + ' уже ушло.');
        return;
      }
      const q = await tgLoadListQ(chatId);
      if (!q) return;
      await tgRssStart(chatId, q);
      return;
    }
    return;
  }

  const msg = u.message;
  if (!msg || msg.text == null) return;
  const chatId = msg.chat.id;
  const text = msg.text;

  // Запоминаем последний чат, писавший боту — для кнопки «Привязать мой ТГ»
  await chrome.storage.local.set({ igx_tg_lastchat: chatId });
  await tgRememberChat(msg.from, msg.chat);

  // Регистрация чата
  const s = await getTgSettings();
  if (!s.chatId) await saveTgSettings({ chatId });

  if (/^\/start/.test(text)) {
    await tgSayHtml(chatId, '👋 <b>Готов к работе.</b>\n\n' + tgHelpText());
    return;
  }
  if (/^\/help/.test(text)) {
    await tgSayHtml(chatId, tgHelpText());
    return;
  }
  if (/^\/mode/.test(text)) {
    const cur = await getTgSettings();
    await tgSayHtml(chatId, `🛠 <b>Режим проверки:</b> ${cur.mode === 'site' ? '🌐 Сайт' : '📱 ТГ'}. Выбери:`, { reply_markup: tgModeKeyboard(cur.mode) });
    return;
  }
  if (/^\/st/.test(text)) {
    const parts = text.trim().split(/\s+/).slice(1);
    const cur = await getTgSettings();
    if (parts.length >= 1) {
      const patch = {};
      const lim = parseInt(parts[0], 10);
      if (lim > 0) patch.msgLimit = Math.min(200, lim);
      const del = parseFloat(parts[1]);
      if (del > 0) patch.delaySec = Math.min(300, del);
      patch.safeMode = false; // ручная настройка выключает авто-режим
      const next = await saveTgSettings(patch);
      await tgSayHtml(chatId, `✅ <b>Настройки сохранены:</b> читать <code>${next.msgLimit}</code> сообщений, задержка <code>${next.delaySec}</code> с.\n<i>Безопасный режим выключен.</i>`);
    } else {
      await tgSayHtml(chatId, `📊 <b>Сейчас:</b> читать <code>${cur.msgLimit}</code> сообщений, задержка <code>${cur.delaySec}</code> c, безопасный режим <b>${cur.safeMode ? 'вкл' : 'выкл'}</b>.\n<b>Использование:</b> <code>/st [сообщений] [задержка сек]</code> · <b>пример:</b> <code>/st 20 10</code>`);
    }
    return;
  }
  if (/^\/list\b/i.test(text)) {
    await tgHandleListCommand(chatId, text);
    return;
  }

  // Ссылки t.me / telegram.me
  const links = [];
  for (const m of text.matchAll(/(?:t\.me|telegram\.me)\/(\+?[A-Za-z0-9_]{3,64})/gi)) {
    let t = m[1];
    if (!/^\+/.test(t)) {
      t = t.toLowerCase();
      if (TG_RESERVED_USERS.has(t)) continue;
    }
    if (!links.includes(t)) links.push(t);
  }
  if (links.length) {
    await tgSayHtml(chatId, `📥 Принял <b>${links.length}</b>. Проверяю в режиме <b>${s.mode === 'site' ? '🌐 сайт' : '📱 тг'}</b>…`);
    for (const t of links) tgQueueBotCheck(t, chatId);
    return;
  }

  await tgSayHtml(chatId, '🤔 Не понял. Кидай ссылку <code>t.me/...</code>, команду <code>/list</code> или <code>/help</code>');
}

let tgPolling = false;
async function tgPollOnce() {
  if (tgPolling) return false;
  tgPolling = true;
  let got = 0;
  try {
    const s = await getTgSettings();
    if (!s.token) return false;
    const offData = await chrome.storage.local.get(TG_OFFSET_KEY);
    const offset = offData[TG_OFFSET_KEY] || 0;
    const updates = await tgApi('getUpdates', { offset, timeout: 20, allowed_updates: ['message', 'callback_query'] });
    got = updates.length;
    // Watermark фиксируем ДО обработки: если воркер убьют посреди разбора,
    // апдейт не пройдёт второй раз (двойной ответ бота хуже, чем недосыл).
    if (updates.length) {
      let maxId = offset - 1;
      for (const u of updates) if (u.update_id > maxId) maxId = u.update_id;
      if (maxId + 1 > offset) await chrome.storage.local.set({ [TG_OFFSET_KEY]: maxId + 1 });
    }
    for (const u of updates) {
      try {
        await tgProcessBotUpdate(u);
      } catch (_) {}
    }
  } catch (_) {
    // токен неверный / сеть — молча ждём следующего цикла
  } finally {
    tgPolling = false;
  }
  return got > 0;
}

// Непрерывный цикл поллинга: бот отвечает за 1–2 секунды, а не раз в 30.
// Аларм оставлен как страховка на случай, если воркер прибьют.
let tgPollLoopActive = false;
async function tgPollLoop() {
  if (tgPollLoopActive) return;
  tgPollLoopActive = true;
  try {
    while (true) {
      const s = await getTgSettings();
      if (!s.token) break;
      try {
        await tgPollOnce();
      } catch (_) {}
      await tgSleep(2000);
    }
  } finally {
    tgPollLoopActive = false;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TG_POLL_ALARM) tgPollLoop();
  // Будильник рассылки: если воркер убили посреди пачки, продолжаем с сохранённого st.cur
  // (помпа сама выйдет, если state.on уже снят).
  if (alarm.name === TG_RSS_ALARM) { try { tgRssPump(); } catch (_) {} }
});

function tgEnsureAlarm() {
  chrome.alarms.create(TG_POLL_ALARM, { periodInMinutes: 0.5 });
}
tgEnsureAlarm();
// Запускаем цикл сразу, не дожидаясь первого аларма
tgPollLoop();

// ---------- диагностика: пошагово показывает, где именно рвётся ----------
async function tgDiagnose() {
  const lines = [];
  const s = await getTgSettings();
  lines.push(`настройки: режим=${s.mode}, msgLimit=${s.msgLimit}, delay=${s.delaySec}с, chatId=${s.chatId || 'не привязан'}, токен=${s.token ? 'задан' : 'НЕТ'}`);
  lines.push('');

  // 1. Бот
  try {
    const me = await tgApi('getMe', {});
    lines.push(`[1] Бот: ОК (@${me.username})`);
  } catch (e) {
    lines.push(`[1] Бот: ОШИБКА — ${e.message || e} (токен/сеть до api.telegram.org)`);
  }

  // 2. Вкладка скана
  let tabId = null;
  try {
    tabId = await tgGetScanTab();
    const t = await chrome.tabs.get(tabId);
    lines.push(`[2] Вкладка скана: id=${tabId}, url=${t.url}, статус=${t.status}`);
  } catch (e) {
    lines.push(`[2] Вкладка скана: ОШИБКА — ${e.message || e}`);
  }

  // 3. Скан t.me/s из вкладки (тот же путь, что и обычный браузер)
  if (tabId != null) {
    try {
      const okNav = await tgNavigateScanTab(tabId, 'https://t.me/s/durov');
      if (!okNav) {
        const t2 = await chrome.tabs.get(tabId).catch(() => null);
        lines.push(`[3] вкладка НЕ смогла открыть t.me/s/durov (url=${t2 ? t2.url : '?'}, статус=${t2 ? t2.status : '?'}) — сеть/блокировка`);
      } else {
        const d = await tgExtractScanTab(tabId, 5);
        if (!d) lines.push('[3] страница открылась, но DOM не читается (executeScript)');
        else lines.push(`[3] t.me/s из вкладки: ОК — канал=${d.isChannel}, «${d.title}», постов: ${d.posts.length}`);
      }
    } catch (e) {
      lines.push(`[3] t.me/s из вкладки: ОШИБКА — ${e.message || e}`);
    }
  }

  // 4. Прямой fetch из воркера (для сравнения — так раньше и работало)
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch('https://t.me/durov', { credentials: 'omit', signal: ctrl.signal, headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
    clearTimeout(timer);
    lines.push(`[4] fetch напрямую из воркера: статус ${res.status}`);
  } catch (e) {
    lines.push(`[4] fetch напрямую из воркера: ОШИБКА — ${e.message || e} (скорее всего, не идёт через твой VPN)`);
  }

  return lines.join('\n');
}

// ---------- сообщения из content/popup для Telegram-блока ----------
async function handleTgMessage(msg, sendResponse) {
  if (msg.type === 'tgGetSettings') {
    sendResponse(await getTgSettings());
    return true;
  }
  if (msg.type === 'tgSaveSettings') {
    sendResponse(await saveTgSettings(msg.patch || {}));
    return true;
  }
  if (msg.type === 'tgVerify') {
    // Слой доказательности пишет ТОЛЬКО воркер (tgWriteReal): content.js не должен
    // заново изобретать правило «unknown не перетирает решительный вердикт».
    try {
      const res = await tgVerify(msg.username);
      if (msg.igUsername && res && res.verdict) {
        try { await tgWriteReal('igx_profile:' + String(msg.igUsername).toLowerCase(), res.verdict); } catch (_) {}
      }
      sendResponse(res);
    } catch (e) {
      sendResponse({ exists: null, error: String((e && e.message) || e) });
    }
    return true;
  }
  if (msg.type === 'tgResolvePhone') {
    // Номер из шапки инсты -> поиск реального @юза в web.telegram.org.
    (async () => {
      try {
        const res = await tgResolvePhone(msg.phone);
        // найденный по номеру юз доказан живой web-сессией — это самый сильный
        // канал из трёх, поэтому пишем его сразу в слой доказательности
        if (msg.igUsername && res && res.found && res.tgKind) {
          await tgWriteReal('igx_profile:' + String(msg.igUsername).toLowerCase(), tgRealFromKind(res.tgKind, res.tgKind === 'user' ? 'webtg' : 'tme'));
        }
        sendResponse(res);
      } catch (e) { sendResponse({ ok: false, error: String(e.message || e) }); }
    })();
    return true;
  }
  if (msg.type === 'tgRecheckPhone') {
    // Ремонт базы: перепроверить один профиль, где TG пришёл из поиска по номеру.
    (async () => {
      try {
        const key = 'igx_profile:' + String(msg.username || '').toLowerCase();
        const res = await tgRecheckPhoneOne(key);
        sendResponse(res);
      } catch (e) { sendResponse({ skipped: 'err', error: String(e.message || e) }); }
    })();
    return true;
  }
  if (msg.type === 'tgRecheckHandle') {
    // Сплошная перепроверка одного TG-юза через превью t.me (снять несуществующие).
    (async () => {
      try {
        const key = 'igx_profile:' + String(msg.username || '').toLowerCase();
        const res = await tgRecheckHandleOne(key);
        sendResponse(res);
      } catch (e) { sendResponse({ skipped: 'err', error: String(e.message || e) }); }
    })();
    return true;
  }
  if (msg.type === 'tgResolveHandle') {
    // Дубль: пробуем ник из инсты как @юзернейм в ТГ.
    (async () => {
      try {
        const res = await tgResolveHandle(msg.handle, msg.igName);
        // найденный по дублю ника хэндл promoted в «реальный» ТОЛЬКО если имя в
        // карточке TG совпало с IG (corroborated). Иначе не пишем real-слой — пусть
        // остаётся спекуляцией (не в списках/окнах), а не «доказанной личкой».
        if (msg.igUsername && res && res.found && res.tgKind === 'user' && res.corroborated) {
          await tgWriteReal('igx_profile:' + String(msg.igUsername).toLowerCase(), tgRealFromKind('user', 'tme'));
        }
        sendResponse(res);
      } catch (e) { sendResponse({ ok: false, error: String(e.message || e) }); }
    })();
    return true;
  }
  if (msg.type === 'tgProbeSite') {
    // Скрап своего сайта/таплинка: телефон/WA/tg, опубликованные владельцем.
    (async () => {
      try { sendResponse(await tgProbeSite(msg.url)); }
      catch (e) { sendResponse({ ok: false, phones: [], waNumbers: [], tgCandidates: [], error: String(e.message || e) }); }
    })();
    return true;
  }
  if (msg.type === 'tgOpenApp') {
    // Открыть чат/канал в приложении Телеграм на ПК (протокол tg://).
    (async () => {
      try {
        const ok = await tgOpenApp(msg.domain, true); // явный клик пользователя — открываем всегда
        sendResponse({ ok });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }
  if (msg.type === 'tgClassifyLinks') {
    // Для кнопок ссылок у авы: определяем тип каждой (личка/канал) через Bot API.
    (async () => {
      const result = {};
      for (const t of (msg.targets || []).slice(0, 8)) {
        try {
          result[t] = await tgClassify(t);
        } catch (_) {
          result[t] = null;
        }
      }
      sendResponse({ ok: true, result });
    })();
    return true;
  }
  if (msg.type === 'tgDiagnose') {
    (async () => {
      try {
        sendResponse({ ok: true, report: await tgDiagnose() });
      } catch (e) {
        sendResponse({ ok: false, report: `Диагностика упала: ${e.message || e}` });
      }
    })();
    return true;
  }
  if (msg.type === 'tgCheck') {
    // Полная проверка с прогрессом (клик по галочке в списке)
    try {
      const r = await tgCheckTarget(msg.target, msg.mode || null, {});
      if (r.ok) {
        await tgSendReport(msg.target, r, msg.instaUrl || null, true);
        sendResponse({ ok: true, sent: true });
      } else {
        sendResponse({ ok: false, error: r.error });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
    return true;
  }
  if (msg.type === 'tgReportLead') {
    // Автоотчёт при обнаружении лида из Instagram.
    // Кидаем юз КАЖДОГО, у кого нашлась TG-ссылка: даже если скан не смог подтвердить
    // существование (личка/приват/сеть), лид не должен теряться.
    try {
      const s = await getTgSettings();
      if (s.autoReport && s.chatId && msg.username && msg.telegram) {
        // ГЛАВНЫЙ фильтр по сабам: пороги хранятся в storage, поэтому режем здесь,
        // в воркере — фоновые вкладки автопроверки свой фильтр не видят (у них он всегда 0).
        const minData = await chrome.storage.local.get(['igx_min_followers', 'igx_max_followers']);
        const minF = parseInt(minData.igx_min_followers, 10) || 0;
        const maxF = parseInt(minData.igx_max_followers, 10) || 0;
        if (minF > 0 && msg.followers != null && msg.followers < minF) {
          sendResponse({ ok: true }); // не прошёл порог — в бота не кидаем
          return true;
        }
        if (maxF > 0 && msg.followers != null && msg.followers > maxF) {
          sendResponse({ ok: true }); // выше максимума — тоже не кидаем
          return true;
        }
        const tgUser = msg.telegram.replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, '').replace(/^\//, '');
        let r = null;
        try {
          // Автоотчёт ходит ТОЛЬКО через Bot API. Браузерный скан здесь запрещён:
          // он открывал t.me, и у личек редирект на превью дёргал tg:// — само открывалось приложение ТГ.
          r = await tgApiCheck(tgUser);
        } catch (_) {}
        if (r && r.ok && r.exists !== false) {
          // Запомнить тип TG в записи профиля (getChat надёжно различает канал/личку) —
          // база накапливает tgKind, /list tg фильтрует по нему без повторных проверок.
          if (typeof r.isChannel === 'boolean') {
            try {
              const pk = 'igx_profile:' + String(msg.username || '').toLowerCase();
              const cur = await chrome.storage.local.get(pk);
              if (cur[pk]) await chrome.storage.local.set({ [pk]: Object.assign({}, cur[pk], { tgKind: r.isChannel ? 'channel' : 'user', tgExists: true }) });
            } catch (_) {}
          }
          await tgSendReport(tgUser, r, msg.username, false, msg.followers, msg.username ? 'igx_profile:' + String(msg.username).toLowerCase() : '');
        } else {
          // Bot API не подтвердил — проверяем существование превью t.me (fetch в воркере,
          // без вкладок). Мёртвый юз: в бота НЕ кидаем, в базе помечаем tgKind:'none'
          // (обычный /list его тоже не покажет).
          let kind = null;
          try {
            const info = tgHandleInfo(tgUser);
            if (info.handle) kind = await tgClassifyHandle(info.handle);
          } catch (_) {}
          if (kind === 'none') {
            try {
              const pk = 'igx_profile:' + String(msg.username || '').toLowerCase();
              const cur = await chrome.storage.local.get(pk);
              if (cur[pk]) await chrome.storage.local.set({ [pk]: Object.assign({}, cur[pk], { tgKind: 'none', tgExists: false }) });
            } catch (_) {}
          } else {
            if (kind === 'user' || kind === 'channel' || kind === 'bot') {
              try {
                const pk = 'igx_profile:' + String(msg.username || '').toLowerCase();
                const cur = await chrome.storage.local.get(pk);
                if (cur[pk]) await chrome.storage.local.set({ [pk]: Object.assign({}, cur[pk], { tgKind: kind, tgExists: true }) });
              } catch (_) {}
            }
            // Живой (или не опознанный) — кидаем сам найденный юз как контакт (с пометкой «не подтверждён»).
            const clean = String(tgUser).replace(/^@/, '').toLowerCase();
            const out = { users: new Set([clean]), invites: new Set(), instagram: new Set() };
            await tgSendReport(tgUser, { ok: true, exists: null, out }, msg.username, false, msg.followers, msg.username ? 'igx_profile:' + String(msg.username).toLowerCase() : '');
          }
        }
      }
      sendResponse({ ok: true });
    } catch (_) {
      sendResponse({ ok: false });
    }
    return true;
  }
    if (msg.type === 'tgProfileInfo') {
    // Карточка TG-профиля для разбора: имя/@юз/описание со страницы t.me.
    // Только чтение — ни решений, ни записей.
    (async () => {
      const hi = tgHandleInfo(String(msg.raw || ''));
      const info = hi && hi.handle ? await tgProfileCard(hi.handle) : null;
      sendResponse({ ok: !!info, info: info || null });
    })();
    return true;
  }
  if (msg.type === 'tgkProbe') {
    // ТГК-пробник для автоанализа: «этот контакт — личка или канал?», а если канал —
    // быстро выловить личный @юзернейм из описания/закрепа/последних постов канала
    // (t.me/s, первая страница — там закреп и свежие посты уже есть). Только решает,
    // в профили НЕ пишет — владельцем записи остаётся дашборд, как и у tgVerifyHandles.
    (async () => {
      const entries = Array.isArray(msg.entries) ? msg.entries.slice(0, 40) : [];
      const wantUser = msg.wantUser !== false; // режим «не разбирать»: только классификация, без /s/
      const posts = Math.min(30, Math.max(3, Number(msg.posts) || 10));
      const results = [];
      for (const e of entries) {
        const raw = String(e.raw || '');
        const m = raw.match(/(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{2,31})/i) || raw.match(/^@?([A-Za-z][A-Za-z0-9_]{2,31})$/);
        const handle = m ? m[1].toLowerCase() : null;
        if (!handle || /joinchat|\/t\//i.test(raw)) { results.push({ key: e.key, handle: handle || '', kind: 'private', user: '' }); continue; }
        if (/_bot$/.test(handle)) { results.push({ key: e.key, handle, kind: 'bot', user: '' }); continue; }
        let kind = null;
        try { kind = await tgClassifyHandle(handle); } catch (_) {}
        const r = { key: e.key, handle, kind: kind || 'unknown', user: '' };
        if (!kind) r.why = tgLastClassifyDiag || 't.me не ответил';
        if (kind === 'channel' && wantUser) {
          try {
            const sc = await tgScanSite(handle, { msgLimit: posts }, true);
            if (sc && sc.ok && sc.out && sc.out.users.size) {
              let tries = 0;
              for (const cand of sc.out.users) {
                if (tries++ >= 6) break; // дешёвая квота: не перебираем всю опись канала
                const c = String(cand || '').replace(/^@/, '').toLowerCase();
                if (!c || c === handle || /_bot$/.test(c)) continue;
                let ck = null;
                try { ck = await tgClassifyHandle(c); } catch (_) {}
                if (ck === 'user') { r.user = c; break; }
              }
            }
          } catch (_) {}
        }
        results.push(r);
        await tgSleep(250); // t.me без конвейера
      }
      sendResponse({ ok: true, results });
    })();
    return true;
  }
  if (msg.type === 'tgVerifyHandles') {
    // Массовая ревизия «жив ли TG»: дашборд гонит пачками, потому что MV3-воркер
    // без активности живёт ~30 с, а проход по 5k профилям — десятки минут. Здесь
    // только оракул + запись вердикта; курсор, итоги и «стоп» принадлежат дашборду
    // (один владелец правды), поэтому состояние тут только ЧИТАЕТСЯ.
    (async () => {
      const entries = Array.isArray(msg.entries) ? msg.entries.slice(0, 40) : [];
      const mode = TG_VERIFY_MODES.indexOf(msg.mode) >= 0 ? msg.mode : 'tme';
      const throttleMs = Math.min(5000, Math.max(120, Number(msg.throttleMs) || 700));
      let webtgLeft = Math.max(0, Number(msg.webtgLeft) || 0);
      const out = { ok: true, done: 0, real: 0, dead: 0, unknown: 0, channel: 0, bot: 0, stopped: false, errors: [], webtgLeft: 0, results: [] };
      if (mode === 'off') {
        // ярлык без доказательств не раздаём: прогон в этом режиме не запускается,
        // но если пришёл — ничего не пишем и честно говорим почему
        sendResponse(Object.assign(out, { ok: false, error: 'проверка выключена (режим «не проверять»)' }));
        return;
      }
      for (const e of entries) {
        const st = await readTgRevState();
        if (st && st.stopped) { out.stopped = true; break; }
        const key = e.key || ('igx_profile:' + String(e.username || '').toLowerCase());
        const raw = e.telegram || e.handle;
        let v = await tgVerifyHandleOnce(raw);
        let noteWeb = '';
        // web-сессия добивает в ПЕРВУЮ очередь то, что анонимный t.me не определил
        // (личные юзы без публичного превью вечно висели «проверить не удалось»),
        // и заодно подтверждает «живых» — всё в пределах бюджета webtgLeft.
        if (mode === 'webtg' && webtgLeft > 0 && (v.real === 'unknown' || v.real === true)) {
          webtgLeft--;
          const c = await tgConfirmViaWeb(raw);
          if (c.use) v = c.verdict;
          else noteWeb = ' (web-сессия не ответила: ' + (c.why || 'нет ответа') + ')';
        }
        if (noteWeb) v = Object.assign({}, v, { why: String(v.why || 'доказано превью t.me') + noteWeb });
        const wrote = await tgWriteReal(key, v);
        if (!wrote) { out.errors.push(key + ': профиль пропал из базы во время проверки'); continue; }
        out.done++;
        // итоги по каждому профилю нужны дашборду для drill-down в истории («кто именно
        // умер»); агрегатные счётчики выше остаются единственным источником итогов прогона
        out.results.push({ u: String(e.username || ''), r: v.real === true ? 'real' : v.real === false ? 'dead' : 'unknown', k: v.kind || '' });
        if (v.real === true) out.real++;
        else if (v.real === 'unknown') out.unknown++;
        else { out.dead++; if (v.kind === 'channel') out.channel++; else if (v.kind === 'bot') out.bot++; }
        await tgSleep(throttleMs);
      }
      out.webtgLeft = webtgLeft;
      sendResponse(out);
    })();
    return true;
  }
  if (msg.type === 'tgPaReport') {
    // Готовый разбор профиля из автоанализа — в Telegram. Сверху — шапка-навигация
    // (ссылки на Instagram и Telegram), ниже сам текст прячется в свёрнутую цитату
    // (<blockquote expandable>), чтобы простыня не шла открытой. Не влезло в одно
    // сообщение — каждое следующее тоже чистая свёрнутая цитата.
    (async () => {
      try {
        const s = await getTgSettings();
        if (!s.chatId) { sendResponse({ ok: false, error: 'бот не привязан (chat_id пуст)' }); return; }
        const text = String(msg.text || '').trim();
        if (!text) { sendResponse({ ok: false, error: 'разбор пустой — отправлять нечего' }); return; }
        const u = String(msg.username || '').replace(/^@/, '');
        const tgRaw = String(msg.telegram || '');
        const tgHandle = tgRaw
          .replace(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i, '')
          .replace(/^@/, '').replace(/[/?#].*$/, '').trim();
        const links = [];
        if (u) links.push('IG: <a href="https://www.instagram.com/' + tgEsc(u) + '/">@' + tgEsc(u) + '</a>');
        if (tgHandle) links.push('TG: <a href="https://t.me/' + tgEsc(tgHandle) + '">@' + tgEsc(tgHandle) + '</a>');
        // Имя в шапке: на этот текст потом опирается и рассылка, и человек — пусть
        // будет посчитано кодом, а не выбрано моделью из двух кандидатов.
        let greet = '';
        try {
          const pkey = 'igx_profile:' + u.toLowerCase();
          const prec = (await chrome.storage.local.get(pkey))[pkey] || null;
          greet = tgGreetLine(prec);
        } catch (_) {}
        const header = '<b>🧠 Разбор профиля</b>' + (links.length ? '\n' + links.join(' · ') : '') + (greet ? '\n' + greet : '') + '\n\n';
        // Запас: обёртка цитаты (~34) + шапка первого сообщения + раздувание от tgEsc.
        const chunks = tgChunkText(tgEsc(text), TG_MSG_CHUNK - 400);
        const quote = (c) => '<blockquote expandable>' + c + '</blockquote>';
        const parts = chunks.map((c, i) => (i === 0 ? header + quote(c) : quote(c)));
        const gap = Math.max(400, Math.min(8000, (Number(s.delaySec) || 10) * 200));
        let sent = 0;
        let failed = '';
        for (let i = 0; i < parts.length; i++) {
          try {
            await tgSayHtml(s.chatId, parts[i]);
            sent++;
          } catch (e) {
            failed = String((e && e.message) || e);
            break;
          }
          if (i < parts.length - 1) await tgSleep(gap);
        }
        sendResponse({ ok: sent > 0 && !failed, sent, total: parts.length, chars: text.length, error: failed || null });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  if (msg.type === 'tgDeepCheck') {
    // Глубокая проверка: ищем ЛИЧКУ внутри найденного Telegram.
    // Порядок внутри одного таргета: описание -> закрепы -> сообщения (по возможностям режима).
    // Сначала чекаем первую ссылку; если лички нет — идём по остальным TG-ссылкам аккаунта.
    (async () => {
      // Страховка: проверка не может висеть дольше 75 секунд.
      let finished = false;
      const failSafe = setTimeout(() => {
        if (!finished) {
          finished = true;
          sendResponse({ ok: false, error: 'Таймаут 75с — не успел (медленная сеть). Попробуй ещё раз.' });
        }
      }, 75000);
      const done = (payload) => {
        if (finished) return;
        finished = true;
        clearTimeout(failSafe);
        sendResponse(payload);
      };
      try {
        const s = await getTgSettings();
        const targets = [];
        const pushT = (url) => {
          const t = tgTargetFromUrl(url);
          if (t && !targets.includes(t)) targets.push(t);
        };
        pushT(msg.telegram);
        (msg.telegrams || []).forEach(pushT);
        if (!targets.length) {
          done({ ok: false, error: 'TG-ссылка не найдена.' });
          return;
        }

        // Сначала классифицируем ссылки: ЛИЧНЫЕ аккаунты чекаем раньше каналов.
        // Быстрый путь — Bot API (работает даже при блокировке t.me); браузер только если API молчит.
        const classified = [];
        for (const target of targets.slice(0, 4)) {
          let cls = null;
          try {
            cls = await tgApiCheck(target);
          } catch (_) {}
          if (!cls || !cls.ok) {
            try {
              cls = await tgScanSite(target, s, true);
            } catch (_) {}
          }
          classified.push({
            target,
            exists: cls && cls.ok ? cls.exists : null,
            isChannel: cls && cls.ok && !cls.privateOnly ? cls.isChannel : undefined,
            apiResult: cls && cls.ok && cls.viaApi ? cls : null,
          });
          await tgSleep(150);
        }
        const rank = (c) => (c.isChannel === false ? 0 : c.isChannel === undefined ? 1 : 2);
        classified.sort((a, b) => rank(a) - rank(b));

        let users = [];
        let scanned = 0;
        let personalHit = false; // личка = сам аккаунт, а не юз внутри канала
        const errors = []; // реальные причины по каждому таргету — чтобы не молчать «не найдено»
        for (const c of classified) {
          const target = c.target;
          if (c.exists === false) {
            errors.push(`@${target}: не существует (t.me не подтверждает).`);
            continue;
          }
          // Личный аккаунт — сам юз и есть личка, внутрь лезть не надо.
          if (c.isChannel === false && !/^\+/.test(target)) {
            users = [target];
            personalHit = true;
            scanned++;
            break;
          }
          let r;
          if (c.apiResult) {
            // Уже есть результат из Bot API — не лезем в браузер повторно.
            r = c.apiResult;
          } else {
            try {
              r = await tgCheckTarget(target, null, {});
            } catch (e) {
              r = { ok: false, error: String(e.message || e) };
            }
          }
          scanned++;
          if (!r.ok) errors.push(`@${target}: ${r.error || 'ошибка скана'}`);
          if (r.ok && r.out) {
            users = Array.from(r.out.users);
            if (users.length) break;
          }
          // Небольшая пауза между таргетами
          await tgSleep(600 + Math.random() * 600);
        }

        // Юзы считаем за личку, только если они реально существуют (макс 3 — ради скорости)
        const verified = await tgVerifyUsers(users, 3);

        // Записываем результат в профиль — в списке загорится золотым
        const key = `igx_profile:${String(msg.igUsername || '').toLowerCase()}`;
        const data = await chrome.storage.local.get(key);
        const profile = data[key] || {};
        profile.tgContacts = verified;
        profile.tgDeepCheckedAt = Date.now();
        await chrome.storage.local.set({ [key]: profile });

        // Отчёт в ТГ — только если реально что-то нашлось (подписчики ИГ — сразу под юзом)
        if (verified.length && s.chatId) {
          const f = Number(profile.followers);
          const lines = [
            `@${String(msg.igUsername || '').replace(/^@/, '')} — личка в TG найдена`,
            isFinite(f) && f > 0 ? `Подписчиков в ИГ: ${f.toLocaleString('ru-RU')}` : null,
            `Найдено контактов: ${verified.length}`,
            ...verified.map((c) => '@' + c),
            '',
            `Инста: https://instagram.com/${msg.igUsername}`,
          ].filter((l) => l !== null);
          await tgSay(s.chatId, lines.join('\n'));
        }

        // Открыть результат в приложении Телеграм (если пользователь не выключил автооткрытие):
        // нашли личку эксперта — открываем её; нашли юзов внутри канала — чат с ботом (отчёт там).
        const autoData = await chrome.storage.local.get('igx_auto_open_tg');
        const autoOpen = autoData.igx_auto_open_tg !== false; // по умолчанию включено
        let openedPersonal = false;
        let openedBot = false;
        if (autoOpen && verified.length) {
          if (personalHit) openedPersonal = await tgOpenApp(verified[0]);
          else openedBot = await tgOpenApp(await tgBotUsername());
        } else if (autoOpen && errors.length && !classified.some((c) => c.isChannel === true)) {
          // Совсем ничего не проверилось и ни одна ссылка не подтвердилась как канал —
          // лучше открыть первую ссылку в ТГ, чем молча сказать «не найдено».
          openedPersonal = await tgOpenApp(targets[0]);
        }

        done(
          verified.length
            ? { ok: true, contacts: verified, scanned, openedPersonal, openedBot }
            : {
                ok: false,
                contacts: [],
                scanned,
                openedPersonal,
                error: errors.length
                  ? errors.slice(0, 3).join('\n') +
                    (openedPersonal ? '\nОткрыл первую ссылку в ТГ — проверь глазами.' : '\nПодсказка: 1 клик по ⚡ сразу открывает ссылку в ТГ.')
                  : 'Проверил все ссылки — лички внутри не нашлось.',
              }
        );
      } catch (e) {
        done({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }
  if (msg.type === 'tgBanAlert') {
    // «Instagram забанил, а ферма продолжала работать всю ночь» — предупреждение
    // существовало, но жило только на странице дашборда: если дашборд не открыт (или
    // автопилот листа ⑤ выключен), человек про блок не узнавал вовсе. Теперь контент
    // шлёт это сообщение на ПЕРВОМ бан-остывании. Дедуп по времени — чтобы N окон
    // не выстроились в очередь уведомлений: одна карточка на полчаса.
    (async () => {
      try {
        const s = await getTgSettings();
        if (!s.chatId) return sendResponse({ ok: false, error: 'no-chat' });
        const KEY = 'igx_ban_alert_at';
        const cur = await chrome.storage.local.get(KEY);
        const last = Number(cur && cur[KEY]) || 0;
        const now = Date.now();
        if (now - last < 1800000) return sendResponse({ ok: true, deduped: true });
        await chrome.storage.local.set({ [KEY]: now });
        const why = String(msg.why || 'Instagram показывает экран блокировки');
        // «Кто говорил» и «что будет» обязательны: без вкладки карточка непонятна при 2+
        // окнах, а прежняя строка наврала про «паузу 15 мин» даже там, где прогон уже
        // честно остановили. Теперь вердикт приходит от того решения, которое цикл принял.
        const owner = String(msg.owner || '').replace(/^@+/, '').trim();
        const verdict = String(msg.verdict || '').trim();
        const lines = [
          '🛑 Instagram заблокировал работу' + (owner ? ' — вкладка @' + owner : '') + ', ферма остывает',
          'Признак: ' + why,
          verdict || 'Прогон НЕ добивает аккаунт: пауза на остывание, после лимита пауз — честная остановка со сводкой.',
          'Что сделать: открой instagram.com и посмотри, что там (лимит действий / «подтвердите, что это вы» / выход из аккаунта).',
          'Сегодня аккаунт лучше не нагружать заново.',
        ];
        const bt = String(msg.budgetText || '').trim();
        if (bt) lines.push('Бюджет на момент блока: ' + bt);
        await tgSay(s.chatId, lines.join('\n'));
        sendResponse({ ok: true });
      } catch (_) {
        try { sendResponse({ ok: false }); } catch (_) {}
      }
    })();
    return true;
  }
  if (msg.type === 'tgAfkReport') {
    // Финальная сводка АФК-прогона (шлётся ОДИН раз при остановке, а не после каждого списка).
    // Разбивка по спискам — раскрывающейся цитатой: жирный номер, сколько перечекано,
    // ссылка на владельца и число его подписчиков.
    (async () => {
      try {
        const s = await getTgSettings();
        if (s.chatId) {
          const minF = msg.minFollowers || 0;
          const maxF = msg.maxFollowers || 0;
          const lines = [
            '🤖 АФК: прогон завершён',
            `Длилось: ${msg.durationMin || 0} мин`,
            `Перечекано: ${msg.checked || 0}`,
            `Нашлось с TG: ${msg.foundTg || 0}`,
          ];
          // Причина стопа — первой строкой после цифр: «прогон завершён» без неё читается
          // как успех, а человек между тем смотрит на 2 минуты работы и 0 проверенных.
          lines.push('Остановлен: ' + (String(msg.reason || '').trim() ? tgEsc(msg.reason) : 'причина не записана (остановили вручную или вкладка умерла)'));
          // Куда ушли минуты — ради этого отчёт и затевался: без разкладки «3 проверки
          // за 20 минут» неотличимо от поломки, а с ней видно, что жрал пустой список.
          if (String(msg.budgetText || '').trim()) lines.push('Бюджет: ' + tgEsc(msg.budgetText));
          if (minF > 0 || maxF > 0) {
            const range = `${minF > 0 ? `≥ ${minF}` : ''}${minF > 0 && maxF > 0 ? ' и ' : ''}${maxF > 0 ? `≤ ${maxF}` : ''}`;
            lines.push(`Из них с сабами ${range}: ${msg.foundFit || 0}`);
          }
          // Порог САМОГО донора — отдельной строкой и только если он задан своими полями:
          // после разделения «≥1000» выше — это про лидов, а у кого брали список могло быть
          // совсем другое число (и именно оно решает, был ли кому ставить сид).
          if (msg.donorOwnBound) {
            const dMin = msg.donorMinFollowers || 0;
            const dMax = msg.donorMaxFollowers || 0;
            if (dMin > 0 || dMax > 0) {
              const dRange = `${dMin > 0 ? `≥ ${dMin}` : ''}${dMin > 0 && dMax > 0 ? ' и ' : ''}${dMax > 0 ? `≤ ${dMax}` : ''}`;
              lines.push(`Доноры: сабы ${dRange}`);
            } else {
              lines.push('Доноры: сабы без ограничений');
            }
          }
          // Сколько найденных ссылок реально доказаны — отдельной строкой: иначе
          // «Нашлось с TG: 30» звучит как «30 живых людей», хотя проверялось только наличие ссылки.
          try {
            const tot = await tgRealTotals();
            if (tot.withTg) {
              lines.push(`Реальность TG в базе: живых ${tot.real} · мёртвых ${tot.dead} · не проверялось ${tot.unchecked + tot.unknown}`);
            }
          } catch (_) {}
          const lists = Array.isArray(msg.lists) ? msg.lists.filter((l) => l && l.count > 0) : [];
          const fmtNum = (n) => (Number(n) || 0).toLocaleString('ru-RU');
          if (lists.length) {
            const rows = lists
              .map((l, i) => {
                const owner = String(l.owner || '').replace(/[^A-Za-z0-9._]/g, '');
                const head = `<b>${i + 1})</b> ${l.count} — instagram.com/${owner}`;
                const subs = l.followers != null ? `\n${fmtNum(l.followers)} сабов` : '';
                return head + subs;
              })
              .join('\n\n');
            const base = lines.concat('', 'Прочеканные списки:');
            // expandable-цитата поддерживается не всеми клиентами/API: сначала пробуем её,
            // при ошибке разбора — обычную цитату, чтобы сообщение не потерялось.
            try {
              await tgApi('sendMessage', {
                chat_id: s.chatId,
                text: base.concat(`<blockquote expandable>${rows}</blockquote>`).join('\n'),
                parse_mode: 'HTML',
              });
            } catch (_) {
              await tgSay(s.chatId, base.concat(`<blockquote>${rows}</blockquote>`).join('\n'), { parse_mode: 'HTML' });
            }
          } else {
            await tgSay(s.chatId, lines.join('\n'));
          }
        }
        sendResponse({ ok: true });
      } catch (_) {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }
  if (msg.type === 'tgTest') {
    try {
      const me = await tgApi('getMe', {});
      const s = await getTgSettings();
      sendResponse({ ok: true, botName: me.username, chatId: s.chatId });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  }
  if (msg.type === 'tgResolveChat') {
    // Разрешаем введённый юзернейм / числовой chat_id в рабочий chat_id.
    (async () => {
      try {
        sendResponse(await tgResolveChat(msg.query));
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }
  if (msg.type === 'tgBindChat') {
    // chat_id берём из последнего сообщения, которое бот видел при поллинге
    try {
      const data = await chrome.storage.local.get('igx_tg_lastchat');
      let chatId = data.igx_tg_lastchat || 0;
      if (!chatId) {
        const s = await getTgSettings();
        chatId = s.chatId;
      }
      sendResponse({ ok: !!chatId, chatId });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  }
  return false;
}
