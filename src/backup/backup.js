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
// PatientDb.replayLog — the same functions that produced the log — so the
// restored DB is byte-identical to what the live DB would have been.

import { PatientDb } from '../core/db.js';
import {
  csvHeaderLine,
  visitInputToLogLine,
  csvToLog,
  parseBackup,
} from './csv.js';
import { metaGet, metaSet, metaDel } from './meta.js';

// Active log file name. Swappable so the self-test writes its own log
// (apt-list-latest-devtest.csv) instead of polluting the real one.
let LATEST = 'apt-list-latest.csv';
const DEFAULT_LATEST = LATEST;
// DEV/TEST ONLY: point the log file at a different name (null = default).
function setLogFileName(name) {
  LATEST = name || DEFAULT_LATEST;
}
// DEV/TEST ONLY: delete the current log file from the folder (fresh start).
async function deleteLog() {
  if (!_dir) return false;
  try {
    await _dir.removeEntry(LATEST);
    _needsHeader = true; // next flush re-emits the header
    return true;
  } catch (e) {
    return false; // not present
  }
}
const SNAP_RE = /^apt-list-(\d{4}-\d{2}-\d{2})\.csv$/;
const KEEP_SNAPSHOTS = 30;
const DEBOUNCE_MS = 2000;
const HANDLE_KEY = 'dirHandle';

export const hasFsAccess =
  typeof window.showDirectoryPicker === 'function' &&
  typeof window.showSaveFilePicker === 'function';

let _dir = null;
let _dirty = false;
let _timer = null;
let _writing = false;
// In-flight flush promise. flush() chains onto it so concurrent callers
// (debounced timer + explicit backupNow) serialize instead of one no-oping.
let _flushPromise = null;
let _lastAt = '';
let _lastError = '';
// Pending journal entries (raw inputs from addVisit / setVisitRefund).
// Drained by flush() in order and appended to latest.csv.
let _pending = [];
// True when latest.csv needs a header line prepended (fresh file / truncate).
let _needsHeader = false;
// ---------- status line ----------

function timeAgo(when) {
  const t = typeof when === 'number' ? when : Date.parse(when || '');
  if (!t) return 'never';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  const m = s / 60;
  if (m < 60) return Math.round(m) + 'm ago';
  const h = m / 60;
  if (h < 24) return Math.round(h) + 'h ago';
  const d = h / 24;
  return Math.round(d) + 'd ago';
}

function updateStatus() {
  const el = document.getElementById('backup-status');
  if (!el) return;
  if (!hasFsAccess) {
    el.textContent = 'backup: unsupported';
    el.className = 'status';
    return;
  }
  if (!_dir) {
    el.textContent = 'backup: no folder set';
    el.className = 'status';
    return;
  }
  if (_lastError) {
    el.textContent = 'backup: ✗ ' + _lastError;
    el.className = 'status err';
    return;
  }
  const name = _dir.name || 'folder';
  el.textContent = `backup: ${name} · ${_lastAt ? timeAgo(_lastAt) : 'pending'}`;
  el.className = 'status ok';
}

// ---------- folder IO ----------

async function fileExists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function writeText(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

// Append text to a file (creating it if needed) without rewriting its body.
async function appendText(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const file = await fh.getFile();
  const w = await fh.createWritable({ keepExistingData: true });
  await w.seek(file.size);
  await w.write(text);
  await w.close();
}

async function pruneSnapshots(dir) {
  const snaps = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file' && SNAP_RE.test(name)) snaps.push(name);
  }
  if (snaps.length <= KEEP_SNAPSHOTS) return;
  snaps.sort(); // lexicographic == chronological for YYYY-MM-DD
  for (const n of snaps.slice(0, snaps.length - KEEP_SNAPSHOTS)) {
    try {
      await dir.removeEntry(n);
    } catch {}
  }
}

async function readLatest(dir) {
  try {
    const fh = await dir.getFileHandle(LATEST);
    const f = await fh.getFile();
    return await f.text();
  } catch {
    return null;
  }
}

async function readNewestSnapshot(dir) {
  const snaps = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file' && SNAP_RE.test(name)) snaps.push({ name, handle });
  }
  if (!snaps.length) return null;
  snaps.sort((a, b) => b.name.localeCompare(a.name));
  const f = await snaps[0].handle.getFile();
  return await f.text();
}



// One encoder for both ops: refunds are full rows (see csv.js). op is a
// provenance tag only, not a shape selector.
function formatLogEntry(entry) {
  return visitInputToLogLine(entry);
}

// ---------- public ops ----------

async function loadPersistedHandle() {
  if (!hasFsAccess) return null;
  try {
    return await metaGet(HANDLE_KEY);
  } catch {
    return null;
  }
}

async function init() {
  // Wire db.js's journal into this module. Every successful addVisit /
  // setVisitRefund now queues a log line here.
  PatientDb.setJournal(markDirty);
  updateStatus();
  if (!hasFsAccess) return { ok: false, reason: 'unsupported' };
  const h = await loadPersistedHandle();
  if (!h) return { ok: false, reason: 'no-handle' };
  _dir = h;
  let perm = 'prompt';
  try {
    perm = await h.queryPermission({ mode: 'readwrite' });
  } catch {
    perm = 'prompt';
  }
  if (perm === 'granted') {
    updateStatus();
    return { ok: true, folderName: h.name || '' };
  }
  updateStatus();
  return { ok: false, reason: 'needs-gesture', folderName: h.name || '' };
}

async function setFolder() {
  if (!hasFsAccess) throw new Error('File System Access not supported in this browser.');
  const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'apt-list-backup' });
  _dir = h;
  _lastError = '';
  _needsHeader = true;
  await metaSet(HANDLE_KEY, h);
  _dirty = true;
  await flush();
  return { folderName: h.name || '' };
}

async function reconnect() {
  if (!_dir) throw new Error('No folder set.');
  const p = await _dir.requestPermission({ mode: 'readwrite' });
  if (p !== 'granted') throw new Error('Permission denied.');
  _lastError = '';
  _dirty = true;
  await flush();
  return { folderName: _dir.name || '' };
}

async function clearFolder() {
  await metaDel(HANDLE_KEY);
  _dir = null;
  _lastAt = '';
  _lastError = '';
  _pending = [];
  updateStatus();
}

async function pickOrBackup() {
  if (!_dir) return setFolder();
  const perm = await _dir.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') return reconnect();
  _dirty = true;
  await flush();
  return { folderName: _dir.name || '', lastAt: _lastAt };
}

// Journal entry point. db.js calls this via PatientDb.setJournal() at boot.
// Each successful addVisit / setVisitRefund queues its raw input here; the
// next flush appends one formatted line per entry to latest.csv.
function markDirty(entry) {
  if (!_dir) return;
  if (entry) {
    // Dedupe within the pending window: (date, token) is the visit's upsert
    // key in the DB, so a later write for the same key is a last-write-wins
    // update — replace in place rather than append twice. Refund edits and
    // visit adds share this key because both are full self-describing rows.
    const key = entry.date + '|' + entry.token;
    const idx = _pending.findIndex((e) => e.date + '|' + e.token === key);
    if (idx >= 0) _pending[idx] = entry;
    else _pending.push(entry);
  }
  _dirty = true;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    _timer = null;
    flush().catch((e) => console.error('auto-backup', e));
  }, DEBOUNCE_MS);
}

// Append any queued log lines to latest.csv. Never rewrites the body — the
// log is append-only by design. A header is emitted once, when latest.csv is
// first created (or recreated after a truncate).
async function flush() {
  if (!_dir) return;
  // Serialize: chain onto any in-flight flush so a debounced write and an
  // explicit backupNow() never race, and backupNow() never silently no-ops.
  if (_flushPromise) {
    await _flushPromise;
    // Re-check after the in-flight flush — it may have drained _pending.
    if (!_dir || (!_dirty && !_pending.length)) return;
  }
  if (_writing) return;
  if (!_dirty && !_pending.length) return;
  _writing = true;
  _flushPromise = (async () => {
    try {
      const perm = await _dir.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        _lastError = 'permission needed';
        return;
      }
      if (!_pending.length) {
        _dirty = false;
        return;
      }

      const exists = await fileExists(_dir, LATEST);
      if (!exists) _needsHeader = true;

      let payload = '';
      if (_needsHeader) payload += csvHeaderLine() + '\n';
      for (const entry of _pending) payload += formatLogEntry(entry) + '\n';

      const before = exists ? await readLatest(_dir) : null;
      await appendText(_dir, LATEST, payload);

      // Verify the append landed: re-read and confirm the byte length grew by
      // the payload size (or matches on a fresh file). Guards against a
      // silently-failed write that would leave latest.csv stale.
      const after = await readLatest(_dir);
      const expectedLen = (before != null ? before.length : 0) + payload.length;
      if (after == null || after.length !== expectedLen) {
        _lastError = 'append verification failed';
        return;
      }
      _needsHeader = false;
      _pending = [];

      // First write of the day: snapshot the whole log into a dated file so
      // each day has a self-contained copy. Later appends only touch latest.
      const day = PatientDb.localDay();
      const snap = `apt-list-${day}.csv`;
      if (!(await fileExists(_dir, snap))) {
        const full = await readLatest(_dir);
        if (full != null) await writeText(_dir, snap, full);
        await pruneSnapshots(_dir);
      }

      _dirty = false;
      _lastAt = new Date().toISOString();
      _lastError = '';
    } catch (e) {
      _lastError = e && e.message ? e.message : String(e);
    } finally {
      _writing = false;
      _flushPromise = null;
      updateStatus();
    }
  })();
  return _flushPromise;
}

async function backupNow() {
  _dirty = true;
  _lastError = '';
  await flush();
  if (_lastError) throw new Error(_lastError);
  return { folderName: _dir ? _dir.name || '' : '', lastAt: _lastAt };
}

// ---------- restore ----------

// Read the current logbook text for display. Prefers latest.csv; falls back
// to the newest daily snapshot. Returns { text, source }.
async function readLog() {
  if (!_dir) return { text: null, source: 'no-folder' };
  try {
    let text = await readLatest(_dir);
    if (text != null) return { text, source: LATEST };
    text = await readNewestSnapshot(_dir);
    if (text != null) return { text, source: 'snapshot' };
    return { text: null, source: 'empty' };
  } catch (e) {
    return { text: null, source: 'error', error: e && e.message ? e.message : String(e) };
  }
}

// Discard any queued journal entries and cancel the debounce timer before a
// restore. Otherwise pre-restore lines would be appended to latest.csv AFTER
// the replay commits, corrupting the log the next restore reads from.
function resetPendingForRestore() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  _pending = [];
  _dirty = false;
  _needsHeader = false;
}

async function restoreFromFolder() {
  if (!_dir) throw new Error('No backup folder set.');
  const perm = await _dir.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    const req = await _dir.requestPermission({ mode: 'readwrite' });
    if (req !== 'granted') throw new Error('Permission denied.');
  }
  let text = await readLatest(_dir);
  let source = LATEST;
  if (!text) {
    text = await readNewestSnapshot(_dir);
    source = 'snapshot';
    if (!text) throw new Error('No backup files in that folder.');
  }
  let ops;
  try {
    ops = csvToLog(text);
  } catch (e) {
    const snap = await readNewestSnapshot(_dir);
    if (!snap) throw e;
    ops = csvToLog(snap);
    source = 'snapshot';
  }
  resetPendingForRestore();
  const r = await PatientDb.replayLog(ops);
  return { source, count: r.count, skipped: r.skipped, folderName: _dir.name || '' };
}

async function restoreFromFileObject(file) {
  const text = await file.text();
  const ops = parseBackup(text, file.name);
  resetPendingForRestore();
  const r = await PatientDb.replayLog(ops);
  return { mode: 'upload', filename: file.name, count: r.count, skipped: r.skipped };
}

// Fallback export: when File System Access is unavailable or the user cancels
// the folder picker, download the whole current DB as a fresh log CSV.
async function downloadCsv() {
  const data = await PatientDb.exportAll();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    PatientDb.localDay(now) +
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

// ---------- lifecycle ----------

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && _dirty) {
    flush().catch(() => {});
  }
});

export const PatientBackup = {
  hasFsAccess,
  init,
  setFolder,
  reconnect,
  clearFolder,
  pickOrBackup,
  markDirty,
  flush,
  setLogFileName,
  deleteLog,
  backupNow,
  restoreFromFolder,
  restoreFromFileObject,
  readLog,
  downloadCsv,
  parseBackup,
  state: () => ({
    hasFolder: !!_dir,
    folderName: _dir ? _dir.name || '' : '',
    lastAt: _lastAt,
    lastError: _lastError,
  }),
};
