// Reusable patient-history modal: a visit timeline for one person.
// Self-contained — owns its DOM lookups, keyboard nav, and the Enter ->
// edit-in-Register handoff. Open from anywhere via openHistory(personId).
//
// Element ids live in index.html (#history-modal, #history-name,
// #history-meta, #history-list, #history-close).

import db from '../core/db.js';
import { getRouter } from './router.js';
import { editVisit } from './pages/register.js';

let active = -1; // index of the keyboard-highlighted timeline item
let visitCache = new Map(); // visitId -> visit row (currently rendered)
let wired = false;

function el(id) {
  return document.getElementById(id);
}

function items() {
  const list = el('history-list');
  return list ? Array.from(list.children) : [];
}

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text == null ? '' : String(text);
  return s;
}

function setActive(i) {
  const list = items();
  if (!list.length) {
    active = -1;
    return;
  }
  i = Math.max(0, Math.min(i, list.length - 1));
  for (let k = 0; k < list.length; k++) list[k].classList.toggle('hx-active', k === i);
  active = i;
  list[i].scrollIntoView({ block: 'nearest' });
}

function clearActive() {
  for (const it of items()) it.classList.remove('hx-active');
  active = -1;
}

function wireOnce() {
  if (wired) return;
  wired = true;
  const modal = el('history-modal');
  const close = el('history-close');
  if (close) close.addEventListener('click', closeHistory);
  if (modal)
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeHistory();
    });
  document.addEventListener('keydown', onKeydown);
}

function onKeydown(e) {
  const modal = el('history-modal');
  if (!modal || modal.hidden) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeHistory();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    setActive(active < 0 ? 0 : active + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setActive(active < 0 ? items().length - 1 : active - 1);
  } else if (e.key === 'Home') {
    e.preventDefault();
    setActive(0);
  } else if (e.key === 'End') {
    e.preventDefault();
    setActive(items().length - 1);
  } else if (e.key === 'Enter') {
    const list = items();
    if (active < 0 || active >= list.length) return;
    e.preventDefault();
    const id = list[active].dataset.id;
    if (!id) return;
    closeHistory();
    openInRegister(Number(id));
  }
}

export function closeHistory() {
  clearActive();
  const modal = el('history-modal');
  if (modal) modal.hidden = true;
}

// Enter on a timeline entry: load that visit in the Register tab for editing.
async function openInRegister(visitId) {
  const visit = visitCache.get(visitId);
  if (!visit) return;
  const router = getRouter();
  if (router) router.activateTab('register');
  await editVisit(visit);
}

function renderItem(v) {
  const item = document.createElement('div');
  item.className = 'hx-item ' + (v.followup ? 'followup' : 'paid');
  item.dataset.id = String(v.id);

  const dot = document.createElement('div');
  dot.className = 'hx-dot';

  const body = document.createElement('div');
  body.className = 'hx-body';

  const head = document.createElement('div');
  head.className = 'hx-head';
  const time = new Date(v.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  head.append(
    span('hx-date', v.date),
    span('hx-badge', v.followup ? 'Follow up' : 'Paid'),
    span('hx-time', time)
  );

  const meta = document.createElement('div');
  meta.className = 'hx-meta';
  const bits = [
    'Token ' + v.token,
    'Fee ₹' + (v.fee != null ? v.fee : 0),
    'Age ' + v.age,
    v.gender || '—',
    v.weight != null ? v.weight + ' kg' : '—',
    v.payment ? 'UPI' : 'Cash',
  ];
  if (v.refundTier) bits.push('Refund ₹' + db.refundAmountFor(v.refundTier));
  meta.textContent = bits.join(' · ');

  body.append(head, meta);
  item.append(dot, body);
  return item;
}

export async function openHistory(personId) {
  if (!personId) return;
  wireOnce();
  const modal = el('history-modal');
  const nameEl = el('history-name');
  const metaEl = el('history-meta');
  const listEl = el('history-list');
  if (!modal || !listEl) return;

  const p = await db.getPerson(personId);
  const visits = await db.visitsForPerson(personId);

  if (nameEl) nameEl.textContent = p ? p.name : `Patient #${personId}`;
  if (metaEl)
    metaEl.textContent = p
      ? `${p.mob} · Age ${p.age} · ${p.gender || '—'}${p.weight != null ? ' · ' + p.weight + ' kg' : ''}`
      : '';

  listEl.replaceChildren();
  active = -1;
  visitCache = new Map();
  for (const v of visits) {
    visitCache.set(v.id, v);
    listEl.appendChild(renderItem(v));
  }
  modal.hidden = false;
}
