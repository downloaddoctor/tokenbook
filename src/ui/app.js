// Boot + global UI (topbar tabs, backup/restore buttons, initial DB open).
// Entry point loaded from index.html as <script type="module" src="src/ui/app.js">.

import { PatientDb } from '../core/db.js';
import { PatientBackup } from '../backup/backup.js';
import { Pages } from './pages/index.js';
import { createRouter, routeFromHash } from './router.js';
import { toast } from './toast.js';

// Styled confirm used before a destructive restore. Returns true if the user
// confirmed, false on cancel / Esc / backdrop.
function restoreConfirm(folderName) {
  return new Promise((resolve) => {
    const dlg = document.getElementById('restore-confirm');
    const sub = document.getElementById('restore-confirm-sub');
    if (!dlg || !sub) return resolve(false); // fail closed
    sub.textContent = folderName ? `Folder: ${folderName}` : '';
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
  const fileRestore = document.getElementById('file-restore');

  const router = createRouter({
    pages: Pages,
    onNewBill: () => {
      if (Pages.register && Pages.register.startNewBill) Pages.register.startNewBill();
    },
  });
  router.wire();

  btnBackup.addEventListener('click', async () => {
    // No File System Access -> CSV download instead of picking a folder.
    if (!PatientBackup.hasFsAccess) {
      try {
        const r = await PatientBackup.downloadCsv();
        toast('Backup saved: ' + r.filename, 'ok');
      } catch (err) {
        toast('Backup failed: ' + err.message, 'err');
      }
      return;
    }
    try {
      const r = await PatientBackup.pickOrBackup();
      if (!r.lastAt) {
        toast('Backup folder set: ' + r.folderName, 'ok');
      } else {
        toast('Backup written to ' + r.folderName, 'ok');
      }
    } catch (err) {
      // User cancelled the folder picker -> silently fall back to CSV.
      if (err && err.name === 'AbortError') {
        try {
          const r = await PatientBackup.downloadCsv();
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
    const st = PatientBackup.state();
    if (!st.hasFolder) {
      fileRestore.click();
      return;
    }
    if (!(await restoreConfirm(st.folderName))) return;
    try {
      const r = await PatientBackup.restoreFromFolder();
      toast('Restored ' + r.count + ' visits from ' + r.source + '.', 'ok');
      router.activateTab(router.currentTab, true);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      toast('Restore failed: ' + err.message, 'err');
    }
  });

  fileRestore.addEventListener('change', async () => {
    const f = fileRestore.files && fileRestore.files[0];
    fileRestore.value = '';
    if (!f) return;
    try {
      const r = await PatientBackup.restoreFromFileObject(f);
      toast('Restored ' + r.count + ' visits from ' + r.filename + '.', 'ok');
      router.activateTab(router.currentTab, true);
    } catch (err) {
      toast('Restore failed: ' + err.message, 'err');
    }
  });

  if (btnLog) {
    btnLog.addEventListener('click', async () => {
      const dlg = document.getElementById('log-dialog');
      const sub = document.getElementById('log-sub');
      const body = document.getElementById('log-body');
      if (!dlg || !sub || !body) return;
      const r = await PatientBackup.readLog();
      if (r.text == null) {
        sub.textContent =
          r.source === 'no-folder'
            ? 'No backup folder set.'
            : r.source === 'empty'
              ? 'No log file yet.'
              : 'Error: ' + (r.error || r.source);
        body.textContent = '';
      } else {
        const lines = r.text.split('\n').filter((l) => l.length > 0);
        sub.textContent = `${r.source} · ${Math.max(0, lines.length - 1)} entries`;
        body.textContent = r.text.trimEnd();
      }
      dlg.returnValue = '';
      dlg.showModal();
    });
  }

  try {
    await PatientDb.openDb();
  } catch (err) {
    console.error('IndexedDB open failed', err);
    toast('Could not open local database: ' + err.message, 'err');
    return;
  }

  try {
    const r = await PatientBackup.init();
    if (r && r.reason === 'needs-gesture') {
      console.info('Backup folder set but permission needs a click — press Backup.');
    }
  } catch (e) {
    console.error('backup init', e);
  }

  if (!location.hash) location.hash = '#/register';
  router.activateTab(routeFromHash(), false, false);

  // Dev tools: enabled with ?dev=1. Seeding is destructive (clears DB) so it
  // stays opt-in. Add a status-bar button pair when the flag is set.
  if (new URLSearchParams(location.search).get('dev') === '1') {
    const { seed, clearAll } = await import('../dev/seed.js');
    const bar = document.getElementById('statusbar');
    const right = bar && bar.querySelector('.statusbar-right');
    if (right) {
      const bSeed = document.createElement('button');
      bSeed.type = 'button';
      bSeed.textContent = 'Seed';
      bSeed.title = 'Generate 100,000 visits over 90 days from a pool of 20,000 patients';
      bSeed.addEventListener('click', async () => {
        bSeed.disabled = true;
        bClear.disabled = true;
        const TOTAL = 100;
        try {
          const r = await seed({
            total: TOTAL,
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
})();
