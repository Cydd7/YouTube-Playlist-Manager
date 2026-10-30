/*
 * Entry point: shows the dashboard on youtube.com/feed/playlists, above the
 * playlist grid.
 *
 * YouTube is a single-page app: clicking "Playlists" doesn't load a new page,
 * so this script runs on every YouTube page, follows YouTube's own navigation
 * events, and puts the dashboard back if YouTube re-renders the page.
 */
(() => {
  'use strict';

  const PM = globalThis.PM;

  const ROUTE = '/feed/playlists';
  const CHECK_DELAY_MS = 100;
  const FALLBACK_AFTER_MS = 3000;

  let dashboard = null;
  let observer = null;
  let checkQueued = false;
  let routeEnteredAt = 0;
  let lastHref = location.href;

  const onRoute = () => location.pathname.replace(/\/+$/, '') === ROUTE;

  /** Where the dashboard goes: the top of the visible page's main column. */
  function findAnchor() {
    // YouTube keeps pages you've visited in the DOM, hidden; only the visible one counts.
    const page = document.querySelector('ytd-browse:not([hidden])');
    const primary = page?.querySelector('#primary');
    if (primary) return primary;
    // If YouTube's layout ever changes, fall back to the top of the page after a short wait.
    return page && Date.now() - routeEnteredAt > FALLBACK_AFTER_MS ? page : null;
  }

  function check() {
    checkQueued = false;
    if (!onRoute()) return;
    const anchor = findAnchor();
    if (!anchor) return;
    dashboard ??= new PM.Dashboard();
    if (dashboard.host.parentNode !== anchor) dashboard.mount(anchor);
  }

  function queueCheck() {
    if (checkQueued) return;
    checkQueued = true;
    setTimeout(check, CHECK_DELAY_MS);
  }

  function sync() {
    lastHref = location.href;
    if (onRoute()) {
      if (!observer) {
        routeEnteredAt = Date.now();
        observer = new MutationObserver(queueCheck);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['hidden'],
        });
        setTimeout(queueCheck, FALLBACK_AFTER_MS + CHECK_DELAY_MS);
      }
      check();
    } else if (observer) {
      observer.disconnect();
      observer = null;
      dashboard?.unmount();
    }
  }

  window.addEventListener('yt-navigate-finish', sync);
  document.addEventListener('yt-navigate-finish', sync);
  window.addEventListener('popstate', sync);
  // Safety net in case YouTube renames its navigation event.
  setInterval(() => {
    if (location.href !== lastHref) sync();
  }, 1000);
  sync();
})();
