const status = document.getElementById('status');
async function refresh() {
  const data = await chrome.storage.local.get(['igx_laptop_last_result','igx_laptop_outbox','igx_laptop_bridge_error']);
  status.textContent = data.igx_laptop_bridge_error ||
    'Локальная база подключена. Ожидают сохранения: ' + Object.keys(data.igx_laptop_outbox || {}).length +
    '\nПоследний результат: ' + JSON.stringify(data.igx_laptop_last_result || {}, null, 2);
}
document.getElementById('start').onclick = async () => {
  if (launchParams.get('worker')) await chrome.storage.local.set({igx_laptop_worker:launchParams.get('worker')});
  const all = await chrome.storage.local.get(null);
  if (Object.entries(all).some(([key,value]) => key.startsWith('igx_afk_tab_') && value?.on)) {
    status.textContent = 'В этом аккаунте уже работает поток. Второй не запускаю.'; return;
  }
  let donor = document.getElementById('donor').value.trim().replace(/^@/, '').toLowerCase();
  if (!donor) {
    const candidates = Object.entries(all).filter(([key,value]) => key.startsWith('igx_profile:') &&
      value?.followers >= 3000 && !all['igx_done:' + value.username.toLowerCase()]);
    donor = candidates[Math.floor(Math.random() * candidates.length)]?.[1].username;
  }
  if (!donor || !/^[a-z0-9_.]{1,30}$/.test(donor)) {status.textContent = 'Укажи Instagram донора.'; return;}
  const requestedKind = launchParams.get('kind');
  const kind = requestedKind === 'followers' || requestedKind === 'following'
    ? requestedKind : (all.igx_afk_list_kind === 'followers' ? 'followers' : 'following');
  const queue = [{username: donor, word: 'тренер', ts: Date.now(), infinite: true}];
  await chrome.storage.local.set({igx_afk_autostart: queue, igx_afk_last_word: 'тренер',
    igx_afk_must_word: 'тренер', igx_afk_enter_mode: 'wordall', igx_min_followers: 3000,
    igx_afk_list_kind: kind, igx_afk_infinite: {on:true, startedAt:Date.now()}});
  await chrome.tabs.create({url: 'https://www.instagram.com/' + donor +
    (kind === 'followers' ? '/followers/mutualFirst' : '/following/')});
  status.textContent = 'Запущен один поток: @' + donor;
};
document.getElementById('stop').onclick = async () => {
  await chrome.storage.local.set({igx_afk_stop_cmd:{ts:Date.now()},igx_afk_autostart:[],
    igx_afk_infinite:{on:false,stoppedAt:Date.now(),reason:'manual'}});
  status.textContent = 'Остановка. Самостоятельного перезапуска не будет.';
};
refresh(); setInterval(refresh, 5000);
// An explicit launch URL is a one-shot manual command, never a timed restart.
const launchParams = new URLSearchParams(location.search);
async function manualRestart() {
  const all = await chrome.storage.local.get(null);
  const session = await chrome.storage.session.get('igx_quickcheck_tabs');
  const quick = session.igx_quickcheck_tabs || {};
  const activeIds = new Set(Object.keys(all).filter(key => /^igx_afk_tab_\d+$/.test(key)).map(key => Number(key.slice('igx_afk_tab_'.length))));
  for (const id of Object.keys(quick)) activeIds.add(Number(id));
  await chrome.storage.local.set({igx_afk_stop_cmd:{ts:Date.now()},igx_afk_autostart:[],
    igx_afk_infinite:{on:false,stoppedAt:Date.now(),reason:'manual_restart'}});
  const cleanStart = launchParams.get('clean') === '1';
  const currentTab = cleanStart ? await chrome.tabs.getCurrent() : null;
  const tabs = await chrome.tabs.query(cleanStart ? {} : {url:'https://www.instagram.com/*'});
  for (const tab of tabs) {
    if (cleanStart ? tab.id !== currentTab?.id :
        (activeIds.has(tab.id) || /\/(followers|following)(\/|$)/.test(new URL(tab.url).pathname))) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
  // Only transient run state. Keep profiles, done donors, outbox and histories.
  await chrome.storage.local.remove(Object.keys(all).filter(key => key.startsWith('igx_afk_tab_') || key === 'igx_afk_dispatched'));
  if (launchParams.get('fresh') === '1') {
    // Retire the old donor pool only. Profile records, checked flags, completed
    // lists and the shared check cache must survive a queue reset.
    // Retire only actual donors from the previous chain, not every checked
    // person: a checked lead can still have a completely unexplored list.
    const retired = new Set();
    for (const [key, state] of Object.entries(all)) {
      if (!key.startsWith('igx_afk_tab_') || !state || typeof state !== 'object') continue;
      for (const name of [state.cur, state.seed, ...(state.visited || []),
        ...(state.lists || []).map(item => item.owner)]) {
        if (typeof name === 'string' && /^[a-z0-9_.]{1,30}$/i.test(name)) retired.add(name.toLowerCase());
      }
    }
    await chrome.storage.local.set({igx_retired_donors: [...retired],
      igx_donor_queue_reset_at: Date.now()});
  }
  await chrome.storage.session.set({igx_quickcheck_tabs:{}});
  // Recheck previously truncated, unsaved contacts when encountered again.
  const incomplete = Object.entries(all).filter(([key, record]) => key.startsWith('igx_profile:') &&
    !record?.laptopHistorical && record?.followers >= 2000 && !record.telegram &&
    /(?:\.{3}|…)\s*ещ[её]/i.test(record.bio || ''));
  for (let index = 0; index < incomplete.length; index += 50) {
    await chrome.storage.local.set(Object.fromEntries(incomplete.slice(index, index + 50).map(([key, record]) =>
      [key, {...record, laptopNeedsBioRecheck:true}])));
  }
  // Re-evaluate cached profiles rejected solely by the old follower threshold.
  // Reuse actual profile evidence; the receiver still applies all other filters.
  if (false) {
    const eligible = Object.entries(all).filter(([key, record]) =>
      key.startsWith('igx_profile:') && record?.followers >= 2000 && record.followers < 4000 &&
      !record.laptopHistorical && Array.isArray(record.laptopProfileUrls));
    for (let index = 0; index < eligible.length; index += 50) {
      await chrome.storage.local.set(Object.fromEntries(eligible.slice(index, index + 50).map(([key, record]) =>
        [key, {...record, laptopThresholdRecheckAt: Date.now()}])));
    }
  }
  await document.getElementById('start').onclick();
}
if (launchParams.get('start') === '1' || launchParams.get('restart') === '1') {
  document.getElementById('donor').value = launchParams.get('donor') || '';
  history.replaceState(null, '', location.pathname);
  (launchParams.get('restart') === '1' ? manualRestart() : document.getElementById('start').onclick())
    .catch(error => {status.textContent = String(error);});
}
// Explicit maintenance command used before a rollout: reload the extension worker,
// not only its Instagram tabs. A second normal launch starts the fresh worker.
if (launchParams.get('reloadExtension') === '1') {
  chrome.storage.local.set({igx_laptop_build:'queue-owners-20261024'}).then(() => chrome.runtime.reload());
}
