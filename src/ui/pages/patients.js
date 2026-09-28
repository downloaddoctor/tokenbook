// Patients page: unique patients (one row per person), with a drill-in history
// modal. Visits live in the Tokens tab; this page is the registry.

import db from '../../core/db.js';
import { bindOff, isInteractiveTarget } from '../dom.js';
import { createListNav } from '../listNav.js';
import { openHistory } from '../history.js';

const PAGE = 50;
let st;
let nav; // keyboard row navigation

const rowEls = () => (st && st.tbody ? Array.from(st.tbody.children) : []);

async function render() {
  st.tbody.replaceChildren();
  if (nav) nav.clear();

  const q = st.searchEl.value.trim();
  let rows;
  let total;

  if (q) {
    rows = await db.searchPeopleByPrefix(q, 200);
    total = rows.length;
    st.pager.hidden = true;
  } else {
    total = await db.countPeople();
    rows = await db.listPeople({ offset: st.offset, limit: PAGE });
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const page = Math.floor(st.offset / PAGE) + 1;
    st.infoEl.textContent = `Page ${page} / ${pages} — ${total} patients`;
    st.prevBtn.disabled = st.offset <= 0;
    st.nextBtn.disabled = st.offset + PAGE >= total;
    st.pager.hidden = false;
  }

  const counts = await db.visitCountsForPeople(rows.map((p) => p.rootId));
  st.cache.clear();
  for (const p of rows) st.cache.set(p.rootId, p);

  for (const p of rows) {
    const tr = document.createElement('tr');
    tr.className = 'row-click';
    tr.dataset.id = String(p.rootId);
    // a11y: row is an interactive control. tabindex is managed by listNav.
    tr.setAttribute('role', 'button');
    tr.setAttribute(
      'aria-label',
      `Patient #${p.rootId}, ${p.name}, ${p.mob} — open history`
    );
    const lastAt = p.lastVisitAt || p.updatedAt;
    const cells = [
      p.rootId,
      p.name,
      p.mob,
      p.age,
      p.weight != null ? p.weight : '',
      counts.get(p.rootId) || 0,
      lastAt ? new Date(lastAt).toLocaleString() : '',
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = String(c);
      tr.appendChild(td);
    }
    st.tbody.appendChild(tr);
  }

  st.empty.hidden = rows.length > 0;
  if (nav) nav.refresh();
  st.countEl.textContent = total + ' patient' + (total === 1 ? '' : 's');
}

export function mount() {
  st = {
    searchEl: document.getElementById('patients-search'),
    countEl: document.getElementById('patients-count'),
    tbody: document.querySelector('#patients-table tbody'),
    empty: document.getElementById('patients-empty'),
    pager: document.getElementById('patients-pager'),
    prevBtn: document.getElementById('pg-prev'),
    nextBtn: document.getElementById('pg-next'),
    infoEl: document.getElementById('pg-info'),
    offset: 0,
    cache: new Map(), // personId -> person row (last rendered page)
  };

  const off = bindOff();

  let searchTimer = null;
  off.on(st.searchEl, 'input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      st.offset = 0;
      render();
    }, 150);
  });
  off.on(st.prevBtn, 'click', () => {
    st.offset = Math.max(0, st.offset - PAGE);
    render();
  });
  off.on(st.nextBtn, 'click', () => {
    st.offset += PAGE;
    render();
  });

  // Row click -> history modal (delegated).
  off.on(st.tbody, 'click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    nav.setActive(rowEls().indexOf(tr));
    openHistory(Number(tr.dataset.id));
  });

  // Keyboard row navigation. Header = search box, footer = pager; ArrowUp on
  // the first row returns to search, ArrowDown past the last row focuses Next.
  nav = createListNav({
    getRows: rowEls,
    getBody: () => st.tbody,
    search: () => st.searchEl,
    pagerPrev: () => st.prevBtn,
    pagerNext: () => (st.pager && !st.pager.hidden ? st.nextBtn : null),
    // History modal owns the keyboard while open.
    isOpen: () => {
      const modal = document.getElementById('history-modal');
      return !(modal && !modal.hidden);
    },
    // Allow the search box to start navigation (ArrowDown enters the list);
    // yield to every other interactive control.
    canNav: (e) => e.target === st.searchEl || !isInteractiveTarget(e.target),
    onEnter: (tr) => {
      if (tr && tr.dataset.id) openHistory(Number(tr.dataset.id));
    },
  });
  off.on(document, 'keydown', (e) => nav.keydown(e));

  st.off = off;
  render();
}

export function unmount() {
  if (st && st.off) st.off.off();
}
