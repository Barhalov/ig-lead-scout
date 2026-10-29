function laptopUntil(read, timeoutMs) {
  return new Promise(resolve => {
    let observer, timer;
    const check = () => {
      const value = read();
      if (!value) return;
      observer?.disconnect(); clearTimeout(timer); resolve(value);
    };
    observer = new MutationObserver(check);
    observer.observe(document.documentElement || document, {childList:true, subtree:true, characterData:true});
    timer = setTimeout(() => {observer.disconnect();resolve(null);}, timeoutMs);
    check();
  });
}
function laptopCount(text) {
  const match = String(text).replace(/[\u00a0\u202f]/g,' ').match(/([\d][\d\s.,]*)\s*(тыс\.?|млн\.?|[km])?/i);
  if (!match) return null;
  const suffix = (match[2] || '').toLowerCase();
  const raw = match[1].trim().replace(/\s/g,'');
  const value = Number(suffix ? raw.replace(',','.') : raw.replace(/[,.]/g,''));
  return Number.isFinite(value) ? Math.round(value * (/млн|m/.test(suffix) ? 1e6 : /тыс|k/.test(suffix) ? 1e3 : 1)) : null;
}
function laptopHeaderFollowers(header) {
  if (!header) return null;
  const links = [...header.querySelectorAll('a[href*="/followers"],li')];
  const node = links.find(el => /подписчик|followers/i.test(el.innerText || ''));
  if (node) {
    const exact = node.querySelector('[title]')?.getAttribute('title');
    return laptopCount(exact || node.innerText);
  }
  const text = header.innerText || '';
  return laptopCount(text.match(/([\d][\d\s.,]*(?:тыс\.?|млн\.?|[km])?)\s*(?:подписчик|followers)/i)?.[1] || '');
}
async function laptopQuickProfile() {
  if (globalThis.laptopQuickStarted) return;
  globalThis.laptopQuickStarted = true;
  const username = location.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
  const stage = name => chrome.runtime.sendMessage({type:'laptopCheckStage',stage:name}).catch(() => {});
  await stage('content_ready');
  try {
    const header = await laptopUntil(() => {
      const h = document.querySelector('header');
      return laptopHeaderFollowers(h) !== null ? h : null;
    }, 20000);
    if (!header) {await stage('header_timeout'); return;}
    await stage('header_ready');
    const followers = laptopHeaderFollowers(header);
    const isPrivate = /это закрытый профиль|this account is private/i.test(document.querySelector('main')?.innerText || '');
    let urls = [], bio = '', fullName = header.querySelector('h1')?.innerText || username;
    if (followers >= 3000 && !isPrivate) {
      await laptopExpandBiography(username);
      await stage('biography_ready');
      urls = await laptopReadProfileUrls(username);
      bio = header.innerText || '';
      await stage('links_ready');
    }
    const telegrams = urls.map(url => {
      try {const parsed = new URL(url); return parsed.hostname === 'l.instagram.com' ? parsed.searchParams.get('u') || '' : url;}
      catch (_) {return '';}
    }).filter(url => /^https?:\/\/(?:t\.me|telegram\.me)\//i.test(url));
    const result = await chrome.runtime.sendMessage({type:'laptopQuickResult',record:{
      username, fullName, followers, isPrivate, bio, laptopProfileUrls:urls,
      telegram:telegrams[0] || null, telegrams, checkedAt:Date.now()}});
    if (result?.ok) await stage('check_completed');
  } catch (error) {await stage('extraction_error');}
  finally {await chrome.runtime.sendMessage({type:'checkDone',username}).catch(() => {});}
}
// Expand biography only inside the current profile header, never posts/comments.
async function laptopExpandBiography(username) {
  if (location.pathname.split('/').filter(Boolean)[0]?.toLowerCase() !== username.toLowerCase()) return false;
  const header = document.querySelector('header');
  if (!header) return false;
  const more = [...header.querySelectorAll('span,button,[role="button"]')].find(element =>
    /^(?:\.{3}|…)?\s*(?:ещ[её]|more)\s*$/i.test((element.innerText || element.textContent || '').trim()) &&
    element.getClientRects().length > 0);
  if (!more) return true;
  more.click();
  return !!(await laptopUntil(() => !header.contains(more) || !/^(?:\.{3}|…)?\s*(?:ещ[её]|more)\s*$/i.test((more.innerText || more.textContent || '').trim()), 1200));
}

// Read only the current profile's header and its own extra-link dialog.
async function laptopReadProfileUrls(username) {
  if (location.pathname.split('/').filter(Boolean)[0]?.toLowerCase() !== username.toLowerCase()) return [];
  const header = document.querySelector('header');
  if (!header) return [];
  const urls = new Set([...header.querySelectorAll('a[href]')].map(a => a.href));
  const more = [...header.querySelectorAll('a,button,[role="button"]')].find(el =>
    /(?:и\s+ещ[её]\s+\d+|and\s+\d+\s+more)/i.test(el.innerText || ''));
  if (more && !document.querySelector('[role="dialog"]')) {
    more.click();
    const dialog = await laptopUntil(() => {
      const d = document.querySelector('[role="dialog"]');
      return d?.querySelector('a[href]') ? d : null;
    }, 2000);
    if (dialog) {
      for (const anchor of dialog.querySelectorAll('a[href]')) urls.add(anchor.href);
      const close = [...dialog.querySelectorAll('button,[role="button"]')].find(el =>
        /close|закрыть/i.test(el.getAttribute('aria-label') || el.querySelector('[aria-label]')?.getAttribute('aria-label') || ''));
      if (close) close.click();
    }
  }
  return [...urls];
}
