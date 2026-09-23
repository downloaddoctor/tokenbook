// Backup / restore to a user-chosen folder (typically a pendrive) via the
// File System Access API.
//
// Logbook model: every write appends ONE line to apt-list-latest.csv. No
// rewriting. A header is written once, when the file is first created.
// At the first write of each day, the whole latest.csv is copied to
// apt-list-YYYY-MM-DD.csv (self-contained daily snapshot); snapshots are
// pruned to the newest KEEP_SNAPSHOTS.
//
// Restore reads every line of the log in file order and replays it through
// db.replayLog — the same functions that produced the log — so the restored
// DB is byte-identical to what the live DB would have been.
//
// Class shape: all state (the folder handle, debounce timer, in-flight flush
// promise, pending journal queue) lives on the instance. External code uses
// the default instance (`import backup from './backup.js'; backup.flush()`).

import db from '../core/db.js';
import {
  csvHeaderLine,
  visitInputToLogLine,
  csvToLog,
  parseBackup,
} from './csv.js';
import meta from './meta.js';
import { timeAgo } from '../core/time.js';

const DEFAULT_LATEST = 'apt-list-latest.csv';
const SNAP_RE = /^apt-list-(\d{4}-\d{2}-\d{2})\.csv$/;
const KEEP_SNAPSHOTS = 30;
const DEBOUNCE_MS = 2000;
const HANDLE_KEY = 'dirHandle';

export const hasFsAccess = typeof window.showDirectoryPicker === 'function';

class Backup {
  constructor() {
    // Active log file name. Swappable so the self-test writes its own log
    // (apt-list-latest-devtest.csv) instead of polluting the real one.
    this.LATEST = DEFAULT_LATEST;
    this._dir = null;
    this._dirty = false;
    this._timer = null;
    this._writing = false;
    // In-flight flush promise. flush() chains onto it so concurrent callers
    // (debounced timer + explicit backupNow) serialize instead of one no-oping.
    this._flushPromise = null;
    this._lastAt = '';
    this._lastCount = 0;
    this._lastError = '';
    this._lastErrorName = '';
    // Pending journal entries (raw inputs from addVisit / setVisitRefund).
    // Drained by flush() in order and appended to latest.csv.
    this._pending = [];
    // True when latest.csv needs a header line prepended (fresh file / truncate).
    this._needsHeader = false;
    // Bind the journal callback once so db.setJournal receives a stable fn.
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
      el.textContent = 'backup: no folder set';
      el.className = 'status';
      return;
    }
    const name = this._dir.name || 'folder';
    // Surface queued log lines so an unflushed/failed write is visible.
    const queued = this._pending.length;
    const queuedStr = queued ? ` · ${queued} pending` : '';
    if (this._lastError) {
      el.textContent = 'backup: ✗ ' + this._lastError + queuedStr;
      el.className = 'status err';
      return;
    }
    el.textContent = `backup: ${name} · ${
      this._lastAt ? this.timeAgo(this._lastAt) : 'pending'
    }${queuedStr}`;
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

  // Append text to a file (creating it if needed) without rewriting its body.
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

  // One encoder for both ops: refunds are full rows (see csv.js).
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
  // real directory (user deleted/moved it, or the FS revoked access). These
  // should clear the persisted handle so the next Backup click re-opens the
  // picker instead of failing forever.
  isStaleHandleError(e) {
    if (!e) return false;
    const name = e.name || '';
    if (name === 'NotFoundError') return true;
    // Chromium reports a missing/renamed dir as NotAllowedError on some versions.
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

  async setFolder() {
    if (!hasFsAccess) throw new Error('File System Access not supported in this browser.');
    const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'apt-list-backup' });
    this._dir = h;
    this._lastError = '';
    this._lastErrorName = '';
    this._needsHeader = false;
    await meta.set(HANDLE_KEY, h);
    // Picking a folder performs a full backup: write the entire current DB as
    // latest.csv (header + one row per visit), overwriting any stale file, then
    // take the daily snapshot. Pending journal rows are folded in by exportAll.
    await this.writeFullBackup();
    return { folderName: h.name || '', count: this._lastCount || 0 };
  }

  // Write the whole current DB to latest.csv in the active folder, plus the
  // dated snapshot. Replaces the log (unlike flush, which appends).
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
    // A full write supersedes any pending journal rows / header flag.
    this._pending = [];
    this._needsHeader = false;
    this._dirty = false;
    const day = db.localDay();
    const snap = `apt-list-${day}.csv`;
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

  // Backup button: always open the folder picker so the operator can pick or
  // change the target folder, then write to it. Auto-backup (markDirty) still
  // flushes silently to the current folder.
  async pickOrBackup() {
    return this.setFolder();
  }

  // Journal entry point. db.js calls this via db.setJournal() at boot.
  markDirty(entry) {
    if (!this._dir) return;
    if (entry) {
      // Dedupe within the pending window: (date, token) is the visit's upsert
      // key in the DB, so a later write for the same key is a last-write-wins
      // update — replace in place rather than append twice.
      const key = entry.date + '|' + entry.token;
      const idx = this._pending.findIndex((e) => e.date + '|' + e.token === key);
      if (idx >= 0) this._pending[idx] = entry;
      else this._pending.push(entry);
    }
    this._dirty = true;
    // Reflect the queued line immediately (status line shows "N pending").
    this.updateStatus();
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush().catch((e) => console.error('auto-backup', e));
    }, DEBOUNCE_MS);
  }

  // Append any queued log lines to latest.csv. Never rewrites the body — the
  // log is append-only by design.
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
          this._dirty = false;
          return;
        }

        let payload = '';
        if (this._needsHeader) payload += csvHeaderLine() + '\n';
        for (const entry of this._pending) payload += this.formatLogEntry(entry) + '\n';

        const before = exists ? await this.readLatest(this._dir) : null;
        await this.appendText(this._dir, this.LATEST, payload);

        // Verify the append landed: re-read and confirm the byte length grew by
        // the payload size (or matches on a fresh file).
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
        const snap = `apt-list-${day}.csv`;
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

  // Read the current logbook text for display. Prefers latest.csv; falls back
  // to the newest daily snapshot. Returns { text, source }.
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

  // Discard any queued journal entries and cancel the debounce timer before a
  // restore.
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

  // Fallback export: download the whole current DB as a fresh log CSV.
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
    const filename = `clinic-register-${stamp}.csv`;
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

// visibilitychange: flush pending writes when the tab is hidden.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && backup._dirty) {
    backup.flush().catch(() => {});
  }
});

export { hasFsAccess as fsAccess };
export default backup;
export { Backup };
