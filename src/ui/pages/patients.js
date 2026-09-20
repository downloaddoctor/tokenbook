// Patients page: unique patients (one row per person), with a drill-in
// history modal. Visits live in the Tokens tab; this page is the registry.

import { PatientDb } from '../../core/db.js';
import { bindOff } from '../dom.js';

const PAGE = 50;
let st;

async function render() {
  st.tbody.replaceChildren();

  const q = st.searchEl.value.trim();
  let rows;
  let total;

  if (q) {
    rows = await PatientDb.searchPeopleByPrefix(q, 200);
    total = rows.length;
    st.pager.hidden = true;
  } else {
    total = await PatientDb.countPeople();
    rows = await PatientDb.listPeople({ offset: st.offset, limit: PAGE });
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const page = Math.floor(st.offset / PAGE) + 1;
    st.infoEl.textContent = `Page ${page} / ${pages} — ${total} patients`;
    st.prevBtn.disabled = st.offset <= 0;
    st.nextBtn.disabled = st.offset + PAGE >= total;
    st.pager.hidden = false;
  }

  const counts = await PatientDb.visitCountsForPeople(rows.map((p) => p.id));
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

async function openHistory(personId) {
  let p = st.cache.get(personId);
  if (!p) p = await PatientDb.getPerson(personId);
  const visits = await PatientDb.visitsForPerson(personId);
  st.modalName.textContent = p ? p.name : `Patient #${personId}`;
  st.modalMeta.textContent = p ? `${p.mob} · Age ${p.age} · ${p.gender || '—'}` : '';
  st.modalBody.replaceChildren();
  for (const v of visits) {
    const tr = document.createElement('tr');
    for (const c of [
      v.date || v.day,
      v.token,
      v.age,
      v.gender || '',
      new Date(v.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    ]) {
      const td = document.createElement('td');
      td.textContent = String(c);
      tr.appendChild(td);
    }
    st.modalBody.appendChild(tr);
  }
  st.modal.hidden = false;
}

function closeHistory() {
  st.modal.hidden = true;
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
    modal: document.getElementById('history-modal'),
    modalName: document.getElementById('history-name'),
    modalMeta: document.getElementById('history-meta'),
    modalBody: document.querySelector('#history-table tbody'),
    modalClose: document.getElementById('history-close'),
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
    openHistory(Number(tr.dataset.id));
  });

  off.on(st.modalClose, 'click', closeHistory);
  off.on(st.modal, 'click', (e) => {
    if (e.target === st.modal) closeHistory();
  });
  off.on(document, 'keydown', (e) => {
    if (e.key === 'Escape' && !st.modal.hidden) closeHistory();
  });

  st.off = off;
  render();
}

export function unmount() {
  if (st && st.off) st.off.off();
}
