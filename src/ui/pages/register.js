// Billing page: form, autofill, submit+print. State is local; the router
// calls mount()/unmount() and this module binds/unbinds its own listeners.

import { PatientDb } from '../../core/db.js';
import { PatientBackup } from '../../backup/backup.js';
import { PS } from '../../print/ps.js';
import { bindOff, timeAgo } from '../dom.js';
import { toast, clearToast } from '../toast.js';

let b;

// ---- test hooks (dev self-test only) ---------------------------------
// The self-test drives the real form. To keep it headless it can (a) suppress
// the paperstamp print call and (b) auto-answer the identity dialogs instead
// of waiting for a click. Both default to production behavior.
const testHooks = {
  suppressPrint: false,
  answerIdentity: null, // null | 'update' | 'new' | 'reassign' | 'cancel'
  bypassLayoutCheck: false, // self-test: skip the paperstamp layout requirement
};
export function __setTestHooks(hooks) {
  if (!hooks) return;
  if ('suppressPrint' in hooks) testHooks.suppressPrint = !!hooks.suppressPrint;
  if ('bypassLayoutCheck' in hooks) testHooks.bypassLayoutCheck = !!hooks.bypassLayoutCheck;
  if ('answerIdentity' in hooks) testHooks.answerIdentity = hooks.answerIdentity || null;
}
export function __getForm() {
  return b;
}
// Self-test: run the submit path and RETURN its promise so the caller can
// observe errors (the normal submit handler swallows them in a toast).
export function __submitForTest() {
  return submitBill();
}

function fieldValues() {
  return {
    name: b.fName.value.trim(),
    mob: b.fMob.value.trim(),
    age: b.fAge.value.trim(),
    gender: b.fGender.value.trim(),
    weight: b.fWeight ? b.fWeight.value.trim() : '',
    followup: b.fFollowup ? b.fFollowup.value : '0',
    payment: b.fPayment ? b.fPayment.value : '0',
    fee: b.fFee ? b.fFee.value.trim() : '300',
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
  if (b.fWeight) b.fWeight.value = p.weight != null && p.weight !== '' ? String(p.weight) : '';
  b.fPatientId.value = p.id != null ? String(p.id) : '';
  hideSuggests();
  if (focus) b.saveBtn && b.saveBtn.focus();
  applyFollowupRule(p.id);
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

// Re-evaluate the follow-up rule from the CURRENT form identity. Runs on
// name/mob blur. Resolution mirrors addVisit: explicit Pat ID wins, else
// match on (name, mob). If neither resolves, the patient is new -> force No.
let identityTimer = null;
function revalidateIdentity() {
  clearTimeout(identityTimer);
  identityTimer = setTimeout(async () => {
    const name = b.fName.value.trim().toUpperCase();
    const mob = b.fMob.value.trim();
    const patId = Number(b.fPatientId.value.trim()) || null;
    let personId = null;
    if (patId) {
      const p = await PatientDb.getPerson(patId).catch(() => null);
      if (p && p.name === name && p.mob === mob) personId = p.id;
    }
    if (!personId && name && mob) {
      const matches = await PatientDb.searchPeopleByName(name, 8).catch(() => []);
      const hit = matches.find((p) => p.name === name && p.mob === mob);
      if (hit) personId = hit.id;
    }
    applyFollowupRule(personId);
  }, 180);
}

async function refreshNextToken() {
  const day = b.fDate.value || PatientDb.localDay();
  const t = await PatientDb.nextTokenForDate(day);
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
  const found = await PatientDb.findVisitByDateToken(day, token);
  if (!found) {
    loadedVisitId = null;
    setMsg(`Token ${token} is free on ${day}.`, 'ok');
    startNewBill(false)
    return;
  }
  const { visit, person } = found;
  
  setFollowupNote('');
  hideSuggests();
  setMsg(
    `Editing token ${token} on ${day} — ${visit.name}${person ? ' (Patient #' + person.id + ')' : ''}.`,
    'ok'
  );

  b.fName.value = (visit.name || '').toUpperCase();
  b.fMob.value = visit.mob || '';
  b.fAge.value = String(visit.age);
  b.fGender.value = visit.gender || person?.gender || 'M';
  b.fWeight.value = String(visit.weight);
  b.fFollowup.value = visit.followup ? '1' : '0';
  b.fPayment.value = visit.payment ? '1' : '0';
  b.fFee.value = String(visit.fee);
  if (visit.followup) lockFee(visit.fee);
  else unlockFee();
  
  b.fPatientId.value = person ? String(person.id) : visit.personId != null ? String(visit.personId) : '';
  loadedVisitId = visit.id;
  
  refreshPreview();
}

// Date change: if token has not been hand-edited, recompute the next token
// for the new date. Otherwise leave the typed token alone.
async function onDateChange() {
  const patId = Number(b.fPatientId.value.trim()) || null;
  if (patId) applyFollowupRule(patId);
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

// Auto-followup rule: if the linked patient had a PAID visit within the
// last 6 calendar days, mark this visit as a follow-up (free) and lock fee
// to 0. Otherwise leave the user's toggle alone.
let followupBusy = 0;
async function applyFollowupRule(personId) {
  const my = ++followupBusy;
  const day = (b.fDate && b.fDate.value) || PatientDb.localDay();
  if (!personId) {
    // No resolved person -> first-time patient, force paid visit.
    if (my !== followupBusy) return;
    if (b.fFollowup) b.fFollowup.value = '0';
    unlockFee();
    if (b.fFee && (!b.fFee.value || Number(b.fFee.value) === 0)) b.fFee.value = '300';
    setFollowupNote('');
    return;
  }
  let last = null;
  try {
    last = await PatientDb.lastPaidVisitDaysFor(personId, day);
  } catch (_) {
    last = null;
  }
  if (my !== followupBusy) return;
  if (last && last.days != null && last.days >= 0 && last.days <= 6) {
    // Inside window -> free follow-up.
    if (b.fFollowup) b.fFollowup.value = '1';
    lockFee(0);
    const left = 6 - last.days;
    setFollowupNote(
      `Free follow-up — last paid visit ${last.days === 0 ? 'today' : last.days + ' day(s) ago'}. Window closes in ${left} day(s).`
    );
  } else if (last && last.days != null && last.days > 6) {
    // Past window -> force paid visit, unlock the fee, note the gap.
    if (b.fFollowup) b.fFollowup.value = '0';
    unlockFee();
    if (b.fFee && (!b.fFee.value || Number(b.fFee.value) === 0)) b.fFee.value = '300';
    setFollowupNote(
      `Paid visit — last paid visit was ${last.days} day(s) ago (outside the 6-day follow-up window).`
    );
  } else {
    // No prior paid visit at all -> first-time patient, force paid visit.
    if (b.fFollowup) b.fFollowup.value = '0';
    unlockFee();
    if (b.fFee && (!b.fFee.value || Number(b.fFee.value) === 0)) b.fFee.value = '300';
    setFollowupNote('');
  }
}

function setFollowupNote(text) {
  const el = document.getElementById('followup-note');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

function lockFee(v) {
  if (!b.fFee) return;
  b.fFee.value = String(v);
  b.fFee.readOnly = true;
  b.fFee.dataset.locked = '1';
}

function unlockFee() {
  if (!b.fFee) return;
  delete b.fFee.dataset.locked;
  b.fFee.readOnly = false;
}


function onFollowupChange() {
  if (b.fFollowup.value === '1') lockFee(0);
  else {
    unlockFee();
    if (!b.fFee.value || Number(b.fFee.value) === 0) b.fFee.value = '300';
  }
  setFollowupNote('');
  refreshPreview();
}

// Pat ID change: look up the person and populate the form. Empty = leave
// fields as-is (submit falls back to (name, mob) matching).
async function onPatIdChange() {
  const raw = b.fPatientId.value.trim();
  if (!raw) return;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    setMsg('Pat ID must be a number.', 'err');
    return;
  }
  const p = await PatientDb.getPerson(id);
  if (!p) {
    setMsg(`No patient with ID ${id}.`, 'err');
    return;
  }
  b.fName.value = (p.name || '').toUpperCase();
  b.fMob.value = p.mob || '';
  b.fAge.value = String(p.age);
  b.fGender.value = p.gender || 'M';
  b.fWeight.value = p.weight != null && p.weight !== '' ? String(p.weight) : '';
  hideSuggests();
  setMsg('');

  if(!loadedVisitId) applyFollowupRule(p.id);
  else setFollowupNote('');
  refreshPreview();
}

// Prepare a fresh bill for the next patient. Called by the New-bill button
// and by Alt+N via app.js.
export function startNewBill(nextToken = true) {
  b.fName.value = '';
  b.fMob.value = '';
  b.fAge.value = '';
  b.fGender.value = 'M';
  b.fWeight.value = '';
  b.fFollowup.value = '0';
  b.fPayment.value = '0';
  unlockFee();
  b.fFee.value = '300';
  setFollowupNote('');
  b.fPatientId.value = '';
  tokenEdited = false;
  loadedVisitId = null;
  hideSuggests();
  setMsg('');
  b.fName.focus();
  if(nextToken) refreshNextToken();
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
  if (testHooks.answerIdentity) return Promise.resolve(testHooks.answerIdentity);
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

// Variant prompt: the form's identity matches an EXISTING patient (not the
// currently linked one). "Update" would collide, so only offer Reassign or
// Cancel. Reuses the same dialog element; falls back to 'reassign' if the
// markup is missing so behavior degrades gracefully.
function askReassign(linked, other, current) {
  if (testHooks.answerIdentity) return Promise.resolve(testHooks.answerIdentity);
  return new Promise((resolve) => {
    const dlg = document.getElementById('pat-id-confirm');
    const title = document.getElementById('pat-id-confirm-title');
    const sub = document.getElementById('pat-id-confirm-sub');
    const body = document.getElementById('pat-id-confirm-body');
    const actions = document.getElementById('pat-id-confirm-actions');
    if (!dlg || !sub || !body || !actions) return resolve('reassign');
    if (title) title.textContent = 'Reassign to existing patient?';
    // Replace action buttons for this variant: Cancel + Reassign.
    actions.replaceChildren();
    const cancel = document.createElement('button');
    cancel.type = 'submit';
    cancel.value = 'cancel';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.value = 'reassign';
    ok.className = 'primary';
    ok.textContent = 'Reassign';
    actions.append(cancel, ok);
    sub.textContent = `Currently linked to patient #${linked.id}. A different patient already has this name + mobile.`;
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
    row('Linked', `#${linked.id} ${linked.name}`, '');
    row('Reassign to', `#${other.id} ${other.name}`, '');
    row('Mobile', other.mob, '');
    body.appendChild(dl);
    const restore = () => {
      if (title) title.textContent = 'Update patient?';
      actions.replaceChildren();
      const c = document.createElement('button');
      c.type = 'submit';
      c.value = 'cancel';
      c.textContent = 'Cancel';
      const n = document.createElement('button');
      n.type = 'submit';
      n.value = 'new';
      n.textContent = 'Use as new patient';
      const u = document.createElement('button');
      u.type = 'submit';
      u.value = 'update';
      u.className = 'primary';
      u.textContent = 'Update patient';
      actions.append(c, n, u);
    };
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      const v = dlg.returnValue;
      restore();
      if (v === 'reassign') resolve('reassign');
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
  const weightRaw = b.fWeight ? b.fWeight.value.trim() : '';
  const feeRaw = b.fFee ? b.fFee.value.trim() : '';
  const dateRaw = b.fDate ? b.fDate.value.trim() : '';
  const tokenRaw = b.fToken ? b.fToken.value.trim() : '';
  const missing = [];
  if (!name) missing.push('name');
  if (!mob) missing.push('mobile');
  if (!Number.isFinite(age)) missing.push('age');
  if (!gender) missing.push('gender');
  if (weightRaw === '' || !Number.isFinite(Number(weightRaw))) missing.push('weight');
  if (!dateRaw) missing.push('date');
  if (!tokenRaw || !Number.isInteger(Number(tokenRaw))) missing.push('token');
  if (feeRaw === '' || !Number.isFinite(Number(feeRaw))) missing.push('fee');
  if (missing.length) {
    setMsg('Please fill: ' + missing.join(', ') + '.', 'err');
    return;
  }

  if (!testHooks.bypassLayoutCheck && (!PS.selectedLayoutId() || !PS.activeLayoutDef())) {
    setMsg('No layout — create one in Settings first.', 'err');
    return;
  }

  const day = dateRaw || PatientDb.localDay();
  let patId = Number(b.fPatientId.value.trim()) || null;
  const weight = Number(weightRaw);
  const followup = b.fFollowup && b.fFollowup.value === '1' ? 1 : 0;
  const payment = b.fPayment && b.fPayment.value === '1' ? 1 : 0;
  const fee = Number(feeRaw);

  // If a patient is linked and the user has edited their identity, ask how
  // to proceed before writing anything.
  if (patId) {
    const p = await PatientDb.getPerson(patId);
    if (p && (p.name !== name || p.mob !== mob)) {
      // If the new (name, mob) belongs to a DIFFERENT existing patient, then
      // "Update" (rename A to the new identity) would collide. Only offer
      // "Use as new" (reassign the visit to that patient) or Cancel.
      const clash = await PatientDb.searchPeopleByPrefix(name, 200);
      const other = clash.find((x) => x.name === name && x.mob === mob && x.id !== patId);
      if (other) {
        const choice = await askReassign(p, other, { name, mob, age, gender });
        if (choice === 'cancel') return;
        patId = null; // reassign to `other` via the (name, mob) match
      } else {
        const choice = await askIdentityChange(p, { name, mob, age, gender });
        if (choice === 'cancel') return;
        if (choice === 'new') patId = null;
      }
    }
  }

  const visitInput = {
    name,
    mob,
    age,
    gender,
    weight,
    followup,
    payment,
    fee,
    token: Number(b.fToken.value) || undefined,
    date: day,
    personId: patId,
  };
  let token = visitInput.token || (await PatientDb.nextTokenForDate(day));
  visitInput.token = token;
  let result;
  try {
    result = await PatientDb.addVisit(visitInput);
  } catch (err) {
    if (err && err.name === 'DuplicateIdentityError') {
      setMsg(err.message, 'err');
      return;
    }
    if (err && err.name === 'ConstraintError') {
      token = await PatientDb.nextTokenForDate(day);
      visitInput.token = token;
      result = await PatientDb.addVisit(visitInput);
    } else {
      throw err;
    }
  }
  const { rec, created } = result;
  // Echo the resolved person id back into the form so the next Save for the
  // same patient carries an explicit personId (new patients get an id here).
  b.fPatientId.value = rec.personId != null ? String(rec.personId) : '';
  hideSuggests();

  // Reflect the resolved billing back into the form (auto-followup may have
  // flipped the flag or zeroed the fee on the server side).
  if (b.fFollowup) b.fFollowup.value = rec.followup ? '1' : '0';
  if (b.fPayment) b.fPayment.value = rec.payment ? '1' : '0';
  if (b.fFee && rec.fee != null) {
    b.fFee.value = String(rec.fee);
    if (rec.followup) lockFee(rec.fee);
  }
  if (b.fWeight && rec.weight != null) b.fWeight.value = String(rec.weight);

  if (!testHooks.suppressPrint) {
    PS.print(
      {
        name: rec.name,
        mob: rec.mob,
        age: String(rec.age),
        gender: rec.gender || '',
        weight: rec.weight != null ? String(rec.weight) : '',
        followup: rec.followup ? 'Yes' : 'No',
        payment: rec.payment ? 'UPI' : 'Cash',
        fee: rec.fee != null ? String(rec.fee) : '',
        date: rec.date,
        token: String(rec.token),
      },
      () => PS.openDesigner()
    );
  }
  setMsg(
    (created ? 'Saved. Token ' : 'Updated. Token ') +
      rec.token +
      (rec.followup ? ' (free follow-up)' : ' — ₹' + (rec.fee != null ? rec.fee : '')),
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
    fWeight: document.getElementById('f-weight'),
    fFollowup: document.getElementById('f-followup'),
    fPayment: document.getElementById('f-payment'),
    fFee: document.getElementById('f-fee'),
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
  if (b.fFollowup) off.on(b.fFollowup, 'change', onFollowupChange);
  if (b.fFee)
    off.on(b.fFee, 'input', () => {
      // Manual edit clears the lock so syncFeeFromFollowup won't fight the user.
      if (b.fFee.dataset.locked === '1') unlockFee();
    });
  off.on(b.fName, 'blur', revalidateIdentity);
  off.on(b.fMob, 'blur', revalidateIdentity);
  off.on(b.fName, 'change', revalidateIdentity);
  off.on(b.fMob, 'change', revalidateIdentity);
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
