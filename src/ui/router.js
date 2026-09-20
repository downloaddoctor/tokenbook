// Router: tab activation, hash sync, keyboard shortcuts.
// Owns: nav-tab clicks, hashchange listener, keydown shortcuts.
// Calls pages[name].mount()/unmount() around visibility toggles.

export const ROUTES = ['register', 'tokens', 'patients', 'printLayout'];

// Route id -> DOM section id. Route ids use camelCase; section ids use
// kebab-case for readability. Keep them in sync via this map.
const PAGE_ID = {
  register: 'page-register',
  tokens: 'page-tokens',
  patients: 'page-patients',
  printLayout: 'page-print-layout',
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

export function createRouter({ pages, onNewBill } = {}) {
  let currentTab = null;

  function activateTab(name, force = false, syncHash = true) {
    if (!ROUTES.includes(name)) name = 'register';
    if (currentTab === name && !force) return;

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
        if (currentTab !== 'billing') activateTab('billing');
        if (typeof onNewBill === 'function') onNewBill();
        return;
      }
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > ROUTES.length) return;
      e.preventDefault();
      activateTab(ROUTES[n - 1]);
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
