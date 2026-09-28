// Single-tab guard. Uses the Web Locks API (navigator.locks) to ensure only ONE
// tab of TokenBook is active at a time. First tab wins; a later tab's request
// is denied and the caller shows a "already open" screen.
//
// Release is automatic: Web Locks drops a tab's lock when the tab is closed,
// navigated away, or crashes — no heartbeat, no pagehide handler needed.
//
// Fallback: browsers without navigator.locks (older Safari) get a permissive
// pass (acquire returns { ok:true }) so the app still boots; the single-tab
// guarantee is lost there. Modern Chrome/Edge/Firefox/Safari 15.4+ are covered.

const LOCK_NAME = 'tokenbook-active-tab';

// Try to become the active tab. Resolves { ok, release? }.
//   ok=true  -> this tab owns the lock; the handle is held until the tab dies.
//   ok=false -> another tab already owns it; caller should show a block screen.
export function acquireTabLock() {
  if (!navigator.locks || typeof navigator.locks.request !== 'function') {
    return Promise.resolve({ ok: true }); // no support -> permissive
  }
  return new Promise((resolve) => {
    let releaseFn = null;
    // DO NOT await request(): when the callback returns a never-resolving
    // promise (holding the lock for the page lifetime), the outer await would
    // hang forever. Fire the request, then resolve our OWN promise from inside
    // the callback once granted/denied is known.
    navigator.locks
      .request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve({ ok: false });
          return; // denied: callback returns immediately
        }
        resolve({
          ok: true,
          release() {
            if (releaseFn) {
              const r = releaseFn;
              releaseFn = null;
              r();
            }
          },
        });
        // Hold the lock for the tab's lifetime. Web Locks releases it when the
        // tab unloads, so this promise never resolving is the intended state.
        return new Promise((r) => {
          releaseFn = r;
        });
      })
      .catch(() => resolve({ ok: false }));
  });
}
