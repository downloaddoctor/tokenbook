// Boot + global UI (topbar tabs, backup/restore buttons, initial DB open).
// Entry point loaded from index.html.

import db from '../core/db.js';
import backup, { hasFsAccess } from '../backup/backup.js';
import { csvToLog } from '../backup/csv.js';
import { Pages } from './pages/index.js';
import { createRouter, routeFromHash, setRouter } from './router.js';
import { toast } from './toast.js';

// Restore result message. Flags skipped rows so the operator knows the restore
// was not 1:1 with the file.
function restoreMsg(count, skipped, tail) {
  const base = 'Restored ' + count + ' visits ' + tail + '.';
  return skipped ? base + ' Skipped ' + skipped + ' bad row(s).' : base;
}

// Reusable progress toast during a restore. Single toast (replaced each tick),
// cleared by done() so the final report isn't stacked behind it.
function mkProgressToast() {
  let active = false;
  return {
    update({ processed, total, restored, skipped }) {
      active = true;
      toast(
        'Restoring ' + processed + '/' + total + ' · ok ' + restored + ' · skip ' + skipped,
        'warn',
      );
    },
    done() {
      if (active) toast('');
      active = false;
    },
  };
}

// Report a restore result: toast, console dump of skip detail, and an
// error.log (folder + download) when rows were skipped.
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
  // Console dump — always available, even if the file write failed.
  console.warn('[restore] skipped rows:', r.skippedRows || []);
  if (rep) {
    console.warn('[restore] error report:\n' + rep.text);
    if (rep.filename) console.warn('[restore] downloaded ' + rep.filename);
  }
  const suffix = rep && rep.filename ? ' — see ' + rep.filename : '';
  toast(restoreMsg(r.count, r.skipped, tail) + suffix, 'err');
}

// Styled confirm before a destructive restore. Reads the incoming log first and
// shows "N visits, M patients" so the operator can verify the source. Resolves
// true if confirmed, false on cancel/Esc/backdrop.
function restoreConfirm(folderName, summary) {
  return new Promise((resolve) => {
    const dlg = document.getElementById('restore-confirm');
    const sub = document.getElementById('restore-confirm-sub');
    if (!dlg || !sub) return resolve(false); // fail closed
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
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'restore');
    };
    dlg.returnValue = '';
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

(async function boot() {
  const btnBackup = document.getElementById('btn-backup');
  const btnRestore = document.getElementById('btn-restore');
  const btnLog = document.getElementById('btn-log');
  const btnTest = document.getElementById('btn-test');
  const fileRestore = document.getElementById('file-restore');

  const router = createRouter({
    pages: Pages,
    onNewBill: () => {
      if (Pages.register && Pages.register.startNewBill) Pages.register.startNewBill();
    },
  });
  setRouter(router);
  router.wire();

  // Global Alt shortcuts: H history, L log, B backup (work from any tab).
  window.addEventListener('keydown', async (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const k = e.key && e.key.toLowerCase();
    if (k !== 'h' && k !== 'l' && k !== 'b') return;
    e.preventDefault();
    if (k === 'l') {
      if (btnLog) btnLog.click();
      return;
    }
    if (k === 'b') {
      btnBackup.click();
      return;
    }
    // Alt+H: open the history modal for the patient id in the Register form
    // (works from any tab; focuses Register if needed).
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
    // No File System Access -> CSV download instead of picking a folder.
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
      // User cancelled the folder picker -> silently fall back to CSV.
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
    // Read the incoming log first so the confirm can show what will be restored.
    let summary = null;
    try {
      const lg = await backup.readLog();
      if (lg.text) {
        const parsed = csvToLog(lg.text);
        const people = new Set();
        for (const op of parsed.ops) if (op.personId != null) people.add(op.personId);
        summary = {
          visits: parsed.ops.length,
          people: people.size,
          skipped: parsed.skippedRows.length,
        };
      }
    } catch (_) {
      summary = null; // unreadable/invalid log -> confirm still proceeds, no counts
    }
    if (!(await restoreConfirm(st.folderName, summary))) return;
    const p = mkProgressToast();
    try {
      const r = await backup.restoreFromFolder({ onProgress: p.update });
      p.done();
      reportRestore(r, 'from ' + r.source);
      router.activateTab(router.currentTab, true);
    } catch (err) {
      p.done();
      if (err && err.name === 'AbortError') return;
      toast('Restore failed: ' + err.message, 'err');
    }
  });

  fileRestore.addEventListener('change', async () => {
    const f = fileRestore.files && fileRestore.files[0];
    fileRestore.value = '';
    if (!f) return;
    const p = mkProgressToast();
    try {
      const r = await backup.restoreFromFileObject(f, { onProgress: p.update });
      p.done();
      reportRestore(r, 'from ' + r.filename);
      router.activateTab(router.currentTab, true);
    } catch (err) {
      p.done();
      toast('Restore failed: ' + err.message, 'err');
    }
  });

  if (btnLog) {
    btnLog.addEventListener('click', async () => {
      const dlg = document.getElementById('log-dialog');
      const sub = document.getElementById('log-sub');
      const body = document.getElementById('log-body');
      if (!dlg || !sub || !body) return;

      // No folder set: backup is off. Show what WOULD be logged, clearly
      // labelled as not backed up, so the operator sees the gap.
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
        dlg.returnValue = '';
        dlg.showModal();
        return;
      }

      const [csv, dbCount, pendingLines] = await Promise.all([
        backup.readLog(),
        db.countAll(),
        Promise.resolve(backup.pendingLines()),
      ]);

      const parts = [];
      body.textContent = '';

      // 1) DB rows — source of truth.
      parts.push(`DB · ${dbCount} visit${dbCount === 1 ? '' : 's'}`);

      // 2) Pending journal entries — queued but not yet flushed.
      parts.push(`Pending · ${pendingLines.length}`);

      // 3) CSV on disk — latest.csv (or newest snapshot).
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

      section('PENDING FLUSH', pendingLines.join('\n'));
      if (csv.text != null) section('CSV · ' + csv.source, csv.text);
      else if (csv.source === 'error') section('CSV ERROR', csv.error || 'unknown');

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
            if (name === '#stage') render('--- ' + detail + ' ---');
            else if (name === '#info') render('    · ' + detail);
            else render((status || (ok ? 'PASS' : 'FAIL')) + ' ' + name + (detail ? '  (' + detail + ')' : ''));
          },
          // No confirm: the self-test runs on an isolated DB (tokenbook-devtest)
          // that is dropped afterwards, so replay cannot destroy real data.
          confirmReplay: async () => true,
        });
        const tally =
          `${r.passed} passed` +
          (r.skipped ? `, ${r.skipped} skipped` : '') +
          (r.failed ? `, ${r.failed} failed` : '');
        sub.textContent = r.ok
          ? `all good — ${tally}`
          : `${r.failed} FAILED — ${tally}`;
        render('');
        render(r.ok ? 'RESULT: ALL PASSED' : 'RESULT: FAILURES — see FAIL lines above');
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

  // If a pre-revision DB is found, db dumps it to a JSON file and recreates.
  // Surface the download so the operator knows a backup exists.
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

  // Ask the browser to mark our origin's storage persistent so IndexedDB
  // isn't evicted under disk pressure. Usually auto-granted for installed
  // PWAs on Chrome/Edge. Quiet on success; toast only on failure.
  if (navigator.storage && navigator.storage.persist) {
    try {
      const granted = await navigator.storage.persist();
      if (!granted) {
        toast('Storage not persistent — data may be cleared if disk fills.', 'warn');
      }
    } catch (err) {
      toast('Storage persistence check failed: ' + err.message, 'warn');
    }
  }

  try {
    const r = await backup.init();
    if (r && r.dailySnapshot) {
      // First open of the date -> a fresh daily snapshot was taken.
      toast('Backup connected · daily snapshot ' + r.dailySnapshot, 'ok');
    } else if (r && r.ok) {
      // Folder connected; snapshot already existed for today.
      toast('Backup connected' + (r.folderName ? ' · ' + r.folderName : ''), 'ok');
    } else if (r && r.reason === 'needs-gesture') {
      console.info('Backup folder set but permission needs a click — press Backup.');
    }
  } catch (e) {
    console.error('backup init', e);
  }

  if (!location.hash) location.hash = '#/register';
  router.activateTab(routeFromHash(), false, false);

  // Dev tools: enabled with ?dev=1. Seeding is destructive (clears DB) so it
  // stays opt-in.
  if (new URLSearchParams(location.search).get('dev') === '1') {
    const { seed, clearAll, promptSeedConfig, SEED_CONFIG } = await import('../dev/seed.js');
    const bar = document.getElementById('statusbar');
    const right = bar && bar.querySelector('.statusbar-right');
    if (right) {
      const bSeed = document.createElement('button');
      bSeed.type = 'button';
      bSeed.textContent = 'Seed';
      bSeed.title = 'Click: seed defaults (10k visits/500 patients/200 days). Double-click: configure.';
      const runSeed = async (cfg) => {
        bSeed.disabled = true;
        bClear.disabled = true;
        try {
          const r = await seed({
            total: cfg.total,
            days: cfg.days,
            patients: cfg.patients,
            onProgress: (n, t) => toast(`Seeding ${n.toLocaleString()}/${t.toLocaleString()} entries…`),
          });
          toast(
            `Seeded ${r.people.toLocaleString()} patients, ${r.visits.toLocaleString()} visits in ${(r.ms / 1000).toFixed(1)}s.`,
            'ok'
          );
          router.activateTab(router.currentTab, true);
        } catch (e) {
          toast('Seed failed: ' + e.message, 'err');
        } finally {
          bSeed.disabled = false;
          bClear.disabled = false;
        }
      };
      // Single click seeds defaults; double click opens the config dialog. A
      // browser fires click-then-dblclick, so delay the single-click action and
      // cancel it if a second click arrives within the threshold.
      let seedClickTimer = null;
      bSeed.addEventListener('click', () => {
        if (seedClickTimer) return; // second click of a double-click
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
        if (cfg === null) return; // cancelled
        runSeed(cfg);
      });
      const bClear = document.createElement('button');
      bClear.type = 'button';
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
})().catch((err) => {
  // Fatal boot error: surface it instead of leaving a dead statusbar.
  console.error('boot failed', err);
  try {
    toast('Startup failed: ' + (err && err.message ? err.message : String(err)), 'err');
  } catch (_) {
    /* toast not ready yet — nothing more we can do */
  }
});
