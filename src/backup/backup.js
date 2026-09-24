// Backup / restore to a user-chosen folder (pendrive) via File System Access API.
//
// Logbook model: every write APPENDS one line to tokenbook-latest.csv (no
// rewriting). Header written once at file creation. On the first write of each
// day, latest.csv is snapshotted to tokenbook-YYYY-MM-DD.csv (newest KEEP).
//
// Restore reads the log in file order and replays through db.replayLog — the
// same write path that produced it. Log is append-only; one self-describing row
// per write; delimiter '|'; timestamps epoch-seconds.
//
// Default export = singleton; `import backup from './backup.js'`.

import db from '../core/db.js';
import {
  csvHeaderLine,
  visitInputToLogLine,
  csvToLog,
  parseBackup,
} from './csv.js';
import meta from './meta.js';
import { timeAgo } from '../core/time.js';

const DEFAULT_LATEST = 'tokenbook-latest.csv';
const SNAP_RE = /^tokenbook-(\d{4}-\d{2}-\d{2})\.csv$/;
const KEEP_SNAPSHOTS = 30;
const DEBOUNCE_MS = 2000;
const HANDLE_KEY = 'dirHandle';

export const hasFsAccess = typeof window.showDirectoryPicker === 'function';

class Backup {
  constructor() {
    // Log file name — swappable so self-test uses tokenbook-latest-devtest.csv.
    this.LATEST = DEFAULT_LATEST;
    this._dir = null;
    this._dirty = false;
    this._timer = null;
    this._writing = false;
    // In-flight flush promise: flush() chains onto it so concurrent callers
    // serialize instead of no-oping.
    this._flushPromise = null;
    this._lastAt = '';
    this._lastCount = 0;
    this._lastError = '';
    this._lastErrorName = '';
    // Pending journal entries (raw inputs). Drained by flush() in order.
    this._pending = [];
    // True when latest.csv needs a header prepended (fresh file / truncate).
    this._needsHeader = false;
    // Bound once so db.setJournal gets a stable fn.
    this._markDirty = this.markDirty.bind(this);
  }

  // ---------- status line ----------

  timeAgo(when) {
    return timeAgo(when, { compact: true, fallback: 'never' });
  }

  updateStatus() {
    const el = document.getElementById('backup-status');
    if (!el) return;
    if (!hasFsAccess) {
      el.textContent = 'backup: unsupported';
      el.className = 'status';
      return;
    }
    if (!this._dir) {
      el.textContent = 'backup: off';
      el.className = 'status';
      return;
    }
    // Idle = "2m ago" (since last success); queued rows add "N pending".
    // Errors take priority.
    const queued = this._pending.length;
    const ago = this._lastAt ? this.timeAgo(this._lastAt) : 'ready';
    const queuedStr = queued ? `${queued} pending · ` : '';
    if (this._lastError) {
      el.textContent = 'backup: ✗ ' + this._lastError + (queued ? ` · ${queued} pending` : '');
      el.className = 'status err';
      return;
    }
    el.textContent = `backup: ${queuedStr}${ago}`;
    el.className = 'status ok';
  }

  // ---------- folder IO ----------

  async fileExists(dir, name) {
    try {
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  async writeText(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }

  // Append text without rewriting the file body.
  async appendText(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    const file = await fh.getFile();
    const w = await fh.createWritable({ keepExistingData: true });
    await w.seek(file.size);
    await w.write(text);
    await w.close();
  }

  async pruneSnapshots(dir) {
    const snaps = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && SNAP_RE.test(name)) snaps.push(name);
    }
    if (snaps.length <= KEEP_SNAPSHOTS) return;
    snaps.sort();
    for (const n of snaps.slice(0, snaps.length - KEEP_SNAPSHOTS)) {
      try {
        await dir.removeEntry(n);
      } catch {}
    }
  }

  async readLatest(dir) {
    try {
      const fh = await dir.getFileHandle(this.LATEST);
      const f = await fh.getFile();
      return await f.text();
    } catch {
      return null;
    }
  }

  async readNewestSnapshot(dir) {
    const snaps = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && SNAP_RE.test(name)) snaps.push({ name, handle });
    }
    if (!snaps.length) return null;
    snaps.sort((a, b) => b.name.localeCompare(a.name));
    const f = await snaps[0].handle.getFile();
    return await f.text();
  }

  // One encoder for both ops: refunds are full rows too (see csv.js).
  formatLogEntry(entry) {
    return visitInputToLogLine(entry);
  }

  // ---------- public ops ----------

  async loadPersistedHandle() {
    if (!hasFsAccess) return null;
    try {
      return await meta.get(HANDLE_KEY);
    } catch {
      return null;
    }
  }

  // True when an error means the saved folder handle no longer resolves to a
  // real dir (deleted/moved/revoked). These clear the handle so the next Backup
  // click re-opens the picker instead of failing forever.
  isStaleHandleError(e) {
    if (!e) return false;
    const name = e.name || '';
    if (name === 'NotFoundError') return true;
    // Chromium reports missing/renamed dir as NotAllowedError on some versions.
    if (name === 'NotAllowedError') return true;
    return false;
  }

  // Probe the handle with a cheap directory read. Throws if the dir is gone.
  async validateHandle(h) {
    for await (const _ of h.entries()) break;
    return true;
  }

  async init() {
    db.setJournal(this._markDirty);
    this.updateStatus();
    if (!hasFsAccess) return { ok: false, reason: 'unsupported' };
    const h = await this.loadPersistedHandle();
    if (!h) return { ok: false, reason: 'no-handle' };
    // Drop a stale handle (folder deleted/moved) before using it.
    try {
      await this.validateHandle(h);
    } catch (e) {
      if (this.isStaleHandleError(e)) {
        await this.clearFolder();
        return { ok: false, reason: 'stale-handle' };
      }
    }
    this._dir = h;
    let perm = 'prompt';
    try {
      perm = await h.queryPermission({ mode: 'readwrite' });
    } catch {
      perm = 'prompt';
    }
    if (perm === 'granted') {
      this.updateStatus();
      return { ok: true, folderName: h.name || '' };
    }
    this.updateStatus();
    return { ok: false, reason: 'needs-gesture', folderName: h.name || '' };
  }

  // ALWAYS opens the picker, then does a FULL DB write (overwrites latest.csv +
  // daily snapshot). Auto-backup (markDirty) still appends.
  async setFolder() {
    if (!hasFsAccess) throw new Error('File System Access not supported in this browser.');
    const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'tokenbook-backup' });
    this._dir = h;
    this._lastError = '';
    this._lastErrorName = '';
    this._needsHeader = false;
    await meta.set(HANDLE_KEY, h);
    // Picking a folder performs a full backup. Pending rows fold in via exportAll.
    await this.writeFullBackup();
    return { folderName: h.name || '', count: this._lastCount || 0 };
  }

  // Write the whole DB to latest.csv (overwrites) + daily snapshot. Replaces the
  // log (unlike flush, which appends).
  async writeFullBackup() {
    if (!this._dir) throw new Error('No folder set.');
    const perm = await this._dir.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      const req = await this._dir.requestPermission({ mode: 'readwrite' });
      if (req !== 'granted') throw new Error('Permission denied.');
    }
    // Cancel any debounced flush so it can't append on top of the full file.
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const data = await db.exportAll();
    await this.writeText(this._dir, this.LATEST, data.text);
    // Full write supersedes any pending journal rows / header flag.
    this._pending = [];
    this._needsHeader = false;
    this._dirty = false;
    const day = db.localDay();
    const snap = `tokenbook-${day}.csv`;
    if (!(await this.fileExists(this._dir, snap))) {
      await this.writeText(this._dir, snap, data.text);
      await this.pruneSnapshots(this._dir);
    }
    this._lastCount = data.count || 0;
    this._lastAt = new Date().toISOString();
    this._lastError = '';
    this._lastErrorName = '';
    this.updateStatus();
    return { count: this._lastCount };
  }

  async reconnect() {
    if (!this._dir) throw new Error('No folder set.');
    const p = await this._dir.requestPermission({ mode: 'readwrite' });
    if (p !== 'granted') throw new Error('Permission denied.');
    this._lastError = '';
    this._dirty = true;
    await this.flush();
    return { folderName: this._dir.name || '' };
  }

  async clearFolder() {
    await meta.del(HANDLE_KEY);
    this._dir = null;
    this._lastAt = '';
    this._lastError = '';
    this._lastErrorName = '';
    this._pending = [];
    this.updateStatus();
  }

  // Backup button: always open the folder picker (see setFolder).
  async pickOrBackup() {
    return this.setFolder();
  }

  // Journal entry point — db.js calls this via db.setJournal() at boot.
  markDirty(entry) {
    if (!this._dir) return;
    if (entry) {
      // Dedupe within the pending window: (date, token) is the visit's upsert
      // key, so a later write replaces rather than appends twice.
      const key = entry.date + '|' + entry.token;
      const idx = this._pending.findIndex((e) => e.date + '|' + e.token === key);
      if (idx >= 0) this._pending[idx] = entry;
      else this._pending.push(entry);
    }
    this._dirty = true;
    // Reflect queued line immediately in the status line.
    this.updateStatus();
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush().catch((e) => console.error('auto-backup', e));
    }, DEBOUNCE_MS);
  }

  // Append queued lines to latest.csv. Never rewrites the body (append-only).
  async flush() {
    if (!this._dir) return;
    if (this._flushPromise) {
      await this._flushPromise;
      if (!this._dir || (!this._dirty && !this._pending.length)) return;
    }
    if (this._writing) return;
    if (!this._dirty && !this._pending.length) return;
    this._writing = true;
    this._flushPromise = (async () => {
      try {
        const perm = await this._dir.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
          this._lastError = 'permission needed';
          return;
        }
        const exists = await this.fileExists(this._dir, this.LATEST);
        if (!exists) this._needsHeader = true;

        if (!this._pending.length) {
          // Nothing to append, but folder is reachable — record the check so
          // the status shows a relative time instead of "ready".
          this._dirty = false;
          this._lastAt = new Date().toISOString();
          this._lastError = '';
          this._lastErrorName = '';
          return;
        }

        let payload = '';
        if (this._needsHeader) payload += csvHeaderLine() + '\n';
        for (const entry of this._pending) payload += this.formatLogEntry(entry) + '\n';

        const before = exists ? await this.readLatest(this._dir) : null;
        await this.appendText(this._dir, this.LATEST, payload);

        // Verify the append: re-read and confirm byte length grew by payload size.
        const after = await this.readLatest(this._dir);
        const expectedLen = (before != null ? before.length : 0) + payload.length;
        if (after == null || after.length !== expectedLen) {
          this._lastError = 'append verification failed';
          return;
        }
        this._needsHeader = false;
        this._pending = [];

        // First write of the day: snapshot the whole log into a dated file.
        const day = db.localDay();
        const snap = `tokenbook-${day}.csv`;
        if (!(await this.fileExists(this._dir, snap))) {
          const full = await this.readLatest(this._dir);
          if (full != null) await this.writeText(this._dir, snap, full);
          await this.pruneSnapshots(this._dir);
        }

        this._dirty = false;
        this._lastAt = new Date().toISOString();
        this._lastError = '';
        this._lastErrorName = '';
      } catch (e) {
        this._lastError = e && e.message ? e.message : String(e);
        this._lastErrorName = e && e.name ? e.name : '';
      } finally {
        this._writing = false;
        this._flushPromise = null;
        this.updateStatus();
      }
    })();
    return this._flushPromise;
  }

  async backupNow() {
    this._dirty = true;
    this._lastError = '';
    await this.flush();
    if (this._lastError) throw new Error(this._lastError);
    return { folderName: this._dir ? this._dir.name || '' : '', lastAt: this._lastAt };
  }

  // ---------- restore ----------

  // Log text for display. Prefers latest.csv; falls back to newest snapshot.
  // Returns { text, source }.
  async readLog() {
    if (!this._dir) return { text: null, source: 'no-folder' };
    try {
      let text = await this.readLatest(this._dir);
      if (text != null) return { text, source: this.LATEST };
      text = await this.readNewestSnapshot(this._dir);
      if (text != null) return { text, source: 'snapshot' };
      return { text: null, source: 'empty' };
    } catch (e) {
      return { text: null, source: 'error', error: e && e.message ? e.message : String(e) };
    }
  }

  // Unflushed journal entries as CSV lines (no header). Read-only.
  pendingLines() {
    return this._pending.map((e) => this.formatLogEntry(e));
  }

  // Discard queued journal entries and cancel the debounce timer before restore.
  resetPendingForRestore() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._pending = [];
    this._dirty = false;
    this._needsHeader = false;
  }

  async restoreFromFolder() {
    if (!this._dir) throw new Error('No backup folder set.');
    const perm = await this._dir.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      const req = await this._dir.requestPermission({ mode: 'readwrite' });
      if (req !== 'granted') throw new Error('Permission denied.');
    }
    let text = await this.readLatest(this._dir);
    let source = this.LATEST;
    if (!text) {
      text = await this.readNewestSnapshot(this._dir);
      source = 'snapshot';
      if (!text) throw new Error('No backup files in that folder.');
    }
    let ops;
    try {
      ops = csvToLog(text);
    } catch (e) {
      const snap = await this.readNewestSnapshot(this._dir);
      if (!snap) throw e;
      ops = csvToLog(snap);
      source = 'snapshot';
    }
    this.resetPendingForRestore();
    const r = await db.replayLog(ops);
    return { source, count: r.count, skipped: r.skipped, folderName: this._dir.name || '' };
  }

  async restoreFromFileObject(file) {
    const text = await file.text();
    const ops = parseBackup(text, file.name);
    this.resetPendingForRestore();
    const r = await db.replayLog(ops);
    return { mode: 'upload', filename: file.name, count: r.count, skipped: r.skipped };
  }

  // Fallback export: download the whole DB as a fresh log CSV.
  async downloadCsv() {
    const data = await db.exportAll();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp =
      db.localDay(now) +
      'T' +
      pad(now.getHours()) +
      '-' +
      pad(now.getMinutes()) +
      '-' +
      pad(now.getSeconds());
    const filename = `tokenbook-${stamp}.csv`;
    const blob = new Blob([data.text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { filename, count: data.count || 0 };
  }

  // DEV/TEST ONLY: point the log file at a different name (null = default).
  setLogFileName(name) {
    this.LATEST = name || DEFAULT_LATEST;
  }

  // DEV/TEST ONLY: delete the current log file from the folder (fresh start).
  async deleteLog() {
    if (!this._dir) return false;
    try {
      await this._dir.removeEntry(this.LATEST);
      this._needsHeader = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  state() {
    return {
      hasFolder: !!this._dir,
      folderName: this._dir ? this._dir.name || '' : '',
      lastAt: this._lastAt,
      lastError: this._lastError,
      pending: this._pending.length,
      dirty: this._dirty,
    };
  }
}

const backup = new Backup();

// Flush pending writes when the tab is hidden.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && backup._dirty) {
    backup.flush().catch(() => {});
  }
});

// Refresh the status line so "2m ago" stays current.
setInterval(() => backup.updateStatus(), 30000);

export { hasFsAccess as fsAccess };
export default backup;
export { Backup };
