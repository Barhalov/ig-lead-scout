importScripts('laptop-config.js');
let laptopChain = Promise.resolve();
let laptopWorkerPromise;
function laptopWorker() {
  return laptopWorkerPromise ||= chrome.storage.local.get('igx_laptop_worker').then(async data => {
    const worker = data.igx_laptop_worker || crypto.randomUUID();
    await chrome.storage.local.set({igx_laptop_worker: worker});
    return worker;
  });
}
async function laptopEvent(stage, fields = {}) {
  return laptopRequest('/event', {stage, worker: await laptopWorker(), ...fields});
}
async function laptopRequest(path, body) {
  const response = await fetch(LAPTOP_API + path, {
    method: body ? 'POST' : 'GET',
    headers: {'Authorization': 'Bearer ' + LAPTOP_TOKEN, 'Content-Type': 'application/json'},
    ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error('Local bridge: ' + response.status);
  return response.json();
}
async function laptopFlush() {
  const data = await chrome.storage.local.get('igx_laptop_outbox');
  const outbox = data.igx_laptop_outbox || {};
  for (const [key, record] of Object.entries(outbox)) {
    try {
      const result = await laptopRequest('/profile', record);
      delete outbox[key];
      await chrome.storage.local.set({igx_laptop_outbox: outbox,
        igx_laptop_last_result: {username: record.username, at: Date.now(), ...result}});
    } catch (error) {
      await chrome.storage.local.set({igx_laptop_bridge_error: String(error)});
      laptopEvent('save_error', {username:record.username, error:String(error)}).catch(() => {});
      return;
    }
  }
  await chrome.storage.local.remove('igx_laptop_bridge_error');
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const records = Object.entries(changes).filter(([key, change]) =>
    key.startsWith('igx_profile:') && change.newValue && !change.newValue.laptopHistorical &&
    Object.hasOwn(change.newValue, 'laptopProfileUrls'));
  if (!records.length) return;
  laptopChain = laptopChain.catch(() => {}).then(async () => {
    const data = await chrome.storage.local.get('igx_laptop_outbox');
    const outbox = data.igx_laptop_outbox || {};
    for (const [key, change] of records) {
      outbox[key] = {...change.newValue, laptopWorker: await laptopWorker()};
    }
    await chrome.storage.local.set({igx_laptop_outbox: outbox});
    await laptopFlush();
  });
});
chrome.alarms.create('laptop-outbox', {periodInMinutes: 1});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'laptop-outbox') laptopChain = laptopChain.catch(() => {}).then(laptopFlush);
});
async function laptopInitialize() {
  const data = await chrome.storage.local.get('igx_laptop_ready');
  if (!data.igx_laptop_ready) {
    const bootstrap = await laptopRequest('/bootstrap');
    const defaults = {igx_min_followers: 2000, igx_max_followers: 0,
      igx_afk_last_word: 'тренер', igx_afk_must_word: 'тренер',
      igx_afk_enter_mode: 'wordall', igx_afk_list_kind: 'following',
      igx_settings: {openMode: 'newtab', throttleMs: 4000, jitterSec: 0, breakEvery: 0},
      igx_sync_on: false, igx_laptop_ready: true};
    for (const record of bootstrap.profiles || []) defaults['igx_profile:' + record.username.toLowerCase()] = record;
    await chrome.storage.local.set(defaults);
    await chrome.tabs.create({url: chrome.runtime.getURL('laptop.html')});
  }
  laptopChain = laptopChain.catch(() => {}).then(laptopFlush);
  await laptopChain;
}
chrome.runtime.onInstalled.addListener(() => laptopInitialize().catch(console.error));
chrome.runtime.onStartup.addListener(() => laptopInitialize().catch(console.error));
laptopInitialize().catch(console.error);

// Runs outside Instagram: a stalled document cannot disable this watchdog.
let laptopWatchBusy = false;
async function laptopWatchLoading() {
  if (laptopWatchBusy) return;
  laptopWatchBusy = true;
  try {
    const data = await chrome.storage.local.get(null);
    if (!data.igx_afk_infinite?.on || data.igx_afk_infinite?.banned) return;
    const watches = data.igx_laptop_loading_watch || {};
    for (const tab of await chrome.tabs.query({url: 'https://www.instagram.com/*'})) {
      const state = data['igx_afk_tab_' + tab.id];
      if (!state?.on || state.stopping || !state.sid) continue;
      if (/\/challenge|\/accounts\/(login|activity)/i.test(tab.url || '')) continue;
      const now = Date.now();
      await laptopEvent('stream_status', {sid:state.sid, tabId:tab.id, username:state.cur,
        hb:state.hb, prog:state.prog, checked:state.totals?.checked || 0,
        pauseTill:state.pauseTill || 0, pauseWhy:state.pauseWhy || '',
        outbox:Object.keys(data.igx_laptop_outbox || {}).length});
      const kind = /\/followers\//.test(tab.url || '') ? 'followers' : 'following';
      if (state.cur) {
        const lease = await laptopRequest('/donor', {username:state.cur, kind, worker:await laptopWorker()});
        if (!lease.claimed) await laptopEvent('donor_conflict', {username:state.cur, sid:state.sid});
      }
      if (Number(state.pauseTill) > now) continue;
      // Independent of Instagram's timers: catches a live heartbeat with a stuck loop.
      const lastStep = Number(state.prog || state.hb || state.startedAt || now);
      if (now - lastStep > 120000) {
        const fresh = await chrome.storage.local.get('igx_afk_infinite');
        if (!fresh.igx_afk_infinite?.on) break;
        await laptopEvent('stalled_stream', {sid:state.sid, username:state.cur, action:'recover'});
        try {
          const result = await Promise.race([
            chrome.tabs.sendMessage(tab.id, {type:'laptopRecover'}),
            new Promise((_, reject) => setTimeout(() => reject(new Error('recovery_timeout')), 8000))
          ]);
          if (result?.ok) continue;
        } catch (_) {}
        const check = await chrome.storage.local.get('igx_afk_infinite');
        if (check.igx_afk_infinite?.on && !check.igx_afk_infinite?.banned) {
          const retired = new Set(data.igx_retired_donors || []);
          const candidates = Object.entries(data).filter(([key,p]) => key.startsWith('igx_profile:') &&
            p?.username && !p.isPrivate && p.followers >= 3000 && p.username !== state.cur &&
            !retired.has(p.username.toLowerCase()) &&
            !(Number(data.igx_unavailable_donors?.[p.username.toLowerCase()+':'+kind]) > Date.now()) &&
            /тренер/i.test([p.username,p.fullName,p.bio].join(' ')));
          let next;
          for (const [,p] of candidates.sort(() => Math.random() - 0.5).slice(0, 20)) {
            const lease = await laptopRequest('/donor', {username:p.username, kind, worker:await laptopWorker()});
            if (lease.claimed) {next=p.username; break;}
          }
          const fresh = await chrome.storage.local.get('igx_afk_infinite');
          if (!fresh.igx_afk_infinite?.on || fresh.igx_afk_infinite?.banned) continue;
          if (next) {
            await laptopEvent('external_donor_switch', {username:next, action:'restart_stalled_tab'});
            await chrome.tabs.update(tab.id, {url:chrome.runtime.getURL('laptop.html') +
              '?restart=1&clean=1&kind='+kind+'&donor='+encodeURIComponent(next)});
          } else {
            await laptopEvent('no_free_donor', {username:state.cur, action:'reload'});
            await chrome.tabs.reload(tab.id);
          }
        }
        continue;
      }
      let stalled = tab.status === 'loading';
      try {
        const result = await chrome.scripting.executeScript({target: {tabId: tab.id}, func: () => {
          const text = document.body?.innerText?.trim() || '';
          const hasProfile = !!document.querySelector('header a');
          const dialog = [...document.querySelectorAll('[role="dialog"]')].find((node) => {
            const r = node.getBoundingClientRect();
            return r.width > 100 && r.height > 100;
          });
          // Поле поиска само по себе не означает, что список загрузился: Instagram
          // часто оставляет модалку с одними skeleton-строками. Живым считаем список,
          // только когда в нём появился хотя бы один реальный профиль.
          const hasListInput = !!dialog?.querySelector('input');
          const hasListUsers = !![...(dialog?.querySelectorAll('a[href^="/"]') || [])].find((a) => {
            const path = (a.getAttribute('href') || '').split('?')[0];
            return /^\/[A-Za-z0-9._]+\/?$/.test(path) &&
              !/^\/(explore|reels|direct|accounts|stories)\/?$/i.test(path);
          });
          const emptyList = hasListInput && !hasListUsers;
          const blankPage = !hasProfile && !hasListInput && (!text || /^(from\s+Meta|Instagram)$/i.test(text));
          return emptyList || blankPage;
        }});
        stalled = stalled || result[0]?.result === true;
      } catch (_) { stalled = true; }
      const key = String(tab.id);
      if (!stalled) { delete watches[key]; continue; }
      const old = watches[key];
      const watch = old?.sid === state.sid && old.url === tab.url
        ? old : {sid: state.sid, url: tab.url, since: Date.now(), retries: 0};
      watches[key] = watch;
      if (Date.now() - watch.since < 60000) continue;
      // Recheck stop immediately before acting; never resurrect a stopped job.
      const fresh = await chrome.storage.local.get('igx_afk_infinite');
      if (!fresh.igx_afk_infinite?.on) break;
      if (watch.retries < 2) {
        watch.retries = (watch.retries || 0) + 1; watch.since = Date.now();
        await chrome.tabs.reload(tab.id);
        await chrome.storage.local.set({igx_laptop_watchdog_event: {at: Date.now(), action: 'reload', url: tab.url}});
      } else {
        // Не выключаем весь поток из-за сетевой заглушки Instagram. После двух
        // перезагрузок даём content-script ещё один чистый цикл восстановления;
        // его состояние (fails/visited) сохранено и он выберет другого донора.
        watch.retries = 0; watch.since = Date.now();
        await chrome.tabs.reload(tab.id, {bypassCache: true});
        await chrome.storage.local.set({igx_laptop_watchdog_event: {at: Date.now(), action: 'hard_reload', url: tab.url}});
      }
    }
    await chrome.storage.local.set({igx_laptop_loading_watch: watches});
  } finally { laptopWatchBusy = false; }
}
chrome.alarms.create('laptop-loading-watch', {periodInMinutes: 0.5});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'laptop-loading-watch') laptopWatchLoading().catch(console.error);
});
