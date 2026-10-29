// tg-web.js — content-скрипт для web.telegram.org (режим проверки «ТГ»).
// Background управляет этой вкладкой: открывает чат по ссылке, скроллит вверх,
// собирает текст сообщений и описания и ищет там юзы/ссылки на личку.

(function () {
  const RESERVED = new Set([
    'telegram', 'bot', 'username', 'stickers', 'addstickers', 'addemoji',
    'addtheme', 'settheme', 'share', 'proxy', 'socks', 'boost', 'm', 's',
    'invoice', 'game', 'confirmphone', 'login', 'iv', 'bg',
  ]);

  let state = {
    busy: false,
    done: false,
    error: null,
    progress: '',
    title: '',
    postsRead: 0,
    users: new Set(),
    invites: new Set(),
    instagram: new Set(),
  };

  function resetState() {
    state = {
      busy: true, done: false, error: null, progress: '', title: '',
      postsRead: 0, users: new Set(), invites: new Set(), instagram: new Set(),
    };
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function isLoggedIn() {
    // Страница входа показывает QR / форму логина
    if (document.querySelector('.auth-page, .auth-form, [class*="qr"]')) return false;
    // Залогиненный WebA имеет контейнер чатов/сайбар
    return !!(
      document.querySelector('.chat-list, .sidebar-tools-button, .btn-menu, #column-left, .chat-info')
    );
  }

  function openChat(target) {
    // WebA/A-роутер читает hash: #@username, #+invite, #id
    const hash = /^(\+|[0-9-])/.test(target) ? `#${target}` : `#@${target.replace(/^@/, '')}`;
    if (location.hash !== hash) {
      location.hash = hash;
      // Подстраховка для роутеров, которые не реагируют на смену hash
      setTimeout(() => {
        if (!document.querySelector('.message, .chat-background')) {
          location.href = `https://web.telegram.org/a/${hash}`;
        }
      }, 4000);
    }
  }

  function extractFromText(text, selfName) {
    if (!text) return;
    const low = (selfName || '').toLowerCase();
    for (const m of text.matchAll(/@([A-Za-z0-9_]{3,32})/g)) {
      const u = m[1].toLowerCase();
      if (RESERVED.has(u) || u === low) continue;
      state.users.add(u);
    }
    for (const m of text.matchAll(/(?:t\.me|telegram\.me)\/\+([A-Za-z0-9_-]{4,64})/g)) {
      state.invites.add('+' + m[1]);
    }
    for (const m of text.matchAll(/instagram\.com\/([A-Za-z0-9._]{1,30})/gi)) {
      state.instagram.add(m[1].toLowerCase());
    }
    for (const m of text.matchAll(/(?:inst|ig|инст|инстаграм)[\s:—–-]+@?([A-Za-z0-9._]{2,30})/gi)) {
      const u = m[1].toLowerCase().replace(/[.,]+$/, '');
      if (u && !RESERVED.has(u)) state.instagram.add(u);
    }
  }

  function collectMessages(maxNew) {
    // WebA: сообщения — div.message, текст в .text-content
    let added = 0;
    const nodes = document.querySelectorAll('.message .text-content, .message .message-text, .message-content .text-content');
    for (const el of nodes) {
      if (el.dataset.igxScanned) continue;
      el.dataset.igxScanned = '1';
      added++;
      state.postsRead++;
      extractFromText(el.textContent, state.title);
      if (maxNew && added >= maxNew) break;
    }
    return added;
  }

  function getScroller() {
    return (
      document.querySelector('.chat-background') ||
      document.querySelector('.messages-container') ||
      document.querySelector('[class*="messages"]')
    );
  }

  async function runScan(target, msgLimit, delayMs) {
    resetState();
    try {      state.progress = 'Открываю чат…';
      openChat(target);

      // Ждём, пока чат откроется и появятся сообщения (или описание пустого чата)
      let opened = false;
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        if (!isLoggedIn()) {
          state.error = 'Сессия web.telegram.org протухла — войди заново.';
          state.done = true;
          return;
        }
        if (document.querySelector('.message') || document.querySelector('.chat-info')) {
          opened = true;
          break;
        }
      }
      if (!opened) {
        state.error = 'Чат не открылся (не существует, или ты не подписан на приватный канал).';
        state.done = true;
        return;
      }

      const titleEl = document.querySelector('.chat-info .title, .chat-info .peer-title, .chat-info h3, .chat-info span');
      state.title = titleEl ? titleEl.textContent.trim().replace(/^@/, '') : String(target).replace(/^[@+]/, '');

      // Описание канала: клик по шапке чата открывает профиль
      try {
        const headerBtn = document.querySelector('.chat-info');
        if (headerBtn) {
          headerBtn.click();
          await sleep(1500);
          const bio = document.querySelector('.ProfileInfo, .profile-info, [class*="bio"], .info-panel, .chat-details');
          if (bio) extractFromText(bio.textContent, state.title);
          const back = document.querySelector('.btn-back, .chat-info-close, [class*="back"]');
          if (back) back.click();
          await sleep(800);
        }
      } catch (_) {}

      // Читаем сообщения в порядке приоритета: описание (выше) -> закрепы -> обычные
      state.progress = 'Читаю закрепы…';
      try {
        const pinned = document.querySelectorAll(
          '.pinned-message .text-content, .pinned-message-text, .message.pinned .text-content, [class*="pinned"] .text-content'
        );
        for (const el of pinned) {
          if (el.dataset.igxScanned) continue;
          el.dataset.igxScanned = '1';
          state.postsRead++;
          extractFromText(el.textContent, state.title);
        }
      } catch (_) {}

      state.progress = 'Читаю сообщения…';
      collectMessages(msgLimit - state.postsRead);

      const scroller = getScroller();
      let idleRounds = 0;
      while (state.postsRead < msgLimit && idleRounds < 6) {
        // Пауза между пачками — чтобы активность выглядела как чтение человеком
        await sleep(Math.max(1500, delayMs) + Math.random() * 1500);
        if (scroller) scroller.scrollTop = 0;
        window.scrollTo(0, 0);
        await sleep(1200);
        const added = collectMessages(msgLimit - state.postsRead);
        state.progress = `Читаю сообщения… (${state.postsRead}/${msgLimit})`;
        if (added === 0) idleRounds++;
        else idleRounds = 0;
      }

      state.done = true;
    } catch (e) {
      state.error = String(e.message || e);
      state.done = true;
    } finally {
      // Сброс флага обязателен: без него вкладка web.telegram.org после ПЕРВОГО скана
      // молча игнорировала все следующие (tgScan отвечал started:true, а tgGetResult
      // отдавал результат прошлого канала) — вкладка переиспользуется до 15 минут.
      state.busy = false;
    }
  }

  // ---------- глобальный поиск (по номеру телефона или @юзернейму) ----------
  // Отдельное состояние: не мешать обычному скану чатов (state/runScan).
  // Возвращаем верхний результат: @handle (если публичный) / id / title.
  let searchState = null;

  function findSearchInput() {
    const direct = document.querySelectorAll(
      '.chat-list-search input, .search-input-input, .input-field-search input, .ContentSearch input, .dialog-search input'
    );
    for (const el of direct) if (el && el.offsetParent !== null) return el;
    const byPlaceholder = Array.from(document.querySelectorAll('input')).filter(
      (i) => /поиск|search/i.test(i.getAttribute('placeholder') || '')
    );
    return byPlaceholder[0] || direct[0] || null;
  }

  function typeIntoSearch(inp, text) {
    try { inp.focus(); } catch (_) {}
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, text);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function searchResultItems() {
    const pick = (sel) => Array.from(document.querySelectorAll(sel))
      .filter((it) => (it.textContent || '').trim().length > 0);
    let items = pick(
      '.chat-list .chat-list-item, .chat-list .ListItem, .search-results .ListItem, .chatlist-chat, .peer-wrapper'
    );
    if (items.length) return items;
    // Запасной путь: Web A рендерит строку результата как элемент с заголовком
    // .peer-title / .main-title внутри подписанного контейнера. Если точные селекторы
    // разъехались после обновления — берём ближайший кликабельный предок строки.
    const heads = document.querySelectorAll('.peer-title, .main-title, [class*="peer-title"], [class*="title"]');
    const seen = new Set();
    for (const h of heads) {
      let row = h;
      for (let d = 0; d < 5 && row.parentElement; d++) {
        row = row.parentElement;
        if (/ListItem|chat-list-item|dialog|peer/i.test(row.className || '') || row.getAttribute('role') === 'option') break;
      }
      const txt = (row.textContent || '').trim();
      if (!txt || txt.length > 300) continue;
      if (seen.has(row)) continue;
      seen.add(row);
      items.push(row);
    }
    return items;
  }

  function extractHandleFromEl(el) {
    const m = (el && el.textContent || '').match(/@([A-Za-z0-9_]{3,32})/);
    return m ? m[1].toLowerCase() : null;
  }

  // Соответствие верхнего результата глобального поиска запросу. web.telegram.org
  // по номеру телефона часто выдаёт НЕ владельца номера, а случайные «глобальные»
  // аккаунты с короткими премиум-юзами (@chat, @LIDERADD, @cachatlot и т.п.) — их
  // нельзя приписывать лиду. Номеру принадлежит только результат, где реально
  // показаны цифры этого номера; @нику — только результат с равным хэндлом/заголовком.
  function normDigits(s) {
    return String(s || '').replace(/\D/g, '');
  }
  function phoneTail(digits) {
    const d = String(digits || '');
    // RU/KZ: 11 цифр на 7/8 → сверяем по последним 10 (терпим +7/8, пробелы, дефисы).
    if (/^[78]\d{10}$/.test(d)) return d.slice(-10);
    return d;
  }
  function resultMatchesQuery(query, texts) {
    const q = String(query || '').trim();
    const qDigits = normDigits(q);
    if (qDigits.length >= 7) {
      const hay = normDigits([texts.row, texts.head].join('\n'));
      const tail = phoneTail(qDigits);
      if (tail.length >= 6 && hay.includes(tail)) return true;
      if (qDigits.length >= 10 && hay.includes(qDigits)) return true;
      return false; // номер нигде не показан → это НЕ владелец номера
    }
    const qHandle = q.replace(/^@/, '').toLowerCase();
    if (!qHandle) return false;
    if (texts.handle && String(texts.handle).toLowerCase() === qHandle) return true;
    if (texts.title && String(texts.title).toLowerCase().replace(/^@/, '') === qHandle) return true;
    return false;
  }

  async function runSearch(query) {
    searchState = { busy: true, done: false, error: null, query, handle: null, id: null, title: '' };
    try {
      if (!isLoggedIn()) {
        searchState.error = 'Сессия web.telegram.org протухла — войди заново.';
        return;
      }
      const inp = findSearchInput();
      if (!inp) {
        searchState.error = 'Не нашёл поле поиска в web.telegram.org.';
        return;
      }
      typeIntoSearch(inp, query);
      let item = null;
      for (let i = 0; i < 16; i++) {
        await sleep(700);
        const items = searchResultItems();
        if (items.length) { item = items[0]; break; }
      }
      if (!item) {
        searchState.error = 'Поиск ничего не нашёл.';
        typeIntoSearch(inp, '');
        return;
      }
      const titleEl = item.querySelector('.peer-title, .main-title, [class*="title"]');
      searchState.title = titleEl ? titleEl.textContent.trim() : '';
      searchState.handle = extractHandleFromEl(item);
      const rowText = (item.textContent || '');
      // Жмём на результат — из открытого профиля/шапки часто достаётся @handle.
      try { item.click(); } catch (_) {}
      await sleep(2500);
      const head = document.querySelector('.chat-info, .peer-info, .top-bar, .column-header');
      const headText = (head || document.body).textContent || '';
      if (!searchState.handle) {
        const hm = headText.match(/@([A-Za-z0-9_]{3,32})/);
        if (hm) searchState.handle = hm[1].toLowerCase();
      }
      if (!searchState.handle) {
        const idm = location.hash.match(/#(?:c|p|dialog)?(-?\d{1,20})/);
        if (idm) searchState.id = idm[1];
      }
      // Обязательная проверка соответствия (см. resultMatchesQuery): иначе items[0]
      // из глобального поиска приписывает лиду чужой премиум-юз.
      searchState.match = resultMatchesQuery(query, {
        row: rowText, head: headText, handle: searchState.handle, title: searchState.title,
      });
      typeIntoSearch(inp, '');
    } catch (e) {
      searchState.error = String(e.message || e);
    } finally {
      searchState.done = true;
      searchState.busy = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'tgPing') {
      sendResponse({ ready: isLoggedIn(), needsLogin: !isLoggedIn() });
      return;
    }
    if (msg.type === 'tgSearch') {
      if (!searchState || !searchState.busy) runSearch(msg.query);
      sendResponse({ started: true });
      return;
    }
    if (msg.type === 'tgSearchResult') {
      sendResponse(searchState ? {
        done: !!searchState.done,
        error: searchState.error,
        handle: searchState.handle,
        id: searchState.id,
        title: searchState.title,
        match: !!searchState.match,
      } : { done: false });
      return;
    }
    if (msg.type === 'tgScan') {
      if (!state.busy) {
        runScan(msg.target, msg.msgLimit || 20, msg.delayMs || 10000);
      }
      sendResponse({ started: true });
      return;
    }
    if (msg.type === 'tgGetResult') {
      sendResponse({
        done: state.done,
        progress: state.progress,
        error: state.error,
        title: state.title,
        postsRead: state.postsRead,
        users: Array.from(state.users),
        invites: Array.from(state.invites),
        instagram: Array.from(state.instagram),
      });
      return;
    }
  });
})();
