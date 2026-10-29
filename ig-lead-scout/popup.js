async function loadSettings() {
  const data = await chrome.storage.local.get('igx_settings');
  const s = Object.assign({ openMode: 'newtab', throttleMs: 4000 }, data.igx_settings || {});
  document.getElementById('openMode').value = s.openMode;
  document.getElementById('throttle').value = Math.round((s.throttleMs || 4000) / 1000);
}

async function saveSettings() {
  const openMode = document.getElementById('openMode').value;
  const throttleMs = Math.max(1, parseInt(document.getElementById('throttle').value, 10) || 4) * 1000; // тот же пол, что в дашборде и content.js
  await chrome.storage.local.set({ igx_settings: { openMode, throttleMs } });
}

document.getElementById('openMode').addEventListener('change', saveSettings);
document.getElementById('throttle').addEventListener('change', saveSettings);

async function loadStats() {
  const all = await chrome.storage.local.get(null);
  let total = 0;
  let withTg = 0;
  for (const k of Object.keys(all)) {
    if (k.startsWith('igx_profile:')) {
      total++;
      if (all[k] && all[k].telegram) withTg++;
    }
  }
  document.getElementById('stats').textContent = `Проверено профилей: ${total} · с Telegram: ${withTg}`;
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

document.getElementById('exportCsv').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const rows = [['username', 'fullName', 'followers', 'telegram', 'checkedAt']];
  for (const k of Object.keys(all)) {
    if (k.startsWith('igx_profile:')) {
      const p = all[k];
      rows.push([p.username, p.fullName, p.followers ?? '', p.telegram ?? '', new Date(p.checkedAt).toISOString()]);
    }
  }
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ig_leads_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

document.getElementById('clearAll').addEventListener('click', async () => {
  if (!confirm('Удалить всю накопленную базу проверенных профилей?')) return;
  const all = await chrome.storage.local.get(null);
  const toRemove = Object.keys(all).filter(
    (k) => k.startsWith('igx_profile:') || k.startsWith('igx_visited:') || k.startsWith('igx_search:')
  );
  await chrome.storage.local.remove(toRemove);
  loadStats();
});

// ---------- вкладки ----------
document.querySelectorAll('.igx-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.igx-tab').forEach((t) => t.classList.remove('is-active'));
    tab.classList.add('is-active');
    document.getElementById('tabIg').hidden = tab.dataset.tab !== 'ig';
    document.getElementById('tabTg').hidden = tab.dataset.tab !== 'tg';
  });
});

// ---------- вкладка «Телеграм» ----------
const TG_SAFE_PRESET = { msgLimit: 10, delaySec: 30 };

async function loadTgSettings() {
  let s;
  try {
    s = await chrome.runtime.sendMessage({ type: 'tgGetSettings' });
  } catch (_) {}
  if (!s || typeof s !== 'object') return;
  document.getElementById('tgSafe').checked = !!s.safeMode;
  document.getElementById('tgMode').value = s.mode === 'tg' ? 'tg' : 'site';
  document.getElementById('tgMsgLimit').value = s.msgLimit;
  document.getElementById('tgDelay').value = s.delaySec;
  document.getElementById('tgAutoReport').checked = !!s.autoReport;
  document.getElementById('tgToken').value = s.token || '';
  document.getElementById('tgChat').value = s.chatQuery || (s.chatId ? String(s.chatId) : '');
  applySafeModeUI(s.safeMode);
  if (s.chatId) {
    document.getElementById('tgStatus').textContent = `ТГ привязан (chat_id: ${s.chatId}). Команды бота: /mode, /st, либо просто кинь ему ссылку t.me/...`;
  }
}

function applySafeModeUI(safe) {
  const lim = document.getElementById('tgMsgLimit');
  const del = document.getElementById('tgDelay');
  if (safe) {
    lim.value = TG_SAFE_PRESET.msgLimit;
    del.value = TG_SAFE_PRESET.delaySec;
  }
  lim.disabled = safe;
  del.disabled = safe;
}

function collectTgPatch() {
  const safe = document.getElementById('tgSafe').checked;
  return {
    safeMode: safe,
    mode: document.getElementById('tgMode').value,
    msgLimit: Math.min(200, Math.max(5, parseInt(document.getElementById('tgMsgLimit').value, 10) || 20)),
    delaySec: Math.min(300, Math.max(3, parseInt(document.getElementById('tgDelay').value, 10) || 10)),
    autoReport: document.getElementById('tgAutoReport').checked,
    token: document.getElementById('tgToken').value.trim(),
    chatQuery: document.getElementById('tgChat').value.trim(),
  };
}

async function saveTg() {
  await chrome.runtime.sendMessage({ type: 'tgSaveSettings', patch: collectTgPatch() });
}

document.getElementById('tgSafe').addEventListener('change', (e) => {
  applySafeModeUI(e.target.checked);
  saveTg();
});
document.getElementById('tgMode').addEventListener('change', saveTg);
document.getElementById('tgMsgLimit').addEventListener('change', saveTg);
document.getElementById('tgDelay').addEventListener('change', saveTg);
document.getElementById('tgAutoReport').addEventListener('change', saveTg);
document.getElementById('tgToken').addEventListener('change', saveTg);
document.getElementById('tgChat').addEventListener('change', saveTg);

document.getElementById('tgTest').addEventListener('click', async () => {
  const st = document.getElementById('tgStatus');
  st.textContent = 'Проверяю бота…';
  await saveTg();
  const r = await chrome.runtime.sendMessage({ type: 'tgTest' });
  if (r && r.ok) {
    st.textContent = `Бот @${r.botName} отвечает.${r.chatId ? ` ТГ привязан (chat_id: ${r.chatId}).` : ' Напиши боту /start и нажми «Привязать мой ТГ».'}`;
  } else {
    st.textContent = `Ошибка бота: ${(r && r.error) || 'нет ответа'}. Проверь токен.`;
  }
});

document.getElementById('tgDiagBtn').addEventListener('click', async () => {
  const out = document.getElementById('tgDiag');
  const st = document.getElementById('tgStatus');
  out.hidden = false;
  out.textContent = 'Диагностика… жди до ~40 секунд.';
  st.textContent = 'Прогоняю все этапы скана.';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'tgDiagnose' });
    out.textContent = r && r.report ? r.report : `Нет ответа от расширения: ${JSON.stringify(r)}`;
  } catch (e) {
    out.textContent = `Фоновый воркер не отвечает: ${e.message || e}\nПопробуй перезагрузить расширение на chrome://extensions.`;
  }
});

document.getElementById('tgBind').addEventListener('click', async () => {
  const st = document.getElementById('tgStatus');
  await saveTg();
  const query = document.getElementById('tgChat').value.trim();
  if (query) {
    // Явно ввели юзернейм / числовой chat_id — разрешаем его в chat_id.
    st.textContent = `Ищу получателя «${query}»…`;
    const r = await chrome.runtime.sendMessage({ type: 'tgResolveChat', query });
    if (r && r.ok && r.chatId) {
      await chrome.runtime.sendMessage({ type: 'tgSaveSettings', patch: { chatId: r.chatId } });
      st.textContent = `ТГ привязан (chat_id: ${r.chatId}). Все отчёты бот будет слать этому юзеру.`;
    } else {
      st.textContent = `Не привязал: ${(r && r.error) || 'нет ответа'}`;
    }
    return;
  }
  // Поле пустое — старое поведение: берём последний чат, писавший боту.
  st.textContent = 'Ищу твой chat_id… (если не выходит — напиши боту /start и повтори)';
  const r = await chrome.runtime.sendMessage({ type: 'tgBindChat' });
  if (r && r.ok && r.chatId) {
    await chrome.runtime.sendMessage({ type: 'tgSaveSettings', patch: { chatId: r.chatId } });
    st.textContent = `ТГ привязан (chat_id: ${r.chatId}). Отчёты будут приходить сюда.`;
  } else {
    st.textContent = `Не нашёл. Напиши боту /start, подожди пару секунд и нажми ещё раз.${r && r.error ? ` (${r.error})` : ''}`;
  }
});

// ---------- АФК: кнопка «открыть АФК-вкладку (случайный зелёный)» ----------
const AFK_KIND_KEY = 'igx_afk_list_kind';
const AFK_AUTOSTART_KEY = 'igx_afk_autostart';
const AFK_DISPATCHED_KEY = 'igx_afk_dispatched';
const AFK_LAST_WORD_KEY = 'igx_afk_last_word';

async function loadAfkKind() {
  const d = await chrome.storage.local.get(AFK_KIND_KEY);
  const v = d[AFK_KIND_KEY];
  document.getElementById('afkListKind').value =
    (v === 'following' || v === 'both') ? v : 'followers';
}

document.getElementById('afkListKind').addEventListener('change', async (e) => {
  const v = e.target.value;
  await chrome.storage.local.set({
    [AFK_KIND_KEY]: (v === 'following' || v === 'both') ? v : 'followers',
  });
});

function afkKindUrl(username, kind) {
  return kind === 'following'
    ? `https://www.instagram.com/${username}/following/`
    : `https://www.instagram.com/${username}/followers/mutualFirst`;
}

// Случайный зелёный (есть telegram), чей список ещё не «выжат» и не занят другим АФК.
function pickRandomGreen(all, dispatched) {
  const done = new Set();
  for (const k of Object.keys(all)) {
    if (k.startsWith('igx_done:')) done.add(k.slice('igx_done:'.length));
  }
  const greens = [];
  for (const k of Object.keys(all)) {
    if (!k.startsWith('igx_profile:')) continue;
    const p = all[k];
    if (!p || !p.telegram) continue;
    const u = k.slice('igx_profile:'.length).toLowerCase();
    if (done.has(u) || dispatched[u]) continue;
    greens.push(u);
  }
  if (!greens.length) return null;
  return greens[Math.floor(Math.random() * greens.length)];
}

document.getElementById('afkSpawn').addEventListener('click', async () => {
  const st = document.getElementById('afkSpawnStatus');
  const all = await chrome.storage.local.get(null);

  // карта занятых сидов с протуханием (>3 ч)
  const now = Date.now();
  const dispatched = (all && all[AFK_DISPATCHED_KEY]) || {};
  for (const k of Object.keys(dispatched)) {
    if (!dispatched[k] || now - dispatched[k] > 3 * 3600 * 1000) delete dispatched[k];
  }

  const u = pickRandomGreen(all, dispatched);
  if (!u) {
    st.textContent = 'Нет свободных зелёных лидов: все уже «выжаты» или запущены в других вкладках.';
    return;
  }

  const kind = document.getElementById('afkListKind').value === 'following' ? 'following' : 'followers';
  const word = all[AFK_LAST_WORD_KEY] || '';

  // занимаем лид и кладём запись автозапуска (новую вкладку подхватит content.js)
  dispatched[u] = now;
  const q = Array.isArray(all[AFK_AUTOSTART_KEY]) ? all[AFK_AUTOSTART_KEY] : [];
  q.push({ username: u, word, ts: now });
  await chrome.storage.local.set({
    [AFK_DISPATCHED_KEY]: dispatched,
    [AFK_AUTOSTART_KEY]: q,
  });

  try {
    await chrome.runtime.sendMessage({ type: 'newTab', url: afkKindUrl(u, kind) });
    st.textContent = `Открыта АФК-вкладка для @${u} (${kind === 'following' ? 'подписки' : 'подписчики'}). Активных лидов: ${Object.keys(dispatched).length}.`;
  } catch (e) {
    st.textContent = `Не удалось открыть вкладку: ${(e && e.message) || e}. Перезагрузи расширение.`;
  }
});

// ---------- сайт расширения (дашборд): статистика, настройки, бесконечный чек ----------
document.getElementById('openSite').addEventListener('click', async () => {
  // не плодим дубликат — если вкладка уже открыта, переключаемся на неё
  const url = chrome.runtime.getURL('dashboard.html');
  try {
    const tabs = await chrome.tabs.query({ url });
    if (tabs.length) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId != null) await chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
  } catch (_) {}
  window.close();
});

loadSettings();
loadStats();
loadTgSettings();
loadAfkKind();
