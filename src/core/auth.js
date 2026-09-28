// Authentication + sessions. Client-only, no server.
//
// Users live in the IndexedDB `users` store (db.js schema v2). Passwords are
// never stored in plaintext: PBKDF2-SHA256 via WebCrypto, 150k iterations,
// 16-byte random salt per user, 32-byte derived key. Both salt + hash are
// base64 in the store; the plaintext never leaves the form.
//
// Session model: on successful login a fresh random token is written to the
// user row (users.sessionToken) AND to localStorage 'tokenbook-session' as
// { userId, token, exp }. `requireAuth()` re-reads the user row and compares
// tokens, so logout / disable / password reset on any tab invalidates other
// tabs on their next gate check.
//
// Boot gate:
//   - countUsers() === 0  -> caller renders the Create-Admin view.
//   - no valid session    -> caller renders the Login view.
//   - valid session       -> caller boots the app; currentUser() is cached.

import db from './db.js';

const SESSION_KEY = 'tokenbook-session';
const SESSION_DAYS = 30;
const PBKDF2_ITER = 150000;
const PBKDF2_HASH = 'SHA-256';
const SALT_BYTES = 16;
const KEY_BYTES = 32;

let _current = null; // cached user row for the active session (or null)

// ---------- base64 helpers (Uint8Array <-> b64) ----------

function b64encode(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

function b64decode(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Timing-safe-ish compare for two b64 strings of equal length. Not a
// substitute for a constant-time HMAC, but removes the trivial early-exit.
function b64Equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomB64(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64encode(buf);
}

// ---------- password hashing ----------

async function deriveKey(password, saltBytes, iter) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(password)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: PBKDF2_HASH, salt: saltBytes, iterations: iter },
    baseKey,
    KEY_BYTES * 8
  );
  return new Uint8Array(bits);
}

// Returns { salt, hash, iter } for storing on a user row.
export async function hashPassword(password) {
  if (password == null || String(password).length < 4) {
    const e = new Error('Password must be at least 4 characters.');
    e.name = 'WeakPasswordError';
    throw e;
  }
  const saltBytes = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(saltBytes);
  const hashBytes = await deriveKey(password, saltBytes, PBKDF2_ITER);
  return { salt: b64encode(saltBytes), hash: b64encode(hashBytes), iter: PBKDF2_ITER };
}

// Constant-ish compare of a candidate password against a user row.
// The stored `iter` is clamped to a sane range: a tampered row cannot weaken
// verification by setting a tiny count, and cannot DoS the tab by setting a
// huge one. Values outside the range are ignored (fall back to default).
const MIN_ITER = 10000;
const MAX_ITER = 5000000;
export async function verifyPassword(user, password) {
  if (!user || !user.salt || !user.hash) return false;
  const raw = Number(user.iter);
  const iter = Number.isFinite(raw) && raw >= MIN_ITER && raw <= MAX_ITER ? Math.floor(raw) : PBKDF2_ITER;
  const hashBytes = await deriveKey(password, b64decode(user.salt), iter);
  return b64Equal(b64encode(hashBytes), user.hash);
}

// ---------- user records ----------

function normName(username) {
  return String(username == null ? '' : username).trim().toUpperCase();
}

export async function countUsers() {
  return db.raw().users.count();
}

export async function listUsers() {
  const rows = await db.raw().users.orderBy('username').toArray();
  return rows;
}

export async function getUserByName(username) {
  const u = normName(username);
  if (!u) return null;
  return (await db.raw().users.where('username').equals(u).first()) || null;
}

export async function getUserById(id) {
  if (id == null) return null;
  return (await db.raw().users.get(Number(id))) || null;
}

// Normalize + enforce uniqueness for every NEW user insert. All creation
// paths go through this so a future import/reset cannot silently insert a
// differently-cased duplicate of an existing username.
async function _insertUser(row) {
  const u = normName(row.username);
  if (!u) {
    const e = new Error('Username is required.');
    e.name = 'MissingUsernameError';
    throw e;
  }
  const existing = await getUserByName(u);
  if (existing) {
    const e = new Error('Username already exists.');
    e.name = 'DuplicateUsernameError';
    throw e;
  }
  const normalized = { ...row, username: u };
  const id = await db.raw().users.add(normalized);
  return { ...normalized, id };
}

// Roles: 'admin' (full) | 'user' (everything except Print Layout + Users).
export async function createUser({ username, password, role = 'user' }) {
  const { salt, hash, iter } = await hashPassword(password);
  const now = new Date().toISOString();
  const saved = await _insertUser({
    username,
    role: role === 'admin' ? 'admin' : 'user',
    salt,
    hash,
    iter,
    disabled: 0,
    sessionToken: '',
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    failedLogins: 0,
    lockedUntil: null,
  });
  // Append the user revision (audit trail; logged to CSV without secrets).
  await db.appendUserRevision(saved);
  return saved;
}

export async function setUserDisabled(id, disabled) {
  const u = await getUserById(id);
  if (!u) throw new Error('User not found: ' + id);
  const patch = {
    disabled: disabled ? 1 : 0,
    updatedAt: new Date().toISOString(),
  };
  // Disabling also invalidates any live session immediately.
  if (disabled) patch.sessionToken = '';
  await db.raw().users.update(id, patch);
  const saved = { ...u, ...patch };
  await db.appendUserRevision(saved);
  // If the disabled user is the current session, drop it.
  if (disabled && _current && _current.id === u.id) logout();
  return saved;
}

export async function resetPassword(id, newPassword) {
  const u = await getUserById(id);
  if (!u) throw new Error('User not found: ' + id);
  const { salt, hash, iter } = await hashPassword(newPassword);
  const patch = {
    salt,
    hash,
    iter,
    sessionToken: '', // invalidate live sessions
    updatedAt: new Date().toISOString(),
  };
  await db.raw().users.update(id, patch);
  const saved = { ...u, ...patch };
  await db.appendUserRevision(saved);
  if (_current && _current.id === u.id) logout();
  return saved;
}

// ---------- session ----------

function writeSession(userId, token, expMs) {
  try {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ userId, token, exp: expMs })
    );
  } catch (_) {
    /* private mode / storage disabled — session becomes tab-local in memory */
  }
}

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return null;
    if (typeof s.exp === 'number' && s.exp > 0 && Date.now() > s.exp) return null;
    return s;
  } catch (_) {
    return null;
  }
}



function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (_) { }
}

// Login throttling: after MAX_FAILED consecutive bad passwords, lock the
// account for LOCK_MS. State lives on the user row (failedLogins, lockedUntil)
// so it survives a reload and is shared with every tab through IndexedDB.
const MAX_FAILED = 5;
const LOCK_MS = 5 * 60 * 1000;

// Log in. Returns the user row on success, throws on failure.
export async function login(username, password) {
  const u = await getUserByName(username);
  // Same generic error for unknown user and bad password.
  const fail = () => {
    const e = new Error('Incorrect username or password.');
    e.name = 'BadCredentialsError';
    return e;
  };
  if (!u) throw fail();
  if (u.disabled) {
    const e = new Error('This account is disabled.');
    e.name = 'DisabledAccountError';
    throw e;
  }
  // Lockout check (before hashing — cheap rejection).
  const now0 = Date.now();
  if (u.lockedUntil && u.lockedUntil > now0) {
    const secs = Math.ceil((u.lockedUntil - now0) / 1000);
    const e = new Error(`Too many failed attempts. Try again in ${secs}s.`);
    e.name = 'LockedOutError';
    e.retryAfterMs = u.lockedUntil - now0;
    throw e;
  }
  const ok = await verifyPassword(u, password);
  if (!ok) {
    const failed = (Number(u.failedLogins) || 0) + 1;
    const patch = { failedLogins: failed };
    if (failed >= MAX_FAILED) {
      patch.lockedUntil = Date.now() + LOCK_MS;
      patch.failedLogins = 0; // reset so the next attempt after the lock starts fresh
    }
    try { await db.raw().users.update(u.id, patch); } catch (_) { /* best-effort */ }
    throw fail();
  }
  // Success: clear any failure counter + lock.
  const token = randomB64(32);
  const now = new Date().toISOString();
  const exp = Date.now() + SESSION_DAYS * 86400000;
  await db.raw().users.update(u.id, {
    sessionToken: token,
    lastLoginAt: now,
    updatedAt: now,
    failedLogins: 0,
    lockedUntil: null,
  });
  writeSession(u.id, token, exp);
  _current = {
    ...u,
    sessionToken: token,
    lastLoginAt: now,
    failedLogins: 0,
    lockedUntil: null,
    v: await _latestUserV(u.id),
  };
  return _current;
}

// Latest user revision number (1 if none). Used to stamp the actor on DB writes.
async function _latestUserV(id) {
  try {
    const revs = await db.userRevisions(id);
    return revs.length ? revs[revs.length - 1].v : 1;
  } catch (_) {
    return 1;
  }
}

// Log out: clear the token on the row + the localStorage entry + memory cache.
export async function logout() {
  const cur = _current || (await currentUser());
  if (cur && cur.id != null) {
    try {
      await db.raw().users.update(cur.id, {
        sessionToken: '',
        updatedAt: new Date().toISOString(),
      });
    } catch (_) { }
  }
  _current = null;
  clearSession();
}

// Resolve the current user (row or null), verifying the session token against
// the user row. Cached in memory after the first successful check.
export async function currentUser() {
  if (_current) return _current;
  const s = readSession();
  if (!s || s.userId == null || !s.token) return null;
  const u = await getUserById(s.userId);
  if (!u || u.disabled) {
    clearSession();
    return null;
  }
  if (!b64Equal(u.sessionToken || '', s.token)) {
    // Token rotated elsewhere (login/reset/disable) — this tab is stale.
    clearSession();
    return null;
  }
  _current = { ...u, v: await _latestUserV(u.id) };
  return _current;
}

// Boot gate helper. Returns:
//   { state: 'create-admin' }  — no users exist; caller shows Create Admin
//   { state: 'login' }         — users exist, no valid session
//   { state: 'authed', user }  — valid session
export async function requireAuth() {
  const n = await countUsers();
  if (n === 0) return { state: 'create-admin' };
  const u = await currentUser();
  if (!u) return { state: 'login' };
  return { state: 'authed', user: u };
}

export function isAdmin(user) {
  return !!(user && user.role === 'admin');
}

// Synchronous view of the cached session user (null if none). Used by the
// db actor hook — DB writes are sync-path and cannot await the session check.
export function currentUserSync() {
  return _current || null;
}



// Used by login view: which mode to render.
export async function needsFirstAdmin() {
  return (await countUsers()) === 0;
}
