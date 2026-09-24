// Patients page: unique patients (one row per person), with a drill-in history
// modal. Visits live in the Tokens tab; this page is the registry.

import db from '../../core/db.js';
import { bindOff } from '../dom.js';
import { openHistory } from '../history.js';

const PAGE = 50;
let st;
let activeRow = -1; // index of the keyboard-highlighted row

function rowEls() {
  return st && st.tbody ? Array.from(st.tbody.children) : [];
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

async function render() {
  st.tbody.replaceChildren();
  activeRow = -1;

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

  const counts = await db.visitCountsForPeople(rows.map((p) => p.id));
  st.cache.clear();
  for (const p of rows) st.cache.set(p.id, p);

  for (const p of rows) {
    const tr = document.createElement('tr');
    tr.className = 'row-click';
    tr.dataset.id = String(p.id);
    const lastAt = p.lastVisitAt || p.updatedAt;
    const cells = [
      p.id,
      p.name,
      p.mob,
      p.age,
      p.weight != null ? p.weight : '',
      counts.get(p.id) || 0,
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
  // ArrowDown from the search box jumps into the first row. Blur the input so
  // the document-level handler (which ignores INPUT) takes over for later arrows.
  off.on(st.searchEl, 'keydown', (e) => {
    if (e.key !== 'ArrowDown') return;
    if (!rowEls().length) return;
    e.preventDefault();
    st.searchEl.blur();
    setActiveRow(0);
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
    setActiveRow(rowEls().indexOf(tr));
    openHistory(Number(tr.dataset.id));
  });


  off.on(document, 'keydown', (e) => {
    // History modal owns the keyboard while open.
    const modal = document.getElementById('history-modal');
    if (modal && !modal.hidden) return;
    if (!st.tbody || !rowEls().length) return;
    const t = e.target;
    if (
      t &&
      (t.tagName === 'INPUT' ||
        t.tagName === 'SELECT' ||
        t.tagName === 'TEXTAREA' ||
        t.isContentEditable)
    )
      return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const rows = rowEls();
      if (activeRow >= rows.length - 1) {
        // Bottom of the list -> hand focus to the pager's Next button.
        clearActiveRow();
        if (st.nextBtn && !st.nextBtn.disabled && !st.pager.hidden) {
          st.nextBtn.focus();
          return;
        }
        return;
      }
      setActiveRow(activeRow < 0 ? 0 : activeRow + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      // Coming back from the Next button -> reselect the last row.
      if (st.nextBtn && t === st.nextBtn) {
        setActiveRow(rowEls().length - 1);
        return;
      }
      if (activeRow <= 0) {
        // Top of the list -> hand focus to the search input.
        clearActiveRow();
        if (st.searchEl) st.searchEl.focus();
        return;
      }
      setActiveRow(activeRow - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveRow(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveRow(rowEls().length - 1);
    } else if (e.key === 'Enter') {
      const rows = rowEls();
      if (activeRow < 0 || activeRow >= rows.length) return;
      e.preventDefault();
      openHistory(Number(rows[activeRow].dataset.id));
    }
  });

  st.off = off;
  render();
}

export function unmount() {
  if (st && st.off) st.off.off();
}
