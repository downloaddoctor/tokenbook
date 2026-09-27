// Reusable revision-history modal. Timeline of every appended revision of one
// entity (person or visit), newest first, with a per-step diff.
//
// Self-contained: owns its DOM lookups, keyboard nav, and the diff engine.
// Open from anywhere via openRevisions(entity, rootId).
// Element ids live in index.html (#revisions-modal, -title, -meta, -list).

import db from '../core/db.js';
import { timeAgo } from './dom.js';

let active = -1;       // keyboard-highlighted item index
let wired = false;
let currentEntity = null;
let currentRootId = null;

function el(id) {
  return document.getElementById(id);
}

function items() {
  const list = el('revisions-list');
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
  const modal = el('revisions-modal');
  const close = el('revisions-close');
  if (close) close.addEventListener('click', closeRevisions);
  if (modal)
    modal.addEventListener('click', (e) => {
      // Backdrop click (the dialog itself, not the inner card).
      if (e.target === modal) closeRevisions();
    });
  document.addEventListener('keydown', onKeydown);
}

function onKeydown(e) {
  const modal = el('revisions-modal');
  if (!modal || !modal.open) return;
  if (e.key === 'Escape') {
    // Native <dialog> also closes on Esc; prevent default and route through us
    // so state resets deterministically.
    e.preventDefault();
    closeRevisions();
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
  }
}

export function closeRevisions() {
  clearActive();
  const modal = el('revisions-modal');
  if (modal && modal.open) modal.close();
  currentEntity = null;
  currentRootId = null;
}

// ---- diff engine ------------------------------------------------------
// Fields that are metadata, not content — never shown as a change.
const META_KEYS = new Set(['v', 'createdAt', 'rootId', 'personV']);

// Human labels. Falls back to the raw key.
const LABELS = {
  name: 'Name',
  mob: 'Mobile',
  age: 'Age',
  gender: 'Gender',
  weight: 'Weight',
  hidden: 'Visibility',
  date: 'Date',
  token: 'Token',
  personId: 'Patient',
  followup: 'Follow up',
  payment: 'Payment',
  fee: 'Fee',
  refundTier: 'Refund',
};

function fmt(key, val, entity) {
  if (key === 'hidden') return val ? 'hidden' : 'active';
  if (key === 'followup') return val ? 'free follow-up' : 'paid';
  if (key === 'payment') return val ? 'UPI' : 'Cash';
  if (key === 'refundTier') return val ? '₹' + Number(val) * 100 : 'none';
  if (key === 'fee') return '₹' + (val == null ? 0 : val);
  if (key === 'personId') return '#' + val;
  if (key === 'weight') return val == null ? '—' : val + ' kg';
  return val == null || val === '' ? '—' : String(val);
}

// Compare two revisions of the same root. Returns changed fields as
// [{ key, label, from, to }]. `prev` may be null (first revision = "created").
export function diffRevisions(prev, cur, entity) {
  const out = [];
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(cur || {})]);
  for (const key of keys) {
    if (META_KEYS.has(key)) continue;
    const a = prev ? prev[key] : undefined;
    const b = cur ? cur[key] : undefined;
    // Normalize null/undefined so a missing key doesn't read as a change.
    const an = a == null ? null : a;
    const bn = b == null ? null : b;
    if (prev && an === bn) continue;
    out.push({
      key,
      label: LABELS[key] || key,
      from: prev ? fmt(key, a, entity) : null,
      to: fmt(key, b, entity),
    });
  }
  return out;
}

// ---- rendering --------------------------------------------------------

function renderStep(rev, prev, index, total) {
  const item = document.createElement('div');
  item.className = 'hx-item rev-item';
  item.dataset.v = String(rev.v);

  const dot = document.createElement('div');
  dot.className = 'hx-dot';

  const body = document.createElement('div');
  body.className = 'hx-body';

  const head = document.createElement('div');
  head.className = 'hx-head';
  const when = rev.createdAt ? new Date(rev.createdAt) : null;
  const abs = when ? when.toLocaleString() : '';
  const rel = rev.createdAt ? timeAgo(rev.createdAt) : '';
  head.append(
    span('hx-date', 'v' + rev.v + (index === 0 ? ' · current' : '')),
    span('hx-badge', rev.hidden ? 'hidden' : 'active'),
    span('hx-time', rel ? rel + (abs ? ' · ' + abs : '') : abs)
  );
  if (rev.hidden) item.classList.add('hidden-rev');

  const meta = document.createElement('div');
  meta.className = 'hx-meta rev-changes';

  if (!prev) {
    meta.textContent = 'created';
  } else {
    const changes = diffRevisions(prev, rev, currentEntity);
    if (!changes.length) {
      meta.textContent = 'no field change';
    } else {
      for (const c of changes) {
        const row = document.createElement('div');
        row.className = 'rev-change';
        const label = document.createElement('span');
        label.className = 'rev-label';
        label.textContent = c.label;
        const val = document.createElement('span');
        val.className = 'rev-val';
        val.textContent = c.from == null ? c.to : c.from + ' → ' + c.to;
        row.append(label, val);
        meta.appendChild(row);
      }
    }
  }

  body.append(head, meta);
  item.append(dot, body);
  return item;
}

// Open the revision timeline for one entity. entity: 'person' | 'visit'.
export async function openRevisions(entity, rootId) {
  if (!entity || rootId == null) return;
  wireOnce();
  const modal = el('revisions-modal');
  const titleEl = el('revisions-title');
  const metaEl = el('revisions-meta');
  const listEl = el('revisions-list');
  if (!modal || !listEl) return;

  currentEntity = entity;
  currentRootId = rootId;

  const revs = await db.revisionsOf(entity, rootId);
  revs.sort((a, b) => a.v - b.v);

  let label = entity === 'person' ? 'Patient' : 'Visit';
  let sub = '';
  const cur = revs[revs.length - 1];
  if (entity === 'person' && cur) {
    label = cur.name || ('Patient #' + rootId);
    sub = cur.mob || '';
  } else if (entity === 'visit' && cur) {
    label = 'Visit · token ' + cur.token;
    sub = cur.date + ' · ' + revs.length + ' revision' + (revs.length === 1 ? '' : 's');
  }
  if (titleEl) titleEl.textContent = label;
  if (metaEl) metaEl.textContent = sub;

  listEl.replaceChildren();
  active = -1;
  // Newest first for display.
  for (let i = revs.length - 1; i >= 0; i--) {
    const prev = i > 0 ? revs[i - 1] : null;
    listEl.appendChild(renderStep(revs[i], prev, revs.length - 1 - i, revs.length));
  }
  if (!revs.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No revisions.';
    listEl.appendChild(empty);
  }
  if (!modal.open) modal.showModal();
}
