// Users page (admin only): list/create/disable/reset user + admin accounts.
// Registered in Pages + ROUTES; the topbar tab is hidden for non-admins by app.js.

import { bindOff, showError } from '../dom.js';
import { toast } from '../toast.js';
import {
  listUsers,
  createUser,
  setUserDisabled,
  resetPassword,
  currentUser,
  isAdmin,
} from '../../core/auth.js';
import { openUserActivity } from '../revisions.js';

let s;
let off;
let cache = [];

function rowEls() {
  return s && s.tbody ? Array.from(s.tbody.children) : [];
}

async function render() {
  const me = await currentUser();
  const admin = isAdmin(me);
  s.tbody.replaceChildren();
  if (!admin) {
    s.empty.textContent = 'Only admins can manage users.';
    s.empty.hidden = false;
    s.newBtn.disabled = true;
    return;
  }
  cache = await listUsers();
  s.empty.hidden = cache.length > 0;
  s.newBtn.disabled = false;

  for (const u of cache) {
    const tr = document.createElement('tr');
    tr.dataset.id = String(u.id);
    tr.className = 'row-click';
    tr.title = 'Click to see this user’s activity';
    if (u.disabled) tr.classList.add('disabled-row');
    const isMe = me && me.id === u.id;
    tr.addEventListener('click', (e) => {
      // Clicks on action buttons must NOT open the timeline.
      if (e.target.closest('button')) return;
      openUserActivity(u.id, u.username);
    });

    const tdName = document.createElement('td');
    tdName.textContent = u.username + (isMe ? ' (you)' : '');

    const tdRole = document.createElement('td');
    tdRole.textContent = u.role;

    const tdStatus = document.createElement('td');
    tdStatus.textContent = u.disabled ? 'disabled' : 'active';

    const tdLast = document.createElement('td');
    tdLast.textContent = u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '';

    const tdCreated = document.createElement('td');
    tdCreated.textContent = u.createdAt ? new Date(u.createdAt).toLocaleString() : '';

    const tdActions = document.createElement('td');
    tdActions.className = 'users-actions';

    const bReset = document.createElement('button');
    bReset.type = 'button';
    bReset.textContent = 'Reset password';
    bReset.addEventListener('click', () => onReset(u));

    const bToggle = document.createElement('button');
    bToggle.type = 'button';
    bToggle.textContent = u.disabled ? 'Enable' : 'Disable';
    // Cannot disable yourself (would lock you out and clear your own session).
    bToggle.disabled = isMe;
    bToggle.title = isMe ? 'You cannot disable your own account.' : '';
    bToggle.addEventListener('click', () => onToggle(u));

    tdActions.append(bReset, bToggle);

    tr.append(tdName, tdRole, tdStatus, tdLast, tdCreated, tdActions);
    s.tbody.appendChild(tr);
  }
}

async function onToggle(u) {
  try {
    await setUserDisabled(u.id, !u.disabled);
    toast((u.disabled ? 'Enabled ' : 'Disabled ') + u.username, 'ok');
    await render();
  } catch (e) {
    toast('Failed: ' + e.message, 'err');
  }
}

async function onReset(u) {
  const p1 = prompt(`New password for ${u.username} (min 4 chars):`);
  if (p1 == null) return;
  if (p1.length < 4) {
    toast('Password too short.', 'err');
    return;
  }
  const p2 = prompt('Confirm new password:');
  if (p2 == null) return;
  if (p1 !== p2) {
    toast('Passwords do not match.', 'err');
    return;
  }
  try {
    await resetPassword(u.id, p1);
    toast('Password reset for ' + u.username, 'ok');
    // If admin reset their own password, session is invalidated -> re-gate.
    const me = await currentUser();
    if (!me) {
      location.reload();
      return;
    }
    await render();
  } catch (e) {
    toast('Reset failed: ' + e.message, 'err');
  }
}

function openNewUserDialog() {
  const dlg = document.getElementById('user-new-dialog');
  if (!dlg) return;
  document.getElementById('user-new-name').value = '';
  document.getElementById('user-new-pass').value = '';
  document.getElementById('user-new-pass2').value = '';
  document.getElementById('user-new-role').value = 'user';
  const err = document.getElementById('user-new-err');
  showError(err);
  dlg.returnValue = '';
  dlg.showModal();
  document.getElementById('user-new-name').focus();
}

async function onCreateSubmit(e) {
  const form = document.getElementById('user-new-form');
  if (e.target !== form) return;
  // Prevent the native dialog close so we can validate.
  e.preventDefault();
  const err = document.getElementById('user-new-err');
  showError(err);
  const name = document.getElementById('user-new-name').value;
  const p1 = document.getElementById('user-new-pass').value;
  const p2 = document.getElementById('user-new-pass2').value;
  const role = document.getElementById('user-new-role').value;
  if (!name.trim()) {
    showError(err, 'Username is required.');
    return;
  }
  if (p1.length < 4) {
    showError(err, 'Password must be at least 4 characters.');
    return;
  }
  if (p1 !== p2) {
    showError(err, 'Passwords do not match.');
    return;
  }
  try {
    await createUser({ username: name, password: p1, role });
    toast('Created ' + role + ' ' + name.trim().toUpperCase(), 'ok');
    const dlg = document.getElementById('user-new-dialog');
    dlg.close('created');
    await render();
  } catch (e2) {
    showError(err, e2 && e2.message ? e2.message : String(e2));
  }
}

export async function mount() {
  s = {
    tbody: document.querySelector('#users-table tbody'),
    empty: document.getElementById('users-empty'),
    newBtn: document.getElementById('users-new'),
  };
  off = bindOff();
  off.on(s.newBtn, 'click', openNewUserDialog);
  off.on(document, 'submit', onCreateSubmit);
  await render();
}

export function unmount() {
  if (off) off.off();
  off = null;
  s = null;
}
