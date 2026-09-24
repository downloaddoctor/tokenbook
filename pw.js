/* TokenBook PWA bootstrap — registers the service worker and wires install/update
   UX. Loaded by index.html; no-op when unsupported. */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function (err) {
      // Registration failure must never break the app.
      if (window.console && console.warn) {
        console.warn('[tokenbook] SW registration failed:', err);
      }
    });
  });

  // The SW found a fresh deploy (version.txt sentinel changed) and refreshed the
  // cache in the background — reload to pick it up. Guarded via localStorage:
  // only one auto-reload per short window, so a flaky sentinel/network hiccup
  // can't reload the page repeatedly.
  var RELOAD_GUARD_KEY = 'tokenbook-reload-guard';
  var RELOAD_GUARD_MS = 30000;

  navigator.serviceWorker.addEventListener('message', function (event) {
    if (!event.data || event.data.type !== 'tokenbook-update-ready') return;

    var last = 0;
    try {
      last = Number(localStorage.getItem(RELOAD_GUARD_KEY)) || 0;
    } catch (err) {
      /* localStorage unavailable (private mode etc) — reload once, no guard. */
    }
    if (Date.now() - last < RELOAD_GUARD_MS) return;

    try {
      localStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    } catch (err) {
      /* ignore — best effort only. */
    }
    window.location.reload();
  });
})();
