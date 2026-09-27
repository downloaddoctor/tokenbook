// Tokens page: pick a day, list its visits in issue order.

import db from '../../core/db.js';
import { bindOff } from '../dom.js';
import { toast } from '../toast.js';
import { openRefundFor, refundLabel } from '../refund.js';


let s;
let rowCache = new Map(); // visitId -> visit row (rendered page)
let activeRow = -1;       // index of the keyboard-highlighted row

function rowEls() {
  return s && s.tbody ? Array.from(s.tbody.children) : [];
}

function setActiveRow(i) {
  const rows = rowEls();
  if (!rows.length) {
    activeRow = -1;
    return;
  }
  i = Math.max(0, Math.min(i, rows.length - 1));
  for (let k = 0; k < rows.length; k++) rows[k].classList.toggle('active', k === i);
  activeRow = i;
  rows[i].scrollIntoView({ block: 'nearest' });
}

function clearActiveRow() {
  for (const tr of rowEls()) tr.classList.remove('active');
  activeRow = -1;
}



function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function refresh() {
  const day = s.dateEl.value || ymd(new Date());
  const rows = await db.listByDate(day);
  s.tbody.replaceChildren();
  rowCache = new Map();
  activeRow = -1;
  let collected = 0;
  let refunded = 0;
  let paidCount = 0;
  let freeCount = 0;
  let cashTotal = 0;
  let upiTotal = 0;
  for (const r of rows) {
    rowCache.set(r.rootId, r);
    const fee = Number(r.fee) || 0;
    const refund = db.refundAmountFor(r.refundTier);
    const net = fee - refund;
    if (r.followup) freeCount++;
    else {
      paidCount++;
      collected += net;
      refunded += refund;
      if (r.payment) upiTotal += net;
      else cashTotal += net;
    }
    const tr = document.createElement('tr');
    tr.className = 'row-click';
    tr.dataset.id = String(r.rootId);
    for (const c of [
      r.token,
      r.name,
      r.mob,
      r.age,
      r.gender || '',
      r.weight != null ? r.weight : '',
      r.followup ? 'Yes' : 'No',
      r.payment ? 'UPI' : 'Cash',
      r.fee != null ? r.fee : '',
      refundLabel(r.refundTier),
      new Date(r.updatedAt || r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    ]) {
      const td = document.createElement('td');
      td.textContent = String(c);
      tr.appendChild(td);
    }
    s.tbody.appendChild(tr);
  }
  s.empty.hidden = rows.length > 0;

  if (s.summary) {
    if (!rows.length) {
      s.summary.hidden = true;
      s.summary.textContent = '';
    } else {
      s.summary.hidden = false;
      const parts = [
        `Visits: ${rows.length} (${paidCount} paid · ${freeCount} free)`,
        `Collected: ₹${collected}`,
        `Cash: ₹${cashTotal}`,
        `UPI: ₹${upiTotal}`,
      ];
      if (refunded > 0) parts.push(`Refunded: ₹${refunded}`);
      s.summary.textContent = parts.join('  ·  ');
    }
  }
}

async function onRowClick(e) {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  await activateRow(Number(tr.dataset.id));
}

// Open the refund dialog for a visit by id (shared by click + Enter).
async function activateRow(visitId) {
  const visit = rowCache.get(visitId);
  if (!visit) return;
  // Follow-up visits were free — nothing to refund.
  if (visit.followup) {
    toast('Free follow-up visit — no refund.', 'err');
    return;
  }
  try {
    const choice = await openRefundFor(visit);
    if (choice == null) return;
    toast(choice === '0' ? 'Refund cleared.' : `Refund set: ${refundLabel(choice)}.`, 'ok');
    refresh();
  } catch (err) {
    toast('Refund failed: ' + err.message, 'err');
  }
}

export function mount() {
  s = {
    dateEl: document.getElementById('tokens-date'),
    todayBtn: document.getElementById('tokens-today'),
    tbody: document.querySelector('#tokens-table tbody'),
    empty: document.getElementById('tokens-empty'),
    summary: document.getElementById('tokens-summary'),
  };
  s.dateEl.value = ymd(new Date());
  const off = bindOff();
  off.on(s.dateEl, 'change', refresh);
  off.on(s.todayBtn, 'click', () => {
    s.dateEl.value = ymd(new Date());
    refresh();
  });
  off.on(s.tbody, 'click', onRowClick);
  // Arrow keys navigate; Enter opens the highlighted visit for editing in
  // Register. Ignored when focus is in an input/select/dialog.
  off.on(document, 'keydown', (e) => {
    if (!s.tbody || !rowEls().length) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const dlgOpen = document.querySelector('dialog[open]');
    if (dlgOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveRow(activeRow < 0 ? 0 : activeRow + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveRow(activeRow < 0 ? rowEls().length - 1 : activeRow - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveRow(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveRow(rowEls().length - 1);
    } else if (e.key === 'Enter' && activeRow >= 0) {
      const tr = rowEls()[activeRow];
      if (tr && tr.dataset.id) {
        e.preventDefault();
        activateRow(Number(tr.dataset.id));
      }
    } else if (e.key === 'Escape' && activeRow >= 0) {
      e.preventDefault();
      clearActiveRow();
    }
  });
  s.off = off;
  refresh();
}

export function unmount() {
  if (s && s.off) s.off.off();
}
