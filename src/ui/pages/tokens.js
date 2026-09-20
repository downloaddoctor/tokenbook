// Tokens page: pick a day, list its visits in issue order.

import { PatientDb } from '../../core/db.js';
import { bindOff } from '../dom.js';

let s;

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function refresh() {
  const day = s.dateEl.value || ymd(new Date());
  const rows = await PatientDb.listByDay(day);
  s.tbody.replaceChildren();
  for (const r of rows) {
    const tr = document.createElement('tr');
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
      new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    ]) {
      const td = document.createElement('td');
      td.textContent = String(c);
      tr.appendChild(td);
    }
    s.tbody.appendChild(tr);
  }
  s.empty.hidden = rows.length > 0;
}

export function mount() {
  s = {
    dateEl: document.getElementById('tokens-date'),
    todayBtn: document.getElementById('tokens-today'),
    tbody: document.querySelector('#tokens-table tbody'),
    empty: document.getElementById('tokens-empty'),
  };
  s.dateEl.value = ymd(new Date());
  const off = bindOff();
  off.on(s.dateEl, 'change', refresh);
  off.on(s.todayBtn, 'click', () => {
    s.dateEl.value = ymd(new Date());
    refresh();
  });
  s.off = off;
  refresh();
}

export function unmount() {
  if (s && s.off) s.off.off();
}
