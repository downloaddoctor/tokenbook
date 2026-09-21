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
  refundInputToLogLine,
  csvToLog,
  parseBackup,
  OP_REFUND,
} from './csv.js';
import { metaGet, metaSet, metaDel } from './meta.js';

const LATEST = 'apt-list-latest.csv';
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



function formatLogEntry(entry) {
  if (entry.op === OP_REFUND) return refundInputToLogLine(entry);
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
    // Dedupe within the pending window: same op + same (date, token) is a
    // last-write-wins update, so replace in place rather than append twice.
    const key = entry.op + '|' + entry.date + '|' + entry.token;
    const idx = _pending.findIndex((e) => e.op + '|' + e.date + '|' + e.token === key);
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
  if (!_dir || _writing) return;
  if (!_dirty && !_pending.length) return;
  _writing = true;
  try {
    const perm = await _dir.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      _lastError = 'permission needed';
      updateStatus();
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

    await appendText(_dir, LATEST, payload);
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
    updateStatus();
  }
}

async function backupNow() {
  _dirty = true;
  await flush();
  if (_lastError) throw new Error(_lastError);
  return { folderName: _dir ? _dir.name || '' : '', lastAt: _lastAt };
}

// ---------- restore ----------

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
  const n = await PatientDb.replayLog(ops);
  return { source, count: n, folderName: _dir.name || '' };
}

async function restoreFromFileObject(file) {
  const text = await file.text();
  const ops = parseBackup(text, file.name);
  const n = await PatientDb.replayLog(ops);
  return { mode: 'upload', filename: file.name, count: n };
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
  backupNow,
  restoreFromFolder,
  restoreFromFileObject,
  downloadCsv,
  parseBackup,
  state: () => ({
    hasFolder: !!_dir,
    folderName: _dir ? _dir.name || '' : '',
    lastAt: _lastAt,
    lastError: _lastError,
  }),
};
