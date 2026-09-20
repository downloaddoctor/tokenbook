// Billing page: form, autofill, submit+print. State is local; the router
// calls mount()/unmount() and this module binds/unbinds its own listeners.

import { PatientDb } from '../../core/db.js';
import { PatientBackup } from '../../backup/backup.js';
import { PS } from '../../print/ps.js';
import { bindOff, timeAgo } from '../dom.js';
import { toast, clearToast } from '../toast.js';

let b;

function fieldValues() {
  return {
    name: b.fName.value.trim(),
    mob: b.fMob.value.trim(),
    age: b.fAge.value.trim(),
    gender: b.fGender.value.trim(),
    date: b.fDate.value.trim(),
    token: b.fToken.value.trim(),
  };
}

function refreshPreview() {
  PS.preview(fieldValues());
}

// ---- autofill (name + mobile) ----
let nameTimer = null;
let mobTimer = null;
let activeList = null; // { ul, items, pick, hi }
let submitting = false; // guards against double-submit (fast clicks / Enter spam)
let tokenEdited = false; // true once the user manually types in Token; reset on New Visit / auto-refresh
let loadedVisitId = null; // visit id currently being edited (null = new visit)

function setHighlight(list, i) {
  list.hi = i;
  const lis = list.ul.children;
  for (let k = 0; k < lis.length; k++) lis[k].classList.toggle('hl', k === i);
  if (i >= 0 && lis[i]) lis[i].scrollIntoView({ block: 'nearest' });
}

function renderSuggest(ul, items, pick) {
  ul.replaceChildren();
  if (!items.length) {
    ul.hidden = true;
    if (activeList && activeList.ul === ul) activeList = null;
    return;
  }
  const list = { ul, items, pick, hi: -1 };
  items.forEach((p, i) => {
    const li = document.createElement('li');
    const main = document.createElement('span');
    main.textContent = p.name;
    const sub = document.createElement('span');
    sub.className = 's-sub';
    const bits = [p.mob];
    if (p.age != null && p.age !== '') bits.push(String(p.age));
    const seen = timeAgo(p.updatedAt || p.createdAt);
    if (seen) bits.push(seen);
    sub.textContent = bits.join(' · ');
    li.append(main, sub);
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pick(p);
    });
    li.addEventListener('mouseenter', () => setHighlight(list, i));
    ul.appendChild(li);
  });
  ul.hidden = false;
  activeList = list;
}

function hideSuggests() {
  if (b.nameSuggest) b.nameSuggest.hidden = true;
  if (b.mobSuggest) b.mobSuggest.hidden = true;
  activeList = null;
}

function pickPerson(p, focus = true) {
  b.fName.value = (p.name || '').toUpperCase();
  b.fMob.value = p.mob || '';
  if (p.age != null && p.age !== '') b.fAge.value = String(p.age);
  b.fGender.value = p.gender || '';
  b.fPatientId.value = p.id != null ? String(p.id) : '';
  hideSuggests();
  if (focus) b.fAge.focus();
  refreshPreview();
}

function onSuggestKey(e) {
  const list = activeList;
  if (!list || list.ul.hidden) return;
  const n = list.items.length;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setHighlight(list, list.hi < 0 ? 0 : Math.min(list.hi + 1, n - 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setHighlight(list, list.hi < 0 ? n - 1 : Math.max(list.hi - 1, 0));
  } else if (e.key === 'Enter') {
    if (list.hi >= 0) {
      e.preventDefault();
      list.pick(list.items[list.hi]);
    }
  } else if (e.key === 'Tab') {
    const idx = list.hi >= 0 ? list.hi : 0;
    list.pick(list.items[idx], false);
  } else if (e.key === 'Escape') {
    hideSuggests();
  }
}

function onNameInput() {
  clearTimeout(nameTimer);
  const q = b.fName.value.trim();
  if (q.length < 2) {
    b.nameSuggest.hidden = true;
    return;
  }
  nameTimer = setTimeout(async () => {
    const items = await PatientDb.searchPeopleByName(q, 8);
    renderSuggest(b.nameSuggest, items, pickPerson);
  }, 120);
}

function onMobInput() {
  clearTimeout(mobTimer);
  const q = b.fMob.value.trim();
  if (q.length < 3) {
    b.mobSuggest.hidden = true;
    return;
  }
  mobTimer = setTimeout(async () => {
    const items = await PatientDb.searchPeopleByMob(q, 8);
    renderSuggest(b.mobSuggest, items, pickPerson);
  }, 120);
}

function onDocMouseDown(e) {
  const t = e.target;
  if (b.nameSuggest.contains(t) || t === b.fName || b.mobSuggest.contains(t) || t === b.fMob)
    return;
  hideSuggests();
}

async function refreshNextToken() {
  const day = b.fDate.value || PatientDb.localDay();
  const t = await PatientDb.nextTokenForDay(day);
  if (!b.fDate.value) b.fDate.value = day;
  b.fToken.value = String(t);
  tokenEdited = false;
  loadedVisitId = null;
}

// Token change: if the user typed a token and a visit exists at (date, token),
// load that visit into the form (edit mode). Otherwise leave the typed value
// as-is; submit will create a new visit at that key.
async function onTokenChange() {
  tokenEdited = true;
  const day = b.fDate.value.trim();
  const token = Number(b.fToken.value);
  if (!day || !Number.isInteger(token) || token < 1) return;
  const found = await PatientDb.findVisitByDayToken(day, token);
  if (!found) {
    loadedVisitId = null;
    setMsg(`Token ${token} is free on ${day}.`, 'ok');
    return;
  }
  const { visit, person } = found;
  b.fName.value = (visit.name || '').toUpperCase();
  b.fMob.value = visit.mob || '';
  if (visit.age != null && visit.age !== '') b.fAge.value = String(visit.age);
  b.fGender.value = visit.gender || person?.gender || 'M';
  b.fPatientId.value = person ? String(person.id) : visit.personId != null ? String(visit.personId) : '';
  loadedVisitId = visit.id;
  hideSuggests();
  setMsg(
    `Editing token ${token} on ${day} — ${visit.name}${person ? ' (Patient #' + person.id + ')' : ''}.`,
    'ok'
  );
  refreshPreview();
}

// Date change: if token has not been hand-edited, recompute the next token
// for the new date. Otherwise leave the typed token alone.
async function onDateChange() {
  if (tokenEdited) return;
  await refreshNextToken();
}

// Token blur: if the field was left empty, fill it with the next available
// token for the current date (and reset tokenEdited so Date changes recompute).
async function onTokenBlur() {
  if (b.fToken.value.trim() === '') {
    await refreshNextToken();
  }
}

// Kept as the same signature used across this file — routes to the toast.
// `kind` is 'ok' | 'err' | undefined. Errors use the same mechanism, styled red.
function setMsg(text, kind) {
  toast(text, kind);
}

// Pat ID change: look up the person and populate the form. Empty = leave
// fields as-is (submit falls back to (name, mob) matching).
async function onPatIdChange() {
  const raw = b.fPatientId.value.trim();
  if (!raw) return;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    setMsg('Pat ID must be a number.', 'err');
    b.fPatientId.value = '';
    return;
  }
  const p = await PatientDb.getPerson(id);
  if (!p) {
    setMsg(`No patient with ID ${id}.`, 'err');
    b.fPatientId.value = '';
    return;
  }
  b.fName.value = (p.name || '').toUpperCase();
  b.fMob.value = p.mob || '';
  if (p.age != null && p.age !== '') b.fAge.value = String(p.age);
  b.fGender.value = p.gender || 'M';
  hideSuggests();
  setMsg('');
  refreshPreview();
}

// Prepare a fresh bill for the next patient. Called by the New-bill button
// and by Alt+N via app.js.
export function startNewBill() {
  b.fName.value = '';
  b.fMob.value = '';
  b.fAge.value = '';
  b.fGender.value = 'M';
  b.fPatientId.value = '';
  tokenEdited = false;
  loadedVisitId = null;
  hideSuggests();
  setMsg('');
  b.fName.focus();
  refreshNextToken();
}

async function onSubmit(e) {
  e.preventDefault();
  if (submitting) return;
  submitting = true;
  const btn = b.saveBtn;
  if (btn) btn.disabled = true;
  try {
    await submitBill();
  } finally {
    submitting = false;
    if (btn) btn.disabled = false;
  }
}

// Ask the user how to proceed when the form's identity differs from the
// linked patient. Returns 'update' | 'new' | 'cancel'.
function askIdentityChange(person, current) {
  return new Promise((resolve) => {
    const dlg = document.getElementById('pat-id-confirm');
    const sub = document.getElementById('pat-id-confirm-sub');
    const body = document.getElementById('pat-id-confirm-body');
    if (!dlg || !sub || !body) {
      console.warn('pat-id-confirm dialog markup missing; skipping prompt');
      return resolve('update');
    }

    sub.textContent = `Currently linked to patient #${person.id}.`;
    body.replaceChildren();
    const dl = document.createElement('dl');
    const row = (label, from, to) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      const f = from == null || from === '' ? '—' : String(from);
      const t = to == null || to === '' ? '—' : String(to);
      dd.textContent = f === t ? f : `${f} → ${t}`;
      dl.append(dt, dd);
    };
    row('Name', person.name, current.name);
    row('Mobile', person.mob, current.mob);
    row('Age', person.age, current.age);
    row('Gender', person.gender || '', current.gender || '');
    body.appendChild(dl);

    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      const v = dlg.returnValue;
      // Empty means Esc (or close without a button) -> cancel.
      if (v === 'update' || v === 'new') resolve(v);
      else resolve('cancel');
    };
    dlg.returnValue = '';
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

// Worker for onSubmit. The guard/disable lives on onSubmit — do not
// re-check `submitting` here, or the outer call would make this a no-op.
async function submitBill() {
  setMsg('');
  const name = b.fName.value.trim().toUpperCase();
  const mob = b.fMob.value.trim();
  const age = Number(b.fAge.value);
  const gender = b.fGender.value;
  if (!name || !mob || !Number.isFinite(age)) {
    setMsg('Please fill name, mobile, age.', 'err');
    return;
  }

  if (!PS.selectedLayoutId() || !PS.activeLayoutDef()) {
    setMsg('No layout — create one in Settings first.', 'err');
    return;
  }

  const day = b.fDate.value.trim() || PatientDb.localDay();
  let patId = Number(b.fPatientId.value.trim()) || null;

  // If a patient is linked and the user has edited their identity, ask how
  // to proceed before writing anything.
  if (patId) {
    const p = await PatientDb.getPerson(patId);
    if (p && (p.name !== name || p.mob !== mob)) {
      const choice = await askIdentityChange(p, { name, mob, age, gender });
      if (choice === 'cancel') return;
      if (choice === 'new') patId = null;
    }
  }

  let token = Number(b.fToken.value) || (await PatientDb.nextTokenForDay(day));
  let result;
  try {
    result = await PatientDb.addVisit({ name, mob, age, gender, token, date: day, patId });
  } catch (err) {
    if (err && err.name === 'DuplicateIdentityError') {
      setMsg(err.message, 'err');
      return;
    }
    if (err && err.name === 'ConstraintError') {
      token = await PatientDb.nextTokenForDay(day);
      result = await PatientDb.addVisit({ name, mob, age, gender, token, date: day, patId });
    } else {
      throw err;
    }
  }
  const { rec, created } = result;
  // Echo the resolved person id back into the form so the next Save for the
  // same patient carries an explicit patId (new patients get an id here).
  b.fPatientId.value = rec.personId != null ? String(rec.personId) : '';
  hideSuggests();

  PatientBackup.markDirty();

  PS.print(
    {
      name: rec.name,
      mob: rec.mob,
      age: String(rec.age),
      gender: rec.gender || '',
      date: rec.date,
      token: String(rec.token),
    },
    () => PS.openDesigner()
  );
  setMsg(
    (created ? 'Saved. Token ' : 'Updated. Token ') +
      rec.token,
    'ok'
  );
}

export function mount() {
  b = {
    form: document.getElementById('patient-form'),
    fName: document.getElementById('f-name'),
    fMob: document.getElementById('f-mob'),
    fAge: document.getElementById('f-age'),
    fGender: document.getElementById('f-gender'),
    fPatientId: document.getElementById('f-patient-id'),
    fDate: document.getElementById('f-date'),
    fToken: document.getElementById('f-token'),
    saveBtn: document.getElementById('btn-save-print'),
    msg: document.getElementById('form-msg'),
    host: document.getElementById('register-ps-host'),
    nameSuggest: document.getElementById('name-suggest'),
    mobSuggest: document.getElementById('mob-suggest'),
  };
  PS.mount(b.host, { autoShow: false, openDesignerOnReady: true, seedDefaultOnReady: true });
  const off = bindOff();
  off.on(b.form, 'submit', onSubmit);
  off.on(b.form, 'input', refreshPreview);
  off.on(document.getElementById('btn-new-bill'), 'click', startNewBill);
  off.on(b.fName, 'input', onNameInput);
  off.on(b.fMob, 'input', onMobInput);
  off.on(b.fPatientId, 'change', onPatIdChange);
  off.on(b.fToken, 'change', onTokenChange);
  off.on(b.fToken, 'blur', onTokenBlur);
  off.on(b.fDate, 'change', onDateChange);
  off.on(b.fDate, 'input', onDateChange);
  // Alt+S -> Save & Print (only while this page is mounted). Ctrl/Shift are
  // deliberately required to be unset so we don't shadow browser combos.
  off.on(window, 'keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      if (b.form && !submitting) b.form.requestSubmit();
    }
  });
  off.on(b.fName, 'keydown', onSuggestKey);
  off.on(b.fMob, 'keydown', onSuggestKey);
  off.on(document, 'mousedown', onDocMouseDown);
  b.off = off;
  refreshNextToken();
  b.fName.focus();
}

export function unmount() {
  if (b && b.off) b.off.off();
  submitting = false;
  clearToast();
  PS.reset();
}
