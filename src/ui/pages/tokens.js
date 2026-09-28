// Tokens page: pick a day, list its visits in issue order.

import db from '../../core/db.js';
import { bindOff, isInteractiveTarget, isDialogOpen } from '../dom.js';
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

  // All modes are paged now — a busy day can be hundreds of rows and
  // materializing the whole day just to render 50 is wasteful.
  const total = from ? await db.countByDateRange(from, to) : 0;
  const rows = from
    ? await db.listByDateRangePage(from, to, { offset: s.offset, limit: PAGE })
    : [];
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.floor(s.offset / PAGE) + 1;
  s.infoEl.textContent = `Page ${page} / ${pages} — ${total} visits`;
  s.prevBtn.disabled = s.offset <= 0;
  s.nextBtn.disabled = s.offset + PAGE >= total;
  // Only show the pager when there is more than one page.
  s.pager.hidden = pages <= 1;

  // Summary totals cover the WHOLE range, not just the rendered page.
  let collected = 0;
  let refunded = 0;
  let paidCount = 0;
  let freeCount = 0;
  let cashTotal = 0;
  let upiTotal = 0;
  // Aggregate over the WHOLE range (not just the rendered page). Every mode
  // is paged now, so totals always come from totalsByDateRange.
  let summaryTotal = total;
  if (from) {
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
    // a11y: row is an interactive control. tabindex is managed by listNav.
    tr.setAttribute('role', 'button');
    tr.setAttribute(
      'aria-label',
      `Token ${r.token}, ${r.name}, ${r.mob} — open refund`
    );
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
  if (nav) nav.refresh();
  if (s.dateHead) s.dateHead.hidden = s.mode === 'day';

  if (s.summary) {
    if (!summaryTotal) {
      s.summary.replaceChildren();
      s.summary.hidden = true;
    } else {
      const stat = (label, value, cls) => {
        const d = document.createElement('div');
        d.className = 'stat' + (cls ? ' ' + cls : '');
        const l = document.createElement('span');
        l.className = 'stat-label';
        l.textContent = label;
        const v = document.createElement('span');
        v.className = 'stat-value';
        v.textContent = value;
        d.append(l, v);
        return d;
      };
      const grossTotal = collected + refunded;
      s.summary.replaceChildren(
        stat('Visits', String(summaryTotal)),
        stat('Paid', String(paidCount)),
        stat('Free', String(freeCount)),
        stat('Total', '₹' + grossTotal),
        stat('Refunded', '₹' + refunded, refunded > 0 ? 'err' : ''),
        stat('Net', '₹' + collected, 'accent'),
        stat('Cash', '₹' + cashTotal),
        stat('UPI', '₹' + upiTotal),
      );
      s.summary.hidden = s.summaryHidden === true;
    }
  }
  if (s.summaryBtn) s.summaryBtn.disabled = summaryTotal === 0;
}

// Toggle the inline summary panel. Hidden state is per-mount.
function toggleSummary() {
  if (!s.summary) return;
  s.summaryHidden = !s.summaryHidden;
  s.summary.hidden = s.summaryHidden;
  if (s.summaryBtn) s.summaryBtn.textContent = s.summaryHidden ? 'Show summary' : 'Hide summary';
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
    summaryBtn: document.getElementById('tokens-summary-btn'),
    modeEl: document.getElementById('tokens-mode'),
    modeBtns: Array.from(document.querySelectorAll('#tokens-mode .seg-btn')),
    dateHead: document.getElementById('tokens-th-date'),
    tbody: document.querySelector('#tokens-table tbody'),
    empty: document.getElementById('tokens-empty'),
    summary: document.getElementById('tokens-summary'),
    summaryHidden: false,
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
  off.on(s.summaryBtn, 'click', toggleSummary);
  if (s.summaryBtn) s.summaryBtn.textContent = 'Hide summary';
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
    // Yield to any interactive control (filter buttons / date inputs) so Enter
    // does not open a row while they are focused.
    canNav: (e) => !isInteractiveTarget(e.target) && !isDialogOpen(),
    // Header = the currently visible filter control (ArrowUp from row 0).
    search: () => document.querySelector('#page-tokens .toolbar input:not([hidden])'),
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
