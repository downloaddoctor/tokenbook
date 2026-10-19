/* TokenBook PWA bootstrap — registers the service worker and wires the
   update-consent UX. Loaded by index.html; no-op when unsupported.

   Update policy (same as labtestbook): the SW only detects a new deploy and
   posts 'tokenbook-update-available'. Nothing is applied until the user accepts
   the prompt in the app. A plain reload never picks up the new version. */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  var DEV = /[?&]dev=1(?:&|$)/.test(window.location.search);
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

  // localStorage flag so the status-bar indicator survives reloads.
  var PENDING_KEY = 'tokenbook.update.pending';

  function readPending() {
    try {
      return localStorage.getItem(PENDING_KEY) === '1';
    } catch (e) {
      return false;
    }
  }
  function setPending(on) {
    try {
      if (on) localStorage.setItem(PENDING_KEY, '1');
      else localStorage.removeItem(PENDING_KEY);
    } catch (e) {
      /* ignore */
    }
  }
  function showIndicator() {
    var el = document.getElementById('update-status');
    if (el) {
      el.hidden = false;
      el.textContent = 'update available';
    }
  }
  function hideIndicator() {
    var el = document.getElementById('update-status');
    if (el) el.hidden = true;
  }

  function withController(fn) {
    var c = navigator.serviceWorker.controller;
    if (c) fn(c);
    else
      navigator.serviceWorker.ready.then(function (reg) {
        // A hard reload (Ctrl+Shift+R) leaves the page uncontrolled: fall back to the active worker.
        var w = navigator.serviceWorker.controller || (reg && reg.active);
        if (w) fn(w);
      });
  }

  function applyNow() {
    withController(function (c) {
      c.postMessage({ type: 'tokenbook-apply-update' });
    });
  }

  window.addEventListener('load', function () {
    navigator.serviceWorker
      .register('./sw.js')
      .then(function () {
        if (readPending()) {
          showIndicator();
          // Verify the stale flag against the SW; it clears itself when nothing is pending.
          withController(function (c) {
            c.postMessage({ type: 'tokenbook-check-update' });
          });
        }
        if (!FORCE_UPDATE) return;
        withController(function (c) {
          c.postMessage({ type: 'tokenbook-force-update' });
        });
      })
      .catch(function (err) {
        if (window.console && console.warn) {
          console.warn('[tokenbook] SW registration failed:', err);
        }
      });
  });

  navigator.serviceWorker.addEventListener('message', function (event) {
    var d = event.data;
    if (!d || !d.type) return;
    if (d.type === 'tokenbook-update-available') {
      setPending(true);
      showIndicator();
      return;
    }
    if (d.type === 'tokenbook-update-none') {
      setPending(false);
      hideIndicator();
      window.dispatchEvent(new CustomEvent('tb:update-none'));
      return;
    }
    if (d.type === 'tokenbook-update-failed') {
      window.dispatchEvent(new CustomEvent('tb:update-failed'));
      return;
    }
    if (d.type === 'tokenbook-update-applied') {
      setPending(false);
      hideIndicator();
      window.location.reload();
    }
  });

  // Helpers for the app status bar / update dialog.
  window.__tbUpdate = {
    pending: readPending,
    applyNow: applyNow,
    openDialog: function () {
      window.dispatchEvent(new CustomEvent('tb:update-prompt'));
    },
  };
})();
