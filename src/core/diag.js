// Diagnostics: ring buffer for console.warn/error + a snapshot builder for the
// "Copy diagnostics" button in the Log dialog. No dependencies, no side effects
// until install() is called (from app.js at boot).
//
// Scope: dev-and-field support only. The ring lives in memory; nothing is
// persisted. install() is idempotent.

const RING_MAX = 50;
const ring = [];
let installed = false;
let origWarn = null;
let origError = null;

function toLine(level, args) {
  const ts = new Date().toISOString();
  const parts = [];
  for (const a of args) {
    if (a == null) parts.push(String(a));
    else if (typeof a === 'string') parts.push(a);
    else if (a instanceof Error) parts.push(a.name + ': ' + a.message);
    else {
      try {
        parts.push(JSON.stringify(a));
      } catch (_) {
        parts.push(String(a));
      }
    }
  }
  return ts + ' ' + level + ' ' + parts.join(' ');
}

function push(level, args) {
  ring.push(toLine(level, args));
  if (ring.length > RING_MAX) ring.shift();
}

// Wrap console.warn/console.error so recent messages are captured. Call once
// from app.js boot. Safe to call twice (second call is a no-op).
export function install() {
  if (installed) return;
  installed = true;
  origWarn = console.warn.bind(console);
  origError = console.error.bind(console);
  console.warn = (...args) => {
    push('WARN', args);
    origWarn(...args);
  };
  console.error = (...args) => {
    push('ERR ', args);
    origError(...args);
  };
}

// Recent buffered warn/error lines, oldest first.
export function recent() {
  return ring.slice();
}

// Snapshot the app + backup + DB state into a pasteable text block. Async
// because DB counts are looked up live. `db` and `backup` are passed in by the
// caller so this module never imports them (avoids load-order surprises).
export async function snapshot({ db, backup, appVersion } = {}) {
  const lines = [];
  lines.push('=== TokenBook diagnostics ===');
  lines.push('at: ' + new Date().toISOString());
  lines.push('ua: ' + (navigator.userAgent || ''));
  lines.push('lang: ' + (navigator.language || ''));
  lines.push('url: ' + location.href);
  if (appVersion != null) lines.push('app: v' + appVersion);

  // App shell / version.txt sentinel (best-effort).
  try {
    const r = await fetch('./version.txt', { cache: 'no-store' });
    if (r.ok) lines.push('version.txt: ' + (await r.text()).trim());
  } catch (_) {}

  if (db && typeof db.countAll === 'function') {
    try {
      lines.push('db: visits=' + (await db.countAll()) + ' people=' + (await db.countPeople()));
    } catch (e) {
      lines.push('db: <error: ' + (e && e.message ? e.message : e) + '>');
    }
  }

  if (backup && typeof backup.state === 'function') {
    try {
      const s = backup.state();
      lines.push(
        'backup: hasFolder=' + !!s.hasFolder + ' folder=' + (s.folderName || '') +
        ' pending=' + s.pending + ' dirty=' + !!s.dirty +
        ' lastAt=' + (s.lastAt || 'never') + ' lastError=' + (s.lastError || '')
      );
    } catch (e) {
      lines.push('backup: <error: ' + (e && e.message ? e.message : e) + '>');
    }
  }

  if (navigator.storage && navigator.storage.estimate) {
    try {
      const e = await navigator.storage.estimate();
      lines.push(
        'storage: usage=' + (e.usage || 0) + ' quota=' + (e.quota || 0)
      );
    } catch (_) {}
  }

  const rec = recent();
  lines.push('--- recent console (' + rec.length + '/' + RING_MAX + ') ---');
  for (const l of rec) lines.push(l);
  if (!rec.length) lines.push('(none)');
  lines.push('=== end ===');
  return lines.join('\n');
}
