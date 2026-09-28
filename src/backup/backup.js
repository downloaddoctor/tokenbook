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
  detailsLine,
  personRevToLogLine,
  visitRevToLogLine,
  csvToLog,
  parseBackup,
  parseCsvLine,
} from './csv.js';
import meta from './meta.js';
import { timeAgo } from '../core/time.js';

const DEFAULT_LATEST = 'tokenbook-latest.csv';
const SNAP_RE = /^tokenbook-(\d{4}-\d{2}-\d{2})\.csv$/;
const KEEP_SNAPSHOTS = 30;
// Prior full backups are moved here (not left in the root) with a timestamp name.
const ARCHIVE_DIR = 'archive';
const ARCHIVE_RE = /^tokenbook-.*\.csv$/;
const KEEP_ARCHIVES = 30;
// Once-per-day snapshot of the whole DB, taken on first app-open of the date.
const DAILY_DIR = 'daily';
const DAILY_RE = /^tokenbook-(\d{4}-\d{2}-\d{2})\.csv$/;
const DEBOUNCE_MS = 2000;
const HANDLE_KEY = 'dirHandle';

export const hasFsAccess = typeof window.showDirectoryPicker === 'function';

// Local 'YYYY-MM-DDTHH-MM-SS' stamp for backup filenames.
function fileStamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    db.localDay(now) +
    'T' +
    pad(now.getHours()) +
    '-' +
    pad(now.getMinutes()) +
    '-' +
    pad(now.getSeconds())
  );
}

// Trigger a browser download of `text` as `filename`. Fire-and-forget.
function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 1s: long enough that the browser has started the download before revoke.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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

  // Stream chunks to a file via one writable. chunks: async iterable/callback
  // driver — here we pass an async function that receives a write(chunk) sink.
  async writeStream(dir, name, producer) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      await producer((chunk) => w.write(chunk));
    } finally {
      await w.close();
    }
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

  // Move the existing latest.csv into archive/ with a timestamp name so the
  // upcoming overwrite preserves the previous full backup. Returns the new name
  // or null when there is nothing to archive.
  async archiveLatest(dir) {
    try {
      const existing = await dir.getFileHandle(this.LATEST);
      if (!existing) return null;
      const adir = await dir.getDirectoryHandle(ARCHIVE_DIR, { create: true });
      const ts = new Date()
        .toISOString()
        .replace(/[:T]/g, '-')
        .replace(/\..+$/, '');
      const name = `tokenbook-${ts}.csv`;
      await existing.move(adir, name);
      await this.pruneArchives(adir);
      return name;
    } catch {
      // No existing file (or move unsupported) -> nothing to archive.
      return null;
    }
  }

  // Keep only the newest KEEP_ARCHIVES files in archive/.
  async pruneArchives(adir) {
    const names = [];
    for await (const [name, handle] of adir.entries()) {
      if (handle.kind === 'file' && ARCHIVE_RE.test(name)) names.push(name);
    }
    if (names.length <= KEEP_ARCHIVES) return;
    names.sort();
    for (const n of names.slice(0, names.length - KEEP_ARCHIVES)) {
      try {
        await adir.removeEntry(n);
      } catch { }
    }
  }

  // Take today's snapshot into daily/ if it does not already exist. Idempotent:
  // safe to call on every boot + backup. Returns the file name or null if
  // already present. Requires the dir handle to be readable/writable.
  async snapshotDaily(dir) {
    const ddir = await dir.getDirectoryHandle(DAILY_DIR, { create: true });
    const day = db.localDay();
    const name = `tokenbook-${day}.csv`;
    try {
      await ddir.getFileHandle(name);
      return null; // today's snapshot already exists
    } catch {
      /* not present -> write it */
    }
    await this.writeStream(ddir, name, async (write) => {
      await db.exportAllStream((chunk) => write(chunk));
    });
    await this.pruneDaily(ddir);
    return name;
  }

  // Keep only the newest KEEP_SNAPSHOTS files in daily/.
  async pruneDaily(ddir) {
    const names = [];
    for await (const [name, handle] of ddir.entries()) {
      if (handle.kind === 'file' && DAILY_RE.test(name)) names.push(name);
    }
    if (names.length <= KEEP_SNAPSHOTS) return;
    names.sort();
    for (const n of names.slice(0, names.length - KEEP_SNAPSHOTS)) {
      try {
        await ddir.removeEntry(n);
      } catch { }
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
    // Daily snapshots live in daily/. Fall back to root for older layouts.
    const snaps = [];
    try {
      const ddir = await dir.getDirectoryHandle(DAILY_DIR);
      for await (const [name, handle] of ddir.entries()) {
        if (handle.kind === 'file' && DAILY_RE.test(name)) snaps.push({ name, handle });
      }
    } catch {
      /* no daily/ dir */
    }
    if (!snaps.length) {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file' && SNAP_RE.test(name)) snaps.push({ name, handle });
      }
    }
    if (!snaps.length) return null;
    snaps.sort((a, b) => b.name.localeCompare(a.name));
    const f = await snaps[0].handle.getFile();
    return await f.text();
  }

  // One encoder for both revision types. `entry` is a stored revision row
  // (people or visits), tagged with `kind` by the db layer.
  formatLogEntry(entry) {
    if (entry && entry.kind === 'person') return personRevToLogLine(entry);
    return visitRevToLogLine(entry);
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
      // First open of the date -> take today's snapshot (best-effort).
      let dailySnapshot = null;
      try {
        dailySnapshot = await this.snapshotDaily(h);
      } catch (e) {
        console.warn('daily snapshot failed', e);
      }
      return { ok: true, folderName: h.name || '', dailySnapshot };
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
    // Preserve the previous latest.csv (rename with a timestamp) before overwrite.
    await this.archiveLatest(this._dir);
    // Stream latest.csv from the DB in pages — never one giant string.
    let count = 0;
    await this.writeStream(this._dir, this.LATEST, async (write) => {
      const r = await db.exportAllStream((chunk) => write(chunk));
      count = r.count || 0;
    });
    // Full write supersedes any pending journal rows / header flag.
    this._pending = [];
    this._needsHeader = false;
    this._dirty = false;
    // Daily snapshot into daily/ (idempotent — fills it if boot couldn't).
    try {
      await this.snapshotDaily(this._dir);
    } catch (e) {
      console.warn('daily snapshot failed', e);
    }
    this._lastCount = count;
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
      // v3: every journal entry is an APPENDED REVISION (a new [rootId+v]).
      // Revisions are history — never dedupe them. The old v2 "same (date,
      // token) upsert" rule does not apply, and person revisions have no
      // (date, token) at all.
      this._pending.push(entry);
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
        if (this._needsHeader) {
          let counts = { visits: 0, people: 0, users: 0 };
          try {
            counts = await db._logCounts();
          } catch (_) { }
          payload += detailsLine(await db._appVersion(), new Date().toISOString(), counts) + '\n';
          payload += csvHeaderLine() + '\n';
        }
        for (const entry of this._pending) payload += this.formatLogEntry(entry) + '\n';

        // Size-before: O(1) metadata read, no full-file text load.
        let beforeSize = 0;
        try {
          const fh = await this._dir.getFileHandle(this.LATEST);
          beforeSize = (await fh.getFile()).size;
        } catch {
          beforeSize = 0; // file doesn't exist yet — will be created by appendText
        }

        await this.appendText(this._dir, this.LATEST, payload);

        // Verify the append: O(1) size check on the file handle, no re-read.
        let afterSize = -1;
        try {
          const fh = await this._dir.getFileHandle(this.LATEST);
          afterSize = (await fh.getFile()).size;
        } catch {
          afterSize = -1;
        }
        const expectedLen = beforeSize + new Blob([payload]).size;
        if (afterSize !== expectedLen) {
          this._lastError = 'append verification failed';
          return;
        }
        this._needsHeader = false;
        this._pending = [];

        // First write of the day: snapshot the whole log into daily/.
        const day = db.localDay();
        const name = `tokenbook-${day}.csv`;
        const ddir = await this._dir.getDirectoryHandle(DAILY_DIR, { create: true });
        let existsToday = true;
        try {
          await ddir.getFileHandle(name);
        } catch {
          existsToday = false;
        }
        if (!existsToday) {
          const full = await this.readLatest(this._dir);
          if (full != null) await this.writeText(ddir, name, full);
          await this.pruneDaily(ddir);
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

  // List every restorable backup in the folder, grouped by type.
  // Returns { latest, daily:[], archive:[] } where each entry is
  // { name, dir, path, date, size, handle }.
  async listBackups() {
    const out = { latest: null, daily: [], archive: [] };
    if (!this._dir) return out;

    // latest.csv (or the swap-name used by self-test).
    try {
      const fh = await this._dir.getFileHandle(this.LATEST);
      const f = await fh.getFile();
      out.latest = {
        name: this.LATEST,
        dir: this._dir,
        path: this.LATEST,
        date: f.lastModified ? new Date(f.lastModified).toISOString() : null,
        size: f.size,
        handle: fh,
      };
    } catch {
      /* no latest.csv */
    }

    // daily/*.csv
    try {
      const ddir = await this._dir.getDirectoryHandle(DAILY_DIR);
      for await (const [name, handle] of ddir.entries()) {
        if (handle.kind !== 'file' || !DAILY_RE.test(name)) continue;
        const f = await handle.getFile();
        out.daily.push({
          name,
          dir: ddir,
          path: DAILY_DIR + '/' + name,
          date: f.lastModified ? new Date(f.lastModified).toISOString() : null,
          size: f.size,
          handle,
        });
      }
    } catch {
      /* no daily/ */
    }

    // Root-level snapshots (older layout) fold into daily.
    try {
      for await (const [name, handle] of this._dir.entries()) {
        if (handle.kind !== 'file' || !SNAP_RE.test(name)) continue;
        if (out.daily.some((d) => d.name === name)) continue;
        const f = await handle.getFile();
        out.daily.push({
          name,
          dir: this._dir,
          path: name,
          date: f.lastModified ? new Date(f.lastModified).toISOString() : null,
          size: f.size,
          handle,
        });
      }
    } catch {
      /* ignore */
    }
    out.daily.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    // archive/*.csv
    try {
      const adir = await this._dir.getDirectoryHandle(ARCHIVE_DIR);
      for await (const [name, handle] of adir.entries()) {
        if (handle.kind !== 'file' || !ARCHIVE_RE.test(name)) continue;
        const f = await handle.getFile();
        out.archive.push({
          name,
          dir: adir,
          path: ARCHIVE_DIR + '/' + name,
          date: f.lastModified ? new Date(f.lastModified).toISOString() : null,
          size: f.size,
          handle,
        });
      }
    } catch {
      /* no archive/ */
    }
    out.archive.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return out;
  }

  // Read the first #details line of a backup file (for the picker summary).
  // Returns a map like { version, date, visits, people, users } or null.
  async readDetails(entry) {
    if (!entry || !entry.handle) return null;
    try {
      const f = await entry.handle.getFile();
      const head = await f.slice(0, 512).text();
      const line = head.split(/\r?\n/).find((l) => l.startsWith('#details'));
      if (!line) return null;
      const f2 = parseCsvLine(line);
      // #details|TokenBook|v<ver>|<iso>|visits=N|people=N|users=N
      const out = { version: f2[2] || '', date: f2[3] || null };
      for (let i = 4; i < f2.length; i++) {
        const [k, v] = String(f2[i]).split('=');
        if (k) out[k] = Number(v);
      }
      return out;
    } catch (_) {
      return null;
    }
  }

  // Restore from a specific file entry chosen by the user.
  async restoreFromEntry(entry, { onProgress = null } = {}) {
    if (!entry || !entry.handle) throw new Error('No backup file selected.');
    if (!this._dir) throw new Error('No backup folder set.');
    const perm = await this._dir.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      const req = await this._dir.requestPermission({ mode: 'readwrite' });
      if (req !== 'granted') throw new Error('Permission denied.');
    }
    const f = await entry.handle.getFile();
    const text = await f.text();
    const parsed = csvToLog(text);
    this.resetPendingForRestore();
    const r = await db.replayLog(parsed.ops, {
      skippedRows: parsed.skippedRows,
      onProgress,
    });
    return {
      source: entry.path,
      count: r.count,
      skipped: r.skipped,
      skippedRows: r.skippedRows,
      folderName: this._dir.name || '',
    };
  }

  async restoreFromFolder({ onProgress = null } = {}) {
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
    let skippedRows = [];
    try {
      const parsed = csvToLog(text);
      ops = parsed.ops;
      skippedRows = parsed.skippedRows;
    } catch (e) {
      const snap = await this.readNewestSnapshot(this._dir);
      if (!snap) throw e;
      const parsed = csvToLog(snap);
      ops = parsed.ops;
      skippedRows = parsed.skippedRows;
      source = 'snapshot';
    }
    this.resetPendingForRestore();
    const r = await db.replayLog(ops, { skippedRows, onProgress });
    return {
      source,
      count: r.count,
      skipped: r.skipped,
      skippedRows: r.skippedRows,
      folderName: this._dir.name || '',
    };
  }

  async restoreFromFileObject(file, { onProgress = null } = {}) {
    const text = await file.text();
    const parsed = parseBackup(text, file.name);
    this.resetPendingForRestore();
    const r = await db.replayLog(parsed.ops, { skippedRows: parsed.skippedRows, onProgress });
    return {
      mode: 'upload',
      filename: file.name,
      count: r.count,
      skipped: r.skipped,
      skippedRows: r.skippedRows,
    };
  }

  // Append a restore-error report to error.log in the backup folder, if set.
  // The log is capped at MAX_ERROR_LOG bytes; when appending would exceed it,
  // the file is rotated to error.log.1 (previous .1 is dropped). Keeps the
  // folder from filling on a pathological run without silently discarding the
  // most recent report.
  async writeErrorLog(text) {
    if (!this._dir) return false;
    const MAX_ERROR_LOG = 1024 * 1024; // 1 MB
    try {
      const fh = await this._dir.getFileHandle('error.log', { create: true });
      const file = await fh.getFile();
      const bytes = new Blob([text]).size;
      if (file.size + bytes > MAX_ERROR_LOG) {
        // Rotate: remove any .1, then rename current -> .1.
        try { await this._dir.removeEntry('error.log.1'); } catch (_) { /* none */ }
        try { await fh.move(this._dir, 'error.log.1'); } catch (_) { /* move unsupported */ }
        // Fall through; the next getFileHandle({create:true}) recreates it.
      }
      const fh2 = await this._dir.getFileHandle('error.log', { create: true });
      const file2 = await fh2.getFile();
      const w = await fh2.createWritable({ keepExistingData: true });
      await w.seek(file2.size);
      await w.write(text);
      await w.close();
      return true;
    } catch {
      return false;
    }
  }

  // Always-download a fresh restore-error report. Returns the filename.
  downloadErrorLog(text) {
    const filename = `tokenbook-restore-errors-${fileStamp()}.log`;
    downloadText(filename, text, 'text/plain;charset=utf-8');
    return filename;
  }

  // Build the error report text, write it to the backup folder (if set) AND
  // download it. Returns { text, filename } — folder write is fire-and-forget.
  reportRestoreErrors({ source, folderName, skippedRows }) {
    if (!skippedRows || !skippedRows.length) return null;
    const lines = [];
    lines.push(`=== Restore ${new Date().toISOString()} · source=${source || '?'}${folderName ? ' · folder=' + folderName : ''} ===`);
    for (const r of skippedRows) {
      lines.push(`line ${r.lineNo != null ? r.lineNo : '?'}: ${r.reason}`);
      if (r.raw) lines.push(`  raw: ${r.raw}`);
    }
    lines.push('');
    const text = lines.join('\n');
    // Fire-and-forget: folder write is best-effort and must not block the UI.
    this.writeErrorLog(text).catch(() => { });
    let filename = null;
    try {
      filename = this.downloadErrorLog(text);
    } catch {
      filename = null;
    }
    return { text, filename };
  }

  // Fallback export: download the whole DB as a fresh log CSV.
  async downloadCsv() {
    const data = await db.exportAll();
    const filename = `tokenbook-${fileStamp()}.csv`;
    downloadText(filename, data.text, 'text/csv;charset=utf-8');
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
    backup.flush().catch(() => { });
  }
});

// Refresh the status line so "2m ago" stays current.
setInterval(() => backup.updateStatus(), 30000);

export default backup;
export { Backup };
