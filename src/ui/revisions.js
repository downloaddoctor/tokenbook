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
  activityState = null;
}

// ---- diff engine ------------------------------------------------------
// Fields that are metadata, not content — never shown as a change.
// Metadata never shown as a content change. `personV` is intentionally NOT here:
// when a visit only re-pins the patient's identity revision, that IS the change
// and must render as "Identity N → M" rather than "no field change".
const META_KEYS = new Set(['v', 'createdAt', 'revAt', 'rootId', 'userId', 'userV']);

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
  personV: 'Identity',
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
  if (key === 'personV') return 'v' + val;
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

function renderStep(rev, prev, index, total, entity) {
  const diffEntity = entity || currentEntity;
  const item = document.createElement('div');
  item.className = 'hx-item rev-item';
  item.dataset.v = String(rev.v);

  const dot = document.createElement('div');
  dot.className = 'hx-dot';

  const body = document.createElement('div');
  body.className = 'hx-body';

  const head = document.createElement('div');
  head.className = 'hx-head';
  // `revAt` = when THIS revision was written; fall back to createdAt for
  // legacy rows written before revAt existed.
  const stamp = rev.revAt || rev.createdAt;
  const when = stamp ? new Date(stamp) : null;
  const abs = when ? when.toLocaleString() : '';
  const rel = stamp ? timeAgo(stamp) : '';
  // Badge meaning: the newest v is "current"; older v's are "superseded".
  // `hidden` is a separate axis (soft delete) and overrides the label.
  const isCurrent = index === 0;
  let badge;
  let badgeCls = 'hx-badge';
  if (rev.hidden) {
    badge = 'hidden';
    badgeCls += ' badge-hidden';
  } else if (isCurrent) {
    badge = 'current';
    badgeCls += ' badge-current';
  } else {
    badge = 'superseded';
    badgeCls += ' badge-superseded';
  }
  head.append(
    span('hx-date', 'v' + rev.v),
    span(badgeCls, badge),
    span('hx-time', rel ? rel + (abs ? ' · ' + abs : '') : abs)
  );
  if (rev.hidden) item.classList.add('hidden-rev');

  const meta = document.createElement('div');
  meta.className = 'hx-meta rev-changes';

  if (!prev) {
    meta.textContent = 'created';
  } else {
    const changes = diffRevisions(prev, rev, diffEntity);
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

// Render one activity item: a step of some entity, tagged with its kind.
function renderActivityStep(entry, userLabel) {
  const { kind, rev, prev } = entry;
  const item = document.createElement('div');
  item.className = 'hx-item rev-item';
  item.dataset.kind = kind;
  item.dataset.rootId = String(entry.rootId);

  const dot = document.createElement('div');
  dot.className = 'hx-dot';

  const body = document.createElement('div');
  body.className = 'hx-body';

  const head = document.createElement('div');
  head.className = 'hx-head';
  const stamp = rev.revAt || rev.createdAt;
  const when = stamp ? new Date(stamp) : null;
  const abs = when ? when.toLocaleString() : '';
  const rel = stamp ? timeAgo(stamp) : '';
  // Kind badge: patient vs visit; plus the entity's own label (name / token).
  const kindLabel = kind === 'person' ? 'patient' : 'visit';
  const kindCls = 'hx-badge ' + (kind === 'person' ? 'badge-superseded' : 'badge-current');
  let entLabel = '';
  if (kind === 'person') entLabel = rev.name || ('Patient #' + entry.rootId);
  else entLabel = 'Visit · token ' + rev.token + ' · ' + rev.date;
  head.append(
    span(kindCls, kindLabel),
    span('hx-date', 'v' + rev.v),
    span('hx-entity', entLabel),
    span('hx-time', rel ? rel + (abs ? ' · ' + abs : '') : abs)
  );

  const meta = document.createElement('div');
  meta.className = 'hx-meta rev-changes';
  if (!prev) {
    meta.textContent = 'created';
  } else {
    const changes = diffRevisions(prev, rev, kind);
    if (!changes.length) meta.textContent = 'no field change';
    else {
      for (const c of changes) {
        const row = document.createElement('div');
        row.className = 'rev-change';
        row.append(
          span('rev-label', c.label),
          span('rev-val', c.from == null ? c.to : c.from + ' → ' + c.to)
        );
        meta.appendChild(row);
      }
    }
  }
  body.append(head, meta);
  item.append(dot, body);
  return item;
}

// Open a timeline of everything ONE USER did to patients + visits, newest first.
// Account-only changes (create/disable/reset) are intentionally NOT shown —
// they are not clinical work. Called from the Users page row click.
// Infinite scroll: PAGE items at a time, appended as the list nears the bottom.
const ACTIVITY_PAGE = 15;
let activityState = null; // { userId, offset, total, loading, done }

async function loadMoreActivity() {
  const st = activityState;
  if (!st || st.loading || st.done) return;
  st.loading = true;
  const listEl = el('revisions-list');
  const spinner = el('revisions-loading');
  if (spinner) spinner.hidden = false;
  try {
    const { items, total, hasMore } = await db.activityForUser(st.userId, {
      offset: st.offset,
      limit: ACTIVITY_PAGE,
    });
    for (const e of items) listEl.appendChild(renderActivityStep(e));
    st.offset += items.length;
    st.total = total;
    st.done = !hasMore || items.length === 0;
    const metaEl = el('revisions-meta');
    if (metaEl) {
      metaEl.textContent =
        st.offset + ' of ' + st.total + ' change' + (st.total === 1 ? '' : 's') +
        ' to patients + visits';
    }
    if (st.done && st.offset === 0) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No activity by this user.';
      listEl.appendChild(empty);
    }
  } finally {
    st.loading = false;
    if (spinner) spinner.hidden = true;
  }
}

function onActivityScroll(e) {
  if (!activityState) return;
  const box = e.target;
  if (box.scrollTop + box.clientHeight >= box.scrollHeight - 120) loadMoreActivity();
}

export async function openUserActivity(userId, username) {
  if (userId == null) return;
  wireOnce();
  const modal = el('revisions-modal');
  const titleEl = el('revisions-title');
  const metaEl = el('revisions-meta');
  const listEl = el('revisions-list');
  if (!modal || !listEl) return;

  currentEntity = null;
  currentRootId = null;

  if (titleEl) titleEl.textContent = (username || 'User #' + userId) + ' — activity';
  if (metaEl) metaEl.textContent = 'loading…';
  listEl.replaceChildren();

  activityState = { userId: Number(userId), offset: 0, total: 0, loading: false, done: false };
  const scrollBox = listEl.parentElement;
  if (scrollBox && !scrollBox._activityWired) {
    scrollBox._activityWired = true;
    scrollBox.addEventListener('scroll', onActivityScroll);
  }
  if (scrollBox) scrollBox.scrollTop = 0;

  if (!modal.open) modal.showModal();
  await loadMoreActivity();
}
