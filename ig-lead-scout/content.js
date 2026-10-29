// content.js — работает на страницах instagram.com

(async function () {
  try {
    const mode = await chrome.runtime.sendMessage({type:'isQuickCheck'});
    if (mode?.isQuickCheck) { await laptopQuickProfile(); return; }
  } catch (error) { console.warn('Quick profile initialization failed', error); }
  // Маркер сборки: вкладка Instagram, открытая ДО ⟳ в chrome://extensions, крутит дальше
  // СТАРЫЙ content.js вплоть до F5 по этой вкладке. Нет этой строки в консоли ИГ-вкладки
  // (или номер ниже того, что последним стоит в журнале CODE_STRUCTURE.md) — значит код
  // не обновился, а не «логика сломалась».
  console.log('[IG Lead Scout] content.js build=autoguard-2 loaded'); // 1: выключенный прогон молчит — бан-карточка в бота шлётся ТОЛЬКО пока состояние этой вкладки реально включено (и с честным вердиктом «остыл/встал» + @вкладки); 2: таймеры «поднимаю прогон» стали ОДНИМ отменяемым afkWake, а afkLoop больше не оживает на выключенном прогоне (не пишет hb, не жжёт кнопку); 3: метка prog (последний настоящий шаг) + вотчдог зависания: 8 минут тишины без объявленной паузы = честный стоп «завис», а не вечно живое окно; автоперерыв теперь тоже подписан как пауза; 4: бан-детект расширен (temporarily blocking / unable to follow / wait a few minutes / try again in / действия ограничены и т.д.), экран блока важнее счётчика проверок, модалка проверяется до «живого main», чеки обрываются на блоке сразу, и пассивный пробник сам звонит в бота на первом появлении блока

  // «Uncaught (in promise) Error: Extension context invalidated.»
  // После перезагрузки/обновления расширения все уже открытые страницы Instagram
  // остаются с «висячим» content-script: любой вызов chrome.* из него отваливается
  // именно этой ошибкой. Точечные вызовы обёрнуты в свои guards (safeStorageGet/Set,
  // safeSendMessage), но «выстрелил и забыл» промисов в коде много (сохранение
  // позиции панели, чекбоксы, состояния АФК) — обёртывать их по одному дороже и
  // рискованнее, чем поставить общую сеть. Гасим только этот конкретный случай:
  // другой текст ошибки в консоли остаётся видимым, чтобы не потерять реальные баги.
  function igxIsDeadContext(err) {
    const s = String((err && err.message) || err || '');
    return (
      s.indexOf('Extension context invalidated') !== -1 ||
      s.indexOf('context invalidated') !== -1 ||
      s.indexOf('message port closed') !== -1
    );
  }
  let igxDeadCtxTold = false;
  window.addEventListener('unhandledrejection', (ev) => {
    if (!igxIsDeadContext(ev && ev.reason)) return;
    try {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
    } catch (_) {}
    if (!igxDeadCtxTold) {
      igxDeadCtxTold = true;
      console.info('[IG Lead Scout] Расширение было обновлено. Обнови страницу Instagram (F5) — иначе кнопки не работают.');
    }
  });

  // Подгрузка main-bridge.js в MAIN world (доступ к React Fiber)
  try {
    if (!document.documentElement.dataset.igxBridgeInjected) {
      document.documentElement.dataset.igxBridgeInjected = '1';
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('main-bridge.js');
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    }
  } catch (_) {}

  const RESERVED = new Set([
    'explore', 'reels', 'stories', 'direct', 'accounts', 'p', 'tv', 'about',
    'legal', 'developer', 'ads', 'api', 'challenge', 'emails', 'session',
    'push', 'web', 'nametag', 'topics', 'locations', 'directory', 'privacy',
    'terms', 'lite', 'graphql', 'oauth', 'create', 'settings',
  ]);

  const TG_RE = /(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{3,32})/i;

  // Номер телефона вместо юза: «тг: 89991234567», «+7 999 123-45-67» и т.п.
  // Раньше цифры матчились как юзернейм ([A-Za-z0-9_] включает цифры) и бот
  // «проверял» несуществующий @8999.... Теперь: числа отсеиваем из хэндлов,
  // а по номеру ищем реальный аккаунт через web.telegram.org (режим 📱 ТГ).
  const PHONE_TG_RE = /(^|\D)((?:\+7|8|7)[\s()-]{0,2}\d{3}[\s()-]{0,2}\d{3}[\s()-]{0,2}\d{2}[\s()-]{0,2}\d{2})(?=\D|$)/;
  const isPhoneLike = (h) => /^[+\d][\d\s()-]{9,17}$/.test(String(h || '').trim());
  // Мусорные/несуществующие TG-юзы: служебные пути t.me (share/s/joinchat/...) и частые
  // спам/рекламные слова. collectTelegram скрёб весь document.body, и tgList[0] становился
  // «ТГ профиля» — прилетали @chat, @adfire, @chat123 и прочая рандомная хуйня с рекламы
  // и подборок, а не реальный юз владельца. Такое отсекаем на входе (и чистка снимает).
  const TG_RESERVED = new Set(['share', 's', 'joinchat', 'join', 'addstickers', 'addsticker', 'addlist', 'addtheme', 'addchain', 'addemoji', 'addaudio', 'addcolor', 'addmessage', 'proxy', 'iv', 'login', 'setlanguage', 'confirmphone', 'boost', 'gift', 'gifts', 'stories', 'profile', 'telegram', 'tg', 'me', 'app', 'desktop', 'macos', 'web', 'webk', 'contact', 'contacts', 'recent', 'saved', 'favorites', 'channels', 'groups', 'bot', 'telegramorg', 'ct', 'startapp', 'deep', 'deeplink', 'link', 'linkresolver', 'm', 'c', 'post', 'user', 'addcomment', 'addreaction', 'bg', 'savegas', 'invoice', 'wallet', 'business', 'verify', 'domain']);
  const TG_GENERIC = new Set(['chat', 'chats', 'adfire', 'ad', 'ads', 'adv', 'promo', 'spam', 'free', 'sex', 'xxx', 'hot', 'vpn', 'casino', 'win', 'wining', 'lotery', 'lottery', 'crypto', 'bitcoin', 'binance', 'market', 'shop', 'store', 'support', 'help', 'admin', 'manager', 'info', 'office', 'team', 'staff', 'service', 'news', 'media', 'tv', 'club', 'game', 'games', 'giveaway', 'airdrop', 'nft', 'token', 'job', 'jobs', 'work', 'money', 'order', 'menu', 'buy', 'sale', 'call', 'sms', 'code', 'test', 'demo', 'example']);
  function isGarbageTgHandle(h) {
    const x = String(h || '').toLowerCase().replace(/^@/, '').trim();
    if (!x || x.length < 4) return true;
    if (TG_RESERVED.has(x) || TG_GENERIC.has(x)) return true;
    if (/^(chat|chats|ad|ads|promo|free|hot|sex|xxx|vpn|casino|bot)[-_]?\d{0,4}$/.test(x)) return true; // chat123, bot80, ad24…
    // Хвост вида «<спам-токен><цифры>» с ЛЮБЫМ префиксом: nexwire_bot80, my_chat12, promo_777.
    // Прежний якорь ^ ловил только «bot80» с начала, а засор вида «ник_botNN» проскакивал и
    // оседал в базе как «ТГ лида». Реальные боты кончаются на «_bot» без цифр — не задевает.
    if (/(?:^|[-_.])(chat|chats|ad|ads|adv|promo|spam|vpn|casino|bot)[_.-]?\d{1,5}$/.test(x)) return true;
    return false;
  }
  function normPhone(raw) {
    // Убираем и «+», и разделители: дальше смотрим только на цифры, чтобы
    // «+8 999...», «8999...», «7 999...» и «8 999 12-34-56» сводились к одному +7...
    const d = String(raw || '').replace(/[\s()+-]/g, '');
    if (/^[78]\d{10}$/.test(d)) return '+7' + d.slice(-10); // RU/KZ: 7/8 (в т.ч. 89...) + 10 цифр → +7
    if (/^\d{10,15}$/.test(d)) return '+' + d;              // международный (wa.me отдаёт полный номер без «+»)
    return null;
  }
  // Номер должен ПОХОЖИТЬ на реальный, а не на счётчик/id/технические цифры со
  // страницы: проверяем первую цифру кода региона по стране кода и запрещаем
  // «5+ подряд одинаковых» (+7 8800000000, +7 0000001082). Неизвестная страна —
  // пропускаем: фильтр ловит только заведомый мусор.
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
  function findPhoneInText(text) {
    if (!text) return null;
    const m = String(text).match(PHONE_TG_RE);
    if (!m) return null;
    const p = normPhone(m[2]);
    return p && isPlausiblePhone(p) ? p : null;
  }

  // Номер внутри ССЫЛКИ профиля: wa.me/79681355444, api.whatsapp.com/send?phone=7968...,
  // tel:+7968... Часто телефон прячут именно в ссылке (WhatsApp), а не в тексте био —
  // Instagram показывает ссылку меткой («Запись»), поэтому innerText номера не содержит.
  const LINK_PHONE_RES = [
    /wa\.me\/(\d{7,15})/i,
    /[?&]phone=(\+?\d{7,15})/i,
    /tel:(\+?\d{7,15})/i,
  ];
  function findPhoneInLinks(container) {
    if (!container || !container.querySelectorAll) return null;
    for (const a of container.querySelectorAll('a[href]')) {
      let raw = '';
      try { raw = decodeURIComponent(a.href || ''); } catch (_) { raw = a.href || ''; }
      for (const re of LINK_PHONE_RES) {
        const m = raw.match(re);
        if (m) { const p = normPhone(m[1]); if (p && isPlausiblePhone(p)) return p; }
      }
    }
    return null;
  }

  // Ник инсты можно попробовать как @юзернейм ТГ только если он валиден для ТГ:
  // 5–32 символа, без точек (точки есть в инсте, но запрещены в ТГ).
  const tgHandleUsable = (u) => /^[A-Za-z0-9_]{5,32}$/.test(String(u || ''));

  function extractUsername(elOrPath) {
    if (!elOrPath) return null;
    let path = '';
    if (typeof elOrPath === 'string') {
      path = elOrPath;
    } else if (elOrPath.pathname) {
      path = elOrPath.pathname;
    } else if (elOrPath.getAttribute) {
      path = elOrPath.getAttribute('href') || '';
    }
    path = path.replace(/^https?:\/\/[^/]+/i, '');
    path = path.split('?')[0].split('#')[0];
    const m = path.match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
    if (!m) return null;
    const u = m[1].toLowerCase();
    if (RESERVED.has(u)) return null;
    return m[1];
  }

  // ---------- storage: ключи ----------
  const PROFILE_PREFIX = 'igx_profile:';
  const VIEWED_PREFIX = 'igx_viewed:';
  const DONE_PREFIX = 'igx_done:' // эксперты, чьи списки подписок уже полностью прочеканы
  const profileKey = (u) => PROFILE_PREFIX + u.toLowerCase();
  const viewedKey = (u) => VIEWED_PREFIX + u.toLowerCase();
  const doneKey = (u) => DONE_PREFIX + u.toLowerCase();

  // Кэш профилей/просмотров в памяти. Раньше каждый проход фильтра ходил в
  // chrome.storage по 2 раза НА КАЖДУЮ строку списка — на больших списках это
  // подвешивало страницу (лагали кнопки и панель). Теперь читаем storage один
  // раз при старте и держим актуальным через storage.onChanged.
  const profileCache = new Map(); // username(lower) -> запись профиля или null
  const viewedCache = new Set(); // username(lower)
  const doneCache = new Map(); // username(lower) -> { followers:bool, following:bool }
  // Флаг «первая считка базы закончилась» (пусть и с исключением). Нужен НЕ фильтрам, а
  // итогам прогона: до него profileCache пуст, и «TG не нашёлся» — это не «TG нет», а
  // «мы ещё не посмотрели». Свернуть имя в накопленное тогда — значит заморозить ноль.
  let profileCacheReady = false;
  (async () => {
    try {
      const all = await chrome.storage.local.get(null);
      for (const k of Object.keys(all)) {
        if (k.startsWith(PROFILE_PREFIX)) profileCache.set(k.slice(PROFILE_PREFIX.length), all[k]);
        else if (k.startsWith(VIEWED_PREFIX)) viewedCache.add(k.slice(VIEWED_PREFIX.length));
        else if (k.startsWith(DONE_PREFIX)) doneCache.set(k.slice(DONE_PREFIX.length), normalizeDone(all[k]));
      }
    } catch (_) {}
    profileCacheReady = true;
  })();

  async function getProfile(username) {
    const u = username.toLowerCase();
    if (profileCache.has(u)) return profileCache.get(u);
    const key = profileKey(u);
    const data = await chrome.storage.local.get(key);
    const rec = data[key] || null;
    profileCache.set(u, rec);
    return rec;
  }
  async function saveProfile(record) {
    const u = record.username.toLowerCase();
    if (Object.hasOwn(record, 'bio') && record.checkedAt) {
      record.laptopProfileUrls = await laptopReadProfileUrls(u);
      record.laptopHistorical = false;
      const context = await igxSend({type:'laptopCheckContext'}, 8000).catch(() => null);
      if (context?.token) {
        record.laptopClaimToken = context.token;
        record.laptopWorker = context.worker;
      }
    }
    // НЕ затираем старую запись, а ОБОГАЩАЕМ: если новый проход не добыл какое-то
    // поле (null/пусто), оставляем прежнее значение. Так повторный просмотр профиля,
    // который уже был в базе «без подробностей», допишет ник/описание/ссылки,
    // а база при этом не очищается.
    // prev берём свежим из storage, а не из кэша: воркер только что мог записать
    // вердикт ревизии (tgReal/tgRealAt), а storage.onChanged ещё не успел долететь —
    // с кэша эта запись затиралась бы ровно в том месте, где её и поставили.
    let prev = profileCache.has(u) ? profileCache.get(u) : null;
    try {
      const fresh = await chrome.storage.local.get(profileKey(u));
      if (fresh && fresh[profileKey(u)]) prev = fresh[profileKey(u)];
    } catch (_) {}
    const merged = mergeProfileRecord(prev, record);
    profileCache.set(u, merged);
    await chrome.storage.local.set({
      [profileKey(record.username)]: merged,
    });
    return merged;
  }

  const igxIsEmptyVal = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
  function mergeProfileRecord(prev, next) {
    if (!prev || typeof prev !== 'object') return Object.assign({}, next);
    const out = Object.assign({}, prev);
    for (const k of Object.keys(next)) {
      if (k === 'checkedAt' || k === 'firstSeenAt') continue;
      if (k === 'telegrams') {
        // union всех найденных ТГ-ссылок
        const set = new Set([...(prev.telegrams || []), ...(next.telegrams || [])]);
        if (set.size) out.telegrams = Array.from(set);
        continue;
      }
      if (k === 'tgContacts') {
        // union кандидатов контакта по handle: держим более высокую уверенность
        // (published > unverified) и OR по corroborated. Массив объектов — generic
        // union не подходит (затёр бы целиком), поэтому своя ветка как у telegrams.
        const rank = { published: 1, unverified: 0 };
        const map = new Map();
        const put = (c) => {
          if (!c || !c.handle) return;
          const key = String(c.handle).toLowerCase();
          const cand = Object.assign({}, c, { handle: key });
          const old = map.get(key);
          if (!old) { map.set(key, cand); return; }
          if ((rank[cand.confidence] || 0) >= (rank[old.confidence] || 0)) {
            if (old.corroborated === true) cand.corroborated = true;
            map.set(key, cand);
          } else if (cand.corroborated === true) {
            old.corroborated = true;
          }
        };
        (prev.tgContacts || []).forEach(put);
        (next.tgContacts || []).forEach(put);
        if (map.size) out.tgContacts = Array.from(map.values());
        continue;
      }
      // новое непустое значение побеждает; пустое — не затирает старое
      if (!igxIsEmptyVal(next[k])) out[k] = next[k];
      else if (!(k in out)) out[k] = next[k];
    }
    out.checkedAt = next.checkedAt || prev.checkedAt || Date.now();
    if (!out.firstSeenAt) out.firstSeenAt = prev.firstSeenAt || prev.checkedAt || out.checkedAt;
    return out;
  }
  async function isViewed(username) {
    const u = username.toLowerCase();
    if (viewedCache.has(u)) return true;
    const key = viewedKey(u);
    const data = await chrome.storage.local.get(key);
    const v = !!data[key];
    if (v) viewedCache.add(u);
    return v;
  }
  async function markViewed(username) {
    viewedCache.add(username.toLowerCase());
    await chrome.storage.local.set({ [viewedKey(username)]: Date.now() });
  }

  // Нормализация записи «выжатости»: отдельно помечаем прочеканные подписчики и подписки.
  function normalizeDone(v) {
    if (!v || typeof v !== 'object') return { followers: false, following: false };
    const fol = !!(v.followers || v.followersAt);
    const fsg = !!(v.following || v.followingAt);
    // Легаси-формат {count, checkedAt} без типа списка — считаем как подписчики.
    if (!fol && !fsg && (v.count != null || v.checkedAt)) return { followers: true, following: false };
    return { followers: fol, following: fsg };
  }
  function doneState(username) {
    return doneCache.get(username.toLowerCase()) || { followers: false, following: false };
  }
  // Эксперт «выжат» хоть по одному списку.
  function isDone(username) {
    const d = doneState(username);
    return d.followers || d.following;
  }
  // Выжат ли конкретно нужный тип списка — чтобы АФК не лез повторно в тот же список.
  function isDoneKind(username, kind) {
    const d = doneState(username);
    if (kind === 'both') return d.followers && d.following;
    return kind === 'following' ? !!d.following : !!d.followers;
  }
  async function markDone(username, count, kind) {
    const u = username.toLowerCase();
    const cur = doneCache.get(u) || { followers: false, following: false };
    const next = { followers: !!cur.followers, following: !!cur.following };
    if (kind === 'following') next.following = true;
    else next.followers = true;
    doneCache.set(u, next);
    try {
      await chrome.storage.local.set({
        [doneKey(u)]: { followers: next.followers, following: next.following, count: count || 0, checkedAt: Date.now() },
      });
    } catch (_) {}
  }

  function igxSend(msg, timeoutMs = 10000) {
    return Promise.race([
      chrome.runtime.sendMessage(msg),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
  }

  function getSettings() {
    return igxSend({ type: 'getSettings' }, 5000).catch(() => ({
      openMode: 'splitscreen',
      throttleMs: 4000,
    }));
  }

  // Кэш настроек: обработчику клика режим открытия нужен СИНХРОННО — раньше
  // он сначала глотал клик (preventDefault) и только потом узнавал режим,
  // из-за чего при «в этой же вкладке» профиль вообще не открывался.
  let cachedSettings = { openMode: 'newtab', throttleMs: 4000 };
  getSettings()
    .then((s) => {
      cachedSettings = s;
    })
    .catch(() => {});

  // ---------- парсинг чисел и ссылок ----------
  function parseCount(raw) {
    if (!raw) return null;
    // Делегируем общему разбору компактных чисел: прежняя реализация ломала английские
    // разряды («1,234» превращалось в 1, потому что запятая считалась десятичной).
    return parseCompactCount(raw);
  }

  function findTelegram(container) {
    if (!container) return null;
    const links = container.querySelectorAll('a[href]');
    for (const a of links) {
      let rawHref = a.href;
      try {
        rawHref = decodeURIComponent(a.href);
      } catch (_) {}
      const m = rawHref.match(TG_RE);
      if (m && !isGarbageTgHandle(m[1])) return `https://t.me/${m[1]}`;

      const mText = a.textContent.match(TG_RE);
      if (mText && !isGarbageTgHandle(mText[1])) return `https://t.me/${mText[1]}`;
    }

    // Берём только ВИДИМЫЙ текст (innerText), чтобы не матчить служебный JSON
    // из <script>-тегов страницы Instagram — оттуда прилетали ложные срабатывания.
    let text = '';
    try {
      text = container.innerText || '';
    } catch (_) {}
    if (!text) text = container.textContent || '';

    const m = text.match(TG_RE);
    if (m && !isGarbageTgHandle(m[1])) return `https://t.me/${m[1]}`;

    // Поиск формата "TG: @username" или "тг: username" в описании
    const mBio = text.match(/(?:tg|тг|telegram|телеграм|телега)[\s:—–-]+@?([A-Za-z0-9_]{3,32})/i);
    if (mBio && !isPhoneLike(mBio[1]) && !isGarbageTgHandle(mBio[1])) return `https://t.me/${mBio[1]}`;

    return null;
  }

  // Собирает ВСЕ Telegram-юзы из контейнера (на аккаунте может быть несколько ссылок,
  // включая ссылки вида t.me/user?text=... с готовым сообщением в личку).
  function collectTelegram(container, acc) {
    if (!container || !acc) return;
    const tgReG = new RegExp(TG_RE.source, 'gi');
    const bioReG = /(?:tg|тг|telegram|телеграм|телега)[\s:—–-]+@?([A-Za-z0-9_]{3,32})/gi;

    const links = container.querySelectorAll('a[href]');
    for (const a of links) {
      let rawHref = a.href;
      try {
        rawHref = decodeURIComponent(a.href);
      } catch (_) {}
      for (const m of rawHref.matchAll(tgReG)) { if (!isGarbageTgHandle(m[1])) acc.add(m[1].toLowerCase()); }
      for (const m of (a.textContent || '').matchAll(tgReG)) { if (!isGarbageTgHandle(m[1])) acc.add(m[1].toLowerCase()); }
    }

    let text = '';
    try {
      text = container.innerText || '';
    } catch (_) {}
    if (!text) text = container.textContent || '';
    for (const m of text.matchAll(tgReG)) { if (!isPhoneLike(m[1]) && !isGarbageTgHandle(m[1])) acc.add(m[1].toLowerCase()); }
    for (const m of text.matchAll(bioReG)) { if (!isPhoneLike(m[1]) && !isGarbageTgHandle(m[1])) acc.add(m[1].toLowerCase()); }
  }

  // Внешняя «своя» ссылка профиля (таплинк/сайт) — НЕ соцсеть и НЕ мессенджер.
  // Телефон/WA, опубликованные человеком на СВОЁМ сайте — самый чистый контакт:
  // уверенность published, без риска приписать чужой ник (в отличие от догадки по
  // IG-нику). Instagram оборачивает внешнюю ссылку в /url.php?u=<enc> — разворачиваем.
  const _SOCIAL_HOSTS = ['threads.', 'facebook.', 'fb.', 'x.com', 'twitter.', 't.co', 'youtube.', 'youtu.be', 'tiktok.', 'vk.', 'ok.ru', 'ok.me', 'pinterest.', 'pin.it', 'linkedin.', 'reddit.', 't.me', 'telegram.', 'wa.me', 'whatsapp.'];
  function _isSocialHost(u) {
    let host = '';
    try { host = new URL(u).hostname.toLowerCase(); } catch (_) { return false; }
    return _SOCIAL_HOSTS.some((h) => host.includes(h));
  }
  function findExternalProfileUrl(container) {
    if (!container || !container.querySelectorAll) return null;
    for (const a of container.querySelectorAll('a[href]')) {
      let raw = '';
      try { raw = decodeURIComponent(a.href || ''); } catch (_) { raw = a.href || ''; }
      const um = raw.match(/[?&]u=([^&]+)/i);
      if (um) { try { raw = decodeURIComponent(um[1]); } catch (_) {} }
      if (!/^https?:\/\//i.test(raw)) continue;
      if (/instagram\.com/i.test(raw)) continue;
      if (_isSocialHost(raw)) continue;
      return raw;
    }
    return null;
  }
  // Дней с последнего поста (для гейта «не тратить окно на спящего»). Берём первый
  // таймсетку грида: <time datetime>, иначе относительную подпись (дн/нед/мес/ч RU+EN).
  // Не удалось определить — null (fail-open: НЕ блокируем по неизвестности).
  function getLastPostDaysAgo() {
    try {
      const arts = document.querySelectorAll('main article');
      for (const art of arts) {
        const t = art.querySelector('time[datetime]');
        if (t) {
          const dt = new Date(t.getAttribute('datetime'));
          if (!isNaN(dt.getTime())) return Math.max(0, Math.floor((Date.now() - dt.getTime()) / 86400000));
        }
        const raw = ((t && (t.getAttribute('title') || t.textContent)) || (art.textContent || '')).trim().toLowerCase();
        const mD = raw.match(/(\d+)\s*(?:д|дн|days?|d)/i);
        const mW = raw.match(/(\d+)\s*(?:нед|w|weeks?)/i);
        const mM = raw.match(/(\d+)\s*(?:мес|mo|months?)/i);
        const mH = raw.match(/(\d+)\s*(?:ч|h|hours?|мин|m)/i);
        if (mD) return parseInt(mD[1], 10);
        if (mW) return parseInt(mW[1], 10) * 7;
        if (mM) return parseInt(mM[1], 10) * 30;
        if (mH) return 0;
      }
    } catch (_) {}
    return null;
  }

  function extractFollowersFromHeader() {
    const candidates = Array.from(
      document.querySelectorAll('header li, header span, header div, header a, main li, main span, main a')
    ).filter((el) => /(?:подписч|follower)/i.test(el.textContent || ''));
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.textContent.length - b.textContent.length);
    const best = candidates[0];
    const numEl = best.querySelector('span[title]') || best.querySelector('span') || best;
    const raw = (numEl.getAttribute && numEl.getAttribute('title')) || numEl.textContent;
    return parseCount(raw);
  }

  // ---------- определение и извлечение данных со страницы профиля ----------
  let lastPath = null;
  async function tryExtractProfile(username, attempt = 0, tgAttempt = 0) {
    await laptopExpandBiography(username);
    if (location.pathname.split('/').filter(Boolean)[0]?.toLowerCase() !== username.toLowerCase()) return;
    const header = document.querySelector('header') || document.querySelector('main');
    const followers = header ? extractFollowersFromHeader() : null;

    if (followers === null && attempt < 24) {
      setTimeout(() => tryExtractProfile(username, attempt + 1, tgAttempt), 500);
      return;
    }

    // Собираем Telegram-ссылки ТОЛЬКО из шапки профиля (био + имя + ссылка в био).
    // Раньше скан шёл и по main/document.body — а это лента, подписи постов,
    // КОММЕНТАРИИ и реклама: спам-боты оставляют «тг: @xxx» в комментах под чужими
    // постами, и этот хендл приписывался владельцу профиля. База замусорилась
    // ботами/каналами, разборы уходили в ТГК вместо личек — 90% проверок впустую.
    // Точность сейчас важнее охвата: берём контакт только из header.
    const tgSet = new Set();
    // Строго <header> без фолбэка на main: если шапка ещё не отрисовалась, лучше
    // пропустить этот проход (будет ретрай), чем сканировать ленту и собрать мусор.
    const profileHeader = document.querySelector('header');
    if (profileHeader) collectTelegram(profileHeader, tgSet);
    const tgList = Array.from(tgSet).slice(0, 10);
    let telegram = tgList.length ? `https://t.me/${tgList[0]}` : null;
    let telegrams = tgList.map((t) => `https://t.me/${t}`);
    let tgSpeculative = false; // TG найден только по совпадению IG-ника — не доказано, что это тот же человек
    // tgContacts — модель кандидатов (idea 1): каждый TG-юз с источником и
    // уверенностью. Пишется ВСЕГДА (и в legacy, и в cascade), поэтому откат тумблера
    // безопасен: tier считается на лету из этого массива, а legacy-флаги ниже не деваем.
    let tgContacts = tgList.map((h) => ({ handle: String(h).toLowerCase(), source: 'bio', confidence: 'unverified' }));
    const externalUrl = profileHeader ? findExternalProfileUrl(profileHeader) : null;
    const lastPostDaysAgo = getLastPostDaysAgo();

    const fullNameEl = header ? header.querySelector('h1, h2') : null;
    const fullName = fullNameEl ? fullNameEl.textContent.trim() : '';

    // Дополнительные данные профиля: описание (bio), подписки, число публикаций.
    // Нужно и для подробной базы, и для фильтра «обязательное слово в описании/нике».
    // Переиспользуем сборщик шапки из Profile Analyzer (чистое чтение DOM, без сайд-эффектов).
    let bio = '';
    let following = null;
    let posts = null;
    let followersOut = followers;
    let highlights = [];
    try {
      const extra = igxPaCollectHeader(username);
      bio = (extra && extra.bio) || '';
      following = extra ? extra.following : null;
      posts = extra ? extra.posts : null;
      highlights = (extra && extra.highlights) || [];
      if (followersOut == null && extra) followersOut = extra.followers;
    } catch (_) {}

    // Если telegram не найден на первых попытках — пробуем ещё раз (ссылки могут подгружаться позже).
    // Счётчик отдельный от ожидания подписчиков: раньше медленная загрузка шапки
    // съедала все попытки, и профиль сохранялся без TG (ложное «Telegram не найден»).

    // Под «ТГ» мог быть замаскирован голый номер: вытаскиваем его отдельно
    // (поиск по номеру делает воркер через web.telegram.org).
    let tgPhone = null;
    if (!telegram) {
      const hay = String((profileHeader && profileHeader.innerText) || '') + '\n' + bio;
      // Номер ищем в тексте шапки/био и в href ссылок ИМЕННО шапки (<header>, без
      // фолбэка на main). По ленте/комментам/рекламе не ходим — там чужие номера,
      // которые раньше приписывались владельцу профиля.
      tgPhone = findPhoneInText(hay) || findPhoneInLinks(profileHeader);
    }
    // Номер найден — это тоже «TG есть», переподожидать ссылок незачем.
    // Бюджет ретраев зависит от того, отрисовалась ли шапка. 16×500мс = 8 секунд мёртвого
    // ожидания на профиле, где шапка УЖЕ полная (имя видно) и ссылки в ней нет: DOM между
    // проходами не меняется, мы крутим один и тот же скан. Целых 16 попыток остаётся только
    // «недорисованной» шапке — ровно ради того ложного «Telegram не найден», из-за которого
    // бюджет когда-то подняли. Готовой шапке хватает 4×300мс: вкладка проверки сохраняется
    // раньше, успевает записать всё до принудительного закрытия через 30 с (background.js),
    // и одновременно живых heavy-вкладок держим меньше.
    if (!telegram && tgAttempt < (profileHeader && fullName ? 4 : 16) && !tgPhone) {
      setTimeout(() => tryExtractProfile(username, attempt, tgAttempt + 1), profileHeader && fullName ? 300 : 500);
      return;
    }

    // tgSpeculative: telegram на этом шаге всегда взят из шапки. Если шапка дала
    // ссылку — снимаем stale-флаг прошлых прогонов (merge иначе вечно держит true и
    // навсегда губит легитимный лид, исключив его из /list и автоанализа).
    saveProfile({ username, fullName, followers: followersOut, following, posts, bio, highlights,
      isPrivate: afkIsPrivateProfilePage(), telegram, telegrams, tgPhone,
      tgSpeculative: telegram ? false : undefined, tgContacts, externalUrl,
      lastPostDaysAgo, checkedAt: Date.now() }).then(async () => {
      // Скрап таплинка/сайта (idea 4): телефон/WA/tg, опубликованные на СВОЁМ сайте,
      // — самый чистый контакт. Работает в обоих режимах. Fail-open: таймаут/блок
      // сайта = тихо ничего. Один сетевой заход, без ретраев-штормов.
      if (externalUrl) {
        try {
          const sc = await chrome.storage.local.get('igx_site_scrape');
          if (sc.igx_site_scrape !== false) {
            const sp = await igxSend({ type: 'tgProbeSite', url: externalUrl }, 15000);
            if (sp && sp.ok) {
              const tg = Array.isArray(sp.tgCandidates) ? sp.tgCandidates : [];
              const ph = Array.isArray(sp.phones) ? sp.phones : [];
              let siteAdopted = false; // контакт ВЗЯТ с сайта (а не просто страница с линками)
              // ЮЗ С САЙТА САМ ПО СЕБЕ ЕЩЁ НЕ КОНТАКТ. Мы читаем ВЕСЬ HTML таплинка, а
              // там всегда есть чужие ссылки: подвал/партнёрка/реклама/«похожие» — и
              // один и тот же юз живёт на тысячах чужих страниц. Прямое присвоение
              // telegram = tg[0] забивало базу одним «захватчиком» (сотни профилей с
              // одним ТГ). Поэтому: published ставим ТОЛЬКО когда юз уже стоял в био
              // (два независимых источника указали на него), иначе — unverified.
              for (const hRaw of tg) {
                const hh = String(hRaw).toLowerCase();
                const ex = tgContacts.find((c) => c.handle === hh);
                if (ex) ex.confidence = 'published';
                else tgContacts.push({ handle: hh, source: 'site', confidence: 'unverified' });
              }
              // голый номер с сайта — легитим (человек публикует СВОЙ телефон), его
              // в контакт превращает только строгий резолв по номеру ниже.
              if (!tgPhone && ph.length) tgPhone = ph[0];
              // Контакт из сайта принимаем тем же обычным путём верификации, что и
              // догадку по IG-нику: анонимная проверка юза + СОВПАДЕНИЕ ИМЕНИ в карточке
              // TG с именем IG-профиля. Реклама из подвала имени не совпадёт → останется
              // кандидатом, но базовым контактом не станет.
              if (!telegram && tg.length) {
                for (const hh of tg.slice(0, 2)) {
                  let vr = null;
                  try { vr = await igxSend({ type: 'tgResolveHandle', handle: hh }, 12000); } catch (_) {}
                  if (vr && vr.ok && vr.found && vr.tgKind === 'user' && vr.corroborated === true) {
                    telegram = vr.telegram || `https://t.me/${hh}`;
                    siteAdopted = true;
                    const c = tgContacts.find((x) => x.handle === hh);
                    if (c) { c.confidence = 'published'; c.corroborated = true; }
                    break;
                  }
                }
              }
              if (telegram && !telegrams.includes(telegram)) telegrams = [...telegrams, telegram];
              if (tg.length || ph.length) await saveProfile({ username, telegram, telegrams, tgPhone, tgContacts, tgFromSite: siteAdopted });
            }
          }
        } catch (_) {}
      }
      // Вместо TG-юза — голый номер: ищем реальный аккаунт по номеру через
      // web.telegram.org (работает в режиме 📱 ТГ). Если нашли — подставляем
      // настоящие @юз/ссылку в telegram и продолжаем обычную проверку/отчёт.
      if (false && !telegram && tgPhone) {
        const prevRec = profileCache.get(String(username).toLowerCase());
        if (!(prevRec && prevRec.tgPhoneResolved)) {
          try {
            const rr = await igxSend({ type: 'tgResolvePhone', phone: tgPhone, igUsername: username }, 95000);
            if (rr && rr.ok && rr.found) {
              telegram = rr.telegram || null;
              if (telegram && !telegrams.includes(telegram)) telegrams = [...telegrams, telegram];
              const pm = telegram ? String(telegram).match(/(?:t\.me|telegram\.me)\/([A-Za-z0-9_]+)/i) : null;
              if (pm && !tgContacts.some((c) => c.handle === pm[1].toLowerCase())) tgContacts.push({ handle: pm[1].toLowerCase(), source: 'phone', confidence: 'unverified' });
              await saveProfile({ username, telegram, telegrams, tgExists: true, tgKind: rr.tgKind || 'user', tgPhoneResolved: 'user', tgContacts });
            } else if (rr && rr.ok) {
              // аккаунта с таким номером нет (или приватность запрещает поиск по номеру) —
              // запоминаем, чтобы не повторять поиск по 60 секунд на каждой проверке профиля
              await saveProfile({ username, tgPhoneResolved: 'none' });
            }
          } catch (_) {}
        }
      }
      // Дубль ника: ТГ вообще не найден (ни ссылки, ни номера) — пробуем тот же
      // @юзернейм, что и в инсте (многие держат одинаковые ники). Тоже через поиск
      // web.telegram.org. Помечаем результат, чтобы не повторять прогон на каждом просмотре.
      if (false && !telegram && tgHandleUsable(username)) {
        const prevH = profileCache.get(String(username).toLowerCase());
        if (!(prevH && prevH.tgHandleResolved)) {
          try {
            const rh = await igxSend({ type: 'tgResolveHandle', handle: String(username), igUsername: username, igName: fullName }, 95000);
            if (rh && rh.ok && rh.found && rh.telegram) {
              telegram = rh.telegram;
              if (!telegrams.includes(telegram)) telegrams = [...telegrams, telegram];
              // Совпадение @ника в ТГ — НЕ доказательство, что это тот же человек: под
              // распространённым ником сидят докеры/боты/однофамильцы, и они забивали
              // список «лидов» и сжирали окна автоанализа. Верим только при совпадении
              // имени в карточке ТГ с IG-именем (corroborated). Иначе — спекуляция: не
              // в «зелёные» лиды, не в /list, не в автоанализ.
              tgSpeculative = rh.corroborated !== true;
              const hm = String(telegram).match(/(?:t\.me|telegram\.me)\/([A-Za-z0-9_]+)/i);
              const hLow = (hm ? hm[1] : String(username)).toLowerCase();
              const hc = tgContacts.find((c) => c.handle === hLow);
              if (hc) hc.corroborated = rh.corroborated === true;
              else tgContacts.push({ handle: hLow, source: 'nick_guess', confidence: 'unverified', corroborated: rh.corroborated === true });
              await saveProfile({ username, telegram, telegrams, tgExists: !tgSpeculative, tgKind: rh.tgKind || 'user', tgHandleResolved: 'user', tgFromHandle: true, tgSpeculative, tgContacts });
            } else if (rh && rh.ok) {
              await saveProfile({ username, tgHandleResolved: 'none' });
            }
          } catch (_) {}
        }
      }
      if (false && telegram && !tgSpeculative) {
        // Верификация найденного TG-юза + автоотчёт ботом (если включён).
        // Важно дождаться ДО checkDone, иначе фоновая вкладка закроется раньше времени.
        const tgUser = telegram.replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, '').replace(/^\//, '');
        try {
          // igUsername нужен воркеру: слой доказательности (tgReal/tgRealVia/tgRealAt)
          // пишет ОДИН воркер, content.js только просит проверить и переваривает ответ.
          const r = await igxSend({ type: 'tgVerify', username: tgUser, igUsername: username }, 20000);
          const exists = r && typeof r.exists === 'boolean' ? r.exists : null;
          if (exists !== null) {
            // tgKind: 'user' — реальный юзер, 'channel' — канал/группа (бот-верификация
            // различает через getChat). Нужен для фильтра «/list tg» в боте.
            const tgKind = r.kind || (r.isChannel === true ? 'channel' : (r && r.isChannel === false ? 'user' : undefined));
            await saveProfile({ username, fullName, followers: followersOut, following, posts, bio, highlights, telegram, telegrams, tgExists: exists, tgKind, checkedAt: Date.now() });
          }
        } catch (_) {}
        // Отчёт в бота — только если эксперт проходит фильтр по подписчикам.
        // Порог читаем из storage: фоновые вкладки автопроверки не видят filterState панели.
        const minData = await chrome.storage.local.get(['igx_min_followers', 'igx_max_followers']);
        const minF = parseInt(minData.igx_min_followers, 10) || 0;
        const maxF = parseInt(minData.igx_max_followers, 10) || 0;
        // верх порога: неизвестные сабы НЕ отсекаем (мин — отсекает, макс — нет)
        const meetsFilter = (minF <= 0 || (followers != null && followers >= minF)) && (maxF <= 0 || followers == null || followers <= maxF);
        if (meetsFilter) {
          try {
            await igxSend({ type: 'tgReportLead', username, telegram, followers }, 20000);
          } catch (_) {}
        }
      }
      try {
        await igxSend({ type: 'checkDone', username }, 5000);
      } catch (_) {}
    });
  }

  function handleRouteChange() {
    const path = location.pathname;
    if (path === lastPath) return;
    lastPath = path;
    const username = extractUsername(path);
    if (username) {
      // В фоновых вкладках автопроверки НЕ помечаем профиль просмотренным —
      // иначе каждый автопроверенный аккаунт считается «посещённым вручную».
      isQuickCheckTab().then((qc) => {
        if (!qc) markViewed(username);
      });
      tryExtractProfile(username);
    }
  }

  let quickCheckTabFlag = null;
  function isQuickCheckTab() {
    if (quickCheckTabFlag !== null) return Promise.resolve(quickCheckTabFlag);
    return chrome.runtime
      .sendMessage({ type: 'isQuickCheck' })
      .then((r) => (quickCheckTabFlag = !!(r && r.isQuickCheck)))
      .catch(() => (quickCheckTabFlag = false));
  }

  (function watchRoute() {
    const _push = history.pushState;
    const _replace = history.replaceState;
    history.pushState = function (...args) { _push.apply(this, args); handleRouteChange(); };
    history.replaceState = function (...args) { _replace.apply(this, args); handleRouteChange(); };
    window.addEventListener('popstate', handleRouteChange);
    setInterval(handleRouteChange, 800);
    handleRouteChange();
  })();

  // ---------- глобальный плавающий тултип ----------
  let globalTooltip = null;
  function getTooltipEl() {
    if (!globalTooltip) {
      globalTooltip = document.createElement('div');
      globalTooltip.className = 'igx-tooltip';
      document.body.appendChild(globalTooltip);
    }
    return globalTooltip;
  }

  function showTooltip(html, targetEl) {
    const tip = getTooltipEl();
    tip.innerHTML = html;
    tip.style.display = 'block';

    const rect = targetEl.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();

    let top = rect.top - tipRect.height - 8;
    let left = rect.left;

    if (top < 10) {
      top = rect.bottom + 8;
    }
    if (left + tipRect.width > window.innerWidth - 12) {
      left = window.innerWidth - tipRect.width - 12;
    }
    if (left < 12) {
      left = 12;
    }

    tip.style.top = `${Math.round(top)}px`;
    tip.style.left = `${Math.round(left)}px`;
  }

  function hideTooltip() {
    if (globalTooltip) {
      globalTooltip.style.display = 'none';
    }
  }

  // ---------- поиск строки пользователя в списке / модалке ----------
  function findUserRow(el) {
    if (!el) return null;
    const li = el.closest('li, [role="listitem"]');
    if (li) return li;

    let curr = el;
    let bestRow = null;

    while (curr && curr !== document.body && !curr.matches('[role="dialog"], main, body, section')) {
      const hasImg = !!curr.querySelector('img');
      const hasLink = !!curr.querySelector('a[href]');
      const hasButton = !!curr.querySelector('button');

      if (hasImg && (hasLink || hasButton)) {
        bestRow = curr;
        if (curr.parentElement && curr.parentElement.children.length >= 2) {
          let imgCount = 0;
          const kids = curr.parentElement.children;
          for (let i = 0; i < Math.min(kids.length, 6); i++) {
            if (kids[i].querySelector('img')) imgCount++;
          }
          if (imgCount >= 2) {
            return curr;
          }
        }
      }
      curr = curr.parentElement;
    }
    return bestRow || el.closest('div') || el;
  }

  // ---------- отслеживание активных проверок ----------
  const pendingUsers = new Set();
  function isPending(username) {
    return pendingUsers.has(username.toLowerCase());
  }

  // ---------- обновление статуса кнопки и подсветки всей строки ----------
  async function refreshRowStatus(username, avatarBox, row) {
    const bolt = avatarBox.querySelector('.igx-bolt');
    if (!bolt) return;

    const p = await getProfile(username);
    const viewed = await isViewed(username);
    const ds = doneState(username); // какие списки эксперта уже прочеканы
    const done = ds.followers || ds.following;
    // Три цвета «выжатости»: только подписчики = пурпурный, только подписки = синий, оба = фиолетовый.
    const doneRowClass = done ? (ds.followers && ds.following ? 'igx-row-done-both' : ds.followers ? 'igx-row-done-fol' : 'igx-row-done-fsg') : null;
    const minF = filterState?.minFollowers || 0;
    const maxF = filterState?.maxFollowers || 0;

    // Очищаем предыдущие классы подсветки со строки и аватарки
    if (row) {
      row.classList.remove('igx-row-tg', 'igx-row-checked', 'igx-row-visited', 'igx-row-pending', 'igx-row-tg-pending', 'igx-row-gold', 'igx-row-done', 'igx-row-done-both', 'igx-row-done-fol', 'igx-row-done-fsg');
    }
    if (avatarBox) {
      avatarBox.classList.remove('igx-avatar-pending', 'igx-avatar-tg-pending', 'igx-avatar-gold', 'igx-avatar-done');
    }

    // Идёт глубокая проверка Telegram (поиск лички) — фиолетовый, другая иконка
    if (isTgPending(username)) {
      bolt.textContent = '🔍';
      bolt.title = 'Ищу личку в Telegram…';
      bolt.className = 'igx-bolt is-tg-pending';
      if (row) row.classList.add('igx-row-tg-pending');
      if (avatarBox) avatarBox.classList.add('igx-avatar-tg-pending');
      return;
    }

    if (isPending(username)) {
      bolt.textContent = '⏳';
      bolt.title = 'Проверяется в фоне...';
      bolt.className = 'igx-bolt is-pending';
      if (row) {
        row.classList.add('igx-row-pending');
      }
      if (avatarBox) avatarBox.classList.add('igx-avatar-pending');
      return;
    }

    // Личка в Telegram найдена глубокой проверкой -> ярко-золотой
    if (p && Array.isArray(p.tgContacts) && p.tgContacts.length) {
      bolt.textContent = '💰';
      bolt.title = `Личка найдена: ${p.tgContacts.map((c) => '@' + c).join(', ')}\nКлик — перепроверить Telegram`;
      bolt.className = 'igx-bolt is-gold';
      if (row) row.classList.add('igx-row-gold');
      if (avatarBox) avatarBox.classList.add('igx-avatar-gold');
      return;
    }

    if (p) {
      if (done && avatarBox) avatarBox.classList.add('igx-avatar-done');
      const hasTg = !!p.telegram;
      const meetsFollowers = (minF <= 0 || (p.followers != null && p.followers >= minF)) && (maxF <= 0 || p.followers == null || p.followers <= maxF);

      if (hasTg && meetsFollowers) {
        // Три состояния вместо двух. Болт «✅» имел право означать только одно:
        // проверку делали и она доказала живой личный аккаунт. Раньше галочка
        // ставилась по tgExists (а при его отсутствии — вообще по наличию строки),
        // поэтому «проверено» выглядело то, что никогда не проверялось.
        const rs = tgRealStateOf(p);
        const handle = String(p.telegram || '').replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, '');
        const subs = `Подписчиков: ${p.followers != null ? p.followers.toLocaleString('ru-RU') : '—'}`;
        if (rs.state === 'dead') {
          bolt.textContent = '⚠️';
          bolt.title = `TG ${handle} — ${rs.label}${rs.why ? ': ' + rs.why : ''}\n${subs}\nКлик — перепроверить Telegram`;
          bolt.className = 'igx-bolt is-no-tg' + (done ? ' is-done' : '');
          if (row) {
            row.classList.add(doneRowClass || 'igx-row-checked');
          }
        } else if (rs.state === 'verified') {
          // Доказанный живой юз -> галочка, повторный клик открывает меню проверок
          bolt.textContent = '✅';
          bolt.title = `TG доказан живым (${rs.via === 'webtg' ? 't.me + web-сессия' : rs.via === 'api' ? 'Bot API' : 't.me'}): ${p.telegram}\n(${subs})\nКлик — искать личку внутри Telegram`;
          bolt.className = 'igx-bolt is-tg is-verified';
          if (row) row.classList.add(doneRowClass || (viewed ? 'igx-row-visited' : 'igx-row-tg'));
        } else {
          // Ссылка есть, доказательства нет: ❔, а не ✅. «Не проверялся» ≠ «мёртв»,
          // и вёрстка не должна позволять спутать одно с другим одним взглядом.
          bolt.textContent = '❔';
          bolt.title = `TG: ${p.telegram} — реальность не проверялась${rs.why ? ' (' + rs.why + ')' : ''}\n(${subs})\nПрогоните «Ревизию TG» на второй странице сайта`;
          bolt.className = 'igx-bolt is-tg is-unknown';
          // Просмотренный лид с TG -> синий, свежий -> зелёный; «выжатый» эксперт -> цвет выжатости.
          if (row) row.classList.add(doneRowClass || (viewed ? 'igx-row-visited' : 'igx-row-tg'));
        }
      } else if (hasTg && !meetsFollowers) {
        // Есть TG, но подписчиков вне диапазона min/max -> НЕ проходит, жёлтый
        const req = [];
        if (minF > 0) req.push('≥ ' + minF.toLocaleString('ru-RU'));
        if (maxF > 0) req.push('≤ ' + maxF.toLocaleString('ru-RU'));
        bolt.textContent = '⚠️';
        bolt.title = `TG: ${p.telegram}, но не проходит по фильтру подписчиков: ${p.followers != null ? p.followers.toLocaleString('ru-RU') : '—'}${req.length ? ' (нужно ' + req.join(' и ') + ')' : ''}`;
        bolt.className = 'igx-bolt is-no-tg' + (done ? ' is-done' : '');
        if (row) {
          row.classList.add(doneRowClass || 'igx-row-checked');
        }
      } else {
        // Нет TG -> СИНИЙ (или цвет «выжатости», если эксперт уже прочекан)
        bolt.textContent = '❌';
        bolt.title = 'Telegram не найден (нажмите для повторной проверки)';
        bolt.className = 'igx-bolt is-no-tg' + (done ? ' is-done' : '');
        if (row) {
          row.classList.add(doneRowClass || 'igx-row-checked');
        }
      }
      return;
    }

    if (viewed) {
      bolt.textContent = done ? '🏁' : '⚡';
      bolt.title = done
        ? `Прочекано: ${ds.followers && ds.following ? 'подписчики и подписки' : ds.followers ? 'подписчики' : 'подписки'} — внутрь больше можно не лезть`
        : 'Вы уже заходили сюда. Нажмите для быстрой проверки';
      bolt.className = 'igx-bolt' + (done ? ' is-done' : '');
      if (row) {
        row.classList.add(doneRowClass || 'igx-row-visited');
      }
      if (done && avatarBox) {
        avatarBox.classList.add('igx-avatar-done');
      }
      return;
    }

    // Не проверен
    bolt.textContent = '⚡';
    bolt.title = 'Быстро проверить наличие Telegram';
    bolt.className = 'igx-bolt';
  }

  function updateUIForUser(username) {
    const u = username.toLowerCase();
    document.querySelectorAll(`.igx-badge-wrap[data-igx-user="${u}"]`).forEach((wrap) => {
      const avatarBox = wrap.parentElement;
      if (!avatarBox) return;
      const row = findUserRow(wrap);
      refreshRowStatus(username, avatarBox, row);
    });
  }

  async function decorateElement(link) {
    const username = extractUsername(link);
    if (!username) return;

    // Кнопки ⚡ — только внутри модалок со списками (подписчики/подписки).
    // На страницах профилей, в сетке похожих аккаунтов и т.п. ничего не вешаем,
    // чтобы клики по странице не цепляли наши кнопки.
    if (!link.closest('[role="dialog"]')) return;

    const row = findUserRow(link);
    const img = link.querySelector('img') || (row ? row.querySelector('img') : null);
    if (!img) return;

    let avatarBox = img.closest('a, [role="button"], div[style*="width"], div[style*="height"]') || img.parentElement;
    if (avatarBox === img.parentElement && avatarBox.parentElement) {
      avatarBox = avatarBox.parentElement;
    }

    // Защита от дублирования значков внутри строки
    if (row && row.dataset.igxDecorated === username.toLowerCase()) {
      const existingWrap = avatarBox.querySelector('.igx-badge-wrap');
      if (existingWrap) refreshRowStatus(username, avatarBox, row);
      return;
    }

    if (avatarBox.querySelector('.igx-badge-wrap')) {
      const existingWrap = avatarBox.querySelector('.igx-badge-wrap');
      if (existingWrap) {
        if (row) row.dataset.igxDecorated = username.toLowerCase();
        refreshRowStatus(username, avatarBox, row);
        return;
      }
    }

    if (row) row.dataset.igxDecorated = username.toLowerCase();
    avatarBox.style.position = 'relative';
    avatarBox.style.overflow = 'visible';

    const wrap = document.createElement('span');
    wrap.className = 'igx-badge-wrap';
    wrap.dataset.igxUser = username.toLowerCase();

    const bolt = document.createElement('button');
    bolt.type = 'button';
    bolt.className = 'igx-bolt';
    bolt.title = 'Быстро проверить Telegram-ссылку';
    bolt.textContent = '⚡';

    wrap.appendChild(bolt);
    avatarBox.appendChild(wrap);

    const onEnter = async () => {
      const p = await getProfile(username);
      const viewed = await isViewed(username);
      let html;
      if (p) {
        html = `<b>@${username}</b><br>Подписчиков: ${p.followers != null ? p.followers.toLocaleString('ru-RU') : '—'}<br>TG: ${
          p.telegram ? p.telegram.replace('https://t.me/', '@') : 'не найден'
        }${p.tgContacts && p.tgContacts.length ? `<br>💰 Личка: ${p.tgContacts.map((c) => '@' + c).join(', ')}` : ''}${viewed ? '<br><i>(Вы уже просматривали этот профиль)</i>' : ''}`;
      } else if (viewed) {
        html = `<b>@${username}</b><br>Вы уже заходили, данные не извлечены`;
      } else {
        html = `<b>@${username}</b><br>Ещё не проверен (нажмите ⚡)`;
      }
      const dts = doneState(username);
      if (dts.followers || dts.following) {
        const what = dts.followers && dts.following ? 'подписчики и подписки' : dts.followers ? 'подписчики' : 'подписки';
        html += `<br>🏁 Прочекано: ${what}`;
      }
      showTooltip(html, wrap);
    };

    wrap.addEventListener('mouseenter', onEnter);
    wrap.addEventListener('mouseleave', hideTooltip);
    link.addEventListener('mouseenter', onEnter);
    link.addEventListener('mouseleave', hideTooltip);

    bolt.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Если TG уже найден:
      //  1 клик  — открыть ссылку в Телеграме (если их несколько — показать кнопки);
      //  2 клика быстрее 0.5 сек — режим проверки (поиск лички внутри).
      const p = await getProfile(username);
      if (p && p.telegram) {
        const links = (Array.isArray(p.telegrams) && p.telegrams.length ? p.telegrams : [p.telegram]).filter(Boolean);
        if (bolt._dblTimer) {
          clearTimeout(bolt._dblTimer);
          bolt._dblTimer = null;
          hideLinkMenu();
          runTgDeepCheck(username, p, wrap);
          return;
        }
        bolt._dblTimer = setTimeout(() => {
          bolt._dblTimer = null;
          tgSingleClickAction(links, wrap);
        }, 480);
        return;
      }
      enqueueQuickCheck(username, `https://www.instagram.com/${username}/`);
    });

    refreshRowStatus(username, avatarBox, row);
  }

  // ---------- один клик по ⚡: открыть ссылку в ТГ или показать кнопки всех ссылок ----------
  function openTgDomain(url) {
    const domain = tgUserOf(url);
    if (!domain) return;
    chrome.runtime.sendMessage({ type: 'tgOpenApp', domain }).catch(() => {});
  }

  function tgSingleClickAction(links, anchorEl) {
    if (!links.length) return;
    // Клик по ⚡ — явное действие пользователя, открываем всегда (галочка автооткрытия на это не влияет).
    if (links.length === 1) {
      openTgDomain(links[0]);
      showTooltip(`Открываю в Телеграме: <b>@${tgUserOf(links[0])}</b>`, anchorEl);
      setTimeout(hideTooltip, 2500);
      return;
    }
    showTgLinkMenu(links, anchorEl);
  }

  let linkMenuEl = null;
  function onDocClickCloseMenu(e) {
    if (linkMenuEl && linkMenuEl.contains(e.target)) return;
    hideLinkMenu();
  }
  function hideLinkMenu() {
    if (linkMenuEl) {
      linkMenuEl.remove();
      linkMenuEl = null;
    }
    document.removeEventListener('mousedown', onDocClickCloseMenu, true);
  }

  // Меню с кнопками всех TG-ссылок аккаунта (левее авы). Каждая подпись — тип ссылки.
  async function showTgLinkMenu(links, anchorEl) {
    hideLinkMenu();
    linkMenuEl = document.createElement('div');
    linkMenuEl.className = 'igx-link-menu';
    const title = document.createElement('div');
    title.className = 'igx-link-menu-title';
    title.textContent = 'Ссылки Телеграм — клик откроет в ТГ';
    linkMenuEl.appendChild(title);

    // Определяем тип каждой ссылки (личка/канал) через Bot API
    const targets = links.map(tgUserOf).filter(Boolean);
    let types = {};
    try {
      const r = await chrome.runtime.sendMessage({ type: 'tgClassifyLinks', targets });
      if (r && r.ok) types = r.result || {};
    } catch (_) {}
    if (!linkMenuEl) return;

    links.forEach((url) => {
      const t = tgUserOf(url);
      const kind = types[t];
      const label = kind === 'personal' ? '👤 Личка' : kind === 'channel' ? '📢 Канал' : '❔ Неизвестно';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'igx-link-btn' + (kind === 'personal' ? ' is-personal' : kind === 'channel' ? ' is-channel' : '');
      btn.innerHTML = `<span class="igx-link-kind">${label}</span><span class="igx-link-url">@${t}</span>`;
      btn.title = `Открыть @${t} в приложении Телеграм`;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openTgDomain(url);
        hideLinkMenu();
      });
      linkMenuEl.appendChild(btn);
    });

    document.body.appendChild(linkMenuEl);
    // Позиция — левее авы; если не влезает — правее.
    const rect = anchorEl.getBoundingClientRect();
    const mr = linkMenuEl.getBoundingClientRect();
    let left = rect.left - mr.width - 12;
    if (left < 8) left = rect.right + 12;
    const top = Math.min(Math.max(8, rect.top - mr.height / 2), Math.max(8, window.innerHeight - mr.height - 8));
    linkMenuEl.style.left = `${Math.round(left)}px`;
    linkMenuEl.style.top = `${Math.round(top)}px`;

    setTimeout(() => {
      document.addEventListener('mousedown', onDocClickCloseMenu, true);
    }, 0);
  }

  // ---------- повторная проверка: поиск лички внутри найденного Telegram ----------
  const pendingTgUsers = new Set();
  function isTgPending(username) {
    return pendingTgUsers.has(username.toLowerCase());
  }

  function tgUserOf(url) {
    return String(url || '')
      .replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, '')
      .replace(/^\//, '');
  }

  async function runTgDeepCheck(username, profile, anchorEl) {
    const u = username.toLowerCase();
    if (pendingTgUsers.has(u)) return;
    pendingTgUsers.add(u);
    updateUIForUser(username);
    const target = tgUserOf(profile.telegram);
    showTooltip(`🔍 Ищу личку в Telegram <b>@${target}</b>…<br>Порядок: описание → закрепы → сообщения.<br>Отчёт придёт в Telegram.`, anchorEl);
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'tgDeepCheck',
        igUsername: username,
        telegram: profile.telegram,
        telegrams: profile.telegrams || [],
      });
      if (r && r.ok && r.contacts && r.contacts.length) {
        const openedNote = r.openedPersonal ? '<br>Открыл личку в приложении ТГ.' : r.openedBot ? '<br>Открыл чат с ботом в ТГ (отчёт там).' : '';
        showTooltip(`💰 Личка найдена: ${r.contacts.map((c) => '@' + c).join(', ')}<br>Отчёт отправлен в Telegram.${openedNote}`, anchorEl);
      } else {
        showTooltip(`❌ Личка в Telegram не найдена${r && r.error ? `<br>${String(r.error).replace(/\n/g, '<br>')}` : ''}`, anchorEl);
      }
    } catch (err) {
      showTooltip(`❌ Ошибка: ${err.message || err}`, anchorEl);
    }
    pendingTgUsers.delete(u);
    updateUIForUser(username);
    setTimeout(hideTooltip, 8000);
  }

  function scanForRows(root = document) {
    root.querySelectorAll('a[href]').forEach(decorateElement);
  }

  // ---------- полоска перемотки на видео Инстаграма ----------
  // В ИГ нет перемотки видео/рилсов — рисуем свою полоску поверх: клик или перетаскивание =
  // мгновенный прыжок на таймкод (например, глянуть призыв к действию в конце, не пересматривая всё).
  function scanForVideos(root = document) {
    root.querySelectorAll('video:not([data-igx-seek])').forEach(enhanceVideo);
  }

  // Сканирование каруселей со слайдами (добавляем кнопки извлечения слайдов и копирования данных)
  function scanForCarousels(root = document) {
    try {
      const uls = root.querySelectorAll('ul._acay, ul[class*="acay"]');
      uls.forEach((ul) => {
        const container = ul.closest('div._aatk, div._aamw, div[class*="_aatk"]') || ul.parentElement;
        if (!container || container.querySelector('.igx-carousel-bar')) return;

        const bar = document.createElement('div');
        bar.className = 'igx-carousel-bar';
        bar.innerHTML =
          '<button type="button" class="igx-carousel-copy-meta" title="Скопировать данные карусели (дни, просмотры, лайки, комментарии, репосты, описание)">📋 Данные</button>' +
          '<button type="button" class="igx-carousel-ocr" title="Извлечь текст из слайдов карусели">📝 Слайды</button>';
        container.appendChild(bar);

        const ocrBtn = bar.querySelector('.igx-carousel-ocr');
        if (ocrBtn) {
          ocrBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openOcrPopup('carousel');
          });
          ocrBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
          ocrBtn.addEventListener('mousedown', (e) => e.stopPropagation());
        }

        const copyBtn = bar.querySelector('.igx-carousel-copy-meta');
        if (copyBtn) {
          copyBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            try {
              const article = findPostArticle(container);
              const postMeta = extractInstagramPostData(article || container);
              const metaStr = formatPostDataText(postMeta);
              // Пустой результат (нет ни одного поля) буфером обмена не затираем.
              if (!metaStr) {
                copyBtn.textContent = '∅';
                setTimeout(() => {
                  copyBtn.textContent = '📋 Данные';
                }, 2000);
                return;
              }
              const ok = await copyToClipboard(metaStr);
              if (ok) {
                copyBtn.textContent = '✓ Скопировано';
                setTimeout(() => {
                  copyBtn.textContent = '📋 Данные';
                }, 2000);
              }
            } catch (_) {}
          });
          copyBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
          copyBtn.addEventListener('mousedown', (e) => e.stopPropagation());
        }
      });
    } catch (_) {}
  }

  function fmtTime(s) {
    if (!isFinite(s)) return '—';
    s = Math.max(0, Math.floor(s));
    const m = Math.floor(s / 60);
    const sec = String(s % 60).padStart(2, '0');
    return `${m}:${sec}`;
  }

  // Полоска живёт НЕ внутри контейнера видео (ИГ глушит там события и накрывает оверлеями),
  // а прямо в document.body с position:fixed — поверх ВСЕГО на странице. Её позиция каждый кадр
  // синхронизируется с прямоугольником видео. Реестр + один общий цикл позиционирования.
  const igxSeekRegistry = new Set();
  let igxSeekLoopOn = false;

  function igxSeekFrame() {
    for (const item of Array.from(igxSeekRegistry)) {
      if (!item.video.isConnected) {
        // Ролик выпал из DOM: снимаем полоску, слушатели и метку data-igx-seek.
        // Без снятия метки ИГ, переиспользуя тот же <video>, оставлял полоску без
        // перерисовки навсегда: scanForVideos ищет только video:not([data-igx-seek]).
        try {
          item.destroy?.();
        } catch (_) {}
        item.bar.remove();
        igxSeekRegistry.delete(item);
        continue;
      }
      const r = item.video.getBoundingClientRect();
      const visible =
        r.width > 40 && r.height > 40 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
      if (!visible) {
        item.bar.style.display = 'none';
        continue;
      }
      item.bar.style.display = '';
      item.bar.style.left = r.left + 'px';
      item.bar.style.width = r.width + 'px';
      // Поднимаем на 46px над нижней кромкой — там у ИГ кнопка громкости/звука,
      // полоска не должна её накрывать.
      item.bar.style.top = Math.max(0, r.bottom - item.bar.offsetHeight - 46) + 'px';
    }
    if (igxSeekRegistry.size > 0) {
      requestAnimationFrame(igxSeekFrame);
    } else {
      igxSeekLoopOn = false;
    }
  }

  function enhanceVideo(video) {
    try {
      if (!video.crossOrigin) video.crossOrigin = 'anonymous';
    } catch (_) {}
    // Метку ставим ТОЛЬКО когда полоска реально создана: иначе видео (например, до
    // появления document.body) навсегда помечалось бы как обработанное без полоски.
    if (!document.body) return;
    video.dataset.igxSeek = '1';

    const bar = document.createElement('div');
    bar.className = 'igx-seekbar';
    bar.innerHTML =
      '<div class="igx-seek-track"><div class="igx-seek-fill"></div><div class="igx-seek-knob"></div></div>' +
      '<span class="igx-seek-time">0:00 / 0:00</span>' +
      '<button type="button" class="igx-seek-copy-meta" title="Скопировать данные ролика (дни, просмотры, лайки, комменты, репосты, описание)">📋</button>';
    document.body.appendChild(bar);

    const copyMetaSeekBtn = bar.querySelector('.igx-seek-copy-meta');
    if (copyMetaSeekBtn) {
      const handleCopyMeta = async (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        }
        try {
          const media = detectCurrentPostMedia();
          const scope = (media && media.scope) || video.closest('article, [role="dialog"], main, section') || document;
          const postMeta = extractInstagramPostData(scope);
          const metaStr = formatPostDataText(postMeta);
          // Данных не нашлось ни по одному полю: буфер обмена не трогаем —
          // иначе затрём его пустой строкой.
          if (!metaStr) {
            copyMetaSeekBtn.textContent = '∅';
            setTimeout(() => {
              copyMetaSeekBtn.textContent = '📋';
            }, 2000);
            return;
          }
          const ok = await copyToClipboard(metaStr);
          if (ok) {
            copyMetaSeekBtn.textContent = '✓';
            setTimeout(() => {
              copyMetaSeekBtn.textContent = '📋';
            }, 2000);
          }
        } catch (err) {
          console.warn('[Insta] copy metadata failed:', err);
        }
      };
      copyMetaSeekBtn.addEventListener('click', handleCopyMeta);
      copyMetaSeekBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      });
      copyMetaSeekBtn.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      });
    }

    const track = bar.querySelector('.igx-seek-track');
    const fill = bar.querySelector('.igx-seek-fill');
    const knob = bar.querySelector('.igx-seek-knob');
    const timeEl = bar.querySelector('.igx-seek-time');
    let dragging = false;
    let seekSeq = 0; // инкремент отменяет старые цепочки доводки перемотки — иначе они дерутся между собой и возвращают видео назад

    const seekItem = { video, bar, destroy: null };
    igxSeekRegistry.add(seekItem);
    if (!igxSeekLoopOn) {
      igxSeekLoopOn = true;
      requestAnimationFrame(igxSeekFrame);
    }

    const paint = (ratio) => {
      const pct = (Math.min(1, Math.max(0, ratio)) * 100).toFixed(2) + '%';
      fill.style.width = pct;
      knob.style.left = pct;
    };

    // Доводка: если плеер ИГ проигнорировал прыжок — повторяем. ВАЖНО: цепочка живёт только пока
    // её seq актуален (новый клик её убивает) и пока не идёт перетаскивание. Иначе старые цепочки
    // возвращали видео на старые таймкоды («нажал — видос начался заново»).
    let lastTargetT = null;
    const verifySeek = (t, seq, tries) => {
      setTimeout(() => {
        if (!video.isConnected || seq !== seekSeq || dragging) return;
        if (Math.abs(video.currentTime - t) > 1.5 && tries < 2) {
          try {
            video.currentTime = t;
          } catch (_) {}
          verifySeek(t, seq, tries + 1);
        }
      }, 400);
    };

    const ratioFromX = (clientX) => {
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return null;
      return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    };

    const seekTo = (clientX, withRetry) => {
      const ratio = ratioFromX(clientX);
      if (ratio == null) return;
      const d = video.duration;
      if (isFinite(d) && d > 0) {
        // не даём прыгнуть в самый конец — ИГ считает это «видео кончилось» и запускает заново с нуля.
        const t = Math.min(Math.max(0, d - 0.25), ratio * d);
        lastTargetT = t;
        seekSeq++;
        try {
          video.currentTime = t;
        } catch (_) {}
        if (withRetry) verifySeek(t, seekSeq, 0);
        timeEl.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
      }
      paint(ratio);
    };

    const sync = () => {
      if (dragging) return;
      const d = video.duration;
      paint(isFinite(d) && d > 0 ? video.currentTime / d : 0);
      timeEl.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(d)}`;
    };

    video.addEventListener('timeupdate', sync);
    video.addEventListener('durationchange', sync);
    video.addEventListener('loadedmetadata', sync);
    sync();

    // Проверяем, попал ли клик в нашу кнопку копирования метаданных
    const isSpecialBtn = (e) => {
      if (!e) return false;
      const t = e.target;
      if (copyMetaSeekBtn && (t === copyMetaSeekBtn || copyMetaSeekBtn.contains(t))) return true;
      if (copyMetaSeekBtn && copyMetaSeekBtn.isConnected) {
        const rc = copyMetaSeekBtn.getBoundingClientRect();
        if (rc.width > 0 && e.clientX >= rc.left && e.clientX <= rc.right && e.clientY >= rc.top && e.clientY <= rc.bottom) {
          return true;
        }
      }
      return false;
    };

    // События ловим НА УРОВНЕ ОКНА в фазе захвата (раньше любых обработчиков ИГ).
    // «Наше» событие = либо попало в DOM полоски, либо пришло в её прямоугольник координатами —
    // так его не перехватит даже невидимый оверлей ИГ, лежащий поверх.
    const owns = (e) => {
      if (bar.style.display === 'none') return false;
      if (isSpecialBtn(e)) return false; // кнопка копирования обрабатывает события сама
      if (e.target && bar.contains(e.target)) return true;
      const r = bar.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };

    const onDown = (e) => {
      if (isSpecialBtn(e)) return;
      if (!owns(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      dragging = true;
      seekTo(e.clientX, true);
    };
    let lastDragSeekAt = 0;
    const onMove = (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // Во время перетаскивания долбим плеер не чаще ~7 раз/сек, иначе лагает;
      // полоска при этом рисуется плавно каждый раз.
      const now = Date.now();
      const ratio = ratioFromX(e.clientX);
      if (ratio != null) {
        const d = video.duration;
        if (isFinite(d) && d > 0) {
          lastTargetT = Math.min(Math.max(0, d - 0.25), ratio * d);
          timeEl.textContent = `${fmtTime(lastTargetT)} / ${fmtTime(d)}`;
        }
        paint(ratio);
      }
      if (now - lastDragSeekAt > 140 && lastTargetT != null && isFinite(video.duration) && video.duration > 0) {
        lastDragSeekAt = now;
        try {
          video.currentTime = lastTargetT;
        } catch (_) {}
      }
    };
    const onUp = (e) => {
      if (isSpecialBtn(e)) return;
      if (!dragging) return;
      e.stopImmediatePropagation();
      dragging = false;
      // финальная доводка на то место, где отпустили (одна цепочка, без драк)
      if (lastTargetT != null && isFinite(video.duration) && video.duration > 0) {
        seekSeq++;
        try {
          video.currentTime = lastTargetT;
        } catch (_) {}
        verifySeek(lastTargetT, seekSeq, 0);
      }
      sync();
    };
    const onClick = (e) => {
      if (isSpecialBtn(e)) return;
      // чтобы ИГ не ставил паузу/плей по клику через нашу полоску
      if (!owns(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('click', onClick, true);

    // Снятие всего, что повесили выше. Вызывается из igxSeekFrame, когда видео
    // больше нет в DOM (ИГ пересоздаёт узлы ленты при скролле).
    seekItem.destroy = () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('click', onClick, true);
      video.removeEventListener('timeupdate', sync);
      video.removeEventListener('durationchange', sync);
      video.removeEventListener('loadedmetadata', sync);
      delete video.dataset.igxSeek;
    };
  }

  // ---------- извлечение текста из видео / слайдов (хук + призыв) ----------
  // Кнопки 📝 в боковой панели и на карусели: снимаем кадры первых и последних секунд
  // видео или слайды карусели, прогоняем через Tesseract / Whisper, копируем результат в буфер.
  function safeStorageGet(keys, fallback = {}) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const res = chrome.storage.local.get(keys);
        if (res && typeof res.then === 'function') {
          return res.catch(() => fallback);
        }
        return new Promise((resolve) => {
          try {
            chrome.storage.local.get(keys, (data) => {
              if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) resolve(fallback);
              else resolve(data || fallback);
            });
          } catch (_) {
            resolve(fallback);
          }
        });
      }
    } catch (_) {}
    return Promise.resolve(fallback);
  }

  function safeStorageSet(obj) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const res = chrome.storage.local.set(obj);
        if (res && typeof res.catch === 'function') {
          res.catch(() => {});
        }
      }
    } catch (_) {}
  }

  // То же для удаления записей: без .catch() такой вызов после обновления
  // расширения даёт «Uncaught (in promise) Error: Extension context invalidated.»
  function safeStorageRemove(keys) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const res = chrome.storage.local.remove(keys);
        if (res && typeof res.catch === 'function') {
          res.catch(() => {});
        }
      }
    } catch (_) {}
  }

  const OCR_START_KEY = 'igx_ocr_start_sec';
  const OCR_END_KEY = 'igx_ocr_end_sec';
  const OCR_MODE_KEY = 'igx_ocr_mode';
  const OCR_START_SLIDES_KEY = 'igx_ocr_start_slides';
  const OCR_END_SLIDES_KEY = 'igx_ocr_end_slides';
  const OCR_APIKEY_KEY = 'igx_ocr_apikey';
  // Режим «👁 вижу картинку»: нейронка вместе с текстом описывает и то, что изображено.
  // Работает с облачным ключом (Groq/OpenAI) и с локальной моделью ниже — не описывает
  // картинку только Tesseract.
  const OCR_VISION_KEY = 'igx_ocr_vision';
  const OCR_VIDEO_FPS_KEY = 'igx_ocr_video_fps';
  const OCR_INCLUDE_META_KEY = 'igx_ocr_include_meta';
  // Локальная vision-модель через LM Studio (OpenAI-совместимый сервер на localhost).
  // Ключи ровно те же, что читает ocr-offscreen.js: настройки снимаются там же, где
  // идёт распознавание, а не передаются полем в каждом запросе — иначе представление о
  // том, «кто из движков хозяин», разъехалось бы между двумя файлами.
  const LOCAL_OCR_ON_KEY = 'igx_local_ocr_on';
  const LOCAL_OCR_URL_KEY = 'igx_local_ocr_url';
  const LOCAL_OCR_MODEL_KEY = 'igx_local_ocr_model';
  const LOCAL_OCR_ORDER_KEY = 'igx_local_ocr_order';
  const LOCAL_OCR_DEFAULT_URL = 'http://localhost:1234';
  // Свой промпт для облачной нейронки. Пустая строка = «взять встроенный промпт
  // режима» (текст / vision). Значение ОДНО на все входы (попап OCR и анализатор
  // профиля), поэтому держим его в кэше и рассылаем оффскрину полем `prompt`.
  const OCR_PROMPT_KEY = 'igx_ocr_prompt';
  let igxOcrPrompt = '';
  let igxOcrPop = null;
  let igxActiveMediaType = 'video'; // 'video' или 'carousel'

  // Распознавание крутится в offscreen-документе расширения (Tesseract rus+eng + Whisper / Cloud API)
  function safeSendMessage(msg) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime || !chrome.runtime.id) {
        return reject(new Error('Расширение было обновлено в браузере. Пожалуйста, обнови страницу Instagram (F5).'));
      }
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            const err = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '';
            if (err.includes('context invalidated')) {
              return reject(new Error('Расширение было обновлено в браузере. Пожалуйста, обнови страницу Instagram (F5).'));
            }
            return reject(new Error(err));
          }
          resolve(res);
        });
      } catch (e) {
        if (String(e).includes('context invalidated')) {
          return reject(new Error('Расширение было обновлено в браузере. Пожалуйста, обнови страницу Instagram (F5).'));
        }
        reject(e);
      }
    });
  }

  // Ключ облачной распознавалки? По префиксу видно, потянет ли она описание картинки.
  function igxIsCloudKey(apiKey) {
    const k = String(apiKey || '').trim();
    return k.startsWith('gsk_') || k.startsWith('sk-');
  }

  // Предупреждения распознавалки (например: «облако упёрлось в лимит токенов, кадр
  // дочитан локально»). Оффскрин возвращает их полем `note`, тут они собираются в
  // один буфер и попадают в отчёт: иначе «текст хуже обычного» осталось бы невидимым.
  const igxOcrNotes = new Set();
  function igxOcrNote(text) {
    if (text) igxOcrNotes.add(String(text));
  }
  function igxOcrNotesFlush() {
    const list = Array.from(igxOcrNotes);
    igxOcrNotes.clear();
    return list;
  }
  function igxOcrNotesLine() {
    const list = igxOcrNotesFlush();
    return list.length ? '\n\n(⚠ ' + list.join('; ') + ')' : '';
  }

  // ---------- редактируемый промпт для облачной распознавалки ----------
  // Разметка и обработчик одни и те же в двух раскладках (попап OCR, анализатор
  // профиля): поле живёт в storage под одним ключом, поэтому любое изменение
  // мгновенно раскатывается по всем открытым редакторам.
  function igxPromptEditorHtml() {
    return (
      '<details class="igx-prompt-details">' +
      '<summary>🧠 Промпт для нейросети (можно редактировать)</summary>' +
      '<div class="igx-prompt-body">' +
      '<textarea class="igx-prompt-area" rows="4" spellcheck="false" placeholder="Пусто — используется встроенный промпт режима"></textarea>' +
      '<div class="igx-prompt-btns">' +
      '<button type="button" class="igx-prompt-btn" data-tpl="text">Шаблон: только текст</button>' +
      '<button type="button" class="igx-prompt-btn" data-tpl="vision">Шаблон: текст + 👁 описание</button>' +
      '<button type="button" class="igx-prompt-btn" data-tpl="clear">↩ Встроенный</button>' +
      '</div>' +
      '<span class="igx-prompt-hint">Касается нейронки: облачного ключа (Groq/OpenAI) и локальной модели LM Studio. Локальный Tesseract промпт не читает. При включённом 👁 оставь в тексте метки «Текст:» и «Что на слайде:» — по ним ответ раскладывается на два блока, иначе они слипнутся.</span>' +
      '</div>' +
      '</details>'
    );
  }

  let igxPromptTpl = null; // кэш встроенных промптов (просим у оффскрина один раз)
  function igxLoadPromptTemplates() {
    if (igxPromptTpl) return Promise.resolve(igxPromptTpl);
    return new Promise((resolve) => {
      const done = (v) => {
        igxPromptTpl = v || null;
        resolve(igxPromptTpl);
      };
      try {
        Promise.resolve(safeSendMessage({ type: 'ocrGetPrompts' })).then(
          (res) => done(res && res.ok ? { text: String(res.text || ''), vision: String(res.vision || '') } : null),
          () => done(null)
        );
      } catch (_) {
        done(null);
      }
    });
  }

  // Не пишем в storage на каждую клавишу: значение в памяти обновляется сразу, а
  // в chrome.storage уходит с задержкой — когда поле умолкло.
  let igxPromptSaveTimer = null;
  function igxPromptChanged(value) {
    igxOcrPrompt = String(value || '');
    clearTimeout(igxPromptSaveTimer);
    igxPromptSaveTimer = setTimeout(() => safeStorageSet({ [OCR_PROMPT_KEY]: igxOcrPrompt }), 400);
    igxSyncPromptEditors();
  }

  function igxSyncPromptEditors(except) {
    try {
      document.querySelectorAll('.igx-prompt-area').forEach((el) => {
        if (el === except || el === document.activeElement) return;
        if (el.value !== igxOcrPrompt) el.value = igxOcrPrompt || '';
        el.classList.toggle('is-custom', !!String(el.value || '').trim());
      });
    } catch (_) {}
  }

  function igxWirePromptEditor(root) {
    const box = root && root.querySelector('.igx-prompt-details');
    const area = box && box.querySelector('.igx-prompt-area');
    if (!area) return;
    area.value = igxOcrPrompt || '';
    area.classList.toggle('is-custom', !!String(area.value).trim());
    // Кэш storage на момент создания попапа мог ещё не подключиться — подтягиваем.
    safeStorageGet([OCR_PROMPT_KEY]).then((d) => {
      if (!d || typeof d[OCR_PROMPT_KEY] !== 'string') return;
      if (d[OCR_PROMPT_KEY] === igxOcrPrompt) return;
      igxOcrPrompt = d[OCR_PROMPT_KEY];
      igxSyncPromptEditors(area);
    });
    const sum = box.querySelector('summary');
    if (sum) sum.addEventListener('click', () => igxLoadPromptTemplates());
    area.addEventListener('input', () => igxPromptChanged(area.value));
    box.querySelectorAll('.igx-prompt-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const kind = btn.getAttribute('data-tpl');
        if (kind === 'clear') {
          igxPromptChanged('');
          area.value = '';
          return;
        }
        const tpl = await igxLoadPromptTemplates();
        if (!tpl || !tpl[kind]) {
          // Оффскрин не ответил (фон не поднялся?) — не вставляем пустоту молча.
          area.placeholder = 'Встроенный промпт не удалось получить — закрой и открой попап ещё раз.';
          return;
        }
        area.value = tpl[kind];
        igxPromptChanged(area.value);
      });
    });
  }

  // ---------- локальная vision-модель (LM Studio) ----------
  // Настройки живут в chrome.storage.local под теми же ключами, что читает оффскрин,
  // поэтому в каждый запрос их не тащим: два файла не могут разойтись в том, кто из
  // движков хозяин. Сам разбор идёт через `doOcr` оффскрина — тут только управление.
  function igxLocalOcrHtml() {
    return (
      '<details class="igx-ocr-local-details">' +
      '<summary>🏠 Локальная модель (LM Studio) — читает без лимитов</summary>' +
      '<div class="igx-ocr-local-body">' +
      '<label class="igx-ocr-local-row igx-ocr-local-chk"><input type="checkbox" class="igx-ocr-local-on" /><span>Использовать локальную модель</span></label>' +
      '<label class="igx-ocr-local-row">Кто читает первым:' +
      '<select class="igx-ocr-local-order">' +
      '<option value="cloud">облако, локалка на подхвате</option>' +
      '<option value="local">локалка, облако на подхвате</option>' +
      '<option value="only">только локалка (облако не трогать)</option>' +
      '</select></label>' +
      '<input type="text" class="igx-ocr-local-url" spellcheck="false" placeholder="http://localhost:1234" />' +
      '<input type="text" class="igx-ocr-local-model" spellcheck="false" placeholder="имя модели (пусто — возьмём загруженную)" />' +
      '<div class="igx-ocr-local-btns">' +
      '<button type="button" class="igx-ocr-local-check">🔌 Проверить</button>' +
      '<button type="button" class="igx-ocr-local-warm">🔥 Разогреть</button>' +
      '</div>' +
      '<div class="igx-ocr-local-note"></div>' +
      '<div class="igx-ocr-local-hint">LM Studio → Developer → «Serve Model» (порт 1234). Своя модель на своём железе не упирается в лимит токенов в минуту и читает стилизованный текст там, где Tesseract пасует. Первый запрос после простоя медленный — модель поднимается с диска, для этого и есть «Разогреть».</div>' +
      '</div>' +
      '</details>'
    );
  }

  // Снимок настроек локального движка, который уезжает в каждый запрос оффскрину.
  // Владелец настроек — по-прежнему оффскрин (он читает их из storage сам); этот снимок
  // нужен только как подстраховка, когда в документе распознавания `chrome.storage`
  // недоступен: живой запуск дал именно «Cannot read properties of undefined (reading
  // 'local')» после перезагрузки расширения, и тогда валилась вся цепочка движков.
  let igxLocalOcrSnap = {
    [LOCAL_OCR_ON_KEY]: false,
    [LOCAL_OCR_URL_KEY]: '',
    [LOCAL_OCR_MODEL_KEY]: '',
    [LOCAL_OCR_ORDER_KEY]: 'cloud',
  };
  function igxLocalOcrSnapSet(d) {
    if (!d) return;
    [LOCAL_OCR_ON_KEY, LOCAL_OCR_URL_KEY, LOCAL_OCR_MODEL_KEY, LOCAL_OCR_ORDER_KEY].forEach((k) => {
      if (k in d) igxLocalOcrSnap[k] = d[k];
    });
  }
  function igxLocalOcrSnapshot() {
    return Object.assign({}, igxLocalOcrSnap);
  }

  // Короткий синхронный кэш выбора движка: строка цены прогона в анализаторе обязана
  // перестать врать про «≈3 картинки в минуту» в тот же миг, как сняли галку, а не
  // после следующего похода в storage.
  let igxLocalOcrState = { on: false, order: 'cloud' };
  function igxLocalOcrApply(on, order) {
    igxLocalOcrState = { on: !!on, order: ['cloud', 'local', 'only'].indexOf(order) >= 0 ? order : 'cloud' };
    try {
      if (igxPaPop && typeof igxPaPop._igxPaDrawCost === 'function') igxPaPop._igxPaDrawCost();
    } catch (_) {}
    return igxLocalOcrState;
  }
  function igxLocalOcrRefresh() {
    return safeStorageGet([LOCAL_OCR_ON_KEY, LOCAL_OCR_URL_KEY, LOCAL_OCR_MODEL_KEY, LOCAL_OCR_ORDER_KEY]).then(
      (d) => {
        d = d || {};
        igxLocalOcrSnapSet(d);
        return igxLocalOcrApply(d[LOCAL_OCR_ON_KEY] === true, d[LOCAL_OCR_ORDER_KEY]);
      },
      () => igxLocalOcrState
    );
  }
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (
        !(LOCAL_OCR_ON_KEY in changes) &&
        !(LOCAL_OCR_ORDER_KEY in changes) &&
        !(LOCAL_OCR_URL_KEY in changes) &&
        !(LOCAL_OCR_MODEL_KEY in changes)
      ) {
        return;
      }
      igxLocalOcrRefresh();
    });
  } catch (_) {}
  // Стартовое значение: пока не дочитаемся, считаем, что локалки нет (как было раньше).
  igxLocalOcrRefresh();

  // Кому по силам описание картинки («👁 вижу картинку»): облачный ключ или локальная
  // модель LM Studio. Снимать флаг vision надо только перед Tesseract — он картинок
  // не видит, и галка молча превращалась бы в украшение интерфейса.
  function igxVisionWorks(apiKey) {
    return igxIsCloudKey(apiKey) || igxLocalOcrState.on;
  }

  // Прогрев локальной модели перед разбором. LM Studio после простоя поднимает
  // модель с диска десятки секунд: если это случится на первом кадре, плата тихо
  // съест таймаут прямого видео OCR посреди прогона. Пусть будет видна отдельной
  // строкой статуса ДО работы. Греем только когда локалка реально будет читать:
  // при хозяине-облаке с валидным ключом она нужна лишь на подмену.
  async function igxLocalWarmIfNeeded(apiKey, setStatus, needed) {
    await igxLocalOcrRefresh();
    if (!needed || !igxLocalOcrState.on) return;
    if (igxLocalOcrState.order === 'cloud' && igxIsCloudKey(apiKey)) return;
    setStatus('Грею локальную модель (LM Studio)…');
    const w = await Promise.resolve(safeSendMessage({ type: 'ocrLocalWarm' })).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    setStatus(w && w.ok
      ? 'Локальная модель готова: ' + Math.max(1, Math.round((w.ms || 0) / 1000)) + ' с.'
      : 'Локальная модель не ответила (' + ((w && w.error) || 'LM Studio не найден') + ') — читаем тем, что есть.');
    await new Promise((r) => setTimeout(r, 1500));
  }

  function igxWireLocalOcr(root) {
    const box = root && root.querySelector('.igx-ocr-local-details');
    if (!box) return;
    const on = box.querySelector('.igx-ocr-local-on');
    const order = box.querySelector('.igx-ocr-local-order');
    const url = box.querySelector('.igx-ocr-local-url');
    const model = box.querySelector('.igx-ocr-local-model');
    const note = box.querySelector('.igx-ocr-local-note');
    if (!on || !order || !url || !model) return;

    safeStorageGet([LOCAL_OCR_ON_KEY, LOCAL_OCR_URL_KEY, LOCAL_OCR_MODEL_KEY, LOCAL_OCR_ORDER_KEY]).then((d) => {
      d = d || {};
      on.checked = d[LOCAL_OCR_ON_KEY] === true;
      order.value = d[LOCAL_OCR_ORDER_KEY] || 'cloud';
      url.value = d[LOCAL_OCR_URL_KEY] || '';
      url.placeholder = LOCAL_OCR_DEFAULT_URL;
      model.value = d[LOCAL_OCR_MODEL_KEY] || '';
      // Открытие попапа — хороший момент сверить синхронный кэш движка (строка цены
      // в анализаторе и флаг vision зависят именно от него).
      igxLocalOcrApply(on.checked, order.value);
    });

    const save = () => {
      const snap = {
        [LOCAL_OCR_ON_KEY]: on.checked,
        [LOCAL_OCR_ORDER_KEY]: order.value,
        [LOCAL_OCR_URL_KEY]: url.value.trim(),
        [LOCAL_OCR_MODEL_KEY]: model.value.trim(),
      };
      // Снимок обновляем сразу, не дожидаясь записи в storage и её onChanged: если
      // расширению станет плохо ровно в этот момент, оффскрин возьмёт то, что человек
      // видит в попапе.
      igxLocalOcrSnapSet(snap);
      safeStorageSet(snap);
      igxLocalOcrApply(on.checked, order.value);
    };
    const setNote = (text, kind) => {
      if (!note) return;
      note.textContent = text || '';
      note.className = 'igx-ocr-local-note' + (kind ? ' is-' + kind : '');
    };
    on.addEventListener('change', () => {
      save();
      setNote('');
    });
    order.addEventListener('change', () => {
      save();
      setNote('');
    });
    url.addEventListener('input', save);
    model.addEventListener('input', save);

    const fmtMs = (ms) => (ms >= 3000 ? (ms / 1000).toFixed(1).replace('.', ',') + ' с' : Math.round(ms) + ' мс');
    const cmd = (type, btn, busy) => {
      const prev = btn.textContent;
      btn.disabled = true;
      btn.textContent = busy;
      setNote('Жду ответ LM Studio…', '');
      Promise.resolve(safeSendMessage({ type, cfg: igxLocalOcrSnapshot() })).then(
        (r) => {
          if (r && r.ok) {
            setNote(
              '✓ ' + (r.model || 'модель на связи') + ' · ответ ' + fmtMs(r.ms || 0) + (r.warm ? ' — прогрета' : '') + (r.via ? ' · ' + r.via : ''),
              'ok'
            );
          } else setNote('✗ ' + ((r && r.error) || 'LM Studio не ответил — включён ли сервер (lms server start)?'), 'bad');
        },
        (e) => setNote('✗ ' + String((e && e.message) || e), 'bad')
      ).finally(() => {
        btn.disabled = false;
        btn.textContent = prev;
      });
    };
    const checkBtn = box.querySelector('.igx-ocr-local-check');
    const warmBtn = box.querySelector('.igx-ocr-local-warm');
    if (checkBtn) {
      checkBtn.addEventListener('click', (e) => {
        e.preventDefault();
        cmd('ocrLocalTest', checkBtn, 'Проверяю…');
      });
    }
    if (warmBtn) {
      warmBtn.addEventListener('click', (e) => {
        e.preventDefault();
        cmd('ocrLocalWarm', warmBtn, 'Грею модель…');
      });
    }
  }

  try {
    chrome.storage.local.get([OCR_PROMPT_KEY]).then((d) => {
      if (d && typeof d[OCR_PROMPT_KEY] === 'string') {
        igxOcrPrompt = d[OCR_PROMPT_KEY];
        igxSyncPromptEditors();
      }
    }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[OCR_PROMPT_KEY]) return;
      igxOcrPrompt = String(changes[OCR_PROMPT_KEY].newValue || '');
      igxSyncPromptEditors();
    });
  } catch (_) {}

  // Таймауты с запасом: оффскрин умеет ждать «окно токенов» облака (до 30 с на
  // картинку вместо мгновенного 429), поэтому прежние 35 с отсекали заодно и это
  // легитимное ожидание — пользователь получал «Таймаут распознавания» вместо текста.
  // promptOverride — отдельный вопрос для vision-модели («вердикт по закрепу»):
  // тот же канал, что и OCR, но свой промпт вместо пользовательского и БЕЗ
  // vision-оформления (ответ — одна строка, а не блоки «Текст/Что на слайде»).
  async function ocrRecognize(dataUrl, apiKey, vision, promptOverride) {
    const timer = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Таймаут распознавания кадра (90 с) — облако могло ждать окно лимита токенов.')), 90000)
    );
    const own = promptOverride != null && String(promptOverride).trim() ? String(promptOverride) : '';
    const r = await Promise.race([
      safeSendMessage({ type: 'ocrRecognize', image: dataUrl, apiKey: apiKey || '', vision: own ? false : (!!vision && igxVisionWorks(apiKey)), prompt: own || igxOcrPrompt || '', cfg: igxLocalOcrSnapshot() }),
      timer,
    ]);
    if (!r) throw new Error('Распознавалка не ответила.');
    if (r.error) throw new Error(r.error);
    igxOcrNote(r.note);
    return (r.text || '').trim();
  }

  async function ocrRecognizeUrl(url, apiKey, vision, promptOverride) {
    const timer = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Таймаут распознавания слайда (90 с) — облако могло ждать окно лимита токенов.')), 90000)
    );
    // Свой промпт (как в ocrRecognize) отключает встроенный vision-формат: модель всё
    // равно видит картинку, но ответ диктует наш текст — иначе два «формататора» спорят.
    const own = promptOverride != null && String(promptOverride).trim() ? String(promptOverride) : '';
    const r = await Promise.race([
      safeSendMessage({ type: 'ocrRecognizeUrl', url, apiKey: apiKey || '', vision: own ? false : (!!vision && igxVisionWorks(apiKey)), prompt: own || igxOcrPrompt || '', cfg: igxLocalOcrSnapshot() }),
      timer,
    ]);
    if (!r) throw new Error('Распознавалка не ответила.');
    if (r.error) throw new Error(r.error);
    igxOcrNote(r.note);
    return (r.text || '').trim();
  }

  async function ocrVideoDirect(url, headTimestamps, tailTimestamps, apiKey, vision) {
    // Внутри одного запроса оффскрин перебирает несколько кадров, каждый может
    // досчитывать локально или ждать окна лимита — отсюда самый щедрый таймаут.
    const timer = new Promise((_, rej) =>
      setTimeout(() => {
        // Флаг timeout читает анализатор профиля: после такого провала нельзя ещё раз
        // снимать те же кадры — это сверху ровно столько же ожидания лимита.
        const e = new Error('Таймаут прямого распознавания видео (200 с).');
        e.timeout = true;
        rej(e);
      }, 200000)
    );
    const res = await Promise.race([
      safeSendMessage({ type: 'ocrVideoDirect', url, headTimestamps, tailTimestamps, apiKey: apiKey || '', vision: !!vision && igxVisionWorks(apiKey), prompt: igxOcrPrompt || '', cfg: igxLocalOcrSnapshot() }),
      timer,
    ]);
    if (!res) throw new Error('Распознавалка не ответила.');
    if (res.error) throw new Error(res.error);
    igxOcrNote(res.note);
    return { headText: (res.headText || '').trim(), tailText: (res.tailText || '').trim() };
  }

  // ВАЖНО: тип сообщения должен быть «asrRecognize»/«asrRecognizeUrl» (их разбирает
  // background.js и только он гарантирует создание offscreen-документа). С прежними
  // прямыми «asrDo»/«asrDoUrl» речь не работала, если распознавание речи было первым
  // обращением к offscreen: получателя ещё не существовало, приходило
  // «Could not establish connection».
  async function asrRecognize(base64, apiKey) {
    const timer = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Таймаут распознавания речи (60 с).')), 60000)
    );
    const r = await Promise.race([
      safeSendMessage({ type: 'asrRecognize', audio: base64, apiKey: apiKey || '' }),
      timer,
    ]);
    if (!r) throw new Error('Распознавалка речи не ответила.');
    if (r.error) throw new Error(r.error);
    return (r.text || '').trim();
  }

  async function asrRecognizeUrl(url, headTo, tailFrom, tailTo, apiKey) {
    const timer = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Таймаут распознавания речи (120 с).')), 120000)
    );
    const r = await Promise.race([
      safeSendMessage({ type: 'asrRecognizeUrl', url, headTo, tailFrom, tailTo, apiKey: apiKey || '' }),
      timer,
    ]);
    if (!r) throw new Error('Распознавалка речи не ответила.');
    if (r.error) throw new Error(r.error);
    return { headText: (r.headText || '').trim(), tailText: (r.tailText || '').trim() };
  }

  // Поиск прямого HTTP URL видео с очисткой параметров сегментации (bytestart/byteend)
  function findVideoUrl(video) {
    if (!video) return null;
    const cleanUrl = (u) => {
      if (!u || !u.startsWith('http') || !u.includes('.mp4')) return null;
      try {
        const parsed = new URL(u);
        parsed.searchParams.delete('bytestart');
        parsed.searchParams.delete('byteend');
        return parsed.toString();
      } catch (_) {
        return u.replace(/[?&]bytestart=\d+/g, '').replace(/[?&]byteend=\d+/g, '');
      }
    };

    const src = cleanUrl(video.currentSrc || video.src);
    if (src) return src;

    const sourceEl = video.querySelector('source');
    if (sourceEl) {
      const sSrc = cleanUrl(sourceEl.src);
      if (sSrc) return sSrc;
    }
    return null;
  }

  // ---------------- Маскировка всего лишнего перед снимком вкладки ----------------
  // Наш собственный интерфейс (полоска таймкода с кнопкой 📋, полоска карусели,
  // попап OCR, панель) и оверлеи плеера Instagram попадают в снимок вкладки и раньше
  // распознавались как текст — прямо в коде видно, как filterCleanTextLines отдельно
  // вырезает строки вида «0:00 / 1:07», т.е. таймер нашей же полоски.
  const IGX_OVERLAY_SELECTORS = [
    '.igx-seekbar',
    '.igx-carousel-bar',
    '.igx-ocr-pop',
    '.igx-side-panel',
    '.igx-pa-pop',
    '.igx-afk-pop',
    '.igx-tooltip',
    '.igx-link-menu',
  ];

  // Оверлеи самого Instagram внутри области поста (те же, что прячет captureRange)
  const IGX_IG_OVERLAY_SELECTORS = [
    'svg[aria-label="Play"]',
    'svg[aria-label="Воспроизвести"]',
    '[aria-label*="Play"]',
    '[aria-label*="Воспроизвести"]',
    'div._9zs5',
    'div._aae-',
    'div[role="progressbar"]',
    'div._ab6-',
    'div._aamz',
  ];

  // Прячет наш UI и оверлеи плеера на время снимка. Возвращает функцию восстановления
  // (вызывать её обязательно в finally/на всех ветках, иначе UI останется невидимым).
  function hideCaptureObstructions(element) {
    const hidden = [];
    const hide = (el, prop, value) => {
      if (!el || !el.style) return;
      if (String(el.style[prop]) === String(value)) return;
      const prev = el.style[prop];
      el.style[prop] = value;
      hidden.push({ el, prop, prev });
    };

    // 1. Наш интерфейс — целиком (иначе таймер полоски снова уедет в OCR)
    IGX_OVERLAY_SELECTORS.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        hide(el, 'visibility', 'hidden');
        // Попап OCR прячем только прозрачностью: он перетаскиваемый, и лишние
        // правки его стилей ни к чему.
        if (!el.classList || !el.classList.contains('igx-ocr-pop')) hide(el, 'opacity', '0');
      });
    });

    // 2. Оверлеи плеера Instagram в области поста
    const root =
      (element && element.closest && element.closest('article, [role="dialog"], div._aatk, div._aamw, div._ab6-')) ||
      document.body;
    IGX_IG_OVERLAY_SELECTORS.forEach((sel) => {
      root.querySelectorAll(sel).forEach((el) => {
        const b = el.closest('button, [role="button"]') || el;
        hide(b, 'display', 'none');
      });
    });

    // 3. Текстовый таймер плеера Instagram (0:00 / 1:07)
    root.querySelectorAll('div, span').forEach((el) => {
      const t = (el.innerText || el.textContent || '').trim();
      if (/^\d{1,2}:\d{2}\s*(?:\/|из|of)\s*\d{1,2}:\d{2}$/.test(t) && el.children.length === 0) {
        hide(el, 'display', 'none');
      }
    });

    return () => {
      hidden.forEach(({ el, prop, prev }) => {
        try { el.style[prop] = prev; } catch (_) {}
      });
      hidden.length = 0;
    };
  }

  // Прямой снимок кадра через Canvas без вызова captureVisibleTab (если нет CORS-блокировки).
  // Это ЧИСТЫЙ кадр: без оверлеев Instagram и без нашего UI, поэтому он всегда предпочтительнее.
  function captureVideoDirectCanvas(video) {
    try {
      if (!video || !video.videoWidth || !video.videoHeight) return null;
      const cnv = document.createElement('canvas');
      cnv.width = video.videoWidth;
      cnv.height = video.videoHeight;
      const ctx = cnv.getContext('2d');
      ctx.drawImage(video, 0, 0, cnv.width, cnv.height);
      return cnv.toDataURL('image/jpeg', 0.92);
    } catch (_) {
      return null;
    }
  }

  // Чистый кадр элемента поста (слайда или видео): с <video> сначала пробуем canvas,
  // и только если он недоступен (taint/CORS) — снимок вкладки как фолбэк.
  // Никакой перемотки: кадр берётся как есть, поэтому функция безопасна для карусели.
  async function captureElementClean(el) {
    if (!el) return null;
    if (el.tagName === 'VIDEO') {
      const direct = captureVideoDirectCanvas(el);
      if (direct) return direct;
    }
    try {
      return await captureVideoViaTab(el);
    } catch (e) {
      console.warn('Снимок элемента не удался:', e);
      // Честная строчка В ОТЧЁТ (не только в консоль): кадр не снят, потому что окно в
      // этот момент не отрисовывалось (перекрыто/свернуто/фон). Так видно, какой пост
      // реально проскочил распознавалку, а не «молча пустой» блок.
      try { igxOcrNote('кадр не снят — окно было перекрыто или не отрисовано: ' + igxPaErrMsg(e)); } catch (_) {}
      return null;
    }
  }

  // Захват кадра через снимок вкладки с точным масштабированием (фолбэк).
  // Перед снимком прячем СВОЙ UI (полоска таймкода с 📋, полоска карусели, попап OCR)
  // и оверлеи плеера Instagram, после — возвращаем всё как было.
  function captureVideoViaTab(element) {
    return new Promise((resolve, reject) => {
      const restore = hideCaptureObstructions(element);
      let settled = false;
      let guard = 0;
      // Единожды прячем/возвращаем интерфейс и закрываем промис. Раньше при зависшем
      // rAF/снимке ни restore(), ни reject не вызывались вовсе — на этом вёрстка ночного
      // прогона и вставала на первом же незагруженном рилсе.
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        try { restore(); } catch (_) {}
        try { fn(); } catch (e) { reject(e); }
      };
      // Жёсткий предохранитель: в свёрнутом окне / с погасшим экраном requestAnimationFrame
      // и captureVisibleTab могут НИКОГДА не вернуться. Через 12 с честно падаем в ошибку:
      // captureElementClean вернёт null, разбор пропустит кадр вместо вечной паузы.
      guard = setTimeout(
        () => finish(() => reject(new Error('Снимок вкладки не дождён: окно скрыто или экран погас.'))),
        12000
      );
      let kicked = false;
      const kick = () => {
        if (kicked || settled) return;
        kicked = true;
        safeSendMessage({ type: 'captureTab' })
          .then((res) => {
            if (settled) return;
            if (!res || !res.dataUrl) {
              return finish(() => reject(new Error((res && res.error) || 'Снимок вкладки не удался.')));
            }
            const img = new Image();
            img.onload = () => {
              if (settled) return;
              try {
                const r = element.getBoundingClientRect();
                const scaleX = img.naturalWidth / window.innerWidth;
                const scaleY = img.naturalHeight / window.innerHeight;
                const sx = Math.max(0, Math.round(r.left * scaleX));
                const sy = Math.max(0, Math.round(r.top * scaleY));
                const sw = Math.min(img.naturalWidth - sx, Math.max(1, Math.round(r.width * scaleX)));
                const sh = Math.min(img.naturalHeight - sy, Math.max(1, Math.round(r.height * scaleY)));
                if (sw <= 0 || sh <= 0) {
                  return finish(() => reject(new Error('Элемент за пределами видимой области экрана.')));
                }
                // Раньше длинная сторона ужималась до 1280 px — мелкий стилизованный текст
                // рилсов после такого даунскейла Tesseract уже не разбирал. Теперь ориентир
                // 1600 px, апскейл разрешён (но не выше 2x, чтобы не раздувать кадры).
                const scale = Math.max(0.3, Math.min(2.0, 1600 / Math.max(sw, sh)));
                const cropCnv = document.createElement('canvas');
                cropCnv.width = Math.max(1, Math.round(sw * scale));
                cropCnv.height = Math.max(1, Math.round(sh * scale));
                const cropCtx = cropCnv.getContext('2d');
                cropCtx.imageSmoothingEnabled = true;
                cropCtx.imageSmoothingQuality = 'high';
                cropCtx.drawImage(img, sx, sy, sw, sh, 0, 0, cropCnv.width, cropCnv.height);
                const out = cropCnv.toDataURL('image/jpeg', 0.94);
                finish(() => resolve(out));
              } catch (e) {
                finish(() => reject(e));
              }
            };
            img.onerror = (e) => finish(() => reject(e));
            img.src = res.dataUrl;
          })
          .catch((err) => finish(() => reject(err)));
      };
      requestAnimationFrame(kick);
      // Фолбэк для скрытого окна, где rAF не горит: через 250 мс всё равно пробуем —
      // captureVisibleTab сам вернёт ошибку, если окно не видимо, вместо зависания.
      setTimeout(kick, 250);
    });
  }

  function videoSeekTo(video, t) {
    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        video.removeEventListener('seeked', onSeeked);
        clearTimeout(timer);
        setTimeout(resolve, 200);
      };
      const onSeeked = () => done();
      const timer = setTimeout(done, 600);
      video.addEventListener('seeked', onSeeked, { once: true });
      try {
        // Защита от перескока в конец: отступаем 0.25 с от конца видео,
        // чтобы Instagram не триггерил авто-луп в 0:00 и экран повтора
        const maxSeek = Math.max(0.02, (video.duration || 10) - 0.25);
        const target = Math.min(maxSeek, Math.max(0.02, t));
        video.currentTime = target;
      } catch (_) {
        done();
      }
    });
  }

  function getRangeTimestamps(from, to, fpsLevel) {
    const dur = Math.max(0.1, to - from);
    const stepMap = {
      1: 2.5,
      2: 1.5,
      3: 1.0,
      4: 0.5,
      5: 0.3,
    };
    const step = stepMap[fpsLevel] || 1.0;
    const timestamps = [];

    // Первый кадр в начале диапазона
    const first = Math.round((from + 0.1) * 10) / 10;
    timestamps.push(first);

    let cur = from + step;
    while (cur < to - 0.05) {
      timestamps.push(Math.round(cur * 10) / 10);
      cur += step;
    }

    const last = Math.round(Math.max(from + 0.1, to - 0.1) * 10) / 10;
    if (!timestamps.includes(last)) timestamps.push(last);

    return Array.from(new Set(timestamps)).sort((a, b) => a - b);
  }

  // Ровно N кадров на отрезке: первый у начала, последний у конца, остальные
  // равномерно между ними. Нужен анализатору профиля: там пользователь задаёт
  // ЧИСЛО кадров, а не частоту — меньше кадров = меньше платных запросов к облаку.
  function getEvenTimestamps(from, to, count) {
    const n = Math.max(1, Math.min(12, Math.round(Number(count) || 1)));
    const dur = Math.max(0.2, to - from);
    const lo = from + 0.1;
    const hi = Math.max(lo, to - 0.1);
    if (n === 1) return [Math.round(lo * 10) / 10];
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = from + (dur * i) / (n - 1);
      out.push(Math.round(Math.min(Math.max(t, lo), hi) * 10) / 10);
    }
    return Array.from(new Set(out)).sort((a, b) => a - b);
  }

  // fpsLevel — уровень «fps» из настроек (частота), либо уже готовый массив таймкодов:
  // тогда снимаем ровно по ним (анализатор профиля сам считает число кадров).
  async function captureRange(video, from, to, fpsLevelOrTimestamps, statusEl, label) {
    const frames = [];
    const timestamps = Array.isArray(fpsLevelOrTimestamps)
      ? fpsLevelOrTimestamps.slice()
      : getRangeTimestamps(from, to, fpsLevelOrTimestamps);

    try {
      video.scrollIntoView?.({ block: 'center', behavior: 'instant' });
    } catch (_) {}

    // «🛡 анти-залипание»: не листать таймкоды по заведомо негрузящемуся плееру — иначе
    // seek не доходит, кадры пустые/одинаковые, и разбор «нихуя не анализирует». Доводим до готовности.
    // Ждём ТОЛЬКО когда длительность ещё не посчиталась (реально битый плеер): раньше требовали
    // readyState>=2 — из-за этого даже у здорового видео каждый вызов впадал в долгое ожидание.
    if (_paGuardOn && video && !igxPaVideoReady(video)) {
      try { await igxPaWaitVideoMeta(video, 3000); } catch (_) {}
      // Так и не грузнулся (Instagram отдал «не удалось загрузить») — уходим сразу:
      // не крутим seek'ы по мёртвому плееру, иначе каждый кадр упирается в 12-с
      // предохранитель съёмки и прогон ползёт минутами вместо честного пропуска.
      if (!igxPaVideoReady(video)) {
        if (statusEl) { try { statusEl.textContent = 'Видео не загрузилось — пропускаю этот пост.'; } catch (_) {} }
        return frames;
      }
    }

    // Временно скрываем оверлеи паузы/воспроизведения, полосы прогресса и таймер плеера Instagram
    // Временно скрываем наш UI и оверлеи паузы/воспроизведения, полосы прогресса
    // и таймер плеера Instagram — общий помощник, тот же прячет UI в снимке вкладки.
    const restoreObstructions = hideCaptureObstructions(video);
    try {
      let lastFrame = null;
      for (let i = 0; i < timestamps.length; i++) {
        const t = timestamps[i];
        if (statusEl) {
          statusEl.textContent = `Снимаю кадр ${label} (${i + 1}/${timestamps.length}, ${t.toFixed(1)} с)…`;
        }
        await videoSeekTo(video, t);
        // Чистый кадр (canvas с <video>) в приоритете, снимок вкладки — фолбэк
        const frame = await captureElementClean(video);
        if (frame && frame !== lastFrame) {
          frames.push(frame);
          lastFrame = frame;
        }
      }
      // Кадров больше НЕ снимаем. Если после этой строчки висит долго — виноват уже
      // не плеер и не перемотка, а ожидание ответа нейронки (у неё свой потолок 90 с).
      // Без этой подсказки статус врал «Снимаю кадр конца (2/2, 54.0 с)…» полторы минуты,
      // пока на самом деле молчало облако, и баг искали не в том месте.
      if (statusEl && frames.length) {
        try { statusEl.textContent = `Кадры сняты (${frames.length}) — жду ответ нейронки…`; } catch (_) {}
      }
    } finally {
      restoreObstructions();
    }
    return frames;
  }

  function compactOcrText(s) {
    const input = Array.isArray(s) ? s.join('\n') : String(s || '');
    const rawLines = input
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => {
        // Отсекаем оверлеи таймеров плеера 0:00 / 1:07
        if (/^\d{1,2}:\d{2}\s*(?:\/|из|of)\s*\d{1,2}:\d{2}$/.test(l)) return false;
        if (l.length <= 1 && !/[\p{L}\p{N}]/u.test(l)) return false;
        return true;
      });

    const unique = [];
    const seen = new Set();
    for (const l of rawLines) {
      const key = l.toLowerCase().replace(/\s+/g, ' ');
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(l);
      }
    }

    // Удаляем обрывочные строки анимации печатной машинки (префиксы более длинных фраз)
    // Служебные метки vision-режима («Текст:», «Что на слайде:») — это структура
    // отчёта, а не распознанный текст: правило «строка-префикс» их съедает, если
    // такое слово случайно попало в описание или в надписи на слайде.
    const STRUCT_RE = /^(?:текст|что\s+(?:на|в)\s+[\wа-яё]+)\s*[:—]/i;
    const finalLines = [];
    for (let i = 0; i < unique.length; i++) {
      const a = unique[i];
      const aNorm = a.toLowerCase().replace(/\s+/g, ' ');
      let isSub = false;
      if (!STRUCT_RE.test(aNorm)) {
        for (let j = 0; j < unique.length; j++) {
          if (i === j) continue;
          const bNorm = unique[j].toLowerCase().replace(/\s+/g, ' ');
          if (bNorm.length > aNorm.length && bNorm.includes(aNorm)) {
            isSub = true;
            break;
          }
        }
      }
      if (!isSub) {
        const validShort = new Set(['в', 'и', 'с', 'к', 'у', 'о', 'а', 'не', 'на', 'по', 'за', 'из', 'от', 'до', 'об']);
        if (aNorm.length <= 2 && !validShort.has(aNorm) && !/^\d+$/.test(aNorm)) {
          continue;
        }
        finalLines.push(a);
      }
    }

    return finalLines.join('\n');
  }

  // Поиск встроенных субтитров Instagram в DOM
  function findReelsCaptionText(scope) {
    if (!scope) return '';
    const candidates = scope.querySelectorAll(
      'div[data-testid*="caption"], div[class*="caption"], div[class*="subtitle"], span[class*="caption"]'
    );
    const texts = [];
    for (const el of candidates) {
      const txt = (el.innerText || '').trim();
      if (txt && txt.length > 2 && !txt.includes('Follow') && !txt.includes('Подписаться')) {
        texts.push(txt);
      }
    }
    return texts.join(' ').trim();
  }

  // Самое видимое видео на экране
  function pickBestVideo() {
    let best = null;
    let bestArea = 0;
    document.querySelectorAll('video').forEach((v) => {
      if (!isFinite(v.duration) || v.duration <= 0.5) return;
      const r = v.getBoundingClientRect();
      const visW = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
      const visH = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      const area = visW > 0 && visH > 0 ? visW * visH : 0;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    });
    return best;
  }

  // Поиск статьи (article) текущего поста
  function findPostArticle(scope) {
    if (scope && scope !== document && scope !== document.body) {
      if (scope.tagName === 'ARTICLE') return scope;
      const art = scope.closest?.('article');
      if (art) return art;
      const innerArt = scope.querySelector?.('article');
      if (innerArt) return innerArt;
    }

    // 1. Модальное окно поста (если пост открыт во всплывающем окне)
    const dialogArt = document.querySelector('[role="dialog"] article, [role="dialog"]');
    if (dialogArt) return dialogArt;

    // 2. Если на экране активно играет/виден рилс или видео
    const bestVid = pickBestVideo();
    if (bestVid) {
      const art = bestVid.closest('article, [role="dialog"], main, section');
      if (art) return art;
    }

    // 3. Если есть карусель в области видимости
    const acays = document.querySelectorAll('ul._acay, ul[class*="acay"]');
    for (const ul of acays) {
      const r = ul.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0) {
        const art = ul.closest('article, [role="dialog"], main, section');
        if (art) return art;
      }
    }

    // 4. Поиск наиболее видимой статьи (article) в области просмотра
    let bestArt = null;
    let maxArea = 0;
    document.querySelectorAll('article').forEach((art) => {
      const r = art.getBoundingClientRect();
      const visW = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
      const visH = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      const area = visW > 0 && visH > 0 ? visW * visH : 0;
      if (area > maxArea) {
        maxArea = area;
        bestArt = art;
      }
    });
    if (bestArt) return bestArt;

    return document.querySelector('article') || document.body;
  }

  // Поиск медиа-контейнера поста (исключая внутренний scroll-viewport div._acaw!)
  function findMediaContainer(scope) {
    const article = findPostArticle(scope);
    const ul = article.querySelector('ul._acay, ul[class*="acay"]');
    if (ul) {
      // Ищем верхний контейнер div._aatk (где живут и стрелки, и точки), а НЕ div._acaw
      const topMedia = ul.closest('div._aatk, div._aamw, div[class*="_aatk"]');
      if (topMedia) return topMedia;
      return ul.parentElement?.parentElement || article;
    }
    const video = article.querySelector('video');
    if (video) {
      const topMedia = video.closest('div._aatk, div._aamw, div[class*="_aatk"]');
      if (topMedia) return topMedia;
      return video.parentElement?.parentElement || article;
    }
    return article.querySelector('div._aatk, div._aamw, div[class*="_aatk"]') || article;
  }

  // Определение типа медиа на текущем посте (видео или карусель со слайдами)
  function detectCurrentPostMedia() {
    const article = findPostArticle();
    const mediaContainer = findMediaContainer(article);
    const scope = mediaContainer || article || document;

    const ul = scope.querySelector?.('ul._acay, ul[class*="acay"]');
    const refRect = getCarouselRefRect(scope);
    const nextBtn = findCarouselNextButton(scope, refRect);
    const prevBtn = findCarouselPrevButton(scope, refRect);
    // Точки карусели ищем ТОЛЬКО внутри контейнера поста, а НЕ по глобальному tablist навигации Instagram!
    const carouselMedia = ul ? (ul.closest('div._aatk, div._aamw') || ul.parentElement) : (scope.querySelector?.('div._aatk, div._aamw') || scope);
    const dots = carouselMedia ? carouselMedia.querySelectorAll('div._acaz, div[role="tablist"] > *, ul._acay > li') : [];
    // Структурные индикаторы и слайд-трек: работают без <article> (лента Reels)
    // и без хешированных классов Instagram.
    const structDots = findSlideDots(scope, refRect);
    const hasSlideTrack = hasHorizontalSlideTrack(scope);
    const video = (scope.querySelector && scope.querySelector('video')) || pickBestVideo();

    // ВАЖНО: карусель проверяем РАНЬШЕ видео. Видео-слайд внутри карусели не должен
    // переводить пост в тип 'video' — иначе включалась видео-ветка с перемоткой видео
    // вместо перелистывания слайдов.
    if (ul || nextBtn || prevBtn || (dots && dots.length > 1) || structDots.length > 1 || hasSlideTrack) {
      const dotsForTotal = structDots.length > 1 ? structDots : Array.from(dots || []);
      let totalSlides = detectSlideTotal(scope, dotsForTotal);
      const textScope = carouselMedia || scope;
      const textContent = textScope ? (textScope.innerText || textScope.textContent || '') : '';
      const textIndicators = textContent.match(/(\d+)\s*(?:\/|из|of)\s*(\d+)/i);
      if (textIndicators && textIndicators[2]) {
        const parsed = parseInt(textIndicators[2], 10);
        if (parsed > 0 && parsed <= 30 && parsed > totalSlides) totalSlides = parsed;
      }
      return {
        type: 'carousel',
        totalSlides: totalSlides > 0 ? totalSlides : 0,
        scope: article || carouselMedia || document,
        mediaContainer: carouselMedia,
        video,
      };
    }

    if (video && isFinite(video.duration) && video.duration > 0.5) {
      return {
        type: 'video',
        video,
        scope: article || video.closest('article, [role="dialog"], main') || document,
        mediaContainer: video.parentElement,
      };
    }

    return null;
  }

  // Расчёт временных окон для видео:
  function getVideoWindows(duration, startSec, endSec) {
    const d = Math.max(0.1, duration);
    const s = Math.max(0, Number(startSec) || 0);
    const e = Math.max(0, Number(endSec) || 0);
    let headTo = 0;
    let tailFrom = 0;
    let tailTo = d;

    if (e === 0 && s > 0) {
      headTo = Math.min(s, d);
      tailFrom = d;
      tailTo = d;
    } else if (s === 0 && e > 0) {
      headTo = 0;
      tailFrom = Math.max(0, d - e);
      tailTo = d;
    } else if (s + e > d) {
      const mid = d / 2;
      headTo = mid;
      tailFrom = mid;
      tailTo = d;
    } else {
      headTo = Math.min(s, d);
      tailFrom = Math.max(0, d - e);
      tailTo = d;
    }
    return { headTo, tailFrom, tailTo };
  }

  // Расчёт слайдов для карусели:
  function getSlideWindows(total, startCount, endCount) {
    const n = Math.max(1, total);
    const s = Math.max(0, Math.min(startCount, n));
    const e = Math.max(0, Math.min(endCount, n));
    let headSlides = [];
    let tailSlides = [];

    if (e === 0 && s > 0) {
      for (let i = 1; i <= Math.min(s, n); i++) headSlides.push(i);
    } else if (s === 0 && e > 0) {
      for (let i = Math.max(1, n - e + 1); i <= n; i++) tailSlides.push(i);
    } else if (s + e > n) {
      const mid = Math.ceil(n / 2);
      const headLimit = Math.min(s, Math.max(1, mid));
      for (let i = 1; i <= headLimit; i++) headSlides.push(i);
      for (let i = Math.max(headLimit + 1, n - e + 1); i <= n; i++) tailSlides.push(i);
    } else {
      for (let i = 1; i <= s; i++) headSlides.push(i);
      for (let i = Math.max(1, n - e + 1); i <= n; i++) tailSlides.push(i);
    }
    return { headSlides, tailSlides };
  }

  function isElementVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !el.disabled && el.style.display !== 'none' && el.style.visibility !== 'hidden';
  }

  // ---------------- Навигация по слайдам карусели без хешированных классов ----------------
  // Instagram регулярно меняет хешированные классы (ul._acay / div._acaz / button._afxw),
  // поэтому вся геометрия и структура ниже опирается на layout, role/aria и иконку-шеврон,
  // а классы используются только как необязательная подсказка.

  // Опорный прямоугольник карусели: самое крупное видимое медиа внутри области поста.
  // Нужен, чтобы искать точки и стрелки ВНУТРИ конкретного поста: в ленте Reels <article>
  // нет, и глобальный поиск попадает в навигацию чужих постов или верхнее меню.
  function getCarouselRefRect(scope) {
    const root = (scope && scope.querySelectorAll) ? scope : document;
    let best = null;
    let bestArea = 0;
    const consider = (el) => {
      if (!el || !isElementVisible(el)) return;
      const r = el.getBoundingClientRect();
      const visW = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
      const visH = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      const area = visW > 0 && visH > 0 ? visW * visH : 0;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    };
    root.querySelectorAll('video').forEach(consider);
    root.querySelectorAll('img[src*="cdninstagram"], img[src*="fbcdn"], div._aagv img, ul._acay img').forEach(consider);
    if (best) return best.getBoundingClientRect();

    const art = findPostArticle(scope);
    const rect = (art && art.getBoundingClientRect) ? art.getBoundingClientRect() : null;
    if (rect && rect.width > 0 && rect.height > 0) return rect;
    return {
      top: 0,
      left: 0,
      width: window.innerWidth,
      height: window.innerHeight,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };
  }

  // Точки-индикаторы слайдов. Ищем структурно (role="tablist" или ряд мелких
  // «квадратиков» у кромки медиа) и лишь как подсказку — по классу *acaz*.
  // Все кандидаты обязаны лежать в области конкретной карусели (refRect).
  function findSlideDots(scope, refRect) {
    const root = (scope && scope.querySelectorAll) ? scope : document;
    const R = refRect || getCarouselRefRect(scope);
    const near = (r) =>
      r.width > 0 && r.height > 0 &&
      r.bottom > R.top - 16 && r.top < R.bottom + 16 &&
      r.right > R.left - 16 && r.left < R.right + 16;
    const byX = (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left;

    // 1) Явный таб-лист слайдов
    const tablists = Array.from(root.querySelectorAll('[role="tablist"]'));
    for (const tl of tablists) {
      const kids = Array.from(tl.children).filter(isElementVisible);
      if (kids.length > 1 && kids.length <= 30 && kids.filter((k) => near(k.getBoundingClientRect())).length >= kids.length - 1) {
        return kids;
      }
    }

    // 2) Подсказка по классу (у Instagram это *acaz*), но только внутри области поста
    const byClass = Array.from(root.querySelectorAll('div[class*="acaz"], button[class*="acaz"], span[class*="acaz"]'))
      .filter((el) => isElementVisible(el) && near(el.getBoundingClientRect()));
    if (byClass.length > 1) return byClass.sort(byX);

    // 3) Структурно: у одного родителя >=2 маленьких квадратных элемента в один ряд
    const groups = new Map();
    Array.from(root.querySelectorAll('div, span, li')).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 3 || r.width > 26 || r.height < 3 || r.height > 26) return;
      if (Math.abs(r.width - r.height) > 12) return;
      if (!near(r)) return;
      const p = el.parentElement;
      if (!p) return;
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(el);
    });
    let bestKids = null;
    for (const kids of groups.values()) {
      if (kids.length < 2 || kids.length > 30) continue;
      const ys = kids.map((k) => {
        const r = k.getBoundingClientRect();
        return r.top + r.height / 2;
      });
      if (Math.max(...ys) - Math.min(...ys) > 10) continue;
      if (!bestKids || kids.length > bestKids.length) bestKids = kids;
    }
    return bestKids ? bestKids.sort(byX) : [];
  }

  // Индекс активной точки (текущий слайд). Признаки — aria, затем класс,
  // фолбэк — самая крупная/непрозрачная точка (у Instagram активная залита).
  function getActiveDotIndex(dots) {
    if (!dots || !dots.length) return -1;
    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      const aria = `${d.getAttribute('aria-selected') || ''} ${d.getAttribute('aria-current') || ''}`.toLowerCase();
      if (aria.includes('true') || aria.includes('current') || aria.includes('step')) return i;
      const cls = String(d.className || '');
      if (/active|selected|current/i.test(cls)) return i;
    }
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < dots.length; i++) {
      const r = dots[i].getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue; // оторванные от DOM точки пропускаем
      let op = 1;
      try { op = parseFloat(getComputedStyle(dots[i]).opacity || '1'); } catch (_) {}
      const score = r.width * r.height * (isFinite(op) ? op : 1);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  // Стабильный id DOM-узла: смена самого элемента активного слайда — тоже признак
  // того, что карусель перелистнулась (Instagram иногда пересоздаёт узлы).
  const igxElIds = new WeakMap();
  let igxElIdSeq = 0;
  function igxElId(el) {
    if (!el) return -1;
    if (!igxElIds.has(el)) igxElIds.set(el, ++igxElIdSeq);
    return igxElIds.get(el);
  }

  // Бейдж «N/M» у карусели (если Instagram его показывает): текущий слайд и всего.
  function getSlideBadge(scope, refRect) {
    const root = (scope && scope.querySelectorAll) ? scope : document;
    const R = refRect || getCarouselRefRect(scope);
    const nodes = root.querySelectorAll('span, div');
    let scanned = 0;
    for (const n of nodes) {
      if (++scanned > 900) break;
      if (n.children.length) continue;
      if (n.closest && n.closest('.igx-seekbar, .igx-carousel-bar, .igx-ocr-pop, .igx-side-panel, .igx-pa-pop, .igx-afk-pop')) continue;
      const t = (n.textContent || '').trim();
      if (!t || t.length > 12) continue;
      const m = t.match(/^(\d{1,2})\s*(?:\/|из|of)\s*(\d{1,2})$/i);
      if (!m) continue;
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.bottom < R.top - 16 || r.top > R.bottom + 16) continue;
      const cur = parseInt(m[1], 10);
      const total = parseInt(m[2], 10);
      if (cur > 0) return { cur, total: total > 0 ? total : -1 };
    }
    return { cur: -1, total: -1 };
  }

  // Общее число слайдов: точки-индикаторы + бейдж «N/M» + элементы списка слайдов.
  // Не опирается на конкретный хеш класса (раньше считалось только по ul._acay).
  function detectSlideTotal(scope, dots) {
    let total = dots && dots.length > 1 ? dots.length : 0;
    const badge = getSlideBadge(scope);
    if (badge.total > total && badge.total <= 30) total = badge.total;
    const root = (scope && scope.querySelectorAll) ? scope : document;
    Array.from(root.querySelectorAll('ul._acay, ul[class*="acay"], ul[class*="slides"]')).forEach((ul) => {
      const n = ul.children.length;
      if (n > total && n <= 30) total = n;
    });
    return total;
  }

  // «Самый крупный» вариант из srcset: у Instagram первый кандидат часто оказывается
  // 150-пиксельным плейсхолдером, поэтому брать его вслепую нельзя — сравниваем
  // дескрипторы (1000w или 2x) и берём максимум.
  function igxBestSrcFromSrcset(srcset) {
    if (!srcset) return '';
    let best = '';
    let bestScore = -1;
    String(srcset).split(',').forEach((part) => {
      const bits = part.trim().split(/\s+/);
      const u = bits[0];
      if (!u) return;
      const d = bits[1] || '';
      let score = 500; // без дескриптора — середина: лучше «1x», хуже «1000w»
      if (/^\d+w$/i.test(d)) score = parseInt(d, 10);
      else if (/^\d+(?:\.\d+)?x$/i.test(d)) score = parseFloat(d) * 1000;
      if (score > bestScore) {
        bestScore = score;
        best = u;
      }
    });
    return best;
  }

  // URL картинки слайда. Порядок: currentSrc → src → самый крупный из srcset → data-src.
  // Встроенные data:-плейсхолдеры пропускаем — распознавать по ним нечего.
  function igxImageUrl(img) {
    if (!img) return null;
    const direct = img.currentSrc || img.src;
    if (direct && direct.startsWith('http')) return direct;
    const fromSet = igxBestSrcFromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
    if (fromSet && fromSet.startsWith('http')) return fromSet;
    const ds = img.getAttribute('data-src');
    if (ds && ds.startsWith('http')) return ds;
    return null;
  }

  // Медиа одного слайда (ребёнка дорожки). Видео проверяем первым: его URL — это .mp4,
  // для OCR картинкой он не годится, кадр снимается отдельно (captureElementClean).
  function igxSlideMedia(itemEl) {
    if (!itemEl) return null;
    const video = itemEl.tagName === 'VIDEO' ? itemEl : itemEl.querySelector('video');
    if (video) return { el: video, itemEl, isVideo: true, url: findVideoUrl(video) };
    const imgs = itemEl.tagName === 'IMG' ? [itemEl] : Array.from(itemEl.querySelectorAll('img'));
    if (!imgs.length) return null;
    let best = null;
    let bestArea = -1;
    imgs.forEach((img) => {
      const r = img.getBoundingClientRect();
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      if (area > bestArea) {
        bestArea = area;
        best = img;
      }
    });
    const img = best || imgs[0];
    return { el: img, itemEl, isVideo: false, url: igxImageUrl(img) };
  }

  // «Дорожка» слайдов карусели, найденная ГЕОМЕТРИЧЕСКИ, а не по хешированным классам:
  // контейнер, у которого >=2 ребёнка, каждый содержит крупный (>=120 px) img/video,
  // а сами дети стоят В ОДНОМ горизонтальном ряду на одной высоте (в ленте элементы
  // идут по вертикали, а сетка постов в профиле — в несколько рядов, поэтому оба
  // признака отсекают ложные срабатывания).
  // Возвращает детей контейнера слева направо — это и есть слайды, ВКЛЮЧАЯ уехавшие
  // за край экрана: именно поэтому сбор перестал зависеть от перелистывания.
  function findHorizontalSlideTrack(scope) {
    const root = (scope && scope.querySelectorAll) ? scope : document;

    const rowOf = (parent) => {
      const kids = Array.from(parent.children).filter((k) => {
        const r = k.getBoundingClientRect();
        if (r.width < 120 || r.height < 120) return false;
        // Ряд должен быть на экране: иначе это чужая невидимая карусель из ленты
        if (r.bottom <= 0 || r.top >= window.innerHeight) return false;
        return k.tagName === 'IMG' || k.tagName === 'VIDEO' || !!k.querySelector('img, video');
      });
      if (kids.length < 2 || kids.length > 30) return null;
      const sorted = kids
        .map((k) => ({ k, r: k.getBoundingClientRect() }))
        .sort((a, b) => a.r.left - b.r.left);
      const tops = sorted.map((s) => s.r.top);
      if (Math.max(...tops) - Math.min(...tops) > 40) return null; // это сетка, а не ряд
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1].r;
        const b = sorted[i].r;
        const vOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const hGap = b.left - a.right;
        if (vOverlap > 100 && Math.abs(hGap) <= 40) return sorted.map((s) => s.k);
      }
      return null;
    };

    // 0) Дополнительная подсказка: старый селектор списка слайдов (у Instagram ul._acay).
    // Он больше НЕ обязателен — используется только как быстрый путь.
    const hinted = root.querySelector('ul._acay, ul[class*="acay"]');
    if (hinted) {
      const hr = hinted.getBoundingClientRect();
      if (hr.width > 0 && hr.height > 0 && hr.bottom > 0 && hr.top < window.innerHeight) {
        const row = rowOf(hinted);
        if (row) return row;
      }
    }

    // 1) Геометрия: контейнер — один из предков крупного медиа (не выше 3 уровней)
    const cands = new Set();
    let bigMedias = 0;
    Array.from(root.querySelectorAll('img, video')).forEach((m) => {
      const r = m.getBoundingClientRect();
      if (r.width < 120 || r.height < 120) return;
      bigMedias++;
      let p = m.parentElement;
      for (let up = 0; p && up < 3; up++, p = p.parentElement) cands.add(p);
    });
    if (bigMedias < 2) return [];

    let bestRow = null;
    cands.forEach((c) => {
      const row = rowOf(c);
      if (!row) return;
      if (!bestRow || row.length > bestRow.length) bestRow = row;
    });
    return bestRow || [];
  }

  // Есть ли на экране дорожка слайдов (нужно для определения типа медиа).
  function hasHorizontalSlideTrack(scope) {
    return findHorizontalSlideTrack(scope).length > 1;
  }

  // Отпечаток всех крупных медиа в области: появляется/исчезает URL нового слайда —
  // значит дорожка перерисовалась (самый слабый признак, но лучше чем «не листается»).
  function igxMediaSig(scope) {
    const root = (scope && scope.querySelectorAll) ? scope : document;
    const list = [];
    root.querySelectorAll('img, video').forEach((m) => {
      const r = m.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) return;
      const u = igxImageUrl(m) || String(m.currentSrc || m.src || '');
      if (u) list.push(u.slice(-26));
    });
    return list.sort().join('|');
  }

  // «Отпечаток» текущего слайда: id активного медиа-элемента, его src, активная точка,
  // номер из бейджа и состав медиа в области. Используется, чтобы проверить ФАКТ
  // смены слайда после клика.
  function getSlideFingerprint(scope, dots) {
    const el = getVisibleSlideElement(scope);
    const src = el ? String(el.currentSrc || el.src || (el.getAttribute && el.getAttribute('src')) || '') : '';
    const badge = getSlideBadge(scope);
    return {
      elId: igxElId(el),
      src,
      dotIdx: getActiveDotIndex(dots),
      badge: badge.cur,
      mediaSig: igxMediaSig(scope),
      // У играющего видео кадры меняются сами по себе — сравнение снимков к нему
      // неприменимо (иначе плеер «подтверждал» бы несуществующий переход).
      volatile: !!(el && el.tagName === 'VIDEO'),
    };
  }

  // Решение «слайд реально сменился». Признаки по убыванию надёжности:
  // снимок кадра → id/src активного медиа → активная точка → бейдж.
  // true  — хотя бы один доступный признак говорит «сменилось»;
  // false — все доступные признаки говорят «не сменилось»;
  // null  — проверить нечем (нет ни снимка, ни src, ни индикаторов).
  function slideChanged(before, after, prevShot, newShot) {
    const signals = [];
    if (prevShot && newShot && before && after && !before.volatile && !after.volatile) {
      signals.push(prevShot !== newShot);
    }
    if (before && after && before.src && after.src) signals.push(before.src !== after.src);
    if (before && after && before.elId >= 0 && after.elId >= 0) signals.push(before.elId !== after.elId);
    if (before && after && before.dotIdx >= 0 && after.dotIdx >= 0) signals.push(before.dotIdx !== after.dotIdx);
    if (before && after && before.badge > 0 && after.badge > 0) signals.push(before.badge !== after.badge);
    if (!signals.length) return null;
    return signals.some(Boolean);
  }

  // Ждём, пока отпечаток слайда изменится: Instagram анимирует переход ~200–500 мс.
  // Признаки по убыванию надёжности; самый слабый (состав медиа в DOM) принимаем только
  // спустя ~400 мс — раньше это может быть обычная ленивая подгрузка соседнего слайда.
  async function waitForSlideAdvance(scope, dots, before, timeoutMs) {
    const t0 = Date.now();
    const limit = timeoutMs || 1500;
    while (Date.now() - t0 < limit) {
      await new Promise((r) => setTimeout(r, 120));
      const now = getSlideFingerprint(scope, dots);
      if (now.src && before.src && now.src !== before.src) return true;
      if (now.elId >= 0 && before.elId >= 0 && now.elId !== before.elId) return true;
      if (now.dotIdx >= 0 && before.dotIdx >= 0 && now.dotIdx !== before.dotIdx) return true;
      if (now.badge > 0 && before.badge > 0 && now.badge !== before.badge) return true;
      if (Date.now() - t0 > 400 && now.mediaSig && before.mediaSig && now.mediaSig !== before.mediaSig) return true;
    }
    return false;
  }

  // Короткое описание кандидата навигации — для честной причины остановки
  // (когда точка/стрелка найдена, но отсеяна проверкой видимости).
  function describeNavCandidate(el) {
    if (!el) return 'пустой элемент';
    const r = el.getBoundingClientRect();
    const label = String((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('role'))) || '').trim();
    const kind = label ? `«${label.slice(0, 40)}»` : String(el.tagName || '').toLowerCase();
    return `${kind} ${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  // Контейнеры карусели, которые реально прокручиваются горизонтально (у части сборок
  // Instagram слайды живут в overflow-блоке, а не в transform-дорожке).
  function findCarouselScrollers(scope) {
    const article = findPostArticle(scope) || (scope && scope.querySelectorAll ? scope : null);
    if (!article) return [];
    const out = [];
    const seen = new Set();
    Array.from(article.querySelectorAll('img, video')).forEach((m) => {
      const r = m.getBoundingClientRect();
      if (r.width < 120 || r.height < 120) return;
      let p = m.parentElement;
      for (let up = 0; p && up < 8; up++, p = p.parentElement) {
        if (seen.has(p)) continue;
        if (p.scrollWidth > p.clientWidth + 20) {
          seen.add(p);
          out.push(p);
        }
      }
    });
    return out;
  }

  // Прокрутка дорожки на слайд. dir: +1 — вперёд, -1 — назад. Возвращает описание
  // сделанного ('' — прокручивать нечего).
  async function igxScrollCarousel(scope, dir) {
    const list = findCarouselScrollers(scope);
    for (const s of list) {
      const before = s.scrollLeft;
      const step = Math.max(120, Math.round(s.clientWidth * 0.9));
      try {
        if (typeof s.scrollBy === 'function') s.scrollBy({ left: dir * step, behavior: 'auto' });
        else s.scrollLeft = before + dir * step;
      } catch (_) { continue; }
      try { s.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {}
      await igxSleep(140);
      const dlt = Math.round(s.scrollLeft - before);
      if (Math.abs(dlt) > 8) {
        const rest = Math.round(s.scrollWidth - s.clientWidth);
        return `прокрутка ${dlt > 0 ? '+' : ''}${dlt}px (${Math.round(s.scrollLeft)}/${rest}px)`;
      }
    }
    return '';
  }

  // Горизонтальное «колесо» по центру медиа: часть сборок листает карусель именно так.
  function igxWheelCarousel(scope, dir) {
    const r = getCarouselRefRect(scope);
    if (!r || r.width < 60) return '';
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    let target = null;
    try { target = document.elementFromPoint(x, y); } catch (_) {}
    target = target || findPostArticle(scope);
    if (!target || !target.dispatchEvent) return '';
    const d = Math.max(120, Math.round(r.width * 0.8));
    try {
      target.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, deltaX: dir * d, deltaY: 0,
      }));
    } catch (_) { return ''; }
    return `колесо ${dir > 0 ? '-' : '+'}${d}px`;
  }

  // Свайп/перетаскивание по области медиа (pointer + mouse, шагами — как живой жест).
  async function igxSwipeCarousel(scope, dir) {
    const r = getCarouselRefRect(scope);
    if (!r || r.width < 120) return '';
    const y = Math.round(r.top + r.height / 2);
    const x0 = Math.round(dir > 0 ? r.left + r.width * 0.78 : r.left + r.width * 0.22);
    const dist = Math.round(r.width * 0.5);
    const x1 = x0 - dir * dist;
    let target = null;
    try { target = document.elementFromPoint(x0, y); } catch (_) {}
    target = target || findPostArticle(scope);
    if (!target || !target.dispatchEvent) return '';
    const ev = (x, btns) => ({
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: btns,
    });
    try {
      target.dispatchEvent(new PointerEvent('pointerdown', ev(x0, 1)));
      target.dispatchEvent(new MouseEvent('mousedown', ev(x0, 1)));
      for (let i = 1; i <= 6; i++) {
        const x = Math.round(x0 + ((x1 - x0) * i) / 6);
        target.dispatchEvent(new PointerEvent('pointermove', ev(x, 1)));
        target.dispatchEvent(new MouseEvent('mousemove', ev(x, 1)));
        await igxSleep(35);
      }
      target.dispatchEvent(new PointerEvent('pointerup', ev(x1, 0)));
      target.dispatchEvent(new MouseEvent('mouseup', ev(x1, 0)));
    } catch (_) { return ''; }
    return `свайп на ${dist}px ${dir > 0 ? 'влево' : 'вправо'}`;
  }

  // Стрелки клавиатуры. Раньше не использовались ВООБЩЕ: если в карусели есть видео,
  // Instagram трактует ArrowRight как перемотку — поэтому жмём ТОЛЬКО когда видео в
  // области нет, и только как последний довод (вызывающий код сверяет адрес поста).
  function igxPressSlideArrow(scope, dir) {
    const root = scope && scope.querySelectorAll ? scope : document;
    if (root.querySelector('video')) return '';
    const key = dir > 0 ? 'ArrowRight' : 'ArrowLeft';
    const target = getVisibleSlideElement(scope) || document.body;
    const fire = (node, type) => {
      try { node.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true })); } catch (_) {}
    };
    ['keydown', 'keyup'].forEach((t) => {
      fire(target, t);
      if (target !== document) fire(document, t);
    });
    return `клавиша ${key}`;
  }

  // Короткое описание того, чем сейчас «является» карусель — для честной диагностики
  // в причине остановки (сколько точек, есть ли кнопка, найдена ли дорожка).
  function igxCarouselNavSummary(scope, dots) {
    const ref = getCarouselRefRect(scope);
    const btn = findCarouselNextButton(scope, ref);
    const track = findHorizontalSlideTrack(scope).length;
    const fp = getSlideFingerprint(scope, dots);
    const srcTail = fp.src ? `…${String(fp.src).slice(-10)}` : 'нет';
    return `точек:${dots ? dots.length : 0}, активная:${dots ? getActiveDotIndex(dots) : -1}, кнопка «Далее»:${btn ? describeNavCandidate(btn) : 'нет'}, дорожка:${track}, бейдж:${fp.badge || '?'}, src:${srcTail}`;
  }

  // Переход к следующему слайду. Порядок способов — от самого бережного к отчаянным:
  // точка-индикатор → кнопка «Далее» → прокрутка дорожки → колесо → свайп → стрелка
  // (только без видео) → клик БЕЗ гасителя. Каждый способ проверяется на ФАКТ смены
  // слайда, и всё, что пробовали, попадает в причину остановки.
  // opts.nextUrlHint — URL следующего слайда, уже известный из DOM: если проверка
  // смены ничего не подтвердила, но следующий слайд заведомо другой, идём дальше.
  // opts.postUrl — адрес открытого поста: нужен, чтобы не «перелистнуть» в чужой пост.
  async function goToNextSlide(scope, curIndex, opts) {
    const o = opts || {};
    const refRect = getCarouselRefRect(scope);
    const dots = findSlideDots(scope, refRect);
    const activeIdx = getActiveDotIndex(dots);
    // ВАЖНО: в отпечаток передаём РЕАЛЬНЫЙ список точек. С null признак «сменилась
    // активная точка» не участвовал в проверке (dotIdx всегда -1) — отсюда могли
    // браться ложные «карусель не перелистнулась» при реально сработавшем клике.
    const before = getSlideFingerprint(scope, dots);
    const curSrc = before.src || '';
    const log = [];

    // Один способ перелистать: выполнил, проверил смену, записал результат в log.
    // null — способ не сработал, { moved } — ушли дальше, { abort } — трогать
    // навигацию больше нельзя (пост/модалка куда-то пропали).
    const attempt = async (run, waitMs) => {
      const done = await run();
      if (!done) return null;
      if (o.postUrl && window.location.href !== o.postUrl) {
        log.push(`${done} — адрес сменился`);
        return { abort: true, reason: `${done} — после действия сменился адрес (выход из поста)` };
      }
      // Публикация могла закрыться (например, клик без гасителя ушёл в обработчик
      // «клик вне модалки»): продолжать листание бессмысленно — честно сообщаем.
      const stillOpen = document.querySelector('article') || pickBestVideo() || document.querySelector('[role="dialog"]');
      if (!stillOpen) {
        log.push(`${done} — пост закрылся`);
        return { abort: true, reason: `${done} — закрылась публикация` };
      }
      const moved = await waitForSlideAdvance(scope, dots, before, waitMs || 1500);
      log.push(`${done} → ${moved ? 'листает' : 'не листает'}`);
      return moved ? { moved: true } : null;
    };

    const clickTargets = [];
    if (dots.length > 1) {
      const nextDot = activeIdx >= 0 ? dots[activeIdx + 1] : dots[curIndex];
      if (nextDot && nextDot !== dots[activeIdx]) clickTargets.push(nextDot);
    }
    const nextBtn = findCarouselNextButton(scope, refRect);
    if (nextBtn) clickTargets.push(nextBtn);
    if (dots.length > 1 && activeIdx < 0 && dots[curIndex] && !clickTargets.includes(dots[curIndex])) {
      clickTargets.push(dots[curIndex]);
    }

    const skipped = [];
    for (const el of clickTargets) {
      // Кандидатов, отсеянных isElementVisible(), НЕ пропускаем молча: жмём один раз
      // всё равно (нулевой размер бывает у ещё не отрисованной кнопки), но запоминаем.
      const dsc = describeNavCandidate(el);
      if (!isElementVisible(el)) skipped.push(dsc);
      const res = await attempt(async () => { clickElement(el, { nav: true }); return dsc; }, 1500);
      if (res && (res.moved || res.abort)) return res;
    }

    // Клики не убедили — пробуем то, что листает карусель без нажатий на элементы IG.
    for (const step of [
      () => igxScrollCarousel(scope, 1),
      () => igxWheelCarousel(scope, 1),
      () => igxSwipeCarousel(scope, 1),
      () => igxPressSlideArrow(scope, 1),
    ]) {
      const res = await attempt(step, 1800);
      if (res && (res.moved || res.abort)) return res;
    }

    // Отчаянный вариант: тот же клик, но БЕЗ гасителя — если обработчик Instagram висит
    // на document, помеченный навигационный клик до него не доходил.
    for (const el of clickTargets) {
      const dsc = describeNavCandidate(el);
      const res = await attempt(async () => { clickElement(el, {}); return `${dsc} без гасителя`; }, 1800);
      if (res && (res.moved || res.abort)) return res;
    }

    // Проверка ничего не подтвердила, но из DOM известно, что следующий слайд другой:
    // считаем переход состоявшимся и продолжаем (дубли отсекает проверка в вызывающем
    // коде: она сравнивает отпечатки и НЕ записывает повтор того же слайда).
    const nextUrlHint = o.nextUrlHint || null;
    if (nextUrlHint && curSrc && nextUrlHint !== curSrc) return { moved: true, optimistic: true };

    const skippedNote = skipped.length ? `; отсеяно проверкой видимости: ${skipped.join(', ')}` : '';
    return {
      moved: false,
      reason: (log.length ? `не перелистывает: ${log.join('; ')}${skippedNote}` : 'не нашёл ни точек-индикаторов, ни кнопки «Далее»') + ` [${igxCarouselNavSummary(scope, dots)}]`,
    };
  }

  // Направление шеврона по иконке (polyline/path), без привязки к хешу класса.
  // 1 — вправо, -1 — влево, 0 — иконка не похожа на шеврон (сердце, лайк, звук и пр.).
  // Признак: у «>» средняя точка смещена ВПРАВО от середины отрезка «первая-последняя»,
  // у «<» — влево. Суммировать смещения нельзя: у симметричного шеврона они взаимно
  // уничтожаются (x конца равен x начала), поэтому сравниваем именно среднюю точку.
  function detectChevronDirection(svg) {
    if (!svg) return 0;
    const geo = svg.querySelector('polyline, path');
    if (!geo) return 0;
    const raw = `${geo.getAttribute('points') || ''} ${geo.getAttribute('d') || ''}`;
    const nums = (raw.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (nums.length < 6 || nums.length > 12) return 0; // 3–6 точек
    // Кривые/дуги (C/S/Q/T/A) — это пиктограмма (сердце, «поделиться»), а не стрелка
    const cmds = raw.replace(/[^a-z]/gi, '').toLowerCase();
    if (/[csqta]/.test(cmds)) return 0;
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    if (pts.length < 3) return 0;
    const xFirst = pts[0][0];
    const xLast = pts[pts.length - 1][0];
    const xMid = pts[Math.floor(pts.length / 2)][0];
    // ВНИМАНИЕ: для относительных path-команд («l6-6») разбор приблизительный,
    // поэтому направление по геометрии — вспомогательный признак, а основной — aria-label.
    const delta = xMid - (xFirst + xLast) / 2;
    if (Math.abs(delta) < 0.5) return 0;
    return delta > 0 ? 1 : -1;
  }

  // Подписи кнопок, которые НЕ являются навигацией по слайдам (лайк, коммент, звук):
  // защита от ложного срабатывания структурного поиска стрелки в ленте Reels.
  const IGX_NOT_NAV_LABEL = /(like|comment|share|save|more|mute|audio|music|tag|нравит|коммент|подел|сохран|ещ[её]|звук|музык|отмет)/i;

  // Гаситель наших синтетических кликов по навигации карусели.
  // Он висит на document в фазе ВСПЛЫТИЯ: обработчики React живут на корневом
  // контейнере (он ниже document) и к этому моменту уже отработали — поэтому точка
  // или кнопка «Далее» срабатывает, а само событие не доходит до слушателей
  // document/window Instagram (там живут обработчики плеера и меню).
  // Ставить гаситель в фазе перехвата нельзя: тогда React вообще не увидит клик.
  let igxNavShieldOn = false;
  // Нативное el.click() (см. clickElement) отправляет НЕпомеченное событие: флаг на него
  // поставить нельзя. Но вызов синхронный, поэтому на время его выполнения гаситель
  // считает клик навигационным — другие события в этот промежуток выполниться не могут.
  let igxNativeNavClick = false;
  function igxInstallNavShield() {
    if (igxNavShieldOn) return;
    igxNavShieldOn = true;
    const shield = (e) => {
      if (!e || !(e.__igxNavClick || (igxNativeNavClick && e.type === 'click'))) return;
      // ВАЖНО: у pointerdown/mousedown preventDefault НЕ вызываем — он подавляет
      // совместимые mouse-события (mousedown/mouseup/click), а на них и завязана
      // навигация Instagram. Достаточно остановить всплытие; для остальных фаз
      // prevention безопасен.
      if (e.type !== 'pointerdown' && e.type !== 'mousedown') {
        try { e.preventDefault(); } catch (_) {}
      }
      try { e.stopPropagation(); } catch (_) {}
      try { if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation(); } catch (_) {}
    };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => {
      document.addEventListener(t, shield, false);
    });
  }

  // Симуляция полноценного клика по элементу в React 18 с точными координатами.
  // opts.nav = true — клик НАВИГАЦИИ по карусели (точка-индикатор / «Далее» / «Назад»):
  // событие помечается флагом __igxNavClick и гасится igxInstallNavShield().
  function clickElement(el, opts) {
    if (!el) return false;
    const isNav = !!(opts && opts.nav);
    if (isNav) igxInstallNavShield();
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const common = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
    };
    const fire = (Ctor, type, extra) => {
      const ev = new Ctor(type, { ...common, ...extra });
      if (isNav) {
        try { ev.__igxNavClick = true; } catch (_) {}
      }
      el.dispatchEvent(ev);
    };
    try { el.focus?.(); } catch (_) {}
    fire(PointerEvent, 'pointerover');
    fire(PointerEvent, 'pointerenter');
    fire(PointerEvent, 'pointerdown', { button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: 'mouse' });
    fire(MouseEvent, 'mousedown', { button: 0, buttons: 1 });
    fire(PointerEvent, 'pointerup', { button: 0, buttons: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse' });
    fire(MouseEvent, 'mouseup', { button: 0, buttons: 0 });
    fire(MouseEvent, 'click', { button: 0 });
    // Нативный el.click() нужен и для навигации: именно его ждут обработчики Instagram,
    // срабатывающие от «настоящего» клика. Событие, созданное el.click(), пометить флагом
    // нельзя, поэтому на время синхронного вызова поднимаем igxNativeNavClick — гаситель
    // (igxInstallNavShield) по нему узнаёт своё событие и не пускает его выше document.
    if (isNav) {
      igxNativeNavClick = true;
      try { el.click(); } finally { igxNativeNavClick = false; }
    } else {
      try { el.click(); } catch (_) {}
    }
    return true;
  }

  // Поиск кнопки «Далее» СТРОГО внутри публикации (article).
  // refRect — уже известный прямоугольник медиа-контейнера (в ленте Reels <article>
  // нет, поэтому геометрию лучше передать снаружи, а не искать по классам заново).
  function findCarouselNextButton(scope, refRect) {
    const article = findPostArticle(scope);
    if (!article) return null;
    const mRect = refRect || (findMediaContainer(article) || article).getBoundingClientRect();

    const selectors = [
      'button[aria-label="Next"]',
      'button[aria-label="Далее"]',
      'button[aria-label="Next slide"]',
      'button[aria-label="Следующий слайд"]',
      'button[aria-label="Вперед"]',
      'button[aria-label*="Next"]',
      'button[aria-label*="Далее"]',
      'button[aria-label*="Следующ"]',
      'button[aria-label*="Вперед"]',
      'div._aaqg._aaqh button',
      'div._aaqh button',
      'div._aaqg button',
      'button._afxw, button[class*="afxw"]',
      'div[role="button"][aria-label*="Next"]',
      'div[role="button"][aria-label*="Далее"]',
    ];

    for (const sel of selectors) {
      const list = Array.from(article.querySelectorAll(sel)).filter(isElementVisible);
      for (const b of list) {
        const br = b.getBoundingClientRect();
        // Кнопка Далее находится справа от центра медиа
        if (br.left >= mRect.left + mRect.width * 0.35 && br.left <= mRect.right + 70) {
          return b;
        }
      }
    }

    const svgs = Array.from(article.querySelectorAll('svg')).filter(isElementVisible);
    for (const svg of svgs) {
      const label = `${svg.getAttribute('aria-label') || ''} ${svg.querySelector('title')?.textContent || ''}`.toLowerCase();
      const isNextLabel =
        label.includes('далее') ||
        label.includes('next') ||
        label.includes('следующ') ||
        label.includes('вперед');

      const poly = svg.querySelector('polyline');
      const pts = poly ? (poly.getAttribute('points') || '') : '';
      // Хеш-подсказки Instagram оставляем, но основной признак — геометрия иконки
      const isChevronRight = detectChevronDirection(svg) === 1 || pts.includes('19.84') || pts.includes('22.565') || pts.includes('9.276');

      if (isNextLabel || isChevronRight) {
        const btn = svg.closest('button, [role="button"]') || svg.parentElement;
        if (btn && isElementVisible(btn)) {
          const br = btn.getBoundingClientRect();
          if (br.left >= mRect.left + mRect.width * 0.35 && br.left <= mRect.right + 70) {
            return btn;
          }
        }
      }
    }

    // Структурный фолбэк: маленькая кнопка-шеврон у правого края медиа на середине
    // по высоте. Отсекаем кнопки лайка/коммента/звука по aria-label и по форме иконки.
    const structCands = Array.from(article.querySelectorAll('button, [role="button"]')).filter(isElementVisible);
    for (const b of structCands) {
      const br = b.getBoundingClientRect();
      if (br.width < 12 || br.width > 72 || br.height < 12 || br.height > 72) continue;
      if (IGX_NOT_NAV_LABEL.test(String(b.getAttribute('aria-label') || ''))) continue;
      const cy = br.top + br.height / 2;
      if (cy < mRect.top + mRect.height * 0.2 || cy > mRect.bottom - mRect.height * 0.2) continue;
      if (br.left < mRect.left + mRect.width * 0.72 || br.left > mRect.right + 40) continue;
      if (detectChevronDirection(b.querySelector('svg')) !== 1) continue;
      return b;
    }

    return null;
  }

  // Поиск кнопки «Назад» СТРОГО внутри публикации (article)
  function findCarouselPrevButton(scope, refRect) {
    const article = findPostArticle(scope);
    if (!article) return null;
    const mRect = refRect || (findMediaContainer(article) || article).getBoundingClientRect();

    const selectors = [
      'button[aria-label="Previous"]',
      'button[aria-label="Назад"]',
      'button[aria-label="Previous slide"]',
      'button[aria-label="Предыдущий слайд"]',
      'button[aria-label*="Previous"]',
      'button[aria-label*="Назад"]',
      'button[aria-label*="Back"]',
      'div._aaqi button',
      'button._afxw, button[class*="afxw"]',
      'div[role="button"][aria-label*="Previous"]',
      'div[role="button"][aria-label*="Назад"]',
    ];

    for (const sel of selectors) {
      const list = Array.from(article.querySelectorAll(sel)).filter(isElementVisible);
      for (const b of list) {
        const br = b.getBoundingClientRect();
        // Кнопка Назад находится слева от центра медиа
        if (br.left <= mRect.left + mRect.width * 0.65 && br.left >= mRect.left - 70) {
          return b;
        }
      }
    }

    const svgs = Array.from(article.querySelectorAll('svg')).filter(isElementVisible);
    for (const svg of svgs) {
      const label = `${svg.getAttribute('aria-label') || ''} ${svg.querySelector('title')?.textContent || ''}`.toLowerCase();
      const isPrevLabel =
        label.includes('назад') ||
        label.includes('previous') ||
        label.includes('back') ||
        label.includes('предыдущ');

      const poly = svg.querySelector('polyline');
      const pts = poly ? (poly.getAttribute('points') || '') : '';
      const isChevronLeft = detectChevronDirection(svg) === -1 || pts.includes('16.564') || pts.includes('6 12');

      if (isPrevLabel || isChevronLeft) {
        const btn = svg.closest('button, [role="button"]') || svg.parentElement;
        if (btn && isElementVisible(btn)) {
          const br = btn.getBoundingClientRect();
          if (br.left <= mRect.left + mRect.width * 0.65 && br.left >= mRect.left - 70) {
            return btn;
          }
        }
      }
    }

    // Структурный фолбэк: маленькая кнопка-шеврон у левого края медиа на середине высоты
    const structCands = Array.from(article.querySelectorAll('button, [role="button"]')).filter(isElementVisible);
    for (const b of structCands) {
      const br = b.getBoundingClientRect();
      if (br.width < 12 || br.width > 72 || br.height < 12 || br.height > 72) continue;
      if (IGX_NOT_NAV_LABEL.test(String(b.getAttribute('aria-label') || ''))) continue;
      const cy = br.top + br.height / 2;
      if (cy < mRect.top + mRect.height * 0.2 || cy > mRect.bottom - mRect.height * 0.2) continue;
      if (br.left > mRect.left + mRect.width * 0.28 || br.left < mRect.left - 40) continue;
      if (detectChevronDirection(b.querySelector('svg')) !== -1) continue;
      return b;
    }

    return null;
  }

  // Получение активного/видимого изображения текущего слайда
  // Получение активного/видимого изображения текущего слайда
  function getVisibleSlideElement(scope) {
    const article = findPostArticle(scope);
    const ul = article.querySelector('ul._acay, ul[class*="acay"]');
    const ulRect = ul ? ul.getBoundingClientRect() : null;
    // Доверяем списку слайдов только если он реально на экране: в ленте Reels первый
    // ul._acay в документе может принадлежать другому, невидимому посту.
    const ulOnScreen = !!(ulRect && ulRect.width > 0 && ulRect.height > 0 && ulRect.bottom > 0 && ulRect.top < window.innerHeight);
    if (ul && ulOnScreen) {
      const lis = Array.from(ul.children);
      const parent = ul.parentElement || ul;
      const pRect = parent.getBoundingClientRect();
      const pCenter = pRect.left + pRect.width / 2;

      let bestLi = null;
      let bestDist = Infinity;
      for (const li of lis) {
        const r = li.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const c = r.left + r.width / 2;
        const d = Math.abs(c - pCenter);
        if (d < bestDist) {
          bestDist = d;
          bestLi = li;
        }
      }
      if (bestLi) {
        const media = bestLi.querySelector('img, video');
        if (media) return media;
        return bestLi;
      }
    }

    // Опора — видимый контейнер медиа, а не первый попавшийся в документе
    const viewports = Array.from(article.querySelectorAll('div._aatk, div._aamw')).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
    });
    const viewport = viewports[0] || findMediaContainer(article) || article;
    const vRect = viewport.getBoundingClientRect();
    const vCenter = vRect.left + vRect.width / 2;

    const imgs = Array.from(
      article.querySelectorAll('ul._acay img, div._acaw img, div._aatk img, div._aagv img, img[src*="cdninstagram"], img[src*="fbcdn"]')
    ).filter((img) => {
      const r = img.getBoundingClientRect();
      // Кадр слайда должен быть крупным И на экране — иначе выбирались картинки
      // соседних (невидимых) постов ленты.
      return r.width > 120 && r.height > 120 && r.bottom > 0 && r.top < window.innerHeight;
    });

    if (imgs.length === 0) {
      return article.querySelector('video') || article.querySelector('img');
    }

    imgs.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const distA = Math.abs(ra.left + ra.width / 2 - vCenter);
      const distB = Math.abs(rb.left + rb.width / 2 - vCenter);
      return distA - distB;
    });

    return imgs[0];
  }

  // Кадр слайда-видео БЕЗ перемотки: видимый элемент снимаем обычным чистым способом
  // (canvas, при неудаче — снимок вкладки), невидимый — только canvas. Снимок вкладки
  // для элемента за кадром вырезал бы чужой участок экрана и дал бы мусорный текст.
  async function igxCaptureFrameFor(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const onScreen = r.width > 0 && r.height > 0 &&
      r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    if (onScreen) return captureElementClean(el);
    if (el.tagName === 'VIDEO') return captureVideoDirectCanvas(el);
    return null;
  }

  // Виден ли сейчас именно этот медиа-элемент слайда (нужно, чтобы подвести карусель
  // к слайду-видео и снять с него кадр).
  function igxIsSlideVisible(scope, mediaEl) {
    if (!mediaEl) return false;
    const vis = getVisibleSlideElement(scope);
    if (!vis) return false;
    return vis === mediaEl || vis.contains(mediaEl) || mediaEl.contains(vis);
  }

  // «Отличительный знак» картинки: Instagram отдаёт одно и то же медиа по разным URL
  // (разные размеры/обрезка), поэтому сравниваем по ig_cache_key, а без него — по имени
  // файла. Нужно, чтобы понять, что картинка из embed-страницы и есть тот же слайд.
  function igxUrlKey(u) {
    const s = String(u || '');
    if (!s) return '';
    const ck = s.match(/[?&]ig_cache_key=([^&#]+)/);
    if (ck) return 'ck:' + ck[1];
    const base = s.split('?')[0].split('#')[0];
    const tail = base.slice(base.lastIndexOf('/') + 1);
    return tail ? 'n:' + tail : '';
  }

  // Запасной добытчик слайдов — embed-страница поста (/p/<CODE>/embed/captioned/).
  // Она не зависит от перелистывания: картинки всех слайдов лежат в HTML по порядку.
  // Вызывается ТОЛЬКО когда после кликов остались неполученные слайды; аватарки и
  // иконки отсекаются по размеру в пути, видео — по расширению.
  async function igxFetchEmbedSlideUrls(code) {
    const grab = async (path) => {
      let html = '';
      try {
        const r = await fetch(path, { credentials: 'include', cache: 'no-store' });
        if (!r.ok) return [];
        html = await r.text();
      } catch (_) {
        return [];
      }
      const out = [];
      const seen = new Set();
      const re = /<img[^>]+(?:src|data-src)="([^"]+)"/gi;
      let m;
      while ((m = re.exec(html))) {
        const u = String(m[1]).replace(/&amp;/g, '&');
        if (!/^https?:\/\//i.test(u)) continue;
        if (!/(cdninstagram\.com|fbcdn\.net|instagram\.com)/i.test(u)) continue;
        if (/\.mp4/i.test(u.split('?')[0])) continue;
        const dim = u.match(/\/(\d{2,4})x(\d{2,4})\//);
        if (dim && Math.min(parseInt(dim[1], 10), parseInt(dim[2], 10)) < 200) continue;
        const k = igxUrlKey(u);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(u);
        if (out.length >= 30) break;
      }
      return out;
    };
    let list = await grab(`/p/${code}/embed/captioned/`);
    if (list.length < 2) {
      const alt = await grab(`/p/${code}/embed/`);
      if (alt.length > list.length) list = alt;
    }
    return list;
  }

  // Ставит картинки с embed-страницы по номерам слайдов. Доверять можно только порядку,
  // подтверждённому совпадением с уже известными из DOM URL (одна и та же картинка на
  // том же месте): иначе есть риск записать слайды перепутанными. Совпадений нет —
  // верим лишь когда картинок ровно столько, сколько слайдов.
  // Возвращает Map(номер слайда → URL) или null, если сопоставить не удалось.
  function igxAlignEmbedUrls(embedUrls, domUrlIndex, total) {
    const list = Array.from(embedUrls || []).filter(Boolean);
    if (!list.length || total < 1) return null;
    const keyAt = new Map();
    domUrlIndex.forEach((num, u) => {
      const k = igxUrlKey(u);
      if (k && !keyAt.has(k)) keyAt.set(k, num);
    });
    let shift = null;
    for (let i = 0; i < list.length; i++) {
      const num = keyAt.get(igxUrlKey(list[i]));
      if (!num) continue;
      const s = num - 1 - i;
      if (shift === null) shift = s;
      else if (shift !== s) return null; // порядок разошёлся с DOM — не верим
    }
    if (shift === null) {
      if (list.length !== total) return null;
      shift = 0;
    }
    const out = new Map();
    for (let i = 0; i < list.length; i++) {
      const num = shift + i + 1;
      if (num < 1 || num > total) continue;
      if (!out.has(num)) out.set(num, list[i]);
    }
    return out.size ? out : null;
  }

  // Извлечение текста со слайдов карусели.
  // ГЛАВНЫЙ путь — DOM: URL слайдов берутся прямо из «дорожки» (findHorizontalSlideTrack),
  // а клики по точкам/«Далее» остаются лишь вспомогательным механизмом — только для
  // слайдов, которых в DOM ещё нет (ленивая подгрузка), и для видео, кадр которого надо
  // снять. Поэтому «карусель не перелистывается» больше не обрывает прогон: если URL
  // слайда известен, он уходит в распознавание и попадает в результат.
  async function extractCarouselSlides(postMedia, startCount, endCount, apiKey, statusEl, vision) {
    const scope = postMedia.scope || document;
    const initialUrl = window.location.href;
    // Область поиска навигации: контейнер медиа конкретного поста, а если его нет —
    // переданная область. В ленте Reels <article> отсутствует, поэтому привязка идёт
    // по геометрии медиа (см. getCarouselRefRect/findSlideDots), а не по классам.
    const navScope =
      (postMedia.mediaContainer && isElementVisible(postMedia.mediaContainer) && postMedia.mediaContainer) ||
      scope;

    // Собираем точки-индикаторы: сначала в области медиа, затем (если пусто) шире
    const collectDots = () => {
      let d = findSlideDots(navScope, getCarouselRefRect(scope));
      if (!d.length && navScope !== scope) d = findSlideDots(scope, getCarouselRefRect(scope));
      return d;
    };
    // Дорожка слайдов: тоже сначала в области медиа, затем шире
    const collectTrack = () => {
      let t = findHorizontalSlideTrack(navScope);
      if (t.length < 2 && navScope !== scope) t = findHorizontalSlideTrack(scope);
      return t;
    };

    // 1. ГЛАВНОЕ: слайды добываем из DOM, без единого клика — у каждого ребёнка дорожки
    // уже есть URL медиа, и перелистывать карусель ради этого не нужно.
    if (statusEl) statusEl.textContent = 'Собираю слайды из DOM…';
    const slideDescs = collectTrack().map(igxSlideMedia).filter(Boolean);
    // URL → номер слайда по DOM: по нему узнаём, что клик НЕ перелистнул карусель
    // (видимый слайд оказался чужой картинкой из уже известных)
    const domUrlIndex = new Map();
    slideDescs.forEach((d, i) => {
      if (d.url && !domUrlIndex.has(d.url)) domUrlIndex.set(d.url, i + 1);
    });

    // Дорожку Instagram догружает лениво: соседние слайды появляются в DOM не сразу.
    // Поэтому пересканируем её заново и дописываем те слайды, которых раньше не видели.
    // Верим новому ряду только если его удаётся выровнять по уже известным URL:
    // иначе Instagram показал «скользящее окно» слайдов, и по индексу их не расставить.
    const mergeTrack = () => {
      const fresh = collectTrack().map(igxSlideMedia).filter(Boolean);
      if (!fresh.length) return;
      let shift = null;
      for (let i = 0; i < fresh.length; i++) {
        const u = fresh[i].url;
        if (!u) continue;
        const known = domUrlIndex.get(u);
        if (!known) continue;
        if (shift === null) shift = known - 1 - i;
        else if (shift !== known - 1 - i) return; // ряд не совпадает с известным
      }
      if (shift === null) return; // сопоставить не с чем — оставляем как было
      for (let i = 0; i < fresh.length; i++) {
        const num = shift + i + 1;
        if (num < 1 || num > 30) continue;
        const prev = slideDescs[num - 1];
        if (prev && prev.url) continue; // добытое не подменяем
        slideDescs[num - 1] = fresh[i];
        if (fresh[i].url && !domUrlIndex.has(fresh[i].url)) domUrlIndex.set(fresh[i].url, num);
      }
    };

    // 2. Общее число слайдов: дорожка из DOM + индикаторы + бейдж «N/M» + список слайдов
    // (раньше считалось только по хешированному ul._acay и часто оставалось нулём).
    let dots = collectDots();
    let detectedTotal = detectSlideTotal(navScope, dots);
    // Бейдж «N/M» — счётчик ВНУТРИ самого поста, он честнее точек: findSlideDots
    // иногда захватывает глобальный tablist Instagram и выдаёт «10» на 2-слайдовой
    // карусели. Если бейдж показывает МЕНЬШЕ — верим бейджу и не листаем к фантомам.
    let badgeTotal = 0;
    try { const b = getSlideBadge(navScope); if (b && b.total >= 1 && b.total <= 30) badgeTotal = b.total; } catch (_) {}
    if (badgeTotal > 0 && badgeTotal < detectedTotal) detectedTotal = badgeTotal;
    // DOM-дорожка — тоже свидетель, но лишь когда она длиннее и не противоречит бейджу.
    if (slideDescs.length > detectedTotal && slideDescs.length <= 30 && !(badgeTotal > 0 && slideDescs.length > badgeTotal)) {
      detectedTotal = slideDescs.length;
    }

    // Не выдумываем размер: при неизвестном total берём ровно head+tail, иначе на
    // короткой карусели появлялся хвост «слайд 11/12» и уход за конец поста.
    const totalToUse = detectedTotal > 0 ? detectedTotal : Math.max(startCount + endCount, 2);
    const { headSlides: plannedHead, tailSlides: plannedTail } = getSlideWindows(totalToUse, startCount, endCount);
    const neededSet = new Set([...plannedHead, ...plannedTail]);
    const maxNeeded = neededSet.size > 0 ? Math.max(...Array.from(neededSet)) : Math.max(startCount + endCount, 2);
    const scanLimit = detectedTotal > 0 ? Math.min(detectedTotal, maxNeeded) : maxNeeded;
    const neededList = Array.from(neededSet).filter((i) => i >= 1 && i <= scanLimit).sort((a, b) => a - b);

    // Клики нужны ТОЛЬКО там, где URL слайда в DOM отсутствует
    const clicksNeeded = neededList.some((cur) => {
      const d = slideDescs[cur - 1];
      return !d || !d.url;
    });

    // 3. Переход к первому слайду — только если без кликов не обойтись (точка-индикатор,
    // затем «Назад»). Клавиатуру не используем вообще: dispatchEvent(new KeyboardEvent
    // ('ArrowLeft')) всплывал до обработчиков Instagram, и плеер трактовал его как
    // перемотку видео — из-за этого «перелистывалось видео» вместо слайдов.
    let rewindAttempted = false;
    let firstSlideConfirmed = !clicksNeeded;
    if (clicksNeeded) {
      if (statusEl) statusEl.textContent = 'Перехожу к началу слайдов…';
      const dots0 = collectDots();
      const active0 = getActiveDotIndex(dots0);
      if (dots0.length > 1 && active0 === 0) {
        firstSlideConfirmed = true; // индикаторы уже показывают первый слайд
      } else if (dots0.length > 1 && dots0[0]) {
        const before0 = getSlideFingerprint(navScope, dots0);
        clickElement(dots0[0], { nav: true });
        rewindAttempted = true;
        firstSlideConfirmed = await waitForSlideAdvance(navScope, dots0, before0, 1500);
      }
      if (!firstSlideConfirmed) {
        for (let step = 0; step < 20; step++) {
          const dotsN = collectDots();
          const activeN = getActiveDotIndex(dotsN);
          if (dotsN.length > 1 && activeN === 0) {
            firstSlideConfirmed = true;
            break;
          }
          const prevBtn = findCarouselPrevButton(navScope, getCarouselRefRect(scope));
          if (!prevBtn) break;
          const beforeN = getSlideFingerprint(navScope, dotsN);
          clickElement(prevBtn, { nav: true });
          rewindAttempted = true;
          if (!(await waitForSlideAdvance(navScope, dotsN, beforeN, 1200))) break;
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    // 4. Сбор нужных слайдов: сначала всё, что уже есть в DOM (без кликов), затем —
    // только недостающее, перелистыванием.
    const captured = {};
    const obtained = new Set();
    let unverified = 0;
    let stopReason = '';
    let prevShot = null;
    let prevFp = null;
    let visibleIdx = 1; // номер слайда, который считаем видимым (для кликового пути)

    for (const cur of neededList) {
      if (window.location.href !== initialUrl) {
        stopReason = 'страница сменилась';
        break;
      }
      mergeTrack();
      const desc = slideDescs[cur - 1];

      // 4a. URL слайда уже известен из DOM — ни кликов, ни проверок смены не требуется
      if (desc && desc.url) {
        if (statusEl) statusEl.textContent = `Слайд ${cur}: медиа взято из DOM…`;
        const item = { url: desc.url, isVideo: !!desc.isVideo, dataUrl: null };
        if (desc.isVideo) {
          // У видео URL — это .mp4: для распознавания нужен кадр, снимаем без перемотки
          const frame = await igxCaptureFrameFor(desc.el);
          if (frame) {
            item.dataUrl = frame;
            item.url = null;
          }
        } else if (igxIsSlideVisible(navScope, desc.el)) {
          // Слайд на экране: снимок пойдёт фолбэком, если распознать по URL не выйдет
          const frame = await igxCaptureFrameFor(desc.el);
          if (frame) item.dataUrl = frame;
        }
        captured[cur] = item;
        obtained.add(cur);
        // Отпечаток сбрасываем: проверка «слайд сменился» относится только к кликовому пути
        prevFp = null;
        prevShot = null;
        continue;
      }

      // 4b. Медиа слайда в DOM нет (ленивая подгрузка) — добираем перелистыванием
      if (statusEl) statusEl.textContent = `Слайд ${cur}: медиа нет в DOM, перелистываю…`;

      // Дальний слайд (например, 7-й из 8) выгоднее взять ПРЫЖКОМ по точке-индикатору:
      // клик по точке k ведёт сразу к слайду k, тогда как шагами пришлось бы листать
      // k-1 раз и в каждом шаге рисковать ошибкой проверки. Прыжку верим только когда
      // Instagram сам подтвердил, на каком слайде мы оказались (точка/бейдж).
      if (cur - visibleIdx > 1) {
        const jumpDots = collectDots();
        const targetDot = jumpDots[cur - 1];
        if (targetDot) {
          const beforeJ = getSlideFingerprint(navScope, jumpDots);
          clickElement(targetDot, { nav: true });
          if (await waitForSlideAdvance(navScope, jumpDots, beforeJ, 2200)) {
            const idxNow = getActiveDotIndex(collectDots());
            const badgeNow = getSlideBadge(navScope).cur;
            if (idxNow >= 0) visibleIdx = idxNow + 1;
            else if (badgeNow > 0) visibleIdx = badgeNow;
          }
        }
      }

      let reached = true;
      while (visibleIdx < cur) {
        const nextDesc = slideDescs[visibleIdx] || null;
        const nav = await goToNextSlide(navScope, visibleIdx, {
          nextUrlHint: (nextDesc && nextDesc.url) || null,
          postUrl: initialUrl,
        });
        if (!nav.moved) {
          stopReason = nav.reason || 'переход на следующий слайд не сработал';
          reached = false;
          break;
        }
        visibleIdx++;
        mergeTrack();
      }
      if (!reached) break;

      const el = getVisibleSlideElement(navScope);
      const curSrc = el ? String(el.currentSrc || el.src || '') : '';
      const isVid = !!(el && el.tagName === 'VIDEO');

      // Защита от «мёртвых» кликов: если видимый слайд — это картинка, чей URL уже
      // известен из DOM под ДРУГИМ номером, значит карусель не перелистнулась.
      // Записывать её как слайд cur нельзя — это была бы подмена одного слайда другим.
      const seenIdx = curSrc ? domUrlIndex.get(curSrc) : 0;
      if (seenIdx && seenIdx !== cur) {
        stopReason = `карусель осталась на слайде ${seenIdx}`;
        break;
      }

      // Чистый кадр слайда: с <video> снимаем прямо с canvas (без оверлеев Instagram),
      // снимок вкладки остаётся фолбэком. Перемотки видео здесь нет вообще.
      const dUrl = await captureElementClean(el);

      // Со 2-го кликового слайда проверяем, что карусель РЕАЛЬНО перелистнулась: иначе мы бы
      // записали один и тот же слайд несколько раз и отчитались о несуществующих.
      if (prevFp) {
        const verdict = slideChanged(prevFp, getSlideFingerprint(navScope, dots), prevShot, dUrl);
        if (verdict === false) {
          stopReason = `карусель не перелистнулась на слайд ${cur}`;
          break;
        }
        if (verdict === null) {
          unverified++;
          if (unverified >= 2) {
            stopReason = 'смену слайда нечем подтвердить (нет ни кадра, ни src, ни индикаторов)';
            break;
          }
        } else {
          unverified = 0;
        }
      }

      captured[cur] = {
        url: (!isVid && curSrc.startsWith('http')) ? curSrc : null,
        isVideo: isVid,
        dataUrl: dUrl,
      };
      if (isVid && !dUrl) {
        // Кадра нет — оставляем mp4-URL как последний фолбэк распознавания
        const vu = findVideoUrl(el);
        if (vu) captured[cur].url = vu;
      }
      obtained.add(cur);
      prevShot = dUrl;
      prevFp = getSlideFingerprint(navScope, dots);
      // Индикаторы могли перерисоваться после перехода — перечитываем их
      dots = collectDots();
    }

    // 5. Слайды-видео, кадр которых снять не удалось: подводим к ним карусель кликами —
    // единственный случай, когда клик нужен для слайда с уже известным из DOM URL.
    for (const cur of neededList) {
      const item = captured[cur];
      if (!item || !item.isVideo || item.dataUrl) continue;
      const desc = slideDescs[cur - 1];
      if (!desc || !desc.el) continue;
      let guard = 0;
      while (guard++ < 12 && !igxIsSlideVisible(navScope, desc.el)) {
        const nextDesc = slideDescs[visibleIdx] || null;
        const nav = await goToNextSlide(navScope, visibleIdx, {
          nextUrlHint: (nextDesc && nextDesc.url) || null,
          postUrl: initialUrl,
        });
        if (!nav.moved) break;
        visibleIdx++;
      }
      if (igxIsSlideVisible(navScope, desc.el)) {
        const frame = await igxCaptureFrameFor(desc.el);
        if (frame) {
          item.dataUrl = frame;
          item.url = null;
        }
      }
    }

    // 5c. Последний довод для недостающих слайдов — embed-страница поста: там картинки
    // лежат в разметке по порядку, перелистывать ничего не нужно. Берём только то, чего
    // до сих пор нет, и только если порядок подтвердился совпадением с уже известными URL.
    let embedRecovered = 0;
    const stillMissing = neededList.filter((i) => !obtained.has(i));
    if (stillMissing.length && window.location.href === initialUrl) {
      const codeM = String(initialUrl).match(/\/(?:p|reel|tv)\/([^/?#]+)/i);
      if (codeM) {
        if (statusEl) statusEl.textContent = 'Добираю недостающие слайды из embed-страницы поста…';
        try {
          const embedUrls = await igxFetchEmbedSlideUrls(codeM[1]);
          const aligned = igxAlignEmbedUrls(embedUrls, domUrlIndex, detectedTotal || Math.max(...neededList));
          if (aligned) {
            for (const num of stillMissing) {
              const u = aligned.get(num);
              if (!u) continue;
              captured[num] = { url: u, isVideo: false, dataUrl: null };
              obtained.add(num);
              embedRecovered++;
            }
          }
        } catch (e) {
          console.warn('embed-слайды не удалось получить:', e);
        }
      }
    }

    // 6. Честный отчёт: сколько ВЫБРАННЫХ слайдов удалось получить и каких именно нет.
    // Если всё получилось (missing пуст) — лишнего текста в предупреждениях не появляется.
    // Самокоррекция длины: если листание упёрлось в конец поста (сменился адрес / пост
    // закрылся / перестал листаться), а бейдж не доказывает больше слайдов, чем мы
    // реально добыли, честный размер = максимум добытого. Иначе завыщенный/выдуманный
    // total оставлял в отчёте фантомы «Слайд 10: не удалось получить».
    const reachedMax = obtained.size ? Math.max.apply(null, Array.from(obtained)) : 1;
    const stalledAtEnd = /сменился адрес|закрылась публикация|не перелистн|осталась на слайде|не сработал|страница сменилась/.test(stopReason || '');
    if (stalledAtEnd && detectedTotal > reachedMax && badgeTotal <= reachedMax) detectedTotal = reachedMax;
    const missing = neededList.filter((i) => !obtained.has(i) && i <= detectedTotal);
    const warnings = [];
    if (!firstSlideConfirmed && clicksNeeded) {
      warnings.push(rewindAttempted
        ? 'начало карусели (1-й слайд) подтвердить не удалось'
        : 'не нашёл индикаторов/кнопки «Назад» — не смог убедиться, что захват начат с 1-го слайда');
    }
    if (detectedTotal <= 0) {
      warnings.push('всего слайдов определить не удалось');
    }
    // Если DOM-дорожка пуста, весь захват держится на кликах — это надо видеть в отчёте,
    // иначе «получен 1 слайд из 8» выглядит как поломка распознавания, а не навигации.
    if (slideDescs.length < 2 && detectedTotal > 1 && missing.length) {
      warnings.push(`дорожка слайдов в DOM не найдена (слайдов в разметке: ${slideDescs.length}) — листание только кликами`);
    }
    if (missing.length) {
      const tail = stopReason ? `: ${stopReason}` : '';
      warnings.push(
        `получено слайдов — ${obtained.size} из ${neededList.length}${tail}; не удалось получить слайды ${missing.join(', ')}`
      );
    }
    if (embedRecovered) {
      warnings.push(`${embedRecovered} слайд(ов) добраны с embed-страницы поста (без перелистывания)`);
    }
    if (vision && !igxVisionWorks(apiKey)) {
      warnings.push('описание картинок недоступно: нужна нейронка — облачный ключ (Groq/OpenAI) или локальная модель LM Studio');
    }

    // Итоговое число слайдов: реальный размер карусели, если он определён, иначе — максимум
    // из добытого. По нему раскладываем слайды на хук и призыв.
    const actualTotal = detectedTotal > 0
      ? detectedTotal
      : (obtained.size ? Math.max(...Array.from(obtained)) : 1);
    const { headSlides, tailSlides } = getSlideWindows(actualTotal, startCount, endCount);

    async function ocrItem(item) {
      if (!item) return '';
      if (item.url) {
        try {
          const txt = await ocrRecognizeUrl(item.url, apiKey, vision);
          if (txt && txt.trim()) return txt.trim();
        } catch (e) {
          console.warn('ocrRecognizeUrl failed:', e);
        }
      }
      if (item.dataUrl) {
        try {
          const txt = await ocrRecognize(item.dataUrl, apiKey, vision);
          if (txt && txt.trim()) return txt.trim();
        } catch (e) {
          console.warn('ocrRecognize screen capture failed:', e);
        }
      }
      return '';
    }

    const headTexts = [];
    for (const s of headSlides) {
      if (!captured[s]) {
        // Честная пометка: слайд выбран, но добыть его не удалось (см. предупреждение)
        headTexts.push(`Слайд ${s}:\n(не удалось получить)`);
        continue;
      }
      if (statusEl) statusEl.textContent = apiKey ? `Распознаю слайд ${s} (Vision AI)…` : `Распознаю слайд ${s}…`;
      try {
        const txt = await ocrItem(captured[s]);
        const clean = compactOcrText(txt);
        headTexts.push(clean ? `Слайд ${s}:\n${clean}` : `Слайд ${s}:\n(нет текста)`);
      } catch (e) {
        console.warn(`Ошибка OCR слайда ${s}:`, e);
        headTexts.push(`Слайд ${s}:\n(ошибка распознавания)`);
      }
    }
    if (headTexts.length === 0) {
      headTexts.push('(не выбрано)');
    }

    const tailTexts = [];
    for (const s of tailSlides) {
      if (!captured[s]) {
        // Честная пометка: слайд выбран, но добыть его не удалось (см. предупреждение)
        tailTexts.push(`Слайд ${s}:\n(не удалось получить)`);
        continue;
      }
      if (statusEl) statusEl.textContent = apiKey ? `Распознаю слайд ${s} (Vision AI)…` : `Распознаю слайд ${s}…`;
      try {
        const txt = await ocrItem(captured[s]);
        const clean = compactOcrText(txt);
        tailTexts.push(clean ? `Слайд ${s}:\n${clean}` : `Слайд ${s}:\n(нет текста)`);
      } catch (e) {
        console.warn(`Ошибка OCR слайда ${s}:`, e);
        tailTexts.push(`Слайд ${s}:\n(ошибка распознавания)`);
      }
    }
    if (tailTexts.length === 0) {
      // Окно конца пустое бывает честно: слайд в карусели один или листание не
      // дошло до хвоста — тогда «призыв» это тот же слайд, что и хук. Раньше
      // тут стояло голое «(не выбрано)», и это читалось как поломка.
      tailTexts.push(actualTotal <= 1
        ? '(концовка совпадает с началом — прочитан только 1-й слайд, слайдов-то больше по метке)'
        : '(не выбрано)');
    }

    return {
      actualTotal,
      plannedTotal: scanLimit,
      // Предупреждения распознавалки (облако упёрлось в лимит и т.п.) — в отчёт, а
      // не только в консоль: пользователь должен видеть, что текст читали не нейронкой.
      warnings: warnings.concat(igxOcrNotesFlush()),
      headSlides,
      tailSlides,
      headText: headTexts.join('\n\n'),
      tailText: tailTexts.join('\n\n'),
    };
  }

  // WebAudio-отвод аудиодорожки <video> БЕЗ анмьюта элемента. captureStream() на muted
  // элементе в autoplay-ограниченном фоне не отдаёт звук, а unmute без жеста Chrome
  // наказывает паузой плеера. createMediaElementSource читает декодированный поток
  // элемента: в фоне он играет muted (разрешено), а мы пишем его через MediaStreamDestination.
  // Кэшим на элементе: MediaElementSource можно создать только ОДИН раз на элемент
  // (head+tail — это два вызова recordRange).
  function igxTapElementAudio(video) {
    try {
      // «The AudioContext was not allowed to start» — не наша поломка, а автоплей-
      // политика Chrome: resume() заблокированного фона = консольное предупреждение
      // с указанием на content.js, из-за чего в тулбаре раздувается «ошибка
      // расширения». Значит resume зовём ТОЛЬКО где он может пройти: реальный жест
      // человека в ЭТОМ документе (sticky hasBeenActive). Не выстрело — честная тишина.
      // ВАЖНО: document.hasFocus() сюда НЕ входит — авто-окно получает фокус ПРОГРАММНО
      // (его поднимают наверх anti-stick / режим front), а Chrome этого не считает за
      // жест: контекст создаётся, не стартует, и на каждый рилс сыпется варнинг + бейдж
      // «ошибки». При таком тапе писать звук всё равно нечем (suspended = тишина), так что
      // без hasFocus() мы ничего не теряем — только гасим мусор в консоли.
      const maybe = () => (navigator.userActivation ? navigator.userActivation.hasBeenActive !== false : true);
      const reResume = (tap) => {
        const ctx = tap.ctx;
        if (!ctx || ctx.state !== 'suspended' || !maybe()) return;
        try { ctx.resume().catch(() => {}); } catch (_) {}
      };
      const dropTap = (tap, el) => {
        try { if (tap && tap.unarm) tap.unarm(); } catch (_) {}
        try { if (tap && tap.ctx && tap.ctx.state !== 'closed') tap.ctx.close(); } catch (_) {}
        try { delete el.__igxAudioTap; } catch (_) { el.__igxAudioTap = null; }
      };
      const existing = video.__igxAudioTap;
      if (existing && existing.dest && (!existing.ctx || existing.ctx.state !== 'closed')) {
        reResume(existing);
        return existing.dest.stream;
      }
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      // Не создаём AudioContext вовсе, когда он запер бы автоплеем (фоновое окно без
      // жеста и без фокуса): самого конструирования вне жеста хватает, чтобы Chrome
      // на каждый рилс сыпал «The AudioContext was not allowed to start» и поднимал
      // бейдж «ошибки расширения». Такому тапу и так нечем было бы писать (тишина).
      if (!maybe()) return null;
      const ctx = new AudioCtx();
      const src = ctx.createMediaElementSource(video);
      const dest = ctx.createMediaStreamDestination();
      src.connect(dest); // к ctx.destination НЕ подключаем: только пишем, без колонок
      const tap = { ctx, src, dest, unarm: null };
      video.__igxAudioTap = tap;
      if (ctx.state === 'suspended' && maybe()) {
        try { ctx.resume().catch(() => {}); } catch (_) {}
      }
      if (ctx.state === 'suspended') {
        // Неожиданная радость: человек ткнул в это окно — открываем контекст по-тихому.
        const unlock = () => {
          if (ctx.state !== 'suspended') { arm(); return; }
          if (maybe()) { try { ctx.resume().catch(() => {}); } catch (_) {} }
        };
        const arm = () => {
          document.removeEventListener('pointerdown', unlock, true);
          document.removeEventListener('visibilitychange', unlock, true);
          if (tap._iv) { clearInterval(tap._iv); tap._iv = null; }
        };
        tap.unarm = arm;
        document.addEventListener('pointerdown', unlock, true);
        document.addEventListener('visibilitychange', unlock, true);
        tap._iv = setInterval(() => {
          if (ctx.state !== 'suspended') { arm(); return; }
          // фоновое окно без жеста — не долбим; окно с фокусом — пробуем ещё
          if (document.hasFocus()) unlock();
          // тупик: без шансов на жест (окно неактивно и MEI не пускает) — сбрасываем
          if (Date.now() > tap.deadline) { arm(); dropTap(tap, video); }
        }, 700);
        tap.deadline = Date.now() + 5000;
      }
      return dest.stream;
    } catch (_) {
      return null;
    }
  }

  async function recordRange(video, from, to) {
    if (typeof video.captureStream !== 'function' && typeof video.mozCaptureStream !== 'function') {
      throw new Error('Браузер не даёт захватить звук из этого видео.');
    }

    const prevTime = video.currentTime;
    const prevVolume = video.volume;
    const wasMuted = video.muted;

    // Восстановление состояния плеера — в finally: раньше при любой ошибке записи
    // видео оставалось со снятым mute и громкостью 0.5, а позиция не возвращалась.
    try {
      await videoSeekTo(video, from);

      // Аудиодорожка в captureStream() появляется только когда плеер РЕАЛЬНО играет,
      // поэтому заводим его на mute (muted-autoplay разрешён без жеста). Анмьютить же
      // без пользовательского жеста НЕЛЬЗЯ: Chrome не даёт снять mute и ВМЕСТО этого
      // ставит элемент на паузу (консольное «Unmuting failed and the element was paused
      // instead…») — поток обрывался. Раньше анмьют был безусловным и в фоне всегда
      // паузил плеер. Теперь: если страница «активна» (ручной анализатор, человек кликал)
      // — анмьютим и берём captureStream с настоящим звуком; если жеста не было (фоновый
      // авторазбор, наш синтетический клик activation не даёт) — держим mute и снимаем
      // декодированный звук через WebAudio-отвод, который unmute не требует.
      try { video.muted = true; video.volume = 1; await video.play(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 200));
      const userActive = !(navigator.userActivation && navigator.userActivation.hasBeenActive === false);
      if (userActive) {
        try { video.muted = false; video.volume = 0.5; } catch (_) {}
      }

      let cs = null;
      let tracks = [];
      for (let i = 0; i < 12; i++) {
        try { cs = video.captureStream ? video.captureStream() : video.mozCaptureStream(); } catch (_) { cs = null; }
        tracks = (cs && typeof cs.getAudioTracks === 'function') ? cs.getAudioTracks() : [];
        if (tracks.length) break;
        try { const p = video.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
        await new Promise((r) => setTimeout(r, 150));
      }
      // captureStream не отдал аудиотрек (типично для muted-элемента без жеста) — пробуем
      // отвести звук через AudioContext, не трогая mute элемента.
      if (!tracks.length) {
        const tapped = igxTapElementAudio(video);
        if (tapped) {
          cs = tapped; tracks = (typeof tapped.getAudioTracks === 'function') ? tapped.getAudioTracks() : [];
          // Контекст может остаться запертым автоплеем (фоновое окно без жеста) —
          // такой трек запишет тишину и сожжёт запрос впустую. Даём тапу раскрыться
          // (он сам ретраит на жест/фокус); не вышло — считаем трека нет.
          const tap = video.__igxAudioTap;
          if (tracks.length && tap && tap.ctx && tap.ctx.state === 'suspended') {
            for (let w = 0; w < 12 && tap.ctx.state === 'suspended'; w++) await new Promise((r) => setTimeout(r, 250));
            if (tap.ctx.state === 'suspended') tracks = [];
          }
        }
      }
      if (!tracks.length) throw new Error('Звука нет: в видео дорожки не оказалось, либо Chrome не отдал звук в этом окне (фоновое проигрывание без жеста).');

      // Изолируем только аудиодорожку, чтобы MediaRecorder не падал из-за наличия видеодорожки
      const audioStream = new MediaStream(tracks);

      let mimeType = '';
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        mimeType = 'audio/webm;codecs=opus';
      } else if (MediaRecorder.isTypeSupported('audio/webm')) {
        mimeType = 'audio/webm';
      } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
        mimeType = 'audio/mp4';
      }

      const chunks = [];
      let resolveStopped;
      const stopped = new Promise((res) => { resolveStopped = res; });
      let rec;
      // wire перепривязывает обработчики при каждой подмене rec — иначе onstop остане-
      // ся на старом MediaRecorder и stopped не разрезолвился бы (запись висела).
      const wire = (r) => {
        rec = r;
        rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
        rec.onstop = () => resolveStopped();
      };
      try {
        wire(mimeType ? new MediaRecorder(audioStream, { mimeType }) : new MediaRecorder(audioStream));
      } catch (e) {
        console.warn('MediaRecorder audioStream init failed, trying raw stream:', e);
        wire(new MediaRecorder(cs));
      }

      try {
        rec.start(100);
      } catch (e) {
        console.warn('rec.start failed on audioStream, fallback to cs:', e);
        wire(new MediaRecorder(cs));
        rec.start(100);
      }

      const dur = Math.max(0.5, to - from);
      // Пока пишем, Instagram в unfocused-окне может снова паузнуть плеер — тогда
      // остальная часть окна запишется тишиной. Держим плеер играющим: каждые 250 мс
      // проверяем paused и возвращаем play(), не трогая mute (поток уже с треком).
      await new Promise((r) => {
        const stopAt = Date.now() + Math.round(dur * 1000);
        const iv = setInterval(() => {
          try { if (video.paused) { const p = video.play(); if (p && p.catch) p.catch(() => {}); } } catch (_) {}
          if (Date.now() >= stopAt) { clearInterval(iv); r(); }
        }, 250);
      });

      try {
        if (rec.state !== 'inactive') rec.stop();
      } catch (_) {}
      await stopped;

      try {
        video.pause();
      } catch (_) {}

      return new Blob(chunks, { type: 'audio/webm' });
    } finally {
      try {
        video.currentTime = prevTime;
      } catch (_) {}
      video.volume = prevVolume;
      video.muted = wasMuted;
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(new Error('Не смог прочитать звук.'));
      fr.readAsDataURL(blob);
    });
  }

  // Распознавание кадров видео по одному. Описание картинки (vision) просим ТОЛЬКО
  // с первого кадра окна: кадры одного ролика похожи, описывать каждый — пустая трата
  // токенов, а текста-то на них и так столько же.
  async function ocrFrames(frames, apiKey, statusEl, label, vision) {
    const out = [];
    for (let i = 0; i < frames.length; i++) {
      if (statusEl) {
        statusEl.textContent = `Распознаю текст ${label} (${i + 1}/${frames.length})…`;
      }
      try {
        const txt = await ocrRecognize(frames[i], apiKey, !!vision && i === 0);
        if (txt) out.push(txt);
      } catch (e) {
        console.warn(`Ошибка OCR кадра ${i + 1}:`, e);
      }
    }
    return out;
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {}
    // Фолбэк через скрытый textarea. Удаление — в finally: если execCommand бросит
    // исключение, textarea не должна остаться висеть в DOM.
    let ta = null;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      return document.execCommand('copy');
    } catch (_) {
      return false;
    } finally {
      try {
        ta?.remove();
      } catch (_) {}
    }
  }

  // ---------- метрики поста: просмотры / лайки / комментарии / репосты ----------
  // Instagram отдаёт числа сразу в нескольких местах и форматах, а вёрстка лент
  // (Reels, модалка поста, профиль) отличается. Поэтому ниже не один селектор, а
  // цепочка независимых стратегий — выигрывает первая, вернувшая значение:
  //   1) React Fiber (точное число из props)                        — igxExtractMetric
  //   2) aria-label / title кнопок, иконок и подписей-счётчиков      — igxCountByAttributes
  //   3) короткий числовой текст внутри кнопки и рядом с ней (в ленте
  //      Reels число лежит в соседнем span под иконкой)              — igxCountNear
  //   4) ключевые фразы в тексте области поста («N отметок "Нравится"»,
  //      «Посмотреть все N комментариев», «N репостов»)              — igxCountByText
  // Если ни одна стратегия не сработала — возвращаем null, а НЕ 0:
  // ноль не должен маскировать поломку извлечения.

  const IGX_LIKE_WORDS = ['нравится', 'лайк', 'like', 'unlike', 'liked'];
  const IGX_COMMENT_WORDS = ['комментар', 'коммент', 'комментир', 'comment'];
  const IGX_SHARE_WORDS = ['поделиться', 'поделились', 'репост', 'share', 'repost', 'отправить'];
  // Слова соседних кнопок: по ним отсекаем чужие числа (иначе лайки уезжали бы в репосты)
  const IGX_OTHER_ACTION_WORDS = [].concat(
    IGX_LIKE_WORDS,
    IGX_COMMENT_WORDS,
    IGX_SHARE_WORDS,
    ['сохран', 'save', 'bookmark', 'ещё', 'еще', 'more', 'дополнительно']
  );

  // Фразы в тексте области поста. Число обязано стоять вплотную к ключевому слову,
  // иначе легко выдернуть из описания случайную цифру. ВАЖНО: \w в JS не матчит
  // кириллицу, поэтому окончания слов пишем явным классом [а-яё].
  // Точка после множителя («1,2 тыс. репостов») и перед самим ключевым словом —
  // необязательная, но допустимая: в русской локали ИГ пишет именно так.
  const IGX_LIKE_TEXT_PATTERNS = [
    /([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|млрд|k|m|b)\.?)?)\s*\.?\s*отмет[а-яё]*\s*["«”']?\s*нравится/i,
    /(?:нравится|likes?)\s*[:—-]\s*([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|млрд|k|m|b)\.?)?)/i,
    /([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|млрд|k|m|b)\.?)?)\s*\.?\s*(?:likes?|лайк[а-яё]*)/i,
    /нравится\s+[\w.]+\s+и\s+(?:еще|ещё)\s+([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|k|m)\.?)?)/i,
    /liked\s+by\s+[\w.]+\s+and\s+([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|k|m)\.?)?)\s+others/i,
  ];
  const IGX_COMMENT_TEXT_PATTERNS = [
    /(?:посмотреть\s+(?:все\s+)?|показать\s+(?:все\s+)?|view\s+all\s+|все\s+)([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|k|m)\.?)?)\s*\.?\s*(?:комментар[а-яё]*|comments?)/i,
    /([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|k|m)\.?)?)\s*\.?\s*(?:комментар[а-яё]*|comments?)/i,
    /(?:комментар[а-яё]*|comments?)\s*[:—-]\s*([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|k|m)\.?)?)/i,
  ];
  const IGX_REPOST_TEXT_PATTERNS = [
    /([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|k|m)\.?)?)\s*\.?\s*(?:репост[а-яё]*|reposts?|shares?)/i,
    /(?:репост[а-яё]*|reposts?|shares?)\s*[:—-]\s*([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|k|m)\.?)?)/i,
  ];

  // Просмотры: под описанием это «N просмотров» / «N views» / «N воспроизведений»,
  // а в ленте Reels число часто стоит рядом с иконкой play вообще без подписи —
  // такой случай ловит igxCountNear (стратегия 3: короткое число рядом с иконкой).
  const IGX_VIEW_WORDS = ['просмотр', 'просмотры', 'просмотров', 'воспроизведен', 'view', 'views', 'play', 'plays', 'played'];
  const IGX_VIEW_TEXT_PATTERNS = [
    /([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|млрд|k|m|b)\.?)?)\s*\.?\s*(?:просмотр[а-яё]*|воспроизведен[а-яё]*|views?|plays?)/i,
    /(?:просмотр[а-яё]*|воспроизведен[а-яё]*|views?|plays?)\s*[:—-]\s*([\d][\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|млрд|k|m|b)\.?)?)/i,
  ];

  // Скрытые лайки: «Отметки "Нравится" скрыты» / «likes are hidden». Написания «Нравится
  // X и другим» / «liked by X and others» оставлены как было (X — ник, только латиница).
  const IGX_LIKES_HIDDEN_RE = new RegExp(
    [
      'отметк[а-яё]*\\s*["«”\']?\\s*нравится["»”\']?\\s*скрыт',
      'скрыт[а-яё]*[^.]{0,24}отметк',
      'likes?\\s*(?:are|is)?\\s*hidden',
      'hidden\\s+likes?',
      'нравится\\s+[\\w.]+\\s+и\\s+другим(?!\\s*\\d)',
      'liked\\s+by\\s+[\\w.]+\\s+and\\s+others(?!\\s*\\d)',
    ].join('|'),
    'i'
  );

  // Неразрывные и узкие пробелы ИГ использует как разделитель разрядов — приводим к обычному
  function igxNormalizeText(raw) {
    return String(raw == null ? '' : raw)
      .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Компактные числа Instagram: «1 234» → 1234, «1,2 тыс.» → 1200, «1.2K» → 1200,
  // «3,4 млн» → 3400000, «1,234» → 1234 (англ. разряды), «1.234» → 1234 (европ. разряды).
  function parseCompactCount(raw) {
    let s = igxNormalizeText(raw).toLowerCase();
    if (!/\d/.test(s)) return null;

    // Множитель: «1,2 тыс.», «3.4M», «2 млн». Буква после множителя = это уже другое слово.
    let mult = 1;
    const suf = s.match(/(тыс[а-яё]*|млн|млрд|k|m|b)(?![a-zа-яё0-9])/);
    if (suf) {
      if (suf[1].startsWith('тыс') || suf[1] === 'k') mult = 1e3;
      else if (suf[1] === 'млн' || suf[1] === 'm') mult = 1e6;
      else if (suf[1] === 'млрд' || suf[1] === 'b') mult = 1e9;
      s = s.slice(0, suf.index) + ' ' + s.slice(suf.index + suf[1].length);
    }

    // Берём первое ЧИСЛО, а не «всё числоподобное»: разряды идут группами по 3 цифры
    // («1 234 567», «1,234,567»), поэтому группа другого размера — уже другое число.
    const num = s.match(/\d{1,3}(?:[ .,]\d{3})+|\d+(?:[.,]\d+)?/);
    if (!num) return null;
    let t = num[0].replace(/\s/g, '').replace(/^[.,]+|[.,]+$/g, '');
    if (!t) return null;

    if (mult === 1 && /^\d{1,3}(?:,\d{3})+$/.test(t)) t = t.replace(/,/g, '');
    else if (mult === 1 && /^\d{1,3}(?:\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
    else t = t.replace(/,/g, '.');

    const value = parseFloat(t);
    if (!isFinite(value)) return null;
    return Math.round(value * mult);
  }

  // Первое число из подписи/строки («Нравится: 1 234», «1,2 тыс. отметок», «View all 12 comments»)
  function igxCountFromText(raw) {
    const s = igxNormalizeText(raw);
    if (!/\d/.test(s)) return null;
    const m = s.match(/(\d{1,3}(?:[ .,]\d{3})+|\d+(?:[.,]\d+)?)\s*(?:тыс[а-яё]*|млн|млрд|k|m|b)?(?![a-zа-яё0-9])/i);
    if (!m) return null;
    return parseCompactCount(m[0]);
  }

  // Совпадает ли подпись с одним из «слов» метрики. Сравниваем по токенам и по началу
  // токена — так «комментариев» попадает в «комментар», а «Likes» в «like».
  function igxLabelMatches(label, words) {
    const s = igxNormalizeText(label).toLowerCase();
    if (!s || !words || !words.length) return false;
    const tokens = s.split(/[^0-9a-zа-яё]+/i).filter(Boolean);
    if (!tokens.length) return false;
    return words.some((w) => tokens.some((t) => t === w || t.startsWith(w)));
  }

  // Короткий ЧИСТО числовой текст элемента («1 234», «1,2 тыс.»). Длинные тексты
  // (описания, подписи) отсекаем, чтобы не выдернуть оттуда случайное число.
  function igxShortNumberFrom(el) {
    if (!el || !el.textContent) return null;
    const t = igxNormalizeText(el.textContent.replace(/[^\d\s.,a-zа-яё]/gi, ''));
    if (!t || t.length > 20) return null;
    if (!/^\d[\d\s.,]*(?:\s*(?:тыс[а-яё]*|млн|млрд|k|m|b))?\.?$/i.test(t)) return null;
    return igxCountFromText(t);
  }

  // Есть ли внутри элемента подпись ДРУГОЙ кнопки действия (лайк/коммент/поделиться/
  // сохранить)? Такие узлы пропускаем, чтобы не подставить чужое число.
  function igxForeignAction(el, myWords) {
    if (!el || !el.querySelectorAll) return false;
    const nodes = el.querySelectorAll('[aria-label], [title]');
    for (const n of nodes) {
      const label = igxNormalizeText(n.getAttribute('aria-label') || n.getAttribute('title'));
      if (!label) continue;
      if (igxLabelMatches(label, myWords)) continue;
      if (igxLabelMatches(label, IGX_OTHER_ACTION_WORDS)) return true;
    }
    return false;
  }

  // Иконки/кнопки действия внутри области (в ИГ подписи живут в aria-label у svg и кнопок).
  // Порядок — от внешних к глубоким: кнопки действий самого поста лежат выше, а одноимённые
  // кнопки внутри комментариев («Нравится» у каждого комментария) — глубже в DOM.
  function igxMetricButtons(root, words, excludeWords) {
    const out = [];
    if (!root || !root.querySelectorAll) return out;
    const seen = new Set();
    const add = (el) => {
      if (el && !seen.has(el)) {
        seen.add(el);
        out.push(el);
      }
    };
    root.querySelectorAll('svg[aria-label], svg[title]').forEach((svg) => {
      const label = igxNormalizeText(svg.getAttribute('aria-label') || svg.getAttribute('title'));
      if (!igxLabelMatches(label, words)) return;
      if (excludeWords && igxLabelMatches(label, excludeWords)) return;
      add(svg.closest('button, [role="button"], a') || svg.parentElement || svg);
    });
    root
      .querySelectorAll('button[aria-label], button[title], [role="button"][aria-label], [role="button"][title], a[aria-label], a[title]')
      .forEach((btn) => {
        const label = igxNormalizeText(btn.getAttribute('aria-label') || btn.getAttribute('title'));
        if (!igxLabelMatches(label, words)) return;
        if (excludeWords && igxLabelMatches(label, excludeWords)) return;
        add(btn);
      });
    const depthOf = (el) => {
      let d = 0;
      let cur = el;
      while (cur && cur !== root && d < 100) {
        cur = cur.parentElement;
        d++;
      }
      return d;
    };
    out.sort((a, b) => depthOf(a) - depthOf(b));
    return out;
  }

  // Стратегия 2: подписи aria-label/title, в которых лежит само число
  // («Нравится: 1 234», «1 234 отметок "Нравится"», «Посмотреть все 12 комментариев»).
  // excludeWords — подписи чужих метрик, которые содержит слова этой: для просмотров это
  // «View all 12 comments» (число там от комментариев, а не от просмотров).
  function igxCountByAttributes(root, words, excludeWords) {
    if (!root || !root.querySelectorAll) return null;
    const nodes = root.querySelectorAll('[aria-label], [title]');
    for (const el of nodes) {
      for (const attr of ['aria-label', 'title']) {
        const v = igxNormalizeText(el.getAttribute && el.getAttribute(attr));
        if (!v || v.length > 60 || !/\d/.test(v)) continue;
        if (!igxLabelMatches(v, words)) continue;
        if (excludeWords && igxLabelMatches(v, excludeWords)) continue;
        const n = igxCountFromText(v);
        if (n !== null) return n;
      }
    }
    return null;
  }

  // Стратегия 3: число рядом с иконкой/кнопкой. Порядок: подпись кнопки → её текст →
  // ближайшие соседи (столбик Reels: иконка, рядом число) → короткий числовой текст родителя.
  // boundary — область поиска: за её пределы не выходим, иначе из поста можно «вылезти»
  // в body и подставить число соседнего поста (в ленте — соседнего ролика).
  function igxCountNear(el, words, boundary) {
    if (!el) return null;
    const btn = el.closest?.('button, [role="button"], a') || el;
    const nodes = btn === el ? [el] : [el, btn];

    for (const node of nodes) {
      for (const attr of ['aria-label', 'title']) {
        const v = igxNormalizeText(node.getAttribute && node.getAttribute(attr));
        if (!v) continue;
        const n = igxCountFromText(v);
        if (n !== null) return n;
      }
    }
    for (const node of nodes) {
      const n = igxShortNumberFrom(node);
      if (n !== null) return n;
    }

    let cur = btn;
    for (let up = 0; up < 3 && cur && cur.parentElement; up++) {
      const parent = cur.parentElement;
      if (boundary && parent !== boundary && !boundary.contains(parent)) break;
      const kids = Array.from(parent.children || []);
      const idx = kids.indexOf(cur);
      const ordered = [];
      if (idx >= 0) {
        // сначала ближайшие соседи, потом всё дальше (число почти всегда вплотную к иконке)
        for (let d = 1; d < kids.length; d++) {
          if (kids[idx + d]) ordered.push(kids[idx + d]);
          if (idx - d >= 0) ordered.push(kids[idx - d]);
        }
      } else {
        ordered.push(...kids);
      }
      for (const sib of ordered) {
        if (sib === cur || sib.contains?.(btn)) continue;
        if (igxForeignAction(sib, words)) continue;
        const n = igxShortNumberFrom(sib);
        if (n !== null) return n;
      }
      if (!igxForeignAction(parent, words)) {
        const n = igxShortNumberFrom(parent);
        if (n !== null) return n;
      }
      cur = parent;
    }
    return null;
  }

  // Стратегия 4: ключевые фразы в тексте области поста
  function igxCountByText(root, patterns) {
    if (!root) return null;
    let txt = '';
    try {
      txt = root.innerText || root.textContent || '';
    } catch (_) {}
    if (!txt) return null;
    txt = igxNormalizeText(txt);
    for (const re of patterns) {
      const m = txt.match(re);
      if (!m) continue;
      const n = igxCountFromText(m[1] || m[0]);
      if (n !== null) return n;
    }
    return null;
  }

  // Контейнер поста вокруг видимого ролика: ближайший предок, внутри которого есть
  // кнопки действий. В ленте Reels <article> отсутствует, а <body> слишком широко —
  // в виртуализированной ленте там лежат числа соседних роликов.
  function igxPostScopeFromVideo(video) {
    if (!video) return null;
    let cur = video.parentElement;
    for (let up = 0; up < 12 && cur && cur !== document.body; up++, cur = cur.parentElement) {
      if (igxMetricButtons(cur, IGX_LIKE_WORDS).length || igxMetricButtons(cur, IGX_COMMENT_WORDS).length) return cur;
    }
    return null;
  }

  // Области поиска метрик: от самой точной к самой широкой. Если article не нашёлся
  // (лента Reels, сторис, попапы) — findPostArticle отдаёт body, и по нему искать нельзя.
  function igxMetricRoots(root) {
    const list = [];
    const add = (el) => {
      if (el && el.nodeType === 1 && !list.includes(el)) list.push(el);
    };
    const bodyLike = !root || root === document || root === document.body || !root.tagName;
    if (!bodyLike) add(root);
    add(igxPostScopeFromVideo(pickBestVideo()));
    if (!list.length) add(document.body);
    // Вложенную область проверяем первой: в ленте Reels контейнер ролика точнее,
    // чем article/main/body, которые отдаёт findPostArticle.
    list.sort((a, b) => (a === b ? 0 : a.contains(b) ? 1 : b.contains(a) ? -1 : 0));
    return list;
  }

  // Скрыты ли лайки: по тексту области поста (innerText — видимый текст, textContent — запас)
  function igxLikesHidden(roots) {
    for (const r of roots) {
      let txt = '';
      try {
        txt = r.innerText || r.textContent || '';
      } catch (_) {}
      if (txt && IGX_LIKES_HIDDEN_RE.test(txt)) return true;
    }
    return false;
  }

  // Прогон стратегий 2-4 по всем областям поиска
  function igxExtractMetric(roots, words, patterns, excludeWords) {
    for (const r of roots) {
      const byAttr = igxCountByAttributes(r, words, excludeWords);
      if (byAttr !== null) return byAttr;
    }
    for (const r of roots) {
      for (const el of igxMetricButtons(r, words, excludeWords)) {
        const near = igxCountNear(el, words, r);
        if (near !== null) return near;
      }
    }
    for (const r of roots) {
      const byText = igxCountByText(r, patterns);
      if (byText !== null) return byText;
    }
    return null;
  }

  // Извлечение детальных данных публикации (Reels / видео / карусель / фото)
  function extractInstagramPostData(scope) {
    const article = findPostArticle(scope);
    const root = article || document;

    // 1. Попытка достать точные данные из React Fiber (через main-bridge в MAIN world)
    let fiberData = null;
    try {
      document.dispatchEvent(new CustomEvent('igx_req_post_meta'));
      if (document.documentElement.dataset.igxPostMeta) {
        fiberData = JSON.parse(document.documentElement.dataset.igxPostMeta);
      }
    } catch (_) {}

    // Резервная прямая попытка (если запущено в контексте с доступом к Fiber)
    if (!fiberData) {
      try {
        const candidates = [
          root.querySelector('video'),
          root.querySelector('ul._acay'),
          root,
          document.querySelector('[role="dialog"] article'),
          document.querySelector('article'),
        ].filter(Boolean);

        for (const el of candidates) {
          const k = Object.keys(el).find((key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
          if (!k) continue;
          let curr = el[k];
          for (let depth = 0; depth < 30 && curr; depth++) {
            const p = curr.memoizedProps || curr.pendingProps;
            if (p) {
              const item = p.item || p.media || p.post || p.clip;
              if (item && (item.like_count !== undefined || item.caption !== undefined || item.taken_at !== undefined || item.pk)) {
                fiberData = {
                  pk: item.pk,
                  taken_at: typeof item.taken_at === 'number' ? item.taken_at : null,
                  like_count: typeof item.like_count === 'number' ? item.like_count : null,
                  like_and_view_counts_disabled: !!item.like_and_view_counts_disabled,
                  comment_count: typeof item.comment_count === 'number' ? item.comment_count : null,
                  play_count: typeof item.play_count === 'number' ? item.play_count : (typeof item.view_count === 'number' ? item.view_count : null),
                  reshare_count: typeof item.reshare_count === 'number' ? item.reshare_count : (typeof item.share_count === 'number' ? item.share_count : null),
                  caption: item.caption && typeof item.caption.text === 'string' ? item.caption.text : (typeof item.caption === 'string' ? item.caption : null),
                };
                break;
              }
            }
            curr = curr.return;
          }
          if (fiberData) break;
        }
      } catch (_) {}
    }

    // 2. Сколько дней назад выложен ролик
    let daysAgo = null;
    if (fiberData && typeof fiberData.taken_at === 'number') {
      const diffMs = Date.now() - fiberData.taken_at * 1000;
      daysAgo = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
    }
    if (daysAgo === null) {
      const timeEls = Array.from(root.querySelectorAll('time[datetime], time'));
      if (!timeEls.length && document.body) {
        timeEls.push(...document.querySelectorAll('time[datetime], time'));
      }
      for (const timeEl of timeEls) {
        const dtStr = timeEl.getAttribute('datetime');
        if (dtStr) {
          const dt = new Date(dtStr);
          if (!isNaN(dt.getTime())) {
            const diffMs = Date.now() - dt.getTime();
            daysAgo = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
            break;
          }
        }
        const rawT = (timeEl.getAttribute('title') || timeEl.textContent || '').trim().toLowerCase();
        const mDays = rawT.match(/(\d+)\s*(?:д|дн|days?|d)/i);
        const mWeeks = rawT.match(/(\d+)\s*(?:нед|w|weeks?)/i);
        const mMonths = rawT.match(/(\d+)\s*(?:мес|mo|months?)/i);
        const mHours = rawT.match(/(\d+)\s*(?:ч|h|hours?|мин|m|минут|minutes?)/i);
        if (mDays) { daysAgo = parseInt(mDays[1], 10); break; }
        else if (mWeeks) { daysAgo = parseInt(mWeeks[1], 10) * 7; break; }
        else if (mMonths) { daysAgo = parseInt(mMonths[1], 10) * 30; break; }
        else if (mHours) { daysAgo = 0; break; }
      }
    }

    const metricRoots = igxMetricRoots(root);

    // 3. Просмотры
    let views = null;
    if (fiberData) {
      if (typeof fiberData.play_count === 'number') views = fiberData.play_count;
      else if (typeof fiberData.view_count === 'number') views = fiberData.view_count;
    }
    if (views === null) {
      views = igxExtractMetric(metricRoots, IGX_VIEW_WORDS, IGX_VIEW_TEXT_PATTERNS, IGX_COMMENT_WORDS);
    }

    // 4. Лайки
    let likes = null;
    let likesHidden = !!(fiberData && fiberData.like_and_view_counts_disabled);
    if (!likesHidden && fiberData && typeof fiberData.like_count === 'number') {
      likes = fiberData.like_count;
    }
    if (!likesHidden && likes === null) {
      likes = igxExtractMetric(metricRoots, IGX_LIKE_WORDS, IGX_LIKE_TEXT_PATTERNS);
    }
    if (!likesHidden && likes === null) {
      likesHidden = igxLikesHidden(metricRoots);
    }

    // 5. Комментарии
    let comments = null;
    if (fiberData && typeof fiberData.comment_count === 'number') {
      comments = fiberData.comment_count;
    }
    if (comments === null) {
      comments = igxExtractMetric(metricRoots, IGX_COMMENT_WORDS, IGX_COMMENT_TEXT_PATTERNS);
    }

    // 6. Репосты
    let reposts = null;
    if (fiberData) {
      if (typeof fiberData.reshare_count === 'number') reposts = fiberData.reshare_count;
      else if (typeof fiberData.share_count === 'number') reposts = fiberData.share_count;
    }
    if (reposts === null) {
      reposts = igxExtractMetric(metricRoots, IGX_SHARE_WORDS, IGX_REPOST_TEXT_PATTERNS);
    }

    // 7. Описание
    let caption = null;
    if (fiberData && typeof fiberData.caption === 'string') {
      caption = fiberData.caption.trim();
    } else if (fiberData && fiberData.caption && typeof fiberData.caption.text === 'string') {
      caption = fiberData.caption.text.trim();
    }
    if (!caption) {
      const capEl = root.querySelector('div._a9zs, h1, span._ap3a._aaco, div[data-testid="post-comment-root"] span');
      if (capEl) {
        const innerSpan = capEl.querySelector('span');
        const raw = innerSpan ? (innerSpan.innerText || innerSpan.textContent || '') : (capEl.innerText || capEl.textContent || '');
        caption = raw.trim();
      }
    }
    if (!caption) {
      caption = findReelsCaptionText(root);
    }
    if (caption) {
      caption = caption.replace(/\s*(?:…|\.\.\.)?\s*(?:ещё|more)\s*$/i, '').trim();
    }

    return {
      daysAgo,
      views,
      likes: likesHidden ? 'скрыто' : likes,
      comments,
      reposts,
      description: caption && caption.length > 0 ? caption : null,
    };
  }

  function formatPostDataText(data) {
    if (!data) return '';
    const formatVal = (v, defaultVal = 'нет') => {
      if (v === null || v === undefined) return defaultVal;
      if (typeof v === 'number') return Number.isFinite(v) ? v.toLocaleString('ru-RU') : defaultVal;
      const s = String(v).trim();
      return s || defaultVal;
    };
    // Есть ли реальное значение (не null/undefined/пусто). Просмотры Instagram
    // почти всегда прячет — «Просмотры: нет» это не факт о ролике, а шум («не нашли»).
    // Поэтому про просмотры говорим только когда число действительно есть.
    const hasVal = (v) => v !== null && v !== undefined &&
      (typeof v === 'number' ? Number.isFinite(v) : String(v).trim() !== '');

    const lines = [
      `Сколько дней назад выложен ролик: ${data.daysAgo !== null && data.daysAgo !== undefined ? data.daysAgo : 'нет'}`,
    ];
    if (hasVal(data.views)) lines.push(`Просмотры: ${formatVal(data.views)}`);
    lines.push(
      `Лайки: ${data.likes === 'скрыто' ? 'скрыто' : formatVal(data.likes, 'нет')}`,
      `Комментарии: ${formatVal(data.comments, '0')}`,
      `Репосты: ${formatVal(data.reposts, 'нет')}`,
    );

    const desc = (data.description || '').trim();
    if (desc) {
      lines.push(`Описание: ${desc.includes('\n') ? '\n' + desc : desc}`);
    } else {
      lines.push('Описание: нет');
    }

    return lines.join('\n');
  }

  function initOcrPopDrag(pop) {
    const head = pop.querySelector('.igx-ocr-head');
    if (!head) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = pop.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      pop.style.left = `${origLeft}px`;
      pop.style.top = `${origTop}px`;
      pop.style.right = 'auto';
      pop.style.bottom = 'auto';
      head.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    head.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newL = Math.max(10, Math.min(window.innerWidth - pop.offsetWidth - 10, origLeft + dx));
      const newT = Math.max(10, Math.min(window.innerHeight - pop.offsetHeight - 10, origTop + dy));
      pop.style.left = `${newL}px`;
      pop.style.top = `${newT}px`;
    });

    const endDrag = (e) => {
      if (!isDragging) return;
      isDragging = false;
      try {
        head.releasePointerCapture?.(e.pointerId);
      } catch (_) {}
      safeStorageSet({
        igx_ocr_pos: { left: pop.style.left, top: pop.style.top },
      });
    };

    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);
  }

  function ensureOcrPopup() {
    if (igxOcrPop && document.body.contains(igxOcrPop)) return igxOcrPop;
    const pop = document.createElement('div');
    pop.className = 'igx-ocr-pop';
    pop.innerHTML =
      '<div class="igx-ocr-head"><span class="igx-ocr-title">Извлечение текста</span><button class="igx-ocr-close" title="Закрыть">✕</button></div>' +
      '<div class="igx-ocr-tabs">' +
      '<button type="button" class="igx-ocr-tab igx-tab-video active">🎬 Видео</button>' +
      '<button type="button" class="igx-ocr-tab igx-tab-slides">🖼 Слайды</button>' +
      '</div>' +
      '<div class="igx-ocr-inputs">' +
      '<div class="igx-ocr-field">' +
      '<div class="igx-ocr-field-label igx-lbl-start">Первые сек</div>' +
      '<input type="number" class="igx-ocr-start" min="0" max="60" value="7">' +
      '</div>' +
      '<div class="igx-ocr-field">' +
      '<div class="igx-ocr-field-label igx-lbl-end">Последние сек</div>' +
      '<input type="number" class="igx-ocr-end" min="0" max="60" value="7">' +
      '</div>' +
      '</div>' +
      '<div class="igx-ocr-modes">' +
      '<label title="Распознаёт надписи на кадрах"><input type="radio" name="igx-ocr-mode" value="text" checked> Текст с экрана</label>' +
      '<label title="Распознаёт речь из звука"><input type="radio" name="igx-ocr-mode" value="audio"> Речь из звука</label>' +
      '</div>' +
      '<div class="igx-ocr-fps-wrap" style="margin-top:6px; padding:6px 10px; background:rgba(255,255,255,0.04); border-radius:6px; border:1px solid rgba(255,255,255,0.08);">' +
      '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">' +
      '<span style="font-size:11px; color:#cbd5e1; font-weight:600;">🎯 Частота анализа кадров:</span>' +
      '<span class="igx-ocr-fps-label" style="font-size:11px; color:#38bdf8; font-weight:700;">1 кадр / 1.0 с</span>' +
      '</div>' +
      '<input type="range" class="igx-ocr-fps-slider" min="1" max="5" step="1" value="3" style="width:100%; accent-color:#38bdf8; cursor:pointer;" />' +
      '<div style="display:flex; justify-content:space-between; font-size:9px; color:#64748b; margin-top:2px;">' +
      '<span>2.5с (быстро)</span>' +
      '<span>1.5с</span>' +
      '<span>1.0с (норма)</span>' +
      '<span>0.5с</span>' +
      '<span>0.3с (макс)</span>' +
      '</div>' +
      '</div>' +
      '<div class="igx-ocr-badge igx-ocr-slide-note" style="display:none;">На слайдах текст распознаётся со слайдов</div>' +
      '<label class="igx-ocr-chk-meta-label" title="При копировании добавлять данные ролика (дни, просмотры, лайки, комментарии, репосты, описание) перед текстом транскрипции">' +
      '<input type="checkbox" class="igx-ocr-chk-meta" />' +
      '<span>📋 Добавлять данные видео к тексту</span>' +
      '</label>' +
      '<label class="igx-ocr-chk-meta-label" title="Просить нейросеть не только прочитать надписи, но и коротко описать, что изображено (кто в кадре и что происходит — ровно 1–2 предложения). Тот же запрос, поэтому запросов к API больше не становится — чуть длиннее ответ. Нужна нейронка: облачный ключ ниже или локальная модель LM Studio; обычная распознавалка Tesseract картинок не описывает. Результат в этом режиме всегда в двух блоках: «Текст:» и «Что на слайде:». Текст промпта правится в блоке «🧠 Промпт для нейросети» ниже.">' +
      '<input type="checkbox" class="igx-ocr-chk-vision" />' +
      '<span>👁 Описывать и то, что на картинке (Vision)</span>' +
      '</label>' +
      igxPromptEditorHtml() +
      '<details class="igx-ocr-api-details" style="margin-top: 8px; margin-bottom: 8px; font-size: 11px; color: #8fa3b8; cursor: pointer;">' +
      '<summary style="outline: none; user-select: none; font-weight: 600;">⚡ Ключ Groq API (бесплатно, точность 100% Premiere)</summary>' +
      '<div style="margin-top: 6px; display: flex; flex-direction: column; gap: 4px;">' +
      '<input type="password" class="igx-ocr-apikey-input" placeholder="gsk_... (бесплатно на console.groq.com) или sk-..." style="width: 100%; box-sizing: border-box; padding: 6px 8px; font-size: 11px; background: #1a2129; border: 1px solid #37424f; border-radius: 6px; color: #e7edf3;" />' +
      '<span style="font-size: 10px; color: #64748b; line-height: 1.3;">Распознаёт речь через Whisper Large v3 и текст на слайдах/видео через Vision AI (Qwen 3.6 / GPT-4o). Если пусто — работает локально.</span>' +
      '</div>' +
      '</details>' +
      igxLocalOcrHtml() +
      '<button class="igx-btn igx-ocr-run">📝 Извлечь и скопировать</button>' +
      '<div class="igx-ocr-status"></div>' +
      '<div class="igx-ocr-result-wrap" style="display:none;">' +
      '<div class="igx-ocr-result-head"><span>Результат:</span><button type="button" class="igx-ocr-copy-btn">📋 Скопировать</button></div>' +
      '<textarea class="igx-ocr-result-text" rows="5" readonly></textarea>' +
      '</div>';
    document.body.appendChild(pop);

    initOcrPopDrag(pop);
    igxWirePromptEditor(pop);
    igxWireLocalOcr(pop);

    pop.querySelector('.igx-ocr-close').addEventListener('click', () => {
      pop.style.display = 'none';
    });
    pop.querySelector('.igx-ocr-run').addEventListener('click', () => ocrRun());

    const copyBtn = pop.querySelector('.igx-ocr-copy-btn');
    const resultText = pop.querySelector('.igx-ocr-result-text');
    copyBtn.addEventListener('click', async () => {
      const text = resultText.value;
      if (!text) return;
      const ok = await copyToClipboard(text);
      if (ok) {
        copyBtn.textContent = '✓ Скопировано!';
        setTimeout(() => {
          copyBtn.textContent = '📋 Скопировать';
        }, 2000);
      } else {
        resultText.focus();
        resultText.select();
        document.execCommand('copy');
        copyBtn.textContent = '✓ Скопировано!';
        setTimeout(() => {
          copyBtn.textContent = '📋 Скопировать';
        }, 2000);
      }
    });

    const metaChk = pop.querySelector('.igx-ocr-chk-meta');
    if (metaChk) {
      chrome.storage.local.get([OCR_INCLUDE_META_KEY]).then((d) => {
        if (d && typeof d[OCR_INCLUDE_META_KEY] === 'boolean') {
          metaChk.checked = d[OCR_INCLUDE_META_KEY];
        }
      });
      metaChk.addEventListener('change', () => {
        safeStorageSet({ [OCR_INCLUDE_META_KEY]: metaChk.checked });
        if (resultText && resultText.value) {
          const currentVal = resultText.value;
          const hasSep = currentVal.includes('\n\n---\n');
          if (metaChk.checked && !hasSep) {
            const media = detectCurrentPostMedia();
            const postMeta = extractInstagramPostData((media && media.scope) || findPostArticle() || document);
            const metaStr = formatPostDataText(postMeta);
            if (metaStr) resultText.value = `${metaStr}\n\n---\n${currentVal}`;
          } else if (!metaChk.checked && hasSep) {
            const parts = currentVal.split('\n\n---\n');
            if (parts.length > 1) resultText.value = parts.slice(1).join('\n\n---\n');
          }
        }
      });
    }

    // Переключатель «видеть картинку, а не только текст» — живёт отдельно от metaChk:
    // он меняет промпт распознавания, а не состав результата.
    const visionChk = pop.querySelector('.igx-ocr-chk-vision');
    if (visionChk) {
      chrome.storage.local.get([OCR_VISION_KEY]).then((d) => {
        if (d && typeof d[OCR_VISION_KEY] === 'boolean') visionChk.checked = d[OCR_VISION_KEY];
      });
      visionChk.addEventListener('change', () => {
        safeStorageSet({ [OCR_VISION_KEY]: visionChk.checked });
      });
    }

    const apiKeyInput = pop.querySelector('.igx-ocr-apikey-input');
    chrome.storage.local.get([OCR_APIKEY_KEY]).then((d) => {
      if (d && d[OCR_APIKEY_KEY]) apiKeyInput.value = d[OCR_APIKEY_KEY];
    });
    const saveApiKey = () => {
      safeStorageSet({ [OCR_APIKEY_KEY]: apiKeyInput.value.trim() });
    };
    apiKeyInput.addEventListener('input', saveApiKey);
    apiKeyInput.addEventListener('change', saveApiKey);

    const fpsWrap = pop.querySelector('.igx-ocr-fps-wrap');
    const fpsSlider = pop.querySelector('.igx-ocr-fps-slider');
    const fpsLabel = pop.querySelector('.igx-ocr-fps-label');
    const fpsLabels = {
      1: '1 кадр / 2.5 с (быстро)',
      2: '1 кадр / 1.5 с',
      3: '1 кадр / 1.0 с (рекомендуется)',
      4: '2 кадра / с (высокая)',
      5: '3 кадра / с (максимальная)',
    };

    if (fpsSlider) {
      fpsSlider.addEventListener('input', () => {
        const lvl = parseInt(fpsSlider.value, 10) || 3;
        if (fpsLabel) fpsLabel.textContent = fpsLabels[lvl] || '1 кадр / 1.0 с';
        safeStorageSet({ [OCR_VIDEO_FPS_KEY]: lvl });
      });
      chrome.storage.local.get([OCR_VIDEO_FPS_KEY]).then((d) => {
        const lvl = (d && d[OCR_VIDEO_FPS_KEY]) || 3;
        fpsSlider.value = lvl;
        if (fpsLabel) fpsLabel.textContent = fpsLabels[lvl] || '1 кадр / 1.0 с';
      });
    }

    function updateFpsVisibility() {
      const isVideo = igxActiveMediaType === 'video';
      const curMode = (pop.querySelector('input[name="igx-ocr-mode"]:checked')?.value) || 'text';
      if (fpsWrap) {
        fpsWrap.style.display = (isVideo && curMode === 'text') ? 'block' : 'none';
      }
    }

    ['pointerdown', 'mousedown', 'click'].forEach((ev) => {
      pop.addEventListener(ev, (e) => e.stopPropagation());
    });

    const tabVideo = pop.querySelector('.igx-tab-video');
    const tabSlides = pop.querySelector('.igx-tab-slides');

    function setMediaTypeUI(type) {
      igxActiveMediaType = type;
      if (type === 'carousel') {
        tabSlides.classList.add('active');
        tabVideo.classList.remove('active');
        pop.querySelector('.igx-lbl-start').textContent = 'Первые слайды';
        pop.querySelector('.igx-lbl-end').textContent = 'Последние слайды';
        pop.querySelector('.igx-ocr-modes').style.display = 'none';
        pop.querySelector('.igx-ocr-slide-note').style.display = 'block';
        pop.querySelector('.igx-ocr-api-details').style.display = 'block';
        chrome.storage.local.get([OCR_START_SLIDES_KEY, OCR_END_SLIDES_KEY]).then((d) => {
          pop.querySelector('.igx-ocr-start').value = (d && d[OCR_START_SLIDES_KEY] != null) ? d[OCR_START_SLIDES_KEY] : 2;
          pop.querySelector('.igx-ocr-end').value = (d && d[OCR_END_SLIDES_KEY] != null) ? d[OCR_END_SLIDES_KEY] : 2;
        });
      } else {
        tabVideo.classList.add('active');
        tabSlides.classList.remove('active');
        pop.querySelector('.igx-lbl-start').textContent = 'Первые сек';
        pop.querySelector('.igx-lbl-end').textContent = 'Последние сек';
        pop.querySelector('.igx-ocr-modes').style.display = 'flex';
        pop.querySelector('.igx-ocr-slide-note').style.display = 'none';
        pop.querySelector('.igx-ocr-api-details').style.display = 'block';
        chrome.storage.local.get([OCR_START_KEY, OCR_END_KEY]).then((d) => {
          pop.querySelector('.igx-ocr-start').value = (d && d[OCR_START_KEY] != null) ? d[OCR_START_KEY] : 7;
          pop.querySelector('.igx-ocr-end').value = (d && d[OCR_END_KEY] != null) ? d[OCR_END_KEY] : 7;
        });
      }
      updateFpsVisibility();
    }

    tabVideo.addEventListener('click', () => setMediaTypeUI('video'));
    tabSlides.addEventListener('click', () => setMediaTypeUI('carousel'));

    pop.querySelectorAll('input[name="igx-ocr-mode"]').forEach((r) => {
      r.addEventListener('change', () => {
        safeStorageSet({ [OCR_MODE_KEY]: r.value });
        updateFpsVisibility();
      });
    });

    chrome.storage.local.get([OCR_START_KEY, OCR_END_KEY, OCR_MODE_KEY, OCR_VIDEO_FPS_KEY, OCR_INCLUDE_META_KEY]).then((d) => {
      pop.querySelector('.igx-ocr-start').value = (d && d[OCR_START_KEY] != null) ? d[OCR_START_KEY] : 7;
      pop.querySelector('.igx-ocr-end').value = (d && d[OCR_END_KEY] != null) ? d[OCR_END_KEY] : 7;
      if (metaChk && d && typeof d[OCR_INCLUDE_META_KEY] === 'boolean') {
        metaChk.checked = d[OCR_INCLUDE_META_KEY];
      }
      const mode = d[OCR_MODE_KEY] || 'text';
      const radio = pop.querySelector(`input[name="igx-ocr-mode"][value="${mode}"]`);
      if (radio) radio.checked = true;
      const lvl = d[OCR_VIDEO_FPS_KEY] || 3;
      if (fpsSlider) fpsSlider.value = lvl;
      if (fpsLabel) fpsLabel.textContent = fpsLabels[lvl] || '1 кадр / 1.0 с';
      updateFpsVisibility();
    });

    igxOcrPop = pop;
    return pop;
  }

  function ocrClampInt(val, fallback, min = 0) {
    const n = parseInt(val, 10);
    return isNaN(n) || n < min ? fallback : Math.min(n, 60);
  }

  async function openOcrModal(anchorOrType) {
    try {
      const pop = ensureOcrPopup();
      if (!pop) return;

      // Сразу отображаем попап, чтобы не зависеть от асинхронного storage
      pop.style.display = 'flex';
      pop.style.visibility = 'visible';
      pop.style.opacity = '1';
      pop.style.zIndex = '2147483647';
      pop.style.top = '70px';
      pop.style.right = '24px';
      pop.style.left = 'auto';
      pop.style.bottom = 'auto';

      safeStorageGet(['igx_ocr_pos']).then((d) => {
        try {
          if (d && d.igx_ocr_pos && d.igx_ocr_pos.left && d.igx_ocr_pos.top) {
            const leftVal = parseInt(d.igx_ocr_pos.left, 10);
            const topVal = parseInt(d.igx_ocr_pos.top, 10);
            if (!isNaN(leftVal) && !isNaN(topVal)) {
              const maxW = (window.innerWidth || 1000) - 360;
              const maxH = (window.innerHeight || 800) - 300;
              const clampedLeft = Math.max(10, Math.min(maxW, leftVal));
              const clampedTop = Math.max(10, Math.min(maxH, topVal));
              pop.style.left = `${clampedLeft}px`;
              pop.style.top = `${clampedTop}px`;
              pop.style.right = 'auto';
              pop.style.bottom = 'auto';
            }
          }
        } catch (_) {}
      });

      const statusEl = pop.querySelector('.igx-ocr-status');
      const resWrap = pop.querySelector('.igx-ocr-result-wrap');
      if (statusEl) statusEl.textContent = '';
      if (resWrap) resWrap.style.display = 'none';

      let media = null;
      try {
        media = detectCurrentPostMedia();
      } catch (err) {
        console.warn('[Insta OCR] detectCurrentPostMedia warning:', err);
      }

      const explicitType = typeof anchorOrType === 'string' ? anchorOrType : null;
      const type = explicitType || (media && media.type) || igxActiveMediaType || 'video';

      const tabVideo = pop.querySelector('.igx-tab-video');
      const tabSlides = pop.querySelector('.igx-tab-slides');
      if (type === 'carousel' && tabSlides) {
        tabSlides.click();
      } else if (tabVideo) {
        tabVideo.click();
      }
    } catch (err) {
      console.error('[Insta OCR] openOcrModal error:', err);
    }
  }

  function openOcrPopup(anchorOrType) {
    return openOcrModal(anchorOrType);
  }

  async function ocrRun() {
    const pop = igxOcrPop;
    if (!pop) return;
    const statusEl = pop.querySelector('.igx-ocr-status');
    const runBtn = pop.querySelector('.igx-ocr-run');
    const resWrap = pop.querySelector('.igx-ocr-result-wrap');
    const resText = pop.querySelector('.igx-ocr-result-text');
    const metaChk = pop.querySelector('.igx-ocr-chk-meta');
    const includeMeta = metaChk ? metaChk.checked : false;
    const visionChk = pop.querySelector('.igx-ocr-chk-vision');
    const vision = !!(visionChk && visionChk.checked);

    const media = detectCurrentPostMedia();
    // Тип берём с ВИДИМОЙ вкладки попапа, а не из залипшего igxActiveMediaType:
    // раньше при неудачном определении медиа (media === null) оставалось прежнее
    // значение 'video' — и на карусели запускалась видео-ветка с перемоткой.
    const tabSlidesActive = !!pop.querySelector('.igx-tab-slides.active');
    const activeType = tabSlidesActive
      ? 'carousel'
      : ((media && media.type) || igxActiveMediaType || 'video');

    // Пользователь нажал «Извлечь» — значит читать будем в любом случае: первый кадр
    // на холодной локальной модели платит именно здесь, а не таймаутом в середине.
    const warmKey = ((await safeStorageGet([OCR_APIKEY_KEY])) || {})[OCR_APIKEY_KEY] || '';
    await igxLocalWarmIfNeeded(warmKey, (t) => {
      if (statusEl) statusEl.textContent = t;
    }, true);

    if (activeType === 'carousel') {
      // В этом режиме НИ ОДНО обращение к currentTime/play/pause не выполняется:
      // перемотка видео здесь запрещена, листаются только слайды.
      const startCount = ocrClampInt(pop.querySelector('.igx-ocr-start').value, 2, 0);
      const endCount = ocrClampInt(pop.querySelector('.igx-ocr-end').value, 2, 0);
      safeStorageSet({ [OCR_START_SLIDES_KEY]: startCount, [OCR_END_SLIDES_KEY]: endCount });

      const storedKey = await chrome.storage.local.get(OCR_APIKEY_KEY);
      const apiKey = (storedKey && storedKey[OCR_APIKEY_KEY]) || '';

      // Одиночное фото (ни слайдов, ни видео): ветка карусели на нём только бессмысленно
      // кликала бы по пустоте. Один снимок — один запрос.
      if (!media) {
        const photo = igxPaDetectPhoto();
        if (photo) {
          runBtn.disabled = true;
          try {
            if (statusEl) statusEl.textContent = 'Распознаю фото…';
            const clean = await igxOcrSinglePhoto(photo, apiKey, vision);
            let photoBody = `Хук:\n${clean || '(текста нет или распознать не удалось)'}` + igxOcrNotesLine();
            if (vision && !igxVisionWorks(apiKey)) {
              photoBody += '\n\n(⚠ описание картинок недоступно: нужна нейронка — облачный ключ или локальная модель)';
            }
            let photoResult = photoBody;
            if (includeMeta) {
              const postMeta = extractInstagramPostData(photo.scope || findPostArticle() || document);
              const metaStr = formatPostDataText(postMeta);
              if (metaStr) photoResult = `${metaStr}\n\n---\n${photoBody}`;
            }
            if (resText && resWrap) {
              resText.value = photoResult;
              resWrap.style.display = 'block';
            }
            const okPhoto = await copyToClipboard(photoResult);
            statusEl.textContent = okPhoto
              ? '✓ Скопировано в буфер обмена!'
              : 'Текст извлечён! Нажми «📋 Скопировать» ниже.';
          } catch (err) {
            statusEl.textContent = String((err && err.message) || err);
          } finally {
            runBtn.disabled = false;
          }
          return;
        }
      }

      runBtn.disabled = true;
      try {
        const { actualTotal, warnings, headSlides, tailSlides, headText, tailText } = await extractCarouselSlides(
          media || { scope: document },
          startCount,
          endCount,
          apiKey,
          statusEl,
          vision
        );

        // Честный отчёт: сколько слайдов реально удалось захватить и где встали
        const warnList = Array.isArray(warnings) ? warnings : [];
        const warnLine = warnList.length ? `\n\n(⚠ ${warnList.join('; ')})` : '';
        const ocrBody = `Хук:\n${headText}\n\nПризыв:\n${tailText}${warnLine}`;
        let fullResult = ocrBody;
        if (includeMeta) {
          const postMeta = extractInstagramPostData((media && media.scope) || findPostArticle() || document);
          const metaStr = formatPostDataText(postMeta);
          if (metaStr) fullResult = `${metaStr}\n\n---\n${ocrBody}`;
        }

        if (resText && resWrap) {
          resText.value = fullResult;
          resWrap.style.display = 'block';
        }

        const ok = await copyToClipboard(fullResult);
        statusEl.textContent = ok
          ? (warnList.length
            ? `✓ Скопировано. Захвачено слайдов: ${actualTotal} — ⚠ ${warnList[warnList.length - 1]}`
            : '✓ Скопировано в буфер обмена!')
          : (warnList.length ? `Текст извлечён (⚠ ${warnList.join('; ')})` : 'Текст извлечён! Нажми «📋 Скопировать» ниже.');
      } catch (err) {
        statusEl.textContent = String((err && err.message) || err);
      } finally {
        runBtn.disabled = false;
      }
      return;
    }

    const video = (media && media.video) || pickBestVideo();
    if (!video) {
      statusEl.textContent = 'На экране нет видео — открой рилс/видео или переключи на вкладку «Слайды».';
      return;
    }
    const d = video.duration;
    if (!isFinite(d) || d <= 0.5) {
      statusEl.textContent = 'У этого видео нет длины (эфир или ещё грузится).';
      return;
    }

    const startSec = ocrClampInt(pop.querySelector('.igx-ocr-start').value, 7, 0);
    const endSec = ocrClampInt(pop.querySelector('.igx-ocr-end').value, 7, 0);
    const modeRadio = pop.querySelector('input[name="igx-ocr-mode"]:checked');
    const mode = modeRadio ? modeRadio.value : 'text';
    safeStorageSet({ [OCR_START_KEY]: startSec, [OCR_END_KEY]: endSec, [OCR_MODE_KEY]: mode });

    const storedData = await chrome.storage.local.get([OCR_APIKEY_KEY, OCR_VIDEO_FPS_KEY]);
    const apiKey = (storedData && storedData[OCR_APIKEY_KEY]) || '';
    const fpsLevel = (storedData && storedData[OCR_VIDEO_FPS_KEY]) || 3;
    // Локальная распознавалка (Tesseract) картинки не описывает — честное предупреждение
    // вместо молчаливого «галочка стоит, а описания нет».
    let visionNote = '';
    if (vision && mode === 'text' && !igxVisionWorks(apiKey)) {
      visionNote = '\n\n(⚠ описание картинок недоступно — читает только Tesseract, текст распознан локально)';
    }

    runBtn.disabled = true;
    const wasPlaying = !video.paused;
    const prevTime = video.currentTime;

    try {
      // ОБЯЗАТЕЛЬНО ставим видео на паузу перед анализом, чтобы плеер Instagram
      // не зацикливался и не сбрасывал currentTime в 0:00!
      try { video.pause(); } catch (_) {}

      const { headTo, tailFrom, tailTo } = getVideoWindows(d, startSec, endSec);
      let headText = '';
      let tailText = '';

      const directUrl = findVideoUrl(video);

      if (mode === 'audio') {
        let asrSuccess = false;
        if (directUrl) {
          try {
            statusEl.textContent = apiKey ? 'Распознаю речь через Cloud API…' : 'Распознаю речь (прямая загрузка аудио)…';
            const asrRes = await asrRecognizeUrl(directUrl, headTo, tailFrom, tailTo, apiKey);
            headText = asrRes.headText;
            tailText = asrRes.tailText;
            asrSuccess = true;
          } catch (e) {
            console.warn('Прямое извлечение аудио не удалось, переключаюсь на запись из плеера:', e);
          }
        }
        if (!asrSuccess) {
          statusEl.textContent = `Записываю звук хука (0–${headTo.toFixed(1)} с)…`;
          const headB64 = await blobToBase64(await recordRange(video, 0, headTo));
          statusEl.textContent = `Записываю звук призыва (${tailFrom.toFixed(1)}–${tailTo.toFixed(1)} с)…`;
          const tailB64 = await blobToBase64(await recordRange(video, tailFrom, tailTo));
          statusEl.textContent = apiKey ? 'Распознаю речь хука (Cloud API)…' : 'Распознаю речь хука (Whisper)…';
          headText = await asrRecognize(headB64, apiKey);
          statusEl.textContent = apiKey ? 'Распознаю речь призыва (Cloud API)…' : 'Распознаю речь призыва (Whisper)…';
          tailText = await asrRecognize(tailB64, apiKey);
        }
      } else {
        // Текст с экрана: пробуем прямое извлечение кадров из MP4 без оверлеев Instagram
        let directOcrSuccess = false;
        if (directUrl) {
          try {
            statusEl.textContent = apiKey ? 'Распознаю текст видео через прямой поток (Vision AI)…' : 'Распознаю текст видео через прямой поток…';
            const headTs = getRangeTimestamps(0, headTo, fpsLevel);
            const tailTs = getRangeTimestamps(tailFrom, tailTo, fpsLevel);
            const directRes = await ocrVideoDirect(directUrl, headTs, tailTs, apiKey, vision);
            if (directRes && (directRes.headText || directRes.tailText)) {
              headText = compactOcrText(directRes.headText);
              tailText = compactOcrText(directRes.tailText);
              directOcrSuccess = true;
            }
          } catch (e) {
            console.warn('Прямое OCR видео не удалось, переключаюсь на захват кадров из вкладки:', e);
          }
        }

        if (!directOcrSuccess) {
          statusEl.textContent = apiKey ? 'Снимаю кадры видео и распознаю текст (Vision AI)…' : 'Снимаю кадры видео и распознаю текст…';
          const headFrames = await captureRange(video, 0, headTo, fpsLevel, statusEl, 'начала');
          const tailFrames = await captureRange(video, tailFrom, tailTo, fpsLevel, statusEl, 'конца');

          headText = compactOcrText(await ocrFrames(headFrames, apiKey, statusEl, 'хука', vision));
          tailText = compactOcrText(await ocrFrames(tailFrames, apiKey, statusEl, 'призыва', vision));

          // Если OCR не нашёл текст на кадрах, проверяем встроенные DOM-субтитры Instagram
          if (!headText) {
            const domSub = findReelsCaptionText(media ? media.scope : document);
            if (domSub) headText = domSub;
          }
        }
      }

      const hookFormatted = headTo <= 0 ? '(не выбрано)' : (headText || '(текст на видео не найден)');
      const ctaFormatted = tailFrom >= tailTo ? '(не выбрано)' : (tailText || '(текст на видео не найден)');
      const ocrBody = `Хук:\n${hookFormatted}\n\nПризыв:\n${ctaFormatted}`;
      let fullResult = ocrBody + visionNote + igxOcrNotesLine();

      if (includeMeta) {
        const postMeta = extractInstagramPostData((media && media.scope) || findPostArticle() || document);
        const metaStr = formatPostDataText(postMeta);
        if (metaStr) fullResult = `${metaStr}\n\n---\n${ocrBody}`;
      }

      if (resText && resWrap) {
        resText.value = fullResult;
        resWrap.style.display = 'block';
      }

      const ok = await copyToClipboard(fullResult);
      statusEl.textContent = ok
        ? '✓ Скопировано в буфер обмена!'
        : 'Текст извлечён! Нажми «📋 Скопировать» ниже.';
    } catch (err) {
      statusEl.textContent = String((err && err.message) || err);
    } finally {
      try {
        video.currentTime = prevTime;
      } catch (_) {}
      if (wasPlaying) {
        video.play().catch(() => {});
      } else {
        try {
          video.pause();
        } catch (_) {}
      }
      runBtn.disabled = false;
    }
  }

  // ---------- АНАЛИЗАТОР ПРОФИЛЯ (плавающее меню на «голой» странице профиля) ----------
  // Меню появляется ТОЛЬКО когда открыт профиль эксперта целиком (не внутри чужого
  // поста/рилса). По нажатию собирает: шапку (ник, @юзер, био, числа, TG из базы),
  // закреплённые посты и последние N публикаций. Для каждой публикации определяет
  // формат (видео/карусель/фото), длительность или число слайдов, метрики и — по
  // настройкам — транскрипцию (текст с кадров/слайдов и речь из звука). Итог — один
  // большой текст в поле результата и в буфере обмена. Разбор идёт по клику вручную,
  // вкладка активна, поэтому тяжёлый OCR/ASR работает так же, как в попапе «Хук».

  const PA_COUNT_KEY = 'igx_pa_count';
  const PA_SETTINGS_KEY = 'igx_pa_settings';
  const PA_POS_KEY = 'igx_pa_pos';
  // Автоанализ по кнопке ② дашборда. Очередь автостарта — копия механизма АФК
  // (TTL + прунинг), потому что грабли были ровно те же: осиротевшая запись
  // запускала разбор на профиле, который человек открыл сам.
  const PA_AUTOSTART_KEY = 'igx_pa_autostart';
  const PA_JOB_PREFIX = 'igx_paa_job:'; // джоб = ОДИН ключ, а не массив: два писателя
  const PAA_SEND_KEY = 'igx_paa_send';  // галка «слать разбор в Telegram» у кнопки ②
  const PA_AUTOSTART_TTL_MS = 90 * 1000;
  let igxPaPop = null;
  let igxPaRunning = false;
  let igxPaDismissedFor = null;
  let _paWakeLock = null;        // sentinel navigator.wakeLock на время авторазбора
  let _paWakeVisHandler = null;  // пересъём лока при возврате видимости
  let _paWakeBlocked = false;    // сайт запретил screen-wake-lock — не пробуем и не спамим
  let _paKeepCtx = null;          // «неслышимый аудиоякоръ» — AudioContext
  let _paKeepNodes = null;        // { osc, gain } якоря
  let _paKeepUnlock = null;       // слушатель первого жеста для сьемки якоря с суспенда
  let _paGuardOn = false;        // «🛡 анти-залипание видео» для текущего разбора
  let _paGuardLastFocus = 0;     // троттлинг попыток поднять окно наверх

  // ---------- ручное «дополнение к разбору» по горячей клавише ----------
  // Пока нейронка разбирает профиль, по настроенной комбинации открывается поле, куда
  // человек вписывает то, что ИИ не увидела. Заметка уходит в САМЫЙ КОНЕЦ разбора — и в
  // Telegram (автоанализ), и в буфер/поле результата (ручной разбор).
  const PA_NOTEKEY_KEY = 'igx_pa_notekey'; // напр. 'alt+keyn'; '' — выключено
  let igxPaNotes = [];             // [{ text, at }] — отправленные заметки текущего профиля
  let igxPaNotePop = null;         // плавающее поле заметки: ОТДЕЛЬНО от панели — не слетает при сворачивании видео и перерисовках
  let igxPaNoteKey = '';           // настроенная комбинация (приведённая, как из igxPaComboFromEvent)
  let _igxPaNoteCapturing = false; // в панели идёт запись новой клавиши (следующее нажатие = значение)
  let _paReportShown = false;      // разбор уже собран/показан → новые заметки дописываем «поверх» готового
  let _paNoteUser = null;          // профиль, к которому относятся igxPaNotes (при смене — чистим)
  let igxPaCurRun = null;          // контекст прогона: { username, jobId, auto, finished, notesSent }

  // Держит экран/систему awake на время авторазбора профиля: navigator.wakeLock
  // 'screen' не даёт Windows по таймеру бездействия погасить экран / отправить ПК в сон,
  // из-за чего встаёт снимок вкладки и декод видео. Пока вкладка видима — лок активен;
  // при уходе в фон Chrome сам снимает лок, поэтому на 'visibilitychange' переснимаем,
  // когда снова стали видимы. (Свёрнутое/полностью перекрытое окно всё равно hidden —
  // лок там не держится; это ограничение браузера, не нашего кода.)
  async function igxAcquireWakeLock() {
    let ok = false;
    try { ok = ('wakeLock' in navigator) && navigator.wakeLock && typeof navigator.wakeLock.request === 'function'; } catch (_) { ok = false; }
    if (!ok) return;
    const take = async () => {
      if (_paWakeBlocked) return; // уже узнали, что запрещено — не дёргаем и не шумим
      try {
        if (_paWakeLock && _paWakeLock.type !== 'released') return; // уже держим
        // Instagram (и часть сайтов) запрещает screen-wake-lock через Permissions-Policy:
        // тогда navigator.wakeLock.request() отклоняется И шумит в консоль «violation».
        // Сперва тихо спрашиваем разрешение (query не плодит нарушений) — если denied,
        // помечаем как заблокированное и больше не пробуем вовсе.
        try {
          if (navigator.permissions && navigator.permissions.query) {
            const p = await navigator.permissions.query({ name: 'screen-wake-lock' });
            if (p && p.state === 'denied') { _paWakeBlocked = true; return; }
          }
        } catch (_) {}
        const s = await navigator.wakeLock.request('screen');
        _paWakeLock = s;
        s.addEventListener('release', () => { if (_paWakeLock === s) _paWakeLock = null; }, { once: true });
      } catch (_) {
        // Отказ запроса (в т.ч. permissions-policy) = считаем заблокированным, чтобы
        // не долбить request на каждом visibilitychange и не забивать консоль.
        _paWakeBlocked = true;
      }
    };
    await take();
    if (!_paWakeVisHandler) {
      _paWakeVisHandler = () => { if (document.visibilityState === 'visible') take(); };
      document.addEventListener('visibilitychange', _paWakeVisHandler);
    }
  }
  function igxReleaseWakeLock() {
    try {
      if (_paWakeVisHandler) { document.removeEventListener('visibilitychange', _paWakeVisHandler); _paWakeVisHandler = null; }
    } catch (_) {}
    try { if (_paWakeLock) _paWakeLock.release().catch(() => {}); } catch (_) {}
    _paWakeLock = null;
  }

  // «Неслышимый аудиоякорь». Пока идет разбор, вкладка тихо играет почти неслышный
  // низкочастотный тон. Chrome считает вкладку «производящей звук», поэтому:
  //   · не режет её таймеры в фоне (фоновый троттлинг/заморозка);   · не замораживает вкладку;
  //   · видео продолжает декодироваться даже в фоне/с погашенным экраном.
  // Запуск требует жеста (autoplay-политика): если контекст остался suspended —
  // висит одноразовый слушатель и якорь стартует с первым же кликом/клавишей. При
  // высоком Media Engagement Index для Instagram (ты им постоянно пользуешься) often
  // стартует сразу. Если не вышло — тихо, без звука и без вреда.
  async function igxStartAudioKeepAlive() {
    try {
      if (_paKeepCtx || _paKeepUnlock) return; // уже играет или уже ждём жест
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const detachUnlock = () => {
        if (!_paKeepUnlock) return;
        try { window.removeEventListener('pointerdown', _paKeepUnlock); } catch (_) {}
        try { window.removeEventListener('keydown', _paKeepUnlock); } catch (_) {}
        _paKeepUnlock = null;
      };
      const spawn = () => {
        // ВАЖНО: контекст создаётся СТРОГО внутри жеста пользователя (или когда
        // sticky-активация уже есть). Иначе Chrome на каждый разбор сыплет в консоль
        // «The AudioContext was not allowed to start», а пользы ноль — контекст всё
        // равно остаётся suspended и тишина не считается «игрой звука». Поэтому без
        // жеста вообще не создаём контекст — просто слушаем первый клик/клавишу.
        try {
          if (_paKeepCtx) { detachUnlock(); return; }
          // Пропускаем СИНТЕТИЧЕСКИЕ pointerdown/keydown от нашего же авто-разбора:
          // слушатель на них срабатывает, но user activation они НЕ дают → new AudioContext
          // остался бы suspended и Chrome сыпал бы «The AudioContext was not allowed to
          // start» на каждое такое событие. Ждём НАСТОЯЩЕЕ касание/клавишу (transient
          // activation); нет её — просто продолжаем слушать дальше (не открепляемся).
          const uax = navigator.userActivation;
          if (uax && uax.isActive === false) return;
          const ctx = new AC();
          ctx.resume().catch(() => {});
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          gain.gain.value = 0.0006;         // почти неслышно
          osc.type = 'sine';
          osc.frequency.value = 37;         // очень низкий тон
          osc.connect(gain); gain.connect(ctx.destination);
          try { osc.start(); } catch (_) {}
          _paKeepCtx = ctx; _paKeepNodes = { osc, gain };
        } catch (_) {}
        detachUnlock();
      };
      const ua = navigator.userActivation;
      // Контекст создаём ТОЛЬКО внутри реального жеста (pointerdown/keydown): Chrome
      // печатает «The AudioContext was not allowed to start» уже на создание вне жеста,
      // даже если sticky-активация (hasBeenActive) уже есть. Поэтому НЕ спавним сразу —
      // вешаем одноразовый слушатель, якорь заведётся с первым кликом/клавишей уже чисто.
      // Фоновые авто-окна (жеста нет) якорь не ловят — но и раньше не ловили: контекст у
      // них оставался suspended. Ничего не теряем, минус мусор в консоли.
      _paKeepUnlock = spawn;
      window.addEventListener('pointerdown', _paKeepUnlock, { passive: true });
      window.addEventListener('keydown', _paKeepUnlock, { passive: true });
      void ua;
    } catch (_) {}
  }
  function igxStopAudioKeepAlive() {
    try {
      if (_paKeepUnlock) {
        try { window.removeEventListener('pointerdown', _paKeepUnlock); } catch (_) {}
        try { window.removeEventListener('keydown', _paKeepUnlock); } catch (_) {}
        _paKeepUnlock = null;
      }
      if (_paKeepNodes) { try { _paKeepNodes.osc.stop(); } catch (_) {} try { _paKeepNodes.gain.disconnect(); } catch (_) {} }
      if (_paKeepCtx) { try { _paKeepCtx.close(); } catch (_) {} }
    } catch (_) {}
    _paKeepNodes = null; _paKeepCtx = null;
  }

  // Забрать (и удалить) свежую запись автозапуска для профиля. Протухшую не берём
  // никогда: возраст — единственное, чем она отличается от «пользователь сам открыл».
  // tabId — второй замок: запись принадлежит конкретной вкладке, которую открыл
  // дашборд. Без него разбор начинался бы на профиле, который человек открыл сам.
  async function paTakeAutostart(username, tabId) {
    let q = [];
    try {
      const d = await chrome.storage.local.get(PA_AUTOSTART_KEY);
      if (Array.isArray(d[PA_AUTOSTART_KEY])) q = d[PA_AUTOSTART_KEY];
    } catch (_) {}
    const low = String(username || '').toLowerCase();
    const now = Date.now();
    let pruned = false;
    const fresh = q.filter((e) => {
      const ok = !!e && typeof e.ts === 'number' && now - e.ts <= PA_AUTOSTART_TTL_MS;
      if (!ok) pruned = true;
      return ok;
    });
    const mine = Number(tabId);
    const idx = fresh.findIndex((e) => e.username && String(e.username).toLowerCase() === low && Number(e.tabId) === mine);
    if (idx === -1) {
      if (pruned) { try { await chrome.storage.local.set({ [PA_AUTOSTART_KEY]: fresh }); } catch (_) {} }
      return null;
    }
    const [entry] = fresh.splice(idx, 1);
    try { await chrome.storage.local.set({ [PA_AUTOSTART_KEY]: fresh }); } catch (_) {}
    return entry;
  }

  async function paPruneAutostart() {
    let q = [];
    try {
      const d = await chrome.storage.local.get(PA_AUTOSTART_KEY);
      if (Array.isArray(d[PA_AUTOSTART_KEY])) q = d[PA_AUTOSTART_KEY];
    } catch (_) { return; }
    const now = Date.now();
    const fresh = q.filter((e) => !!e && typeof e.ts === 'number' && now - e.ts <= PA_AUTOSTART_TTL_MS);
    if (fresh.length !== q.length) {
      try { await chrome.storage.local.set({ [PA_AUTOSTART_KEY]: fresh }); } catch (_) {}
    }
  }

  // Допиписать джоб. Ключ один на job, пишет его дашборд при старте и вкладка при
  // финале — поэтому никакой агрегации в массив, где две записи перетёрли бы друг друга.
  async function paJobPatch(jobId, patch) {
    const id = String(jobId || '');
    if (!id) return;
    const key = PA_JOB_PREFIX + id;
    try {
      const d = await chrome.storage.local.get(key);
      const cur = (d && d[key]) || { id, startedAt: Date.now() };
      await chrome.storage.local.set({ [key]: Object.assign({}, cur, patch) });
    } catch (_) {}
  }

  function igxPaOnBareProfile() {
    return !!extractUsername(location.pathname);
  }
  function igxPaModalOpen() {
    // Считаем модалку открытой ТОЛЬКО если она реальна видима: Instagram после закрытия
    // списка/поста иногда оставляет в DOM скрытый [role="dialog"] — из-за него меню анализа
    // «навсегда» пряталось на нормальном профиле.
    const dialogs = document.querySelectorAll('[role="dialog"]');
    for (const d of dialogs) {
      if (d.closest && d.closest('.igx-pa-pop, .igx-afk-pop, .igx-side-panel, .igx-tooltip, .igx-link-menu')) continue;
      let cs;
      try { cs = getComputedStyle(d); } catch (_) { continue; }
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const r = d.getBoundingClientRect();
      if (r.width > 120 && r.height > 120) return true;
    }
    return false;
  }
  function igxPaFmtTime(sec) {
    if (!isFinite(sec) || sec <= 0) return 'нет';
    const s = Math.round(sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function igxPaSetStatus(el, txt) {
    if (el) el.textContent = txt;
  }

  // «Актуальные» (highlight-обложки под шапкой профиля). Названия ТОЛЬКО читаем из
  // DOM — сами обложки не открываем и не чекаем, это лишние клики и лишний трафик.
  // Сигналов несколько (ссылки /stories/highlights/, подпись рядом с <canvas>-
  // обложкой, aria-label карточки): один селектор на другой вёрстке слепнет,
  // поэтому склеиваем всё, что нашли, без дублей.
  function igxCollectHighlights() {
    const titles = [];
    const seen = new Set();
    let covers = 0;
    const add = (raw) => {
      let s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
      if (!s) return;
      // [а-яё] обязательно: \w не знает кириллицы, и «Актуальное: Рецепты» не чистилось.
      // Инста в aria-label кладёт глагол впереди: «Смотреть актуальное: Рецепты» — без
      // этого префикса строка не совпадала с подписью-испанкой «Рецепты» и дублировалась.
      s = s.replace(/^(?:(?:смотр\w*|просмотр\w*|смотреть|просмотреть)\s+)?(?:актуальн[а-яё\w]*|highlights?|истори[а-яё\w]*)\s*[:—-]\s*/i, '').trim();
      if (s.length < 2 || s.length > 40) return;
      if (/^(?:ещ[её]|more|создать|new|add|просмотреть\s+все)$/i.test(s)) return;
      if (/^[\d\s.,kKmM\u00a0]*$/.test(s)) return; // счётчик, не название
      const k = s.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      titles.push(s);
    };
    // Обложки актуалок стоят рядом с био (в <header>) — подписи постов в сетке
    // отсекаем по ссылке-обёртке, иначе в список полезла бы вся лента.
    const scope = document.querySelector('header') || document.querySelector('main') || document;
    const isTileCover = (el) =>
      !!(el.closest && (el.closest('a[href*="/p/"]') || el.closest('a[href*="/reel/"]') || el.closest('a[href*="/tv/"]')));
    try {
      Array.from(scope.querySelectorAll('a[href*="/stories/highlights/"]')).forEach((a) => {
        add(a.getAttribute('aria-label') || a.getAttribute('title'));
        const sp = a.querySelector('span[title]');
        if (sp) add(sp.getAttribute('title'));
      });
    } catch (_) {}
    const shortLabel = (box, cover) => {
      let best = '';
      Array.from(box.querySelectorAll('span, div, p')).forEach((el) => {
        if (el === box || (cover && cover.contains(el))) return;
        if (el.querySelector('canvas, img, video, svg')) return; // это контейнер, не подпись
        const t = String(el.getAttribute('title') || el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 40) return;
        if (!best || t.length < best.length) best = t;
      });
      return best;
    };
    try {
      Array.from(scope.querySelectorAll('canvas')).forEach((cv) => {
        if (isTileCover(cv)) return;
        covers++;
        let box = cv.parentElement;
        for (let up = 0; up < 5 && box; up++) {
          // Поднимаемся только внутри ОДНОЙ карточки: контейнер с несколькими
          // обложками — это уже весь ряд, а «самая короткая подпись» в нём была бы
          // одна на все обложки, и дедупликация оставила бы ровно одно название.
          if (box.querySelectorAll('canvas').length > 1) break;
          const t = shortLabel(box, cv);
          if (t) { add(t); return; }
          box = box.parentElement;
        }
      });
    } catch (_) {}
    // Вёрстка без индивидуальных обёрток: обложки и подписи — соседние дети одного
    // ряда. Проходим по детям в порядке DOM: «canvas → ближайший текст после него».
    if (!titles.length && covers) {
      try {
        const list = Array.from(scope.querySelectorAll('canvas')).filter((c) => !isTileCover(c));
        const row = list.length ? list[0].parentElement : null;
        if (row && row.querySelectorAll('canvas').length > 1) {
          let pending = false;
          Array.from(row.children).forEach((child) => {
            if (child.tagName === 'CANVAS') { pending = true; return; }
            if (!pending) return;
            pending = false;
            add(child.getAttribute('title') || child.innerText);
          });
        }
      } catch (_) {}
    }
    return { titles: titles.slice(0, 40), covers };
  }

  // Шапка профиля: имя, @юзер, био, числа. Числа — из шапки, резерв — из
  // <meta name="description"> («N Followers, M Following, K Posts»).
  function igxPaCollectHeader(username) {
    const out = { username, fullName: '', bio: '', followers: null, following: null, posts: null, telegram: '', highlights: [], highlightCovers: 0 };
    const header = document.querySelector('header') || document.querySelector('main');
    const hl = igxCollectHighlights();
    out.highlights = hl.titles;
    out.highlightCovers = hl.covers;
    if (header) {
      const nameEl = header.querySelector('h2, h1');
      if (nameEl) out.fullName = nameEl.textContent.trim();
    }
    // Био — самый «взрослый» текстовый блок шапки. Отбрасываем: чисто-числовые
    // подписи-счётчики, слишком короткие строки (имя/юз) и мега-обёртки, в которые
    // Instagram складывает сразу имя + @юзер + счётчики + био одним текстом (иначе в
    // «Bio» попадал мусор вида «123 подписчика»).
    if (header) {
      const STAT_RE = /подписч|подписк|follower|following|публ|публикац|\bposts?\b|записей|отметк/i;
      // Подписи обложек «Актуальные» живут в том же <header>, и самый длинный блок
      // шапки оказывался склейкой всех названий — настоящее био всегда короче.
      const hlHits = (t) => hl.titles.reduce((n, x) => n + (t.indexOf(x) !== -1 ? 1 : 0), 0);
      const blocks = Array.from(header.querySelectorAll('span, div'))
        .map((el) => igxNormalizeText(el.innerText || ''))
        .filter(
          (t) =>
            t.length > 12 &&
            t.length < 2000 &&
            !/^[\d\s.,:;()'"\u2013\u2014[\]]*(?:тыс[а-яё]*|млн|млрд|k|m|b)?\.?$/i.test(t) &&
            t !== out.fullName &&
            !STAT_RE.test(t) &&
            hlHits(t) < 2
        );
      blocks.sort((a, b) => b.length - a.length);
      if (blocks[0]) out.bio = blocks[0];
    }
    const numFromLabel = (re) => {
      const cands = Array.from(document.querySelectorAll('header li, header span, header a, main li, main span, main a'))
        .filter((el) => re.test(el.textContent || ''));
      if (!cands.length) return null;
      cands.sort((a, b) => a.textContent.length - b.textContent.length);
      const el = cands[0];
      const nEl = el.querySelector('span[title]') || el.querySelector('span') || el;
      return parseCount((nEl.getAttribute && nEl.getAttribute('title')) || nEl.textContent);
    };
    out.followers = numFromLabel(/подписч|follower/i);
    out.following = numFromLabel(/подписк|following/i);
    out.posts = numFromLabel(/публ|публикац|posts|записей|постов/i);
    const md = document.querySelector('meta[name="description"]');
    if (md) {
      const c = md.getAttribute('content') || '';
      const mf = c.match(/([\d.,kKmM]+)\s*(?:followers|подписчик)/i);
      const mg = c.match(/([\d.,kKmM]+)\s*(?:following|подписк)/i);
      const mp = c.match(/([\d.,kKmM]+)\s*(?:posts|публ|записей)/i);
      if (out.followers == null && mf) out.followers = parseCount(mf[1]);
      if (out.following == null && mg) out.following = parseCount(mg[1]);
      if (out.posts == null && mp) out.posts = parseCount(mp[1]);
    }
    try {
      const rec = profileCache.get(String(username).toLowerCase());
      if (rec && rec.telegram) out.telegram = rec.telegram;
    } catch (_) {}
    return out;
  }

  function igxPaHeaderBlock(h, st) {
    const num = (v) => (v != null && isFinite(v) ? v.toLocaleString('ru-RU') : 'нет');
    const L = [];
    L.push('🔎 РАЗБОР ПРОФИЛЯ');
    // Отпечаток настроек прогона: блоки «В ЗАКРЕПАХ»/«ТИП КОНТЕНТА» добавляются
    // ТОЛЬКО при включённых галках, и без этой строки нечем доказать, что прогон
    // шёл с выключенными — пользователи принимают «блока нет» за «галка не работает».
    if (st) {
      const yn = (b) => (b ? '✓' : '✗');
      L.push('Режим прогона: метр ' + yn(st.doMeta) + ' · vision ' + yn(st.doVision) + ' · 🖼 ' + yn(st.videoPreview) + ' · 🧬 ' + yn(st.frameFormat) + ' · 📌 ' + yn(st.pinScan) + ' · 🎭 ' + yn(st.contentAudit) + ' · постов ' + (st.count || '—') + (st.contentAudit ? ' · аудит ' + (st.auditPosts || '—') : ''));
    }
    // Не «Ник»: модель читает эту строку как «имя лида». Подпись в шапке — это то, как
    // аккаунт назван в Instagram, обращаться по ней нельзя (имя решает igxPaNameBlock).
    L.push(`Подпись в шапке IG (не имя для обращения): ${h.fullName || '—'}`);
    L.push(`Юзер: @${h.username}`);
    L.push(`Подписчиков: ${num(h.followers)} · Подписок: ${num(h.following)} · Постов: ${num(h.posts)}`);
    if (h.telegram) L.push(`Telegram (из базы): ${h.telegram}`);
    L.push(`Bio:\n${h.bio || '(не удалось считать)'}`);
    // «Актуальные» — только названия обложек, сами обложки не открываем.
    if (h.highlights && h.highlights.length) {
      L.push('═══ АКТУАЛЬНЫЕ ═══\n' + h.highlights.map((t, i) => `${i + 1}. ${t}`).join('\n'));
    } else if (h.highlightCovers) {
      // Обложки видим, а прочитать не смогли: говорим как есть, а не молчим.
      L.push(`═══ АКТУАЛЬНЫЕ ═══\n(обложек: ${h.highlightCovers}, названия считать не удалось)`);
    }
    return L.join('\n');
  }

  // Тайлы сетки профиля: порядок = как в Instagram (сначала закрепы, затем по свежести).
  function igxPaCollectTiles() {
    const main = document.querySelector('main') || document;
    const links = Array.from(main.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]'));
    const seen = new Set();
    const tiles = [];
    for (const a of links) {
      const href = (a.getAttribute('href') || a.href || '').split('?')[0];
      const m = href.match(/\/(?:p|reel|tv)\/([^/?]+)/i);
      if (!m) continue;
      const code = m[1];
      if (seen.has(code)) continue;
      seen.add(code);
      // /reel/ и /tv/ — видео, /p/ — фото/карусель. Флаг нужен не только для разбора,
      // но и для штампа в профиле: шторка уведомлений по нему отличает «просмотрено
      // N видео» от «аккаунт разобран полностью».
      // days — возраст тайла из сетки: нужен для распознавания закрепов ПО ПОРЯДКУ,
      // независимо от галки «метрики» и от того, открылся ли пост вообще.
      tiles.push({ code, el: a, vid: /\/(?:reel|tv)\//i.test(href), pinned: igxPaTilePinned(a), days: igxPaTileAgeDays(a), pinOrder: false });
    }
    return tiles;
  }

  // Маркеры закрепа. Разные локали Instagram подписывают по-разному, поэтому берём
  // и русское «закреп…», и английские варианты («Pinned», «Pin to top»).
  // Строго с НАЧАЛА строки: иначе любое короткое описание поста со словами
  // «отзывы в закреп» объявлялось бы закреплённым.
  const IGX_PIN_MARK = /^(закреп|pinned?\b|pin to top|angeheft|épingl|fissat|fijado)/i;

  // Короткие подписи элемента: метки доступности (aria-label/title), <title> внутри svg
  // и текст-чипы. Именно так выглядит плашка закрепа. ВАЖНО: alt у картинок НЕ берём —
  // в него Instagram кладёт полный текст подписи поста, а слова «закреп» в описаниях
  // встречаются сплошь и рядом (как и в bio), иначе закрепом считался бы любой пост.
  function igxPaShortLabels(root, limit, maxTextLen) {
    const out = [];
    if (!root || !root.querySelectorAll) return out;
    const capA = 70;
    const capT = maxTextLen || 26;
    const push = (s) => {
      const t = igxNormalizeText(String(s || ''));
      if (t && t.length <= capA && !out.includes(t)) out.push(t);
    };
    let scanned = 0;
    root.querySelectorAll('[aria-label], [title]').forEach((n) => {
      if (out.length >= (limit || 14) || ++scanned > 400) return;
      push(n.getAttribute('aria-label'));
      push(n.getAttribute('title'));
    });
    root.querySelectorAll('svg title').forEach((t) => {
      if (out.length >= (limit || 14)) return;
      push(t.textContent);
    });
    // Значок закрепа в сетке — часто просто иконка из спрайта без всякой подписи:
    // тогда о ней говорит имя символа (#pinned, #pin-to-top).
    root.querySelectorAll('svg use, use').forEach((u) => {
      if (out.length >= (limit || 14)) return;
      const h = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
      if (h && h.includes('#')) push(String(h).split('#').pop());
    });
    scanned = 0;
    root.querySelectorAll('span, div').forEach((n) => {
      if (out.length >= (limit || 14) || ++scanned > 400) return;
      if (n.children.length) return;
      const t = igxNormalizeText(n.textContent || '');
      if (t && t.length <= capT && !out.includes(t)) out.push(t);
    });
    return out;
  }

  // Признак закрепа в одной подписи. Якорь с НАЧАЛА строки обязателен для ДЛИННЫХ
  // подписей, но короткие составные метки Instagram («Gif, закреплено»,
  // «Публикация, Pinned to top») с якорем не считаются — слово идёт вторым сегментом.
  // Поэтому короткую строку (≤60 символов) дополнительно раскладываем на сегменты:
  // в такой метке «закреп» уже не может быть частью описания поста.
  function igxPaPinMarkIn(s) {
    const t = igxNormalizeText(String(s || ''));
    if (!t) return false;
    if (IGX_PIN_MARK.test(t)) return true;
    if (t.length > 60) return false;
    return t.split(/[,;|]/).some((seg) => IGX_PIN_MARK.test(seg.trim()));
  }

  function igxPaHasPinMark(root, maxTextLen) {
    return igxPaShortLabels(root, 14, maxTextLen).some((s) => igxPaPinMarkIn(s));
  }

  // Закреп помечаем по значку/подписи внутри тайла или его обёртки. Вверх идём ровно
  // до того предка, в котором остался ОДИН пост: иначе на уровне сетки в поддереве
  // оказались бы все тайлы сразу и «закрепленным» стал бы весь профиль.
  function igxPaTilePinned(tileEl) {
    let node = tileEl;
    for (let up = 0; up < 5 && node; up++) {
      if (node.querySelectorAll) {
        const posts = node.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]').length;
        if (posts > 1) break;
        if (igxPaHasPinMark(node, 26)) return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  // Тот же признак внутри УЖЕ открытого поста: у модалки плашка закрепа стоит в шапке,
  // и её видно надёжнее, чем значок в сетке.
  function igxPaPostPinnedInModal() {
    // Берём ТОЛЬКО видимый диалог: Instagram оставляет в DOM и невидимые узлы
    // (вьювер сторис, чужие модалки), в них легко поймать постороннюю подпись.
    let scope = null;
    document.querySelectorAll('[role="dialog"]').forEach((d) => {
      if (scope) return;
      const r = d.getBoundingClientRect();
      if (r.width > 120 && r.height > 120) scope = d;
    });
    if (!scope) {
      scope = (typeof findPostArticle === 'function' && findPostArticle(document)) || null;
    }
    if (!scope) return false;
    return igxPaHasPinMark(scope, 22);
  }

  // Что вообще «видит» расширение в первом тайле — попадает в отчёт, когда закрепы
  // не найдены: по этим подписям можно понять, какой разметкой Instagram их помечает.
  function igxPaTileLabelsText(tileEl) {
    if (!tileEl || !tileEl.closest) return '(тайл недоступен)';
    const a = tileEl.closest('a[href*="/"]') || tileEl;
    let node = a;
    const labs = [];
    for (let up = 0; up < 3 && node; up++) {
      igxPaShortLabels(node, 10, 26).forEach((s) => { if (!labs.includes(s)) labs.push(s); });
      if (node.querySelectorAll && node.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').length > 1) break;
      node = node.parentElement;
    }
    return labs.length ? labs.slice(0, 10).map((s) => `«${s}»`).join(' ') : 'подписей нет вовсе';
  }

  // Закрепы можно опознать и БЕЗ разметки: Instagram всегда ставит их ПЕРВЫМИ в сетке,
  // поэтому «первые несколько постов заметно старше тех, что идут за ними» = закреп.
  // Порог «заметно» — с запасом, чтобы обычная очерёдность свежих (3 дня против 2) не
  // превращала их в закрепы. Максимум три: больше Instagram не закрепляет.
  function igxPaAgePrefixPinned(ages) {
    const list = ages.map((a) => (typeof a === 'number' && isFinite(a) && a >= 0 ? a : null));
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const mine = list[i];
      if (mine === null) break;
      const later = list.slice(i + 1).filter((v) => v !== null);
      if (!later.length) break;
      const min = Math.min(...later);
      if (mine > min + Math.max(10, min)) n = i + 1; else break;
    }
    return Math.min(n, 3);
  }

  // Возраст публикации прямо из СЕТКИ (не открывая пост и не завися от галки «метрики»):
  // Instagram кладёт в каждый тайл <time datetime="…">. Подъём вверх останавливаемся
  // на предке, в поддереве которого больше одного поста — иначе все тайлы получили бы
  // возраст ПЕРВОГО тайла (сетка целиком) и признак стал бы фиктивным.
  function igxPaTileAgeDays(tileEl) {
    let node = tileEl && tileEl.closest ? (tileEl.closest('a[href]') || tileEl) : tileEl;
    for (let up = 0; up < 3 && node; up++) {
      const t = node.querySelector && node.querySelector('time[datetime], time');
      if (t) {
        const d = new Date(t.getAttribute('datetime') || '');
        if (!isNaN(d.getTime())) return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
        const raw = igxNormalizeText(t.getAttribute('title') || t.textContent || '').toLowerCase();
        const mD = raw.match(/(\d+)\s*(?:д\b|дн|day|days)/i);
        const mW = raw.match(/(\d+)\s*(?:нед|week|w\b)/i);
        const mM = raw.match(/(\d+)\s*(?:мес|month|mo\b)/i);
        if (mD) return parseInt(mD[1], 10);
        if (mW) return parseInt(mW[1], 10) * 7;
        if (mM) return parseInt(mM[1], 10) * 30;
        if (/^\d+\s*(?:ч|час|hour|h|мин|min)/i.test(raw) || /только что|just now/i.test(raw)) return 0;
        return null;
      }
      if (node.querySelectorAll && node.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]').length > 1) break;
      node = node.parentElement;
    }
    return null;
  }

  // Более честный возрастной признак, чем ratio: Instagram ставит закрепы ПЕРВЫМИ, а
  // остальные посты идут СТРОГО по свежести (от нового к старому). Значит закрепы — это
  // префикс, на котором порядок ЛОМАЕТСЯ: пост стал старше последующего, а хвост после
  // него снова упорядочен. Обязательное условие «лома» защищает от выдумки: профиль без
  // закрепов даёт ровно 0 (там сетка упорядочена целиком), тогда как прежний порог
  // «mine > min + max(10,min)» молча терял закрепы, если разбираемых постов мало
  // (хвоста нет вовсе) или если закреп старше недавних постов не «вдвое».
  function igxPaOrderPrefixPinned(ages, cap) {
    const src = Array.isArray(ages) ? ages : [];
    const ok = (v) => typeof v === 'number' && isFinite(v) && v >= 0;
    const tailSorted = (from) => {
      let prev = null;
      let any = false;
      for (let i = from; i < src.length; i++) {
        if (!ok(src[i])) continue;
        any = true;
        if (prev !== null && src[i] < prev) return false;
        prev = src[i];
      }
      return any;
    };
    const lim = Math.min(src.length - 1, cap || 3);
    for (let b = 1; b <= lim; b++) {
      if (!ok(src[b - 1])) continue;
      // Сравниваем со следующим ИЗВЕСТНЫМ возрастом: Instagram может не отдать дату у
      // одного тайла — это не обнуляет весь признак, лишь сужает место «лома».
      let nb = -1;
      for (let j = b; j < src.length; j++) { if (ok(src[j])) { nb = j; break; } }
      if (nb < 0) break;
      // «лам»: предыдущий пост СТАРШЕ идущего за ним — по своей воле так не бывает
      if (src[b - 1] <= src[nb]) continue;
      if (tailSorted(nb)) return b;
    }
    return 0;
  }

  // Строка самодиагностики в отчёт: первые 8 возрастов сетки в днях. Прочерк вместо
  // числа значит, что Instagram не отдаёт <time> в сетке (тогда признак «по порядку»
  // бессилен, и всё решает метка); по последовательности видно, где именно закреп
  // ломает порядок.
  function igxPaTilesAgesText(tiles) {
    const list = (tiles || []).slice(0, 8).map((t) => (typeof t.days === 'number' && isFinite(t.days) ? t.days : null));
    if (!list.some((v) => v !== null)) return 'сетка не отдаёт даты';
    return list.map((v) => (v === null ? '—' : v)).join('·');
  }

  // Догружаем сетку прокруткой, чтобы набралось достаточно уникальных постов.
  async function igxPaEnsureTiles(want) {
    const target = Math.max(3, want + 4);
    for (let i = 0; i < 12; i++) {
      const codes = new Set(
        Array.from(document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"], main a[href*="/tv/"]'))
          .map((a) => ((a.getAttribute('href') || '').match(/\/(?:p|reel|tv)\/([^/?]+)/i) || [])[1])
          .filter(Boolean)
      );
      if (codes.size >= target) break;
      try { window.scrollBy(0, Math.round(window.innerHeight * 0.9)); } catch (_) {}
      await igxSleep(900);
    }
    try { window.scrollTo(0, 0); } catch (_) {}
    await igxSleep(500);
  }

  async function igxPaWaitModalMedia(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const dlg = document.querySelector('[role="dialog"]');
      if (dlg && (dlg.querySelector('article') || dlg.querySelector('video') || dlg.querySelector('img'))) return true;
      await igxSleep(200);
    }
    return false;
  }

  // Крупный ВИДИМЫЙ [role="dialog"]: Instagram иногда оставляет скрытые остатки
  // диалогов в DOM после закрытия — судить об «открытой модалке» по одному их
  // наличию нельзя, иначе старый пост считается новым.
  function igxPaVisibleDialog() {
    const dialogs = document.querySelectorAll('[role="dialog"]');
    for (const d of dialogs) {
      if (d.closest && d.closest('.igx-pa-pop, .igx-afk-pop, .igx-side-panel, .igx-tooltip, .igx-link-menu')) continue;
      let cs;
      try { cs = getComputedStyle(d); } catch (_) { continue; }
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const r = d.getBoundingClientRect();
      if (r.width > 240 && r.height > 240) return d;
    }
    return null;
  }

  // Открытие публикации по коду: всегда берём ЖИВОЙ элемент (после history.back()
  // сетка перерисовывается и прежние ссылки невалидны). Возвращает режим — «модалка»
  // (пост поверх профиля) или «страница» (SPA-переход на /p//reel/).
  // Две гонки, из-за которых один пост читался 2–3 раза подряд, а другой молча
  // скипался: не закрывшаяся старая модалка ловилась циклом ожидания как новая,
  // и ссылка ещё не отрисованной сетки давала мгновенный null.
  async function igxPaOpenTile(code) {
    // Если старая модалка ещё видна — закрываем заранее: клик «сквозь» неё не
    // проходит, а цикл ожидания принял бы её за только что открытую.
    if (igxPaVisibleDialog()) {
      await igxPaCloseModal();
      await igxSleep(250);
    }
    const startUrl = location.href;
    let el = null;
    const findDeadline = Date.now() + 3000;
    for (;;) {
      el =
        document.querySelector(`main a[href="/p/${code}/"], main a[href="/reel/${code}/"], main a[href="/tv/${code}/"]`) ||
        document.querySelector(`main a[href*="/${code}/"]`) ||
        document.querySelector(`a[href*="/${code}/"]`);
      if (el || Date.now() > findDeadline) break;
      await igxSleep(300); // сетка после history.back() оживает за пару секунд
    }
    if (!el) return null;
    try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
    await igxSleep(200);
    clickElement(el, {});
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const dlg = igxPaVisibleDialog();
      if (dlg && (dlg.querySelector('article') || dlg.querySelector('video') || dlg.querySelector('img'))) return { mode: 'modal' };
      if (location.href !== startUrl && /\/(?:p|reel|tv)\//i.test(location.pathname) && (document.querySelector('article') || pickBestVideo())) return { mode: 'page' };
      await igxSleep(200);
    }
    return null;
  }

  async function igxPaCloseModal() {
    for (const t of ['keydown', 'keyup']) {
      document.dispatchEvent(new KeyboardEvent(t, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    }
    const closeBtn = document.querySelector(
      '[role="dialog"] button[aria-label*="Закрыть"], [role="dialog"] button[aria-label*="Close" i], [role="dialog"] div[aria-label*="Закрыт"], [role="dialog"] svg[aria-label*="Закрыт"]'
    );
    if (closeBtn) { try { (closeBtn.closest('button') || closeBtn).click(); } catch (_) {} }
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      // Ждём исчезновения ВИДИМОГО диалога: скрытые остатки [role="dialog"]
      // Instagram иногда держит навсегда, и по «есть ли узел» закрытый пост
      // выглядел незакрытым целых 2,5 секунды на каждый цикл.
      if (!igxPaVisibleDialog()) return true;
      await igxSleep(150);
    }
    return false;
  }

  async function igxPaClose(opened) {
    if (!opened) return;
    if (opened.mode === 'modal') {
      await igxPaCloseModal();
      return;
    }
    try { history.back(); } catch (_) {}
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (extractUsername(location.pathname)) break;
      await igxSleep(200);
    }
    await igxSleep(400);
  }

  // Одиночное фото (не карусель и не видео): detectCurrentPostMedia() возвращает null,
  // и раньше такой пост разбирался ВООБЩЕ без текста. Ищем крупную картинку открытого
  // поста — с неё тоже читаются надписи, а в vision-режиме приходит и описание.
  function igxPaDetectPhoto() {
    // Фото ищем ТОЛЬКО когда открыт конкретный пост (модалка или страница /p/<code>/):
    // иначе на странице профиля «фото» окажется любая превьюшка из сетки.
    let scope = null;
    document.querySelectorAll('[role="dialog"]').forEach((d) => {
      if (scope) return;
      const r = d.getBoundingClientRect();
      if (r.width > 240 && r.height > 240) scope = d;
    });
    if (!scope) {
      if (!/\/(?:p|reel|tv)\//i.test(location.pathname)) return null;
      scope = findPostArticle() || null;
    }
    if (!scope || !scope.querySelectorAll) return null;
    // Плеер в этом же контейнере = это НЕ фото. У ролика тоже есть постер-<img>, и
    // без этой проверки reel, которому ещё не отдали метаданные, уезжал в отчёт как
    // «Фото» — с распознаванием картинки и без всякого аудио.
    if (scope.querySelector('video')) return null;
    let best = null;
    let bestArea = 0;
    scope.querySelectorAll('img').forEach((img) => {
      const r = img.getBoundingClientRect();
      if (r.width < 160 || r.height < 160) return;
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = img;
      }
    });
    const url = best ? igxImageUrl(best) : null;
    if (!best || !url) return null;
    return { type: 'photo', el: best, url, scope };
  }

  // Самый крупный видимый <video> в кадре — БЕЗ требования «длительность известна»
  // (в этом и смысл: pickBestVideo() отбрасывает плееры с NaN duration, а именно
  // такой плеер и есть ещё не догруженный reel). Мелкие превьюшки сетки отсекаем
  // по площади, чтобы не принять за ролик иконку-заглушку.
  function igxPaStrayVideo() {
    let best = null;
    let bestArea = 0;
    document.querySelectorAll('video').forEach((v) => {
      const r = v.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      const area = w * h;
      if (area < 30000) return; // ≈173×173: пост сетки и служебные плееры мимо
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    });
    return best;
  }

  function igxPaVideoReady(v) {
    return !!(v && isFinite(v.duration) && v.duration > 0.5);
  }

  // Дождаться метаданных плеера. <video> появляется в разметке раньше, чем Instagram
  // отдаёт duration, а без него пост не считается видео нигде — отсюда «иногда скипал
  // видосы». Главная беда автоанализа: Instagram сам ставит рилс на паузу, когда окно
  // не в фокусе (мы часто гоняем в unfocused-окне) или когда модалку открыли синтетическим
  // кликом без жеста пользователя. Одиночного play() не хватает — плеер тут же паузится,
  // duration так и не приходит → «не посчиталась» + пустой разбор. Заводим на mute
  // (muted-autoplay разрешён без жеста) и ПОДНОВЛЯЕМ play() каждый тик, пока не дождёмся
  // метаданных: так выигрываем гонку у паузы Instagram. Потом честно на паузу и restore.
  async function igxPaWaitVideoMeta(v, ms) {
    if (igxPaVideoReady(v)) return true;
    if (!v) return false;
    const wasMuted = v.muted;
    let nudged = false;
    const kick = () => {
      try {
        v.muted = true;
        const p = v.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
        nudged = true;
      } catch (_) {}
    };
    kick();
    // «🛡 анти-залипание»: Instagram не даёт рилсу стартовать, пока окно не в фокусе.
    // Поднимаем своё окно наверх (мягко, не чаще раза в 4с) — это будит автоплей,
    // и плеер начинает грузить данные, которые иначе не доходят («видос не идёт»).
    const focus = () => {
      if (!_paGuardOn) return;
      const now = Date.now();
      if (now - _paGuardLastFocus < 4000) return;
      _paGuardLastFocus = now;
      try { const r = safeSendMessage({ type: 'bringToFront' }); if (r && r.catch) r.catch(() => {}); } catch (_) {}
    };
    if (_paGuardOn) focus();
    // Под галкой даём плееру чуть больше времени очнуться, но НЕ раздуваем бюджет:
    // эта функция зовётся несколько раз на видео, лишние секунды складываются в минуты.
    const budget = Math.max(600, ms || 0) + (_paGuardOn ? 1200 : 0);
    const deadline = Date.now() + budget;
    let triedLoad = false;
    while (Date.now() < deadline) {
      await igxSleep(180);
      if (igxPaVideoReady(v)) break;
      kick();
      if (_paGuardOn) {
        focus();
        // v.load() — ровно ОДИН раз за ожидание, не каждый тик: load() сбрасывает
        // загрузку и поднимает сетевой запрос ролика заново; при повторе каждые 180мс
        // плеер никогда не догружался, и разбор одного видео растягивался на минуты.
        if (!triedLoad && v.readyState === 0) { triedLoad = true; try { v.load(); } catch (_) {} }
      }
    }
    if (nudged) {
      try { v.pause(); } catch (_) {}
      try { v.muted = wasMuted; } catch (_) {}
      try { v.currentTime = 0; } catch (_) {}
    }
    return igxPaVideoReady(v);
  }

  // Определение типа медиа открытого поста с учётом гонки загрузки: сначала обычный
  // детектор, а если он увидел только «фото» при живом плеере — ждём метаданные и
  // спрашиваем детектор ещё раз. Крайний случай (длительность так и не пришла)
  // возвращаем честным видео с флагом noDuration, а не молча «фото».
  async function igxPaDetectMedia(statusEl) {
    let media = null;
    try { media = detectCurrentPostMedia() || igxPaDetectPhoto(); } catch (_) { media = null; }
    if (media && media.type === 'carousel') return media; // карусель разбирается по слайдам, плеер там не нужен
    const v = igxPaStrayVideo();
    if (!v) return media;
    // Для «фото» с плеером рядом ждать имеет смысл недолго: реальный фото-пост не
    // должен платить полным бюджетом ожидания метаданных, которых там и нет.
    const ready = await igxPaWaitVideoMeta(v, media ? 1500 : 4000);
    if (ready) {
      try {
        const again = detectCurrentPostMedia() || media;
        if (again) return again;
      } catch (_) {}
    }
    igxPaSetStatus(statusEl, 'Видео без метаданных — читаю только начало…');
    return {
      type: 'video',
      video: v,
      noDuration: true,
      scope: v.closest('article, [role="dialog"], main') || document,
      mediaContainer: v.parentElement,
    };
  }

  // Распознавание ОДНОЙ картинки (фото поста): сначала по URL, фолбэк — снимок элемента.
  // Одна картинка = один запрос, в vision-режиме тем же запросом приходит и описание.
  async function igxOcrSinglePhoto(photo, apiKey, vision) {
    if (!photo || !photo.el) return '';
    let txt = '';
    try {
      if (photo.url) txt = await ocrRecognizeUrl(photo.url, apiKey, vision);
    } catch (e) {
      // Пустой catch прятал причину: пользователь видел «(текста нет)» там, где на
      // самом деле картинка не отдалась серверу. Заметка идёт в тот же буфер честных
      // предупреждений и вымывается вызывающей стороной в своём отчёте.
      igxOcrNote('фото по URL не прочитано: ' + igxPaErrMsg(e));
    }
    if (!txt) {
      try {
        const shot = await captureElementClean(photo.el);
        if (shot) txt = await ocrRecognize(shot, apiKey, vision);
      } catch (e) {
        igxOcrNote('и со страницы фото не прочиталось: ' + igxPaErrMsg(e));
      }
    }
    return compactOcrText(txt);
  }

  // ---------- «закрепы под микроскопом» и честная речь ----------
  // Вердикт по закреплённому видео: кадры склеиваются в сетку-коллаж и ОДНИМ
  // запросом уходят vision-модели (локальной или облачной) с вопросом про кейсы
  // и разборы. Спрашивать каждый кадр отдельно — в N раз дольше ради того же ответа.
  const PIN_VERDICT_PROMPT =
    'Перед тобой сетка кадров одного закреплённого Instagram-видео эксперта (по порядку, слева направо). ' +
    'Реши, есть ли в видео КЕЙСЫ и результаты клиентов (до/после, цифры, скриншоты, отзывы) ' +
    'или экспертные РАЗБОРЫ — или это мотивация/атмосфера/реклама без конкретики. ' +
    'Ответь ОДНОЙ строкой (до 220 символов) ровно в формате: «что: …; в рассылку: стоит|не стоит|вскользь; почему: …». ' +
    'Не выдумывай: если по кадрам не понять — так и напиши.';

  // Кадры captureRange отдаёт dataURL-строками; собрать из них одну картинку-сетку,
  // чтобы вердикт стоил ОДИН запрос к нейронке вместо N.
  async function igxStitchFrames(frames, cols, cellW) {
    try {
      const imgs = await Promise.all((frames || []).map((src) => new Promise((res) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => res(null);
        im.src = src;
      })));
      const ok = imgs.filter(Boolean);
      if (!ok.length) return null;
      const c = Math.max(1, Math.min(cols || 2, ok.length));
      const rows = Math.ceil(ok.length / c);
      const w = cellW || 640;
      const h = Math.max(90, Math.round(w * (ok[0].height || 9) / (ok[0].width || 16)));
      const cv = document.createElement('canvas');
      cv.width = w * c; cv.height = h * rows;
      const g = cv.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, cv.width, cv.height);
      ok.forEach((im, i) => g.drawImage(im, (i % c) * w, Math.floor(i / c) * h, w, h));
      return cv.toDataURL('image/jpeg', 0.85);
    } catch (_) { return null; }
  }

  // «🧬 формат кадра»: нейронка смотрит ДВА кадра одного видео — самый начало (~1 с)
  // и концовку (~3 с до конца) — и решает, КАК смонтирован ролик: сплит-экран
  // (сверху человек/тренировка, снизу чужой подкаст), говорящая голова, демонстрация,
  // слайд-текст, нарезка. Обычные проходы берут кадры начала и концовки только ради
  // текста и речи — композицию монтажа они не видят, из-за чего сплит-экран с чужим
  // подкастом снизу терялся из отчёта. Это +1 запрос-коллаж на ВИДЕО-пост (не на кадр).
  const FRAME_FORMAT_PROMPT =
    'Перед тобой ДВА кадра одного Instagram-видео: первым кадр из самого начала ролика, ' +
    'вторым — из концовки. Опиши ФОРМАТ (композицию) видео: как смонтирован и что где расположено. ' +
    'Ищи особенно: сплит-экран (экран пополам или с окном-вставкой: например, сверху человек ' +
    'говорит или качается, а снизу идёт чужое видео/подкаст, где тоже что-то говорят), ' +
    'говорящая голова на весь экран, демонстрация упражнения или процесса без речи, ' +
    'текст/карусель плашек вместо живого видео, нарезка разных сцен, реклама-ролик. ' +
    'Если сверху и снизу кадры различаются — так и скажи отдельно про начало и про концовку. ' +
    'Ответь ОДНОЙ строкой (до 200 символов) в формате: «формат: …; кадры: …», ' +
    'где «кадры» — что физически в кадре (кто где расположен, есть ли вставки/окна/плашки). ' +
    'Не выдумывай: если два кадра нечитаемы — так и напиши.';

  async function igxPaFormatVerdict(video, apiKey, statusEl) {
    if (!video) return '';
    try { await igxPaWaitVideoMeta(video, 2000); } catch (_) {}
    const d = isFinite(video.duration) && video.duration > 0.5 ? video.duration : 0;
    // 1 с с начала; за 3 с до конца — но не раньше самого начала +1 с (короткие ролики).
    const ts = [1];
    if (d > 4) ts.push(Math.max(1.5, d - 3));
    const frames = await captureRange(video, ts[0], ts[ts.length - 1], ts, statusEl, 'формата');
    if (!frames || !frames.length) throw new Error('не удалось снять кадры начала/конца');
    const grid = (await igxStitchFrames(frames, 2, 640)) || frames[0];
    const ans = await ocrRecognize(grid, apiKey, false, FRAME_FORMAT_PROMPT);
    const s = String(ans || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > 240 ? s.slice(0, 240) + '…' : s;
  }

  // «🖼 превью видео»: нейронка смотрит ОБЛОЖКУ ролика (poster) — кадр, который автор
  // сам выбрал обложкой. На ней почти всегда крупно вынесена ТЕМА видео, которой нет
  // ни в подписи, ни в речи. Это +1 запрос на видео-пост (одна картинка, не кадр).
  const PREVIEW_PROMPT =
    'Перед тобой ОБЛОЖКА (превью) Instagram-видео — кадр, который автор поставил обложкой ролика. '
    + 'Часто на обложке крупно написана ТЕМА видео. Кратко (одним предложением) опиши, что изображено, '
    + 'затем через точку с запятой и слово «ТЕКСТ:» выпиши ВЕСЬ читаемый текст с обложки дословно. '
    + 'Формат ответа — ОДНА строка: «…описание…; ТЕКСТ: …». Если текста на обложке нет — часть '
    + '«; ТЕКСТ: …» не пиши вовсе. Не выдумывай: если картинка нечитема — так и напиши.';

  // Обложка видео: сначала poster у самого <video>, иначе — самая крупная картинка
  // рядом с плеером (Instagram кладёт обложку и как <img> в сетку/модалку).
  function igxPaVideoPoster(video) {
    try {
      if (video && video.poster && /^https?:/i.test(video.poster)) return video.poster;
      const scope = (video && video.closest && video.closest('article, [role="dialog"], main')) || document;
      let best = '';
      let bestArea = 0;
      scope.querySelectorAll('img').forEach((im) => {
        const src = im.currentSrc || im.src || '';
        if (!/^https?:/i.test(src)) return;
        const r = im.getBoundingClientRect();
        const area = r.width * r.height;
        // аватарки/иконки отбрасываем: обложка — крупная картинка
        if (area > bestArea && r.width >= 140 && r.height >= 140) { bestArea = area; best = src; }
      });
      return best;
    } catch (_) { return ''; }
  }

  async function igxPaPreviewVerdict(video, apiKey, statusEl) {
    if (!video) return '';
    const poster = igxPaVideoPoster(video);
    let ans = '';
    if (poster) {
      try { ans = await ocrRecognizeUrl(poster, apiKey, false, PREVIEW_PROMPT); }
      catch (e) { igxOcrNote('обложка по URL не прочиталась (' + igxPaErrMsg(e) + ') — снимаю нулевой кадр'); }
    }
    if (!ans) {
      // Постер не отдался (пустой/задержан) — нулевой кадр у Instagram обычно и есть
      // обложка. Снимаем один кадр на 0.2 с без долгой перемотки.
      try {
        const frames = await captureRange(video, 0.1, 0.3, [0.2], statusEl, 'обложки');
        if (frames && frames.length) ans = await ocrRecognize(frames[0], apiKey, false, PREVIEW_PROMPT);
      } catch (e) { igxOcrNote('превью не снято: ' + igxPaErrMsg(e)); }
    }
    const s = String(ans || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > 240 ? s.slice(0, 240) + '…' : s;
  }

  async function igxPaPinVerdict(video, apiKey, statusEl, att) {
    if (!video) return '';
    const d = isFinite(video.duration) && video.duration > 0.5 ? video.duration : 0;
    const from = d ? d * 0.02 : 0.2;
    const to = d ? d * 0.98 : 15;
    // 3–6 кадров-свидетелей по ВСЕМУ ролику (не только начало/конец, как у транскрипта):
    // чем выше «внимание к закрепам», тем плотнее сетка.
    const n = Math.max(3, Math.min(6, 1 + Math.max(1, Math.min(3, Number(att) || 2)) + 1));
    const ts = getEvenTimestamps(from, to, n);
    const frames = await captureRange(video, from, to, ts, statusEl, 'закрепа');
    if (!frames || !frames.length) throw new Error('не удалось снять кадры для вердикта');
    const grid = await igxStitchFrames(frames, 2, 640);
    const ans = await ocrRecognize(grid || frames[0], apiKey, false, PIN_VERDICT_PROMPT);
    const s = String(ans || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > 260 ? s.slice(0, 260) + '…' : s;
  }

  // «🎭 Тип контента» — точный проход по началам постов: КАЖДЫЙ пост получает свой
  // запрос нейронке (2 кадра из начала + подпись поста). Это дольше, чем один коллаж
  // на весь аудит, зато модель видит разницу между «идёт и болтает», «качается под
  // музыку с плашками» и «сценкой-рофл». Итоговые доли жанров склеиваются локально —
  // подсчёт бесплатный, лишний запрос не нужен.
  const CONTENT_AUDIT_ITEM_PROMPT =
    'Перед тобой кадры из НАЧАЛА одной свежей Instagram-публикации. ' +
    'Реши, ЧТО ПРОИСХОДИТ и какой это ЖАНР. Жанры (выбери один): экспертный (говорит по делу, разбирает тему, учит), ' +
    'полуэкспертный (смесь пользы и жизни), разговорный (идёт/сидит и просто болтает, бытовое), ' +
    'демонстрация (показывает упражнения/процесс, часто под музыку, плашки-подписи на экране), ' +
    'рофл/юмор (сценки, мемы, шутки), лайфстайл (про жизнь без пользы), реклама/продажи, мотивация, другое. ' +
    'Смотри на всё: кто в кадре и что ДЕЛАЕТ, текст и плашки на экране, монтаж, тон подписи. '
    + 'Если дан блок «аудио» — обязательно учитывай его: говорящая голова по делу (разбирает тему, учит) = экспертный '
    + 'даже без плашек; а «просто музыка, речи нет» при показе процесса/упражнений = демонстрация, при показе быта/жизни = лайфстайл, но НЕ экспертный. '
    + 'Ответь ОДНОЙ строкой ровно в формате: «жанр: …; в кадре: …» (до 180 символов), ' +
    'где «в кадре» — честное короткое описание происходящего (например: «девушка идёт по улице и рассказывает про день», ' +
    '«парень качает пресс под музыку, сверху плашки с названиями упражнений»). ' +
    'Не выдумывай: если кадры нечитаемы — так и напиши.';

  async function igxPaContentAudit(tiles, st, apiKey, statusEl) {
    if (!igxVisionWorks(apiKey)) {
      igxOcrNote('аудит типа контента включён, но он не выйдет: нет ни облачного ключа, ни локальной модели');
      return '';
    }
    const want = Math.max(1, Math.min(20, Number(st.auditPosts) || 10));
    const sample = (tiles || []).slice(0, want);
    if (!sample.length) return '';
    const lines = [];
    const genres = [];
    // Сколько секунд начала ролика «смотрим»: берём окно старта из настроек OCR
    // (та самая «скок выставлено»); кадров два — чтобы заметить движение, а не застылый кадр.
    const sec = Math.max(2, Math.min(30, Number(st.startSec) || 7));
    for (let i = 0; i < sample.length; i++) {
      igxPaSetStatus(statusEl, `🎭 Аудит контента: пост ${i + 1}/${sample.length}…`);
      const opened = await igxPaOpenTile(sample[i].code);
      // Молчаливый skip делал «аудит 12» аудитом четырёх без единого объяснения.
      if (!opened) { igxOcrNote('пост ' + (i + 1) + ' (' + sample[i].code + '): не открылся — в аудит не попал'); continue; }
      const shots = [];
      let desc = '';
      let audioHint = ''; // 🎧 что слышно в начале: речь/музыка — подсказка для жанра
      try {
        await igxPaWaitModalMedia(1200);
        let media = null;
        try { media = await igxPaDetectMedia(statusEl); } catch (_) {}
        try {
          const m = extractInstagramPostData((media && media.scope) || findPostArticle() || document);
          if (m && m.description) desc = String(m.description).replace(/\s+/g, ' ').slice(0, 160);
        } catch (_) {}
        if (media && media.type === 'video') {
          const video = media.video || igxPaStrayVideo() || pickBestVideo();
          if (video) {
            // Настройка ожидания: сколько секунд ждать ЗАГРУЗКИ видео в аудите перед съёмкой
            // кадров. 0 — не ждать вовсе: незагруженный рилс сразу пропускаем, аудит летит быстрее.
            const awaitSec = Math.max(0, Math.min(15, Number(st.auditWaitSec) || 0));
            if (awaitSec > 0) { try { await igxPaWaitVideoMeta(video, awaitSec * 1000); } catch (_) {} }
            try { video.pause(); } catch (_) {}
            const d = isFinite(video.duration) && video.duration > 0.5 ? video.duration : 0;
            const to = d ? Math.min(d, sec) : sec;
            try {
              const fs = await captureRange(video, 0.2, to, getEvenTimestamps(0.2, to, 2), statusEl, 'аудита');
              if (fs && fs.length) shots.push(...fs);
            } catch (e) { igxOcrNote('пост ' + (i + 1) + ': кадры начала не сняты: ' + igxPaErrMsg(e)); }
            // 🎧 Аудио-сигнал для жанра: слушаем короткое начало — речь по делу vs просто музыка.
            // Галка «🎧 в аудите слушать аудио» (st.auditAudio) включает этот доп. ASR-запрос на
            // каждый видео-пост; выключена — аудит остаётся одним vision-запросом (быстро).
            if (st.auditAudio !== false) {
              try {
                const asec = Math.max(2, Math.min(12, sec));
                const aw = { headTo: d ? Math.min(d, asec) : asec, tailFrom: 0, tailTo: 0, headOnly: true };
                audioHint = (await igxPaVideoVoice(video, aw, apiKey, statusEl)) || '';
              } catch (_) { audioHint = ''; }
            }
          }
        }
        // Фото, карусель и «не понял что»: самый крупный видимый <img> модалки — один кадр.
        if (!shots.length) {
          try { const ph = igxPaDetectPhoto(); const s = ph && (await captureElementClean(ph.el)); if (s) shots.push(s); } catch (_) {}
        }
        if (!shots.length) { igxOcrNote('пост ' + (i + 1) + ': ни одного кадра — в аудит не попал'); continue; }
        // Два кадра склеиваем в одну картинку: пост = ОДИН запрос, как и задумано.
        const grid = shots.length > 1 ? ((await igxStitchFrames(shots, 2, 480)) || shots[0]) : shots[0];
        let prompt = CONTENT_AUDIT_ITEM_PROMPT;
        if (desc) prompt += '\n\nПодпись этого поста: «' + desc + '»';
        if (audioHint) prompt += '\n\nЧто слышно в начале ролика (аудио): «' + audioHint + '»';
        let ans = '';
        try { ans = await ocrRecognize(grid, apiKey, false, prompt); }
        catch (e) { igxOcrNote('пост ' + (i + 1) + ': нейронка не ответила: ' + igxPaErrMsg(e)); continue; }
        const s = String(ans || '').replace(/\s+/g, ' ').trim();
        if (!s) continue;
        const gm = s.match(/жанр:\s*([^;]{2,40})/i);
        if (gm) genres.push(gm[1].toLowerCase().replace(/[.,!]+\s*$/, '').trim().slice(0, 28));
        lines.push('• ' + (i + 1) + '. ' + (s.length > 200 ? s.slice(0, 200) + '…' : s));
      } catch (e) {
        igxOcrNote('пост ' + (i + 1) + ' в аудит не попал: ' + igxPaErrMsg(e));
      } finally {
        await igxPaClose(opened);
        await igxSleep(220);
      }
    }
    if (!lines.length) { igxOcrNote('аудит: ни одного вердикта не вышло'); return ''; }
    // Доли жанров считаем локально по извлечённому «жанр: …» — нейронка угадывала
    // жанр в каждом вердикте, а «большая часть/поменьше» — обычная арифметика.
    const tally = {};
    for (const g of genres) tally[g] = (tally[g] || 0) + 1;
    const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    let out = lines.join('\n');
    if (sorted.length) {
      const top = sorted[0]; const second = sorted[1];
      out += '\nΣ: ' + sorted.map((e) => e[0] + ' — ' + e[1]).join(', ');
      out += '\nИтог: большая часть — ' + top[0] + ' (' + top[1] + ' из ' + lines.length + ')'
        + (second ? ', поменьше — ' + second[0] + ' (' + second[1] + ')' : '') + '.';
    }
    return out;
  }

  // Whisper на чистую музыку часто отвечает пусто или «♪♪♪»/«[music]». Раньше это
  // писалось как «(не найдена)» или «не удалось извлечь аудио» — будто слушать не
  // стали. По смыслу же: слышно есть, но никто не говорит.
  function igxVoiceMusicOnly(raw) {
    const s = String(raw || '').trim();
    if (!s) return true;
    if (/[♪♫♬🎵🎶]/.test(s)) return true;
    return /^[\s\[\](){},.!-]*(?:music|музыка|song|песн\w*|applause|аплодисмент\w*|cheering|laughter|смех)[\s\[\](){},.!-]*$/i.test(s);
  }
  function igxVoiceJoin(head, tail) {
    const parts = [];
    if (head && !igxVoiceMusicOnly(head)) parts.push('Начало: ' + head);
    if (tail && !igxVoiceMusicOnly(tail)) parts.push('Концовка: ' + tail);
    return parts.join('\n');
  }

  // Названия актуалок, по которым видно: эксперт держит «мясо» (кейсы, результаты,
  // отзывы, разборы) в highlights. Сами обложки не открываем — выводим по названиям.
  const IGX_HL_EVIDENCE_RE = /(?:кейс|case|результат|отзыв|разбор|аудит|до\s*[\/–—-]\s*после|до\s+и\s+после|before.?after|внедрен|проект|отч[ёе]т|report)/i;
  function igxHlEvidenceTitles(titles) {
    return (Array.isArray(titles) ? titles : []).filter((t) => IGX_HL_EVIDENCE_RE.test(String(t || '')));
  }

  // Разбор открытой публикации: формат + длительность/слайды + метрики + транскрипт.
  // Возвращает объект: text — блоки отчёта, days — возраст поста (нужен, чтобы опознать
  // закреп «по возрасту», когда метку в разметке прочитать не удалось), pinned — есть ли
  // в открытой модалке плашка закрепа.
  async function igxPaAnalyzeOpenPost(st, apiKey, statusEl, pinBoost) {
    const lines = [];
    const res = { text: '', days: null, pinned: false, verdict: '', kind: 'none' };
    try { res.pinned = igxPaPostPinnedInModal(); } catch (_) {}
    let media = null;
    try { media = await igxPaDetectMedia(statusEl); } catch (_) { media = null; }
    if (media && media.type === 'carousel') {
      res.kind = 'carousel';
      lines.push('Формат: карусель', media.totalSlides > 0 ? `Слайдов: ${media.totalSlides}` : 'Слайдов: не определено (добываем листанием по факту)');
    } else if (media && media.type === 'video') {
      res.kind = 'video';
      lines.push('Формат: видео');
      lines.push(media.noDuration
        ? 'Длительность: не посчиталась — Instagram не отдал метаданные, читается только начало'
        : `Длительность: ${igxPaFmtTime(media.video && media.video.duration)}`);
      // «🖼 превью видео»: обложка (poster) — на ней часто написана тема ролика.
      if (st.videoPreview) {
        if (igxVisionWorks(apiKey)) {
          igxPaSetStatus(statusEl, '🖼 Смотрю превью видео…');
          try {
            const pv = await igxPaPreviewVerdict(media.video || igxPaStrayVideo() || pickBestVideo(), apiKey, statusEl);
            if (pv) { res.preview = pv; lines.push('На превью: ' + pv); }
            else igxOcrNote('превью: нейронка не ответила по обложке');
          } catch (e) {
            igxOcrNote('превью не посмотрел: ' + igxPaErrMsg(e));
          }
        } else {
          igxOcrNote('«🖼 превью видео» включено, но разбора не будет: нет ни облачного ключа, ни локальной модели');
        }
      }
      // «🧬 формат кадра»: начало (1 с) + концовка (3 с до конца) одним коллажом —
      // сплит-экран с чужим подкастом, вставка-окно, нарезка. Один запрос на видео.
      if (st.frameFormat) {
        if (igxVisionWorks(apiKey)) {
          igxPaSetStatus(statusEl, '🧬 Смотрю формат кадра…');
          try {
            const fv = await igxPaFormatVerdict(media.video || igxPaStrayVideo() || pickBestVideo(), apiKey, statusEl);
            if (fv) { res.frameFormat = fv; lines.push('🧬 Композиция/монтаж: ' + fv); }
            else igxOcrNote('формат кадра: нейронка не ответила по видео');
          } catch (e) {
            igxOcrNote('формат кадра не посмотрел: ' + igxPaErrMsg(e));
          }
        } else {
          igxOcrNote('«🧬 формат кадра» включён, но вердикта не будет: нет ни облачного ключа, ни локальной модели');
        }
      }
    } else if (media && media.type === 'photo') {
      res.kind = 'photo';
      lines.push('Формат: фото');
    } else {
      // Раньше сюда же писало «Формат: фото», хотя в модалке не было найдено ничего:
      // отчёт выглядел как разбор, а по факту разбора не было.
      lines.push('Формат: медиа не найдено (ни картинки поста, ни плеера)');
    }
    if (st.doMeta) {
      try {
        const meta = extractInstagramPostData((media && media.scope) || findPostArticle() || document);
        if (meta && typeof meta.daysAgo === 'number') res.days = meta.daysAgo;
        const mtxt = formatPostDataText(meta);
        if (mtxt) lines.push(mtxt);
      } catch (_) {}
    }
    if (igxPaAnyReader(st) && media) {
      try {
        const tr = await igxPaTranscribe(media, st, apiKey, statusEl, pinBoost);
        if (tr) lines.push('--- транскрипт ---', tr);
      } catch (e) {
        lines.push('(ошибка транскрипции: ' + ((e && e.message) || e) + ')');
      }
    }
    // «Закрепы под микроскопом»: vision-модель досматривает закреплённое видео и
    // коротко решает, есть там кейсы/разборы и стоит ли об этом говорить в рассылке.
    if (pinBoost && media && media.type === 'video') {
      if (igxVisionWorks(apiKey)) {
        igxPaSetStatus(statusEl, '📌 Нейронка досматривает закреп…');
        try {
          const vd = await igxPaPinVerdict(media.video || igxPaStrayVideo() || pickBestVideo(), apiKey, statusEl, st.pinAttention);
          if (vd) { res.verdict = vd; lines.push('📌 Что в закрепе: ' + vd); }
        } catch (e) {
          igxOcrNote('вердикт по закрепу не получен: ' + igxPaErrMsg(e));
        }
      } else {
        igxOcrNote('закрепы под микроскопом включены, но вердикта не будет: нет ни облачного ключа, ни локальной модели');
      }
    }
    res.text = lines.join('\n');
    return res;
  }

  async function igxPaProcessTile(tile, st, apiKey, statusEl) {
    const opened = await igxPaOpenTile(tile.code);
    if (!opened) return { text: '(не удалось открыть публикацию)', days: null, pinned: !!tile.pinned, kind: 'none' };
    try {
      await igxPaWaitModalMedia(1500);
      // Буст закреп — если ЕЩЁ ДО открытия пост выглядит как закреп: по метке в сетке
      // или по порядку (старый перед свежими). Внутри модалки метка читается позже,
      // а длинные окна транскрипта нужны уже на чтении.
      const r = await igxPaAnalyzeOpenPost(st, apiKey, statusEl, !!((tile.pinned || tile.pinOrder) && st.pinScan));
      // Метка из сетки тоже силу имеет: если её увидели хотя бы одним способом — закреп.
      // ПОРЯДОК сюда не примешиваем специально: он отдельный признак, и в заголовке
      // блока он должен быть подписан «по порядку сетки», а не врать «по метке».
      if (tile.pinned) r.pinned = true;
      return r;
    } catch (e) {
      return { text: '(ошибка разбора: ' + ((e && e.message) || e) + ')', days: null, pinned: !!tile.pinned };
    } finally {
      await igxPaClose(opened);
      await igxSleep(350);
    }
  }

  // Короткий текст ошибки в честную строку отчёта: пустой catch превращал «упало»
  // в «не найдено», и отличить одно от другого было нельзя.
  function igxPaErrMsg(e) {
    const s = String((e && e.message) || e || 'без сообщения').replace(/\s+/g, ' ').trim();
    return s.length > 150 ? s.slice(0, 150) + '…' : s;
  }

  // Транскрипт: что читать, решает пользователь ПО ТИПУ публикации — фото, слайды,
  // кадры видео, речь видео — четырьмя отдельными галками. Раньше фото и карусель
  // молча подчинялись одной галке «текст с экрана», а у видео был ещё и свой режим,
  // который с ней спорил.
  async function igxPaTranscribe(media, st, apiKey, statusEl, pinBoost) {
    const parts = [];
    // Если картинки просим описать, а нейронки (облако или локалка) нет — молча терять
    // это нельзя: в отчёте не будет ни описаний, ни объяснения почему.
    const visionOff = st.doVision && (st.photoOcr || st.slidesOcr || st.videoOcr) && !igxVisionWorks(apiKey);
    const visionOffLine = visionOff ? '\n(⚠ описание картинок недоступно: нет ни облачного ключа, ни локальной модели)' : '';
    if (media.type === 'photo') {
      // Одно фото: ОДИН запрос к распознавалке (в vision-режиме он же даёт и описание).
      if (st.photoOcr) {
        igxPaSetStatus(statusEl, 'Распознаю фото…');
        let clean = '';
        try { clean = await igxOcrSinglePhoto(media, apiKey, st.doVision); } catch (e) { igxOcrNote('фото не прочитано: ' + igxPaErrMsg(e)); }
        parts.push('Фото:\n' + (clean || '(текста нет или распознать не удалось)') + visionOffLine);
      }
      return parts.join('\n\n') + igxOcrNotesLine();
    }
    if (media.type === 'carousel') {
      if (st.slidesOcr) {
        const { headText, tailText, warnings } = await extractCarouselSlides(
          media, st.startSlides, st.endSlides, apiKey, statusEl, st.doVision
        );
        parts.push(`Хук:\n${headText}\n\nПризыв:\n${tailText}` + (warnings && warnings.length ? `\n\n(⚠ ${warnings.join('; ')})` : '') + igxOcrNotesLine());
      }
      return parts.join('\n\n');
    }
    const video = media.video || igxPaStrayVideo() || pickBestVideo();
    // Видео не нашлось — предупреждения из буфера всё равно обязаны выйти в отчёт,
    // иначе они уедут в следующий пост.
    if (!video) return igxOcrNotesLine();
    // Дожимаем метаданные ИМЕННО на том элементе, с которого сейчас читаем duration и
    // потом пишем звук: детектор выпрашивал метаданные на stray-видео, а media.video —
    // иногда другой <video>, который так и не «разогнался» → вечное «не посчиталась».
    try { await igxPaWaitVideoMeta(video, 3000); } catch (_) {}
    try { video.pause(); } catch (_) {}
    if (!st.videoOcr && !st.videoVoice) {
      return 'Видео не разбираем: в блоке «Что разбирать» сняты и «текст с кадров», и «речь».' + igxOcrNotesLine();
    }
    const d = isFinite(video.duration) ? video.duration : 0;
    // «Закрепы под микроскопом»: закреплённому видео уделяем больше времени целиком —
    // и окна чтения длиннее, и кадров больше (вердикт — отдельным коллажем igxPaPinVerdict).
    const att = pinBoost ? Math.max(1, Math.min(3, Number(st.pinAttention) || 2)) : 1;
    const headSec = Math.max(2, Math.min(30, (Number(st.startSec) || 7) * att));
    // Длительность неизвестна → окно конца построить некуда (мотаться не по чему).
    // Раньше это и был «скипнутый видос»: речь запускалась под условием d > 0.5 и
    // молча не запускалась никогда. Теперь слушаем начало и честно об этом пишем.
    const win = d > 0.5
      ? getVideoWindows(d, (Number(st.startSec) || 7) * att, (Number(st.endSec) || 7) * att)
      : { headTo: headSec, tailFrom: 0, tailTo: 0, headOnly: true };
    if (win.headOnly) igxOcrNote('длительность ролика не посчиталась — читал только начало (' + headSec + ' с), концовка не разобрана');
    if (st.videoOcr) {
      const txt = await igxPaVideoText(video, win, apiKey, statusEl, Math.min(8, (Number(st.videoFrames) || 3) * att), st.doVision);
      parts.push('Текст на видео:\n' + (txt || '(не найден)') + visionOffLine);
    }
    if (st.videoVoice) {
      const v = await igxPaVideoVoice(video, win, apiKey, statusEl);
      parts.push('Речь:\n' + (v || '(не найдена)'));
    }
    return parts.join('\n\n') + igxOcrNotesLine();
  }

  async function igxPaVideoText(video, win, apiKey, statusEl, frames, vision) {
    // Кадров на окно — столько, сколько разрешил пользователь. Раньше бралась
    // частота из попапа (~8 кадров на окно = ~16 запросов к облаку на одно видео),
    // и на бесплатном лимите токенов это минуты простоя, а не точнее разбор.
    const n = Math.max(1, Math.min(8, parseInt(frames, 10) || 3));
    const headTs = getEvenTimestamps(0, win.headTo, n);
    // Окна конца нет — не снимем и не распознаем: пустой массив вместо фантомного
    // кадра «в начале» экономит один платный запрос и не врёт про полноту разбора.
    const tailTs = win.headOnly ? [] : getEvenTimestamps(win.tailFrom, win.tailTo, n);
    const directUrl = findVideoUrl(video);
    if (directUrl) {
      try {
        igxPaSetStatus(statusEl, `Распознаю текст видео (${headTs.length + tailTs.length} кадр.)…`);
        const res = await ocrVideoDirect(directUrl, headTs, tailTs, apiKey, vision);
        const h = compactOcrText(res && res.headText);
        const t = compactOcrText(res && res.tailText);
        if (h || t) return [h && `Начало: ${h}`, t && `Концовка: ${t}`].filter(Boolean).join('\n');
      } catch (e) {
        // Прямое не успело = оно упёрлось в окно лимита токенов. Переснимать те же
        // кадры со страницы — это ещё раз столько же ждать сверху; честнее вернуть
        // пустоту с объяснением, чем удваивать время прогона ради текста, который
        // всё равно нечем читать.
        if (e && e.timeout) return '(прямое распознавание не успело: облако ждало окно лимита; кадры повторно не снимаем)';
        igxOcrNote('прямое чтение кадров не удалось (' + igxPaErrMsg(e) + ') — снимаю со страницы');
      }
    }
    try {
      igxPaSetStatus(statusEl, 'Снимаю кадры и распознаю текст…');
      const hf = await captureRange(video, 0, win.headTo, headTs, statusEl, 'начала');
      const tf = win.headOnly ? [] : await captureRange(video, win.tailFrom, win.tailTo, tailTs, statusEl, 'конца');
      const h = compactOcrText(await ocrFrames(hf, apiKey, statusEl, 'хука', vision));
      const t = compactOcrText(await ocrFrames(tf, apiKey, statusEl, 'призыва', vision));
      return [h && `Начало: ${h}`, t && `Концовка: ${t}`].filter(Boolean).join('\n');
    } catch (e) {
      igxOcrNote('кадры снять не удалось: ' + igxPaErrMsg(e));
      return '';
    }
  }

  async function igxPaVideoVoice(video, win, apiKey, statusEl) {
    const directUrl = findVideoUrl(video);
    if (directUrl) {
      try {
        igxPaSetStatus(statusEl, 'Распознаю речь…');
        const r = await asrRecognizeUrl(directUrl, win.headTo, win.tailFrom, win.tailTo, apiKey);
        const line = igxVoiceJoin(r.headText, r.tailText);
        // ASR отработал и не нашёл ни в начале, ни в концовке осмысленной речи —
        // значит в звуке музыка/фон. Честно писать про это, а не «не удалось извлечь».
        return line || 'Просто музыка на фоне — речи нет.';
      } catch (e) {
        // Раньше catch был пустой: причина падения терялась, а в отчёте стояло
        // «Речь: (не найдена)» — как будто её слушали и ничего не услышали.
        igxOcrNote('прямое аудио не удалось (' + igxPaErrMsg(e) + ') — пробую записать звук с плеера');
      }
    }
    try {
      igxPaSetStatus(statusEl, 'Записываю и распознаю звук…');
      const hb = await blobToBase64(await recordRange(video, 0, win.headTo));
      const h = await asrRecognize(hb, apiKey);
      let t = '';
      if (!win.headOnly) {
        const tb = await blobToBase64(await recordRange(video, win.tailFrom, win.tailTo));
        t = await asrRecognize(tb, apiKey);
      }
      const line = igxVoiceJoin(h, t);
      return line || 'Просто музыка на фоне — речи нет.';
    } catch (e) {
      igxOcrNote('речь не прослушана: ' + igxPaErrMsg(e));
      return '';
    }
  }

  // Хоть что-то из контента поста читаем? Метрики — отдельно: они бесплатный DOM.
  function igxPaAnyReader(st) {
    return !!(st.photoOcr || st.slidesOcr || st.videoOcr || st.videoVoice);
  }

  async function igxPaReadSettings() {
    const d = await safeStorageGet([
      PA_COUNT_KEY, PA_SETTINGS_KEY,
      OCR_START_KEY, OCR_END_KEY, OCR_START_SLIDES_KEY, OCR_END_SLIDES_KEY,
    ]);
    const s = (d && d[PA_SETTINGS_KEY]) || {};
    const iv = (v, fb) => { const n = parseInt(v, 10); return isNaN(n) ? fb : n; };
    const bb = (v, fb) => (v === true || v === false ? v : fb);
    // Старый формат (одна галка текста + одна речи + режим видео) читается и
    // раскладывается в четыре независимых переключателя: пользователь мог ничего
    // не трогать, а молча получить «всё выключено» — хуже настройки не бывает.
    const legacyText = s.doText !== false;
    const legacyVoice = s.doVoice !== false;
    const legacyMode = ['both', 'asr', 'ocr', 'none'].indexOf(s.videoMode) >= 0 ? s.videoMode : 'both';
    return {
      count: Math.min(20, Math.max(1, iv(d && d[PA_COUNT_KEY], 5))),
      doMeta: s.doMeta !== false,
      // Описание картинок по умолчанию ВЫКЛЮЧЕНО: запросы те же, но ответы длиннее,
      // а без нейронки (облачного ключа или локальной модели) от него вообще нет толка.
      doVision: s.doVision === true,
      // Что читать, решается ПО ТИПУ публикации.
      photoOcr: bb(s.photoOcr, legacyText),
      slidesOcr: bb(s.slidesOcr, legacyText),
      videoOcr: bb(s.videoOcr, legacyText && legacyMode !== 'asr' && legacyMode !== 'none'),
      videoVoice: bb(s.videoVoice, legacyVoice && legacyMode !== 'ocr' && legacyMode !== 'none'),
      // Кадров на окно (начало и конец считаются отдельно): всего запросов = 2×N.
      videoFrames: Math.min(8, Math.max(1, iv(s.videoFrames, 3))),
      // «Закрепы под микроскопом»: вердикт vision-модели по каждому закреплённому
      // видео + множитель времени на его чтение (окна и кадры). По умолчанию ВЫКЛ —
      // иначе молча тратились бы лишние запросы на каждом прогоне.
      pinScan: s.pinScan === true,
      // «🖼 превью видео» по умолчанию ВЫКЛ: +1 запрос нейронки на каждое видео.
      videoPreview: s.videoPreview === true,
      // «🧬 формат кадра» по умолчанию ВЫКЛ: +1 запрос нейронки на каждое видео.
      frameFormat: s.frameFormat === true,
      pinAttention: Math.min(3, Math.max(1, iv(s.pinAttention, 2))),
      startSec: iv(d && d[OCR_START_KEY], 7),
      // «🎭 Тип контента»: быстрый аудит по первому кадру начала каждого поста. По
      // умолчанию ВЫКЛ (тратит запрос нейронки). auditPosts — сколько верхних постов
      // сетки взять в аудит (больше, чем основной разбор: «стоит 6 → чекает 12»).
      contentAudit: s.contentAudit === true,
      auditPosts: Math.min(20, Math.max(1, iv(s.auditPosts, 10))),
      // «🎧 в аудите слушать аудио»: по умолчанию ВКЛ (иначе тип контента не слышит
      // музыку/речь). Снять галку — аудит станет быстрее: без ASR на каждый видео-пост.
      auditAudio: s.auditAudio !== false,
      // Сколько секунд ждать загрузку видео в аудите перед съёмкой кадров.
      // 0 — не ждать (битый рилс пропускать сразу), больше — дольше даём догрузиться.
      auditWaitSec: Math.min(15, Math.max(0, iv(s.auditWaitSec, 2))),
      // «🛡 анти-залипание видео» по умолчанию ВКЛ: чинит реальный баг (рилс не стартует
      // в unfocused-окне → пустой разбор). Побочка — окно лезет наверх; если мешает, снимается галкой.
      videoGuard: s.videoGuard !== false,
      endSec: iv(d && d[OCR_END_KEY], 7),
      startSlides: iv(d && d[OCR_START_SLIDES_KEY], 2),
      endSlides: iv(d && d[OCR_END_SLIDES_KEY], 2),
    };
  }

  // TG-профиль в разборе: отображаемое имя, @юзернейм и описание со страницы t.me.
  // Нужен, чтобы экспертная ИИшка обращалась к лиду не по транслиту IG-ника
  // («Dansor» → «дансор»), а по настоящему имени из ТГ («Даниил Сорокин»).
  // Разбор не блокирует: карточка едет параллельно сетке; не вышла — честная строка.
  // Возвращает { text, name, kind }: text — блок в разбор, name/kind — вход для
  // leadFirstName (qualify.js), который и решит, как обращаться к человеку.
  async function igxPaTgProfileBlock(username, rawHint) {
    let rec = null;
    try { rec = await getProfile(username); } catch (_) {}
    let raw = String(rawHint || '');
    if (!raw && rec && rec.telegram) raw = String(rec.telegram);
    const lines = ['═══ TG-ПРОФИЛЬ ═══'];
    // Имя берём из живой карточки, а если t.me молчит — из того, что воркер уже
    // сохранил при проверке TG (tgName пишется только для личных аккаунтов).
    const out = { text: '', name: rec && rec.tgName ? String(rec.tgName) : '', kind: rec && rec.tgKind ? String(rec.tgKind) : '' };
    if (!raw) {
      lines.push('TG-контакт в профиле не найден — описывать нечего.');
      out.name = ''; out.kind = '';
      out.text = lines.join('\n');
      return out;
    }
    let r = null;
    try { r = await igxSend({ type: 'tgProfileInfo', raw }, 20000); } catch (_) {}
    const i = r && r.ok ? r.info : null;
    if (!i) {
      lines.push('Контакт: ' + raw);
      lines.push('TG-профиль не удалось прочитать (t.me не ответил).');
      if (out.name) lines.push('Имя из сохранённой карточки TG: ' + out.name);
      out.text = lines.join('\n');
      return out;
    }
    if (i.kind === 'none') {
      lines.push('Юз не найден: по контакту ' + raw + ' профиля в Telegram нет.');
      out.name = ''; out.kind = 'none';
    } else if (i.kind === 'channel') {
      lines.push('Это канал' + (i.name ? ' «' + i.name + '»' : '') + (i.subscribers ? ', ' + i.subscribers : '') + ' — личка здесь не найдена.');
      out.name = ''; out.kind = 'channel';
    } else if (i.kind === 'bot') {
      lines.push('Это бот' + (i.name ? ' «' + i.name + '»' : '') + '.');
      out.name = ''; out.kind = 'bot';
    } else {
      if (i.name) lines.push('Имя в TG (отображаемое): ' + i.name);
      if (i.user) lines.push('Юзернейм TG: @' + i.user);
      if (i.name) out.name = String(i.name);
      out.kind = 'user';
    }
    if (i.bio) lines.push('Описание TG-профиля: ' + i.bio);
    out.text = lines.join('\n');
    return out;
  }

  // «КАК ОБРАЩАТЬСЯ» — отдельным блоком и ПЕРВЫМ после шапки Instagram. Модель по
  // разбору пишет лиду письмо, и одно неверное имя обесценивает весь текст: реальный
  // случай — в TG «Александр Гурьев», улетело «Алексей», лид ответил «я не Алексей».
  // Раньше здесь стояло «сверь оба имени и бери то, что похоже на настоящее» — то есть
  // выбор отдавали модели, а у неё в руках ещё и bio, посты и комментарии с чужими
  // именами. Теперь имя считает код, модели достаётся одна строка-факт с запретом.
  function igxPaNameBlock(who) {
    const w = who || { name: '', src: '', known: false, like: false, alt: '' };
    const L = ['═══ КАК ОБРАЩАТЬСЯ ═══'];
    if (!w.name) {
      L.push('Имя для обращения: НЕИЗВЕСТНО');
      L.push('Начни без имени: «Привет!» / «Здравствуй!». Подставлять первое попавшееся слово из текста нельзя: лид ответит «я не X», и разбор полетит в спам.');
      return L.join('\n');
    }
    L.push('Имя для обращения: ' + w.name);
    L.push('Его посчитал код ' + (w.src === 'tg' ? 'из отображаемого имени Telegram-аккаунта (личка)' : 'из шапки Instagram — в Telegram настоящее имя не читается') + '. В приветствии используй ТОЛЬКО его.');
    if (!w.known && !w.like) L.push('Имя редкое или похоже на ник: если есть сомнение — напиши «Привет!» без имени. Ошибка в имени дороже, чем отсутствие обращения.');
    if (w.alt) L.push('В ' + (w.src === 'tg' ? 'шапке Instagram' : 'Telegram') + ' этот профиль подписан как «' + w.alt + '» — это НЕ имя для обращения (ниша, бренд, кличка или чужое имя из отзыва). В письме не используй.');
    L.push('Доставать имя из bio, постов, сторис, комментариев, названий актуальных, домена сайта или из @юзернейма — ЗАПРЕЩЕНО. Допустимых варианта два: имя выше или «Привет» без имени.');
    return L.join('\n');
  }

  // Итог автоанализа: разбор уходит в Telegram (tgPaReport) и дописывается в джоб.
  // Отдельно от ручного прогона, потому что здесь результат ждёт не человек у экрана,
  // а очередь: без записи в историю вкладка «пропала бы молча».
  async function igxPaAutoReport(jobId, username, report, frames, vids, types) {
    let rec = null;
    try { rec = await getProfile(username); } catch (_) {}
    const tg = rec && rec.telegram ? String(rec.telegram) : '';
    const d = await safeStorageGet([PAA_SEND_KEY]);
    const wantSend = !d || d[PAA_SEND_KEY] !== false;
    const patch = { finishedAt: Date.now(), frames, vids: vids || 0, types: types || null, chars: report.length, report: String(report || '').slice(0, 6000), tg, sentToTg: false };
    if (!wantSend) {
      patch.status = 'skipped';
      patch.reason = 'отправка в TG выключена на второй странице';
      await paJobPatch(jobId, patch);
      return patch;
    }
    try {
      const r = await igxSend({ type: 'tgPaReport', username, telegram: tg, text: report }, 120000);
      if (r && r.ok) patch.status = 'sent';
      else { patch.status = 'failed'; patch.reason = (r && r.error) || 'воркер не отправил'; }
      patch.sentToTg = !!(r && r.ok);
    } catch (e) {
      patch.status = 'failed';
      patch.reason = String((e && e.message) || e);
    }
    // Штамп в профиле: дашборд следит за igx_profile:* и по tgRealAt/paAt, — без него
    // автоанализ не попал бы в шторку уведомлений (джоб лежит отдельным ключом).
    // Пишем точечно поверх свежепрочитанной записи, не через saveProfile:
    // он обогатил бы кэш, а здесь важна только одна пара полей.
    try {
      const u = String(username || '').toLowerCase();
      const key = profileKey(u);
      const fresh = await chrome.storage.local.get(key);
      const cur = (fresh && fresh[key]) || rec || { username: u };
      await chrome.storage.local.set({ [key]: Object.assign({}, cur, { paAt: patch.finishedAt, paFrames: frames, paVids: vids || 0, paTypes: types || null }) });
    } catch (_) {}
    await paJobPatch(jobId, patch);
    return patch;
  }

  // ───────── ручное «дополнение к разбору»: комбо, поле, отправка ─────────
  // Приведённая строка клавиш: 'ctrl+alt+keyn' / 'f2' (без модификаторов — голоая клавиша).
  function igxPaComboFromEvent(e) {
    const k = e.key;
    if (!k || ['Control', 'Alt', 'Shift', 'Meta', 'OS'].indexOf(k) >= 0) return '';
    const parts = [];
    if (e.ctrlKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    if (e.metaKey) parts.push('meta');
    const main = String(e.code || k || '').toLowerCase();
    return parts.length ? parts.join('+') + '+' + main : main;
  }
  // Человекочитаемый вид для поля настройки: 'alt+keyn' → 'Alt+N'.
  function igxPaFriendlyCombo(c) {
    if (!c) return '';
    const map = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' };
    return String(c).split('+').map((p) => {
      if (map[p]) return map[p];
      if (/^key[a-z]$/.test(p)) return p.slice(3).toUpperCase();
      if (/^digit\d$/.test(p)) return p.slice(5);
      if (/^arrow/.test(p)) return p.charAt(5).toUpperCase() + p.slice(6);
      return p.toUpperCase();
    }).join('+');
  }
  // Блок-дополнение для вставки в конец разбора (заголовок тот же, что и в дописке «поверх»).
  function igxPaNotesBlock() {
    if (!igxPaNotes.length) return '';
    const lines = ['═══ ✍ ДОПОЛНЕНИЕ ОТ ВАС ═══'];
    for (const n of igxPaNotes) lines.push(String(n.text));
    return lines.join('\n\n');
  }
  // Профиль изменился — прошлые заметки относились к другому: чистим список и черновик.
  function igxPaNoteUserSync() {
    const u = extractUsername(location.pathname) || '';
    if (u !== _paNoteUser) {
      _paNoteUser = u;
      igxPaNotes = [];
      if (igxPaNotePop) { const ta = igxPaNotePop.querySelector('.igx-pa-note-text'); if (ta) ta.value = ''; }
      igxPaNoteRefreshList();
    }
    return u;
  }
  function igxPaNoteRefreshList() {
    const box = igxPaNotePop; if (!box) return;
    const list = box.querySelector('.igx-pa-note-list'); if (!list) return;
    list.textContent = '';
    for (const n of igxPaNotes) {
      const d = document.createElement('div'); d.className = 'igx-pa-note-item'; d.textContent = String(n.text);
      list.appendChild(d);
    }
  }
  function igxPaNoteRefreshKeyInputs() {
    const inp = igxPaPop && igxPaPop.querySelector('.igx-pa-notekey');
    if (inp && !_igxPaNoteCapturing) inp.value = igxPaNoteKey ? igxPaFriendlyCombo(igxPaNoteKey) : '';
  }
  function igxPaNoteInitDrag(pop) {
    const head = pop.querySelector('.igx-pa-note-head');
    if (!head) return;
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = pop.getBoundingClientRect(); ox = r.left; oy = r.top;
      pop.style.left = ox + 'px'; pop.style.top = oy + 'px'; pop.style.right = 'auto'; pop.style.bottom = 'auto';
      try { head.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    head.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      pop.style.left = Math.max(6, Math.min(window.innerWidth - pop.offsetWidth - 6, ox + (e.clientX - sx))) + 'px';
      pop.style.top = Math.max(6, Math.min(window.innerHeight - pop.offsetHeight - 6, oy + (e.clientY - sy))) + 'px';
    });
    const end = (e) => { dragging = false; try { head.releasePointerCapture(e.pointerId); } catch (_) {} };
    head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end);
  }
  // Плавающее поле заметки — СВОЙ узел на body (не часть панели). Instagram-модалка видео
  // его не трогает, а панель может скрываться/перерисовываться — здесь текст живёт спокойно.
  function igxPaNoteEnsure() {
    if (igxPaNotePop && document.body.contains(igxPaNotePop)) return igxPaNotePop;
    const box = document.createElement('div');
    box.className = 'igx-pa-note';
    box.innerHTML =
      '<div class="igx-pa-note-head"><span>✍ Дополнение к разбору</span><button type="button" class="igx-pa-note-close" title="Скрыть (или та же клавиша)">✕</button></div>' +
      '<div class="igx-pa-note-sub">Пока идёт разбор — впишите то, что нейронка не увидела. «➕ Добавить» — и это уйдёт в конец разбора (в Telegram / в буфер). Черновик не пропадёт, даже если свернётся видео.</div>' +
      '<div class="igx-pa-note-list"></div>' +
      '<textarea class="igx-pa-note-text" rows="4" placeholder="Ваши наблюдения… (Ctrl/⌘+Enter — добавить)"></textarea>' +
      '<div class="igx-pa-note-foot"><span class="igx-pa-note-hint"></span><button type="button" class="igx-pa-note-send">➕ Добавить в разбор</button></div>';
    document.body.appendChild(box);
    ['pointerdown', 'mousedown', 'click'].forEach((ev) => box.addEventListener(ev, (e) => e.stopPropagation()));
    box.querySelector('.igx-pa-note-close').addEventListener('click', () => igxPaNoteHide());
    box.querySelector('.igx-pa-note-send').addEventListener('click', () => igxPaNoteSend());
    const ta = box.querySelector('.igx-pa-note-text');
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation(); // печать в поле не должна ловить глобальный хоткей/лать Instagram
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); igxPaNoteSend(); }
    });
    igxPaNoteInitDrag(box);
    igxPaNotePop = box;
    igxPaNoteRefreshList();
    return box;
  }
  function igxPaNoteShow() {
    igxPaNoteUserSync();
    const box = igxPaNoteEnsure();
    box.classList.add('is-on');
    const ta = box.querySelector('.igx-pa-note-text');
    if (ta) ta.focus();
    igxPaNoteRefreshList();
  }
  function igxPaNoteHide() { if (igxPaNotePop) igxPaNotePop.classList.remove('is-on'); }
  function igxPaNoteToggle() {
    if (igxPaNotePop && igxPaNotePop.classList.contains('is-on')) igxPaNoteHide();
    else igxPaNoteShow();
  }
  // Разбор уже показан (прогон завершился) — дописываем заметку в конец поля результата,
  // чтобы её можно было скопировать. Заголовок добавляем один раз.
  function igxPaNoteAppendLive(text) {
    if (!igxPaPop) return;
    const rt = igxPaPop.querySelector('.igx-pa-result-text');
    if (!rt || !rt.value) return;
    const hdr = '═══ ✍ ДОПОЛНЕНИЕ ОТ ВАС ═══';
    if (rt.value.indexOf(hdr) < 0) rt.value += '\n\n' + hdr + '\n\n' + text;
    else rt.value += '\n\n' + text;
  }
  // Автопрогон: разбор мог уйти в TG ДО того, как человек добавил заметку — шлём её
  // отдельным «➕ дополнением», чтобы она не потерялась.
  async function igxPaNoteFollowUpTg(text) {
    if (!igxPaCurRun || !igxPaCurRun.auto || !igxPaCurRun.username) return;
    try {
      const d = await safeStorageGet([PAA_SEND_KEY]);
      if (d && d[PAA_SEND_KEY] === false) return;
      let rec = null; try { rec = await getProfile(igxPaCurRun.username); } catch (_) {}
      const tg = rec && rec.telegram ? String(rec.telegram) : '';
      const body = '➕ ДОПОЛНЕНИЕ ОТ ВАС к разбору @' + igxPaCurRun.username + ':\n\n' + text;
      const r = await igxSend({ type: 'tgPaReport', username: igxPaCurRun.username, telegram: tg, text: body }, 120000);
      if (r && r.ok && igxPaCurRun.jobId) {
        igxPaCurRun.notesSent = (igxPaCurRun.notesSent || []).concat(text);
        try { await paJobPatch(igxPaCurRun.jobId, { noteSupplement: igxPaCurRun.notesSent }); } catch (_) {}
      }
    } catch (_) {}
  }
  function igxPaNoteSend() {
    igxPaNoteUserSync();
    const box = igxPaNoteEnsure();
    const ta = box.querySelector('.igx-pa-note-text');
    const text = String((ta && ta.value) || '').trim();
    if (!text) return;
    igxPaNotes.push({ text, at: Date.now() });
    if (ta) ta.value = '';
    igxPaNoteRefreshList();
    const hint = box.querySelector('.igx-pa-note-hint');
    if (hint) {
      hint.textContent = igxPaRunning ? '✓ добавлено — уйдёт в конец разбора' : '✓ добавлено в разбор';
      setTimeout(() => { if (hint) hint.textContent = ''; }, 2500);
    }
    // Пока разбор НЕ показан (идёт) — заметку подберёт сборка отчёта. Если уже показан —
    // дописываем «поверх» и (для авто) шлём дополнением в TG.
    if (_paReportShown) { igxPaNoteAppendLive(text); igxPaNoteFollowUpTg(text); }
  }
  // Глобальный перехват: запись новой клавиши в настройках + сам хоткей. Capture-фаза —
  // чтобы опередить обработчики Instagram. В поле заметки/в поле настройки не вмешиваемся.
  function igxPaNoteKeyHandler(e) {
    if (_igxPaNoteCapturing) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { _igxPaNoteCapturing = false; igxPaNoteRefreshKeyInputs(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { igxPaNoteKey = ''; }
      else { const c = igxPaComboFromEvent(e); if (c) igxPaNoteKey = c; }
      _igxPaNoteCapturing = false;
      safeStorageSet({ [PA_NOTEKEY_KEY]: igxPaNoteKey });
      igxPaNoteRefreshKeyInputs();
      return;
    }
    if (!igxPaNoteKey) return;
    const combo = igxPaComboFromEvent(e);
    if (!combo || combo !== igxPaNoteKey) return;
    const t = e.target;
    if (t && igxPaNotePop && igxPaNotePop.contains(t)) return;
    // Не перехватываем набор текста в чужих полях (поиск/комменты Instagram): если бинд —
    // голоая буква, иначе она бы дёргала окно заметки вместо печати. С модификатором — ок.
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      const hasMod = e.ctrlKey || e.altKey || e.metaKey || e.shiftKey;
      if (!hasMod) return;
    }
    e.preventDefault(); e.stopPropagation();
    igxPaNoteToggle();
  }
  document.addEventListener('keydown', igxPaNoteKeyHandler, true);
  // Ранняя загрузка клавиши (работает и до сборки панели). Заданной нет — дефолт Alt+N.
  safeStorageGet([PA_NOTEKEY_KEY]).then((d) => {
    const v = d && d[PA_NOTEKEY_KEY];
    igxPaNoteKey = (v === undefined || v === null) ? 'alt+keyn' : String(v || '');
    igxPaNoteRefreshKeyInputs();
  }).catch(() => {});
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch[PA_NOTEKEY_KEY]) { igxPaNoteKey = String(ch[PA_NOTEKEY_KEY].newValue || ''); igxPaNoteRefreshKeyInputs(); }
    });
  } catch (_) {}

  async function igxPaRun(opts) {
    const auto = !!(opts && opts.auto);
    const jobId = (opts && opts.jobId) || '';
    if (igxPaRunning) {
      // «уже идёт» — это отказ, а не тишина: без записи прогон выглядел бы как «вкладка сдохла».
      if (auto) await paJobPatch(jobId, { status: 'skipped', reason: 'на этой вкладке уже идёт разбор', finishedAt: Date.now() });
      return;
    }
    const username = extractUsername(location.pathname);
    if (!username || igxPaModalOpen()) {
      if (auto) await paJobPatch(jobId, { status: 'skipped', reason: 'страница профиля не открылась (модалка или редирект)', finishedAt: Date.now() });
      return;
    }
    // Крестик на панели — воля пользователя, а не наша: на этом профиле не лезем.
    if (auto && igxPaDismissedFor === username) {
      await paJobPatch(jobId, { status: 'skipped', reason: 'панель анализатора закрыта вручную на этом профиле', finishedAt: Date.now() });
      return;
    }
    // ТГК последний рубеж: вердикт «по контакту лички нет» мог появиться уже после
    // отбора на дашборде (параллельная ревизия, легаси-запись в базе) — дешевле
    // скипнуть сейчас, чем 5 минут смотреть видосы в пустоту. В режиме «не трогать»
    // не гейтим — это явная воля пользователя.
    if (auto) {
      let gate = 'skip';
      try {
        const dg = await safeStorageGet(['igx_paa_tgk']);
        const v = dg && dg['igx_paa_tgk'];
        if (v === 'off' || v === 'probe' || v === 'skip') gate = v;
      } catch (_) {}
      if (gate !== 'off') {
        let rec = null;
        try { rec = await getProfile(username); } catch (_) {}
        if (rec) {
          const badWhy = rec.tgReal === false ? 'юз не жив' :
            rec.tgKind === 'channel' ? 'это канал, юзу нет' :
            rec.tgKind === 'bot' ? 'это бот' :
            rec.tgKind === 'none' ? 'юз не найден проверкой' : '';
          if (badWhy) {
            await paJobPatch(jobId, { status: 'skipped', reason: 'ТГК: ' + badWhy + ' — разбор пропущен на вкладке', finishedAt: Date.now() });
            return;
          }
        }
      }
    }
    igxPaRunning = true;
    // Контекст прогона для ручного дополнения: заметка, добавленная уже ПОСЛЕ отправки,
    // уйдёт отдельным «➕» в TG. Показ разбора сбрасываем; заметки чистим лишь при смене
    // профиля (черновик в поле при этом не трогаем).
    igxPaCurRun = { username, jobId, auto, finished: false, notesSent: [] };
    _paReportShown = false;
    igxPaNoteUserSync();
    // Пульс живости: каждые 15с помечаем джоб «я жива», пока крутится разбор. Дашборд
    // по нему отличает «вкладка молотит медленно» от «вкладка замёрзла/сдохла» и не
    // убивает медленный, но ЖИВОЙ профиль плоским таймаутом.
    let paBeatTimer = 0;
    if (auto && jobId) {
      try { paJobPatch(jobId, { beat: Date.now() }).catch(() => {}); } catch (_) {}
      paBeatTimer = setInterval(() => { try { paJobPatch(jobId, { beat: Date.now() }).catch(() => {}); } catch (_) {} }, 15000);
    }
    igxAcquireWakeLock().catch(() => {}); // не спим, пока разбираем
    const pop = ensureProfileAnalyzer();
    const statusEl = pop.querySelector('.igx-pa-status');
    const resWrap = pop.querySelector('.igx-pa-result-wrap');
    const resText = pop.querySelector('.igx-pa-result-text');
    const runBtn = pop.querySelector('.igx-pa-run');
    if (runBtn) runBtn.disabled = true;
    try {
      const st = await igxPaReadSettings();
      _paGuardOn = !!st.videoGuard; // watchdog анти-залипания активен весь прогон
      _paGuardLastFocus = 0;
      if (_paGuardOn) igxStartAudioKeepAlive().catch(() => {}); // неслышимый якорь: вкладку не морозит
      const apiKey = (await safeStorageGet([OCR_APIKEY_KEY]))[OCR_APIKEY_KEY] || '';
      await igxLocalWarmIfNeeded(apiKey,
        (t) => igxPaSetStatus(statusEl, t),
        // Греем локальную модель только если хоть что-то из картинок реально пойдёт:
        // фото, слайды, кадры или кадр-коллаж аудита. При «только речь» греть зазря —
        // ждать лишние секунды за результат, который читает облако.
        st.photoOcr || st.slidesOcr || st.videoOcr || st.contentAudit);

      igxPaSetStatus(statusEl, 'Считаю шапку профиля…');
      const header = igxPaCollectHeader(username);
      // Карточку TG-профиля тянем ПАРАЛЛЕЛЬНО сетке и постам: t.me отвечает за
      // секунду, незачем сериализовать её с пятиминутным разбором.
      const tgBlockP = igxPaTgProfileBlock(username, header.telegram);

      igxPaSetStatus(statusEl, 'Ищу посты в сетке…');
      // Сетку догружаем под САМЫЙ широкий проход: аудит берёт больше постов, чем
      // основной разбор, и без этого «аудит 12» честно упирался в ~10 видимых тайлов.
      await igxPaEnsureTiles(st.contentAudit ? Math.max(st.count, st.auditPosts) : st.count);
      const tiles = igxPaCollectTiles();
      // Подсказка «по порядку сетки» считается ДО разбора и по ВСЕМ собранным тайлам,
      // а не по разобранным: при st.count=3 на профиле с тремя закрепиными хвоста из
      // разбираемых постов просто нет — и возрастной признак не мог сработать в принципе.
      const orderPinN = igxPaOrderPrefixPinned(tiles.map((t) => t.days));
      for (let i = 0; i < orderPinN && i < tiles.length; i++) tiles[i].pinOrder = true;
      // Сетка Instagram уже упорядочена: закрепы стоят ПЕРВЫМИ, поэтому «первые N тайлов»
      // — это и есть нужное нам множество (лимит «не больше N» соблюдается автоматически).
      // Распознанные по метке на всякий случай поднимаем в начало.
      const chosen = tiles.slice(0, st.count);
      chosen.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
      // Шаг в джоб: дашборд ловит изменение igx_paa_job:* и показывает в шторке,
      // ЧТО именно разбор делает сейчас, а не абстрактное «разбирает профиль».
      if (auto) await paJobPatch(jobId, { step: { at: Date.now(), title: 'открыл профиль, смотрю ' + chosen.length + ' публикац.', snippet: '' } });
      const pinProbe = tiles.length ? igxPaTileLabelsText(tiles[0].el) : 'тайлов в сетке нет';
      // Вторая строка самодиагностики: возраста тайлов. По ней видно, отдаёт ли IG в
      // сетке <time datetime> вовсе (прочерк = не отдаёт) и где именно ломается порядок.
      const ageProbe = igxPaTilesAgesText(tiles);

      const analyzed = [];
      for (let i = 0; i < chosen.length; i++) {
        igxPaSetStatus(statusEl, `Разбираю публикацию ${i + 1}/${chosen.length}…`);
        const r = await igxPaProcessTile(chosen[i], st, apiKey, statusEl);
        analyzed.push({ tile: chosen[i], text: r.text, days: r.days, pinned: r.pinned, vid: !!chosen[i].vid, kind: r.kind || (chosen[i].vid ? 'video' : 'none'), verdict: r.verdict || '', frameFormat: r.frameFormat || '', preview: r.preview || '' });
        if (auto) {
          const tl = chosen[i];
          const kd = r.kind || (tl.vid ? 'video' : 'none');
          const isPin = !!(r.pinned || tl.pinned || tl.pinOrder);
          // Порядок глаголов важен: у закрепного видео с двумя галками первым идёт
          // всё-таки закреп (он главнее по смыслу прогона), формат — следом.
          const actV = isPin ? 'посмотрел закреп' : (r.preview || r.frameFormat) ? 'посмотрел превью/формат' : kd === 'carousel' ? 'проверил карусель' : kd === 'video' ? 'разобрал видео' : kd === 'photo' ? 'разобрал фото' : 'заглянул в пост';
          const snip = String(r.text || '').replace(/\s+/g, ' ').trim() || (r.verdict ? String(r.verdict) : 'текста не извлёк');
          await paJobPatch(jobId, { step: {
            at: Date.now(),
            title: actV + ' ' + (i + 1) + '/' + chosen.length,
            snippet: snip.length > 200 ? snip.slice(0, 200) + '…' : snip,
          } });
        }
      }

      // «🎭 Тип контента»: точный проход идёт ПОСЛЕ основного разбора — он заново
      // открывает тайлы, но с каждого берёт только 2 кадра начала и свой ОДИН запрос.
      let auditLine = '';
      if (st.contentAudit) {
        try { auditLine = await igxPaContentAudit(tiles, st, apiKey, statusEl); }
        catch (e) { igxOcrNote('аудит типа контента не вышел: ' + igxPaErrMsg(e)); }
      }

      // Закрепы: сначала по метке (надёжнее), потом по ПОРЯДКУ сетки (старший пост стоит
      // перед более свежими, а хвост после него упорядочен), и лишь потом по возрасту
      // разобранных постов — этот путь живёт только при включённых метриках.
      const labeled = analyzed.filter((a) => a.pinned);
      let pinHow = 'по метке';
      let pinnedIdx;
      if (labeled.length) {
        pinnedIdx = new Set(labeled.map((a) => a.tile.code));
      } else if (orderPinN) {
        pinnedIdx = new Set(tiles.slice(0, orderPinN).map((t) => t.code));
        pinHow = 'по порядку сетки';
      } else {
        const n = igxPaAgePrefixPinned(analyzed.map((a) => a.days));
        pinnedIdx = new Set(analyzed.slice(0, n).map((a) => a.tile.code));
        if (n) pinHow = 'по возрасту';
      }
      const pinItems = analyzed.filter((a) => pinnedIdx.has(a.tile.code));
      const lastItems = analyzed.filter((a) => !pinnedIdx.has(a.tile.code));

      const blocks = [igxPaHeaderBlock(header, st)];
      // Карточка TG тянулась параллельно сетке — к этому моменту она уже готова.
      // Первым идёт блок «КАК ОБРАЩАТЬСЯ»: имя для обращения решает код (qualify.js),
      // а не модель — иначе она выбирает его из двух кандидатов мимо.
      let tgCard = null;
      try { tgCard = await tgBlockP; } catch (_) {}
      const who = typeof leadFirstName === 'function'
        ? leadFirstName({ fullName: header.fullName, tgName: tgCard ? tgCard.name : '', tgKind: tgCard ? tgCard.kind : '' })
        : { name: '', src: '', known: false, like: false, alt: '' };
      blocks.push(igxPaNameBlock(who));
      if (tgCard && tgCard.text) blocks.push(tgCard.text);

      const pinBlock = ['═══ ЗАКРЕПЛЁННЫЕ ═══'];
      if (!pinItems.length) {
        pinBlock.push('Закрепов нет.' + (st.doMeta ? '' : ' (метрики выключены — по возрасту разобранных не проверить)'));
        // Честная диагностика: какие подписи расширение вообще видит в первом тайле —
        // по ним видно, какой разметкой Instagram помечает закреп сейчас.
        pinBlock.push(`(диагностика сетки: ${pinProbe})`);
        pinBlock.push(`(возраст тайлов, дни: ${ageProbe})`);
      }
      for (let i = 0; i < pinItems.length; i++) {
        pinBlock.push(`— ${i + 1} закреп (${pinHow}) —\n${pinItems[i].text}`);
      }
      blocks.push(pinBlock.join('\n\n'));

      const lastBlock = [`═══ ПОСЛЕДНИЕ ПУБЛИКАЦИИ (${lastItems.length}) ═══`];
      if (!lastItems.length) lastBlock.push('Свежих постов не найдено.');
      for (let i = 0; i < lastItems.length; i++) {
        const label = i === 0 ? 'Последний пост' : `Следующий пост (${i + 1})`;
        lastBlock.push(`— ${label} —\n${lastItems[i].text}`);
      }
      blocks.push(lastBlock.join('\n\n'));

      // Краткий итог в КОНЦЕ разбора: что нейронка насмотрела в закреплённых видео
      // и стоит ли об этом говорить в рассылке. Без выдумок: не-видео закрепам
      // вердикта нет — читаем их текст в блоке закрепов выше.
      if (st.pinScan) {
        const pinSum = ['═══ В ЗАКРЕПАХ ═══'];
        // Перекрёстный вывод: если вердикты закрепов слабые («в рассылку: не стоит»),
        // а по НАЗВАНИЯМ актуалок видно, что кейсы/разборы/отзывы живут там, —
        // честно пишем «вся инфа в актуальных, закрепы пустые», чтобы в рассылке
        // ссылкой брал актуалки, а не закрепы.
        const hlEv = igxHlEvidenceTitles(header.highlights);
        const hlList = hlEv.map((t) => `«${t}»`).join(', ');
        if (!pinItems.length) {
          pinSum.push('Закрепов нет — подводить итог не по чему.'
            + (hlEv.length ? ` Вся конкретика (кейсы/отзывы/разборы) — в актуальных: ${hlList}; в рассылке ссылаться имеет смысл на них.` : ''));
        } else {
          for (const a of pinItems) {
            if (a.verdict) pinSum.push('• ' + a.verdict);
            else if (a.vid) pinSum.push('• Закреплённое видео: вердикт не получен (смотри предупреждения выше).');
            else pinSum.push('• Закреп не видео — вердикта по кадрам нет, текст читаем в блоке закрепов выше.');
          }
          const verdicts = pinItems.map((a) => a.verdict).filter(Boolean);
          // «Пустые» закрепы = хотя бы один вердикт есть, и НИ в одном нет «в рассылку:
          // стоит». (Вердикт «не стоит» содержит слово «стоит», поэтому ловим именно
          // позитив «: стоит» с запретом на предшествующее «не ».)
          const anyWorth = verdicts.some((v) => /в рассылку:\s*стоит/i.test(v) && !/в рассылку:\s*не стоит/i.test(v));
          const pinsWeak = verdicts.length > 0 && !anyWorth;
          if (pinsWeak && hlEv.length) {
            pinSum.push('➕ Итог: в закрепах конкретики нет (вердикты: «не стоит»), зато по названиям актуальных видно, что вся инфа там: ' + hlList + '. В рассылке говорить про актуальные, закрепы не предлагать.');
          }
        }
        blocks.push(pinSum.join('\n'));
      }

      // Вердикт аудита — последним блоком: коротко «что тут снимают», чтобы решать,
      // в каком тоне писать рассылку, не заходя в профиль.
      if (st.contentAudit) {
        const aBlock = ['═══ ТИП КОНТЕНТА (аудит ' + Math.min(Math.max(1, Math.min(20, Number(st.auditPosts) || 10)), tiles.length) + ' постов) ═══'];
        aBlock.push(auditLine || 'Аудит не получился — причины в предупреждениях выше.');
        blocks.push(aBlock.join('\n'));
      }

      // Ручные заметки — ПОСЛЕДНИМ блоком: то, что нейронка не увидела, а человек дописал.
      const supplement = igxPaNotesBlock();
      if (supplement) blocks.push(supplement);

      const report = blocks.join('\n\n');
      if (resWrap) resWrap.style.display = 'block';
      if (resText) resText.value = report;
      _paReportShown = true; // заметки, добавленные теперь, дописываем «поверх» готового разбора
      if (auto) {
        // Разбивка «что именно посмотрели» — по факту открытого медиа, а не по бейджу
        // в сетке: без этого «просмотрел 2 видео» молча прятал карусели и фото-посты.
        const types = {
          video: analyzed.filter((a) => a.kind === 'video').length,
          carousel: analyzed.filter((a) => a.kind === 'carousel').length,
          photo: analyzed.filter((a) => a.kind === 'photo').length,
        };
        // Буфер обмена в автопрогоне не трогаем: вкладка фоновая, а человеку в другом
        // окне это подменило бы скопированное.
        const res = await igxPaAutoReport(jobId, username, report, analyzed.length, types.video, types);
        igxPaSetStatus(statusEl, res.status === 'sent'
          ? `✓ Разбор готов и отправлен в Telegram (${report.length} симв.)`
          : `Разбор готов — в TG не ушёл: ${res.reason || res.status}`);
      } else {
        const ok = await copyToClipboard(report);
        igxPaSetStatus(statusEl, ok ? '✓ Разбор готов и скопирован в буфер.' : '✓ Разбор готов — нажми «📋 Скопировать».');
      }
    } catch (e) {
      const why = String((e && e.message) || e);
      igxPaSetStatus(statusEl, 'Ошибка: ' + why);
      if (auto) await paJobPatch(jobId, { status: 'failed', reason: why, finishedAt: Date.now() });
    } finally {
      if (paBeatTimer) { try { clearInterval(paBeatTimer); } catch (_) {} }
      _paGuardOn = false;
      try { igxStopAudioKeepAlive(); } catch (_) {} // глушим неслышимый якорь
      igxReleaseWakeLock(); // разбор закончился (или упал) — отпускаем экран/систему
      if (runBtn) runBtn.disabled = false;
      igxPaRunning = false;
      if (igxPaCurRun) igxPaCurRun.finished = true;
    }
  }

  function igxPaInitDrag(pop) {
    const head = pop.querySelector('.igx-pa-head');
    if (!head) return;
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = pop.getBoundingClientRect(); ox = r.left; oy = r.top;
      pop.style.left = `${ox}px`; pop.style.top = `${oy}px`; pop.style.right = 'auto'; pop.style.bottom = 'auto';
      head.setPointerCapture?.(e.pointerId);
      pop.classList.add('is-dragging');
      e.preventDefault();
    });
    head.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const nl = Math.max(10, Math.min(window.innerWidth - pop.offsetWidth - 10, ox + (e.clientX - sx)));
      const nt = Math.max(10, Math.min(window.innerHeight - pop.offsetHeight - 10, oy + (e.clientY - sy)));
      pop.style.left = `${nl}px`; pop.style.top = `${nt}px`;
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false; pop.classList.remove('is-dragging');
      try { head.releasePointerCapture?.(e.pointerId); } catch (_) {}
      safeStorageSet({ [PA_POS_KEY]: { left: pop.style.left, top: pop.style.top } });
    };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  }

  function ensureProfileAnalyzer() {
    if (igxPaPop && document.body.contains(igxPaPop)) return igxPaPop;
    const pop = document.createElement('div');
    pop.className = 'igx-pa-pop';
    pop.innerHTML =
      '<div class="igx-pa-head"><span class="igx-pa-title">🔎 Анализатор профиля</span><button class="igx-pa-close" title="Свернуть до следующего профиля">✕</button></div>' +
      '<div class="igx-pa-field"><span title="Сколько верхних постов сетки разобрать. Закрепы всегда в начале списка, поэтому лимит «не больше N» соблюдается сам.">Последних публикаций разобрать:</span><input type="number" class="igx-pa-count" min="1" max="20" value="5"></div>' +
      '<label class="igx-pa-chk"><input type="checkbox" class="igx-pa-domet" checked> 📊 метрики (дни, просмотры, лайки…)</label>' +
      '<div class="igx-pa-matrix">' +
      '<div class="igx-pa-matrix-cap">🧩 что разбирать — по типу публикации</div>' +
      '<label class="igx-pa-chk" title="Одиночное фото поста: ОДИН запрос к распознавалке. С включённым «👁 описывать» тем же запросом приходит и описание картинки."><input type="checkbox" class="igx-pa-photo" checked> 🖼 фото — текст на картинке</label>' +
      '<label class="igx-pa-chk" title="Карусель: читаем первые и последние слайды (хук и призыв). Сколько слайдов с начала и с конца — в ⚙ настройках OCR."><input type="checkbox" class="igx-pa-slides" checked> 🎠 слайды карусели — текст со слайдов</label>' +
      '<label class="igx-pa-chk" title="С видео снимаем кадры с начала и с конца и читаем текст с них. Самый дорогой способ: по одному запросу на каждый кадр."><input type="checkbox" class="igx-pa-vocr" checked> 🎬 видео — текст с кадров</label>' +
      '<label class="igx-pa-chk" title="С видео слушаем звук: начало и концовка, ОДИН запрос на ролик. Речь читает облако (Groq Whisper); без облачного ключа включается крошечный локальный whisper-tiny — медленно и заметно хуже. Локальная vision-модель аудио не слушает."><input type="checkbox" class="igx-pa-voice" checked> 🎙 видео — речь из звука</label>' +
      '<div class="igx-pa-matrix-hint"></div>' +
      '</div>' +
      '<label class="igx-pa-chk" title="Просить нейросеть заодно коротко описать, что изображено на фото, слайдах и кадрах (кто в кадре и что происходит, 1–2 предложения). Запросов к API больше не становится — тот же запрос, только длиннее ответ. Нужна нейронка: облачный ключ (Groq/OpenAI) или локальная модель LM Studio; обычная распознавалка Tesseract картинок не видит."><input type="checkbox" class="igx-pa-dovision"> 👁 описывать и то, что на картинке (Vision)</label>' +
      '<label class="igx-pa-chk" title="Нейронка смотрит ОБЛОЖКУ (превью) каждого видео — кадр, который автор поставил обложкой. На ней часто крупно вынесена ТЕМА ролика, которой нет ни в подписи, ни в речи. В отчёте появится строка «На превью: …описание…; ТЕКСТ: …». Это +1 запрос на каждую видео-публикацию. Нужна нейронка; без неё — честная строчка в отчёте."><input type="checkbox" class="igx-pa-preview"> 🖼 превью видео — смотреть обложку (тема на ней)</label>' +
      '<label class="igx-pa-chk" title="Нейронка смотрит на ВИДЕО два кадра — самый начало (1 с) и концовку (3 с до конца) — и пишет в отчёт, как смонтирован ролик: сплит-экран (сверху человек говорит или качается, а снизу идёт чужой подкаст), окно-вставка, говорящая голова, демонстрация без речи, нарезка. Это +1 запрос-коллаж на каждое видео-публикацию. Нужна нейронка; без неё — честная строчка в отчёте."><input type="checkbox" class="igx-pa-format"> 🧬 формат кадра — начало и конец видео: сплит-экран, вставки, нарезка</label>' +
      '<label class="igx-pa-chk" title="Каждое закреплённое ВИДЕО получает дополнительное внимание: нейронка (локальная или облачная) смотрит сетку кадров по всему ролику и пишет в конце разбора короткий вердикт — есть там кейсы/разборы/результаты или мотивация-реклама, и стоит ли об этом говорить в рассылке. +1 запрос-коллаж на закреплённое видео. Без нейронки вердикта не будет."><input type="checkbox" class="igx-pa-pinscan"> 📌 закрепы под микроскопом — досматривать их видео и решать про рассылку</label>' +
      '<div class="igx-pa-field"><span title="Во сколько раз закреплённому видео уделяется больше времени, чем обычным: длиннее окна чтения (начало/конец), больше кадров и плотнее сетка для вердикта. 1 — как все, 3 — максимум внимания.">времени закрепам ×</span><input type="number" class="igx-pa-pinatt" min="1" max="3" step="1" value="2"></div>' +
      '<label class="igx-pa-chk" title="Точный аудит ТИПА КОНТЕНТА: каждый пост в выборке нейронка (локальная или облачная) смотрит ОТДЕЛЬНО — 2 кадра из начала видео плюс подпись поста — и пишет вердикт «жанр: …; в кадре: …» (экспертный / полуэкспертный / разговорный / демонстрация упражнений / рофл / лайфстайл / реклама…). В конце — подсчёт долей: «большая часть: рофл, поменьше: разговорный». Это +1 запрос нейронке на КАЖДЫЙ пост аудита — дольше, чем один коллаж, но различает «идёт и болтает» и «качается под музыку с плашками». Нужна нейронка."><input type="checkbox" class="igx-pa-caudit"> 🎭 тип контента — аудит каждого поста по началу</label>' +
      '<div class="igx-pa-field"><span title="Сколько верхних постов сетки взять в аудит типа контента. Можно больше, чем «разобрать публикаций»: лишние посты не читаются целиком — с них берётся 2 кадра из начала и на пост уходит ОДИН запрос нейронке. Длительность «начала» — окно старта из ⚙ настроек OCR.">постов в аудит</span><input type="number" class="igx-pa-auditn" min="1" max="20" step="1" value="10"></div>' +
      '<label class="igx-pa-chk" title="Слушать ли АУДИО в аудите типа контента: если включено, с каждого видео-поста аудита берётся короткий кусок начала и нейронка получает подсказку «что слышно: речь по делу / просто музыка» — так «болтает по теме» надёжнее отличается от «качается под музыку». Это +1 ASR-запрос на каждый видео-пост аудита (заметно медленнее). Сними галку — аудит станет быстрым: только 2 кадра + подпись."><input type="checkbox" class="igx-pa-aaudit" checked> 🎧 в аудите слушать аудио (точнее жанр, но +1 запрос на видео)</label>' +
      '<div class="igx-pa-field"><span title="Сколько секунд ждать ЗАГРУЗКИ видео в аудите перед съёмкой кадров. 0 — не ждать вовсе (незагруженный рилс сразу пропускается, аудит летит быстрее); больше — дольше даём плееру догрузиться у проблемных видео.">секунд ждать видео в аудите</span><input type="number" class="igx-pa-await" min="0" max="15" step="1" value="2"></div>' +
      '<label class="igx-pa-chk" title="🛡 Анти-залипание видео: Instagram часто ставит рилс на паузу и не даёт ему стартовать, пока окно не в фокусе — из-за этого кадры не грузятся и разбор «нихуя не анализирует», приходится вручную снимать видео с паузы. С галкой анализатор: поднимает своё окно наверх (не чаще раза в 4с), перезапускает плеер и грузит данные, пока видео не станет готов к съёмке. Плюс на время разбора вкладка играет почти неслышный тон — из-за этого Chrome не режет таймеры и не морозит фоновую вкладку (у вкладки будет значок 🔊 — это цена). ВНИМАНИЕ: окно будет лезть наверх само — если мешает, сними галку."><input type="checkbox" class="igx-pa-vguard" checked> 🛡 анти-залипание видео — поднимать окно, ре-стартовать плеер, не морозить вкладку</label>' +
      igxPromptEditorHtml() +
      '<div class="igx-pa-field"><span title="Сколько кадров снять с начала и с конца ролика. Работает только с галкой «🎬 видео — текст с кадров». Всего запросов к нейронке = 2 × это число на каждое видео.">кадров на окно (начало/конец)</span><input type="number" class="igx-pa-vframes" min="1" max="8" value="3"></div>' +
      '<div class="igx-pa-cost"></div>' +
      '<div class="igx-pa-field igx-pa-notekey-row"><span title="Горячая клавиша заметки. Во время разбора нажмите её — откроется поле, куда впишете то, что нейронка не увидела; заметка уйдёт в КОНЕЦ разбора (в Telegram и в буфер). Нажмите «задать» и нажмите нужную комбинацию (лучше с Alt или Ctrl). Esc — отменить, Backspace — сбросить.">✍ клавиша заметки:</span><input type="text" class="igx-pa-notekey" readonly placeholder="не задана"><button type="button" class="igx-pa-notekey-set">задать</button></div>' +
      '<button class="igx-pa-run">▶ Разобрать профиль</button>' +
      '<div class="igx-pa-status"></div>' +
      '<div class="igx-pa-result-wrap" style="display:none;">' +
      '<div class="igx-pa-result-head"><span>Результат:</span><button type="button" class="igx-pa-copy-btn">📋 Скопировать</button></div>' +
      '<textarea class="igx-pa-result-text" rows="10" readonly></textarea>' +
      '</div>';
    document.body.appendChild(pop);

    ['pointerdown', 'mousedown', 'click'].forEach((ev) => pop.addEventListener(ev, (e) => e.stopPropagation()));
    igxPaInitDrag(pop);
    igxWirePromptEditor(pop);

    const countInp = pop.querySelector('.igx-pa-count');
    const doMeta = pop.querySelector('.igx-pa-domet');
    const photoChk = pop.querySelector('.igx-pa-photo');
    const slidesChk = pop.querySelector('.igx-pa-slides');
    const vocrChk = pop.querySelector('.igx-pa-vocr');
    const voiceChk = pop.querySelector('.igx-pa-voice');
    const doVision = pop.querySelector('.igx-pa-dovision');
    const pinScanChk = pop.querySelector('.igx-pa-pinscan');
    const previewChk = pop.querySelector('.igx-pa-preview');
    const formatChk = pop.querySelector('.igx-pa-format');
    const pinAttInp = pop.querySelector('.igx-pa-pinatt');
    const cauditChk = pop.querySelector('.igx-pa-caudit');
    const auditNInp = pop.querySelector('.igx-pa-auditn');
    const aauditChk = pop.querySelector('.igx-pa-aaudit');
    const awaitInp = pop.querySelector('.igx-pa-await');
    const vguardChk = pop.querySelector('.igx-pa-vguard');
    const vframes = pop.querySelector('.igx-pa-vframes');
    const hintEl = pop.querySelector('.igx-pa-matrix-hint');
    const costEl = pop.querySelector('.igx-pa-cost');
    const paFrames = () => Math.max(1, Math.min(8, parseInt(vframes && vframes.value, 10) || 3));
    const paOn = (el) => !!(el && el.checked);
    // Стоимость прогона вслух. На бесплатном Groq лимит — входные токены в минуту,
    // одна картинка стоит ~2400, потолок ≈ 3 изображения/мин. Значит «кадров больше»
    // для пользователя равно не «точнее», а «минуты простоя» — пусть видит цену до старта.
    // Если хозяином поставили локальную модель, потолок снимается — и цена пересчитывается
    // по её скорости, а не по облаку (врать про минуты простоя, когда их нет, нельзя).
    const igxFmtDur = (sec) => (sec < 90 ? Math.round(sec) + ' с' : (sec / 60).toFixed(1) + ' мин');
    const plural = (n, one, few, many) => {
      const a = Math.abs(n) % 100, b = a % 10;
      if (a > 10 && a < 20) return many;
      if (b > 1 && b < 5) return few;
      if (b === 1) return one;
      return many;
    };
    const drawCost = () => {
      if (!costEl) return;
      // «Закрепы под микроскопом» — единственная галка, меняющая цену даже когда
      // видео в целом не читаем: вердикт всё равно снимает кадры и шлёт их нейронке.
      const pinNote = () => (pinScanChk && pinScanChk.checked)
        ? ' 📌 Закрепы: +1 запрос-коллаж на закреплённое видео, чтение ×' + (Math.min(3, Math.max(1, parseInt(pinAttInp && pinAttInp.value, 10) || 2))) + '.'
        : '';
      // «Формат кадра» — единственная галка, добавляющая запрос на видео, даже когда
      // текст и речь с видео не читаем: коллаж начала/конца идёт отдельным проходом.
      const fmtNote = () => (formatChk && formatChk.checked)
        ? ' 🧬 Формат кадра: +1 запрос-коллаж (начало + конец) на каждую видео-публикацию.'
        : '';
      const prevNote = () => (previewChk && previewChk.checked)
        ? ' 🖼 Превью: +1 запрос на обложку каждой видео-публикации.'
        : '';
      // Аудит типа контента: теперь это НЕ один запрос — каждый пост в аудите стоит
      // своего запроса (2 кадра начала + подпись). Дольше, но жанр по каждому видно.
      const auditNote = () => (cauditChk && cauditChk.checked)
        ? ' 🎭 Аудит контента: +1 запрос на каждый пост ×' + (Math.min(20, Math.max(1, parseInt(auditNInp && auditNInp.value, 10) || 10))) + ' — это заметно дольше, но точнее.'
        : '';
      const isPhoto = paOn(photoChk);
      const isSlides = paOn(slidesChk);
      const isVocr = paOn(vocrChk);
      const isVoice = paOn(voiceChk);
      const nPosts = Math.max(1, Math.min(20, parseInt(countInp.value, 10) || 5));
      const localOwner = igxLocalOcrState.on && (igxLocalOcrState.order === 'local' || igxLocalOcrState.order === 'only');
      const imgs = [];
      if (isPhoto) imgs.push('фото');
      if (isSlides) imgs.push('слайды');
      // Картинки (фото и слайды) всегда «по одному запросу на картинку» — цена этого
      // запроса и есть вся разница между облаком и локальной моделью.
      const imgPrice = imgs.length
        ? ' 🖼 ' + imgs.join(' и ') + ' — по 1 запросу на картинку'
          + (localOwner ? ' (читает локальная модель — потолок токенов не мешает).'
            : ' (потолок бесплатного облака ≈3 картинки/мин).')
        : '';
      if (!isVocr && !isVoice) {
        costEl.textContent = (imgs.length
          ? 'Видео не трогаем — по нему идут только метрики, это секунды.' + imgPrice
          : 'Из контента не читаем ничего: все галки «🧩 что разбирать» сняты, останутся только метрики.') + pinNote() + fmtNote() + prevNote() + auditNote();
        costEl.classList.remove('warn');
        return;
      }
      const f = paFrames();
      const nFrames = f * 2;
      const req = (isVocr ? nFrames : 0) + (isVoice ? 1 : 0);
      // Кадр у локальной модели на 3060 — единицы секунд; у облака — 1/3 минуты из-за лимита.
      const perFrame = localOwner ? 6 : 20;
      const perVid = (isVocr ? nFrames * perFrame : 0) + (isVoice ? 15 : 0);
      const total = perVid * nPosts;
      const how = [];
      if (isVocr) how.push(nFrames + ' ' + plural(nFrames, 'кадр', 'кадра', 'кадров') + ' → ' + nFrames + ' запрос' + plural(nFrames, '', 'а', 'ов') + ' к ' + (localOwner ? 'локальной модели' : 'нейронке'));
      if (isVoice) how.push('речь — 1 запрос');
      costEl.textContent =
        '🎬 ≈' + req + ' запрос' + plural(req, '', 'а', 'ов') + ' на видео (' + how.join(', ') + '), ≈' + igxFmtDur(perVid) + ' на ролик'
        + ' и ≈' + igxFmtDur(total) + ' на прогон, если все ' + nPosts + ' — видео '
        + (localOwner
          ? '(читает локальная модель на вашем GPU — потолок токенов не мешает).'
          : '(потолок бесплатного облака ≈3 картинки/мин). В блоке «🏠 Локальная модель» в настройках OCR этот потолок снимается.')
        + imgPrice
        + (isVoice && !isVocr ? ' Кадры сняты не будут: если текст на видео — это и есть хук, он в отчёт не попадёт.' : '')
        + pinNote() + fmtNote() + prevNote() + auditNote();
      costEl.classList.toggle('warn', total > 180);
    };
    pop._igxPaDrawCost = drawCost;
    const saveSettings = () => safeStorageSet({
      [PA_COUNT_KEY]: parseInt(countInp.value, 10) || 5,
      [PA_SETTINGS_KEY]: {
        doMeta: paOn(doMeta),
        doVision: paOn(doVision),
        photoOcr: paOn(photoChk),
        slidesOcr: paOn(slidesChk),
        videoOcr: paOn(vocrChk),
        videoVoice: paOn(voiceChk),
        videoFrames: paFrames(),
        pinScan: paOn(pinScanChk),
        frameFormat: paOn(formatChk),
        videoPreview: paOn(previewChk),
        pinAttention: Math.min(3, Math.max(1, parseInt(pinAttInp && pinAttInp.value, 10) || 2)),
        contentAudit: paOn(cauditChk),
        auditPosts: Math.min(20, Math.max(1, parseInt(auditNInp && auditNInp.value, 10) || 10)),
        auditAudio: paOn(aauditChk),
        auditWaitSec: Math.min(15, Math.max(0, parseInt(awaitInp && awaitInp.value, 10) || 0)),
        videoGuard: paOn(vguardChk),
        // Легаси-зеркало: старый формат (doText/doVoice/videoMode) пересчитывается из
        // новых галок, а не остаётся протухшим — иначе откат расширения назад или
        // сторонний читатель увидят то, что пользователь давно отключил.
        doText: paOn(photoChk) || paOn(slidesChk) || paOn(vocrChk),
        doVoice: paOn(voiceChk),
        videoMode: paOn(vocrChk) && paOn(voiceChk) ? 'both' : paOn(voiceChk) ? 'asr' : paOn(vocrChk) ? 'ocr' : 'none',
      },
    });
    [countInp, doMeta, photoChk, slidesChk, vocrChk, voiceChk, doVision, vframes, pinScanChk, previewChk, formatChk, pinAttInp, cauditChk, auditNInp, aauditChk, awaitInp, vguardChk]
      .forEach((el) => el && el.addEventListener('change', () => { drawCost(); saveSettings(); }));
    // Значения галок, «окна чтения» и кто сейчас хозяин распознавания — всё нужно
    // до первой отрисовки цены. Окна (слайды/секунды) живут в настройках OCR,
    // здесь они только показываются: два редактора одного ключа — это будущий конфликт.
    igxPaReadSettings().then((s) => {
      if (s) {
        countInp.value = s.count;
        doMeta.checked = s.doMeta;
        photoChk.checked = s.photoOcr;
        slidesChk.checked = s.slidesOcr;
        vocrChk.checked = s.videoOcr;
        voiceChk.checked = s.videoVoice;
        if (doVision) doVision.checked = s.doVision;
        if (vframes) vframes.value = s.videoFrames;
        if (pinScanChk) pinScanChk.checked = s.pinScan;
        if (previewChk) previewChk.checked = s.videoPreview;
        if (formatChk) formatChk.checked = s.frameFormat;
        if (pinAttInp) pinAttInp.value = s.pinAttention;
        if (cauditChk) cauditChk.checked = s.contentAudit;
        if (auditNInp) auditNInp.value = s.auditPosts;
        if (aauditChk) aauditChk.checked = s.auditAudio;
        if (awaitInp) awaitInp.value = s.auditWaitSec;
        if (vguardChk) vguardChk.checked = s.videoGuard;
        if (hintEl) {
          hintEl.textContent = 'окна чтения: слайды ' + s.startSlides + '+' + s.endSlides
            + ' · видео ' + s.startSec + '+' + s.endSec + ' с — задаются в ⚙ настройках OCR';
        }
      }
      return igxLocalOcrRefresh();
    }).then(() => drawCost(), () => drawCost());

    pop.querySelector('.igx-pa-close').addEventListener('click', () => {
      igxPaDismissedFor = extractUsername(location.pathname);
      pop.style.display = 'none';
    });
    pop.querySelector('.igx-pa-run').addEventListener('click', () => igxPaRun());
    // Настройка горячей клавиши заметки: «задать» → следующая нажатая комбинация пишется
    // в PA_NOTEKEY_KEY (Backspace в режиме записи — сброс, Esc — отмена).
    const noteKeyInp = pop.querySelector('.igx-pa-notekey');
    const noteKeyBtn = pop.querySelector('.igx-pa-notekey-set');
    if (noteKeyBtn) noteKeyBtn.addEventListener('click', () => {
      _igxPaNoteCapturing = true;
      if (noteKeyInp) noteKeyInp.value = 'нажмите клавишу…';
    });
    igxPaNoteRefreshKeyInputs();
    const copyBtn = pop.querySelector('.igx-pa-copy-btn');
    copyBtn.addEventListener('click', async () => {
      const t = pop.querySelector('.igx-pa-result-text').value;
      if (!t) return;
      await copyToClipboard(t);
      copyBtn.textContent = '✓ Скопировано!';
      setTimeout(() => { copyBtn.textContent = '📋 Скопировать'; }, 1500);
    });

    igxPaPop = pop;
    return pop;
  }

  function igxPaUpdateVisibility() {
    if (igxPaRunning) return;
    const user = extractUsername(location.pathname);
    if (user && user !== igxPaDismissedFor) igxPaDismissedFor = null; // новый профиль — снова показываем
    if (!igxPaOnBareProfile() || igxPaModalOpen() || igxPaDismissedFor === user) {
      if (igxPaPop) igxPaPop.style.display = 'none';
      return;
    }
    const pop = ensureProfileAnalyzer();
    if (!pop._igxPaPosApplied) {
      pop._igxPaPosApplied = true;
      safeStorageGet([PA_POS_KEY]).then((d) => {
        try {
          const p = d && d[PA_POS_KEY];
          if (p && p.left && p.top) { pop.style.left = p.left; pop.style.top = p.top; pop.style.right = 'auto'; pop.style.bottom = 'auto'; }
        } catch (_) {}
      });
    }
    pop.style.display = 'flex';
  }

  // Показываем меню только на активном профиле (в фоновых вкладках автопроверки — не надо).
  setInterval(() => {
    try {
      isQuickCheckTab().then((qc) => { if (!qc) igxPaUpdateVisibility(); }).catch(() => {});
    } catch (_) {}
  }, 1200);

  // ---------- живое меню настроек АФК / автопроверки ----------
  // Открывается, когда АФК или автопроверка списка запущены. Все правки применяются
  // СРАЗУ и пишутся в те же storage-ключи, что и попап/боковая панель — поэтому
  // настройки синхронизированы между всеми менюшками и всеми вкладками.
  const AFK_POP_POS_KEY = 'igx_afk_pop_pos';
  let igxAfkPop = null;

  function igxAfkInitDrag(pop) {
    const head = pop.querySelector('.igx-afk-head');
    if (!head) return;
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, select, input')) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = pop.getBoundingClientRect(); ox = r.left; oy = r.top;
      pop.style.left = `${ox}px`; pop.style.top = `${oy}px`; pop.style.right = 'auto'; pop.style.bottom = 'auto';
      head.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    head.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const nl = Math.max(10, Math.min(window.innerWidth - pop.offsetWidth - 10, ox + (e.clientX - sx)));
      const nt = Math.max(10, Math.min(window.innerHeight - pop.offsetHeight - 10, oy + (e.clientY - sy)));
      pop.style.left = `${nl}px`; pop.style.top = `${nt}px`;
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      try { head.releasePointerCapture?.(e.pointerId); } catch (_) {}
      safeStorageSet({ [AFK_POP_POS_KEY]: { left: pop.style.left, top: pop.style.top } });
    };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  }

  function ensureAfkSettingsPanel() {
    if (igxAfkPop && document.body.contains(igxAfkPop)) return igxAfkPop;
    const pop = document.createElement('div');
    pop.className = 'igx-afk-pop';
    pop.innerHTML =
      '<div class="igx-afk-head"><span class="igx-afk-title">🤖 Настройки АФК (live)</span><button type="button" class="igx-afk-close" title="Скрыть">✕</button></div>' +
      '<div class="igx-afk-note">Правки применяются сразу, прямо во время проверки.</div>' +
      '<label class="igx-afk-row"><span>Кого чекать</span>' +
        '<select class="igx-afk-kind"><option value="followers">Подписчиков</option><option value="following">Подписки</option><option value="both">Всех (сначала подписчики, потом подписки)</option></select></label>' +
      '<label class="igx-afk-row"><span>Заходить в профили</span>' +
        '<select class="igx-afk-enter"><option value="random">Крупнейший / зелёный</option><option value="word">Только зелёные со словом</option><option value="wordall">Все кроме пурпурных (слово+сабы)</option></select></label>' +
      '<label class="igx-afk-row"><span>Слово донора (обязательно)</span>' +
        '<input type="text" class="igx-afk-mustword" placeholder="фитнес, йога (через запятую)" title="Какое слово ОБЯЗАТЕЛЬНО должно быть у эксперта-донора (у кого чекают подписки/подписчиков) в описании/имени/нику. Через запятую: сначала берёт тех, у кого ВСЕ слова, если таких нет — у кого хотя бы одно" /></label>' +
      '<label class="igx-afk-row"><span>Пол донора</span>' +
        '<select class="igx-afk-gender" title="Пол са́мого донора (у кого чекуют списки). Считается как бейдж «Квал: пол»: имя из базы имён + родовые окончания в тексте профиля, слова об аудитории не учитываются. При «женский/мужской» профили, у которых пол не распознан, не берутся — АФК подождёт, а не прыгнет наугад."><option value="all">Все</option><option value="f">Женский</option><option value="m">Мужской</option></select></label>' +
      // 4 плашки сабов сеткой 2×2: верхняя строка — ЛИДЫ (кого чекать и кого кидать
      // в бота), нижняя — ДОНОРЫ (у кого вообще берём список). Раньше порог был один
      // на обоих, поэтому «не очень раскрученный донор с крупными подписчиками» было
      // не поймать: он отпадал как лид. Пустое поле донора = наследует порог лидов.
      '<div class="igx-afk-quad">' +
        '<label class="igx-afk-row"><span>лиды · мин</span>' +
          '<input type="number" class="igx-afk-minf" min="0" placeholder="0" title="Минимум подписчиков у ЛИДА: такие профили не открываем и в бота не кидаем. На самого донора не влияет." /></label>' +
        '<label class="igx-afk-row"><span>лиды · макс</span>' +
          '<input type="number" class="igx-afk-maxf" min="0" placeholder="0" title="Максимум подписчиков у ЛИДА (0 = без верха). На самого донора не влияет." /></label>' +
        '<label class="igx-afk-row"><span>донор · мин</span>' +
          '<input type="number" class="igx-afk-dminf" min="0" placeholder="как у лидов" title="Минимум подписчиков у САМОГО донора — у кого чекваем подписчиков/подписки. Пусто = наследует порог лидов." /></label>' +
        '<label class="igx-afk-row"><span>донор · макс</span>' +
          '<input type="number" class="igx-afk-dmaxf" min="0" placeholder="как у лидов" title="Максимум подписчиков у САМОГО донора (0 = без верха, пусто = наследует порог лидов). Донор-миллионник прячет список и поле поиска, поэтому потолок тут реально полезен." /></label>' +
      '</div>' +
      '<label class="igx-afk-row"><span>Пауза, сек</span>' +
        '<input type="number" class="igx-afk-speed" min="1" max="120" step="1" placeholder="4" /></label>' +
      '<div class="igx-afk-status"></div>' +
      '<div class="igx-afk-stats"></div>';
    document.body.appendChild(pop);
    ['pointerdown', 'mousedown', 'click'].forEach((ev) => pop.addEventListener(ev, (e) => e.stopPropagation()));
    igxAfkInitDrag(pop);

    const kindSel = pop.querySelector('.igx-afk-kind');
    const enterSel = pop.querySelector('.igx-afk-enter');
    const mustInp = pop.querySelector('.igx-afk-mustword');
    const genderSel = pop.querySelector('.igx-afk-gender');
    const minfInp = pop.querySelector('.igx-afk-minf');
    const maxfInp = pop.querySelector('.igx-afk-maxf');
    const dminfInp = pop.querySelector('.igx-afk-dminf');
    const dmaxfInp = pop.querySelector('.igx-afk-dmaxf');
    const speedInp = pop.querySelector('.igx-afk-speed');
    const status = pop.querySelector('.igx-afk-status');
    const flash = (t) => { status.textContent = t; setTimeout(() => { if (status.textContent === t) status.textContent = ''; }, 2500); };

    // Начальные значения — из уже загруженных настроек (синхронно с другими меню).
    kindSel.value = afkListKind;
    enterSel.value = afkEnterMode;
    mustInp.value = afkMustWord || '';
    if (genderSel) genderSel.value = afkDonorGender;
    minfInp.value = filterState.minFollowers || '';
    maxfInp.value = filterState.maxFollowers || '';
    dminfInp.value = afkDonorMin == null ? '' : afkDonorMin;
    dmaxfInp.value = afkDonorMax == null ? '' : afkDonorMax;
    // Порог донора читается асинхронно на старте страницы — панель могла открыться
    // раньше. Дотягиваем из storage сами (как ниже с паузой), иначе поле было бы
    // пустым даже при выставленном на дашборде значении.
    safeStorageGet([AFK_DONOR_MIN_KEY, AFK_DONOR_MAX_KEY]).then((d) => {
      const mn = d && typeof d[AFK_DONOR_MIN_KEY] === 'number' ? Math.max(0, d[AFK_DONOR_MIN_KEY]) : null;
      const mx = d && typeof d[AFK_DONOR_MAX_KEY] === 'number' ? Math.max(0, d[AFK_DONOR_MAX_KEY]) : null;
      if (mn != null) afkDonorMin = mn;
      if (mx != null) afkDonorMax = mx;
      if (document.activeElement !== dminfInp) dminfInp.value = afkDonorMin == null ? '' : afkDonorMin;
      if (document.activeElement !== dmaxfInp) dmaxfInp.value = afkDonorMax == null ? '' : afkDonorMax;
    });
    safeStorageGet(['igx_settings']).then((d) => {
      const th = d && d.igx_settings ? d.igx_settings.throttleMs : null;
      if (th != null) speedInp.value = String(Math.max(1, Math.round(th / 1000)));
    });

    kindSel.addEventListener('change', () => {
      afkListKind = kindSel.value;
      afkPhaseKind = kindSel.value === 'following' ? 'following' : 'followers';
      safeStorageSet({ [AFK_LIST_KIND_KEY]: kindSel.value });
      flash('Сохранено: ' + (kindSel.value === 'both' ? 'всех' : kindSel.value === 'following' ? 'подписки' : 'подписчики'));
    });
    if (genderSel) {
      genderSel.addEventListener('change', () => {
        afkDonorGender = genderSel.value;
        safeStorageSet({ [DONOR_GENDER_KEY]: genderSel.value });
        flash(
          genderSel.value === 'f'
            ? 'Доноры: только женский пол (с нераспознанным полом не берём)'
            : genderSel.value === 'm'
              ? 'Доноры: только мужской пол (с нераспознанным полом не берём)'
              : 'Доноры: любой пол'
        );
      });
    }
    enterSel.addEventListener('change', () => {
      afkEnterMode = enterSel.value;
      safeStorageSet({ [AFK_ENTER_MODE_KEY]: enterSel.value });
      flash(
        enterSel.value === 'word'
          ? 'Только зелёные со словом в описании/нике'
          : enterSel.value === 'wordall'
            ? 'Все кроме пурпурных, по слову + сабам'
            : 'Заходит к крупнейшему/зелёному'
      );
    });
    mustInp.addEventListener('input', () => {
      applyAfkMustWord(mustInp.value);
    });
    minfInp.addEventListener('input', () => {
      const v = parseInt(minfInp.value, 10) || 0;
      filterState.minFollowers = v;
      safeStorageSet({ igx_min_followers: v });
      const sideInp = sidePanelEl && sidePanelEl.querySelector('.igx-min-followers');
      if (sideInp && document.activeElement !== sideInp) sideInp.value = v || '';
    });
    maxfInp.addEventListener('input', () => {
      const v = parseInt(maxfInp.value, 10) || 0;
      filterState.maxFollowers = v;
      safeStorageSet({ igx_max_followers: v });
      const sideInp = sidePanelEl && sidePanelEl.querySelector('.igx-max-followers');
      if (sideInp && document.activeElement !== sideInp) sideInp.value = v || '';
    });
    // Порог ДОНОРА: пустое поле СНИМАЕТ ключ (снова наследуем лидов), число — переопределяет.
    // Пишем в storage — дашборд и другие вкладки подхватят через onChanged.
    const bindDonorBound = (inp, key, which) => () => {
      const raw = String(inp.value).trim();
      if (raw === '') {
        if (which === 'min') afkDonorMin = null; else afkDonorMax = null;
        safeStorageRemove([key]);
        flash('Донор: ' + (which === 'min' ? 'мин.' : 'макс.') + ' сабов снова как у лидов');
        return;
      }
      const v = Math.max(0, parseInt(raw, 10) || 0);
      if (which === 'min') afkDonorMin = v; else afkDonorMax = v;
      safeStorageSet({ [key]: v });
      flash('Донор: сабы ' + (which === 'min' ? '≥ ' : '≤ ') + v.toLocaleString('ru-RU'));
    };
    dminfInp.addEventListener('input', bindDonorBound(dminfInp, AFK_DONOR_MIN_KEY, 'min'));
    dmaxfInp.addEventListener('input', bindDonorBound(dmaxfInp, AFK_DONOR_MAX_KEY, 'max'));
    speedInp.addEventListener('input', async () => {
      // Своё число секунд (не выбор из списка). Пустое/0 — игнорим, ждём валидное.
      const sec = parseInt(speedInp.value, 10);
      if (!sec || sec < 1) return;
      const th = Math.min(120, sec) * 1000;
      const d = await safeStorageGet(['igx_settings']);
      const cur = (d && d.igx_settings) || {};
      await safeStorageSet({ igx_settings: Object.assign({}, cur, { throttleMs: th }) });
      cachedSettings = Object.assign({}, cachedSettings, { throttleMs: th });
      flash('Пауза между проверками: ' + Math.round(th / 1000) + ' c');
    });

    pop.querySelector('.igx-afk-close').addEventListener('click', () => {
      pop._igxAfkUserHidden = true;
      pop.style.display = 'none';
    });

    igxAfkPop = pop;
    return pop;
  }

  async function igxAfkUpdateVisibility() {
    let running = isBatchRunning || afkLoopActive || afkLoopBusy;
    if (!running) { try { running = await afkRunning(); } catch (_) {} }
    if (!running) {
      // Прогон закончился — прячем и сбрасываем «скрыто пользователем»,
      // чтобы следующий запуск снова показал меню.
      if (igxAfkPop) { igxAfkPop.style.display = 'none'; igxAfkPop._igxAfkUserHidden = false; }
      return;
    }
    const pop = ensureAfkSettingsPanel();
    if (!pop._igxAfkPosApplied) {
      pop._igxAfkPosApplied = true;
      safeStorageGet([AFK_POP_POS_KEY]).then((d) => {
        try {
          const p = d && d[AFK_POP_POS_KEY];
          if (p && p.left && p.top) { pop.style.left = p.left; pop.style.top = p.top; pop.style.right = 'auto'; pop.style.bottom = 'auto'; }
        } catch (_) {}
      });
    }
    // Живая статистика прогона: время, сколько аккаунтов прочекано, списков, найдено с TG.
    try {
      const st = await afkGetState();
      const statsEl = pop.querySelector('.igx-afk-stats');
      if (statsEl) {
        const t = (st && st.totals) || {};
        const lists = st && Array.isArray(st.lists) ? st.lists.length : 0;
        let timeStr = '0 c';
        if (st && st.startedAt) {
          const sec = Math.max(0, Math.floor((Date.now() - st.startedAt) / 1000));
          timeStr = sec >= 60 ? Math.floor(sec / 60) + ' мин ' + (sec % 60) + ' c' : sec + ' c';
        }
        statsEl.innerHTML =
          '⏱ <b>' + timeStr + '</b>' +
          ' · 👤 прочекано: <b>' + (t.checked || 0) + '</b>' +
          ' · 📋 списков: <b>' + lists + '</b><br>' +
          '🟩 с TG: <b>' + (t.foundTg || 0) + '</b>' +
          ' · ⭐ ≥ порога: <b>' + (t.foundFit || 0) + '</b>' +
          budMini(_bud || (st && st.budget));
      }
    } catch (_) {}
    // Не показываем насильно, если пользователь сам нажал «✕» в этом прогоне.
    if (!pop._igxAfkUserHidden) pop.style.display = 'flex';
  }

  setInterval(() => {
    try {
      isQuickCheckTab().then((qc) => { if (!qc) igxAfkUpdateVisibility(); }).catch(() => {});
    } catch (_) {}
  }, 1200);

  // Пассивный пробник бана. Пользователь может просто открыть «Подписчики/Подписки»
  // руками, без запущенного прогона — раньше блок детектился только внутри afkLoop,
  // поэтому «ничего не грузится, а реактор молчит». Раз в ~6с: явная заглушка/лимит →
  // сразу помечаем; пустой список при том, что у владельца заведомо есть подписчики
  // (и держится 2 тика подряд, чтобы не спутать с недозагрузившейся модалкой) → тоже блок.
  let _passiveEmptyStreak = 0;
  let _passiveBlockStreak = 0;
  setInterval(() => {
    (async () => {
      try {
        const sig = afkIgBlockSignal();
        if (sig) {
          _passiveEmptyStreak = 0;
          // Подтверждение в 2 тика (~12с): одиночная вспышка модалки («сохранить вход»,
          // мигнувший чекпоинт, недозагруженный экран) не должна мгновенно объявлять
          // «ТЯ ЕБНУЛО». Реальный блок держится дольше одного кадра — он пройдёт гейт.
          if (++_passiveBlockStreak < 2) return;
          // Пассивный пробник раньше ТОЛЬКО помечал блок в шкаф риска и молчал. Если
          // прогон не на границе списка (или вкладка просто открыта руками), человек
          // про бан не узнавал вовсе. Звоним в бота на ПЕРВОМ появлении эпизода; сама
          // afkBanAlert молчит, если прогон этой вкладки выключен, а tg.js держит
          // дедуп 30 мин — то есть «выключенный авторазгон не строчит» не ломается.
          let prevAt = 0;
          try { const rs0 = await afkRiskLoad(); prevAt = Number(rs0 && rs0.igBlockAt) || 0; } catch (_) {}
          await afkRiskNoteBlock(sig);
          if (!prevAt || Date.now() - prevAt > 1800000) {
            await afkBanAlert(sig, '', 'Instagram прямо сейчас показывает экран блокировки — прогон на этой вкладке уходит остывать');
          }
          return;
        }
        _passiveBlockStreak = 0;
        // Живой контент (открытый профиль или непустой список) — бан снимаем, чтобы
        // транзиентная заглушка не держала реактор красным, когда всё дальше открывается.
        if (afkPageHealthy()) { _passiveEmptyStreak = 0; await afkRiskClearBlock(); return; }
        if (!afkIsFollowersPage()) { _passiveEmptyStreak = 0; return; }
        const box = afkDialog();
        if (!box) { _passiveEmptyStreak = 0; return; }
        const n = afkIterUserLinks(box, false).length;
        if (n > 0) { _passiveEmptyStreak = 0; await afkRiskClearBlock(); return; }
        const own = afkOwnerFromUrl();
        const op = own ? await getProfile(own) : null;
        if (op && Number(op.followers) > 0 && afkEmptyListPlaceholder(box)) {
          // Голый ноль ссылок (спиннер/долгая загрузка/реально пусто после фильтра по
          // словам) — НЕ бан. Флаг ставим, только когда модалка отдаёт заглушку
          // «здесь будут отображаться все ваши подписчики» и держится 3 тика (~18с).
          if (++_passiveEmptyStreak >= 3) {
            await afkRiskNoteBlock('Instagram: список пуст (заглушка при живом доноре) — похоже на блок за флуд');
          }
        } else {
          _passiveEmptyStreak = 0; // 0 без заглушки = загрузка/фильтр, копить не за чем
        }
      } catch (_) {}
    })();
  }, 6000);

  // Узлы нашего собственного интерфейса. Их добавление (тултип через innerHTML, панель,
  // полоска) не должно запускать пересканирование страницы: раньше фильтр отсекал только
  // сам .igx-tooltip, а его дочерние узлы проходили — и каждый показ тултипа дергал
  // полный обход всех a[href] на странице.
  const IGX_OWN_UI_SELECTOR =
    '.igx-tooltip, .igx-badge-wrap, .igx-bolt, .igx-side-panel, .igx-seekbar, .igx-carousel-bar, .igx-ocr-pop, .igx-link-menu, .igx-link-btn, .igx-pa-pop, .igx-afk-pop';
  function igxIsOwnUiNode(n) {
    if (!n || n.nodeType !== 1) return false;
    try {
      return !!(n.matches?.(IGX_OWN_UI_SELECTOR) || n.closest?.(IGX_OWN_UI_SELECTOR));
    } catch (_) {
      return false;
    }
  }

  const observer = new MutationObserver((mutations) => {
    let hasNewNodes = false;
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length > 0) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && !igxIsOwnUiNode(n)) {
            hasNewNodes = true;
            break;
          }
        }
      }
      if (hasNewNodes) break;
    }
    if (!hasNewNodes) return;

    clearTimeout(scanForRows._t);
    scanForRows._t = setTimeout(() => {
      scanForRows();
      scanForVideos();
      scanForCarousels();
      debouncedApplyFilters();
    }, 250);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scanForRows();
  scanForVideos();
  scanForCarousels();

  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg && (msg.action === 'open_ocr_modal' || msg.action === 'open_ocr')) {
          openOcrPopup(msg.mediaType || null);
          sendResponse({ ok: true });
        }
      });
    }
  } catch (_) {}

  chrome.storage.onChanged.addListener((changes) => {
    let shouldUpdate = false;
    for (const key of Object.keys(changes)) {
      if (key === 'igx_settings') {
        cachedSettings = Object.assign({}, cachedSettings, changes[key].newValue || {});
        continue;
      }
      if (key === 'igx_min_followers') {
        // Синхронизация порога между вкладками (главная / фоновые автопроверки).
        filterState.minFollowers = parseInt(changes[key].newValue, 10) || 0;
        const inp = sidePanelEl && sidePanelEl.querySelector('.igx-min-followers');
        if (inp && document.activeElement !== inp) inp.value = filterState.minFollowers || '';
        const afkInp = igxAfkPop && igxAfkPop.querySelector('.igx-afk-minf');
        if (afkInp && document.activeElement !== afkInp) afkInp.value = filterState.minFollowers || '';
        shouldUpdate = true;
        continue;
      }
      if (key === 'igx_max_followers') {
        // Синхронизация верха порога между вкладками.
        filterState.maxFollowers = parseInt(changes[key].newValue, 10) || 0;
        const inp = sidePanelEl && sidePanelEl.querySelector('.igx-max-followers');
        if (inp && document.activeElement !== inp) inp.value = filterState.maxFollowers || '';
        const afkInp = igxAfkPop && igxAfkPop.querySelector('.igx-afk-maxf');
        if (afkInp && document.activeElement !== afkInp) afkInp.value = filterState.maxFollowers || '';
        shouldUpdate = true;
        continue;
      }
      if (key.startsWith(DONE_PREFIX)) {
        const uname = key.slice(DONE_PREFIX.length);
        if (changes[key].newValue == null) doneCache.delete(uname);
        else doneCache.set(uname, normalizeDone(changes[key].newValue));
        updateUIForUser(uname);
        shouldUpdate = true;
        continue;
      }
      if (key.startsWith(PROFILE_PREFIX) || key.startsWith(VIEWED_PREFIX)) {
        const username = key.replace(/^(?:igx_profile:|igx_viewed:)/, '');
        if (key.startsWith(PROFILE_PREFIX)) {
          profileCache.set(username, changes[key].newValue || null);
        } else if (changes[key].newValue == null) {
          viewedCache.delete(username);
        } else {
          viewedCache.add(username);
        }
        pendingUsers.delete(username.toLowerCase());
        updateUIForUser(username);
        shouldUpdate = true;
      }
    }
    if (shouldUpdate) debouncedApplyFilters();
  });

  // ---------- очередь быстрых проверок с соблюдением задержки ----------
  let queue = [];
  let processingQueue = false;

  function enqueueQuickCheck(username, url) {
    const u = username.toLowerCase();
    if (pendingUsers.has(u)) return;
    pendingUsers.add(u);
    updateUIForUser(username);
    queue.push({ username, url });
    if (!processingQueue) processQueue();
  }

  async function processQueue() {
    processingQueue = true;
    while (queue.length) {
      const item = queue.shift();
      const settings = await getSettings();
      const throttle = Math.max(1000, settings.throttleMs || 4000); // пол 1 с: темп выбирает юзер, шкала риска наказывает <2000

      try {
        await igxSend({ type: 'quickCheck', username: item.username, url: item.url }, 8000);
      } catch (_) {}

      // Ожидание заданной задержки для безопасности аккаунта
      await new Promise((r) => setTimeout(r, throttle));
      pendingUsers.delete(item.username.toLowerCase());
      updateUIForUser(item.username);
    }
    processingQueue = false;
  }

  // ---------- клик по строке внутри модалки -> сплит / новая вкладка ----------
  // Открываем профиль ТОЛЬКО если клик пришёл непосредственно по ссылке на профиль
  // (ник или аватарка). Клики по кнопкам IG, пустому месту строки и т.п. игнорируем.
  function handleRowClick(e) {
    if (e.target.closest('.igx-badge-wrap, .igx-tooltip, .igx-side-panel, .igx-link-menu, .igx-pa-pop, .igx-afk-pop')) return;
    // Ctrl/Cmd/Shift/Alt и средняя кнопка — родное поведение браузера (открыть в новой вкладке), не трогаем
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

    const link = e.target.closest('a[href]');
    if (!link) return;

    const username = extractUsername(link);
    if (!username) return;

    if (!link.closest('[role="dialog"]')) return;

    // Режим «как обычно, в этой же вкладке» — вообще не перехватываем клик.
    // Раньше preventDefault вызывался ДО проверки режима: клик глотался,
    // и профиль не открывался вообще.
    if (cachedSettings.openMode === 'sametab') return;

    // Предотвращаем переход на основной вкладке
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    chrome.runtime
      .sendMessage({ type: 'openProfile', url: `https://www.instagram.com/${username}/` })
      .catch(() => {});
  }

  document.addEventListener('click', handleRowClick, true);

  // ---------- автоматическая пакетная проверка списка ----------
  let isBatchRunning = false;
  let batchTotal = 0;
  let batchCurrent = 0;

  function stopBatchCheck() {
    isBatchRunning = false;
    updateBatchUI();
  }

  function updateBatchUI() {
    const panel = document.querySelector('.igx-side-panel');
    if (!panel) return;
    const btn = panel.querySelector('.igx-btn-autocheck');
    if (!btn) return;

    if (isBatchRunning) {
      // Фаза сбора: кандидатов ещё не считали, а кнопка уже обязана показывать, что
      // клик принят (иначе на длинном списке она молчит — «не работает»).
      btn.textContent = batchTotal > 0
        ? `⏹ Остановить (проверено ${batchCurrent} из ${batchTotal})`
        : '⏹ Собираю список…';
      btn.className = 'igx-btn-autocheck is-running';
    } else {
      btn.textContent = '⚡ Автопроверка списка';
      btn.className = 'igx-btn-autocheck';
    }
  }

  // Тултип-отказ: когда панель скрыта (модалки нет), якорить к ней бессмысленно —
  // сообщение невидимо, и клик выглядит как «кнопка вообще не работает». Тот же
  // приём, что и в afkStop.
  function batchSay(text, ms) {
    const anchor = (sidePanelEl && sidePanelEl.style.display !== 'none') ? sidePanelEl : document.body;
    showTooltip(text, anchor);
    setTimeout(hideTooltip, ms || 8000);
  }

  async function startBatchCheck() {
    if (isBatchRunning) {
      stopBatchCheck();
      return;
    }

    const root = afkListRoot();
    if (!root) {
      batchSay('Автопроверке нужен список людей: открой подписчиков или подписки — модалкой или страницей /username/followers/.');
      return;
    }

    // Клик СРАЗУ показывает себя: раньше сбор кандидатов (await getProfile на каждую
    // строку) выполнялся до первой отрисовки состояния, и на длинном списке кнопка
    // молчала десятками секунд — «не работает».
    isBatchRunning = true;
    batchTotal = 0;
    batchCurrent = 0;
    updateBatchUI();

    // Тот же обход, что у АФК: без владельца списка и без блока «Подписаны (твои
    // подписки)» — автостарт по кнопке не должен сжигать фоновые вкладки на людей,
    // которые уже у тебя в подписках.
    const pool = afkIterUserLinks(root, true);
    const toCheck = [];
    for (const { u } of pool) {
      if (!isBatchRunning) break;
      const p = await getProfile(u);
      if (!p) toCheck.push({ username: u, url: `https://www.instagram.com/${u}/` });
    }

    // Второй клик во время сбора = «стоп»: сообщить честно, а не «ни одной строки».
    if (!isBatchRunning) {
      isBatchRunning = false;
      updateBatchUI();
      return;
    }

    if (!toCheck.length) {
      // Оба случая раньше печатались одной фразой «все проверены!», и она врала
      // ровно тогда, когда список не был найден: 0 строк ≠ все проверены.
      batchSay(pool.length
        ? `Автопроверка (${afkListRootName(root)}): все ${pool.length} найденных уже есть в базе — проверять нечего.`
        : `Автопроверка (${afkListRootName(root)}): не нашлось ни одной строки профиля. Прокрути список вниз — Instagram догружает людей по скроллу, — и нажми снова.`, 11000);
      isBatchRunning = false;
      updateBatchUI();
      return;
    }

    batchTotal = toCheck.length;
    batchCurrent = 0;
    updateBatchUI();

    let sendFail = 0;
    try {
      for (const item of toCheck) {
        if (!isBatchRunning) break;
        batchCurrent++;
        updateBatchUI();

        pendingUsers.add(item.username.toLowerCase());
        updateUIForUser(item.username);

        const settings = await getSettings();
        const throttle = Math.max(1000, settings.throttleMs || 4000); // пол 1 с: темп выбирает юзер, шкала риска наказывает <2000

        try {
          const r = await igxSend({ type: 'quickCheck', username: item.username, url: item.url }, 8000);
          if (!r || !r.ok) sendFail++; // фоновая вкладка не создана (лимит/сбой) — молчать об этом нельзя
        } catch (_) {
          sendFail++;
        }

        if (isBatchRunning) {
          await new Promise((r) => setTimeout(r, throttle));
        }
        pendingUsers.delete(item.username.toLowerCase());
        updateUIForUser(item.username);
      }
    } finally {
      isBatchRunning = false;
      updateBatchUI();
      if (sendFail) {
        batchSay(`Автопроверка: отправила ${batchCurrent} из ${batchTotal}, из них ${sendFail} раз фоновая вкладка не открылась (мост/браузер отказал). Повтори позже.`);
      }
      // Проверены все из списка (или 5+) — эксперт считается «выжатым» по этому типу
      // списка (подписчики/подписки), подсвечиваем его в остальных списках.
      const owner = afkOwnerFromUrl();
      if (owner && batchCurrent > 0 && (batchCurrent >= 5 || batchCurrent >= pool.length)) {
        markDone(owner, batchCurrent, afkActualListKind()).catch(() => {});
      }
    }
  }

  // ---------- АФК-режим ----------
  // Стартует ТОЛЬКО по кнопке «⚡ Автопроверка списка» при включённой галочке «АФК».
  // Состояние живёт в storage (igx_afk_state), поэтому режим переживает переходы:
  // прыжок к следующему челу — полная навигация в ЭТОЙ ЖЕ вкладке на его подписчиков,
  // после перезагрузки скрипт читает состояние и продолжает с того же места.
  // Цикл: листает модалку до конца -> чекает всех -> отчёт в бота -> берёт самого
  // популярного (до 50к сабов, у гигантов список не грузится) -> вводит слово в поиск -> повтор.
  const igxSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Состояние АФК строго изолировано для каждой вкладки (через sessionStorage + chrome.storage),
  // чтобы можно было массово запускать АФК сразу в нескольких вкладках без конфликтов!
  const AFK_TAB_STORAGE_KEY = 'igx_afk_tab_state';
  const AFK_LAST_WORD_KEY = 'igx_afk_last_word';
  try {
    safeStorageRemove('igx_afk_state');
  } catch (_) {}

  function getAfkSessionKey() {
    try {
      let id = sessionStorage.getItem('igx_afk_tab_id');
      if (!id) {
        id = 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem('igx_afk_tab_id', id);
      }
      return 'igx_afk_' + id;
    } catch (_) {
      return 'igx_afk_local_tab';
    }
  }

  // id ИМЕННО этой вкладки (живёт в её sessionStorage). Пишется в состояние, чтобы
  // осиротевший/чужой дубль igx_afk_tab_<tabId> не мог «возобновить» АФК в новой
  // вкладке, которой Chrome выдал тот же самый номер.
  function afkSid() {
    return getAfkSessionKey().replace(/^igx_afk_/, '');
  }

  function getSessionAfkState() {
    try {
      const raw = sessionStorage.getItem(AFK_TAB_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function setSessionAfkState(st) {
    try {
      if (st) {
        sessionStorage.setItem(AFK_TAB_STORAGE_KEY, JSON.stringify(st));
      } else {
        sessionStorage.removeItem(AFK_TAB_STORAGE_KEY);
      }
    } catch (_) {}
  }

  let cachedTabId = null;
  async function getTabId() {
    if (cachedTabId !== null) return cachedTabId;
    try {
      const res = await igxSend({ type: 'getTabId' }, 1500);
      if (res && typeof res.tabId === 'number') {
        cachedTabId = res.tabId;
        return cachedTabId;
      }
    } catch (_) {}
    return null;
  }
  const AFK_MAX_FOLLOWERS = 50000;
  // ИГ редиректит /followers/ → mutualOnly (только твои подписки).
  // Нужен mutualFirst — полный список подписчиков (сначала общие, потом все).
  const AFK_FOLLOWERS_MODE = 'mutualFirst';
  let afkLoopActive = false;
  // «Цикл ещё на стеке» — СЧЁТЧИК, а не флаг: в одной вкладке теоретически могут перекреститься
  // старый цикл, который досматривает шаг после «стопа», и новый, запущенный сразу следом.
  // afkLoopActive сбрасывается мгновенно по «стопу» — от него зависят чекпоинты внутри
  // цикла (afkRunning), иначе АФК не замечал бы остановку. Поэтому «догорает ли ещё тело
  // цикла» хранится отдельно: снимает его только finally.
  let afkLoopBusy = 0;
  let afkHbTimer = null; // «сердцебиение» бесконечного прогона: дашборд считает прогон живым, пока hb свежий
  let _afkErrStreak = 0; // подряд идущие транзитные сбои цикла (для ∞ — перезапуск, а не стоп)
  let _afkHardRests = 0; // сколько ДЛИННЫХ пауз взял ∞-прогон после серий сбоев; после лимита — честный стоп
  let _afkNoSearchStreak = 0; // подряд идущие списки, где слову некуда лечь (нет поля/не вводится)
  // «Прогресс», а не «пульс». hb пишет таймер, который тикает ДАЖЕ когда цикл застрял в
  // незакрыленном await — то есть зависший прогон выглядел живым, и ни дашборд, ни
  // автопилот не имели права его будить. Поэтому живость смотрим по двум меткам: молчание
  // hb = «вкладку усыпило», молчание prog при свежем hb = «вкладка зависла».
  let _afkProgAt = 0;
  function afkProg() { _afkProgAt = Date.now(); return _afkProgAt; }
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg?.type !== 'laptopRecover') return;
    (async () => {
      const state = await afkGetState();
      if (!state?.on || state.stopping || afkIgBlockSignal()) return {ok:false};
      if (Number(state.pauseTill) > Date.now()) return {ok:true};
      const result = await afkInfiniteRecover(state);
      return {ok:result === 'nav' || result === 'stop'};
    })().then(respond, error => respond({ok:false, error:String(error)}));
    return true;
  });
  // Один отменяемый таймер «поднимаю прогон» на вкладку. Раньше это были голые setTimeout
  // в трёх местах: человек жмёт «стоп», а через 2 минуты таймер всё равно зовёт afkLoop(),
  // и уже выключенный прогон снова писал сердцебиение, поджигал кнопку и мог настрочить в
  // бота «Instagram заблокировал работу» — ровно то, на что пожаловались.
  let _afkWakeTimer = 0;
  function afkWake(ms) {
    if (_afkWakeTimer) clearTimeout(_afkWakeTimer);
    _afkWakeTimer = setTimeout(() => {
      _afkWakeTimer = 0;
      (async () => {
        let st = null;
        try { st = await afkGetState(); } catch (_) { return; }
        if (!st || !st.on || st.stopping) return; // выключили, пока мы спали → не оживаем
        afkLoop().catch(() => {});
      })();
    }, Math.max(200, Number(ms) || 0));
  }
  function afkWakeCancel() { if (_afkWakeTimer) { clearTimeout(_afkWakeTimer); _afkWakeTimer = 0; } }

  // Что чекает АФК: подписчиков (followers) или подписки (following). Выбор ставится в
  // попапе, живёт в storage — читают и рабочие вкладки, и автостарт новых вкладок.
  const AFK_LIST_KIND_KEY = 'igx_afk_list_kind';
  const AFK_AUTOSTART_KEY = 'igx_afk_autostart'; // очередь [{ username, word, ts }]
  const AFK_DISPATCHED_KEY = 'igx_afk_dispatched'; // { username(lower): ts } — уже запущенные сиды
  // В какие профили заходит АФК: 'random' — как раньше (крупнейший/зелёный);
  // 'word' — только зелёные, у кого в описании(bio)/нике/юзнейме есть ключевое слово;
  // 'wordall' — все кроме пурпурных (список уже выжат), подходящие по слову + сабам.
  const AFK_ENTER_MODE_KEY = 'igx_afk_enter_mode';
  const AFK_MUST_WORD_KEY = 'igx_afk_must_word';
  const AFK_ENTER_MODES = ['random', 'word', 'wordall'];
  // Пол ДОНОРА — ЖЁСТКИЙ фильтр (у кого чекать списки): 'all' | 'f' | 'm'. Ключ,
  // допустимые значения и само определение пола — в qualify.js ( DONOR_GENDER_KEY /
  // DONOR_GENDERS / donorGenderOk), потому что тот же признак рисует бейдж «Квал: пол»
  // в истории и фильтр /list у бота. Неопределённый пол при выбранном «женский/
  // мужской» не проходит: угадать — значит открыть АФК чужой список.
  // «Бесконечный чек» — режим с сайта расширения: цикл АФК не останавливается,
  // когда кандидаты/списки кончились — ждёт и берёт нового рандомного по настройкам;
  // если профиль не загрузился (~минуты на 3 попытки) — прыгает к другому. Стоп —
  // только закрыть вкладку/окно или кнопка «Стоп» на дашборде (igx_afk_stop_cmd).
  const AFK_INFINITE_KEY = 'igx_afk_infinite';   // { on, startedAt, stoppedAt, reason } — статус для дашборда
  const AFK_STOP_CMD_KEY = 'igx_afk_stop_cmd';   // { ts } — команда «стоп» с дашборда
  const AFK_RUN_HISTORY_KEY = 'igx_run_history'; // [] записей завершённых бесконечных прогонов (для модалки истории на дашборде)
  let afkListKind = 'followers';
  let afkPhaseKind = 'followers'; // эффективный тип списка в текущем проходе (для 'both')
  let afkEnterMode = 'random';
  let afkMustWord = '';
  let afkDonorGender = 'all';
  // Порог подписчиков ОТДЕЛЬНО для донора (у кого берём список) и для лида (кого чеким).
  // null = ключ не задан → наследуем filterState.min/maxFollowers, то есть ровно то
  // поведение, что было до разделения. Тот же приём, что у автоанализа (igx_paa_min)
  // и у телефона (igx_phone_donor_min): пусто = как на основной панели.
  const AFK_DONOR_MIN_KEY = 'igx_donor_min_followers';
  const AFK_DONOR_MAX_KEY = 'igx_donor_max_followers';
  let afkDonorMin = null;
  let afkDonorMax = null;
  try {
    chrome.storage.local.get([AFK_LIST_KIND_KEY, AFK_ENTER_MODE_KEY, AFK_MUST_WORD_KEY, DONOR_GENDER_KEY, AFK_DONOR_MIN_KEY, AFK_DONOR_MAX_KEY], (d) => {
      if (!d) return;
      if (d[AFK_LIST_KIND_KEY] === 'following' || d[AFK_LIST_KIND_KEY] === 'followers' || d[AFK_LIST_KIND_KEY] === 'both') afkListKind = d[AFK_LIST_KIND_KEY];
      afkPhaseKind = afkListKind === 'following' ? 'following' : 'followers';
      if (AFK_ENTER_MODES.includes(d[AFK_ENTER_MODE_KEY])) afkEnterMode = d[AFK_ENTER_MODE_KEY];
      if (typeof d[AFK_MUST_WORD_KEY] === 'string') afkMustWord = d[AFK_MUST_WORD_KEY];
      if (DONOR_GENDERS.includes(d[DONOR_GENDER_KEY])) afkDonorGender = d[DONOR_GENDER_KEY];
      if (typeof d[AFK_DONOR_MIN_KEY] === 'number' && !Number.isNaN(d[AFK_DONOR_MIN_KEY])) afkDonorMin = Math.max(0, d[AFK_DONOR_MIN_KEY]);
      if (typeof d[AFK_DONOR_MAX_KEY] === 'number' && !Number.isNaN(d[AFK_DONOR_MAX_KEY])) afkDonorMax = Math.max(0, d[AFK_DONOR_MAX_KEY]);
    });
  } catch (_) {}
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[AFK_LIST_KIND_KEY]) {
        const v = changes[AFK_LIST_KIND_KEY].newValue;
        if (v === 'following' || v === 'followers' || v === 'both') { afkListKind = v; afkPhaseKind = v === 'following' ? 'following' : 'followers'; }
      }
      if (changes[AFK_ENTER_MODE_KEY]) {
        const v = changes[AFK_ENTER_MODE_KEY].newValue;
        if (AFK_ENTER_MODES.includes(v)) afkEnterMode = v;
      }
      if (changes[AFK_MUST_WORD_KEY] && typeof changes[AFK_MUST_WORD_KEY].newValue === 'string') {
        // Слово ДОНОРА (меню АФК) — живое поле; поле поиска НЕ трогаем (это разные слова).
        afkMustWord = changes[AFK_MUST_WORD_KEY].newValue;
        const liveInp = igxAfkPop && igxAfkPop.querySelector('.igx-afk-mustword');
        if (liveInp && document.activeElement !== liveInp) liveInp.value = afkMustWord;
      }
      if (changes[DONOR_GENDER_KEY]) {
        // Пол донора меняется живьём: следующий прыжок уже берёт донора нового пола.
        const v = changes[DONOR_GENDER_KEY].newValue;
        if (DONOR_GENDERS.includes(v)) afkDonorGender = v;
        const genSel = igxAfkPop && igxAfkPop.querySelector('.igx-afk-gender');
        if (genSel && document.activeElement !== genSel) genSel.value = afkDonorGender;
      }
      if (AFK_DONOR_MIN_KEY in changes || AFK_DONOR_MAX_KEY in changes) {
        // Порог донора правят и с дашборда, и с живой панели: следующий выбор донора
        // уже берёт новые границы. Ключ снят (undefined) → возвращаемся к наследию.
        const readBound = (k, cur) => {
          const c = changes[k];
          if (!c) return cur;
          const v = c.newValue;
          return typeof v === 'number' && !Number.isNaN(v) ? Math.max(0, v) : null;
        };
        afkDonorMin = readBound(AFK_DONOR_MIN_KEY, afkDonorMin);
        afkDonorMax = readBound(AFK_DONOR_MAX_KEY, afkDonorMax);
        const pair = [['.igx-afk-dminf', afkDonorMin], ['.igx-afk-dmaxf', afkDonorMax]];
        for (const [sel, val] of pair) {
          const inp = igxAfkPop && igxAfkPop.querySelector(sel);
          if (inp && document.activeElement !== inp) inp.value = val == null ? '' : val;
        }
      }
      if (changes[AFK_LAST_WORD_KEY] && typeof changes[AFK_LAST_WORD_KEY].newValue === 'string') {
        // Слово ПОИСКА в списке (главное меню) — синхроним только боковое поле.
        const sideInp = sidePanelEl && sidePanelEl.querySelector('.igx-afk-word');
        if (sideInp && document.activeElement !== sideInp) sideInp.value = changes[AFK_LAST_WORD_KEY].newValue;
      }
      if (changes[AFK_STOP_CMD_KEY]) {
        // «Стоп» с дашборда: без tabId — останавливаем все infinite-вкладки;
        // с tabId — только вкладка-адресат (красная кнопка «стоп самое старое окно»).
        (async () => {
          try {
            const cmd = changes[AFK_STOP_CMD_KEY].newValue || {};
            if (cmd && cmd.tabId) {
              const myId = await getTabId();
              if (myId !== cmd.tabId) return;
            }
            const stS = await afkGetState();
            if (stS && stS.on && stS.infinite) await afkStop('остановлено с сайта расширения.');
          } catch (_) {}
        })();
      }
    });
  } catch (_) {}

  // Поле ГЛАВНОГО меню — что АФК вводит в ПОИСК списка донора (st.word + AFK_LAST_WORD_KEY).
  async function applyAfkSearchWord(value) {
    const v = String(value == null ? '' : value).trim();
    try {
      const sideInp = sidePanelEl && sidePanelEl.querySelector('.igx-afk-word');
      if (sideInp && document.activeElement !== sideInp) sideInp.value = v;
    } catch (_) {}
    await safeStorageSet({ [AFK_LAST_WORD_KEY]: v });
    try {
      const st = await afkGetState();
      if (st && st.on) await afkPatchState({ word: v, needSearch: true });
    } catch (_) {}
  }

  // Поле меню АФК — слово, которое ОБЯЗАТЕЛЬНО должно быть у самого ДОНОРА
  // (био/имя/юзернейм). Через запятую: сначала берутся профили со ВСЕМИ словами,
  // если таких нет — с ЛЮБЫМ одним (см. afkPickGreenFromDb / afkPickAnyFromDb / afkPickNext).
  async function applyAfkMustWord(value) {
    const v = String(value == null ? '' : value);
    afkMustWord = v;
    try {
      const liveInp = igxAfkPop && igxAfkPop.querySelector('.igx-afk-mustword');
      if (liveInp && document.activeElement !== liveInp) liveInp.value = v;
    } catch (_) {}
    await safeStorageSet({ [AFK_MUST_WORD_KEY]: v });
  }

  function afkMustTokens() {
    return String(afkMustWord || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  // Дешёвый путь: режим «Все» (по умолчанию) не делает ни одного regex-скана — ровно
  // как до этой настройки. Квалификация недоступна (qualify.js не поднят) — не ломаем
  // прыжок: пропускаем, иначе АФК встал бы молча вместо того чтобы работать как раньше.
  function afkDonorGenderOk(p, username) {
    if (afkDonorGender !== 'f' && afkDonorGender !== 'm') return true;
    try {
      return donorGenderOk(p, username, afkDonorGender);
    } catch (_) {
      return true;
    }
  }
  // Границы сабов для ВЫБОРА ДОНОРА (у кого берём список) — НЕ для лида. Порог лида
  // по-прежнему filterState.min/maxFollowers: он режет строки, totals и отчёт в бота.
  function afkDonorBounds() {
    return {
      minF: afkDonorMin == null ? (filterState.minFollowers || 0) : afkDonorMin,
      maxF: afkDonorMax == null ? (filterState.maxFollowers || 0) : afkDonorMax,
      // Задан явно — чтобы в подсказке «кандидатов нет» можно было сказать, что
      // виноват именно фильтр донора, а не пустая база.
      own: afkDonorMin != null || afkDonorMax != null,
    };
  }

  // Проходит ли ПРОФИЛЬ фильтр слова донора: mode 'all' — все слова, 'any' (по умолчанию) — любое.
  // Слово не задано — проходит каждый.
  function afkMatchesMustWord(p, username, mode) {
    const tokens = afkMustTokens();
    if (!tokens.length) return true;
    const hay = [p && p.bio, p && p.fullName, username].filter(Boolean).join('\n').toLowerCase();
    return mode === 'all' ? tokens.every((w) => hay.includes(w)) : tokens.some((w) => hay.includes(w));
  }

  // URL нужного списка. У /following/ нет mutual-вариантов — там сразу полный список.
  // ВАЖНО: afkListKind читается ЖИВЬЁМ, но URL строится только в момент ПРЫЖКА к следующему
  // эксперту. Поэтому смена «подписчики/подписки» в меню применяется НЕ сразу, а после того,
  // как текущий список дочекан до конца (ровно то поведение, что и нужно).
  function afkListUrl(username) {
    return afkPhaseKind === 'following'
      ? `https://www.instagram.com/${username}/following/`
      : `https://www.instagram.com/${username}/followers/${AFK_FOLLOWERS_MODE}`;
  }

  function afkFollowersUrl(username) {
    return afkListUrl(username);
  }

  function afkIsFollowersPage() {
    return /\/(?:followers|following)(?:\/|$)/i.test(location.pathname);
  }

  // КАКОЙ список реально открыт/прочека́н прямо сейчас (а не какой выбран в настройке
  // afkListKind — он может смениться посреди прогона). Определяем по активной вкладке
  // модалки, затем по URL, затем по настройке.
  function afkActualListKind(box) {
    const root = box || afkDialog();
    if (root) {
      const els = root.querySelectorAll('a, button, [role="tab"], li, [aria-selected], [aria-current]');
      for (const el of els) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 24) continue;
        const selected = el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') === 'true' || /active|selected/i.test(el.className || '');
        if (!selected) continue;
        if (/^(подписки|following|follows)$/i.test(t)) return 'following';
        if (/^(подписчики|followers)$/i.test(t)) return 'followers';
      }
    }
    if (/\/following(?:\/|$)/i.test(location.pathname)) return 'following';
    if (/\/followers(?:\/|$)/i.test(location.pathname)) return 'followers';
    return afkPhaseKind === 'following' ? 'following' : 'followers';
  }

  function afkIsMutualOnlyPage() {
    return afkPhaseKind !== 'following' && /\/followers\/mutualonly/i.test(location.pathname);
  }

  // Закрытый список подписчиков: вместо людей ИГ показывает «Только X может
  // смотреть/видеть всех своих подписчиков» (RU) / «Only X can see …» (EN).
  function afkIsClosedList(box) {
    if (!box) return false;
    let t = '';
    try {
      t = (box.innerText || '').slice(0, 3000);
    } catch (_) {}
    return /может (?:видеть|смотреть)|can see|закрыт\w* аккаунт|private account|this account is private/i.test(t);
  }

  // Закрытый ПРОФИЛЬ до открытия списка. На такой странице Instagram вообще не
  // создаёт рабочую модалку, поэтому ожидание afkEnsureList бессмысленно.
  function afkIsPrivateProfilePage() {
    try {
      const main = document.querySelector('main') || document.body;
      const text = String(main?.innerText || '').slice(0, 6000);
      return /это закрытый профиль|этот аккаунт закрыт|закрытый аккаунт|this account is private|this is a private (?:account|profile)/i.test(text);
    } catch (_) { return false; }
  }

  async function afkMarkPrivateVisited(st) {
    const owner = afkProfileOwner();
    const visited = new Set((st && st.visited) || []);
    if (owner) visited.add(owner.toLowerCase());
    await afkPatchState({ visited: Array.from(visited), fails: 0, plainTried: false,
      needSearch: true, cur: owner || (st && st.cur) || '' });
  }

  // Если ИГ открыл mutualOnly — принудительно переходим на mutualFirst.
  async function afkEnsureMutualFirst() {
    if (!afkIsMutualOnlyPage()) return true;
    const owner = afkProfileOwner();
    if (!owner) return true;
    location.href = afkFollowersUrl(owner);
    return false;
  }

  async function afkGetState() {
    // 1. Сначала читаем из sessionStorage этой конкретной вкладки (мгновенно и полностью изолированно)
    const mem = getSessionAfkState();
    if (mem && typeof mem === 'object') return mem;

    // 2. Читаем из storage по ключу сессии вкладки
    const key = getAfkSessionKey();
    try {
      const d = await chrome.storage.local.get(key);
      if (d && d[key]) {
        setSessionAfkState(d[key]);
        return d[key];
      }
    } catch (_) {}

    // 3. Запасной вариант: проверяем tabId — ТОЛЬКО если дубль принадлежит этой же
    // вкладке (sid). Иначе это мусор от закрытой вкладки с переиспользованным номером:
    // снимаем его и НЕ возобновляем АФК (иначе «сам начал чекать» при обычном заходе в ИГ).
    try {
      const tabId = await getTabId();
      if (tabId) {
        const tabKey = `igx_afk_tab_${tabId}`;
        const td = await chrome.storage.local.get(tabKey);
        const dup = td && td[tabKey];
        if (dup) {
          if (dup.sid === afkSid()) {
            setSessionAfkState(dup);
            return dup;
          }
          try { chrome.storage.local.remove(tabKey); } catch (_) {}
        }
      }
    } catch (_) {}

    return null;
  }

  async function afkPatchState(patch) {
    const cur = (await afkGetState()) || {};
    const st = Object.assign({ on: false, word: '', visited: [], lists: [], needSearch: false, plainTried: false, jumped: false }, cur, patch);
    st.sid = afkSid(); // метка владельца — см. afkGetState (п.3)

    // Сохраняем в sessionStorage этой вкладки
    setSessionAfkState(st);

    // Сохраняем в storage под индивидуальным ключом вкладки
    const key = getAfkSessionKey();
    try {
      await chrome.storage.local.set({ [key]: st });
    } catch (_) {}

    // Дублируем по tabId
    try {
      const tabId = await getTabId();
      if (tabId) {
        await chrome.storage.local.set({ [`igx_afk_tab_${tabId}`]: st });
      }
    } catch (_) {}

    // Сохраняем последнее введённое слово как глобальное значение по умолчанию для новых вкладок
    if (patch && typeof patch.word === 'string' && patch.word.trim()) {
      try {
        await chrome.storage.local.set({ [AFK_LAST_WORD_KEY]: patch.word.trim() });
      } catch (_) {}
    }

    return st;
  }

  async function afkRunning() {
    if (afkLoopActive) return true;
    const st = await afkGetState();
    return !!(st && st.on);
  }

  function afkDialog() {
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      if (afkUserCount(d) > 0 || d.querySelector('input')) return d;
    }
    return document.querySelector('[role="dialog"]');
  }

  // КОНТЕЙНЕР СПИСКА ЛЮДЕЙ. Instagram показывает подписчиков/подписки двумя способами:
  // модалкой ([role="dialog"]) и ПОЛНОЙ СТРАНИЦЕЙ на /<user>/followers|following/ — плюс
  // иногда держит случайный диалог («сохранить вход», уведомления), где строк профиля нет
  // вообще. Раньше и автопроверка списка, и панель смотрели ровно в afkDialog(): на
  // полностраничном списке цеплялись за чужой диалог и рапортовали «все проверены», хотя
  // не видели ни одной строки. Берём тот контейнер, где людей РЕАЛЬНО больше.
  function afkListRoot() {
    let best = null;
    let bestN = 0;
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      const n = afkUserCount(d);
      if (n > bestN) { best = d; bestN = n; }
    }
    if (bestN >= 3) return best; // список явно в модалке
    if (afkIsFollowersPage()) {
      const main = document.querySelector('main') || document.body;
      if (afkUserCount(main) > bestN) return main;
    }
    return best; // тонкая модалка (1-2 строки) лучше, чем ничего; иначе null
  }

  // Где именно искали — для честного текста отказа («в модалке» / «на странице»).
  function afkListRootName(root) {
    if (!root) return 'нигде';
    return (root.getAttribute && root.getAttribute('role') === 'dialog') ? 'в модалке' : 'на странице';
  }

  function afkUserCount(dialog) {
    if (!dialog) return 0;
    const seen = new Set();
    dialog.querySelectorAll('a[href]').forEach((a) => {
      const u = extractUsername(a);
      if (u) seen.add(u.toLowerCase());
    });
    return seen.size;
  }

  async function afkWaitDialog(timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || 20000)) {
      const d = afkDialog();
      if (d && afkUserCount(d) > 0) return d;
      await igxSleep(700);
    }
    return afkDialog();
  }

  // Владелец профиля из URL (профиль, /followers/, /followers/mutualFirst и т.п.).
  function afkProfileOwner() {
    const m = location.pathname.match(/^\/([A-Za-z0-9._]{1,30})(?:\/(?:followers|following)(?:\/[^/]+)?)?\/?/i);
    return m ? m[1].toLowerCase() : null;
  }

  // Надёжный клик по элементу (ИГ иногда игнорирует простой .click()).
  function afkSimulateClick(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch (_) {}
    try {
      el.click();
    } catch (_) {}
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (_) {}
  }

  // Секция «Подписаны (твои подписки)» в модалке — это люди, на которых ты уже подписан.
  // Их нельзя брать как «следующего эксперта» и не стоит тратить на них автопроверку.
  const AFK_SUBSCRIBED_HDR_RE = /подписаны|твои подписки|accounts you follow|people you follow/i;
  // Кнопка в строке: ты УЖЕ подписан на этого человека.
  const AFK_FOLLOWING_BTN_RE = /^(подписки|подписан|отправлен|запрош|following|requested|message|сообщени|друзья)/i;
  const AFK_FOLLOW_BTN_RE = /^(подписаться|follow)$/i;

  // Кэш найденных секций «Подписаны»: раньше при каждом обращении заново
  // сканировался весь DOM модалки — на больших списках это O(n²) и страница
  // зависала. Кэш живёт 5 секунд, потом пересчитывается.
  const afkSubscribedCache = new WeakMap(); // root -> {at, containers}
  function afkSubscribedContainers(root) {
    if (!root) return [];
    const hit = afkSubscribedCache.get(root);
    if (hit && Date.now() - hit.at < 5000) return hit.containers;
    const containers = [];
    for (const el of root.querySelectorAll('span, div, h2, h3, h4')) {
      const direct = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join('')
        .trim();
      const t = (direct || el.textContent || '').trim();
      if (!t || t.length > 70) continue;
      if (!AFK_SUBSCRIBED_HDR_RE.test(t)) continue;
      // Поднимаемся к контейнеру секции (там лежат строки людей).
      let box = el.parentElement;
      for (let i = 0; i < 4 && box && box !== root; i++) {
        if (box.querySelectorAll('a[href]').length >= 2) break;
        box = box.parentElement;
      }
      if (box && !containers.includes(box)) containers.push(box);
    }
    afkSubscribedCache.set(root, { at: Date.now(), containers });
    return containers;
  }

  // Заголовок секции «Подписаны» — всё внутри неё пропускаем.
  function afkIsInSubscribedSection(a, root) {
    return afkSubscribedContainers(root).some((c) => c.contains(a));
  }

  // В строке списка: кнопка «Подписки» / Following = ты уже подписан.
  function afkBtnLabel(btn) {
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    const aria = (btn.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    return t || aria;
  }

  function afkRowForLink(a) {
    if (!a) return null;
    const li = a.closest('li, [role="listitem"]');
    if (li) return li;
    let row = a.parentElement;
    for (let i = 0; i < 8 && row; i++) {
      if (row.querySelector('button, [role="button"]') && (row.querySelector('img') || row === a.closest('div'))) {
        return row;
      }
      row = row.parentElement;
    }
    return findUserRow(a);
  }

  function afkRowShowsFollowButton(row) {
    if (!row) return false;
    for (const btn of row.querySelectorAll('button, [role="button"]')) {
      const label = afkBtnLabel(btn);
      if (!label || label.length > 50) continue;
      if (AFK_FOLLOW_BTN_RE.test(label)) return true;
    }
    return false;
  }

  function afkRowShowsFollowing(row) {
    if (!row) return false;
    for (const btn of row.querySelectorAll('button, [role="button"]')) {
      const label = afkBtnLabel(btn);
      if (!label || label.length > 50) continue;
      if (AFK_FOLLOW_BTN_RE.test(label)) continue;
      if (AFK_FOLLOWING_BTN_RE.test(label)) return true;
    }
    return false;
  }

  function afkIsAlreadyFollowingUser(a, root) {
    if (afkIsInSubscribedSection(a, root)) return true;
    return afkRowShowsFollowing(afkRowForLink(a));
  }

  // Ссылки на юзеров в списке, без владельца и без тех, на кого уже подписан.
  function afkIterUserLinks(root, skipSubscribed) {
    const owner = afkOwnerFromUrl();
    const seen = new Set();
    const out = [];
    for (const a of (root || document).querySelectorAll('a[href]')) {
      const u = extractUsername(a);
      if (!u) continue;
      const low = u.toLowerCase();
      if (seen.has(low)) continue;
      if (owner && low === owner) continue;
      if (skipSubscribed && afkIsAlreadyFollowingUser(a, root)) continue;
      seen.add(low);
      out.push({ a, u, low });
    }
    return out;
  }

  // Найти кликабельный элемент «подписчики» на странице профиля.
  function afkFindFollowersEl() {
    const owner = afkProfileOwner();
    const dialog = afkDialog();
    const isInDialog = (el) => dialog && dialog.contains(el);

    // 1. Ссылка на /owner/followers/mutualFirst в шапке (не mutualOnly, не внутри модалки).
    if (owner) {
      let fallback = null;
      for (const a of document.querySelectorAll('a[href*="followers"]')) {
        if (isInDialog(a)) continue;
        const href = (a.getAttribute('href') || '').toLowerCase();
        if (!href.includes(`/${owner}/followers`)) continue;
        if (href.includes('mutualonly')) continue;
        if (href.includes('mutualfirst')) return a;
        if (!fallback) fallback = a;
      }
      if (fallback) return fallback;
    }

    // 2. Счётчик «подписчики» в header — но не «подписаны/подписки» (это про подписки владельца).
    // ВАЖНО: нельзя пропускать по /подписк/ — оно содержится и в «подписчиков»,
    // из-за этого АФК вообще не находил счётчик в русской локали.
    const header = document.querySelector('header');
    if (header) {
      for (const el of header.querySelectorAll('a, li, span, [role="button"]')) {
        if (isInDialog(el)) continue;
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 40) continue;
        if (/подписан|подписки\b|\bfollowing\b|\bfollows\b/i.test(t)) continue;
        if (/подписчик|\bfollowers?\b/i.test(t)) {
          const click = el.closest('a, [role="button"]') || el;
          if (!isInDialog(click)) return click;
        }
      }
    }
    return null;
  }

  async function afkClickFollowers() {
    const el = afkFindFollowersEl();
    if (!el) return false;
    afkSimulateClick(el);
    await igxSleep(800);
    return true;
  }

  // В модалке ИГ может открыться не та вкладка — переключаем на нужную по afkListKind
  // («Подписчики» для followers, «Подписки» для following). Если вкладок нет — молча выходим.
  async function afkEnsureFollowersTab(box) {
    const root = box || afkDialog();
    if (!root) return;
    const wantFollowing = afkPhaseKind === 'following';
    const re = wantFollowing ? /^(подписки|following|follows)$/i : /^(подписчики|followers)$/i;
    const tabs = root.querySelectorAll('a, button, [role="tab"], li');
    for (const el of tabs) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!re.test(t)) continue;
      const selected = el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') === 'true';
      const cls = el.className || '';
      if (selected || /active|selected/i.test(cls)) return;
      afkSimulateClick(el);
      await igxSleep(1500);
      return;
    }
  }

  // Добиться открытого списка подписчиков и вернуть контейнер со строками.
  // После перехода на /юзернейм/followers/ ИГ не всегда сам открывает модалку —
  // тогда кликаем по ссылке «подписчики» на профиле. Если ИГ показывает список всей страницей — работаем со страницей.
  async function afkEnsureList(timeoutMs) {
    const deadline = Date.now() + Math.min(timeoutMs || 15000, 15000);
    let clickAttempts = 0;

    while (Date.now() < deadline) {
      if (!(await afkRunning()) || afkIsPrivateProfilePage()) return null;
      let d = afkDialog();
      if (d && /люди, на которых вы подпишетесь, будут отображаться здесь|people you follow will (?:appear|show up) here/i.test(d.innerText || '')) break;
      if (d && afkUserCount(d) > 0) return d;

      // На URL /followers/ без модалки — кликаем по счётчику подписчиков (до 5 попыток).
      if (clickAttempts < 5) {
        const clicked = await afkClickFollowers();
        if (clicked) clickAttempts++;
        d = await afkWaitDialog(Math.max(1, Math.min(3000, deadline - Date.now())));
        if (d && afkUserCount(d) > 0) return d;
      }

      // Запасной вариант: модалка есть, но afkWaitDialog не дождался — берём только её.
      const d2 = afkDialog();
      if (d2 && afkUserCount(d2) > 0) return d2;

      await igxSleep(1000);
    }
    if (!afkIgBlockSignal()) {
      const owner = afkProfileOwner();
      if (owner) {
        const key = 'igx_unavailable_donors';
        const unavailable = (await chrome.storage.local.get(key))[key] || {};
        unavailable[owner.toLowerCase() + ':' + afkPhaseKind] = Date.now() + 6 * 60 * 60 * 1000;
        await chrome.storage.local.set({[key]: unavailable});
      }
    }
    return null;
  }

  // Полная зачистка «прогон точно мёртв»: дашборд гасит окно по исчезновению ключа
  // (плюс по несвежему hb — это страховка, если вкладку закрыли посреди очистки).
  async function afkPurgeRunState() {
    setSessionAfkState(null);
    try {
      await chrome.storage.local.remove(getAfkSessionKey());
    } catch (_) {}
    try {
      const tId = await getTabId();
      if (tId) await chrome.storage.local.remove(`igx_afk_tab_${tId}`);
    } catch (_) {}
    // Ключ каденции igx_risk_tab_<sid> НЕ удаляем: его checkTimes — это «жар сессии»,
    // который реактор должен помнить ещё долго после остановки (иначе шкала обваливается
    // в момент стопа, хотя аккаунт ещё горячий). Протухшие ключи чистит дашборд.
  }

  /**
   * Честная пауза «бесконечного» прогона. Цикл умеет ИМЕННО ЖДАТЬ (доноры по фильтрам
   * кончились, список потерялся и поднимаю прогон, другой прогон должен догнать базу).
   * Пишем абсолютный дедлайн и причину в состояние вкладки — дашборд рисует «⏸ на паузе
   * N с», и минута тишины перестаёт выглядеть как «всё вырубилось само». Дедлайн протухает
   * сам, поэтому явный сигнал «снял паузу» не нужен, но каждое НОВОЕ ожидание обязано
   * переписать его, иначе цифра останется от прошлого ожидания.
   */
  async function afkPause(ms, why) {
    afkProg(); // объявить ожидание — это шаг цикла: пауза не должна выглядеть зависанием
    try {
      await afkPatchState({ pauseTill: Date.now() + Math.max(0, Number(ms) || 0), pauseWhy: String(why || '') });
    } catch (_) {}
  }

  // «Бесконечный» значит бесконечный: серия сбоев — это НЕ стоп, а длинная пауза с
  // видимым обратным отсчётом. Полностью останавливаем только после HARD_REST_MAX таких
  // пауз подряд: иначе невыполнимый фильтр/битый ИГ кормил бы вечный hot-loop.
  const HARD_REST_MS = 120000;
  const HARD_REST_MAX = 3;
  async function afkInfiniteRest(why) {
    if (_afkHardRests >= HARD_REST_MAX) return false;
    _afkHardRests++;
    _afkErrStreak = 0;
    afkSetBtnText('🤖 АФК∞: ' + why + ', беру паузу ' + Math.round(HARD_REST_MS / 60000) + ' мин (' + _afkHardRests + '/' + HARD_REST_MAX + ')…');
    await afkPause(HARD_REST_MS + 5000, why + ' — длинная пауза ' + Math.round(HARD_REST_MS / 60000) + ' мин (' + _afkHardRests + '/' + HARD_REST_MAX + ')');
    afkWake(HARD_REST_MS); // отменяемый: «стоп» обязан гасить и этот подъём
    return true;
  }

  // ── ШЛЮЗ «БЛОК / ХОЛОСТОЙ ХОД» ─────────────────────────────────────────────
  // Бан-детект существовал, но был ИСКЛЮЧИТЕЛЬНО пишущим: igBlockAt читали только
  // дашборд (красная карточка) и опциональный автопилот листа ⑤, который сам звал
  // stopAllInfinite(). Без включённого автопилота ферма на бане продолжала прыгать по
  // донорам всю ночь: 87 проверок за 11 часов, 588 списков и добитый аккаунт. HARD_REST
  // отсюда тоже не спасал: его счётчик — модульная переменная, которую afkLoop обнуляет
  // на КАЖДОМ открытом списке, а на бане списки открываются (просто пустые).
  // Поэтому серии пауз считаются в st.budget и живут до конца прогона.
  const BLOCK_REST_MS = 15 * 60000;  // сколько остываем на свежем сигнале блока
  const BLOCK_REST_MAX = 2;          // после N таких пауз — честный стоп с причиной в боте
  const IDLE_DEAD_STREAK = 12;       // списков подряд без единой проверки = холостой ход
  const IDLE_REST_MS = 5 * 60000;    // первая пауза на холостом ходу
  const IDLE_REST2_MS = 20 * 60000;  // вторая, длиннее: третий раз уже стопим, не мучим ИГ
  const IDLE_REST_MAX = 2;
  const BLOCK_FRESH_MS = 10 * 60000; // сигнал блока моложе этого считаем актуальным

  // О бане человек должен узнать СРАЗУ, а не через полчаса, когда ферма встанет. Карточку
  // в бота отдаёт tg.js; дедуп («не чаще раза в полчаса») живёт там же, поэтому несколько
  // окон не устроят спам.
  // Гейт «выключенный прогон молчит»: шлюз мог решить слать карточку, а человек за эти
  // секунды уже нажал «стоп» (или стоп пришёл с дашборда, или дашборд досылал сообщение по
  // сети) — тогда уведомление про ферму, которой больше нет, читается как «я выключил, а оно
  // само решило, что меня забанили». Плюс в карточке обязательны КТО говорил (вкладка) и
  // ЧТО будет (остыл/встал): прежний текст наврал «пауза 15 мин» даже на честном стопе.
  async function afkBanAlert(why, budgetText, verdict) {
    try {
      const st = await afkGetState();
      if (!st || !st.on) return;
      const owner = String(afkOwnerFromUrl() || st.cur || st.seed || '').replace(/^@+/, '');
      chrome.runtime
        .sendMessage({
          type: 'tgBanAlert',
          why: String(why || ''),
          budgetText: String(budgetText || ''),
          verdict: String(verdict || ''),
          owner,
        })
        .catch(() => {});
    } catch (_) {}
  }

  // Вызывается на границе каждого списка, ДО выбора следующего донора.
  // Возвращает: '' — всё чисто, идём дальше; 'rest' — отдохнули (циклу надо сменить
  // донора); 'stop' — прогон остановлен с причиной (циклу — break).
  async function afkBanIdleGuard(st0, checksHere) {
    const b = bud();
    // ЭКРАН ВАЖНЕЕ СЧЁТЧИКОВ. Раньше первым шёл обход «проверки были → значит не блок»,
    // и ферма, которая стоит прямо на заглушке «попробуйте позже», но успела пробить
    // пару имён из списка, остывание НЕ брала: молча листала доноров дальше (отсюда и
    // «не видит бана, не пишет»). Теперь живой экран блока считаем всегда.
    let nowBlk = '';
    try { nowBlk = afkIgBlockSignal(); } catch (_) {}
    if (checksHere > 0 && !nowBlk) {
      // Список отдал людей и проверки были, и на экране чисто → любой «блок» был
      // транзиентной заглушкой, а ряд впустую обнулил сам budCloseList.
      b.blockRests = 0; b.idleRests = 0;
      return '';
    }
    let banWhy = nowBlk;
    if (!banWhy) {
      try {
        const rs = await afkRiskLoad();
        const at = Number(rs.igBlockAt) || 0;
        if (at && Date.now() - at < BLOCK_FRESH_MS) banWhy = String(rs.igBlockWhy || 'Instagram показывает экран блокировки');
      } catch (_) {}
    }
    const ban = !!banWhy;
    const idle = !ban && (Number(b.deadStreak) || 0) >= IDLE_DEAD_STREAK;
    if (!ban && !idle) return '';
    // Shared cached/busy candidates are not fresh checks. A run with twelve
    // such lists must move to another donor, not pause and eventually stop.
    if (idle) {
      b.deadStreak = 0;
      b.idleRests = 0;
      const owner = afkOwnerFromUrl();
      if (owner) {
        const key = 'igx_unavailable_donors';
        const unavailable = (await chrome.storage.local.get(key))[key] || {};
        unavailable[owner + ':' + afkPhaseKind] = Date.now() + 6 * 60 * 60 * 1000;
        await chrome.storage.local.set({[key]: unavailable});
      }
      await budSave();
      return '';
    }

    const infinite = !!(st0 && st0.infinite);
    const nrest = (Number(ban ? b.blockRests : b.idleRests) || 0) + 1;
    if (ban) b.blockRests = nrest; else b.idleRests = nrest;
    const restMs = ban ? BLOCK_REST_MS : (nrest >= 2 ? IDLE_REST2_MS : IDLE_REST_MS);
    const restMax = ban ? BLOCK_REST_MAX : IDLE_REST_MAX;
    const cause = ban
      ? banWhy
      : b.deadStreak + ' ' + budPlural(b.deadStreak, 'список подряд', 'списка подряд', 'списков подряд') + ' не дали ни одной проверки';
    await budSave();

    const stopWhy = ban
      ? 'Instagram блокирует работу (' + banWhy + '). Ферма остывала ' + Math.round(BLOCK_REST_MS / 60000) + ' мин ' +
        BLOCK_REST_MAX + ' ' + budPlural(BLOCK_REST_MAX, 'раз', 'раза', 'раз') + ' подряд, блок не снялся — прогон остановлен,' +
        ' чтобы не добить аккаунт. Открой instagram.com руками и посмотри, что там;' +
        ' авто-проверка (лист ⑤) после этого сама дождётся разбана.'
      : 'Холостой ход: ' + IDLE_DEAD_STREAK + '+ ' + budPlural(IDLE_DEAD_STREAK, 'список', 'списка', 'списков') +
        ' подряд без единой проверки, паузы не помогли — прогон остановлен, чтобы не долбить' +
        ' Instagram впустую. Обычно это значит: фильтры/ключевое слово слишком узкие или пул' +
        ' доноров пуст. Снизь фильтры и запусти заново.';
    if (!infinite || nrest > restMax) {
      await afkBanAlert(cause, budSummary(b, null), 'прогон ОСТАНОВЛЕН со сводкой — аккаунт дальше не долбим');
      await afkStop(stopWhy, ban);
      return 'stop';
    }
    // Первый случай бана — сигнал в бота; холостой ход в бота не пишем (у него есть
    // честный стоп с разбивкой бюджета, а шуметь на каждую серию пустых списков —
    // способ перестать читать уведомления).
    if (ban && nrest === 1) await afkBanAlert(cause, budSummary(b, null), 'ферма остывает: пауза ' + Math.round(restMs / 60000) + ' мин (' + nrest + '/' + restMax + '), после этого продолжу сам');
    const mins = Math.round(restMs / 60000);
    afkSetBtnText('🤖 АФК∞: ' + cause + ' — беру ' + mins + ' мин ' + budPlural(mins, 'паузу', 'паузы', 'пауз') + ' (' + nrest + '/' + restMax + ')…');
    await afkPause(restMs + 5000, (ban ? '🛑 блок Instagram: ' : '💨 холостой ход: ') + cause + ' — пауза ' + mins + ' мин (' + nrest + '/' + restMax + ')');
    // Спим ЗДЕСЬ, а не «выход из цикла + таймер»: сердцебиение продолжает работать,
    // поэтому дашборд видит живой прогон на паузе, а не «вкладку усыпило/прогон встал».
    await afkSleepBreakable(restMs);
    if (!(await afkRunning())) return 'stop';
    b.deadStreak = 0; // после паузы ряд пустых списков начинается заново
    await budSave();
    await afkPatchState({ pauseTill: 0, pauseWhy: '' }); // проснулись — обратный отсчёт на дашборде больше не нужен
    return 'rest';
  }

  // «Бесконечный» прогон и слово, которому некуда лечь. Это НЕ повод останавливать прогон:
  // список без поля поиска — обычное дело (короткий список, полностраничный вариант, чужая
  // модалка сверху). Отсюда раньше шёл afkStop, и ∞ умирал на первом же доноре (~2 минуты,
  // записанная причина была ровно такая: «в этом списке нет поля поиска — слово «Онлайн»
  // ввести некуда»). Возврат: true → прогон сам ушёл (навигация или длинная пауза), циклу
  // надо выходить через return; false → прыгать некуда, честный стоп уже записан.
  async function afkSkipNoSearch(box, tok, res) {
    _afkNoSearchStreak++;
    const owner = afkOwnerFromUrl();
    const why = res === 'noinput'
      ? `список без поля поиска — слово «${tok}» вводить некуда`
      : `слово «${tok}» не получилось ввести в поиск`;
    afkSetBtnText('🤖 АФК∞: ' + why + ', беру другого донора (подряд ' + _afkNoSearchStreak + ')…');
    // Третий подряд — значит, дело не в одном окне. Донора мы НЕ помечаем «выжатим»:
    // markDone снимает его из пула навсегда (isDoneKind в afkGreenCandidates), а «поля
    // поиска нет» — свойство момента (вёрстка ИГ, чужая модалка сверху), а не человека.
    // Иначе такая серия молча сжигала бы базу доноров, и «люди заканчивались» бы быстрее,
    // чем они реально кончаются. Вместо этого — в visited прогона: до сброса круга не вернёмся.
    if (_afkNoSearchStreak >= 3) {
      if (owner) await afkSkipDonorThisRound(owner);
      if (await afkInfiniteRest(why + ' — подряд ' + _afkNoSearchStreak + ' раз')) return true;
    }
    if (await afkInfiniteNewSeed(true)) return true;
    await afkStop(why + ', и других доноров в базе не осталось. Где искали: ' + afkSearchDiag(box));
    return false;
  }

  // «В этом круге к этому донору не возвращаемся» — мягкая замена markDone: visited
  // живёт в состоянии прогона и сбрасывается на новом круге, пул доноров не уменьшается.
  async function afkSkipDonorThisRound(u) {
    try {
      const st = await afkGetState();
      const vis = new Set((st && st.visited) || []);
      const key = String(u).toLowerCase();
      if (vis.has(key)) return;
      vis.add(key);
      await afkPatchState({ visited: Array.from(vis) });
    } catch (_) {}
  }

  async function afkStop(reason, banned) {
    // Двойной стоп — это не «останавливали два раза», а два разных объяснения одного
    // факта: шлюз «блок/холостой ход» уже назвал причину, а ветка цикла, куда он вернул
    // 'stop', зовёт afkStop со своей формулировкой («список не открылся»). Первый стоп
    // главнее: иначе в истории две записи прогона, а в боте два отчёта с РАЗНЫМИ
    // причинами — и человек не понимает, что реально убило ночной прогон.
    try {
      const stDup = await afkGetState();
      if (!stDup || !stDup.on || stDup.stopping) return;
    } catch (_) {}
    // «Стоп» — это команда, а не факт. Цикл мог уйти в igxSleep(30000) или в скролл
    // огромного списка и по-настоящему доскроллит через 10-40 с. Пока тело цикла ещё
    // на стеке (afkLoopBusy), сердцебиение НЕ глушим и ключи прогона НЕ удаляем: иначе
    // дашборд в ту же секунду рисует «0 активных» и врёт. Вместо этого пишем
    // stopping:true — дашборд показывает «⏳ Остановка: ещё работает N», а настоящей
    // зачисткой занимается finally самого afkLoop.
    const winding = afkLoopBusy > 0;
    afkLoopActive = false;
    afkWakeCancel(); // «подниматель» по таймеру тоже умирает вместе с прогоном
    if (!winding && afkHbTimer) { clearInterval(afkHbTimer); afkHbTimer = null; } // стоп — сердцебиение больше не пишем
    // Цифры на момент стопа перечитываем из базы ещё раз: иначе в историю и в отчёт
    // бота уехал бы устаревший снимок (последний пересчёт был до текущего шага).
    try {
      await afkRefreshTotals();
    } catch (_) {}
    // Бесконечный прогон дописываем в глобальный статус — дашборд покажет причину стопа.
    try {
      const stR = await afkGetState();
      if (stR && stR.infinite) {
        const stoppedAt = Date.now();
        await chrome.storage.local.set({ [AFK_INFINITE_KEY]: { on: !!banned, banned: !!banned, stoppedAt, reason: String(reason || '') } });
        // Архивируем завершённый прогон в историю (модалка «История» на дашборде).
        try {
          const tabIdR = await getTabId();
          const hist = await chrome.storage.local.get(AFK_RUN_HISTORY_KEY);
          const arr = Array.isArray(hist[AFK_RUN_HISTORY_KEY]) ? hist[AFK_RUN_HISTORY_KEY] : [];
          arr.unshift({
            id: 'run_' + (stR.startedAt || stoppedAt) + '_' + Math.random().toString(36).slice(2, 7),
            tabId: tabIdR || 0,
            seed: stR.seed || stR.cur || '',
            startedAt: stR.startedAt || 0,
            stoppedAt,
            durationMs: Math.max(0, stoppedAt - (stR.startedAt || stoppedAt)),
            totals: stR.totals || { checked: 0, foundTg: 0, foundFit: 0 },
            lists: (stR.lists || []).length,
            visited: (stR.visited || []).length,
            budget: stR.budget || null, // разкладка расхода — дашборд покажет «куда ушли минуты»
            reason: String(reason || ''),
          });
          await chrome.storage.local.set({ [AFK_RUN_HISTORY_KEY]: arr.slice(0, 60) });
        } catch (_) {}
      }
    } catch (_) {}
    // Финальная сводка в бота — ОДИН раз за весь прогон, до очистки состояния.
    // (Раньше отчёт уходил после каждого списка — бот спамил одинаковыми сводками.)
    try {
      await afkSendFinalReport(reason);
    } catch (_) {}
    await afkPatchState({ on: false, needSearch: false, stopping: winding, stoppingSince: winding ? Date.now() : 0, pauseTill: 0, pauseWhy: '' });
    if (!winding) await afkPurgeRunState();
    // Пока вкладка догорает, кнопка на сайте не должна притворяться свободной.
    if (winding) afkSetBtnText('🤖 АФК: остановка — досматриваю текущий шаг…');
    else afkSetBtn(false);
    if (sidePanelEl) {
      const chk = sidePanelEl.querySelector('.igx-chk-afk');
      if (chk) chk.checked = false;
      if (reason) {
        // Если панель скрыта (модалки нет) — тултип на неё был бы невидим, якоримся к body.
        const anchor = sidePanelEl.style.display === 'none' ? document.body : sidePanelEl;
        showTooltip(`🤖 АФК стоп: ${reason}`, anchor);
        setTimeout(hideTooltip, 9000);
      }
    } else if (reason) {
      showTooltip(`🤖 АФК стоп: ${reason}`, document.body);
      setTimeout(hideTooltip, 9000);
    }
  }

  // Кнопка автопроверки показывает, что сейчас крутится АФК и сколько уже проверено.
  function afkSetBtn(running, count) {
    const panel = document.querySelector('.igx-side-panel');
    if (!panel) return;
    const btn = panel.querySelector('.igx-btn-autocheck');
    if (!btn) return;
    if (running) {
      btn.textContent = `🤖 АФК: проверено ${count || 0} — нажми для стопа`;
      btn.className = 'igx-btn-autocheck is-running';
    } else if (!isBatchRunning) {
      btn.textContent = '⚡ Автопроверка списка';
      btn.className = 'igx-btn-autocheck';
    }
  }

  // Фаза скролла до дна списка (проверки ещё не начались — показываем это отдельно).
  function afkSetBtnScroll() {
    const panel = document.querySelector('.igx-side-panel');
    if (!panel) return;
    const btn = panel.querySelector('.igx-btn-autocheck');
    if (!btn) return;
    btn.textContent = '🤖 АФК: листаю список до конца… — нажми для стопа';
    btn.className = 'igx-btn-autocheck is-running';
  }

  function afkSetBtnText(text) {
    const panel = document.querySelector('.igx-side-panel');
    if (!panel) return;
    const btn = panel.querySelector('.igx-btn-autocheck');
    if (!btn) return;
    btn.textContent = text;
    btn.className = 'igx-btn-autocheck is-running';
  }

  // Скроллим контейнер вниз, пока не перестанут подгружаться новые строки.
  // box может быть модалкой или всей страницей (тогда крутим окно).
  // Возврат: true — дно ПОДТВЕРЖДЕНО (4 круга без новичков); 'cut' — список докрутили
  // не до конца (упёрлись в потолок времени или в 400 тиков); false — стоп/пропал блок.
  // Потолок нужен потому, что без него один огромный список жрал минуты целиком: ночной
  // прогон давал 67 с на донора при 85% списков впустую, а на длинных списках
  // скролл снимал до 10 минут IG-времени (400 тиков × 1.5 с) ради нуля проверок.
  // ВАЖНО: 'cut' — правдивый ответ, и по нему донора НЕЛЬЗЯ помечать «выжатым»
  // (markDone снимает его из пула навсегда — непрочитанный хвост списка пропал бы).
  const SCROLL_MAX_MS = 120000; // потолок прокрутки ОДНОГО списка (на каждое ключевое слово)
  async function afkScrollToEnd(box) {
    const isPage = box === document.body;
    const t0 = Date.now();
    let sc = null;
    if (!isPage) {
      for (const el of box.querySelectorAll('div')) {
        if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200) {
          if (!sc || el.clientHeight > sc.clientHeight) sc = el;
        }
      }
    }
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 400; i++) {
      if (!(await afkRunning()) || !document.contains(box)) return false;
      if (Date.now() - t0 > SCROLL_MAX_MS) return 'cut'; // дно не подтверждено — так и честно возвращаем
      if (sc) sc.scrollTop = sc.scrollHeight;
      else window.scrollTo(0, document.documentElement.scrollHeight);
      await igxSleep(1500);
      const count = afkUserCount(box);
      if (count === last) {
        stable++;
        if (stable >= 4) return true; // 4 круга без новичков — дно
      } else {
        stable = 0;
        last = count;
      }
    }
    return 'cut'; // 400 тиков прошли, а новички всё идут — это не дно, а предел
  }

  // ---------- автодогрузка списка вручную (когда сам долисталь до низа) ----------
  // Instagram грузит подписчиков/подписки лениво: строки допишются, когда его
  // IntersectionObserver снова увидит дно контейнера. АФК крутит список сам
  // (afkScrollToEnd), а при РУЧНОЙ прокрутке событие не вспыхивает — и старые
  // профили в самом низу встают: список есть, а дальше не грузится. Этот наблюдатель
  // «будит» родной ленивый загрузчик: как только видимый список упёрся в дно и рост
  // остановился, чуть откатываем контейнер и возвращаем в низ + шлём scroll-событие.
  // НЕ мешает АФК/пачке: пока идёт afkLoop, наблюдатель молчит.
  const IGX_BOTTOM_LOAD_KEY = 'igx_bottom_load'; // по умолчанию ВКЛ; false — выключить
  let igxBottomLoadOn = true;
  try {
    chrome.storage.local.get([IGX_BOTTOM_LOAD_KEY], (d) => { igxBottomLoadOn = !d || d[IGX_BOTTOM_LOAD_KEY] !== false; });
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === 'local' && c[IGX_BOTTOM_LOAD_KEY]) igxBottomLoadOn = c[IGX_BOTTOM_LOAD_KEY].newValue !== false;
    });
  } catch (_) {}
  // Узлы кэшируем: пересобираем список только когда текущий контейнер устарел
  // (Instagram пересоздаёт узлы после навигации), а не каждый тик — на списке из
  // тысяч строк сплошной обход div-ов лагал бы.
  const bl = { dialog: null, sc: null, last: -1, stable: 0, gaveUp: false, at: 0 };
  setInterval(() => {
    if (!igxBottomLoadOn) return;
    if (afkLoopActive) { bl.dialog = null; bl.sc = null; bl.stable = 0; bl.gaveUp = false; bl.last = -1; return; }
    const stale = !bl.dialog || !document.contains(bl.dialog) || !bl.sc || !document.contains(bl.sc) || !(bl.sc.scrollHeight > bl.sc.clientHeight + 50);
    if (stale) {
      bl.dialog = null; bl.sc = null; bl.stable = 0; bl.gaveUp = false; bl.last = -1;
      for (const d of document.querySelectorAll('[role="dialog"]')) {
        let sc = null;
        for (const el of d.querySelectorAll('div')) {
          if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200 && (!sc || el.clientHeight > sc.clientHeight)) sc = el;
        }
        if (sc && afkUserCount(d) > 0) { bl.dialog = d; bl.sc = sc; break; }
      }
      if (!bl.sc) return;
    }
    const sc = bl.sc;
    const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 12;
    if (!atBottom) { bl.gaveUp = false; bl.stable = 0; return; } // ушёл от дна — снова готовы грузить
    const count = afkUserCount(bl.dialog);
    if (count !== bl.last) { bl.last = count; bl.stable = 0; bl.gaveUp = false; } // догрузились — сброс
    else { bl.stable++; if (bl.stable >= 14) { bl.gaveUp = true; return; } } // ~11с застоя → это реальное дно
    if (bl.gaveUp) return;
    const now = Date.now();
    if (now - bl.at < 1200) return; // кулдаун, чтобы не долбить ИГ каждый кадр
    bl.at = now;
    try {
      sc.scrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight - 60);
      sc.dispatchEvent(new Event('scroll', { bubbles: true }));
      setTimeout(() => { try { sc.scrollTop = sc.scrollHeight; sc.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {} }, 150);
    } catch (_) {}
  }, 800);

  // ---------- шкала риска бана: метрики пишет content, рисует дашборд ----------
  // Ключ общий с дашбордом (dashboard.js читает его же). Метрики копятся в storage, а
  // не в памяти вкладки: между экспертами страница перезагружается и память обнуляется,
  // а «сколько смотрим в час / подряд без перерыва» обязан переживать навигацию.
  const RISK_STATE_KEY = 'igx_risk_state';
  async function afkRiskLoad() {
    let s = null;
    try {
      const d = await safeStorageGet([RISK_STATE_KEY]);
      s = d && d[RISK_STATE_KEY];
    } catch (_) {}
    if (!s || typeof s !== 'object') s = {};
    if (!Array.isArray(s.checkTimes)) s.checkTimes = [];
    s.consec = Number(s.consec) || 0;
    return s;
  }
  async function afkRiskSave(s) {
    s.updatedAt = Date.now();
    try { await safeStorageSet({ [RISK_STATE_KEY]: s }); } catch (_) {}
  }
  // ── Каденция ПО ОКНУ. Раньше все окна писали темп/паузу/ряд в один общий
  // igx_risk_state, и при параллельной работе окна затирали друг друга
  // (read-modify-write без блокировки) — реактор показывал скорость и паузу примерно
  // ОДНОГО окна, а не сумму по всем. Теперь каждое окно ведёт СВОЙ ключ
  // igx_risk_tab_<sid>, а дашборд агрегирует живые окна в общее. Бан/tgFlood при этом
  // остаются в общем igx_risk_state — это и правда глобальные события аккаунта.
  const RISK_TAB_PREFIX = 'igx_risk_tab_';
  function riskTabKey() { return RISK_TAB_PREFIX + afkSid(); }
  async function afkRiskLoadTab() {
    let s = null;
    try {
      const key = riskTabKey();
      const d = await safeStorageGet([key]);
      s = d && d[key];
    } catch (_) {}
    if (!s || typeof s !== 'object') s = {};
    if (!Array.isArray(s.checkTimes)) s.checkTimes = [];
    s.consec = Number(s.consec) || 0;
    return s;
  }
  async function afkRiskSaveTab(s) {
    s.updatedAt = Date.now();
    try { await safeStorageSet({ [riskTabKey()]: s }); } catch (_) {}
  }
  // Один чек профиля: запоминаем время (для «проверок/час»), скользящее среднее паузы, ряд «подряд».
  async function afkRiskNoteCheck(pauseMs) {
    const s = await afkRiskLoadTab();
    const now = Date.now();
    s.checkTimes = s.checkTimes.filter((t) => now - t < 3600000);
    s.checkTimes.push(now);
    if (s.checkTimes.length > 600) s.checkTimes.splice(0, s.checkTimes.length - 600);
    s.consec += 1;
    // «Реактор»: следим, сколько идём подряд без длинной остановки. Даже при безопасном
    // темпе (1 чек/10с) марафон на часы утомляет аккаунт. Длинный разрыв (>5 мин или
    // >6× паузы) = остывание реактора — обнуляем счётчики непрерывной работы.
    const gap = now - (Number(s.lastCheckAt) || 0);
    const coolMs = Math.max(300000, (Number(pauseMs) || 4000) * 6);
    if (!s.runSince || gap > coolMs) { s.runSince = now; s.totalChecks = 0; }
    s.totalChecks = (Number(s.totalChecks) || 0) + 1;
    s.lastCheckAt = now;
    const prev = Number(s.avgPauseMs) || 0;
    s.avgPauseMs = prev ? Math.round(prev * 0.8 + pauseMs * 0.2) : Math.round(pauseMs);
    await afkRiskSaveTab(s);
    return s;
  }
  // Признак блока Instagram. КЛЮЧЕВОЙ антивложняк: сначала смотрим, отдаёт ли страница
  // ЖИВОЙ контент (профиль с постами / открытый список с людьми). Если да — это ТОЧНО
  // не блок, и любые подстроки из био/подписей/комментов («попробуйте позже», «checkpoint»,
  // «you can't», «нужно подождать» и т.п.) больше не поднимают ложный «тя ебнуло».
  function afkPageHealthy() {
    try {
      const box = afkDialog();
      if (box && afkIterUserLinks(box, false).length > 0) return true;      // список отдаёт людей
      const main = document.querySelector('main');
      if (!main) return false;
      if (main.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]').length >= 3) return true; // сетка постов
      return false;
    } catch (_) { return false; }
  }
  // «Пустой список = блок» требует СИЛЬНЫЙ признак: заглушку Instagram «здесь будут
  // отображаться все ваши подписчики / все, на кого вы подписаны». Без неё 0 ссылок —
  // это загрузка/зависание/реально пустой после фильтра по словам, а НЕ бан.
  const IG_EMPTY_LIST_RE = /здесь будут отображаться все ваши подписчики|здесь будут отображаться все,? ?на кого вы подписаны|here,? you.?ll see all your followers|here,? you.?ll see all the people/i;
  function afkEmptyListPlaceholder(box) {
    try {
      const el = box || afkDialog();
      if (!el) return false;
      return IG_EMPTY_LIST_RE.test(String(el.innerText || ''));
    } catch (_) { return false; }
  }
  // Что СЧИТАТЬ экраном блока. Прежний список фраз был слишком узким и это и есть
  // «он не видит бана»: Instagram на лимите действий пишет «We're temporarily BLOCKING
  // this feature», «You're unable to follow at this time», «Please wait a few minutes
  // before you try again», «Try again in 1 hour», «Действия ограничены» — а шаблоны
  // ловили только «temporarily BLOCKED» и «try again later». Ферма стояла всю ночь
  // перед экраном блока и не считала его блоком, поэтому в боте было тихо.
  const IG_BLOCK_RE = /temporarily (?:blocked|blocking)|action (?:blocked|not allowed|isn.?t allowed)|this action.?s not allowed|bulk actions|(?:you.?re|we.?re) unable to (?:follow|like|comment|post)|unable to (?:follow|send) at this time|please (?:stop and )?try again|try again (?:later|in|after)|please wait (?:a few|some|about)? ?(?:minutes|seconds|hours)|follow(?:ing)? too (?:fast|many)|too many (?:requests|follows|actions|likes|messages)|rate limit|you.?ve reached (?:the )?(?:daily|action) ?limit|account (?:has been )?(?:locked|temporarily disabled|disabled)|checkpoint|confirm it.?s you|подтвердите,? ?что это вы|временно заблокир|деятельность заблокир|действия ограничены|доступ ограничен|слишком много (?:запрос|действий|подписок|лайков|сообщений)|повторите попытку (?:позже|через)|попробуйте (?:позже|чуть позже|ещё раз через)|через несколько (?:минут|часов)|не удаётся (?:подписаться|отправить|загрузить)|сделайте паузу|здесь будут отображаться все ваши подписчики|здесь будут отображаться все,? на кого вы подписаны|here,? you.?ll see all your followers|here,? you.?ll see all the people/i;
  function afkIgBlockSignal() {
    try {
      // ПОРЯДОК ВАЖЕН: сначала ЛЮБАЯ модалка. Раньше первым шёл «живой экран → не блок»,
      // и заглушка, всплывшая ПОВЕРХ ещё не свёрнутого профиля или сетки постов,
      // игнорилась: main формально живой, а человек (и ферма) упирается в «попробуйте
      // позже». Смотрим все [role="dialog"], а не первый: Instagram держит случайный
      // диалог («сохранить вход»), и блок мог лежать во втором.
      for (const d of document.querySelectorAll('[role="dialog"]')) {
        if (IG_BLOCK_RE.test(String(d.innerText || '').toLowerCase())) return 'Instagram: экран блокировки/лимита (модалка)';
      }
      if (afkPageHealthy()) return '';   // живой контент → не блок (людей отдают или сетка открыта)
      const main = document.querySelector('main');
      // Весь body читаем ТОЛЬКО если main пропал: Instagram заменил приложение экраном-
      // заглушкой. Био и подписи живут внутри main, при живом main чужие посты в счёт не идут.
      const txt = String((main && main.innerText) || (!main && document.body && document.body.innerText) || '').toLowerCase();
      if (IG_BLOCK_RE.test(txt)) return 'Instagram: экран блокировки/лимита';
      // Экран входа вместо всего контента (main вообще нет):
      if (!main && /log in|войдите|sign in|haven.?t been logged in|been logged out/.test(txt)) {
        return 'Instagram: выкинуло на экран входа';
      }
    } catch (_) {}
    return '';
  }
  async function afkRiskNoteBlock(why) {
    const s = await afkRiskLoad();
    s.igBlockAt = Date.now();
    s.igBlockWhy = why || 'признак блока Instagram';
    await afkRiskSave(s);
  }
  // Успешная загрузка профиля/списка СБРАСЫВАЕТ флаг бана: транзиентная заглушка не должна
  // держать реактор красным полчаса, когда аккаунты дальше открываются нормально.
  async function afkRiskClearBlock() {
    const s = await afkRiskLoad();
    if (s.igBlockAt) { s.igBlockAt = 0; s.igBlockWhy = ''; await afkRiskSave(s); }
  }
  // Длинный сон с проверкой «стоп»: автоперерыв бывает минутами, а «стоп» должен
  // сработать сразу — спим кусками по секунде и следим, жив ли ещё прогон.
  async function afkSleepBreakable(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!(await afkRunning())) return false;
      await igxSleep(Math.max(120, Math.min(1000, end - Date.now())));
    }
    return true;
  }

  // Уведомление о старте/окончании автоперерыва: пишем одноразовый ключ-событие, дашборд
  // в scanNotifs подхватывает его, показывает карточку «вкладка N перерыв/продолжил» и тут
  // же удаляет ключ (не копит мусор). phase: 'start' | 'end'.
  async function afkNoteBreakEvent(phase, mins) {
    try {
      const at = Date.now();
      const key = 'igx_break_evt:' + afkSid() + ':' + at;
      await safeStorageSet({ [key]: { sid: afkSid(), phase, mins: Math.max(0, Number(mins) || 0), owner: afkOwnerFromUrl() || '', at } });
    } catch (_) {}
  }

  // Чекает всех непроверенных в модалке (с троттлом из настроек).
  // Пропускаем блок «Подписаны (твои подписки)» — это не целевые эксперты.
  async function afkCheckAll(dialog) {
    if ((afkFindSearchInput(dialog)?.value || '').trim().toLowerCase() !== 'тренер') return [];
    const toCheck = [];
    for (const { u } of afkIterUserLinks(dialog, true)) {
      const p = await getProfile(u);
      if (!p || (p.followers == null && Date.now() - Number(p.checkedAt || 0) > 60000)) toCheck.push(u);
    }
    const checked = [];
    for (const u of toCheck) {
      if (!(await afkRunning())) break;
      pendingUsers.add(u.toLowerCase());
      updateUIForUser(u);
      const settings = await getSettings();
      const base = Math.max(1000, settings.throttleMs || 4000); // пол 1 с (см. note выше): риск-шкала это учитывает
      // Джиттер: ±jitterSec к паузе, чтобы не долбить строго метрономно (это палит бота).
      const jit = Math.max(0, Math.min(60, Number(settings.jitterSec) || 0)) * 1000;
      const throttle = Math.max(1000, Math.round(jit ? base + (Math.random() * 2 - 1) * jit : base));
      bud().pauseMs = throttle; // сколько стоит одна проверка по текущим настройкам (для «почему медленно»)
      try {
        let result;
        do {
          if (!(await afkRunning())) break;
          result = await igxSend({type:'quickCheck', username:u, url:`https://www.instagram.com/${u}/`}, 8000);
          if (result?.wait) await igxSleep(1000);
        } while (result?.wait);
        if (!result?.ok || result.skipped) {
          pendingUsers.delete(u.toLowerCase());
          updateUIForUser(u);
          continue;
        }
      } catch (_) {
        pendingUsers.delete(u.toLowerCase());
        continue;
      }
      await igxSleep(throttle);
      pendingUsers.delete(u.toLowerCase());
      updateUIForUser(u);
      checked.push(u);
      await afkNoteChecked(u); // прогон запомнил имя: ТГ у него может появиться позже
      afkProg(); // шаг сделан буквально: это и есть «цикл жив», а не только таймеры
      afkSetBtn(true, checked.length); // живой счётчик на кнопке: видно что процесс идёт
      // --- риск/автоперерыв ---
      const blk = afkIgBlockSignal();
      if (blk) {
        await afkRiskNoteBlock(blk);
        // Долбить дальше по списку, стоя на экране «попробуйте позже», — это и есть
        // «он не видит бана». Чеки обрываем сразу: имена никуда не денутся (список
        // перечишится после остывания), а аккаунт перестанет ловить удары по лимиту.
        // Граница списка тут же отдаст это в шлюз «блок/холостой ход» — там пауза,
        // счётчик остываний и карточка в бота.
        afkSetBtnText('🤖 АФК∞: ' + blk + ' — обрываю проверки, идём остывать…');
        break;
      } else if (afkPageHealthy()) await afkRiskClearBlock();
      const rs = await afkRiskNoteCheck(throttle);
      const breakEvery = Math.max(0, Number(settings.breakEvery) || 0);
      if (breakEvery > 0 && rs.consec % breakEvery === 0) {
        const mins = Math.max(1, Number(settings.breakMin) || 5);
        afkSetBtnText(`☕ Автоперерыв ${mins} мин (после ${breakEvery} проверок)…`);
        await afkNoteBreakEvent('start', mins);           // «вкладка N — перерыв» в шторку
        // Пауза обязательна и в pauseTill: без неё минутный кофе-брейк выглядел бы для
        // вотчдога зависания как «цикл встал», и прогон убивался бы на ровном месте.
        await afkPause(mins * 60000 + 4000, '☕ автоперерыв ' + mins + ' мин (после ' + breakEvery + ' проверок)');
        const brT0 = Date.now();
        const woke = await afkSleepBreakable(mins * 60000);
        bud().breaksMs += Date.now() - brT0; // перерыв — тоже расход прогона, его надо видеть
        const s2 = await afkRiskLoadTab();
        s2.consec = 0;
        s2.runSince = Date.now();   // перерыв = остывание: марафон начинается заново
        s2.totalChecks = 0;
        s2.lastBreakAt = Date.now();
        await afkRiskSaveTab(s2);
        if (!woke) break; // остановили во время перерыва
        afkSetBtn(true, checked.length);
        await afkPatchState({ pauseTill: 0, pauseWhy: '' }); // проснулись — обратный отсчёт больше не нужен
        await afkNoteBreakEvent('end', mins);             // «вкладка N — продолжил» в шторку
      }
    }
    await igxSleep(1500); // хвост: последние вкладки доизвлекают данные
    return checked;
  }

  // Владелец текущего списка — из URL (/username/followers/... или страница профиля под модалкой).
  function afkOwnerFromUrl() {
    const m = location.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/(?:followers|following)/i);
    if (m) return m[1].toLowerCase();
    const u = extractUsername(location.pathname);
    return u ? u.toLowerCase() : null;
  }

  // Копим проверенные списки (для финального отчёта): владелец + сколько в нём
  // перечекано + сколько у самого владельца подписчиков.
  async function afkRecordList(owner, count, followers) {
    const st = await afkGetState();
    if (!st) return;
    const lists = Array.isArray(st.lists) ? st.lists.slice() : [];
    const name = owner || `список ${lists.length + 1}`;
    const ex = lists.find((l) => l.owner === name);
    if (ex) {
      ex.count += count;
      if (followers != null) ex.followers = followers;
    } else {
      lists.push({ owner: name, count, followers: followers != null ? followers : null });
    }
    await afkPatchState({ lists });
  }

  // ── Бюджет аккаунта ────────────────────────────────────────────────────────
  // «Медленно» — это не ощущение, а разкладка: сколько минут IG-времени список
  // прокручивался и сколько проверок из него вышло. Узкое место ищет именно
  // пропорция deadMs/ms (время, отданное спискам, которые не дали ни одной
  // проверки), а не скорость скролла.
  // Пишется в chrome.storage РОВНО раз на список — рядом с afkRecordList. На
  // каждую проверку трогать storage нельзя: пайплайн от этого уже вешали.
  // Счётчики живут в st.budget, потому что прыжок к новому донору перезагружает
  // страницу, а прогон продолжается — расход обязан пережить навигацию.
  function budFresh() {
    // cuts / deadStreak / blockRests / idleRests — не «красивые цифры», а счётчики
    // реакции прогона: сколько списков срезано потолком скролла, сколько пустых
    // подряд (это триггер холостого хода) и сколько остываний после блока уже брали.
    // Живут именно здесь, потому что st.budget переживает перезагрузку страницы, а
    // модульные переменные обнуляются на каждом открытом списке.
    return { ms: 0, lists: 0, rows: 0, checks: 0, deadLists: 0, deadMs: 0, emptyLists: 0, wordEmpty: 0, jumps: 0, deadJumps: 0, breaksMs: 0, pauseMs: 0, cuts: 0, deadStreak: 0, blockRests: 0, idleRests: 0, wasted: 0, at: 0 };
  }
  let _bud = null;
  function bud() { if (!_bud) _bud = budFresh(); return _bud; }
  async function budLoad() {
    if (_bud) return _bud;
    let b = null;
    try {
      const st = await afkGetState();
      b = st && st.budget;
    } catch (_) {}
    _bud = b && typeof b === 'object' ? Object.assign(budFresh(), b) : budFresh();
    return _bud;
  }
  async function budSave() {
    const b = bud();
    b.at = Date.now();
    try { await afkPatchState({ budget: Object.assign({}, b) }); } catch (_) {}
  }
  // Граница списка: приносим его расход в общий бюджет.
  // ms — от «список живой» до границы (скролл + фильтр по слову + все чек-паузы),
  // rows — сколько людей в нём было видно, checks — сколько реально перечекано.
  async function budCloseList(ms, rows, checks, wasJump, empty) {
    const b = bud();
    const spent = Math.max(0, Math.round(ms));
    b.ms += spent;
    b.lists++;
    b.rows += Math.max(0, rows | 0);
    b.checks += Math.max(0, checks | 0);
    if (empty) b.emptyLists++;
    if (!(checks > 0)) {
      b.deadLists++;
      b.deadMs += spent;
      b.deadStreak = (Number(b.deadStreak) || 0) + 1; // ряд «впустую» подряд — по нему ловят холостой ход
      // Прыжок к донору из базы, который не дал ни одной проверки, — самый
      // дорогой вид брака: потратили навигацию, загрузку, открытие списка.
      if (wasJump) b.deadJumps++;
    } else {
      b.deadStreak = 0; // хоть одна проверка — ряд сломан, ферма снова добывает
    }
    await budSave();
  }
  function budMin(ms) { return ms / 60000; }
  // Компактный расход для панели на самом Instagram: «впустую N%» надо видеть ДО того,
  // как прогон отработает час вхолостую, а не только в истории постфактум.
  function budMini(b) {
    if (!b || !b.lists) return '';
    const min = budMin(b.ms || 0);
    if (min <= 0.01) return '';
    const waste = Math.round(((b.deadMs || 0) / (b.ms || 1)) * 100);
    return ' · ⚡ <b>' + ((b.checks || 0) / min).toFixed(1) + '</b>/мин' +
      (waste > 0 ? ' · 🗑 <b>' + waste + '%</b> впустую' : '');
  }
  // Одна строка для бота: цифры без вывода «впустую» ничего не решают.
  function budSummary(b, totals) {
    if (!b || !b.lists) return '';
    const min = budMin(b.ms || 0);
    if (min <= 0.01) return '';
    const perMin = (b.checks || 0) / min;
    const wastePct = b.ms > 0 ? Math.round(((b.deadMs || 0) / b.ms) * 100) : 0;
    const bits = [];
    bits.push(fmtBud(min, 1) + ' мин IG-времени');
    bits.push(fmtBud(b.checks || 0) + ' ' + budPlural(b.checks || 0, 'проверка', 'проверки', 'проверок') + ' (' + fmtBud(perMin, 1) + '/мин)');
    bits.push(fmtBud(b.lists) + ' ' + budPlural(b.lists, 'список', 'списка', 'списков') + ', из них ' + fmtBud(b.deadLists || 0) + ' впустую');
    // Главный ответ на «что за хуета, он по кругу ходит»: сколько строк ферма вообще
    // увидела и сколько из них было НОВЫМИ. 20к строк против 87 проверок — это не
    // «медленно», это «всё уже в базе, ищи в других местах».
    if (b.rows) {
      const known = Math.max(0, (b.rows || 0) - (b.checks || 0));
      if (known > (b.checks || 0)) bits.push('из ' + fmtBud(b.rows) + ' увиденных строк ' + fmtBud(known) + ' уже были в базе');
    }
    if (b.wasted) bits.push('в чёрный список пустых доноров взято ' + fmtBud(b.wasted) + ' (' + budPlural(b.wasted, 'список', 'списка', 'списков') + ' без единой новой проверки)');
    if (wastePct > 0) bits.push('это ' + wastePct + '% времени без результата');
    if (b.emptyLists) bits.push(fmtBud(b.emptyLists) + ' ' + budPlural(b.emptyLists, 'пустой список', 'пустых списка', 'пустых списков') + ' — ИГ не отдал людей');
    if (b.wordEmpty) bits.push('по слову никого не нашло ' + fmtBud(b.wordEmpty) + ' ' + budPlural(b.wordEmpty, 'раз', 'раза', 'раз'));
    if (b.deadJumps) bits.push(fmtBud(b.deadJumps) + ' ' + budPlural(b.deadJumps, 'прыжок', 'прыжка', 'прыжков') + ' к донору вхолостую');
    if (b.cuts) bits.push(fmtBud(b.cuts) + ' ' + budPlural(b.cuts, 'список докручен не до дна', 'списка докручено не до дна', 'списков докручено не до дна') + ' (потолок 2 мин на скролл)');
    if (b.blockRests) bits.push('остывали после блока Instagram ' + fmtBud(b.blockRests) + ' ' + budPlural(b.blockRests, 'раз', 'раза', 'раз'));
    if (b.idleRests) bits.push('холостой ход ловили ' + fmtBud(b.idleRests) + ' ' + budPlural(b.idleRests, 'раз', 'раза', 'раз'));
    if (b.breaksMs) bits.push(fmtBud(budMin(b.breaksMs), 1) + ' мин автоперерывов');
    const fit = totals && totals.foundFit ? Number(totals.foundFit) : 0;
    if (fit > 0) bits.push('цена одного подходящего лида — ' + fmtBud(budMin(b.ms) / fit, 1) + ' мин');
    return bits.join(' · ');
  }
  function fmtBud(n, dec) {
    const v = Number(n) || 0;
    return dec ? v.toFixed(dec) : String(Math.round(v));
  }
  // Формы числительного в отчёте: «1 прыжков» читается как бракованный инструмент,
  // а этот текст человек читает в боте на бегу.
  function budPlural(n, one, few, many) {
    const a = Math.abs(Number(n) || 0); const m10 = a % 10; const m100 = a % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return few;
    return many;
  }

  // ---------- итоги прогона: СЧИТАЕМ их из базы, а не снимаем один раз в момент чека ----------
  // Глубокая резолвилка ТГ (поиск юза по номеру и по дублю ника через
  // web.telegram.org) дописывает telegram в запись профиля через 30-90 с ПОСЛЕ того,
  // как профиль уже сохранён. Старая схема заглядывала в профиль через 2-4 с после
  // проверки — почти всегда ещё без ТГ, и сводка навечно оставалась нулевой, хотя
  // лиды в базе спокойно появлялись (пользователь видел: «находит, а показывает 0»).
  // Теперь имена после проверки ждут AFK_TG_SETTLE_MS и итоги пересобираются с нуля
  // на каждом сердцебиении; дождавшиеся сворачиваются в три счётчика, поэтому
  // «дожидающий» список не разрастается до размеров прогона.
  const AFK_TG_SETTLE_MS = 180000;
  // sessionStorage, а не chrome.storage: roster нужен только этой вкладке и только для
  // пересчёта, а гонять весь список в storage на каждом чеке — лишняя нагрузка.
  const AFK_RUN_TOT_KEY = 'igx_afk_run_totals';

  function afkRunTotLoad() {
    let o = null;
    try {
      o = JSON.parse(sessionStorage.getItem(AFK_RUN_TOT_KEY) || 'null');
    } catch (_) {}
    if (!o || typeof o !== 'object' || !o.settled || !Array.isArray(o.pending)) {
      o = { settled: { checked: 0, foundTg: 0, foundFit: 0 }, pending: [] };
    }
    return o;
  }
  function afkRunTotSave(o) {
    try {
      sessionStorage.setItem(AFK_RUN_TOT_KEY, JSON.stringify(o));
    } catch (_) {}
  }
  // Новый прогон — новые итоги. Вызывается только из startAfk: при возобновлении после
  // навигации (прыжок к следующему челу) roster обязан пережить перезагрузку страницы.
  function afkRunTotReset() {
    try {
      sessionStorage.removeItem(AFK_RUN_TOT_KEY);
    } catch (_) {}
  }

  // «Прошли фильтр» = ТГ есть и сабы в заданном диапазоне (семантика — как была).
  function afkTotFits(p, minF, maxF) {
    return (minF <= 0 || (p.followers != null && p.followers >= minF)) && (maxF <= 0 || p.followers == null || p.followers <= maxF);
  }

  // Пересобрать итоги прогона. profileCache читаем синхронно (его держит актуальным
  // storage.onChanged), так что пересчёт — это несколько десятков lookups по Map, без I/O.
  function afkComputeTotals() {
    const o = afkRunTotLoad();
    const now = Date.now();
    const minF = filterState.minFollowers || 0;
    const maxF = filterState.maxFollowers || 0;
    const keep = [];
    let liveTg = 0;
    let liveFit = 0;
    // Пока база не дочитана — НЕ сворачиваем (см. profileCacheReady): «не нашёлся» ≠ «без TG».
    // Молодые имена при этом просто ещё поживут в pending, а цифры per-tick пересчитаются
    // заново, как только кэш наполнится — то есть ошибка не накапливается, а self-heals.
    const canSettle = profileCacheReady;
    for (const e of o.pending) {
      const p = profileCache.get(String(e.u).toLowerCase()) || null;
      const tg = !!(p && p.telegram);
      const fit = tg && afkTotFits(p, minF, maxF);
      if (canSettle && now - (Number(e.t) || 0) >= AFK_TG_SETTLE_MS) {
        // Имя «улёглось»: больше ТГ к нему уже не приедет, переводим в накопленное.
        o.settled.checked = (o.settled.checked || 0) + 1;
        if (tg) {
          o.settled.foundTg = (o.settled.foundTg || 0) + 1;
          if (fit) o.settled.foundFit = (o.settled.foundFit || 0) + 1;
        }
        continue;
      }
      keep.push(e);
      if (tg) {
        liveTg++;
        if (fit) liveFit++;
      }
    }
    o.pending = keep;
    afkRunTotSave(o);
    return {
      checked: (o.settled.checked || 0) + keep.length,
      foundTg: (o.settled.foundTg || 0) + liveTg,
      foundFit: (o.settled.foundFit || 0) + liveFit,
    };
  }

  // Итоги + запись в состояние прогона — оттуда их берут дашборд, история и отчёт бота.
  async function afkRefreshTotals() {
    const totals = afkComputeTotals();
    await afkPatchState({ totals });
    return totals;
  }

  // Заметить проверенный профиль: имя уходит в «дожидающие», а цифры на дашборде
  // догонит ближайшее сердцебиение (раз в 5 с) — на каждый чек пишется только
  // sessionStorage, без лишних заходов в chrome.storage.
  async function afkNoteChecked(username) {
    const o = afkRunTotLoad();
    const u = String(username).toLowerCase();
    // Дедуп по «дожидающим»: одна и та же фамилия могла попасть в проверку дважды за
    // список (несколько слов фильтра), а в settled за ней уже никто не следит.
    for (const e of o.pending) if (e.u === u) return;
    o.pending.push({ u, t: Date.now() });
    afkRunTotSave(o);
  }

  // Тик сердца: живость + пересчёт итогов. Именно пересчёт здесь — причина, по которой
  // ТГ, «прорезавшийся» через минуту после проверки, всплывает в сводке, а не теряется.
  async function afkHeartbeatTick() {
    const totals = afkComputeTotals();
    // prog — «когда был последний НАСТОЯЩИЙ шаг» (проверка/граница списка/прыжок/пауза).
    // hb без prog не отличает «работает» от «висит в незакрыленном await».
    await afkPatchState({ hb: Date.now(), prog: _afkProgAt || Date.now(), totals });
  }

  // Вотчдог зависания. Работает в том же интервале, что и сердцебиение, поэтому словит
  // и худший случай: DOM/сториджа подвис, цикл не идёт, но таймеры живы. Молчание без
  // объявленной паузы дольше AFK_STALL_MS — это не «думает», это встал: стопим с честной
  // причиной (окно потом поднимет автопилот или человек), иначе дашборд вечно показывал бы
  // «▶ работает», а ферма бы не работала вовсе.
  const AFK_STALL_MS = 90000;
  let afkStallRecoveryBusy = false;
  async function afkStallWatch() {
    if (!afkLoopActive || afkStallRecoveryBusy) return;
    const st = await afkGetState();
    if (!st || !st.on || st.stopping) return;
    const now = Date.now();
    if (Number(st.pauseTill) > now) return; // спит по своей воле и с подписью — не сталл
    const prog = Number(st.prog) || _afkProgAt || 0;
    if (!prog || now - prog < AFK_STALL_MS) return;
    afkStallRecoveryBusy = true;
    try {
      // Recover by navigation, not by starting another loop beside the stuck one.
      // The recovery path quarantines this donor and rechecks manual stop.
      if (afkIgBlockSignal()) {
        await afkStop('Instagram ограничил действия. Запустите вручную после проверки аккаунта.', true);
        return;
      }
      await afkInfiniteRecover(st);
    } finally { afkStallRecoveryBusy = false; }
  }

  // Финальная сводка в бота: длительность всего прогона + накопленные итоги + списки.
  // Вызывается из afkStop ДО очистки состояния, ровно один раз.
  // reason — ОБЯЗАТЕЛЬНЫЙ участник: человек должен увидеть «с хуя стопнуло» в боте, а не
  // гадать, открывая дашборд (раньше улетали только цифры, и «прогон завершён» без причины
  // выглядел как нормальное окончание работы).
  async function afkSendFinalReport(reason) {
    const st = await afkGetState();
    if (!st) return;
    const totals = st.totals || {};
    const lists = Array.isArray(st.lists) ? st.lists : [];
    const checked = totals.checked || 0;
    if (!checked && !lists.length && !reason) return; // нечего слать — не шумим
    // НО: прогон умер с причиной и нулём проверок — это как раз то, что надо сказать.
    // Раньше такой стоп молчал: «ничего не перечекано» считалось неинтересным, и
    // человек видел лишь «окна закрылись» без объяснения.
    const minF = filterState.minFollowers || 0;
    const maxF = filterState.maxFollowers || 0;
    // Порог ДОНОРА в отчёт тоже: после разделения «≥1000» ниже — это про лидов, а
    // с какого донора брали список — отдельный вопрос, его и показываем отдельной строкой.
    const donor = afkDonorBounds();
    const durationMin = st.startedAt ? Math.max(1, Math.round((Date.now() - st.startedAt) / 60000)) : 1;
    // Бюджет: _bud — текущий снимок этой вкладки (он уже содержит всё, что было
    // дописано до перезагрузок: budLoad seeding из st.budget), st.budget — снятый
    // на границе последнего списка. Нужен именно он, иначе «0 проверок за 2 минуты»
    // в отчёте выглядит как поломка, а не как слитый в пустоту список.
    const budSnap = _bud || st.budget || null;
    chrome.runtime
      .sendMessage({
        type: 'tgAfkReport',
        durationMin,
        checked,
        foundTg: totals.foundTg || 0,
        foundFit: totals.foundFit || 0,
        minFollowers: minF,
        maxFollowers: maxF,
        donorMinFollowers: donor.minF,
        donorMaxFollowers: donor.maxF,
        donorOwnBound: donor.own,
        lists,
        reason: String(reason || ''),
        infinite: !!st.infinite,
        budget: budSnap,
        budgetText: budSummary(budSnap, totals),
      })
      .catch(() => {});
  }

  // ---------- зелёные лиды из базы: цепочка АФК и диспатч по кнопке попапа ----------
  async function afkGetDispatched() {
    let map = {};
    try {
      const d = await chrome.storage.local.get(AFK_DISPATCHED_KEY);
      map = (d && d[AFK_DISPATCHED_KEY]) || {};
    } catch (_) {}
    const now = Date.now();
    for (const k of Object.keys(map)) {
      // протухшие сиды (>3 ч) убираем, чтобы база не блокировалась навсегда
      if (!map[k] || now - map[k] > 3 * 3600 * 1000) delete map[k];
    }
    return map;
  }

  async function afkMarkDispatched(u) {
    const map = await afkGetDispatched();
    map[String(u).toLowerCase()] = Date.now();
    try {
      await chrome.storage.local.set({ [AFK_DISPATCHED_KEY]: map });
    } catch (_) {}
  }

  async function afkReserveDonor(username) {
    const response = await igxSend({type:'laptopDonorClaim', username,
      kind:afkPhaseKind === 'following' ? 'following' : 'followers'}, 8000);
    if (response?.claimed) return true;
    const key = 'igx_unavailable_donors';
    const unavailable = (await chrome.storage.local.get(key))[key] || {};
    unavailable[username.toLowerCase() + ':' + afkPhaseKind] = Date.now() + 120000;
    await chrome.storage.local.set({[key]:unavailable});
    return false;
  }

  async function afkPushAutostart(entry) {
    let q = [];
    try {
      const d = await chrome.storage.local.get(AFK_AUTOSTART_KEY);
      if (Array.isArray(d[AFK_AUTOSTART_KEY])) q = d[AFK_AUTOSTART_KEY];
    } catch (_) {}
    q.push(entry);
    try {
      await chrome.storage.local.set({ [AFK_AUTOSTART_KEY]: q });
    } catch (_) {}
  }

  // Забрать и удалить из очереди запись автозапуска для конкретного юзера.
  // ВАЖНО: берём только СВЕЖУЮ запись (не старше AUTOSTART_TTL_MS) — осиротевшие
  // (окно закрыли / ИГ не пустил / запуск не состоялся) раньше вечно висели в очереди
  // и включали АФК, когда пользователь сам заходил на этот профиль.
  const AUTOSTART_TTL_MS = 90 * 1000;
  async function afkTakeAutostart(username) {
    let q = [];
    try {
      const d = await chrome.storage.local.get(AFK_AUTOSTART_KEY);
      if (Array.isArray(d[AFK_AUTOSTART_KEY])) q = d[AFK_AUTOSTART_KEY];
    } catch (_) {}
    const low = String(username || '').toLowerCase();
    const now = Date.now();
    let pruned = false;
    const fresh = q.filter((e) => {
      const ok = !!e && typeof e.ts === 'number' && now - e.ts <= AUTOSTART_TTL_MS;
      if (!ok) pruned = true;
      return ok;
    });
    const idx = fresh.findIndex((e) => e.username && String(e.username).toLowerCase() === low);
    if (idx === -1) {
      if (pruned) { try { await chrome.storage.local.set({ [AFK_AUTOSTART_KEY]: fresh }); } catch (_) {} } // чистим протухшее
      return null;
    }
    const [entry] = fresh.splice(idx, 1);
    try {
      await chrome.storage.local.set({ [AFK_AUTOSTART_KEY]: fresh });
    } catch (_) {}
    return entry;
  }

  // Раз на загрузку страницы выбрасываем протухшие записи очереди автостарта.
  async function afkPruneAutostart() {
    let q = [];
    try {
      const d = await chrome.storage.local.get(AFK_AUTOSTART_KEY);
      if (Array.isArray(d[AFK_AUTOSTART_KEY])) q = d[AFK_AUTOSTART_KEY];
    } catch (_) { return; }
    const now = Date.now();
    const fresh = q.filter((e) => !!e && typeof e.ts === 'number' && now - e.ts <= AUTOSTART_TTL_MS);
    if (fresh.length !== q.length) {
      try { await chrome.storage.local.set({ [AFK_AUTOSTART_KEY]: fresh }); } catch (_) {}
    }
  }

  // ── Реестр «этот донор уже ничего не дал» ───────────────────────────────────
  // Дыра, из-за которой ночной прогон превращался в бег по кругу: список дочитан до
  // дна, людей в нём видно, а новых проверок ноль — потому что ВСЕ эти люди уже лежат
  // в базе. При этом markDone такой донор НЕ помечает (его ветка требует
  // checked.length > 0), он остаётся в пуле, а afkPickSeedRelaxed зовётся с пустым
  // skipSet и всегда отдаёт cands[0] — то есть одного и того же самого крупного
  // гиганта. Ночь из 588 «списков», где 500 впустую, — это и есть тот пинг-понг.
  // Реестр живёт в chrome.storage под СВОЕЙ подписью фильтров: поменял слово/пол/сабы —
  // прежние пометки сами перестают действовать (иначе один неудачный вечер закрыл бы
  // пул на недели).
  const AFK_WASTE_KEY = 'igx_afk_waste';
  const AFK_WASTE_TTL_MS = 3 * 24 * 3600 * 1000; // три ночи, а не вечность
  const AFK_WASTE_MAX = 4000;
  const AFK_PICK_TOP = 12; // из скольких самых крупных выбираем наугад
  const _waste = { sig: '', set: new Set(), list: [], at: 0, born: 0, loaded: false, dirty: false };

  // Подпись того, что мы ищем сейчас. «Пустой при одних фильтрах» ≠ «пустой при других».
  async function afkWasteSig() {
    const db = afkDonorBounds();
    let word = '';
    try { const st = await afkGetState(); word = String((st && st.word) || ''); } catch (_) {}
    return [
      afkListKind, afkEnterMode, word.trim().toLowerCase(),
      String(afkMustWord || '').trim().toLowerCase(), afkDonorGender,
      db.minF || 0, db.maxF || 0,
    ].join('\u0001');
  }

  // Set доноров, отдавших пустой список при ТЕКУЩИХ фильтрах. Кэш на минуту: пикировщик
  // вызывается на каждом прыжке, а долбить storage на каждый прыжок — прямой путь к весу.
  async function afkWasteGet() {
    const sig = await afkWasteSig();
    if (_waste.loaded && _waste.sig === sig && Date.now() - _waste.at < 60000) return _waste.set;
    if (_waste.dirty) await afkWasteFlush(); // смену фильтра переживаем, а не теряем
    _waste.sig = sig;
    let rec = null;
    try { const d = await chrome.storage.local.get(AFK_WASTE_KEY); rec = d[AFK_WASTE_KEY]; } catch (_) {}
    // Живёт запись ровно AFK_WASTE_TTL_MS ОТ РОЖДЕНИЯ (born), а не от последней записи.
    // Иначе ферма, которая пишет на каждой границе списка, молча продлевала бы себе
    // чёрный список вечно: «три ночи» превратились бы в «пока сам не поменяешь фильтры».
    // born = 0 у старых записей → считаем возрастом последнюю запись (at), не роняем их.
    const born = Number(rec && (rec.born || rec.at)) || 0;
    const ok = !!rec && rec.sig === sig && born > 0 && (Date.now() - born < AFK_WASTE_TTL_MS);
    const arr = ok && Array.isArray(rec.u) ? rec.u.slice(-AFK_WASTE_MAX) : [];
    _waste.list = arr.slice();
    _waste.set = new Set(arr);
    _waste.born = ok ? born : 0; // 0 = запись начнём заново при первом flush
    _waste.at = Date.now();
    _waste.loaded = true;
    _waste.dirty = false;
    return _waste.set;
  }

  // Пометка ДО первой считки стирала ночной реестр одним именем: первая граница списка
  // в свежей вкладке всегда наступает раньше любого пикировщика (прогон начинается со
  // скролла и чека, а не с выбора донора), а если этот первый список оказался пустым —
  // flush писал { sig, u:[одно_имя] } поверх всех накопленных за ночь. Поэтому загрузку
  // гарантируем здесь, а не на совести вызывающего. Возвращаем именно Set из afkWasteGet:
  // тот при смене подписи ПОДМЕНЯЕТ _waste.set новым объектом, и запись в старый потерялась бы.
  async function afkWasteAdd(u) {
    const key = String(u || '').toLowerCase();
    if (!key) return;
    const set = await afkWasteGet();
    if (set.has(key)) return;
    set.add(key);
    _waste.list.push(key);
    if (_waste.list.length > AFK_WASTE_MAX) _waste.list.shift();
    _waste.dirty = true;
  }

  // Пишется раз на границе списка — вместе с бюджетом, а не на каждую строку.
  // СЛИЯНИЕ-ПЕРЕД-ЗАПИСЬЮ: в ферме несколько ИГ-вкладок, у каждой свой _waste. Без дочитки перед
  // записью последний writer стирал бы имена, добавленные соседней вкладкой (а соседка
  // их обратно не вернёт — у неё в памяти свой список). Поэтому перечитываем запись и
  // пишем ОБЪЕДИНЕНИЕ. Полностью гонку это не лечит (оба успели прочитать до записи —
  // один из двух одновременных имён потеряется), но с «всё» до «одного» — честный размен.
  async function afkWasteFlush() {
    if (!_waste.dirty) return;
    _waste.dirty = false;
    // Подпись обязана описывать ТАК СЕЙЧАС настроенные фильтры. Если нас позвали до
    // первой считки реестра (_waste.sig ещё пустой) — считаем подпись на месте: иначе
    // запись вышла бы с sig:'' и никогда не совпала бы с боевой, т.е. реестр молча
    // не работал бы ни при каких фильтрах.
    const sig = _waste.loaded ? _waste.sig : await afkWasteSig();
    let merged = _waste.list.slice();
    let born = _waste.born || 0;
    try {
      const d = await chrome.storage.local.get(AFK_WASTE_KEY);
      const rec = d && d[AFK_WASTE_KEY];
      if (rec && rec.sig === sig && Array.isArray(rec.u)) {
        const have = new Set(merged);
        for (const u of rec.u) if (!have.has(u)) merged.push(u);
        if (!born) born = Number(rec.born || rec.at) || 0; // чужое рождение записи уважаем
      }
    } catch (_) {}
    if (!born) born = Date.now();
    if (merged.length > AFK_WASTE_MAX) merged = merged.slice(-AFK_WASTE_MAX);
    _waste.list = merged.slice();
    for (const u of merged) _waste.set.add(u); // чужие имена теперь в памяти тоже, чтобы не гонять их туда-сюда
    _waste.born = born;
    try {
      await safeStorageSet({ [AFK_WASTE_KEY]: { sig, born, at: Date.now(), u: merged } });
    } catch (_) { _waste.dirty = true; }
  }

  // Выбор из первых K крупных, а не «всегда первый»: детерминированный cands[0] и есть
  // причина, по которой ферма ночи напролёт открывала одних и тех же гигантов.
  function afkPickTop(cands, k) {
    if (!cands || !cands.length) return null;
    const top = cands.slice(0, Math.max(1, Math.min(k || AFK_PICK_TOP, cands.length)));
    return top[Math.floor(Math.random() * top.length)] || cands[0];
  }

  // Один отбор для всех пикировщиков: сначала обычные кандидаты (крупнейшие, но наугад
  // из первых K), а если их нет и relax разрешал «пустых» — случайный из пустых
  // (голодать не велят, но и зацикливать на одном гиганте нельзя).
  // ФОРМА НАРУЖУ — { username, followers }: все прыжки читают cand.username
  // (afkInfiniteNewSeed, afkLoop). Внутри afkGreenCandidates кандидаты живут как { u },
  // поэтому превращение u → username делаем здесь, в одном месте: раньше это была
  // строчка `return { username: cands[0].u, ... }` в каждом из трёх пикировщиков, и
  // при склейке в одну функцию она чуть не пропала (тогда ∞-режим падал на
  // undefined.toLowerCase() и ночью не открывал вообще ничего).
  function afkTakeCandidate(cands) {
    const take = (arr) => {
      if (!Array.isArray(arr) || !arr.length) return null;
      const c = afkPickTop(arr.slice().sort((a, b) => (b.followers || 0) - (a.followers || 0)), AFK_PICK_TOP);
      const name = c ? (c.username || c.u) : null;
      return name ? { username: String(name), followers: c.followers } : null;
    };
    return take(cands) || take(Array.isArray(cands) ? cands.wasted : null);
  }

  // Кандидаты из базы: без «выжатых» списков нужного типа, без занятых сидов, без тех,
  // кто в этом контексте фильтров уже отдал пустой список.
  // requireTg=true -> только зелёные (есть telegram); false -> все подходящие по слову/сабам.
  // mustMode — фильтр слова донора: 'all' (все слова) / 'any' (любое) / undefined — любое.
  // Учитываем мин. подписчиков из панели: «бомжей» (сабы ниже порога) не берём.
  async function afkGreenCandidates(skipSet, requireTg = true, mustMode, relax = false) {
    const retired = new Set((await chrome.storage.local.get('igx_retired_donors')).igx_retired_donors || []);
    const unavailable = (await chrome.storage.local.get('igx_unavailable_donors')).igx_unavailable_donors || {};
    const dispatched = await afkGetDispatched();
    const ownerNow = afkOwnerFromUrl();
    const waste = await afkWasteGet(); // доноры, уже отдавшие пустой список при ЭТИХ фильтрах
    // Порог ДОНОРА: своё или (пусто) порог лидов — раньше здесь стоял общий фильтр,
    // из-за чего донор с малыми сабами отпадал ещё до того, как мы посмотрели на его список.
    const { minF, maxF } = afkDonorBounds();
    const out = [];
    const outWasted = []; // relax-страховка: пустые доноры, если больше совсем некого
    for (const [u, p] of profileCache.entries()) {
      if (!p) continue;
      if (retired.has(u)) continue;
      if (p.isPrivate || Number(unavailable[u + ':' + afkPhaseKind]) > Date.now()) continue;
      if (requireTg && !p.telegram) continue; // только зелёные
      if (!relax && isDoneKind(u, afkPhaseKind)) continue; // нужный список уже прочекан
      if (!relax && dispatched[u]) continue; // уже сид какой-то вкладки
      if (ownerNow && ownerNow === u) continue;
      if (skipSet && skipSet.has(u)) continue;
      // Порог мин. подписчиков: если он задан и сабы ИЗВЕСТНЫ и ниже — пропускаем.
      // (неизвестные сабы не отсекаем, чтобы не терять лиды без данных)
      if (minF > 0 && p.followers != null && p.followers < minF) continue;
      // Верх порога: сабы известны и больше максимума — тоже пропускаем.
      if (maxF > 0 && p.followers != null && p.followers > maxF) continue;
      // Фильтр слова донора (поле меню АФК): режим all/any задаёт вызывающий.
      if (!afkMatchesMustWord(p, u, mustMode)) continue;
      // Пол донора — жёсткий фильтр, после всех дешёвых (он дорогой на первой пробежке).
      if (!afkDonorGenderOk(p, u)) continue;
      // Реестр «пустых» — ПОСЛЕДНИЙ из жёстких фильтров. Раньше стоял перед сабами/словом/
      // полом, и тогда в relax-запас попадали доноры, которые человеку не нужны в принципе:
      // ∞ прыгал бы к запрещённому полу или чужому слову, а обещание «жёсткие фильтры
      // юзера остаются» нарушалось бы молча. Строгой ветке это безразлично (она и так
      // пропускает такого кандидата), а вот out.wasted обязан быть только разрешённым.
      if (waste.has(u)) {
        if (relax) outWasted.push({ u, followers: p.followers == null ? -1 : p.followers });
        continue;
      }
      out.push({ u, followers: p.followers == null ? -1 : p.followers });
    }
    out.wasted = outWasted;
    return out;
  }

  // Следующий прыжок по зелёным: из КРУПНЕЙШИХ лидов базы, но наугад из первых K,
  // ещё не посещённый в этом прогоне. Раньше здесь был строго cands[0] после сортировки
  // — то есть каждый круг один и тот же мега-донор, чей список обгладывали неделями.
  async function afkPickGreenFromDb() {
    const st = await afkGetState();
    const visited = new Set((st && st.visited) || []);
    // Донорское слово через запятую: сначала те, у кого ВСЕ слова, нет таких — любое.
    let cands = await afkGreenCandidates(visited, true, 'all');
    if (!cands.length && !cands.wasted.length) cands = await afkGreenCandidates(visited, true, 'any');
    return afkTakeCandidate(cands);
  }

  // Режим «все кроме пурпурных»: берём из ВСЕЙ базы любого подходящего эксперта
  // (не только зелёного) — по ключевому слову и мин. подписчикам, минуя «выжатых».
  // Это не даёт АФК заглохнуть, когда в текущем списке подходящих уже не осталось.
  async function afkPickAnyFromDb() {
    const st = await afkGetState();
    const visited = new Set((st && st.visited) || []);
    // Та же приоритетность: все слова → любое слово.
    let cands = await afkGreenCandidates(visited, false, 'all');
    if (!cands.length && !cands.wasted.length) cands = await afkGreenCandidates(visited, false, 'any');
    return afkTakeCandidate(cands);
  }

  // Picking для «нового круга» в ∞: в последний момент берём донора в обход «выжатых»
  // списков и занятых сидов, иначе долгий бесконечный прогон голодал бы: все кандидаты
  // уже помечены done/dispatched, обычный пул пуст → АФК вставал, ничего не открывая.
  // relax снимает ровно эти два фильтра; жёсткие фильтры юзера (сабы/слово/пол) остаются,
  // пустую базу он не выдумает.
  async function afkPickSeedRelaxed() {
    let cands = await afkGreenCandidates(new Set(), true, 'all', true);
    if (!cands.length && !cands.wasted.length) cands = await afkGreenCandidates(new Set(), true, 'any', true);
    if (!cands.length && !cands.wasted.length) cands = await afkGreenCandidates(new Set(), false, 'any', true);
    return afkTakeCandidate(cands);
  }

  // Следующий прыжок: самый популярный чел списка, КРОМЕ уже открытых, гигантов,
  // и тех, на кого ты уже подписан (секция «Подписаны» или кнопка «Подписки» в строке).
  async function afkPickNext(dialog) {
    if ((afkFindSearchInput(dialog)?.value || '').trim().toLowerCase() !== 'тренер') return null;
    // Донорское слово: сначала самый популярный с ВСЕМИ словами, если таких в списке
    // нет — с любым одним (без слова фильтр и так пропускает всех).
    return (await afkPickNextMode(dialog, 'all')) || (await afkPickNextMode(dialog, 'any'));
  }

  async function afkPickNextMode(dialog, mustMode) {
    const retired = new Set((await chrome.storage.local.get('igx_retired_donors')).igx_retired_donors || []);
    const unavailable = (await chrome.storage.local.get('igx_unavailable_donors')).igx_unavailable_donors || {};
    const st = await afkGetState();
    const visited = new Set((st && st.visited) || []);
    const waste = await afkWasteGet(); // «пустой» донор этого контекста фильтров — не спускаемся к нему
    // Сабы здесь проверяются у САМОГО донора (кого открыть) — значит порог тоже донорский.
    const { minF, maxF } = afkDonorBounds();
    let best = null;
    let bestNew = null; // приоритет: у кого кнопка «Подписаться» (точно не подписан)
    for (const { a, u, low } of afkIterUserLinks(dialog, true)) {
      if (retired.has(low)) continue;
      if (Number(unavailable[low + ':' + afkPhaseKind]) > Date.now()) continue;
      if (visited.has(low)) continue;
      // Подсветка «выжатости» = нужный список этого эксперта уже прочекан — не прыгаем к нему снова.
      if (isDoneKind(u, afkPhaseKind)) continue;
      if (waste.has(low)) continue;
      if (afkIsAlreadyFollowingUser(a, dialog)) continue;
      const p = await getProfile(u);
      if (p?.isPrivate) continue;
      if (!p || p.followers == null) continue;
      if (p.followers > AFK_MAX_FOLLOWERS) continue;
      // Мин. подписчики из панели: меньше порога — не открываем.
      if (minF > 0 && p.followers < minF) continue;
      // Макс. подписчики из панели: больше порога — не открываем.
      if (maxF > 0 && p.followers > maxF) continue;
      // Фильтр слова донора (режим all/any задаёт вызывающий).
      if (!afkMatchesMustWord(p, u, mustMode)) continue;
      // Пол донора: тот же жёсткий фильтр, что и в базе (актуален, когда в списке
      // сидят записи без био — у них пол не распознан, и при 'f'/'m' не берём).
      if (!afkDonorGenderOk(p, u)) continue;
      const row = afkRowForLink(a);
      if (afkRowShowsFollowButton(row)) {
        if (!bestNew || p.followers > bestNew.followers) bestNew = { username: u, followers: p.followers };
      }
      if (!best || p.followers > best.followers) best = { username: u, followers: p.followers };
    }
    return bestNew || best;
  }

  // Куда смотреть в поисках поля фильтра. ПОРЯДОК ВАЖЕН: первым идёт контейнер, который
  // нам доверил цикл (box из afkEnsureList — он заведомо со строками людей), и только
  // потом остальные диалоги и страница. Раньше было наоборот: afkFindSearchInput сам
  // звал afkDialog(), а тот отдаёт ПЕРВЫЙ диалог, в котором есть хоть какой-то input —
  // ИГ держит такой поверх списка («Сохранить информацию для входа?», 2FA, cookie).
  // Слово искали в чужом окошке → «поля поиска нет» → АФК вешался.
  function afkSearchScopes(root) {
    const scopes = [];
    const seen = new Set();
    const push = (el) => {
      if (el && !seen.has(el)) { seen.add(el); scopes.push(el); }
    };
    push(root);
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      if (afkUserCount(d) > 0) push(d); // диалоги, где реально есть люди
    }
    push(afkListRoot());
    for (const d of document.querySelectorAll('[role="dialog"]')) push(d); // пустые модалки — последними
    push(document.querySelector('main') || document.body); // полностраничный список
    return scopes;
  }

  function afkFindSearchInput(root) {
    for (const scope of afkSearchScopes(root)) {
      const inp = afkFindSearchInputIn(scope);
      if (inp) return inp;
    }
    return null;
  }

  // Перебрать поля ОДНОГО контейнера: сначала явный поиск, потом любое видимое поле.
  function afkFindSearchInputIn(scope) {
    // Глобальный поиск ИГ в шапке (nav) НЕ является фильтром подписчиков: если слово
    // попадёт в него — ИГ уйдёт в общий поиск, а список останется неотфильтрованным,
    // и АФК начнёт чекать «всех подряд». Поэтому поля шапки отсекаются в usable().
    const allInputs = scope.querySelectorAll('input');
    const usable = (inp) => {
      if (inp.closest('.igx-side-panel, .igx-ocr-pop, .igx-tooltip, .igx-pa-pop')) return false;
      // глобальная навигация/шапка ИГ и её поиск — не фильтр списка
      if (inp.closest('nav, [role="banner"], form[role="search"]')) return false;
      const type = (inp.getAttribute('type') || 'text').toLowerCase();
      if (type !== 'text' && type !== 'search') return false;
      const r = inp.getBoundingClientRect();
      return r.width > 20 && r.height >= 8;
    };
    // 1. Поле с признаком поиска (Search / Поиск)
    for (const inp of allInputs) {
      if (!usable(inp)) continue;
      const ph = (inp.getAttribute('placeholder') || '').toLowerCase();
      const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
      if (/search|поиск/i.test(ph) || /search|поиск/i.test(aria)) return inp;
    }
    // 2. Любое видимое текстовое поле в этом контейнере
    for (const inp of allInputs) {
      if (!usable(inp)) continue;
      const r = inp.getBoundingClientRect();
      if (r.width > 40) return inp;
    }
    return null;
  }

  // Само-диагностика для честного текста: где именно искали поле и что там нашлось.
  // Без неё «нет поля поиска» звучит как отговорка, а виноваты бывают три разные вещи
  // (чужая модалка сверху, полностраничный список, ИГ реально не дал поиск).
  function afkSearchDiag(root) {
    try {
      const scopes = afkSearchScopes(root);
      const dialogs = document.querySelectorAll('[role="dialog"]');
      const parts = [];
      parts.push(scopes.length + ' контейн. в очереди');
      parts.push(dialogs.length + ' диалог(ов)');
      if (scopes[0]) {
        const n = afkUserCount(scopes[0]);
        const inputs = Array.from(scopes[0].querySelectorAll('input')).filter((i) => {
          const t = (i.getAttribute('type') || 'text').toLowerCase();
          return t === 'text' || t === 'search';
        }).length;
        parts.push('в основном: ' + n + ' строк, ' + inputs + ' текстов. полей');
      }
      parts.push(afkIsFollowersPage() ? 'список страницей' : 'список не страницей');
      return parts.join(', ');
    } catch (e) {
      return 'диагностика не удалась: ' + (e && e.message ? e.message : e);
    }
  }

  // Контейнер, которому принадлежит поле поиска: модалка списка, иначе main страницы.
  function afkFieldOwner(inp) {
    try {
      const d = inp.closest('[role="dialog"]');
      if (d) return d;
      return document.querySelector('main') || document.body;
    } catch (_) { return null; }
  }

  // Надёжный ввод текста в React-инпут Инстаграма
  async function afkSetInputValue(input, val) {
    if (!input) return false;
    try {
      input.focus();
    } catch (_) {}

    // 1. Выделяем всё и очищаем
    try {
      input.select();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } catch (_) {}

    // 2. Вводим текст через execCommand (браузер генерирует нативные события с вводом)
    let typed = false;
    if (val) {
      try {
        typed = document.execCommand('insertText', false, val);
      } catch (_) {}
    }

    // 3. Фолбэк нативным сеттером + сброс React _valueTracker
    if (!typed || input.value !== val) {
      try {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) {
          setter.call(input, val);
        } else {
          input.value = val;
        }
      } catch (_) {
        input.value = val;
      }
      try {
        if (input._valueTracker) {
          input._valueTracker.setValue('__igx_reset__');
        }
      } catch (_) {}
    }

    // 4. Диспатчим события для React 16/17/18 и Instagram
    try {
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: val, inputType: val ? 'insertText' : 'deleteContentBackward' }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: val, inputType: val ? 'insertText' : 'deleteContentBackward' }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
    } catch (_) {}

    return input.value === val;
  }

  async function afkClearWord(box) {
    const root = box || afkDialog() || document;
    const input = afkFindSearchInput(root);
    if (!input) return;
    await afkSetInputValue(input, '');
    await igxSleep(1200);
  }

  // Ввести слово в поиск списка. Возврат: 'ok' | 'empty' (по слову никого) | 'failed' (ввести не вышло) | 'noinput'
  async function afkTypeWord(word, box) {
    if (!word) return 'ok';
    const root = box || afkListRoot() || afkDialog() || document;
    let input = null;
    for (let i = 0; i < 30 && !input; i++) {
      input = afkFindSearchInput(root);
      if (!input) await igxSleep(300);
    }
    if (!input) return 'noinput';

    // Поле нашлось НЕ обязательно в root (типично: root — тонкая модалка, а список
    // лежит страницей). Считаем строки и ждём применения фильтра там, где поле реально
    // живёт, иначе ждали бы «изменения счётчика» в пустом контейнере и рапортовали бы
    // «по слову никого», хотя список даже не фильтровался.
    const effRoot = afkFieldOwner(input) || root;

    const countBefore = afkUserCount(effRoot);
    for (let attempt = 0; attempt < 3; attempt++) {
      await afkSetInputValue(input, word);
      await igxSleep(600);
      if (input.value === word) break;
    }
    if (input.value !== word) return 'failed';

    // Ждём, пока ИГ ПРИМЕНИТ фильтр. Просто count>0 недостаточно: это может быть
    // ещё старый неотфильтрованный список — тогда АФК чекнул бы «всех подряд».
    // Признак применения: счётчик изменился и пару кругов держится, либо «не найдено».
    const t0 = Date.now();
    let lastCount = countBefore;
    let stable = 0;
    while (Date.now() - t0 < 9000) {
      await igxSleep(500);
      const text = (effRoot.innerText || '').toLowerCase();
      if (/ничего не найдено|результатов нет|нет результатов|no results found|no results/i.test(text)) {
        return 'empty';
      }
      const count = afkUserCount(effRoot);
      if (count !== lastCount) {
        stable = 0;
        lastCount = count;
      } else {
        stable++;
      }
      if (count !== countBefore && stable >= 2) return 'ok'; // фильтр реально сузил список
      if (stable >= 4) return count > 0 ? 'ok' : 'empty'; // счётчик не меняется — берём как есть
    }
    return afkUserCount(effRoot) > 0 ? 'ok' : 'empty';
  }

  async function startAfk(overrideWord, opts) {
    const infiniteOpt = !!(opts && opts.infinite);
    const wordEl = sidePanelEl && sidePanelEl.querySelector('.igx-afk-word');
    // overrideWord !== undefined — автозапуск из новой вкладки (передано из попапа/дашборда);
    // иначе — обычная кнопка: берём слово из поля боковой панели.
    const word =
      overrideWord != null ? String(overrideWord).trim() : wordEl ? wordEl.value.trim() : '';
    afkRunTotReset(); // новый прогон — пустой «дожидающий» список и итоги с нуля
    _bud = null; // и пустой бюджет: перезапуск в этой же вкладке не должен наследовать прежний расход
    if (afkListKind === 'both') afkPhaseKind = 'followers'; // новый прогон: фаза всегда начинается с подписчиков
    await afkPatchState({ on: true, word, visited: [], lists: [], needSearch: true, plainTried: false, jumped: false, infinite: infiniteOpt, fails: 0, startedAt: Date.now(), seed: afkProfileOwner() || '', cur: afkProfileOwner() || '', stopping: false, stoppingSince: 0, pauseTill: 0, pauseWhy: '', budget: budFresh(), totals: { checked: 0, foundTg: 0, foundFit: 0 } });
    afkProg(); // новый прогон: точка отсчёта «последнего шага» для вотчдога зависания
    afkSetBtn(true);
    // Приватный стартовый донор не ждём 25 секунд: сразу берём следующего.
    if (infiniteOpt && !(await afkReserveDonor(afkProfileOwner()))) {
      if (await afkInfiniteNewSeed(true)) return;
      await afkStop('свободных доноров пока нет; другие потоки уже работают с ними.');
      return;
    }
    if (afkIsPrivateProfilePage()) {
      const stPrivate = await afkGetState();
      await afkMarkPrivateVisited(stPrivate);
      if (infiniteOpt && (await afkInfiniteNewSeed(true))) return;
      await afkStop('стартовый профиль закрыт, а другого донора не найдено.');
      return;
    }
    // Пытаемся открыть список подписчиков автоматически, если модалка ещё не открыта.
    const box = await afkEnsureList(25000);
    if (!box) {
      // Бесконечный режим: стартовый сид-профиль битый — берём другой, не стопорим.
      if (infiniteOpt) {
        await afkInfiniteRecover(await afkGetState());
        return;
      }
      await afkStop('не удалось открыть список подписчиков — открой его вручную или проверь профиль.');
      return;
    }
    if (!(await afkEnsureMutualFirst())) return;
    afkLoop();
  }

  // Бесконечный режим: взять нового подходящего профиля из базы и прыгнуть к его списку.
  // true — навигация запущена (страница перезагрузится, resume-логика подхватит АФК).
  async function afkInfiniteNewSeed(relax, attempt = 0) {
    let cand = afkEnterMode === 'wordall' ? await afkPickAnyFromDb() : await afkPickGreenFromDb();
    if (!cand) cand = await afkPickAnyFromDb();
    // Фаза «both»: подписчики дочекали — переключаемся на подписки и пробуем заново.
    if (!cand && afkListKind === 'both' && afkPhaseKind === 'followers') {
      afkPhaseKind = 'following';
      cand = afkEnterMode === 'wordall' ? await afkPickAnyFromDb() : await afkPickGreenFromDb();
      if (!cand) cand = await afkPickAnyFromDb();
    }
    if (!cand && relax) cand = await afkPickSeedRelaxed(); // в обход «выжатых»/занятых — не умирать
    if (!cand) return false;
    if (!(await afkRunning())) return false;
    if (!(await afkReserveDonor(cand.username))) {
      return attempt < 15 ? afkInfiniteNewSeed(relax, attempt + 1) : false;
    }
    const stN = await afkGetState();
    const vis = new Set((stN && stN.visited) || []);
    vis.add(cand.username.toLowerCase());
    await afkPatchState({ visited: Array.from(vis), needSearch: true, jumped: false, fails: 0, cur: cand.username, pauseTill: 0, pauseWhy: '' });
    await afkMarkDispatched(cand.username); // чтобы параллельные АФК не дублировали
    bud().jumps++; await budSave(); // навигация — последний момент записать расход: страница перезагрузится
    location.href = afkFollowersUrl(cand.username);
    return true;
  }

  // Вместо остановки при незагрузившемся/закрытом списке: считаем попытки
  // (3 цикла × ~20 сек ≈ минута — как просил пользователь), потом прыгаем к новому
  // профилю; если кандидатов нет — ждём 30с и обнуляем обход. 'nav'|'retry'|'stop'.
  async function afkInfiniteRecover(st) {
    if (!st || !st.infinite) return 'stop';
    // A missing list is not an action-limit verdict. Quarantine this donor/list
    // across navigations and relaxed selection; do not retry the same page forever.
    if (!afkIgBlockSignal()) {
      const owner = afkProfileOwner();
      const key = 'igx_unavailable_donors';
      const unavailable = (await chrome.storage.local.get(key))[key] || {};
      if (owner) unavailable[owner.toLowerCase() + ':' + afkPhaseKind] = Date.now() + 6 * 60 * 60 * 1000;
      for (const [name, until] of Object.entries(unavailable)) if (Number(until) <= Date.now()) delete unavailable[name];
      await chrome.storage.local.set({[key]: unavailable});
      const visited = new Set(st.visited || []);
      if (owner) visited.add(owner.toLowerCase());
      await afkPatchState({visited: [...visited], jumped: false, fails: 0});
      if (!(await afkRunning())) return 'stop';
      if (await afkInfiniteNewSeed(true)) return 'nav';
      await afkStop('доступные доноры закончились: списки не загрузились. Запустите вручную позже.');
      return 'stop';
    }
    // ВТОРОЙ вход в шлюз: на бане список может вообще НЕ открываться (заглушка вместо
    // модалки), и тогда граница списка с afkBanIdleGuard не наступает вовсе — цикл
    // «пробую ещё раз / беру нового донора» гоняет навигации минут по часу, молча
    // подставляя аккаунт. Здесь проверок быть не может, поэтому шлюз зовётся с нулём.
    const rec0 = await afkBanIdleGuard(st, 0);
    if (rec0 === 'stop') return 'stop';
    if (rec0 === 'rest') return await afkInfiniteNewSeed(true) ? 'nav' : 'retry';
    const fails = (st.fails || 0) + 1;
    await afkPatchState({ fails, jumped: false });
    if (fails < 3) {
      afkSetBtnText('🤖 АФК∞: страница не грузится, пробую ещё раз…');
      await afkPause(15000 + 3000, 'страница донора не грузится — пробую ещё раз (' + fails + '/3)');
      await igxSleep(15000);
      return 'retry';
    }
    if (await afkInfiniteNewSeed()) return 'nav';
    // Честно говорим, если встанло из-за жёсткого фильтра донора, а не из-за пустой базы.
    const gHint = afkDonorGender === 'f' ? 'женский' : afkDonorGender === 'm' ? 'мужской' : '';
    // Порог сабов донора — тот же «жёсткий фильтр»: при своих полях донора список
    // может быть пуст не из-за слова/пола, а потому что доноры не проходят по сабам.
    const db = afkDonorBounds();
    const why = [
      gHint ? 'пол: ' + gHint : '',
      db.minF > 0 ? 'сабы ≥' + db.minF.toLocaleString('ru-RU') : '',
      db.maxF > 0 ? 'сабы ≤' + db.maxF.toLocaleString('ru-RU') : '',
    ].filter(Boolean).join(', ');
    afkSetBtnText('🤖 АФК∞: кандидатов нет' + (why ? ', доноры отсечены фильтрами (' + why + ')' : '') + ', жду 30с и обнуляю обход…');
    await afkPause(30000 + 3000, 'кандидатов нет' + (why ? ', доноры отсечены фильтрами (' + why + ')' : '') + ' — жду и обнуляю обход');
    await igxSleep(30000);
    await afkPatchState({ fails: 0, visited: [] });
    if (afkListKind === 'both') afkPhaseKind = 'followers'; // новый круг — снова с подписчиков
    return 'retry';
  }

  async function afkLoop() {
    if (afkLoopActive) return;
    afkLoopActive = true; // синхронно: страховка от двух циклов в одной вкладке
    // Вход только для ВКЛЮЧЁННОГО прогона. Без этой проверки отложенный «подниматель»
    // поднимал мёртвый прогон: вкладка снова писала hb, жгла кнопку и вела себя так,
    // будто человек её не выключал (а заодно могла настрочить в бота бан-карточку).
    let stIn = null;
    try { stIn = await afkGetState(); } catch (_) {}
    if (!stIn || !stIn.on) { afkLoopActive = false; return; }
    afkProg();
    afkLoopBusy++; // «тело на стеке»: снимет только finally, «стоп» этот счётчик не трогает
    afkSetBtn(true); // в т.ч. после перезагрузки страницы при возобновлении
    // Сердцебиение: раз в 5с пишем hb в состояние и заодно перечитываем итоги прогона.
    // Дашборд считает прогон живым, только пока hb свежий (< 25с) — так закрытое
    // окно/вкладка гасит «бегунок» даже если сверка по chrome.tabs не сработала.
    // Таймер живёт всю жизнь цикла (переживает igxSleep).
    try { await afkHeartbeatTick(); } catch (_) {} // сразу и hb, и актуальные итоги
    try { await budLoad(); } catch (_) {} // расход прогона переживает перезагрузку: читаем из состояния
    if (afkHbTimer) clearInterval(afkHbTimer);
    afkHbTimer = setInterval(() => { afkHeartbeatTick().catch(() => {}); afkStallWatch().catch(() => {}); }, 5000);
    try {
      while (true) {
        const st0 = await afkGetState();
        if (!st0 || !st0.on) break;
        afkProg(); // новый виток = новый список: вотчдог зависания отсчитывается отсюда
        const wasJump = !!st0.jumped; // этот список открыли прыжком из базы: пустой = прыжок браком
        // На приватной странице списка не будет по определению. Если пришли сюда
        // прыжком — возвращаемся к предыдущей очереди; если это сид — берём новый.
        if (afkIsPrivateProfilePage()) {
          await afkMarkPrivateVisited(st0);
          if (st0.jumped && history.length > 1) {
            await afkPatchState({ jumped: false, needSearch: true });
            history.back();
            return;
          }
          if (await afkInfiniteNewSeed(true)) return;
          await afkPause(30000, 'закрытый профиль пропущен, жду нового донора');
          await igxSleep(30000);
          continue;
        }
        let box = await afkEnsureList(20000);
        // Закрытый список: в модалке нет людей, а есть надпись «только автор может…».
        // Считаем списком только модалку с >= 3 людьми — иначе это заглушка (в ней
        // бывает ссылка на самого чела, и раньше АФК чекал её как «человека из списка»).
        const closedStub = box && afkUserCount(box) <= 2 && afkIsClosedList(box);
        if (closedStub) box = null;
        if (!box) {
          const st1 = await afkGetState();
          if (closedStub && st1 && st1.jumped) {
            // Прыжок попал на закрытый список — разворачиваемся к предыдущему
            // списку, АФК продолжится там и выберет другого кандидата.
            await afkPatchState({ jumped: false, needSearch: true });
            if (history.length > 1) {
              history.back(); // полная навигация назад; resume-логика продолжит цикл
              return;
            }
            const recA = await afkInfiniteRecover(st1);
            if (recA === 'nav') return;
            if (recA === 'retry') continue;
            await afkStop('у следующего эксперта закрытый список подписчиков, а возвращаться некуда — запусти АФК заново.');
            break;
          }
          const owner = afkProfileOwner();
          if (owner && /\/followers\/[^/]+/i.test(location.pathname) && !(st1 && st1.plainTried)) {
            // ИГ мог не понять URL вида /followers/mutualFirst — один раз пробуем чистый /followers/.
            await afkPatchState({ plainTried: true });
            location.href = `https://www.instagram.com/${owner}/followers/`;
            return;
          }
          if (st1 && st1.jumped) {
            // Модалка после прыжка вообще не открылась (приват/глюк) — тоже назад, не стопорим АФК.
            await afkPatchState({ jumped: false, needSearch: true });
            if (history.length > 1) {
              history.back();
              return;
            }
            const recB = await afkInfiniteRecover(st1);
            if (recB === 'nav') return;
            if (recB === 'retry') continue;
            await afkStop('после прыжка список не открылся и назад идти некуда — запусти АФК заново.');
            break;
          }
          const recC = await afkInfiniteRecover(st1);
          if (recC === 'nav') return;
          if (recC === 'retry') continue;
          await afkStop('список подписчиков не открылся (приват или ИГ не дал).');
          break;
        }
        await afkPatchState({ plainTried: false, jumped: false, pauseTill: 0, pauseWhy: '' });
        const listT0 = Date.now(); let rowsPeak = 0; // расход и масштаб именно этого списка
        _afkErrStreak = 0; _afkHardRests = 0; // список живой — прогресс есть, счётчики сбоев обнулёны
        await afkEnsureFollowersTab(box);
        if (!(await afkEnsureMutualFirst())) return;
        // Ключевых слов может быть несколько (через запятую). Каждое по очереди вводим
        // в поиск списка и чекаем его результаты; и только перебрав ВСЕ слова — открываем
        // следующую вкладку. Слово вводится в КАЖДОМ списке и ПОВТОРНО после перезагрузки
        // вкладки: свежая модалка имеет ПУСТОЕ поле поиска, поэтому ориентируемся на факт
        // ввода, а не на одноразовый флаг (иначе АФК чекнул бы общий список «всех подряд»).
        const tokens = (st0.word || '').split(',').map((s) => s.trim()).filter(Boolean);
        const checkedAll = [];
        const seenChecked = new Set();
        let stopLoop = false;
        // Дочитали ли список до настоящего дна. Нужен, чтобы не врать ни бюджету, ни пулу
        // доноров: срезанный потолком скролла список нельзя помечать «выжатым».
        let scrollBottom = true;
        if (tokens.length) {
          for (let ti = 0; ti < tokens.length; ti++) {
            const tok = tokens[ti];
            const inpNow = afkFindSearchInput(box);
            const alreadyApplied = !!inpNow && (inpNow.value || '').trim() === tok;
            if (!alreadyApplied) {
              await afkPatchState({ needSearch: false });
              const res = await afkTypeWord(tok, box);
              if (res === 'failed' || res === 'noinput') {
                // ∞ не умирает от одного неудачного списка: хелпер сам прыгнет к другому
                // донору или уйдёт в длинную паузу (и вернёт true).
                if (st0.infinite) {
                  if (await afkSkipNoSearch(box, tok, res)) return;
                  stopLoop = true;
                  break;
                }
                await afkStop(res === 'noinput'
                  ? `в этом списке нет поля поиска — слово «${tok}» ввести некуда. Открой список, где есть поиск, или убери слово. Где искали: ` + afkSearchDiag(box)
                  : 'не смог ввести слово в поиск модалки. Где искали: ' + afkSearchDiag(box));
                stopLoop = true;
                break;
              }
              if (res === 'empty') {
                // По этому слову в данном списке никого: очищаем поиск и пробуем следующее слово.
                bud().wordEmpty++; // этот цикл (до ~10 с на слово) тоже учтён в бюджете
                afkSetBtnText(`🤖 АФК: «${tok}» не найден, пробую следующее слово…`);
                if (ti < tokens.length - 1) await afkClearWord(box);
                await igxSleep(1200);
                continue;
              }
            } else if (st0.needSearch) {
              // Слово уже в поле (ИГ сохранил запрос после перезагрузки) — гасим устаревший флаг.
              await afkPatchState({ needSearch: false });
            }
            // Слово отфильтровало список — листаем до конца и чекаем новых (уже проверенных afkCheckAll пропустит).
            afkSetBtnScroll();
            const sres = await afkScrollToEnd(box);
            if (sres === false) { stopLoop = true; break; }
            if (sres !== true) scrollBottom = false; // дно не подтверждено
            if (!(await afkRunning())) { stopLoop = true; break; }
            const checkedTok = await afkCheckAll(box);
            rowsPeak = Math.max(rowsPeak, afkIterUserLinks(box, true).length);
            for (const cu of checkedTok) {
              const key = String(cu).toLowerCase();
              if (!seenChecked.has(key)) { seenChecked.add(key); checkedAll.push(cu); }
            }
            // Перед следующим словом очищаем поиск, чтобы фильтры не «склеивались».
            if (ti < tokens.length - 1) { await afkClearWord(box); await igxSleep(1000); }
          }
        } else {
          // Слова нет — чекаем весь список как есть.
          afkSetBtnScroll();
          const sres0 = await afkScrollToEnd(box);
          if (sres0 === false) break;
          if (sres0 !== true) scrollBottom = false; // дно не подтверждено
          if (!(await afkRunning())) break;
          const checkedTok = await afkCheckAll(box);
          rowsPeak = Math.max(rowsPeak, afkIterUserLinks(box, true).length);
          for (const cu of checkedTok) checkedAll.push(cu);
        }
        _afkNoSearchStreak = 0; // слово куда-то легло (или его не было) — списки пригодны, счётчик прочь
        if (stopLoop) break;
        // Бан-детект по пустому списку: ИГ на экшн-блоке отдаёт ОТКРЫВШУЮСЯ и прокрученную
        // модалку с нулём ссылок («Здесь будут отображаться все ваши подписчики») без явного
        // текста ошибки. Если при этом у донора заведомо есть подписчики — это блок, а не пустой юзер.
        try {
          // «Пусто после прокрутки» = бан, ТОЛЬКО если модалка отдаёт заглушку «здесь
          // будут отображаться все ваши подписчики». Голый ноль (долгая загрузка, реально
          // пусто после фильтра по словам) — не бан, флаг не ставим.
          if (!afkIgBlockSignal() && afkIterUserLinks(box, false).length === 0 && afkEmptyListPlaceholder(box)) {
            const own = afkOwnerFromUrl();
            const op = own ? await getProfile(own) : null;
            if (op && Number(op.followers) > 0) {
              await afkRiskNoteBlock('Instagram: список пуст (заглушка при живом доноре) — похоже на экшн-блок');
            }
          } else if (checkedAll.length) {
            await afkRiskClearBlock(); // этот донор отдал людей → никакого блока
          }
        } catch (_) {}
        const checked = checkedAll;
        if (!scrollBottom) bud().cuts = (Number(bud().cuts) || 0) + 1; // учтёт тот же afkPatchState, что и граница списка
        // Граница списка: единственный раз за него пишем бюджет в storage. Именно
        // здесь рождается ответ на «куда ушли минуты»: время списка против вышедших
        // из него проверок.
        try {
          await budCloseList(Date.now() - listT0, Math.max(rowsPeak, checked.length), checked.length, wasJump, rowsPeak === 0);
        } catch (_) {}
        const listOwner = afkOwnerFromUrl();
        const ownerProf = listOwner ? await getProfile(listOwner) : null;
        await afkRecordList(listOwner, checked.length, ownerProf ? ownerProf.followers : null);
        // Эксперт «выжат»: помечаем, если прочекан ВЕСЬ список нужного типа.
        // Без фильтра по слову прокрутка до конца = прочеканы все -> помечаем всегда.
        // Со словом список фильтровался, поэтому полагаемся на эвристику «5+ человек
        // или всех видимых прочекали» и только для одного слова.
        // scrollBottom обязателен: пометка «выжат» снимает донора с пула НАВСЕГДА,
        // а срезанная потолком прокрутки хвостовая часть списка просто не была прочитана.
        if (listOwner && scrollBottom) {
          const noWord = tokens.length === 0;
          const fullByCount = tokens.length === 1 && checked.length > 0 && (checked.length >= 5 || checked.length >= afkUserCount(box));
          if (noWord || fullByCount) {
            await markDone(listOwner, checked.length, afkActualListKind(box));
          }
        }
        // Донор «пустой»: список дочитан до дна, людей в нём ВИДНО, а новых проверок
        // ноль — значит весь видимый хвост уже лежит в базе. markDone такой донор не
        // помечает (его ветка требует checked.length > 0), поэтому без этой отметки
        // он вечно возвращался в пул и ночной прогон сдувался до 87 человек.
        // Условий три, и все по делу: rowsPeak > 0 (ИГ отдал людей, а не заглушку),
        // scrollBottom (хвост не отрезан потолком скролла — там могли быть новые),
        // и живой экран (на блоке списки пустые у ВСЕХ — иначе одна блокировка
        // отравила бы весь пул доноров за вечер).
        try {
          if (!checked.length && rowsPeak > 0 && scrollBottom && !afkIgBlockSignal() && listOwner) {
            await afkWasteAdd(listOwner);
            bud().wasted = (Number(bud().wasted) || 0) + 1;
          }
          await afkWasteFlush(); // одна запись на границу списка, рядом с бюджетом
        } catch (_) {}
        await afkRefreshTotals(); // список закрыт — догоняем цифры, не дожидаясь тика сердца
        if (!(await afkRunning())) break;
        // Шлюз «блок / холостой ход»: до того, как ферма прыгнет к ещё одному донору.
        // Раньше здесь вообще ничего не смотрело на бан — ∞ молча перелистывал списки
        // часами, пока аккаунт доживал.
        const wasteAct = await afkBanIdleGuard(st0, checked.length);
        if (wasteAct === 'stop') break;
        if (wasteAct === 'rest') {
          // Отдыхали на странице, которая либо заблокирована, либо про нас уже всё
          // известно. Возвращаться туда в этом круге незачем — снимаем visited и уходим
          // к другому донору (в обход «выжатых»: на бане они все «выжатые» формально).
          await afkPatchState({ visited: [], fails: 0, pauseTill: 0, pauseWhy: '' });
          if (await afkInfiniteNewSeed(true)) return;
          continue;
        }
        // Порядок прыжка — СПУСКОМ, а не телепортом. Люди текущего списка только что
        // проверены, значит их собственные списки почти наверняка ещё не читаны: спуск
        // по ним и есть добыча новых. Раньше приоритет был у «самого крупного зелёного
        // из базы» — ферма каждый круг возвращалась к гигантам, которых обгладывали
        // неделями. В базу телепортируемся только когда спускаться реально некуда.
        let next = await afkPickNext(box);
        if (!next && st0.word && st0.word.trim().toLowerCase() !== 'тренер') {
          // Если среди отфильтрованных по слову брать больше некого — очищаем поиск,
          // чтобы взять кандидата из общего списка.
          afkSetBtnText('🤖 АФК: ищу следующего кандидата…');
          await afkClearWord(box);
          await igxSleep(1500);
          next = await afkPickNext(box);
        }
        if (!next) next = afkEnterMode === 'wordall' ? await afkPickAnyFromDb() : await afkPickGreenFromDb();
        if (!next) next = await afkPickAnyFromDb();
        if (!next) {
          if (st0.infinite) {
            // Круг по ТЕКУЩЕМУ списку замкнут и «зелёных/подходящих» в базе не осталось.
            // Раньше здесь был ступор: sleep(30с) + continue крутил ТОТ ЖЕ выжатый список,
            // afkPickNext снова давал null — новых профилей не открывалось. Вместо этого
            // берём нового донора и НАВИГИРУЕМ к его списку (в обход «выжатых»/занятых).
            afkSetBtnText('🤖 АФК∞: список выжат, ищу нового донора…');
            await afkPause(8000 + 3000, 'список выжат — ищу нового донора');
            await igxSleep(8000);
            if (!(await afkRunning())) break;
            await afkPatchState({ visited: [], fails: 0, pauseTill: 0, pauseWhy: '' });
            if (await afkInfiniteNewSeed(true)) return;
            // Совсем никого (жёсткие фильтры/пустая база) — честная пауза: другой прогон
            // или автопроверка могут дополнить базу, затем пробуем снова.
            afkSetBtnText('🤖 АФК∞: доноров в базе нет, жду 30с и начинаю новый круг…');
            await afkPause(30000 + 3000, 'доноров по фильтрам в базе нет — жду новый круг');
            await igxSleep(30000);
            if (!(await afkRunning())) break;
            continue;
          }
          await afkStop('подходящие профили в базе и в текущем списке исчерпаны — остановка.');
          break;
        }
        if (!(await afkRunning())) break;
        if (!(await afkReserveDonor(next.username))) continue;
        const stNow = await afkGetState();
        const visited = new Set((stNow && stNow.visited) || []);
        visited.add(next.username.toLowerCase());
        // jumped: true — если у следующего чела окажется закрытый список,
        // цикл поймёт, что был прыжок, и вернётся сюда (history.back).
        await afkPatchState({ visited: Array.from(visited), needSearch: true, jumped: true, cur: next.username, pauseTill: 0, pauseWhy: '' });
        afkProg(); // прыжок к новому донору — тоже шаг: пауза «ищу донора» не считается зависанием
        await afkMarkDispatched(next.username); // чтобы параллельные АФК не дублировали
        bud().jumps++; await budSave(); // перед навигацией — иначе расход этого круга потеряется
        // Прыжок в этой же вкладке: mutualFirst = полный список, не mutualOnly.
        location.href = afkFollowersUrl(next.username);
        return;
      }
      // Страховка «бесконечного» прогона: цикл мог выйти через break при живом st.on —
      // например, ИГ пересоздал узлы списка посреди скролла и afkScrollToEnd вернул false.
      // Прогон не должен умирать молча: поднимаем его по таймеру, afkEnsureList найдёт
      // свежую модалку. Валидные стопы (st.on=false) и переходы (return при location.href)
      // сюда не попадают. Счётчик сбоев ограничивает горячую петлю.
      let stOut = null;
      try { stOut = await afkGetState(); } catch (_) {}
      if (stOut && stOut.on && stOut.infinite && !stOut.stopping) {
        if (_afkErrStreak < 6) {
          _afkErrStreak++;
          afkSetBtnText('🤖 АФК∞: список потерялся, поднимаю прогон… (' + _afkErrStreak + '/6)');
          await afkPause(6000 + 3000, 'список потерялся — поднимаю прогон (' + _afkErrStreak + '/6)');
          afkWake(6000);
        } else if (await afkInfiniteRest('6 раз подряд потерял список')) {
          // длинная пауза уже назначена и подписана — стоп не нужен
        } else {
          await afkStop('бесконечный прогон ' + HARD_REST_MAX + ' раза подряд не смог поднять список даже после длинных пауз — стоп.');
        }
      }
    } catch (_) {
      // Транзитный сбой (DOM/сториджа/контекст) НЕ должен убивать «бесконечный» прогон:
      // отдыхаем и перезапускаемся по таймеру. Счётчик сбоев ограничивает горячую петлю.
      let isInfinite = false;
      try { const stE = await afkGetState(); isInfinite = !!(stE && stE.infinite && !stE.stopping && stE.on); } catch (_) {}
      if (isInfinite && _afkErrStreak < 6) {
        _afkErrStreak++;
        afkSetBtnText('🤖 АФК∞: сбой, перезапускаюсь… (' + _afkErrStreak + '/6)');
        const delay = Math.min(60000, 5000 * _afkErrStreak);
        await afkPause(delay + 3000, 'сбой цикла — перезапускаюсь (' + _afkErrStreak + '/6)');
        // НЕ стопим: finally ниже снимет active/busy и потушит hb, а по таймеру цикл поднимется заново.
        afkWake(delay);
      } else if (isInfinite && (await afkInfiniteRest('сбой цикла ×6'))) {
        // отдыхаю длинной паузой — стоп не объявляем
      } else {
        _afkErrStreak = 0;
        await afkStop('внутренняя ошибка цикла.');
      }
    } finally {
      afkLoopActive = false;
      afkLoopBusy = Math.max(0, afkLoopBusy - 1); // вот теперь цикл действительно вышел — больше ничего не делает
      if (afkHbTimer) { clearInterval(afkHbTimer); afkHbTimer = null; }
      // Зачистка — отсюда, а не из afkStop: только здесь прогон правдиво мёртв.
      // Кроме выхода из-за навигации (history.back / location.href): тогда st.on всё ещё
      // true, и на новой странице цикл возобновится по ключам — удалять их нельзя.
      let stF = null;
      try { stF = await afkGetState(); } catch (_) {}
      if (!stF || !stF.on) {
        try { await afkPurgeRunState(); } catch (_) {}
      }
      if (!(await afkRunning())) afkSetBtn(false);
    }
  }

  // Автозапуск АФК во ВНОВОЙ вкладке, открытой кнопкой из попапа. Попап кладёт запись в
  // очередь igx_afk_autostart и открывает /<юзер>/список/. Здесь подхватываем СВОЮ запись
  // по username и стартуем АФК. Состояние изолировано по вкладке, поэтому 5 кнопок =
  // 5 независимых АФК. Если в этой вкладке уже живой АФК (продолжение после прыжка) —
  // не трогаем, его поднимет блок возобновления ниже.
  (async () => {
    try {
      if (await isQuickCheckTab()) return;
    } catch (_) {}
    afkPruneAutostart(); // подчистить осиротевшее (без этого «призрак» мог выстрелить позже)
    const owner = afkProfileOwner();
    if (!owner) return;
    // Автостарт приходит ТОЛЬКО на URL списка (попап и дашборд открывают /<юз>/followers|following/).
    // Без этой проверки осиротевшая запись стартовала АФК, когда юзер просто открыл профиль.
    if (!afkIsFollowersPage()) return;
    const existing = await afkGetState();
    if (existing && existing.on) return;
    const entry = await afkTakeAutostart(owner);
    if (!entry) return;
    await afkMarkDispatched(owner);
    await igxSleep(2500); // даём ИГ отрисовать страницу новой вкладки
    try {
      await startAfk(typeof entry.word === 'string' ? entry.word : '', { infinite: !!entry.infinite });
    } catch (_) {}
  })();

  // Автоанализ профиля (кнопка ② второй страницы дашборда). Дашборд открыл окно с этим
  // профилем и положил запись в igx_pa_autostart. Стартуем РОВНО на той вкладке, чей
  // tabId записан: без этого второй замок не работал бы, и разбор начинался бы на
  // профиле, который человек открыл сам в ту же минуту.
  (async () => {
    try {
      if (await isQuickCheckTab()) return;
    } catch (_) {}
    paPruneAutostart();
    const username = extractUsername(location.pathname);
    if (!username) return;
    let tabId = null;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'getTabId' });
      tabId = r && r.tabId != null ? r.tabId : null;
    } catch (_) {}
    if (tabId == null) return; // не знаем свою вкладку → не имеем права угадывать
    const entry = await paTakeAutostart(username, tabId);
    if (!entry) return;
    await igxSleep(2500); // ИГ должна отрисовать сетку профиля
    try { await igxPaRun({ auto: true, jobId: entry.jobId || '' }); } catch (_) {}
  })();

  // Возобновление АФК после перехода: вкладка перезагрузилась на профиле или /подписчиках следующего чела.
  // Живой цикл пишет hb каждые ~5с (в фоновой вкладке Chrome троттлит таймеры до ~1мин),
  // поэтому «свежесть» меряем в 5 минут: всё, что старше — мёртвый хвост после перезагрузки
  // расширения или краха вкладки (afkStop не отработал), и АФК самовольно вскакивал на пустом месте.
  const AFK_RESUME_FRESH_MS = 5 * 60 * 1000;
  (async () => {
    // В фоновых вкладках автопроверки — сразу выходим, не трогая storage
    try {
      if (await isQuickCheckTab()) return;
    } catch (_) {}
    const st = await afkGetState();
    if (!st || !st.on) return;
    // «Бесконечный» прогон обязан переживать заморозку вкладки: сон ПК, discard фона,
    // троттлинг таймеров — hb мог протухнуть на часы, но человек НЕ останавливал
    // (on ещё true, stopping нет). Такой прогон возобновляем, а не глушим. Жёсткий
    // 5-минутный ценз оставляем только для обычных (не ∞) прогонов — они не «бесконечные».
    const staleHb = !st.hb || Date.now() - Number(st.hb) > AFK_RESUME_FRESH_MS;
    if (staleHb && !(st.infinite && !st.stopping)) {
      try {
        await afkPatchState({ on: false, needSearch: false });
        setSessionAfkState(null);
        await chrome.storage.local.remove(getAfkSessionKey());
      } catch (_) {}
      return;
    }
    if (staleHb) {
      // возобновляем «уснувший» ∞-прогон: обнуляем счётчик сбоев и освежаем hb
      _afkErrStreak = 0;
      try { await afkPatchState({ fails: 0, hb: Date.now() }); } catch (_) {}
    }
    const path = location.pathname;
    const onFollowers = afkIsFollowersPage();
    const onProfile = /^\/[A-Za-z0-9._]{1,30}\/?$/i.test(path);
    if (!onFollowers && !onProfile) {
      await afkPatchState({ on: false });
      return;
    }
    if (afkIsMutualOnlyPage()) {
      const owner = afkProfileOwner();
      if (owner) {
        location.href = afkFollowersUrl(owner);
        return;
      }
    }
    const markAfkChk = () => {
      const chk = sidePanelEl && sidePanelEl.querySelector('.igx-chk-afk');
      if (chk) chk.checked = true;
    };
    markAfkChk();
    if (!sidePanelEl) {
      const t0 = Date.now();
      const iv = setInterval(() => {
        markAfkChk();
        if (sidePanelEl || Date.now() - t0 > 30000) clearInterval(iv);
      }, 500);
    }
    await igxSleep(5000); // даём ИГ отрисовать профиль и модалку после загрузки
    afkLoop();
  })();

  // ============================================================================
  // ЛИСТ ⑥ · ДВИЖОК КОММЕНТОВ (сборка 38). Второй канал добычи: вместо списков
  // подписчиков (самый лимитируемый запрос ИГ) читаем комментарии под свежими
  // рилсами донора. Протокол — зеркало АФК: дашборд кладёт запись в
  // igx_cmt_autostart и открывает окно на /<донор>/reels/; скрипт забирает СВОЮ
  // запись (свежая, владелец URL совпал), крутит цикл и пишет зеркало
  // igx_cmt_tab_<tabId> {sid,on,phase,hb,prog,...}. Дашборд считает окна по
  // свежему hb (тот же ценз HB_FRESH, что у АФК-сессий). «Стоп» —
  // igx_cmt_stop_cmd {ts, tabId?}: с tabId гасит одну вкладку, без — все.
  // Состояние живёт в storage под ВКЛАДКОЙ, поэтому навигации
  // профиль→reels→риелс прогон не убивают, а перезагрузка страницы возобновляет
  // его (sid в sessionStorage не даёт осиротевшему зеркалу присвоить чужую
  // вкладку — ровно та же arbitration, что у АФК). Пороги движок читает РОВНО
  // те ключи, которые пишет лист ⑥; дефолты совпадают с CMT_DEFAULTS дашборда.
  // Лид отсюда помечается viaComments — холодный зритель чужого рилса, а не
  // сам эксперт; рассылка без первой проверки TG его не берёт (решение на
  // стороне дашборда/бота, здесь — честный флаг в записи).
  // ============================================================================
  const CMT_AUTOSTART_KEY = 'igx_cmt_autostart';  // [{username, ts}] — очередь запуска с дашборда
  const CMT_DISPATCHED_KEY = 'igx_cmt_dispatched'; // {username: ts} — сид занят 3 ч (как у АФК)
  const CMT_STOP_KEY = 'igx_cmt_stop_cmd';        // {ts, tabId?} — команда «стоп» с дашборда
  const CMT_ERR_KEY = 'igx_cmt_last_err';         // последняя ошибка режима (лампочка «⚠»)
  const CMT_STATE_KEY = 'igx_cmt_state';          // глобальная сводка последнего шага
  const CMT_TAB_PREFIX = 'igx_cmt_tab_';          // зеркало состояния на вкладку
  const CMT_VIDEO_PREFIX = 'igx_video:';           // база видео: код → метрики (наполняет движок)
  const CMT_DEFS = { maxAge: 30, minComments: 1, per1000: 0, readMax: 60, postsPerRun: 3, ceiling: 20 };
  // Зеркало молчит дольше этого — считаем хвостом, а не спящим окном, НО только
  // когда сам прогон выключен (on:false) или идёт дольше суток: живое on-зеркало
  // переживает любую заморозку, иначе вотчдог (будит раз в 15 мин) перезагрузкой
  // гарантированно убивал сид (баг ревью сборки 38).
  const CMT_RESUME_FRESH_MS = 10 * 60 * 1000;
  const CMT_RESUME_MAX_RUN_MS = 24 * 3600 * 1000;
  const CMT_AUTOSTART_FRESH_MS = 3 * 60 * 1000;

  function cmtSid() {
    try {
      let id = sessionStorage.getItem('igx_cmt_sid');
      if (!id) {
        id = 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem('igx_cmt_sid', id);
      }
      return id;
    } catch (_) { return 'local_cmt'; }
  }

  // Владелец текущего URL: /<u>/, /<u>/reels/..., /<u>/followers/. Не /^\/<u>\/?$/ —
  // extractUsername на подстраницах молчит, а движку жить именно на них.
  function cmtOwner() {
    const path = String(location.pathname || '');
    // Вечная ссылка поста НЕ содержит пользователя: Instagram канонизирует
    // /<донор>/reel/<код>/ → /reel/<код>/, и прежний регекс брал первым сегментом
    // слово «reel» (в RESERVED есть «reels», но не «reel»). Движок записывал
    // донора «reel» в базу видео, в лиды (cmtDonor) и в donorLc — из-за этого
    // фильтр «коммент самого донора — не лид» не отсеивал НИЧЕГО (баг ревью 38).
    if (/^\/(?:reel|p|tv)\//i.test(path)) return '';
    const m = path.match(/^\/([A-Za-z0-9._]{1,30})(?:\/|$)/);
    if (!m) return '';
    return RESERVED.has(m[1].toLowerCase()) ? '' : m[1];
  }
  function cmtReelCode() {
    const m = String(location.pathname || '').match(/\/(?:reel|p|tv)\/([A-Za-z0-9_-]{3,20})/);
    return m ? m[1] : '';
  }
  // Лимит-модалка Instagram, ТОЛЬКО по [role="dialog"]. Полный afkIgBlockSignal()
  // на странице одного рилса опасен: он при отсутствии «живой сетки» читает
  // main.innerText, а там подписи и чужие комменты — «попробуйте позже» из
  // комментария подняло бы ложный бан. На сетке рилсов полный детектор безопасен.
  function cmtBlockModal() {
    try {
      for (const d of document.querySelectorAll('[role="dialog"]')) {
        if (IG_BLOCK_RE.test(String(d.innerText || '').toLowerCase())) return 'Instagram: экран блокировки/лимита (модалка)';
      }
    } catch (_) {}
    return '';
  }

  // Пороги листа ⑥ — те же дефолты, что показывает экран (иначе «видел 30, ферма ест 0»).
  // Заодно считает, сколько профиль-вью сжевали СОСЕДНИЕ окна за час: счётчик движка
  // живёт в зеркале каждой вкладки, а общий ключ был read-modify-write, из-за чего
  // N окон теряли инкременты друг друга и «20 в час» становилось 20×N (баг ревью 38).
  async function cmtCfg(tabId) {
    let a = {};
    try { a = await chrome.storage.local.get(null); } catch (_) {}
    const now = Date.now();
    const num = (k, d) => { const v = Number(a[k]); return isFinite(v) ? v : d; };
    let pvOthers = 0;
    for (const kk of Object.keys(a)) {
      if (kk.indexOf(CMT_TAB_PREFIX) !== 0 || kk === CMT_TAB_PREFIX + tabId) continue;
      const s = a[kk] || {};
      const at = Number(s.pvAt) || 0;
      if (at && now - at <= 3600000) pvOthers += Number(s.pvN) || 0;
    }
    const words = String(a.igx_cmt_must_word || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return {
      maxAge: num('igx_cmt_max_age_days', CMT_DEFS.maxAge),
      minComments: num('igx_cmt_min_comments', CMT_DEFS.minComments),
      per1000: num('igx_cmt_per_1000', CMT_DEFS.per1000),
      onlyExpert: a.igx_cmt_only_expert === true,
      readMax: Math.max(5, num('igx_cmt_read_max', CMT_DEFS.readMax)),
      postsPerRun: Math.max(1, num('igx_cmt_posts_per_run', CMT_DEFS.postsPerRun)),
      ceiling: num('igx_cmt_profile_ceiling', CMT_DEFS.ceiling),
      openProfiles: a.igx_cmt_open_profiles !== false,
      words,
      master: a.igx_cmt_master_on === true,
      rotate: a.igx_cmt_rotate === 'loop' ? 'loop' : 'once',
      loopPause: Math.max(1, num('igx_cmt_loop_pause', 30)),
      pvOthers,
    };
  }

  async function cmtMirrorGet(tabId) {
    const key = CMT_TAB_PREFIX + tabId;
    const d = await chrome.storage.local.get(key);
    return (d && d[key]) || null;
  }
  // Патчим зеркало и всегда освежаем hb — дашборд по нему считает «окно живое».
  // ВСЕ записи идут через одну цепочку промисов: без неё heartbeat (каждые 5 с,
  // патч {}) и шаг цикла (done/checked/seenU/leads) перекрывались на await чтения,
  // и проигравший откатывал поля победителя — «прочитанные» рилсы сбрасывались, а
  // пустой targets заставлял cmtRun решать, что мишени кончились (баг ревью 38).
  let cmtWriteChain = Promise.resolve();
  // Чтение → решение (fn) → запись — ОДНОЙ очередью, то есть атомарно. Обычному
  // патчу гонка не страшна, но пороги (профиль-вью) РЕШАЮТ ПО ТЕКУЩЕМУ счётчику,
  // и там разрыв между чтением и записью = переврасход. fn обязана вернуть патч или
  // null (null = не пишем) и НЕ имеет права звать cmtMirrorPatch: очередь ждала бы
  // сама себя (см. cmtPvAllow).
  function cmtMirrorAtomic(tabId, fn) {
    const run = async () => {
      try {
        const key = CMT_TAB_PREFIX + tabId;
        const cur = ((await chrome.storage.local.get(key)) || {})[key] || {};
        const patch = await fn(cur);
        if (!patch) return null;
        const st = Object.assign({}, cur, patch);
        st.sid = st.sid || cmtSid();
        st.hb = Date.now();
        await chrome.storage.local.set({ [key]: st });
        return st;
      } catch (_) { return null; }
    };
    cmtWriteChain = cmtWriteChain.then(run, run);
    return cmtWriteChain;
  }
  function cmtMirrorPatch(tabId, patch) {
    return cmtMirrorAtomic(tabId, () => patch);
  }
  async function cmtMirrorRemove(tabId) {
    try { await chrome.storage.local.remove(CMT_TAB_PREFIX + tabId); } catch (_) {}
  }
  // Сводка «последний шаг» — одна на всех (дашборд показывает в статусной строке).
  async function cmtSummary(patch) {
    try {
      const cur = ((await chrome.storage.local.get(CMT_STATE_KEY)) || {})[CMT_STATE_KEY] || {};
      const st = Object.assign({}, cur, patch);
      st.hb = Date.now();
      await chrome.storage.local.set({ [CMT_STATE_KEY]: st });
    } catch (_) {}
  }
  async function cmtErr(msg) {
    try { await chrome.storage.local.set({ [CMT_ERR_KEY]: String(msg || '').slice(0, 300) }); } catch (_) {}
  }

  // Поток «стоп»: команда старше нашего старта и (общая ИЛИ именно наша вкладка).
  async function cmtStopAsked(tabId, startedAt) {
    try {
      const d = await chrome.storage.local.get(CMT_STOP_KEY);
      const c = d && d[CMT_STOP_KEY];
      if (!c || !c.ts) return false;
      if (Number(c.ts) < Number(startedAt)) return false;
      return !c.tabId || Number(c.tabId) === Number(tabId);
    } catch (_) { return false; }
  }

  // Потолок заходов в профиль комментатора в час: профиль-вью — тот же суточный
  // лимит, что у списков; без счётчика второй канал просто быстрее сожрёт его.
  // Свой счётчик (pvAt/pvN) лежит в ЗЕРКАЛЕ вкладки и решается через атомарную
  // очередь записей, чужой подкладывается в cfg.pvOthers — поэтому ни lost update,
  // ни ×N переврасхода (баг ревью сборки 38).
  // ВАЖНО: решение и инкремент ОДНОЙ операцией. Прежний вариант сначала ЧИТАЛ
  // зеркало отдельным get, а патч ставил в очередь: шаг вызывает cmtPvAllow из
  // синхронного перебора строк (без await), и на пачке из 10 новых лидов все 10
  // читали pvN=0, все 10 проходили потолок и все 10 записывали pvN=1 — то есть
  // 10 профиль-вью в счётчике выглядели как одна (баг второй итерации ревью 38).
  async function cmtPvAllow(ceiling, tabId, others) {
    const now = Date.now();
    const res = await cmtMirrorAtomic(tabId, (cur) => {
      const at = Number(cur.pvAt) || 0;
      const own = at && now - at <= 3600000 ? (Number(cur.pvN) || 0) : 0;
      if (ceiling > 0 && own + (Number(others) || 0) >= ceiling) return null;
      return { pvAt: own ? at : now, pvN: own + 1 };
    });
    return res !== null;
  }

  // ── DOM-примитивы комментарной охоты ──────────────────────────────────────
  // Кнопка «Посмотреть все N комментариев» / «ещё комментарии». ИГ рендерит её то
  // button'ом, то div[role=button], и в обеих локалях — ловим по тексту.
  function cmtExpandClicks() {
    let n = 0;
    try {
      const els = Array.from(document.querySelectorAll('button, div[role="button"]'));
      for (const el of els) {
        const t = String(el.innerText || '').trim().toLowerCase();
        if (!t || t.length > 90) continue;
        if (/посмотреть (все|ещ[её])|ещ[её] (комментар|ответ)|загрузить ещё коммент|view all|more comments|show more comments/i.test(t)) {
          el.click(); n++;
          if (n >= 2) break;
        }
      }
    } catch (_) {}
    return n;
  }

  // Ссылка автора комментария — это «/<u>/» (одиночный сегмент). Отсекаем служебные
  // RESERVED и форматы /p/ /reel/ /explore/ (в них есть слэши → не матчатся).
  function cmtAuthorHref(href) {
    const clean = String(href || '').split('?')[0].split('#')[0];
    const m = clean.match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
    if (!m || RESERVED.has(m[1].toLowerCase())) return '';
    return m[1];
  }

  // Строки комментариев. РАНЬШЕ брали <li>, но Instagram перестал класть комментарии
  // в <li> (замер живой вкладки: 0 <li> и 0 <article> при полностью отрисованных
  // комментах справа) — отсюда вечное «строк комм. 0». Тег больше не опора. Ищем
  // строку по инварианту, не зависящему от тега: блок, ссылающийся ровно на ОДНОГО
  // уникального автора и содержащий текст. Для каждой ссылки-профиля поднимаемся
  // вверх, пока предок не начнёт захватывать второго автора — это строка комментария.
  // ВАЖНО: автор — НЕ первая a[href]: под риелсом в строке идут пермалинк времени
  // «/p/<код>/c/<id>/», хэштеги «/explore/tags/…», упоминания — их cmtAuthorHref
  // отсекает (резерв/не профиль), остаётся именно ссылка комментатора.
  function cmtDistinctAuthors(el) {
    const set = new Set();
    for (const a of el.querySelectorAll('a[href]')) {
      const u = cmtAuthorHref(a.getAttribute('href'));
      if (u) { set.add(u.toLowerCase()); if (set.size > 1) return set.size; }
    }
    return set.size;
  }
  function cmtEachRow(cb) {
    const seeds = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const u = cmtAuthorHref(a.getAttribute('href'));
      if (u) seeds.push({ a, u });
    }
    const seenEl = new Set();
    for (const s of seeds) {
      try {
        let row = s.a;
        for (let d = 0; d < 8; d++) {
          const p = row.parentElement;
          if (!p || p === document.body) break;
          if (cmtDistinctAuthors(p) !== 1) break;
          row = p;
        }
        if (seenEl.has(row)) continue;
        seenEl.add(row);
        // страховка: забрался слишком высоко — это не одна строка, а весь пост/нав
        try { if (row.querySelectorAll('a[href]').length > 12) continue; } catch (_) {}
        const text = String(row.innerText || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        cb(s.u, text, row);
      } catch (_) {}
    }
  }

  // Скролл-контейнер комментариев: первый предок с реальным вертикальным скроллом.
  // Если не нашёлся (риелс скроллит само окно) — скроллим окно.
  function cmtScroller(sampleLi) {
    let el = sampleLi && sampleLi.parentElement;
    while (el && el !== document.body) {
      const cs = window.getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 40) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ── один шаг на странице рилса: метрики → фильтры → база видео → комменты → лиды ──
  async function cmtReelStep(tabId, st, cfg) {
    const code = cmtReelCode();
    if (!code) return { nav: true };
    const done = Array.isArray(st.done) ? st.done : [];
    if (done.includes(code)) return { nav: true };
    await igxSleep(3500); // ИГ должна отрисовать пост и счётчики

    // бан-гейт: страница блокировки/логина вместо рилса
    if (/challenge|accounts\/(login|activity)/i.test(location.href)) {
      await afkRiskNoteBlock('комменты: Instagram показывает экран проверки/логина');
      try { await chrome.storage.local.set({ 'igx_cmt_banned': { at: Date.now(), why: 'экран проверки/логина' } }); } catch (_) {}
      return { finish: 'Instagram свербнул на экран проверки — окно остывает' };
    }
    // и живой признак лимита действий: ИГ пишет «Действия ограничены» / «We're
    // temporarily blocking this feature» МОДАЛКОЙ, не меняя URL, — прежний гейт
    // её не видел, и цикл продолжал жать «Посмотреть все N комментариев» ровно
    // перед экраном отказа (баг ревью 38; здесь только диалоги — см. cmtBlockModal).
    const blkModal = cmtBlockModal();
    if (blkModal) {
      await afkRiskNoteBlock('комменты (риелс): ' + blkModal);
      try { await chrome.storage.local.set({ 'igx_cmt_banned': { at: Date.now(), why: blkModal } }); } catch (_) {}
      return { finish: 'Instagram показывает экран лимита — окно остывает' };
    }

    const m = extractInstagramPostData(document) || {};
    const views = typeof m.views === 'number' ? m.views : null;
    const comments = typeof m.comments === 'number' ? m.comments : null;
    const daysAgo = typeof m.daysAgo === 'number' ? m.daysAgo : null;
    const owner = cmtOwner() || st.donor || '';

    // база видео: пишем ДО фильтров — «видео в базе» это всё, что режим видел,
    // а не только пригодное (иначе экран врал бы о покрытии)
    const vkey = CMT_VIDEO_PREFIX + code;
    let vrec = null;
    try { vrec = ((await chrome.storage.local.get(vkey)) || {})[vkey] || null; } catch (_) {}
    const per1000 = views && comments != null ? Math.round((comments / Math.max(1, views)) * 1000) : null;
    const rec = Object.assign({ code, owner, url: location.href.split('?')[0] }, vrec || {}, {
      daysAgo: daysAgo != null ? daysAgo : (vrec && vrec.daysAgo) || null,
      views: views != null ? views : (vrec && vrec.views) || null,
      comments: comments != null ? comments : (vrec && vrec.comments) || null,
      per1000: per1000 != null ? per1000 : (vrec && vrec.per1000) || null,
      checkedAt: Date.now(),
    });
    try { await chrome.storage.local.set({ [vkey]: rec }); } catch (_) {}

    done.push(code);
    const checked = (Number(st.checked) || 0) + 1;
    await cmtMirrorPatch(tabId, { done, checked, prog: Date.now(), phase: 'reel', reel: code });
    await cmtSummary({ lastDonor: owner, lastVideo: code, checked, leads: Number(st.leads) || 0, phase: 'reel' });

    // фильтры «ОТ мусора»: свежесть, минимум комментов, плотность на 1000 просмотров,
    // «только экспертные» (пометку format='экспертный' ставит автоанализ; до неё такой
    // фильтр честно не находит ни одного видео — движок не выдумывает формат)
    const fails = [];
    if (cfg.maxAge > 0 && daysAgo != null && daysAgo > cfg.maxAge) fails.push('старже ' + cfg.maxAge + ' дн');
    if (cfg.minComments > 0 && comments != null && comments < cfg.minComments) fails.push('комментов ' + comments + ' < ' + cfg.minComments);
    if (cfg.per1000 > 0 && per1000 != null && per1000 < cfg.per1000) fails.push(per1000 + '/1000 < ' + cfg.per1000);
    if (cfg.onlyExpert && String((vrec && vrec.format) || '') !== 'экспертный') fails.push('не «экспертное»');
    if (fails.length) return { skip: fails.join(', ') };

    // раскрываем и читаем комментарии
    cmtExpandClicks();
    await igxSleep(1200);
    cmtExpandClicks();
    // Ждём, пока Instagram ОТРИСУЕТ хотя бы одну строку комментария. На медленном
    // риелсе панель комментов подгружается позже, а прежний цикл скролла выходил по
    // «4 тика без роста», так и не дождавшись первой отрисовки → «всегда 0» даже при
    // выключенных фильтрах. До 8 тиков (~10 с) переоткрываем и ждём первую строку.
    let rowN = 0;
    for (let w = 0; w < 8; w++) {
      rowN = 0;
      cmtEachRow(() => { rowN++; });
      if (rowN > 0) break;
      cmtExpandClicks();
      await igxSleep(1200);
    }
    // Диагностика «почему 0» (v4): опора — НЕ <li> (их Instagram больше не рисует),
    // а число ссылок-профилей (aN) и собранных строк (rowN). aN=0 → на странице нет
    // ни одного профиля (комментов реально нет / не та страница); aN>0 при rowN=0 →
    // ссылки есть, но строки не собираются (селектор). Снимаем сигнатуру, только
    // когда строк НОЛЬ, — иначе она не нужна.
    let liTotal = 0;
    let authorLinks = 0;
    try {
      liTotal = document.querySelectorAll('li').length;
      for (const a of document.querySelectorAll('a[href]')) { if (cmtAuthorHref(a.getAttribute('href'))) authorLinks++; }
    } catch (_) {}
    let sig = null;
    if (rowN === 0) {
      try {
        const bodyTxt = (document.body && document.body.innerText) || '';
        const low = bodyTxt.slice(0, 3000).toLowerCase();
        sig = {
          path: String(location.pathname || '').slice(0, 48),
          body: bodyTxt.length,
          art: document.querySelectorAll('article').length,
          dlg: document.querySelectorAll('[role="dialog"]').length,
          links: document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').length,
          aN: authorLinks,
          // «стена логина» — ТОЛЬКО на пустой странице: раньше regex ловил подстроку
          // на полностью отрисованном риелсе и врал «ты не залогинен» (уловка-ложь).
          login: bodyTxt.length < 600 && /войдите|чтобы продолжить|log in|sign in|see more on instagram|forgot password/.test(low) ? 1 : 0,
        };
      } catch (_) { sig = { err: 1 }; }
    }
    await cmtMirrorPatch(tabId, { liN: liTotal, rowN, aN: authorLinks, hidden: document.hidden ? 1 : 0, sig, ver: 'v5', prog: Date.now() });
    const target = Math.min(cfg.readMax, 200);
    const seenU = new Set(Array.isArray(st.seenU) ? st.seenU : []);
    const leadsNow = Number(st.leads) || 0;
    let read = Number(st.read) || 0;
    let scroller = null;
    let lastCount = -1;
    let stillTicks = 0;
    let newLeads = 0;
    for (let iter = 0; iter < 40; iter++) {
      let rowCount = 0;
      cmtEachRow(() => { rowCount++; });
      if (!scroller) {
        // контейнер ищем НЕ по <li> (их IG больше не рисует): берём ПЕРВУЮ собранную
        // строку комментария и поднимаемся от неё до реально скроллящегося предка.
        let sampleRow = null;
        try { cmtEachRow((u, text, el) => { if (!sampleRow) sampleRow = el; }); } catch (_) {}
        scroller = cmtScroller(sampleRow);
      }
      if (rowCount >= target) break;
      if (rowCount === lastCount) stillTicks++; else stillTicks = 0;
      if (stillTicks >= 4) break; // упёрлись в конец («загрузить ещё» нет или пустой хвост)
      lastCount = rowCount;
      try {
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        else window.scrollTo(0, document.body.scrollHeight);
      } catch (_) {}
      await igxSleep(1100);
      // «стоп» долетает даже посреди скролла
      if (await cmtStopAsked(tabId, st.startedAt)) return { finish: 'остановлено с дашборда' };
      // каждую итерацию переоткрываем «все комменты» — ИГ прячет хвост после порции
      if (iter % 3 === 2) cmtExpandClicks();
    }

    // разбор строк в лиды
    const lowerWords = cfg.words;
    const donorLc = String(owner || '').toLowerCase();
    cmtEachRow((u, text) => {
      const ulc = u.toLowerCase();
      if (seenU.has(ulc)) return;
      seenU.add(ulc);
      read++;
      if (ulc === donorLc) return;
      if (lowerWords.length) {
        const tl = text.toLowerCase();
        if (!lowerWords.some((w) => tl.includes(w))) return;
      }
      newLeads++;
      // запись лида: отдельная полка viaComments + срез комментария (кто и под чем спросил)
      saveProfile({
        username: u,
        url: 'https://www.instagram.com/' + u + '/',
        viaComments: true,
        cmtAt: Date.now(),
        cmtText: text.slice(0, 300),
        cmtDonor: owner || '',
        cmtVideo: code,
      }).catch(() => {});
      if (cfg.openProfiles) {
        // заход в профиль (быстрая проверка TG) — только в рамках почасового потолка;
        // саму проверку делает фоновая вкладка воркера, наш цикл ей не мешает
        cmtPvAllow(cfg.ceiling, tabId, cfg.pvOthers).then((ok) => { if (ok) enqueueQuickCheck(u, 'https://www.instagram.com/' + u + '/'); }).catch(() => {});
      }
    });
    const seenArr = Array.from(seenU).slice(-4000); // хвост: набор растёт весь прогон
    await cmtMirrorPatch(tabId, { seenU: seenArr, read, leads: leadsNow + newLeads, prog: Date.now() });
    return { leads: newLeads };
  }

  // ── шаг сетки рилсов: набрать мишени и нырнуть в первую ──
  async function cmtGridStep(tabId, st, cfg) {
    const owner = cmtOwner();
    if (!owner) return { navTo: 'https://www.instagram.com/' + (st.donor || '') + '/reels/' };
    await igxSleep(3000); // сетка дорисовывается
    if (/challenge|accounts\/(login|activity)/i.test(location.href)) {
      await afkRiskNoteBlock('комменты (сетка): Instagram показывает экран проверки/логина');
      return { finish: 'Instagram свербнул на экран проверки — окно остывает' };
    }
    // сетка рилсов — «здоровая» страница по мерке АФК (≥3 ссылок на посты), так что
    // полный детектор блока здесь не ловит ложняк из подписей
    const gridBlk = afkIgBlockSignal();
    if (gridBlk) {
      await afkRiskNoteBlock('комменты (сетка): ' + gridBlk);
      return { finish: 'Instagram показывает экран лимита — окно остывает' };
    }
    // /<u>/ без /reels/ → сами туда не идём
    if (!/\/reels?\//i.test(location.pathname)) {
      if (/^\/[A-Za-z0-9._]{1,30}\/?$/i.test(location.pathname)) return { navTo: 'https://www.instagram.com/' + owner + '/reels/' };
      return { finish: 'вкладка ушла с пути донора — прогон закрыт' };
    }
    // ссылки риелсов + даты из сетки; скроллим сетку, пока не насоберём кандидата
    const want = cfg.maxAge > 0 ? cfg.maxAge * 86400000 : 0;
    const codes = new Map(); // code → daysAgo|null (null = дата не видна, решим на месте)
    const harvest = () => {
      for (const a of document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]')) {
        const m = String(a.getAttribute('href') || '').match(/\/(?:reel|p|tv)\/([A-Za-z0-9_-]{3,20})/);
        if (!m || codes.has(m[1])) continue;
        let d = null;
        const cell = a.closest('div');
        const t = cell ? cell.querySelector('time[datetime]') : null;
        const iso = t && t.getAttribute('datetime');
        if (iso) { const ms = Date.now() - new Date(iso).getTime(); if (isFinite(ms)) d = Math.max(0, Math.floor(ms / 86400000)); }
        codes.set(m[1], d);
      }
    };
    harvest();
    for (let i = 0; i < 8 && (codes.size < cfg.postsPerRun * 2 || [...codes.values()].some((v) => v == null || (want && v * 86400000 <= want))); i++) {
      try { window.scrollTo(0, document.body.scrollHeight); } catch (_) {}
      await igxSleep(1400);
      harvest();
      if (await cmtStopAsked(tabId, st.startedAt)) return { finish: 'остановлено с дашборда' };
    }
    const done = Array.isArray(st.done) ? st.done : [];
    const fresh = [];
    for (const [c, d] of codes) {
      if (done.includes(c)) continue;
      if (d == null) fresh.push({ c, d: null });
      else if (!want || d * 86400000 <= want) fresh.push({ c, d });
    }
    fresh.sort((a, b) => (a.d == null ? 1e9 : a.d) - (b.d == null ? 1e9 : b.d));
    const targets = fresh.slice(0, cfg.postsPerRun).map((x) => x.c);
    await cmtMirrorPatch(tabId, { donor: owner, targets, phase: 'grid', prog: Date.now() });
    if (!targets.length) {
      // ∞: пустая/старая сетка ОДНОГО донора больше НЕ убивает окно — это повод
      // перескочить на следующего. Причины пишем честно (жалоба «нихуя не
      // показывает»): на сетке рилсов ИГ обычно не отдаёт <time>, поэтому пустой
      // список почти всегда значит «сетка пустая/не дорисовалась», а не «всё старое».
      const seen = codes.size;
      let reason;
      if (done.length) reason = 'сетка @' + owner + ' прочекана';
      else if (!seen) reason = 'на сетке @' + owner + ' ни одного рилса/поста';
      else reason = 'увидел ' + seen + ' рилс(ов) @' + owner + ', все старше ' + (cfg.maxAge > 0 ? cfg.maxAge + ' дн' : 'порога');
      return { rotate: reason };
    }
    return { navTo: 'https://www.instagram.com/' + owner + '/reel/' + targets[0] + '/' };
  }

  // Graceful-финиш: зеркало гасим, причину пишем честно.
  async function cmtFinish(tabId, reason, ok) {
    const st = await cmtMirrorGet(tabId).catch(() => null);
    await cmtMirrorPatch(tabId, { on: false, stopping: false, phase: 'idle', reason: String(reason || '').slice(0, 200), finishedAt: Date.now() });
    await cmtSummary({ lastDonor: (st && st.donor) || '', phase: 'idle', checked: (st && st.checked) || 0, leads: (st && st.leads) || 0, note: String(reason || '').slice(0, 200) });
    if (!ok) await cmtErr(reason || 'прогон завершён с ошибкой');
  }

  // ── ∞-РОТАЦИЯ ДОНОРОВ (окно комментов живёт, пока не исчерпан пул) ──────────
  // Следующий донор из ОБЩЕГО пула — те же донорские фильтры, что у АФК и у
  // startCmtWindow (сабы/слово/пол), минус уже опробованные в этом прогоне и минус
  // занятые другими окнами комментов (<3 ч по igx_cmt_dispatched). requireTg=false:
  // дону не нужен Telegram, ему нужны рилсы. relax=true: не тащить АФК-овы done/
  // waste/dispatched — у комментов своя занятость.
  async function cmtPickNextDonor(triedLower) {
    let cands = await afkGreenCandidates(triedLower, false, 'all', true);
    if (!cands.length) cands = await afkGreenCandidates(triedLower, false, 'any', true);
    if (!cands.length) return null;
    let dp = {};
    try { dp = ((await chrome.storage.local.get(CMT_DISPATCHED_KEY)) || {})[CMT_DISPATCHED_KEY] || {}; } catch (_) {}
    const cut = Date.now() - 3 * 3600 * 1000;
    const free = cands.filter((c) => !(Number(dp[String((c.u || c.username || '')).toLowerCase()]) > cut));
    return afkTakeCandidate(free.length ? free : cands);
  }
  // Перескок на следующего донора, НЕ закрывая окно: on остаётся true, поэтому
  // cmtSweep вкладку не сносит. Сбрасываем ТОЛЬКО пордонорные счётчики (targets/
  // done); ран-левел (checked/leads/read/seenU) и tried копим до конца прогона.
  // Пул исчерпан → честный финиш (вот тогда окно и закроется).
  async function cmtRotate(tabId, st, cfg, why) {
    const tried = new Set((Array.isArray(st.tried) ? st.tried : []).map((x) => String(x).toLowerCase()));
    if (st.donor) tried.add(String(st.donor).toLowerCase());
    const pick = await cmtPickNextDonor(tried);
    if (!pick || !pick.username) {
      // ∞-круг: пул пройден, но режим «вечный» — окно НЕ гасим, берём паузу и идём
      // на новый круг (tried очищается; будить будет heartbeat либо резюм после
      // заморозки вкладки). Пул пуст вообще (нулевой базы) — тоже ждём и пробуем.
      if (cfg && cfg.rotate === 'loop') {
        const nowW = Date.now();
        const waitMs = Math.max(1, Number(cfg.loopPause) || 30) * 60000;
        await cmtMirrorPatch(tabId, { phase: 'circle-wait', waitUntil: nowW + waitMs, tried: [], prog: nowW });
        await cmtSummary({ lastDonor: (st && st.donor) || '', phase: 'circle-wait', checked: Number(st.checked) || 0, leads: Number(st.leads) || 0, note: 'круг пройден (' + tried.size + ' доноров), пауза ' + Math.round(waitMs / 60000) + ' мин → новый круг' });
        return;
      }
      await cmtFinish(tabId, (why ? why + ' · ' : '') + 'пул исчерпан: прошёл ' + tried.size + ' донор(ов), свежих рилсов ни у кого нет', true);
      return;
    }
    const now = Date.now();
    try {
      const dp = ((await chrome.storage.local.get(CMT_DISPATCHED_KEY)) || {})[CMT_DISPATCHED_KEY] || {};
      dp[String(pick.username).toLowerCase()] = now;
      await chrome.storage.local.set({ [CMT_DISPATCHED_KEY]: dp });
    } catch (_) {}
    await cmtMirrorPatch(tabId, { donor: pick.username, tried: Array.from(tried), targets: [], done: [], phase: 'boot', ver: 'v5', prog: now });
    await cmtSummary({ lastDonor: pick.username, phase: 'grid', checked: Number(st.checked) || 0, leads: Number(st.leads) || 0, note: '∞ перескок на @' + pick.username });
    try { location.href = 'https://www.instagram.com/' + pick.username + '/reels/'; }
    catch (_) { await cmtFinish(tabId, 'не смогли перейти к следующему донору', false); }
  }

  // Главный цикл одной вкладки: шаг за шагом, состояние — в зеркале. Навигация
  // (полная или SPA) не ломает прогон: после полной перезагрузки этот же цикл
  // подхватывает boot-IIFE, после SPA он просто продолжает крутиться здесь.
  async function cmtRun(tabId) {
    let st = await cmtMirrorGet(tabId);
    if (!st || !st.on || st.sid !== cmtSid()) return;
    const cfg = await cmtCfg(tabId);
    if (!cfg.master) { await cmtFinish(tabId, 'тумблер режима выключен', true); return; }
    if (await cmtStopAsked(tabId, st.startedAt)) { await cmtFinish(tabId, 'остановлено с дашборда', true); return; }
    // ∞-круг: сидим в паузе между кругами. До срока — ничего не делаем (окно живёт,
    // hb бьёт heartbeat). По истечении — пробуем новый круг (cmtRotate с пустым tried).
    if (st.phase === 'circle-wait') {
      if (Date.now() >= (Number(st.waitUntil) || 0)) await cmtRotate(tabId, st, cfg, 'новый круг');
      return;
    }
    const t0 = Date.now();
    const code = cmtReelCode();
    let res;
    try {
      res = code ? await cmtReelStep(tabId, st, cfg) : await cmtGridStep(tabId, st, cfg);
    } catch (e) {
      res = { finish: 'сбой шага: ' + String((e && e.message) || e) };
    }
    if (res && res.finish) { await cmtFinish(tabId, res.finish, true); return; }
    if (res && res.rotate) { await cmtRotate(tabId, st, cfg, res.rotate); return; }
    if (res && res.navTo) { try { location.href = res.navTo; } catch (_) { await cmtFinish(tabId, 'не смогли перейти по ссылке', false); } return; }
    // skip (видео не прошло фильтры), nav (сели на уже прочеканный/чужую страницу —
    // например, вотчдог перезагрузил вкладку ровно на том же рилсе) или чистое
    // прочтение — действие одно и то же: к следующей мишени, нет её — финиш.
    // Раньше nav молча возвращался, и окно вставало насмерть на уже прочеканном
    // рилсе: hb бился, дашборд считал окно живым, а цикл не делал ни шага.
    st = await cmtMirrorGet(tabId);
    const targets = (st && st.targets) || [];
    const done = (st && st.done) || [];
    const next = targets.find((c) => !done.includes(c));
    if (!next) {
      // Все мишени этого донора прочитаны — ∞ перескок на следующего, окно не гасим.
      await cmtRotate(tabId, st, cfg, (res && res.skip)
        ? 'мишени кончились — под пороги ничего не попало'
        : 'проход по @' + ((st && st.donor) || '') + ' закончен: ' + ((st && st.checked) || 0) + ' видео, ' + ((st && st.leads) || 0) + ' лидов');
      return;
    }
    if (Date.now() - t0 < 1500) await igxSleep(2500); // анти-пулемёт: слишком быстрые переходы ИГ читает как бота
    location.href = 'https://www.instagram.com/' + ((st && st.donor) || '') + '/reel/' + next + '/';
  }

  // Сердце коммент-окна: hb раз в 5 с — дашборд отличает живое окно от уснувшего.
  function cmtHeartbeat(tabId) {
    const iv = setInterval(async () => {
      try {
        const st = await cmtMirrorGet(tabId);
        if (!st || st.sid !== cmtSid()) { clearInterval(iv); try { await cmtMirrorRemove(tabId); } catch (_) {} return; }
        if (!st.on && !st.stopping) { clearInterval(iv); return; }
        // ∞-круг: пауза между кругами истекла — будим цикл, он подберёт донора.
        if (st.on && st.phase === 'circle-wait' && Date.now() >= (Number(st.waitUntil) || 0)) { await cmtRun(tabId); return; }
        await cmtMirrorPatch(tabId, {});
      } catch (_) { clearInterval(iv); }
    }, 5000);
  }

  // ── ПУСК ОКНА: claim очереди автозапуска + возобновление своего прогона ──────
  // ПРЕЖНЯЯ версия была ОДНОРАЗОВОЙ и МОЛЧЛИВОЙ (то, из-за чего человек видел
  // «тупо 0 всегда»): IIFE исполнялся ровно один раз при загрузке вкладки, и два
  // обстоятельства убивали прогон БЕЗ единой строки в ошибках:
  //  1) getTabId() звал service worker с таймаутом 1500 мс. Холодный MV3-воркер
  //     просыпается дольше, ответ не приходит, tabId = null → «return» → окно
  //     стоит пустое, а дашборд рапортовал «окно комментов открыто».
  //  2) запись очереди ловилась ТОЛЬКО на этом единственном заходе. Если ИГ в
  //     момент открытия крутил редирект/логин (owner пуст), запись протухала
  //     через 3 мин и никто её больше не перечитывал.
  // Теперь: номер вкладки добиваемся четырьмя попытками, очередь перепроверяем на
  // каждый её change и на тике, пока запись свежая, а отказ — это строка ошибки
  // (лампочка «⚠» на кругу реактора), а не молчание.
  async function cmtMyTabId() {
    for (let i = 0; i < 4; i++) {
      let id = null;
      try { id = await getTabId(); } catch (_) {}
      if (id != null) return id; // getTabId кэширует УСПЕХ — повтор дешёвый
      try { await igxSleep(900 * (i + 1)); } catch (_) { return null; }
    }
    return null;
  }
  // Пытаемся забрать СВОЮ запись автозапуска. Возвращает true, если прогон стартовал.
  // Только с реальным владельцем URL: на /p/<код>/ owner пуст, а сравнение ниже
  // делало бы сравнение по пустой строке — запись с пустым username забралась бы и
  // в dispatched легла бы левая метка '' (после пуска resume-ветки на /p/).
  async function cmtClaim(tabId) {
    const owner = cmtOwner();
    if (!owner) return false;
    let q = [];
    try { q = ((await chrome.storage.local.get(CMT_AUTOSTART_KEY)) || {})[CMT_AUTOSTART_KEY] || []; } catch (_) {}
    if (!Array.isArray(q) || !q.length) return false;
    const i = q.findIndex((e) => e && String(e.username || '').toLowerCase() === owner.toLowerCase() && Date.now() - Number(e.ts || 0) < CMT_AUTOSTART_FRESH_MS);
    if (i < 0) return false;
    const now = Date.now();
    q.splice(i, 1);
    const dp = ((await chrome.storage.local.get(CMT_DISPATCHED_KEY)) || {})[CMT_DISPATCHED_KEY] || {};
    dp[owner.toLowerCase()] = now;
    await chrome.storage.local.set({ [CMT_AUTOSTART_KEY]: q, [CMT_DISPATCHED_KEY]: dp });
    await cmtMirrorPatch(tabId, {
      sid: cmtSid(), on: true, startedAt: now, donor: owner,
      targets: [], done: [], seenU: [], checked: 0, leads: 0, read: 0, tried: [], phase: 'boot', ver: 'v5', prog: now,
    });
    await cmtSummary({ lastDonor: owner, phase: 'boot', startedAt: now });
    cmtHeartbeat(tabId);
    await igxSleep(1500);
    await cmtRun(tabId);
    return true;
  }
  // Возобновление своего прогона после навигации/перезагрузки.
  async function cmtResume(tabId) {
    const st = await cmtMirrorGet(tabId);
    if (!st || !st.on || st.sid !== cmtSid()) return;
    // Сюда доходят ТОЛЬКО с st.on === true, то есть прогон не останавливали и не
    // финишировали. Поэтому плоский ценз по hb убивал именно спящее окно: ИГ/
    // Memory Saver морозит вкладку на минуты, вотчдог будит её раз в 15 мин,
    // а зеркало уже удалено — мишени, сид и счётчики потеряны (баг ревью 38,
    // ровно то, что в этой же сборке починили для ∞-прогонов АФК).
    const age = st.hb ? Date.now() - Number(st.hb) : 0;
    const tooOld = st.startedAt && Date.now() - Number(st.startedAt) > CMT_RESUME_MAX_RUN_MS;
    const fresh = age < CMT_RESUME_FRESH_MS || !tooOld;
    if (!fresh) { await cmtMirrorRemove(tabId); return; } // сутки кряду и молчит — осиротевший хвост
    if (await cmtStopAsked(tabId, st.startedAt)) { await cmtFinish(tabId, 'остановлено с дашборда', true); return; }
    cmtHeartbeat(tabId);
    await igxSleep(1200);
    await cmtRun(tabId);
  }
  // «Дашборд писал очередь» — метка из storage.onChanged. Без неё тик cmtClaimTick
  // читал бы storage каждые 4 с на КАЖДОЙ вкладке ИГ ради события, которого нет.
  let cmtQueueSeenAt = 0;
  let cmtRunLive = false; // этот сид уже крутит прогон (claim/resume не плодим дубли)
  async function cmtClaimTick() {
    try {
      if (!cmtQueueSeenAt || Date.now() - cmtQueueSeenAt > CMT_AUTOSTART_FRESH_MS) return;
      if (cmtRunLive) return;
      const tabId = await cmtMyTabId();
      if (tabId == null) return;
      if (await cmtClaim(tabId)) { cmtRunLive = true; cmtQueueSeenAt = 0; return; }
      const st = await cmtMirrorGet(tabId);
      if (st && st.on && st.sid === cmtSid()) { cmtRunLive = true; cmtQueueSeenAt = 0; }
    } catch (_) {}
  }

  (async () => {
    try { if (await isQuickCheckTab()) return; } catch (_) {}
    const tabId = await cmtMyTabId();
    // Пуск разрешён и без владельца URL: на вечной ссылке поста (/p/<код>/,
    // /reel/<код>/) owner пуст, а resume-ветка привязана по tabId+sid. Без этого
    // окно, которое ИГ перекинул на /p/, навечно залипало с on:true: его нельзя
    // было ни возобновить, ни остановить — читатель стоп-команды живёт только
    // внутри цикла, который не стартовал (баг ревью сборки 38).
    if (tabId == null) {
      // Молчание здесь = «окно открылось и ничего не делает» (жалоба «тупо 0»). Пишем ошибку.
      await cmtErr('вкладка ИГ не смогла узнать свой номер у фоновых скриптов (4 попытки) — коммент-окно НЕ запущено. Перезагрузи расширение (chrome://extensions ⟳) и окно.');
      return;
    }
    if (await cmtClaim(tabId)) { cmtRunLive = true; return; }
    if (!cmtOwner() && !cmtReelCode()) return; // мы не на доноре и не на посте — нечего возобновлять
    await cmtResume(tabId);
  })();

  // Очередь с дашборда + смена URL: перепроверяем claim. Полный перезаход на
  // донора (SPA-редирект с логина) больше не стоит смерти прогона.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[CMT_AUTOSTART_KEY]) return;
      const nv = changes[CMT_AUTOSTART_KEY].newValue;
      if (Array.isArray(nv) && nv.length) cmtQueueSeenAt = Date.now();
      cmtClaimTick();
    });
  } catch (_) {}
  setInterval(() => { cmtClaimTick(); }, 4000);

  // ---------- экспорт найденных Telegram-лидов в CSV ----------
  async function exportLeadsCSV() {
    const all = await chrome.storage.local.get(null);
    const rows = [['username', 'fullName', 'followers', 'following', 'posts', 'telegram', 'bio', 'checkedAt']];
    for (const k of Object.keys(all)) {
      if (k.startsWith('igx_profile:')) {
        const p = all[k];
        if (p && p.telegram) {
          rows.push([p.username, p.fullName || '', p.followers ?? '', p.following ?? '', p.posts ?? '', p.telegram ?? '', p.bio ?? '', new Date(p.checkedAt).toISOString()]);
        }
      }
    }
    if (rows.length <= 1) {
      alert('В базе пока нет профилей с Telegram для экспорта.');
      return;
    }
    function csvEscape(v) {
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    }
    const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ig_tg_leads_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------- боковая панель фильтров (сбоку от модалки) ----------
  let filterState = {
    minFollowers: 0,
    maxFollowers: 0,
    showTg: true,
    showNoTg: true,
    showUnchecked: true,
    showVisited: true,
  };

  // Мин. подписчики хранится в storage: значение живёт между вкладками/сессиями,
  // видно фоновым вкладкам автопроверки и самому боту (он тоже режет тех, кто ниже).
  // Пока сам не поменяешь — будет стоять то, что выставил.
  chrome.storage.local.get(['igx_min_followers', 'igx_max_followers'], (d) => {
    filterState.minFollowers = parseInt(d.igx_min_followers, 10) || 0;
    filterState.maxFollowers = parseInt(d.igx_max_followers, 10) || 0;
  });

  let sidePanelEl = null;

  // Пользовательская позиция панели (перетаскивание). Храним, чтобы не сбрасывалась.
  let panelCustomPos = null;
  chrome.storage.local.get('igx_panel_pos', (d) => {
    if (d && d.igx_panel_pos) panelCustomPos = d.igx_panel_pos;
  });

  // Перетаскивание панели за шапку. Позиция сохраняется в storage.
  function initPanelDrag() {
    const head = sidePanelEl.querySelector('.igx-side-head');
    if (!head || head.dataset.igxDragInit) return;
    head.dataset.igxDragInit = '1';
    head.classList.add('igx-draggable');

    const resetBtn = sidePanelEl.querySelector('.igx-pos-reset');
    if (resetBtn) {
      resetBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      resetBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        panelCustomPos = null;
        safeStorageRemove('igx_panel_pos');
      });
    }

    let dragging = null;
    head.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const r = sidePanelEl.getBoundingClientRect();
      dragging = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      sidePanelEl.classList.add('is-dragging');
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging || !sidePanelEl) return;
      const x = Math.min(Math.max(0, e.clientX - dragging.dx), Math.max(0, window.innerWidth - 120));
      const y = Math.min(Math.max(0, e.clientY - dragging.dy), Math.max(0, window.innerHeight - 50));
      sidePanelEl.style.left = `${Math.round(x)}px`;
      sidePanelEl.style.top = `${Math.round(y)}px`;
      sidePanelEl.style.right = 'auto';
      panelCustomPos = { x: Math.round(x), y: Math.round(y) };
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = null;
      if (sidePanelEl) sidePanelEl.classList.remove('is-dragging');
      if (panelCustomPos) safeStorageSet({ igx_panel_pos: panelCustomPos });
    });
  }

  function syncSidePanel() {
    const dialog = document.querySelector('[role="dialog"]');
    // Instagram отдаёт подписчиков/подписки и модалкой, и ПОЛНОЙ СТРАНИЦЕЙ. Раньше
    // панель жила только при [role="dialog"]: на странице она пряталась, и кнопка
    // «⚡ Автопроверка списка» была физически недосяцаема.
    const pageList = !dialog && afkIsFollowersPage();
    document.querySelectorAll('.igx-filterbar').forEach((b) => b.remove());

    if (!dialog && !pageList) {
      if (sidePanelEl) sidePanelEl.style.display = 'none';
      return;
    }

    if (!sidePanelEl) {
      sidePanelEl = document.createElement('div');
      sidePanelEl.className = 'igx-side-panel';
      sidePanelEl.innerHTML = `
        <div class="igx-side-head">
          <div class="igx-side-title">⚡ IG Lead Scout</div>
          <span class="igx-side-badge">Active</span>
          <button type="button" class="igx-pos-reset" title="Сбросить позицию панели (вернётся к модалке)">⟲</button>
        </div>

        <div class="igx-side-section">
          <button type="button" class="igx-btn-autocheck">⚡ Автопроверка списка</button>
          <div class="igx-afk-row">
            <label class="igx-afk-chk" title="АФК-режим: запускается кнопкой «⚡ Автопроверка списка». Сам листает подписчиков до конца, чекает всех, затем переходит к самому популярному челу в его подписчиков, вводит слово из поля в поиск — и так по кругу">
              <input type="checkbox" class="igx-chk-afk" />
              АФК
            </label>
            <input type="text" class="igx-afk-word" placeholder="слово для поиска" />
          </div>
          <label class="igx-autoopen-chk" title="При проверке эксперта автоматически открывать найденную ссылку ТГ в приложении Телеграм. Выключи, если не хочешь чтобы оно само открывало">
            <input type="checkbox" class="igx-chk-autoopen" checked />
            Автооткрывать ТГ при проверке
          </label>
          <button type="button" class="igx-btn-ocr" title="Извлечь хук и призыв из видео (секунды) или карусели со слайдами (слайды) и скопировать в буфер">📝 Хук и призыв (видео / слайды)</button>
          <button type="button" class="igx-btn-copy-meta" title="Скопировать данные ролика: дни публикации, просмотры, лайки, комментарии, репосты и описание">📋 Скопировать данные видео</button>
        </div>

        <div class="igx-side-section">
          <div class="igx-side-label">Фильтры отображения</div>
          <div class="igx-side-chips">
            <label class="igx-filter-chip chip-tg">
              <input type="checkbox" class="igx-chk-tg" ${filterState.showTg ? 'checked' : ''} />
              🟩 ✅ С Telegram (зелёные)
            </label>
            <label class="igx-filter-chip chip-no-tg">
              <input type="checkbox" class="igx-chk-no-tg" ${filterState.showNoTg ? 'checked' : ''} />
              🟦 ❌ Без TG / Не подошли (синие)
            </label>
            <label class="igx-filter-chip chip-un">
              <input type="checkbox" class="igx-chk-un" ${filterState.showUnchecked ? 'checked' : ''} />
              ⬜ ⚡ Не проверенные (новые)
            </label>
            <label class="igx-filter-chip chip-vis">
              <input type="checkbox" class="igx-chk-vis" ${filterState.showVisited ? 'checked' : ''} />
              👁️ Посещённые
            </label>
          </div>
        </div>

        <div class="igx-side-section">
          <div class="igx-side-input-row">
            <span>Мин. подписчиков:</span>
            <input type="number" min="0" placeholder="0" class="igx-min-followers" value="${filterState.minFollowers || ''}" />
          </div>
          <div class="igx-side-input-row">
            <span>Макс. подписчиков:</span>
            <input type="number" min="0" placeholder="0" class="igx-max-followers" value="${filterState.maxFollowers || ''}" />
          </div>
        </div>

        <div class="igx-side-stats">
          <div>Показано: <b class="igx-st-vis">0</b> из <b class="igx-st-total">0</b></div>
          <div>🟩 Подходящих (TG): <b class="igx-st-tg">0</b></div>
          <div>🟦 Проверенных / Без TG: <b class="igx-st-notg">0</b></div>
          <div>⬜ Новых: <b class="igx-st-un">0</b></div>
        </div>

        <div class="igx-side-buttons">
          <button type="button" class="igx-btn-csv">📥 Скачать CSV</button>
          <button type="button" class="igx-btn-reset">Сбросить</button>
        </div>
      `;

      document.body.appendChild(sidePanelEl);

      // События
      sidePanelEl.querySelector('.igx-chk-tg').addEventListener('change', (e) => {
        filterState.showTg = e.target.checked;
        debouncedApplyFilters();
      });
      sidePanelEl.querySelector('.igx-chk-no-tg').addEventListener('change', (e) => {
        filterState.showNoTg = e.target.checked;
        debouncedApplyFilters();
      });
      sidePanelEl.querySelector('.igx-chk-un').addEventListener('change', (e) => {
        filterState.showUnchecked = e.target.checked;
        debouncedApplyFilters();
      });
      sidePanelEl.querySelector('.igx-chk-vis').addEventListener('change', (e) => {
        filterState.showVisited = e.target.checked;
        debouncedApplyFilters();
      });
      sidePanelEl.querySelector('.igx-min-followers').addEventListener('input', (e) => {
        filterState.minFollowers = parseInt(e.target.value, 10) || 0;
        // Сохраняем навсегда: пока сам не поменяешь — порог будет стоять.
        safeStorageSet({ igx_min_followers: filterState.minFollowers });
        debouncedApplyFilters();
      });
      sidePanelEl.querySelector('.igx-max-followers').addEventListener('input', (e) => {
        filterState.maxFollowers = parseInt(e.target.value, 10) || 0;
        // Верх порога тоже живёт в storage — виден фоновым вкладкам и другим окнам.
        safeStorageSet({ igx_max_followers: filterState.maxFollowers });
        debouncedApplyFilters();
      });
      sidePanelEl.querySelector('.igx-btn-autocheck').addEventListener('click', async () => {
        const chk = sidePanelEl.querySelector('.igx-chk-afk');
        const afkOn = chk && chk.checked;
        if (afkOn) {
          if (afkLoopActive || (await afkRunning())) {
            await afkStop('остановлено вручную.');
          } else {
            try {
              await startAfk();
            } catch (err) {
              showTooltip(`АФК: ${(err && err.message) || err}`, sidePanelEl);
              setTimeout(hideTooltip, 6000);
            }
          }
          return;
        }
        startBatchCheck();
      });

      // АФК: слово сохраняется в состояние; снять галочку во время работы = стоп.
      const afkWord = sidePanelEl.querySelector('.igx-afk-word');
      const afkChk = sidePanelEl.querySelector('.igx-chk-afk');
      afkGetState().then((st) => {
        if (st && st.word && afkWord) {
          afkWord.value = st.word;
        } else if (afkWord && !afkWord.value) {
          chrome.storage.local.get(AFK_LAST_WORD_KEY, (d) => {
            if (d && d[AFK_LAST_WORD_KEY] && afkWord && !afkWord.value) {
              afkWord.value = d[AFK_LAST_WORD_KEY];
            }
          });
        }
        if (st && st.on) {
          if (afkChk) afkChk.checked = true;
          afkSetBtn(true);
        }
      });
      afkWord.addEventListener('input', async (e) => {
        await applyAfkSearchWord(e.target.value);
      });
      afkChk.addEventListener('change', async (e) => {
        if (!e.target.checked && (await afkRunning())) await afkStop('остановлено галочкой.');
      });

      // Автооткрытие ТГ при проверке (по умолчанию включено).
      const autoChk = sidePanelEl.querySelector('.igx-chk-autoopen');
      // Guard: после перезагрузки расширения chrome.* кидает «Extension context
      // invalidated» синхронно — не роняем инициализацию панели из-за одного чтения.
      try {
        if (autoChk && chrome.runtime && chrome.runtime.id) {
          chrome.storage.local.get('igx_auto_open_tg', (d) => {
            if (chrome.runtime && chrome.runtime.id && autoChk) autoChk.checked = !(d && d.igx_auto_open_tg === false);
          });
        }
      } catch (_) {}
      if (autoChk) autoChk.addEventListener('change', (e) => {
        safeStorageSet({ igx_auto_open_tg: e.target.checked });
      });
      sidePanelEl.querySelector('.igx-btn-csv').addEventListener('click', () => {
        exportLeadsCSV();
      });
      sidePanelEl.querySelector('.igx-btn-ocr').addEventListener('click', () => {
        openOcrPopup(sidePanelEl);
      });
      const copyMetaBtn = sidePanelEl.querySelector('.igx-btn-copy-meta');
      if (copyMetaBtn) {
        copyMetaBtn.addEventListener('click', async () => {
          const media = detectCurrentPostMedia();
          const scope = (media && media.scope) || findPostArticle() || document;
          const postMeta = extractInstagramPostData(scope);
          const metaStr = formatPostDataText(postMeta);
          // Пустой результат (нет ни одного поля) буфером обмена не затираем.
          if (!metaStr) {
            copyMetaBtn.textContent = '∅';
            setTimeout(() => {
              copyMetaBtn.textContent = '📋 Скопировать данные видео';
            }, 2000);
            return;
          }
          const ok = await copyToClipboard(metaStr);
          if (ok) {
            copyMetaBtn.textContent = '✓ Данные скопированы!';
            setTimeout(() => {
              copyMetaBtn.textContent = '📋 Скопировать данные видео';
            }, 2000);
          } else {
            showTooltip('Не удалось скопировать данные ролика', sidePanelEl);
          }
        });
      }
      sidePanelEl.querySelector('.igx-btn-reset').addEventListener('click', () => {
        filterState.showTg = true;
        filterState.showNoTg = true;
        filterState.showUnchecked = true;
        filterState.showVisited = true;
        filterState.minFollowers = 0;
        filterState.maxFollowers = 0;
        safeStorageSet({ igx_min_followers: 0, igx_max_followers: 0 });
        sidePanelEl.querySelector('.igx-chk-tg').checked = true;
        sidePanelEl.querySelector('.igx-chk-no-tg').checked = true;
        sidePanelEl.querySelector('.igx-chk-un').checked = true;
        sidePanelEl.querySelector('.igx-chk-vis').checked = true;
        sidePanelEl.querySelector('.igx-min-followers').value = '';
        const maxInpR = sidePanelEl.querySelector('.igx-max-followers');
        if (maxInpR) maxInpR.value = '';
        const afkMaxR = igxAfkPop && igxAfkPop.querySelector('.igx-afk-maxf');
        if (afkMaxR) afkMaxR.value = '';
        const afkMinR = igxAfkPop && igxAfkPop.querySelector('.igx-afk-minf');
        if (afkMinR) afkMinR.value = '';
        debouncedApplyFilters();
      });

      initPanelDrag();
    }

    // Позиционирование: если панель перетащили — держим её там, где поставили.
    if (panelCustomPos) {
      const x = Math.min(panelCustomPos.x, Math.max(0, window.innerWidth - 140));
      const y = Math.min(panelCustomPos.y, Math.max(0, window.innerHeight - 60));
      sidePanelEl.style.left = `${x}px`;
      sidePanelEl.style.top = `${y}px`;
      sidePanelEl.style.right = 'auto';
      sidePanelEl.style.display = 'flex';
      return;
    }

    // Полностраничный список (модалки нет): прижимаем справа, чтобы панель не осталась
    // display:none — иначе ни кнопки, ни фильтров, ни статистики на такой странице.
    if (!dialog) {
      sidePanelEl.style.top = '80px';
      sidePanelEl.style.right = '16px';
      sidePanelEl.style.left = 'auto';
      sidePanelEl.style.display = 'flex';
      return;
    }

    // Иначе — сбоку от модалки
    const modalBox = dialog.querySelector('div:has(input[placeholder]), [role="dialog"] > div > div') || dialog;
    const rect = modalBox.getBoundingClientRect();
    const panelWidth = 260;

    if (rect.right + panelWidth + 20 < window.innerWidth) {
      sidePanelEl.style.top = `${Math.max(20, Math.min(rect.top, window.innerHeight - 440))}px`;
      sidePanelEl.style.left = `${Math.round(rect.right + 14)}px`;
      sidePanelEl.style.right = 'auto';
    } else if (rect.left - panelWidth - 20 > 0) {
      sidePanelEl.style.top = `${Math.max(20, Math.min(rect.top, window.innerHeight - 440))}px`;
      sidePanelEl.style.left = `${Math.round(rect.left - panelWidth - 14)}px`;
      sidePanelEl.style.right = 'auto';
    } else {
      sidePanelEl.style.top = '80px';
      sidePanelEl.style.right = '16px';
      sidePanelEl.style.left = 'auto';
    }

    sidePanelEl.style.display = 'flex';
  }

  setInterval(syncSidePanel, 500);

  let filterTimeout = null;
  function debouncedApplyFilters() {
    clearTimeout(filterTimeout);
    filterTimeout = setTimeout(applyFilters, 150);
  }

  function applyFilters() {
    const dialog = afkListRoot();
    if (!dialog) return;
    const owner = afkOwnerFromUrl();
    const links = dialog.querySelectorAll('a[href]');
    const seenRows = new Set();

    let countTgNew = 0;
    let countTgViewed = 0;
    let countChecked = 0;
    let countUnchecked = 0;
    let totalVisible = 0;
    let totalCount = 0;

    const minF = filterState.minFollowers || 0;
    const maxF = filterState.maxFollowers || 0;

    for (const link of links) {
      const username = extractUsername(link);
      if (!username) continue;
      // Хозяин списка — не кандидат и не строка статистики: на полностраничном списке
      // его ник живёт в шапке, и скрыть эту шапку фильтром значило бы «пропал сайт».
      if (owner && username.toLowerCase() === owner) continue;
      const row = findUserRow(link);
      if (!row || seenRows.has(row)) continue;
      seenRows.add(row);
      totalCount++;

      const avatarBox = row.querySelector('.igx-badge-wrap')?.parentElement;
      if (avatarBox) {
        refreshRowStatus(username, avatarBox, row);
      }

      // Данные берём из кэша (он поддерживается storage.onChanged), а не из
      // chrome.storage на каждую строку — раньше именно это лагало на списках.
      const p = profileCache.get(username.toLowerCase()) || null;
      const viewed = viewedCache.has(username.toLowerCase());

      const hasTg = !!(p && p.telegram);
      // «Лид с TG» = ссылка ЕСТЬ и ревизия её не похоронила. Мёртвый юз (или канал
      // вместо человека) не имеет права попадать в «новый с ТГ»: иначе счётчик
      // в панели врёт так же, как врал зелёный цвет строки.
      const tgDead = !!(p && (p.tgReal === false || (p.tgReal == null && p.tgExists === false)));
      const hasTgLead = hasTg && !tgDead;
      const meetsFollowers = (minF <= 0 || (p && p.followers != null && p.followers >= minF)) && (maxF <= 0 || !p || p.followers == null || p.followers <= maxF);
      const isNewTg = hasTgLead && meetsFollowers && !viewed;
      const isViewedTg = hasTgLead && meetsFollowers && viewed;
      const isOtherChecked = p && (!hasTgLead || !meetsFollowers);
      const isVisOnly = !p && viewed;
      const isUn = !p && !viewed;

      if (isNewTg) countTgNew++;
      else if (isViewedTg) countTgViewed++;
      else if (isOtherChecked || isVisOnly) countChecked++;
      else countUnchecked++;

      let visible = true;

      // Фильтрация по типам
      if (isNewTg && !filterState.showTg) visible = false;
      if (isViewedTg && !filterState.showTg && !filterState.showVisited) visible = false;
      if (isOtherChecked && !filterState.showNoTg) visible = false;
      if (isVisOnly && !filterState.showVisited) visible = false;
      if (isUn && !filterState.showUnchecked) visible = false;

      // Прячем строку только через visibility, не меняя её высоту/место в списке.
      // Если убрать высоту (display:none / height:0), Instagram решает, что место
      // освободилось, и начинает бесконечно догружать/перерисовывать строки
      // (список "мигает" случайными людьми).
      if (visible) {
        totalVisible++;
        row.style.visibility = '';
        row.style.pointerEvents = '';
      } else {
        row.style.visibility = 'hidden';
        row.style.pointerEvents = 'none';
      }
    }

    // Обновление сводки в боковой панели
    if (sidePanelEl) {
      const stVis = sidePanelEl.querySelector('.igx-st-vis');
      const stTotal = sidePanelEl.querySelector('.igx-st-total');
      const stTg = sidePanelEl.querySelector('.igx-st-tg');
      const stNoTg = sidePanelEl.querySelector('.igx-st-notg');
      const stUn = sidePanelEl.querySelector('.igx-st-un');

      if (stVis) stVis.textContent = totalVisible;
      if (stTotal) stTotal.textContent = totalCount;
      if (stTg) stTg.textContent = `${countTgNew} нов. (${countTgViewed} просм.)`;
      if (stNoTg) stNoTg.textContent = countChecked;
      if (stUn) stUn.textContent = countUnchecked;
    }
  }
})();
