// main-bridge.js — выполняется в контексте страницы (MAIN world)
// Имеет прямой доступ к __reactFiber$, React props и внутреннему состоянию Instagram.
(function () {
  function findFiberItem(root) {
    const candidates = [
      root.querySelector('video'),
      root.querySelector('ul._acay'),
      root.querySelector('article'),
      root,
      document.querySelector('[role="dialog"] article'),
      document.querySelector('[role="dialog"]'),
      document.querySelector('article'),
      document.querySelector('main'),
    ].filter(Boolean);

    for (const el of candidates) {
      const k = Object.keys(el).find((key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
      if (!k) continue;
      let curr = el[k];
      for (let depth = 0; depth < 35 && curr; depth++) {
        const p = curr.memoizedProps || curr.pendingProps;
        if (p) {
          const item = p.item || p.media || p.post || p.clip;
          if (item && (item.like_count !== undefined || item.caption !== undefined || item.taken_at !== undefined || item.pk)) {
            return item;
          }
        }
        curr = curr.return;
      }
    }
    return null;
  }

  function syncPostMeta() {
    try {
      const item = findFiberItem(document);
      if (item) {
        const meta = {
          pk: item.pk,
          taken_at: typeof item.taken_at === 'number' ? item.taken_at : null,
          like_count: typeof item.like_count === 'number' ? item.like_count : null,
          like_and_view_counts_disabled: !!item.like_and_view_counts_disabled,
          comment_count: typeof item.comment_count === 'number' ? item.comment_count : null,
          play_count: typeof item.play_count === 'number' ? item.play_count : (typeof item.view_count === 'number' ? item.view_count : null),
          reshare_count: typeof item.reshare_count === 'number' ? item.reshare_count : (typeof item.share_count === 'number' ? item.share_count : null),
          caption: item.caption && typeof item.caption.text === 'string' ? item.caption.text : (typeof item.caption === 'string' ? item.caption : null),
        };
        document.documentElement.dataset.igxPostMeta = JSON.stringify(meta);
      }
    } catch (_) {}
  }

  // Синхронизируем периодически и при смене страницы / кликах
  setInterval(syncPostMeta, 1000);
  window.addEventListener('popstate', () => setTimeout(syncPostMeta, 500));
  document.addEventListener('click', () => setTimeout(syncPostMeta, 300), true);
  document.addEventListener('igx_req_post_meta', syncPostMeta);
  syncPostMeta();
})();
