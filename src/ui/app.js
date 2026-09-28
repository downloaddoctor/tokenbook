// Boot + global UI (topbar tabs, backup/restore buttons, initial DB open).
// Entry point loaded from index.html.
//
// Boot order:
//   openDb -> auth gate (create-admin | login | authed) -> bootAuthed(router)
// bootAuthed() is re-runnable: the Logout button calls it again after the gate
// clears, and the router survives across logout/login.

import db from '../core/db.js';
import backup, { hasFsAccess } from '../backup/backup.js';
import { Pages } from './pages/index.js';
import { createRouter, routeFromHash, setRouter, ADMIN_ONLY } from './router.js';
import { toast } from './toast.js';
import { showModal } from './dom.js';
import { requireAuth, currentUser, currentUserSync, isAdmin, logout } from '../core/auth.js';
import { setConfig, getConfig } from '../core/billing.js';
import { showAuthGate, hideGate } from './auth.js';
import { acquireTabLock } from '../core/tabLock.js';
import { install as installDiag, snapshot as diagSnapshot } from '../core/diag.js';

// ---------- restore helpers ----------

function restoreMsg(count, skipped, tail) {
  const base = 'Restored ' + count + ' visits ' + tail + '.';
  return skipped ? base + ' Skipped ' + skipped + ' bad row(s).' : base;
}

// Live progress in the statusbar (paperstamp/backup style). Toasts are for
// start + finish only; the per-tick numbers go here.
function setWork(label, processed, total) {
  const el = document.getElementById('work-status');
  if (!el) return;
  const pct = total ? Math.floor((processed / total) * 100) : 0;
  const counts =
    total != null
      ? ` ${processed.toLocaleString()}/${total.toLocaleString()} (${pct}%)`
      : '';
  el.textContent = label + counts;
  el.hidden = false;
}

function clearWork() {
  const el = document.getElementById('work-status');
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
}

// Progress adapter for onProgress callbacks: writes to the statusbar.
function mkProgressStatus(label) {
  return {
    update({ processed, total }) {
      setWork(label, processed, total);
    },
  };
}

// Re-read settings into billing after a restore (the log may carry settings).
async function reloadBillingConfig() {
  try {
    setConfig(await db.getSettings());
  } catch (_) { }
}

function reportRestore(r, tail) {
  if (!r.skipped) {
    toast(restoreMsg(r.count, 0, tail), 'ok');
    return;
  }
  const rep = backup.reportRestoreErrors({
    source: r.source || r.filename || tail,
    folderName: r.folderName || '',
    skippedRows: r.skippedRows || [],
  });
  console.warn('[restore] skipped rows:', r.skippedRows || []);
  if (rep) {
    console.warn('[restore] error report:\n' + rep.text);
    if (rep.filename) console.warn('[restore] downloaded ' + rep.filename);
  }
  const suffix = rep && rep.filename ? ' — see ' + rep.filename : '';
  toast(restoreMsg(r.count, r.skipped, tail) + suffix, 'err');
}

// Format a byte size for the picker.
function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

// Small element helper (matches the timeline modules' shape).
function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text == null ? '' : String(text);
  return s;
}

// Show the backup-source picker as a timeline (same look as History/Revisions).
// Resolves to a chosen entry or null.
async function pickRestoreSource() {
  const dlg = document.getElementById('restore-picker');
  const list = document.getElementById('restore-picker-list');
  const sub = document.getElementById('restore-picker-sub');
  const empty = document.getElementById('restore-picker-empty');
  if (!dlg || !list) return null;
  const groups = await backup.listBackups();
  const st = backup.state();
  if (sub) sub.textContent = st.folderName ? `Folder: ${st.folderName}` : '';
  list.innerHTML = '';
  let total = 0;
  const entryMap = new Map();

  // Read each entry's #details line (best-effort) for the timeline meta.
  const detailsMap = new Map();
  const allEntries = [
    ...(groups.latest ? [groups.latest] : []),
    ...groups.daily,
    ...groups.archive,
  ];
  await Promise.all(
    allEntries.map(async (e) => {
      try {
        detailsMap.set(e, await backup.readDetails(e));
      } catch (_) {
        detailsMap.set(e, null);
      }
    }),
  );

  const addGroup = (title, entries) => {
    if (!entries.length) return;
    const header = document.createElement('div');
    header.className = 'hx-group';
    header.textContent = title;
    list.appendChild(header);
    for (const e of entries) {
      total++;
      const key = 'src-' + total;
      entryMap.set(key, e);
      const d = detailsMap.get(e);

      const item = document.createElement('div');
      item.className = 'hx-item';
      item.dataset.key = key;
      item.tabIndex = -1;
      item.setAttribute('role', 'button');

      const dot = document.createElement('div');
      dot.className = 'hx-dot';

      const body = document.createElement('div');
      body.className = 'hx-body';

      const head = document.createElement('div');
      head.className = 'hx-head';
      const when = d && d.date ? d.date : e.date;
      head.append(
        span('hx-date', e.name),
        span('hx-badge', d && d.version ? d.version : '—'),
        span('hx-time', when ? new Date(when).toLocaleString() : '?'),
      );

      const meta = document.createElement('div');
      meta.className = 'hx-meta picker-models';
      if (d) {
        const pill = (label, n) => {
          if (n == null) return;
          const s = document.createElement('span');
          s.className = 'pill';
          s.textContent = `${n} ${label}`;
          meta.appendChild(s);
        };
        pill('visits', d.visits);
        pill('patients', d.people);
        pill('users', d.users);
        if (!meta.childElementCount) meta.textContent = fmtSize(e.size);
      } else {
        meta.textContent = fmtSize(e.size);
      }

      body.append(head, meta);
      item.append(dot, body);
      item.addEventListener('click', () => dlg.close(key));
      list.appendChild(item);
    }
  };
  addGroup('Latest', groups.latest ? [groups.latest] : []);
  addGroup('Daily snapshots', groups.daily);
  addGroup('Archived backups', groups.archive);
  if (empty) empty.hidden = total > 0;
  const picked = await showModal(dlg);
  return picked && entryMap.has(picked) ? entryMap.get(picked) : null;
}

async function restoreConfirm(folderName, summary) {
  const dlg = document.getElementById('restore-confirm');
  const sub = document.getElementById('restore-confirm-sub');
  if (!dlg || !sub) return false;
  sub.textContent = folderName ? `Folder: ${folderName}` : '';
  const info = document.getElementById('restore-confirm-info');
  if (info) {
    if (summary && summary.visits != null) {
      const ppl = summary.people != null ? summary.people : '?';
      info.textContent =
        `Incoming: ${summary.visits} visit${summary.visits === 1 ? '' : 's'}, ` +
        `${ppl} patient${ppl === 1 ? '' : 's'}` +
        `${summary.skipped ? ' (' + summary.skipped + ' bad row(s) skipped)' : ''}.`;
    } else {
      info.textContent = '';
    }
  }
  return (await showModal(dlg)) === 'restore';
}

// ---------- session ----------

// Cached "current session is admin". Read synchronously by the router's
// canAccess predicate (activateTab is sync). Refreshed by applySessionToShell
// before any route activation.
let sessionIsAdmin = false;

// Apply the signed-in user to the shell: show/hide admin-only tabs + whoami,
// wire the Logout button (once). Re-runnable after a re-login.
async function applySessionToShell(router) {
  const me = await currentUser();
  const admin = isAdmin(me);
  sessionIsAdmin = admin;
  const navUsers = document.getElementById('nav-users');
  const navPrintLayout = document.getElementById('nav-printLayout');
  const whoami = document.getElementById('whoami');
  const btnLogout = document.getElementById('btn-logout');
  if (whoami) {
    whoami.textContent = me ? me.username + (admin ? ' · admin' : ' · user') : '';
  }
  if (navUsers) navUsers.hidden = !admin;
  if (navPrintLayout) navPrintLayout.hidden = !admin;
  const btnSettings = document.getElementById('btn-settings');
  if (btnSettings) btnSettings.hidden = !admin;
  // Non-admins keep ONLY Backup in the statusbar: no Restore / Log / Test, and
  // no dev Seed/Clear even with ?dev=1. #file-restore is a programmatic-only
  // picker (always hidden in markup) — never toggle it or it renders as a
  // native "Choose File" control.
  for (const id of ['btn-restore', 'btn-log', 'btn-test']) {
    const n = document.getElementById(id);
    if (n) n.hidden = !admin;
  }
  // Dev Seed/Clear buttons (appended by the ?dev=1 block) are admin-only too.
  const devBar = document.getElementById('statusbar');
  if (devBar) {
    for (const b of devBar.querySelectorAll('.dev-only')) b.hidden = !admin;
  }
  // A non-admin left on an admin-only route is bounced to Register.
  if (!admin && ADMIN_ONLY.has(router.currentTab)) router.activateTab('register');
  if (btnLogout && !btnLogout._wired) {
    btnLogout._wired = true;
    btnLogout.addEventListener('click', async () => {
      await logout();
      toast('Signed out.', 'ok');
      await showAuthGate({ onAuthed: () => bootAuthed(router) });
    });
  }
}

// Settings modal: admin edits default fee + follow-up window. Persists to the
// meta 'settings' record and pushes the new values into billing.
function wireSettings(router) {
  const btn = document.getElementById('btn-settings');
  const dlg = document.getElementById('settings-dialog');
  const form = document.getElementById('settings-form');
  if (!btn || !dlg || !form) return;

  btn.addEventListener('click', async () => {
    if (!isAdmin(await currentUser())) {
      toast('Only admins can change settings.', 'err');
      return;
    }
    const cfg = getConfig();
    document.getElementById('set-fee').value = String(cfg.defaultFee);
    document.getElementById('set-followup').value = String(cfg.followupWindowDays);
    dlg.returnValue = '';
    dlg.showModal();
  });

  form.addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const fee = Number(document.getElementById('set-fee').value);
    const followup = Number(document.getElementById('set-followup').value);
    if (!Number.isFinite(fee) || fee < 0 || !Number.isFinite(followup) || followup < 0) {
      toast('Enter valid non-negative numbers.', 'err');
      return;
    }
    try {
      await db.setSettings({ defaultFee: fee, followupWindowDays: followup });
      setConfig({ defaultFee: fee, followupWindowDays: followup });
      toast('Settings saved.', 'ok');
      dlg.close('saved');
      // Apply the new default fee to the Register form (unless a saved visit is
      // loaded for editing, which must keep ITS fee).
      if (Pages.register && Pages.register.reseedFee) Pages.register.reseedFee();
      router.activateTab(router.currentTab, true);
    } catch (err) {
      toast('Save failed: ' + err.message, 'err');
    }
  });
}

// Everything that runs ONLY when a session exists. Split out of boot() so
// login/create-admin can drive the same sequence after the gate clears.
async function bootAuthed(router) {
  hideGate();
  await applySessionToShell(router);

  // Wire the DB actor hook once: every appended revision is stamped with the
  // current session's userId + username (denormalized so it survives renames).
  if (!bootAuthed._actorWired) {
    bootAuthed._actorWired = true;
    db.setActor(() => {
      const u = currentUserSync();
      return u
        ? { userId: u.id, userV: u.v != null ? u.v : 1 }
        : { userId: null, userV: null };
    });
  }

  // Load app settings into billing (defaultFee, followupWindowDays). Runs on
  // every bootAuthed so a settings change (or re-login) is always reflected.
  try {
    const s = await db.getSettings();
    setConfig(s);
  } catch (e) {
    console.warn('[tokenbook] settings load failed', e);
  }

  // Settings button (admin only) + modal wiring, once.
  if (!bootAuthed._settingsWired) {
    bootAuthed._settingsWired = true;
    wireSettings(router);
  }

  // Storage persistence: checked on boot AND re-checked at the start of every
  // full backup (see btnBackup), so a later denial / quota change is surfaced.
  async function checkPersistence() {
    if (!navigator.storage || !navigator.storage.persist) return null;
    try {
      return await navigator.storage.persist();
    } catch (err) {
      toast('Storage persistence check failed: ' + err.message, 'warn');
      return null;
    }
  }
  {
    const granted = await checkPersistence();
    if (granted === false) {
      toast('Storage not persistent — data may be cleared if disk fills.', 'warn');
    }
  }

  if (!bootAuthed._backupInited) {
    bootAuthed._backupInited = true;
    try {
      const r = await backup.init();
      if (r && r.dailySnapshot) {
        toast('Backup connected · daily snapshot ' + r.dailySnapshot, 'ok');
      } else if (r && r.ok) {
        toast('Backup connected' + (r.folderName ? ' · ' + r.folderName : ''), 'ok');
      } else if (r && r.reason === 'needs-gesture') {
        console.info('Backup folder set but permission needs a click — press Backup.');
      }
    } catch (e) {
      console.error('backup init', e);
    }
  }

  if (!location.hash) location.hash = '#/register';
  router.activateTab(routeFromHash(), false, false);

  // Dev tools: ?dev=1, ADMIN ONLY. Non-admins never get Seed/Clear, even with
  // the dev flag. Wired once.
  if (
    !bootAuthed._devWired &&
    sessionIsAdmin &&
    new URLSearchParams(location.search).get('dev') === '1'
  ) {
    bootAuthed._devWired = true;
    const { seed, clearAll, promptSeedConfig, SEED_CONFIG } = await import('../dev/seed.js');
    const bar = document.getElementById('statusbar');
    const right = bar && bar.querySelector('.statusbar-right');
    if (right) {
      const bSeed = document.createElement('button');
      bSeed.type = 'button';
      bSeed.className = 'dev-only';
      bSeed.textContent = 'Seed';
      bSeed.title = 'Click: seed defaults (10k visits/500 patients/200 days). Double-click: configure.';
      const runSeed = async (cfg) => {
        bSeed.disabled = true;
        bClear.disabled = true;
        toast(`Seed started: ${cfg.total.toLocaleString()} visits…`, 'warn');
        setWork('seeding', 0, cfg.total);
        try {
          const r = await seed({
            total: cfg.total,
            days: cfg.days,
            patients: cfg.patients,
            onProgress: (n, t) => setWork('seeding', n, t),
          });
          clearWork();
          toast(
            `Seeded ${r.people.toLocaleString()} patients, ${r.visits.toLocaleString()} visits in ${(r.ms / 1000).toFixed(1)}s.`,
            'ok'
          );
          router.activateTab(router.currentTab, true);
        } catch (e) {
          clearWork();
          toast('Seed failed: ' + e.message, 'err');
        } finally {
          bSeed.disabled = false;
          bClear.disabled = false;
        }
      };
      let seedClickTimer = null;
      bSeed.addEventListener('click', () => {
        if (seedClickTimer) return;
        seedClickTimer = setTimeout(() => {
          seedClickTimer = null;
          runSeed(SEED_CONFIG);
        }, 260);
      });
      bSeed.addEventListener('dblclick', () => {
        if (seedClickTimer) {
          clearTimeout(seedClickTimer);
          seedClickTimer = null;
        }
        const cfg = promptSeedConfig();
        if (cfg === null) return;
        runSeed(cfg);
      });
      const bClear = document.createElement('button');
      bClear.type = 'button';
      bClear.className = 'dev-only';
      bClear.textContent = 'Clear';
      bClear.title = 'Delete all people + visits';
      bClear.addEventListener('click', async () => {
        bClear.disabled = true;
        try {
          await clearAll();
          toast('Cleared all data.', 'ok');
          router.activateTab(router.currentTab, true);
        } catch (e) {
          toast('Clear failed: ' + e.message, 'err');
        } finally {
          bClear.disabled = false;
        }
      });
      right.append(bClear, bSeed);
    }
  }
}

// ---------- boot ----------

// Full-screen "already open" screen. No shell, no auth, no DB touched.
function showTabBlockedScreen(onRetry) {
  document.body.classList.add('auth-locked');
  for (const id of ['app-topbar', 'main', 'statusbar']) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  let root = document.getElementById('auth-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'auth-root';
    document.body.appendChild(root);
  }
  root.hidden = false;
  root.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'auth-wrap';
  const card = document.createElement('div');
  card.className = 'auth-card';
  const h = document.createElement('h1');
  h.className = 'auth-title';
  h.textContent = 'TokenBook is already open';
  const p = document.createElement('p');
  p.className = 'auth-sub';
  p.textContent = 'Only one tab can use TokenBook at a time. Close the other tab, then retry.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'primary auth-submit';
  btn.textContent = 'Retry';
  btn.addEventListener('click', () => onRetry());
  card.append(h, p, btn);
  wrap.appendChild(card);
  root.appendChild(wrap);
  btn.focus();
}

(async function boot() {
  // FIRST: single-tab guard. Must run before db.openDb() and the auth gate so
  // a second tab never touches IndexedDB or the session.
  let lock = await acquireTabLock();
  if (!lock.ok) {
    showTabBlockedScreen(() => location.reload());
    return;
  }
  // Re-probe on demand (Retry button reloads the page; no polling).

  // Capture warn/error lines for the Log dialog's "Copy diagnostics" button.
  installDiag();

  const btnBackup = document.getElementById('btn-backup');
  const btnRestore = document.getElementById('btn-restore');
  const btnLog = document.getElementById('btn-log');
  const btnTest = document.getElementById('btn-test');
  const fileRestore = document.getElementById('file-restore');

  const router = createRouter({
    pages: Pages,
    // Admin-only routes (printLayout, users) refuse to mount for non-admins,
    // even via a typed hash. Predicate MUST be synchronous: activateTab is sync.
    // The flag is refreshed by applySessionToShell before any activation.
    canAccess: (name) => sessionIsAdmin || !ADMIN_ONLY.has(name),
    onNewBill: () => {
      if (Pages.register && Pages.register.startNewBill) Pages.register.startNewBill();
    },
  });
  setRouter(router);
  router.wire();

  // Global Alt shortcuts: H history, L log (admin), B backup (any tab).
  window.addEventListener('keydown', async (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const k = e.key && e.key.toLowerCase();
    if (k !== 'h' && k !== 'l' && k !== 'b') return;
    e.preventDefault();
    if (k === 'l') {
      if (!sessionIsAdmin) return; // Log is admin-only
      if (btnLog) btnLog.click();
      return;
    }
    if (k === 'b') {
      btnBackup.click();
      return;
    }
    if (router.currentTab !== 'register') router.activateTab('register');
    const idEl = document.getElementById('f-patient-id');
    const id = idEl ? Number(idEl.value) : 0;
    if (!id) {
      toast('No patient ID in the form.', 'err');
      return;
    }
    const { openHistory } = await import('./history.js');
    await openHistory(id);
  });

  btnBackup.addEventListener('click', async () => {
    // Row 33: re-check persistence before every full backup so a later denial
    // (or a fresh origin permission change) is surfaced to the operator.
    try {
      if (navigator.storage && navigator.storage.persist) {
        const granted = await navigator.storage.persist();
        if (!granted) {
          toast('Storage not persistent — data may be cleared if disk fills.', 'warn');
        }
      }
    } catch (_) { /* best-effort */ }
    if (!hasFsAccess) {
      try {
        const r = await backup.downloadCsv();
        toast('Backup saved: ' + r.filename, 'ok');
      } catch (err) {
        toast('Backup failed: ' + err.message, 'err');
      }
      return;
    }
    try {
      const r = await backup.pickOrBackup();
      if (!r.lastAt) {
        toast('Backup folder set: ' + r.folderName, 'ok');
      } else {
        toast('Backup written to ' + r.folderName, 'ok');
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        try {
          const r = await backup.downloadCsv();
          toast('Backup saved: ' + r.filename, 'ok');
        } catch (e2) {
          toast('Backup failed: ' + e2.message, 'err');
        }
        return;
      }
      toast('Backup failed: ' + err.message, 'err');
    }
  });

  btnRestore.addEventListener('click', async () => {
    const st = backup.state();
    if (!st.hasFolder) {
      fileRestore.click();
      return;
    }
    const entry = await pickRestoreSource();
    if (!entry) return;
    let summary = null;
    try {
      const details = await backup.readDetails(entry);
      if (details) {
        summary = {
          visits: details.visits,
          people: details.people,
          skipped: 0,
        };
      }
    } catch (_) {
      summary = null;
    }
    if (!(await restoreConfirm(st.folderName, summary))) return;
    const p = mkProgressStatus('restoring');
    toast('Restore started: ' + entry.name, 'warn');
    setWork('restoring', 0, summary && summary.visits ? summary.visits : null);
    try {
      const r = await backup.restoreFromEntry(entry, { onProgress: p.update });
      clearWork();
      reportRestore(r, 'from ' + r.source);
      await reloadBillingConfig();
      router.activateTab(router.currentTab, true);
    } catch (err) {
      clearWork();
      if (err && err.name === 'AbortError') return;
      toast('Restore failed: ' + err.message, 'err');
    }
  });

  fileRestore.addEventListener('change', async () => {
    const f = fileRestore.files && fileRestore.files[0];
    fileRestore.value = '';
    if (!f) return;
    const p = mkProgressStatus('restoring');
    toast('Restore started: ' + f.name, 'warn');
    setWork('restoring', 0, null);
    try {
      const r = await backup.restoreFromFileObject(f, { onProgress: p.update });
      clearWork();
      reportRestore(r, 'from ' + r.filename);
      await reloadBillingConfig();
      router.activateTab(router.currentTab, true);
    } catch (err) {
      clearWork();
      toast('Restore failed: ' + err.message, 'err');
    }
  });

  // Inject the "Copy diagnostics" button into the Log dialog footer once.
  // Called from BOTH Log-dialog branches (folder set OR no folder) so the
  // button is always available.
  function ensureDiagButton(dlg) {
    const footer = dlg.querySelector('.modal-actions');
    if (!footer || footer._diagWired) return;
    footer._diagWired = true;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Copy diagnostics';
    btn.title = 'Copy app + backup + DB state + recent console to clipboard';
    btn.addEventListener('click', async () => {
      try {
        const text = await diagSnapshot({
          db,
          backup,
          appVersion: db.APP_VERSION != null ? db.APP_VERSION : undefined,
        });
        await navigator.clipboard.writeText(text);
        toast('Diagnostics copied to clipboard.', 'ok');
      } catch (e) {
        toast('Copy failed: ' + (e && e.message ? e.message : e), 'err');
      }
    });
    // Place it at the end, after the Close button (if present).
    footer.appendChild(btn);
  }

  if (btnLog) {
    btnLog.addEventListener('click', async () => {
      const dlg = document.getElementById('log-dialog');
      const sub = document.getElementById('log-sub');
      const body = document.getElementById('log-body');
      if (!dlg || !sub || !body) return;

      const st = backup.state();
      if (!st.hasFolder) {
        const all = await db.exportAll();
        sub.textContent =
          `No backup folder set · ${all.count} visit${all.count === 1 ? '' : 's'} in DB, none on disk`;
        body.textContent =
          'No backup folder set. Nothing is being written to a log file.\n' +
          'Press Backup (bottom bar) to choose a folder.\n\n' +
          'NOT BACKED UP (no folder)\n' +
          '─────────────────────────\n' +
          (all.text ? all.text.trimEnd() : '(no visits)');
        ensureDiagButton(dlg);
        dlg.returnValue = '';
        dlg.showModal();
        return;
      }

      const [csv, dbCount, pendingLines] = await Promise.all([
        backup.readLog(),
        db.countAll(),
        Promise.resolve(backup.pendingLines()),
      ]);
      // Pending-queue "why not flushed?" hint. Mirrors backup.flush()'s gates.
      const pendingReason =
        pendingLines.length === 0 ? 'nothing queued'
        : !st.hasFolder ? 'no folder set'
        : st.lastError ? 'last flush error: ' + st.lastError
        : 'idle — debounce pending (2s)';

      const parts = [];
      body.textContent = '';
      parts.push(`DB · ${dbCount} visit${dbCount === 1 ? '' : 's'}`);
      parts.push(`Pending · ${pendingLines.length} (${pendingReason})`);

      let csvLineCount = 0;
      if (csv.text != null) {
        csvLineCount = csv.text.split('\n').filter((l) => l.length > 0).length - 1;
        parts.push(`${csv.source} · ${Math.max(0, csvLineCount)} entries`);
      } else {
        parts.push(
          csv.source === 'no-folder'
            ? 'No folder set'
            : csv.source === 'empty'
              ? 'No CSV yet'
              : 'CSV error'
        );
      }
      sub.textContent = parts.join('  ·  ');

      const section = (title, text) => {
        const header = title + '\n' + '─'.repeat(title.length) + '\n';
        body.textContent += header + (text ? text.trimEnd() : '(none)') + '\n\n';
      };

      section('PENDING FLUSH (' + pendingLines.length + ') — ' + pendingReason, pendingLines.join('\n'));
      if (csv.text != null) section('CSV · ' + csv.source, csv.text);
      else if (csv.source === 'error') section('CSV ERROR', csv.error || 'unknown');

      ensureDiagButton(dlg);

      dlg.returnValue = '';
      dlg.showModal();
    });
  }

  if (btnTest) {
    btnTest.addEventListener('click', async () => {
      const dlg = document.getElementById('test-dialog');
      const sub = document.getElementById('test-sub');
      const body = document.getElementById('test-body');
      if (!dlg || !sub || !body) return;
      sub.textContent = 'running…';
      body.textContent = '';
      btnTest.disabled = true;
      const lines = [];
      const render = (text) => {
        lines.push(text);
        body.textContent = lines.join('\n');
        body.scrollTop = body.scrollHeight;
      };
      try {
        const { runSelfTest } = await import('../dev/selftest.js');
        const r = await runSelfTest({
          router,
          onProgress: (name, ok, detail, status) => {
            if (name === '#stage') render('=== ' + detail + ' ===');
            else if (name === '#info') render('· ' + detail);
            else {
              const mark = status === 'SKIP' ? '–' : ok ? '✓' : '✗';
              render(`${mark} ${name}${detail ? '  —  ' + detail : ''}`);
            }
          },
          confirmReplay: async () => true,
        });
        const tally =
          `${r.passed} passed · ${r.failed} failed` +
          (r.skipped ? ` · ${r.skipped} skipped` : '');
        sub.textContent = r.ok ? `all good — ${tally}` : `${r.failed} FAILED — ${tally}`;
        render('');
        render(r.ok ? 'RESULT: ALL PASSED' : 'RESULT: FAILURES — see ✗ lines above');
        toast(
          r.ok ? `Self-test passed (${tally}).` : `Self-test: ${r.failed} failed.`,
          r.ok ? 'ok' : 'err'
        );
      } catch (err) {
        sub.textContent = 'error';
        render('ERROR: ' + (err && err.message ? err.message : String(err)));
        toast('Self-test error: ' + (err && err.message ? err.message : String(err)), 'err');
      } finally {
        btnTest.disabled = false;
        dlg.returnValue = '';
        dlg.showModal();
      }
    });
  }

  db.setMigrationNotice(({ filename, stores }) => {
    toast(
      'Old database backed up (' + stores + ' store(s)) → ' + filename + '. Starting fresh.',
      'warn'
    );
    console.info('[tokenbook] pre-migration backup saved:', filename);
  });

  try {
    await db.openDb();
  } catch (err) {
    console.error('IndexedDB open failed', err);
    toast('Could not open local database: ' + err.message, 'err');
    return;
  }

  // Auth gate: create-admin | login | authed.
  const gate = await requireAuth();
  if (gate.state === 'authed') {
    await bootAuthed(router);
  } else {
    await showAuthGate({ onAuthed: () => bootAuthed(router) });
  }
})().catch((err) => {
  console.error('boot failed', err);
  try {
    toast('Startup failed: ' + (err && err.message ? err.message : String(err)), 'err');
  } catch (_) { }
});
