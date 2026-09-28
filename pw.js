/* TokenBook PWA bootstrap — registers the service worker and wires install/update
   UX. Loaded by index.html; no-op when unsupported. */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  // ?dev=1 -> SW off. Unregister any existing worker and nuke its caches so a
  // dev session always sees fresh files (no cache-first shell, no update guard).
  var DEV = /[?&]dev=1(?:&|$)/.test(window.location.search);
  // ?forceUpdate=1 -> skip the reload guard and ask the SW to re-check the
  // deploy sentinel immediately. Dev / manual-test flag only.
  var FORCE_UPDATE = /[?&]forceUpdate=1(?:&|$)/.test(window.location.search);
  if (DEV) {
    if (window.console && console.info) console.info('[tokenbook] dev mode: SW disabled');
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      for (var i = 0; i < regs.length; i++) regs[i].unregister();
    });
    if (window.caches && caches.keys) {
      caches.keys().then(function (names) {
        names.forEach(function (n) {
          if (/^tokenbook-/.test(n)) caches.delete(n);
        });
      });
    }
    return;
  }

  window.addEventListener('load', function () {
    navigator.serviceWorker
      .register('./sw.js')
      .then(function () {
        if (!FORCE_UPDATE) return;
        // Ask the SW to re-check the sentinel right now (dev / manual test).
        var sw = navigator.serviceWorker.controller;
        if (sw) {
          sw.postMessage({ type: 'tokenbook-force-update' });
        } else {
          // First load in this session: wait for the controller to appear.
          navigator.serviceWorker.ready.then(function () {
            var c = navigator.serviceWorker.controller;
            if (c) c.postMessage({ type: 'tokenbook-force-update' });
          });
        }
      })
      .catch(function (err) {
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
    // forceUpdate bypasses the reload guard so a dev can drive the update
    // path deterministically without waiting out the 30s window.
    if (!FORCE_UPDATE && Date.now() - last < RELOAD_GUARD_MS) return;

    try {
      localStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    } catch (err) {
      /* ignore — best effort only. */
    }
    window.location.reload();
  });
})();
