// Full-screen auth gate. Renders login OR create-admin into #auth-root and
// hides the app shell (topbar/main/statusbar) until a session exists.
//
// Not a router page: it runs before the router exists. app.js calls
// `showAuthGate({ onAuthed })` during boot; on success it un-hides the shell
// and continues the normal boot sequence.

import { login, createUser, needsFirstAdmin } from '../core/auth.js';

let root = null;
let onAuthedCb = null;

function ensureRoot() {
  if (root) return root;
  root = document.getElementById('auth-root');
  return root;
}

// Toggle the app shell. `locked` = auth screen showing.
function setShellLocked(locked) {
  const topbar = document.getElementById('app-topbar');
  const main = document.getElementById('main');
  const statusbar = document.getElementById('statusbar');
  for (const el of [topbar, main, statusbar]) {
    if (!el) continue;
    el.hidden = !!locked;
  }
  const authRoot = ensureRoot();
  if (authRoot) authRoot.hidden = !locked;
  document.body.classList.toggle('auth-locked', !!locked);
}

function clearRoot() {
  const authRoot = ensureRoot();
  if (authRoot) authRoot.replaceChildren();
}

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

function makeField(labelText, inputAttrs) {
  const input = el('input', { ...inputAttrs, autocomplete: 'off' });
  const label = el('label', { class: 'auth-field' }, [
    el('span', { class: 'auth-label', text: labelText }),
    input,
  ]);
  return { label, input };
}

// ---------- views ----------

function renderCreateAdmin() {
  clearRoot();
  const r = ensureRoot();
  const u = makeField('Admin username', { type: 'text', maxlength: '40', required: 'required' });
  const p = makeField('Password', { type: 'password', minlength: '4', required: 'required' });
  const p2 = makeField('Confirm password', { type: 'password', minlength: '4', required: 'required' });
  const err = el('p', { class: 'auth-error', hidden: 'hidden' });
  const btn = el('button', { type: 'submit', class: 'primary auth-submit', text: 'Create admin account' });

  const form = el('form', { class: 'auth-card', autocomplete: 'off' }, [
    el('h1', { class: 'auth-title', text: 'Welcome to TokenBook' }),
    el('p', { class: 'auth-sub', text: 'No users yet. Create the first (admin) account. This account can add user accounts later.' }),
    u.label, p.label, p2.label, err, btn,
  ]);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (!u.input.value.trim()) {
      err.textContent = 'Username is required.';
      err.hidden = false;
      return;
    }
    if (p.input.value !== p2.input.value) {
      err.textContent = 'Passwords do not match.';
      err.hidden = false;
      return;
    }
    btn.disabled = true;
    try {
      await createUser({
        username: u.input.value,
        password: p.input.value,
        role: 'admin',
      });
      // Auto-login the just-created admin.
      await login(u.input.value, p.input.value);
      onAuthedCb && onAuthedCb();
    } catch (e2) {
      err.textContent = e2 && e2.message ? e2.message : String(e2);
      err.hidden = false;
      btn.disabled = false;
    }
  });

  r.appendChild(el('div', { class: 'auth-wrap' }, [form]));
  u.input.focus();
}

function renderLogin() {
  clearRoot();
  const r = ensureRoot();
  const u = makeField('Username', { type: 'text', maxlength: '40', required: 'required' });
  const p = makeField('Password', { type: 'password', required: 'required' });
  const err = el('p', { class: 'auth-error', hidden: 'hidden' });
  const btn = el('button', { type: 'submit', class: 'primary auth-submit', text: 'Sign in' });

  const form = el('form', { class: 'auth-card', autocomplete: 'off' }, [
    el('h1', { class: 'auth-title', text: 'TokenBook' }),
    el('p', { class: 'auth-sub', text: 'Sign in to continue.' }),
    u.label, p.label, err, btn,
  ]);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    btn.disabled = true;
    try {
      await login(u.input.value, p.input.value);
      onAuthedCb && onAuthedCb();
    } catch (e2) {
      err.textContent = e2 && e2.message ? e2.message : String(e2);
      err.hidden = false;
      btn.disabled = false;
      p.input.value = '';
      p.input.focus();
    }
  });

  r.appendChild(el('div', { class: 'auth-wrap' }, [form]));
  u.input.focus();
}

// Public entry: shows the correct view for the current state.
// Resolves nothing; calls onAuthed() once a session is established.
export async function showAuthGate({ onAuthed } = {}) {
  onAuthedCb = typeof onAuthed === 'function' ? onAuthed : null;
  setShellLocked(true);
  const first = await needsFirstAdmin();
  if (first) renderCreateAdmin();
  else renderLogin();
}

// Called by app.js after logout to re-show the gate.
export async function relock() {
  await showAuthGate({ onAuthed: onAuthedCb });
}

export function hideGate() {
  setShellLocked(false);
  clearRoot();
}
