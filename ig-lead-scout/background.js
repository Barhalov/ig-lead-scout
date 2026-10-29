// background.js — служебный воркер расширения
// Штамп сборки: воркер живёт отдельно от страниц, поэтому обновляется только вместе
// с расширением (⟳ на chrome://extensions). Смотреть в консоли воркера:
// chrome://extensions → «Inspect views: service worker». Нет строки или номер ниже
// журнала CODE_STRUCTURE.md — значит код не обновился, а не «логика сломалась».
console.log('[IG Lead Scout] background.js build=afk-watchdog-1 loaded'); // 1: вотчдог уснувших прогонов — пнёт перезагрузкой вкладку АФК∞/комментов, которая замолчала, но НЕ трогает бан (экран проверки ИГ — перезагрузка его не снимет, только плодит)

// Разовое автоматическое восстановление старой базы (см. restore_merge.js):
// добавляет только отсутствующие ключи, после первого успеха больше не срабатывает.
try {
  importScripts('laptop-background.js');
} catch (_) {}

// Квалификация лида (пол + «цвет строки») — тот же модуль, что у дашборда: бот в /list
// фильтрует и сортирует базу по этим же признакам, поэтому код обязан быть один.
// Должен быть импортирован ДО tg.js (tg.js вызывает detectGender/accColorOf).
try {
  importScripts('qualify.js');
} catch (_) {}

// Telegram-интеграция (бот, верификация, скан-режимы)
try {
  importScripts('tg.js');
} catch (_) {}

// Фундамент «базы» для будущего подключения телефона. Полностью изолирован и
// по умолчанию выключен (igx_sync_on !== true): пока не включён — ничего не делает,
// только читает базу и пишет в свои ключи. Основной код не затрагивает.
try {
  importScripts('sync.js');
} catch (_) {}

const QC_MAP_KEY = 'igx_quickcheck_tabs'; // {tabId: {username, createdAt}}

async function getQuickCheckMap() {
  const data = await chrome.storage.session.get(QC_MAP_KEY);
  return data[QC_MAP_KEY] || {};
}
async function setQuickCheckMap(map) {
  await chrome.storage.session.set({ [QC_MAP_KEY]: map });
}
let quickMapChain = Promise.resolve();
function updateQuickMap(change) {
  const job = quickMapChain.catch(() => {}).then(async () => {
    const map = await getQuickCheckMap();
    await change(map);
    await setQuickCheckMap(map);
  });
  quickMapChain = job;
  return job;
}

// ---------- пульс автоанализа (держать очередь живой, когда дашборд в фоне) ----------
// Вся помпа очереди и таймауты paaTick крутятся setInterval'OM во вкладке дашборда.
// Когда дашборд перекрывают окна анализа / он уходит в фон, Chrome ЗАМОРАЖИВАЕТ вкладку —
// setInterval встаёт, очередь не идёт, прогон замирает на первом же профиле. Будильник
// воркера (его не заморозить) каждые ~30с шлёт сообщение дашборду: доставка сообщения
// размораживает frozen-вкладку, и paaTick догоняет пропущенное.
const PAA_BEAT_ALARM = 'igx_paa_beat';
async function paaBeatWake() {
  try {
    const url = chrome.runtime.getURL('dashboard.html');
    const tabs = await chrome.tabs.query({ url });
    for (const t of tabs) {
      if (t && typeof t.id === 'number') {
        try { Promise.resolve(chrome.tabs.sendMessage(t.id, { type: 'paaBeat' })).catch(() => {}); } catch (_) {}
      }
    }
  } catch (_) {}
}
try {
  chrome.alarms.onAlarm.addListener((a) => {
    if (a && a.name === PAA_BEAT_ALARM) paaBeatWake();
    if (a && a.name === AFK_WATCH_ALARM) afkWatchTick();
  });
} catch (_) {}

// ---------- вотчдог уснувших прогонов (сборка 38 дашборда) ----------
// Вкладочный watchdog (afkStallWatch в content.js) живёт ВНУТРИ вкладки и умирает
// вместе с ней: если Chrome усыпил/выгрузил вкладку АФК∞ или ИГ свербнул страницу,
// молчать может ВЕЧНО — дашборд пишет «встал сам», а ожить окно само не может.
// Будильник воркера (его не заморозить) раз в минуту смотрит ЗЕРКАЛА прогонов
// (igx_afk_tab_* c infinite&on и igx_cmt_tab_* c on) и пнёт молчавшую дольше 4 минут
// вкладку перезагрузкой: возобновляющая логика content.js уже умеет подхватить
// ∞-прогон и коммент-окно после перезагрузки. БАН — исключение: экран проверки
// Instagram перезагрузка не снимает, а долбить им каждые 15 минут — значит ловить
// новый challenge. Признаки бана: свежий igBlockAt (менее 30 мин) ИЛИ url вкладки на
// challenge/login/activity — такую вкладку не трогаем, только размечаем причину в
// зеркале, чтобы дашборд честно написал «забанена, не перезагружаю».
const AFK_WATCH_ALARM = 'igx_afk_watch';
const AFK_WATCH_SILENT_MS = 4 * 60000;   // молчит дольше четырёх минут — будим
const AFK_WATCH_RELOAD_EVERY_MS = 15 * 60000; // не чаще одной перезагрузки на вкладку за четверть часа
let afkWatchBusy = false; // прошлый тик ещё не дочитал базу
try { chrome.alarms.create(AFK_WATCH_ALARM, { periodInMinutes: 1 }); } catch (_) {}
// onAlarm зовёт тик БЕЗ await. На большой базе чтение всей storage.local + tabs.get
// на каждый ключ не успевается в минуту (и в 30-секундный лайфхак SW), тики
// накладывались на одном и том же протухшем снапшоте, и один и тот же tab.reload
// уходил дважды (баг ревью сборки 38).
async function afkWatchTick() {
  if (afkWatchBusy) return;
  afkWatchBusy = true;
  try { await afkWatchRun(); } catch (_) {} finally { afkWatchBusy = false; }
}
async function afkWatchRun() {
  let all;
  try { all = await chrome.storage.local.get(null); } catch (_) { return; }
  const risk = (all && all.igx_risk_state) || {};
  const banAt = Number(risk.igBlockAt) || 0;
  const banned = banAt && Date.now() - banAt < 30 * 60000;
  const now = Date.now();
  let last = {};
  try { last = ((await chrome.storage.session.get('igx_watch_reload')) || {}).igx_watch_reload || {}; } catch (_) {}
  for (const k of Object.keys(all || {})) {
    const isAfk = k.startsWith('igx_afk_tab_');
    const isCmt = k.startsWith('igx_cmt_tab_');
    if (!isAfk && !isCmt) continue;
    const rawId = k.slice(isAfk ? 'igx_afk_tab_'.length : 'igx_cmt_tab_'.length);
    if (!/^\d+$/.test(rawId)) continue;
    const st = all[k];
    if (!st || typeof st !== 'object' || !st.on || st.stopping) continue;
    if (isAfk && !st.infinite) continue; // обычный (не ∞) прогон — хозяйский: он и сам умеет вставать
    const hbAge = st.hb ? now - Number(st.hb) : now - (Number(st.startedAt) || now);
    if (hbAge < AFK_WATCH_SILENT_MS) continue;
    if (now - (Number(last[k]) || 0) < AFK_WATCH_RELOAD_EVERY_MS) continue;
    let tab;
    try { tab = await chrome.tabs.get(Number(rawId)); } catch (_) {
      // вкладки нет — дашборд сам прунет зеркало; метку перезагрузки убираем,
      // чтобы igx_watch_reload не разрастался мёртвыми tabId
      if (last[k]) { delete last[k]; try { await chrome.storage.session.set({ igx_watch_reload: last }); } catch (_) {} }
      continue;
    }
    if (banned || /challenge|accounts\/(login|activity)|temporarily_disabled|news\/unread/i.test(String(tab.url || ''))) {
      // бан: не будим перезагрузкой, но причину пишем в зеркало — дашборд покажет слово «бан», а не «замерла».
      // Перечитываем КЛЮЧ прямо перед записью и трогам только свои поля: иначе
      // стирался свежий hb/visited/seenU, записанный вкладкой между get(null) и
      // этой записью (read-modify-write на снапшоте whole DB — баг ревью 38).
      try {
        const cur = ((await chrome.storage.local.get(k)) || {})[k] || {};
        await chrome.storage.local.set({ [k]: Object.assign({}, cur, { watchedNote: 'забанена Instagram — вотчдог не перезагружает', watchedAt: now }) });
      } catch (_) {}
      continue;
    }
    try {
      last[k] = now;
      await chrome.storage.session.set({ igx_watch_reload: last });
      await chrome.tabs.reload(Number(rawId), { bypassCache: false });
    } catch (_) {}
  }
}

async function getSettings() {
  const data = await chrome.storage.local.get('igx_settings');
  return Object.assign(
    {
      openMode: 'newtab', // 'newtab' | 'splitscreen' | 'sametab'
      throttleMs: 4000,
    },
    data.igx_settings || {}
  );
}

let splitWindowId = null;

// ---------- очередь снимков вкладки ----------
// chrome.tabs.captureVisibleTab упирается в лимит MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND
// (~2/с). Автоанализ в нескольких окнах снимает кадры видео/слайдов пачкой — квота лопается.
// Все снимки сериализуются через один промис-.chain с паузой между кадрами; при попадании
// в квоту делаем один мягкий ретрей. Очередь глобальная (воркер один) — окна делят лимит.
const CAPTURE_MIN_GAP_MS = 550; // ~1.8/с — с запасом под квоту 2/с
// Предельное время ОДНОЙ съёмки. chrome.tabs.captureVisibleTab на скрытом,
// свёрнутом или «не рисующем» окне может НИКОГДА не вызвать колбэк. Очередь ниже
// строго последовательна и ГЛОБАЛЬНА, поэтому одна такая обрывалась не только
// своя вкладка (её локальный предохранитель в content.js = 12 с), а ВСЕ окна сразу:
// они выстраивались за мёртвым промисом и по 12 с отваливались каждый свой кадр.
// Держим бюджет заведомо меньше локальных 12 с, чтобы ошибка была нашей, честной.
const CAPTURE_DEADLINE_MS = 9000;
// Сколько заявка имеет право ждать своей очереди. Дальше сдаваться: вкладка за
// это время уже уперлась в свой таймер, а отданный «в пустоту» кадр ещё и задержит
// всю очередь позади.
const CAPTURE_MAX_WAIT_MS = 8000;
let captureChain = Promise.resolve();
let captureLastAt = 0;

function captureTabRaw(winId, budgetMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = 0;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const opts = { format: 'jpeg', quality: 85 };
    const cb = (dataUrl) => {
      const err = chrome.runtime.lastError;
      if (err) finish(() => reject(new Error(err.message || 'captureVisibleTab error')));
      else if (!dataUrl) finish(() => reject(new Error('Пустой снимок вкладки.')));
      else finish(() => resolve(dataUrl));
    };
    // Поздний колбэк (Хром всё-таки очнулся после нашего дедлайна) будет проигнорирован:
    // промис уже закрыт, а очередь пошла дальше.
    timer = setTimeout(() => finish(() => reject(new Error(
      'Окно не отдало кадр: вкладка свернута, перекрыта или Instagram не рисует кадр.'
    ))), Math.max(500, Number(budgetMs) || CAPTURE_DEADLINE_MS));
    try {
      if (typeof winId === 'number') chrome.tabs.captureVisibleTab(winId, opts, cb);
      else chrome.tabs.captureVisibleTab(opts, cb);
    } catch (e) {
      finish(() => reject(e));
    }
  });
}

function captureTabQueued(winId) {
  const queuedAt = Date.now();
  const deadlineAt = queuedAt + CAPTURE_DEADLINE_MS;
  const raw = () => captureTabRaw(winId, Math.max(800, deadlineAt - Date.now()));
  const run = () => {
    // Пока заявка ждала очереди, вкладка могла уже сдаться. Отвечать ей кадром
    // «в пустоту» — значит задержать очередь позади; отказываем сразу.
    if (Date.now() - queuedAt > CAPTURE_MAX_WAIT_MS) {
      throw new Error('Снимок не дождён очереди кадров: ждал ' + Math.round((Date.now() - queuedAt) / 1000) + ' с, окно уже устало ждать.');
    }
    // выдерживаем паузу от предыдущего реального снимка
    const wait = Math.max(0, CAPTURE_MIN_GAP_MS - (Date.now() - captureLastAt));
    return new Promise((res) => setTimeout(res, Math.min(wait, Math.max(0, deadlineAt - Date.now()))))
      .then(() => raw())
      .catch((e) => {
        const quota = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(String((e && e.message) || e));
        if (!quota || Date.now() >= deadlineAt) throw e;
        // один мягкий ретрей чуть позже окна квоты — но в рамках того же дедлайна
        return new Promise((res) => setTimeout(res, 1100)).then(() => raw());
      })
      .then((dataUrl) => { captureLastAt = Date.now(); return dataUrl; });
  };
  const result = captureChain.then(run, run);
  // цепочка не должна ронять последующие снимки — глушим её собственное отклонение
  captureChain = result.then(() => {}, () => {});
  return result;
}

// ---------- OCR / распознавание речи (offscreen-документ) ----------
// Контент-скриптам Хром запрещает создавать Worker из файлов расширения,
// поэтому Tesseract и Whisper крутятся в offscreen-странице расширения.
async function ensureOcrDoc() {
  let exists = false;
  try {
    if (chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
      exists = await chrome.offscreen.hasDocument();
    } else if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      exists = contexts && contexts.length > 0;
    }
  } catch (_) {}

  if (!exists) {
    try {
      await chrome.offscreen.createDocument({
        url: 'ocr-offscreen.html',
        reasons: ['WORKERS', 'BLOBS', 'AUDIO_PLAYBACK'],
        justification: 'Распознавание текста и речи с видео Инстаграма',
      });
    } catch (e) {
      if (!String((e && e.message) || e).toLowerCase().includes('single')) throw e;
    }
    // Ожидаем готовности скриптов страницы (handshake)
    for (let i = 0; i < 25; i++) {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'ocrPing' });
        if (r && r.ok) break;
      } catch (_) {}
      await new Promise((res) => setTimeout(res, 100));
    }
  }
  return true;
}

async function offscreenCall(payload) {
  await ensureOcrDoc();
  // Keepalive: не даём Service Worker уснуть во время загрузки нейросети или OCR
  const keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 15000);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await chrome.runtime.sendMessage(payload);
        if (res !== undefined) return res;
      } catch (e) {
        if (attempt === 2) throw e;
      }
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
    return { error: 'Распознавалка не ответила.' };
  } finally {
    clearInterval(keepAlive);
  }
}

// ВНИМАНИЕ: здесь была «разовая чистка» igx_viewed, которая при первом же
// запуске удаляла ВСЕ метки просмотренных профилей (сгорел список из ~900
// чекнутых). Убрана полностью — данные пользователей удаляться не должны.

// Открыть профиль во втором окне рядом (сплит-экран) с повторным использованием окна и вкладки
async function openSplitScreen(url, callerTab) {
  try {
    const displays = await chrome.system.display.getInfo();
    const primary = displays.find((d) => d.isPrimary) || displays[0];
    const wa = primary.workArea;
    const halfW = Math.floor(wa.width / 2);

    // Закрепляем окно с поиском в левой половине экрана
    if (callerTab && callerTab.windowId != null) {
      await chrome.windows.update(callerTab.windowId, {
        left: wa.left,
        top: wa.top,
        width: halfW,
        height: wa.height,
        state: 'normal',
      }).catch(() => {});
    }

    // Если правое окно уже существует — просто заменяем в нём URL текущей вкладки
    if (splitWindowId != null) {
      try {
        const win = await chrome.windows.get(splitWindowId, { populate: true });
        if (win && win.tabs && win.tabs.length > 0) {
          const activeTab = win.tabs.find((t) => t.active) || win.tabs[0];
          await chrome.tabs.update(activeTab.id, { url, active: true });
          return;
        }
      } catch (e) {
        splitWindowId = null;
      }
    }

    // Создаем правое окно
    const win = await chrome.windows.create({
      url,
      left: wa.left + halfW,
      top: wa.top,
      width: wa.width - halfW,
      height: wa.height,
      focused: false,
    });
    splitWindowId = win.id;
  } catch (e) {
    await chrome.tabs.create({ url, active: false });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  // ocr-offscreen.js обрабатывает эти типы — background НЕ должен перехватывать
  if (msg.type === 'ocrPing' || msg.type === 'ocrDo' || msg.type === 'ocrImageUrl' || msg.type === 'ocrVideoDo' || msg.type === 'ocrPrompts' || msg.type === 'asrDo' || msg.type === 'asrDoUrl') return false;

  // Снимок вкладки для видео с CORS-защитой (когда canvas.toDataURL блокируется браузером)
  if (msg.type === 'captureTab') {
    const targetWinId = (sender.tab && typeof sender.tab.windowId === 'number') ? sender.tab.windowId : undefined;
    // Chrome режет captureVisibleTab лимитом MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND
    // (~2/с). Автоанализ в нескольких окнах бьёт по этой квоте пачкой одновременно
    // (кадры видео/слайдов), отсюда «exceeds quota» в логах. Гоним все снимки через
    // одну очередь с паузой и одним мягким ретраем — пик сглаживается, кадры не теряются.
    captureTabQueued(targetWinId).then((dataUrl) => {
      sendResponse({ ok: true, dataUrl });
    }).catch((e) => {
      sendResponse({ ok: false, error: String((e && e.message) || e) || 'Не удалось сделать снимок вкладки.' });
    });
    return true;
  }

  // Telegram-блок (tg.js): настройки, верификация, проверки, бот.
  // ВАЖНО: не возвращаем Promise из слушателя — в MV3 возвращённый Promise
  // воспринимается как сам ответ (отправитель мгновенно получал бы `true`
  // вместо результата проверки). Ответ уходит через sendResponse.
  if (typeof handleTgMessage === 'function' && /^tg[A-Z]/.test(msg.type)) {
    handleTgMessage(msg, sendResponse);
    return true;
  }

  // Проверка, является ли вкладка фоновой вкладкой автопроверки —
  // content script запрашивает это, чтобы не помечать профиль «просмотренным».
  if (msg.type === 'getTabId') {
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
    return true;
  }

  // «🛡 анти-залипание видео»: Instagram не даёт рилсу стартовать, пока его окно
  // не в фокусе. Поднимаем окно с контент-скриптом наверх и делаем вкладку активной.
  // Только своё окно отправителя — чужие не трогаем. Никаких окон не создаём.
  if (msg.type === 'bringToFront') {
    const t = sender.tab;
    if (t && typeof t.id === 'number' && typeof t.windowId === 'number') {
      Promise.resolve()
        .then(() => chrome.windows.update(t.windowId, { focused: true }))
        .then(() => chrome.tabs.update(t.id, { active: true }))
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    } else {
      sendResponse({ ok: false, error: 'no sender tab' });
    }
    return true;
  }

  // Держать пульс очереди автоанализа: старт прогона заводит будильник, финиш/стоп снимает.
  if (msg.type === 'paaAlarmStart') {
    try { chrome.alarms.create(PAA_BEAT_ALARM, { periodInMinutes: 0.5 }); } catch (_) {}
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'paaAlarmStop') {
    try { chrome.alarms.clear(PAA_BEAT_ALARM); } catch (_) {}
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'isQuickCheck') {
    getQuickCheckMap().then((map) => {
      sendResponse({ isQuickCheck: !!(sender.tab && map[sender.tab.id]) });
    });
    return true;
  }

  // Распознавание текста (OCR) и речи (ASR) с видео/слайдов — в offscreen-документе.
  if (
    msg.type === 'ocrRecognize' ||
    msg.type === 'ocrRecognizeUrl' ||
    msg.type === 'ocrVideoDirect' ||
    msg.type === 'ocrGetPrompts' ||
    msg.type === 'ocrLocalTest' ||
    msg.type === 'ocrLocalWarm' ||
    msg.type === 'asrRecognize' ||
    msg.type === 'asrRecognizeUrl'
  ) {
    let payload;
    // vision: true — просить у нейронки не только текст, но и описание того, что
    // изображено (режим «👁 вижу картинку»). Передается честным флагом: оффскрин сам
    // решает, применим ли он (нужен облачный ключ Groq/OpenAI).
    // prompt — свой промпт распознавания, если пользователь отредактировал его в
    // попапе; пустая строка означает «взять встроенный промпт режима».
    if (msg.type === 'ocrRecognize') payload = { type: 'ocrDo', image: msg.image, apiKey: msg.apiKey, vision: !!msg.vision, prompt: msg.prompt || '' };
    else if (msg.type === 'ocrRecognizeUrl') payload = { type: 'ocrImageUrl', url: msg.url, apiKey: msg.apiKey, vision: !!msg.vision, prompt: msg.prompt || '' };
    else if (msg.type === 'ocrVideoDirect')
      payload = {
        type: 'ocrVideoDo',
        url: msg.url,
        headTimestamps: msg.headTimestamps,
        tailTimestamps: msg.tailTimestamps,
        apiKey: msg.apiKey,
        vision: !!msg.vision,
        prompt: msg.prompt || '',
      };
    // Проверка связи с LM Studio и прогрев модели: настроек не касаются, оффскрин
    // сам читает их из chrome.storage.local — тут только передаём «какую команду дать».
    else if (msg.type === 'ocrLocalTest' || msg.type === 'ocrLocalWarm') payload = { type: msg.type };
    else if (msg.type === 'ocrGetPrompts') payload = { type: 'ocrPrompts' };
    else if (msg.type === 'asrRecognize') payload = { type: 'asrDo', audio: msg.audio, apiKey: msg.apiKey };
    else
      payload = {
        type: 'asrDoUrl',
        url: msg.url,
        headTo: msg.headTo,
        tailFrom: msg.tailFrom,
        tailTo: msg.tailTo,
        apiKey: msg.apiKey,
      };

    // Подстраховка на случай сожжённого контекста: пересылаем дальше снимок настроек
    // локального движка со страницы. Оффскрин возьмёт его только если сам до storage
    // не достанет, — владельцем настроек он быть не перестаёт.
    if (msg.cfg && typeof msg.cfg === 'object') payload.cfg = msg.cfg;

    offscreenCall(payload)
      .then((r) => sendResponse(r || { ok: false, error: 'Распознавалка не ответила.' }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  const bgTypes = new Set(['getSettings', 'openProfile', 'quickCheck', 'checkDone', 'newTab', 'laptopDonorClaim', 'laptopCheckContext', 'laptopCheckStage', 'laptopQuickResult']);
  if (!bgTypes.has(msg.type)) return false;

  (async () => {
    try {
      if (msg.type === 'laptopDonorClaim') {
        sendResponse(await laptopRequest('/donor', {username:msg.username, kind:msg.kind, worker:await laptopWorker()}));
        return;
      }
      if (msg.type === 'laptopCheckContext') {
        const map = await getQuickCheckMap();
        sendResponse({token:map[sender.tab?.id]?.token, worker:await laptopWorker()});
        return;
      }
      if (msg.type === 'getSettings') {
        // Normal UI settings handler follows.
        sendResponse(await getSettings());
        return;
      }

      // НОВАЯ фоновая вкладка независимо от openMode (для кнопки «АФК-вкладка» в попапе):
      if (msg.type === 'laptopCheckStage') {
        const info = (await getQuickCheckMap())[sender.tab?.id];
        if (info) await laptopEvent(msg.stage, {username:info.username,tabId:sender.tab.id});
        sendResponse({ok:!!info}); return;
      }
      if (msg.type === 'laptopQuickResult') {
        const info = (await getQuickCheckMap())[sender.tab?.id];
        if (!info || info.username.toLowerCase() !== msg.record?.username?.toLowerCase()) {
          sendResponse({ok:false}); return;
        }
        const record = {...msg.record, laptopClaimToken:info.token, laptopWorker:await laptopWorker(), laptopHistorical:false};
        await chrome.storage.local.set({['igx_profile:'+info.username.toLowerCase()]:record});
        await laptopEvent('profile_extracted', {username:info.username,tabId:sender.tab.id});
        sendResponse({ok:true}); return;
      }
      // сколько раз нажали — столько вкладок открылось, каждая крутит свой АФК.
      if (msg.type === 'newTab') {
        await chrome.tabs.create({ url: msg.url, active: false });
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'openProfile') {
        const settings = await getSettings();
        if (settings.openMode === 'splitscreen') {
          await openSplitScreen(msg.url, sender.tab);
        } else {
          await chrome.tabs.create({ url: msg.url, active: settings.openMode === 'sametab' });
        }
        sendResponse({ ok: true });
        return;
      }

      // "Быстрая проверка": реальная вкладка в фоне, не активная, автозакрытие после извлечения данных
      if (msg.type === 'quickCheck') {
        // Worker timers can be lost when Edge suspends a service worker.
        // Reclaim stale slots here as well, so the producer cannot wait forever.
        await updateQuickMap(async map => {
          for (const [id, info] of Object.entries(map)) {
            let exists = true;
            try {await chrome.tabs.get(Number(id));} catch (_) {exists=false;}
            if (!exists || Date.now() - info.createdAt > 35000) {
              delete map[id];
              if (exists) chrome.tabs.remove(Number(id)).catch(() => {});
              laptopEvent('stale_check_slot', {username:info.username,tabId:Number(id)}).catch(() => {});
            }
          }
        });
        if (Object.keys(await getQuickCheckMap()).length >= 1) {
          sendResponse({ok:true, wait:true}); return;
        }
        // The loopback server serializes claims across all four independent profiles.
        // On coordinator failure do not open duplicate work; the caller can retry.
        const claim = await laptopRequest('/claim', {username: msg.username, worker:await laptopWorker()});
        if (!claim.claimed) {
          if (claim.record) {
            const shared = {...claim.record, laptopHistorical: true};
            await chrome.storage.local.set({['igx_profile:' + msg.username.toLowerCase()]: shared});
          }
          sendResponse({ok: true, skipped: true, reason: claim.reason});
          return;
        }
        const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
        await updateQuickMap(async map => {
          map[tab.id] = {username:msg.username, createdAt:Date.now(), token:claim.token};
          const data = await chrome.storage.session.get('igx_laptop_claims');
          const claims = data.igx_laptop_claims || {};
          claims[msg.username.toLowerCase()] = {token:claim.token};
          await chrome.storage.session.set({igx_laptop_claims:claims});
        });
        await chrome.tabs.update(tab.id, {url:msg.url});
        laptopEvent('check_tab_opened', {username:msg.username,tabId:tab.id}).catch(() => {});

        // подстраховка: если content script не отчитается — закрыть вкладку принудительно
        setTimeout(async () => {
          await updateQuickMap(async m => {
            if (m[tab.id]) {
              await laptopEvent('check_timeout', {username:m[tab.id].username, tabId:tab.id});
              delete m[tab.id];
              chrome.tabs.remove(tab.id).catch(() => {});
            }
          });
        }, 30000);

        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'checkDone') {
        await updateQuickMap(async map => {
          const info = sender.tab ? map[sender.tab.id] : null;
          if (info) {
            delete map[sender.tab.id];
            chrome.tabs.remove(sender.tab.id).catch(() => {});
          }
        });
        sendResponse({ ok: true });
      }
    } catch (e) {
      try {
        sendResponse({ error: String((e && e.message) || e) });
      } catch (_) {}
    }
  })();
  return true; // держим канал открытым для async sendResponse
});


// Очистка состояния АФК и коммент-окна при закрытии вкладки
chrome.tabs.onRemoved.addListener((tabId) => {
  updateQuickMap(async map => {delete map[tabId];}).catch(() => {});
  try {
    chrome.storage.local.remove([`igx_afk_tab_${tabId}`, `igx_cmt_tab_${tabId}`]).catch(() => {});
  } catch (_) {}
});
