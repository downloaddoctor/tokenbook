// Router: tab activation, hash sync, keyboard shortcuts.
// Owns nav-tab clicks, hashchange, and keydown. Calls pages[name].mount/unmount.

export const ROUTES = ['register', 'tokens', 'patients', 'printLayout', 'users'];

// Routes only an admin may activate. Non-admins are bounced to 'register' by
// activateTab, so a typed hash or stale link cannot reach them. The matching
// nav tabs are hidden in app.js (applySessionToShell).
export const ADMIN_ONLY = new Set(['printLayout', 'users']);

// Primary input focused on Alt+1..N. Missing / printLayout -> no focus change.
const FOCUS_ON_ACTIVATE = {
  register: 'f-name',
  patients: 'patients-search',
};

// Module holder so pages can switch tabs without threading a reference.
// Set once in app.js.
let _router = null;
export function setRouter(r) {
  _router = r;
}
export function getRouter() {
  return _router;
}

// Route id (camelCase) -> section id (kebab-case). Keep in sync via this map.
const PAGE_ID = {
  register: 'page-register',
  tokens: 'page-tokens',
  patients: 'page-patients',
  printLayout: 'page-print-layout',
  users: 'page-users',
};

function pageEl(name) {
  return document.getElementById(PAGE_ID[name] || 'page-' + name);
}

function setActiveNav(name) {
  document.querySelectorAll('.tabs .nav-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.route === name);
  });
}

export function routeFromHash() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  return ROUTES.includes(h) ? h : 'register';
}

export function createRouter({ pages, onNewBill, canAccess } = {}) {
  let currentTab = null;

  // Default: everything allowed. app.js passes a predicate that knows whether
  // the current user is an admin.
  const allowed = typeof canAccess === 'function' ? canAccess : () => true;

  function activateTab(name, force = false, syncHash = true) {
    if (!ROUTES.includes(name)) name = 'register';
    // Guard: an admin-only route requested by a non-admin falls back to
    // register. Force a hash resync so a typed #/printLayout is rewritten.
    if (ADMIN_ONLY.has(name) && !allowed(name)) {
      name = 'register';
      syncHash = true;
    }
    if (currentTab === name && !force) {
      if (syncHash) location.hash = '#/' + name;
      return;
    }

    if (currentTab && pages[currentTab] && pages[currentTab].unmount) pages[currentTab].unmount();
    for (const r of ROUTES) {
      const n = pageEl(r);
      if (n) n.hidden = r !== name;
    }
    currentTab = name;
    setActiveNav(name);
    if (syncHash) location.hash = '#/' + name;
    if (pages[name] && pages[name].mount) pages[name].mount();
  }

  function wire() {
    document.querySelectorAll('.tabs .nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => activateTab(btn.dataset.route));
    });

    window.addEventListener('hashchange', () => activateTab(routeFromHash(), false, false));

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.shiftKey) return;
      if (e.ctrlKey === e.altKey) return; // require exactly one of Ctrl/Alt
      if (e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        if (currentTab !== 'register') activateTab('register');
        if (typeof onNewBill === 'function') onNewBill();
        return;
      }
      if (!e.altKey) return; // Alt+1..4 switch + focus
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > ROUTES.length) return;
      e.preventDefault();
      const name = ROUTES[n - 1];
      // Only remount when actually switching; if already here, just focus.
      if (name !== currentTab) activateTab(name);
      const id = FOCUS_ON_ACTIVATE[name];
      const target = id && document.getElementById(id);
      if (target) target.focus();
    });
  }

  return {
    activateTab,
    wire,
    get currentTab() {
      return currentTab;
    },
  };
}
