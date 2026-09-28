// Tokens page: pick a day, list its visits in issue order.

import db from '../../core/db.js';
import { bindOff, isTypingTarget, isDialogOpen } from '../dom.js';
import { createListNav } from '../listNav.js';
import { toast } from '../toast.js';
import { openRefundFor, refundLabel } from '../refund.js';

const PAGE = 50;

let s;
let rowCache = new Map(); // visitId -> visit row (rendered page)
let nav;                  // keyboard row navigation

const ymd = (d) => db.localDay(d);

function ym(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Last day of the month for a 'YYYY-MM' string (e.g. '2026-02' -> '2026-02-28').
function monthEnd(mo) {
  const [y, m] = mo.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${mo}-${String(last).padStart(2, '0')}`;
}

// Set which inputs are visible for the current mode + clear stale day-list nav.
function applyMode() {
  const mode = s.mode;
  for (const b of s.modeBtns) b.classList.toggle('active', b.dataset.mode === mode);
  s.dateEl.hidden = mode !== 'day';
  s.monthEl.hidden = mode !== 'month';
  s.fromEl.hidden = mode !== 'range';
  s.toEl.hidden = mode !== 'range';
  if (s.rangeSep) s.rangeSep.hidden = mode !== 'range';
  s.todayBtn.hidden = mode !== 'day';
}

// Resolve the current mode to a concrete [from, to] day pair (inclusive).
function rangeForMode() {
  if (s.mode === 'month') {
    const mo = s.monthEl.value || ym(new Date());
    return [`${mo}-01`, monthEnd(mo)];
  }
  if (s.mode === 'range') {
    const from = s.fromEl.value;
    return from ? [from, s.toEl.value || from] : null;
  }
  const day = s.dateEl.value || ymd(new Date());
  return [day, day];
}

async function refresh() {
  const rng = rangeForMode();
  const [from, to] = rng || [null, null];

  // Pager: day mode is short (one day) and unpaged; month/range are paged.
  let rows;
  let total;
  if (s.mode === 'day') {
    rows = from ? await db.listByDate(from) : [];
    total = rows.length;
    s.pager.hidden = true;
  } else {
    total = from ? await db.countByDateRange(from, to) : 0;
    rows = from ? await db.listByDateRangePage(from, to, { offset: s.offset, limit: PAGE }) : [];
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const page = Math.floor(s.offset / PAGE) + 1;
    s.infoEl.textContent = `Page ${page} / ${pages} — ${total} visits`;
    s.prevBtn.disabled = s.offset <= 0;
    s.nextBtn.disabled = s.offset + PAGE >= total;
    s.pager.hidden = false;
  }

  // Summary totals cover the WHOLE range, not just the rendered page.
  let collected = 0;
  let refunded = 0;
  let paidCount = 0;
  let freeCount = 0;
  let cashTotal = 0;
  let upiTotal = 0;
  let summaryTotal = total;
  if (s.mode === 'day') {
    for (const r of rows) {
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
    }
  } else if (from) {
    const t = await db.totalsByDateRange(from, to);
    collected = t.collected;
    refunded = t.refunded;
    paidCount = t.paidCount;
    freeCount = t.freeCount;
    cashTotal = t.cashTotal;
    upiTotal = t.upiTotal;
    summaryTotal = t.total;
  }

  s.tbody.replaceChildren();
  rowCache = new Map();
  if (nav) nav.clear();
  for (const r of rows) {
    rowCache.set(r.rootId, r);
    const tr = document.createElement('tr');
    tr.className = 'row-click';
    tr.dataset.id = String(r.rootId);
    const cells = [];
    if (s.mode !== 'day') cells.push(r.date);
    cells.push(
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
    );
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = String(c);
      tr.appendChild(td);
    }
    s.tbody.appendChild(tr);
  }
  s.empty.hidden = summaryTotal > 0;
  if (s.dateHead) s.dateHead.hidden = s.mode === 'day';

  if (s.summary) {
    if (!summaryTotal) {
      s.summary.hidden = true;
      s.summary.textContent = '';
    } else {
      s.summary.hidden = false;
      const parts = [
        `Visits: ${summaryTotal} (${paidCount} paid · ${freeCount} free)`,
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
    monthEl: document.getElementById('tokens-month'),
    fromEl: document.getElementById('tokens-from'),
    toEl: document.getElementById('tokens-to'),
    rangeSep: document.getElementById('tokens-range-sep'),
    todayBtn: document.getElementById('tokens-today'),
    modeEl: document.getElementById('tokens-mode'),
    modeBtns: Array.from(document.querySelectorAll('#tokens-mode .seg-btn')),
    dateHead: document.getElementById('tokens-th-date'),
    tbody: document.querySelector('#tokens-table tbody'),
    empty: document.getElementById('tokens-empty'),
    summary: document.getElementById('tokens-summary'),
    pager: document.getElementById('tokens-pager'),
    prevBtn: document.getElementById('tokens-pg-prev'),
    nextBtn: document.getElementById('tokens-pg-next'),
    infoEl: document.getElementById('tokens-pg-info'),
    mode: 'day',
    offset: 0,
  };
  const today = new Date();
  s.dateEl.value = ymd(today);
  s.monthEl.value = ym(today);
  s.fromEl.value = ymd(today);
  s.toEl.value = ymd(today);
  const off = bindOff();
  const reload = () => {
    s.offset = 0;
    refresh();
  };
  off.on(s.dateEl, 'change', reload);
  off.on(s.monthEl, 'change', reload);
  off.on(s.fromEl, 'change', reload);
  off.on(s.toEl, 'change', reload);
  off.on(s.modeEl, 'click', (e) => {
    const b = e.target.closest('.seg-btn[data-mode]');
    if (!b) return;
    s.mode = b.dataset.mode;
    s.offset = 0;
    applyMode();
    refresh();
  });
  off.on(s.todayBtn, 'click', () => {
    s.dateEl.value = ymd(new Date());
    reload();
  });
  off.on(s.prevBtn, 'click', () => {
    s.offset = Math.max(0, s.offset - PAGE);
    refresh();
  });
  off.on(s.nextBtn, 'click', () => {
    s.offset += PAGE;
    refresh();
  });
  off.on(s.tbody, 'click', onRowClick);
  // Arrow keys navigate; Enter opens the highlighted visit. Header/footer
  // handoff is off here (no search box; pager is the footer).
  nav = createListNav({
    getRows: () => (s && s.tbody ? Array.from(s.tbody.children) : []),
    getBody: () => s.tbody,
    isOpen: () => !!s.tbody,
    canNav: (e) => !isTypingTarget(e.target) && !isDialogOpen(),
    pagerPrev: () => s.prevBtn,
    pagerNext: () => (s.pager && !s.pager.hidden ? s.nextBtn : null),
    onEnter: (tr) => {
      if (tr && tr.dataset.id) activateRow(Number(tr.dataset.id));
    },
    onEscape: (rows, active) => {
      if (active < 0) return false;
      nav.clear();
    },
  });
  off.on(document, 'keydown', (e) => nav.keydown(e));
  s.off = off;
  refresh();
}

export function unmount() {
  if (s && s.off) s.off.off();
}
