// Backup / restore to a user-chosen folder (typically a pendrive) via the
// File System Access API. No JSON. Flat CSV, one row per visit, delimiter
// U+2016 (‖) so ordinary names never need quoting.
//
// Cadence: callers mark the backup dirty after any DB change
// (PatientBackup.markDirty). Writes are debounced DEBOUNCE_MS and also
// flushed on visibilitychange -> hidden. A failed write never blocks the
// caller — it just updates the status line.

import { PatientDb } from '../core/db.js';
import { visitsToCsv, parseBackup } from './csv.js';
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

function markDirty() {
  if (!_dir) return;
  _dirty = true;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    _timer = null;
    flush().catch((e) => console.error('auto-backup', e));
  }, DEBOUNCE_MS);
}

async function flush() {
  if (!_dir || _writing) return;
  if (!_dirty) return;
  _writing = true;
  try {
    const perm = await _dir.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      _lastError = 'permission needed';
      updateStatus();
      return;
    }
    const data = await PatientDb.exportAll();
    const text = visitsToCsv(data.visits || []);
    await writeText(_dir, LATEST, text);
    const day = PatientDb.localDay();
    const snap = `apt-list-${day}.csv`;
    if (!(await fileExists(_dir, snap))) await writeText(_dir, snap, text);
    await pruneSnapshots(_dir);
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
  let data;
  try {
    data = parseBackup(text, LATEST);
  } catch (e) {
    const snap = await readNewestSnapshot(_dir);
    if (!snap) throw e;
    data = parseBackup(snap, LATEST);
    source = 'snapshot';
  }
  const n = await PatientDb.replaceAll(data);
  return { source, count: n, folderName: _dir.name || '' };
}

async function restoreFromFileObject(file) {
  const text = await file.text();
  const data = parseBackup(text, file.name);
  const n = await PatientDb.replaceAll(data);
  return { mode: 'upload', filename: file.name, count: n };
}

// Fallback export: when File System Access is unavailable or the user cancels
// the folder picker, download the CSV directly. Filename is date-stamped so
// repeated clicks don't collide in the Downloads folder.
async function downloadCsv() {
  const data = await PatientDb.exportAll();
  const text = visitsToCsv(data.visits || []);
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
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { filename, count: (data.visits || []).length };
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
