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
  // Keep RELOAD_GUARD_MS equal to CHECK_GUARD_MS in sw.js.
  var reloadRequested = false;

  // Non-destructive update prompt. `worker` = a waiting SW to activate first
  // (null when the SW already refreshed the cache and only a reload is needed).
  function showUpdateBanner(worker) {
    if (document.getElementById('tb-update')) return;
    var box = document.createElement('div');
    box.id = 'tb-update';
    box.setAttribute('role', 'status');
    box.style.cssText =
      'position:fixed;right:12px;bottom:12px;z-index:9999;background:#1f2937;color:#fff;' +
      'padding:10px 14px;border-radius:8px;display:flex;gap:10px;align-items:center;' +
      'font:14px Inter,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)';
    var msg = document.createElement('span');
    msg.textContent = 'Update ready. Save your work, then reload.';
    var go = document.createElement('button');
    go.type = 'button';
    go.textContent = 'Reload';
    go.addEventListener('click', function () {
      reloadRequested = true;
      if (worker) worker.postMessage({ type: 'tokenbook-skip-waiting' });
      else window.location.reload();
    });
    var later = document.createElement('button');
    later.type = 'button';
    later.textContent = 'Later';
    later.addEventListener('click', function () {
      box.remove();
    });
    box.appendChild(msg);
    box.appendChild(go);
    box.appendChild(later);
    document.body.appendChild(box);
  }

  // After the waiting worker takes over, reload once (only if the user asked).
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (reloadRequested) window.location.reload();
  });

  // Offer the update when a new worker is installed and waiting.
  window.addEventListener('load', function () {
    navigator.serviceWorker
      .register('./sw.js')
      .then(function (reg) {
        if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);
        reg.addEventListener('updatefound', function () {
          var w = reg.installing;
          if (!w) return;
          w.addEventListener('statechange', function () {
            if (w.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner(w);
            }
          });
        });
      })
      .catch(function () {});
  });

  var RELOAD_GUARD_KEY = 'tokenbook-reload-guard';
  var RELOAD_GUARD_MS = 30000;

  navigator.serviceWorker.addEventListener('message', function (event) {
    if (!event.data || event.data.type !== 'tokenbook-update-ready') return;
    // Never reload under the operator: show a prompt instead (a half-filled form
    // would be lost). Only ?forceUpdate=1 reloads directly.
    if (!FORCE_UPDATE) {
      showUpdateBanner(null);
      return;
    }

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
