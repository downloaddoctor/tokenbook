// Register page: form, autofill, submit+print. Router calls mount()/unmount();
// this module binds/unbinds its own listeners.

import db from '../../core/db.js';
import { evaluateFollowup, followupDaysLeft, DEFAULT_FEE } from '../../core/billing.js';
import ps from '../../print/ps.js';
import { bindOff, timeAgo } from '../dom.js';
import { toast, clearToast } from '../toast.js';
import { openRefundFor, refundLabel } from '../refund.js';

let b;

// ---- test hooks (dev self-test only) ----
// The self-test drives the real form; it can suppress print and bypass layout
// checks. Both default to production behavior.
const testHooks = {
  suppressPrint: false,
};
export function __setTestHooks(hooks) {
  if (!hooks) return;
  if ('suppressPrint' in hooks) testHooks.suppressPrint = !!hooks.suppressPrint;
}
export function __getForm() {
  return b;
}
// Run submit path and RETURN its promise so the caller can observe errors
// (the normal handler swallows them in a toast).
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
    fee: b.fFee ? b.fFee.value.trim() : String(DEFAULT_FEE),
    date: b.fDate.value.trim(),
    token: b.fToken.value.trim(),
  };
}

let previewTimer = null;
function refreshPreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = null;
    ps.preview(fieldValues());
  }, 90);
}

// ---- autofill (name + mobile) ----
let nameTimer = null;
let activeList = null;      // { ul, items, pick, hi }
let submitting = false;     // guards against double-submit
let tokenEdited = false;    // true once user types in Token; reset on New Visit
let loadedVisitId = null;   // visit id being edited (null = new visit)

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
    main.className = 's-main';
    const name = document.createElement('span');
    name.className = 's-name';
    name.textContent = p.name;
    const ago = document.createElement('span');
    ago.className = 's-ago';
    ago.textContent = timeAgo(p.lastVisitAt || p.createdAt) || '';
    main.append(name, ago);

    const sub = document.createElement('span');
    sub.className = 's-sub';
    const mob = document.createElement('span');
    mob.className = 's-mob';
    mob.textContent = p.mob || '';
    const age = document.createElement('span');
    age.className = 's-age';
    age.textContent = p.age != null && p.age !== '' ? String(p.age) : '';
    sub.append(mob, age);

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
    // Match by name OR mobile (same as Patients search), so a phone number typed
    // here also finds the person.
    const items = await db.searchPeopleByPrefix(q, 8);
    renderSuggest(b.nameSuggest, items, pickPerson);
  }, 120);
}

function onDocMouseDown(e) {
  const t = e.target;
  if (b.nameSuggest.contains(t) || t === b.fName) return;
  hideSuggests();
}

// Re-evaluate the follow-up rule from the CURRENT form identity. Runs on
// name/mob blur. Resolution mirrors addVisit: explicit Pat ID wins, else match
// (name, mob). Unresolved -> new patient -> force paid.
let identityTimer = null;
function revalidateIdentity() {
  clearTimeout(identityTimer);
  identityTimer = setTimeout(async () => {
    const name = b.fName.value.trim().toUpperCase();
    const mob = b.fMob.value.trim();
    const patId = Number(b.fPatientId.value.trim()) 
    let personId = null;
    if (patId) {
      const p = await db.getPerson(patId).catch(() => null);
      if (p && p.name === name && p.mob === mob) personId = p.id;
    }
    if (!personId && name && mob) {
      const matches = await db.searchPeopleByName(name, 8).catch(() => []);
      const hit = matches.find((p) => p.name === name && p.mob === mob);
      if (hit) personId = hit.id;
    }
    applyFollowupRule(personId);
  }, 180);
}

async function refreshNextToken() {
  const day = b.fDate.value || db.localDay();
  const t = await db.nextTokenForDate(day);
  if (!b.fDate.value) b.fDate.value = day;
  b.fToken.value = String(t);
  tokenEdited = false;
  loadedVisitId = null;
}

// Token change: if a visit exists at (date, token), load it (edit mode).
// Otherwise keep the typed value; submit will create at that key.
async function onTokenChange() {
  tokenEdited = true;
  const day = b.fDate.value.trim();
  const token = Number(b.fToken.value);
  if (!day || !Number.isInteger(token) || token < 1) return;
  const found = await db.findVisitByDateToken(day, token);
  if (!found) {
    loadedVisitId = null;
    setMsg(`Token ${token} is free on ${day}.`, 'ok');
    startNewBill(false, false); // keep the user's chosen day
    return;
  }
  const { visit, person } = found;
  setFollowupNote('');
  hideSuggests();
  setMsg(
    `Editing token ${token} on ${day} — ${visit.name}${person ? ' (Patient #' + person.id + ')' : ''}.`,
    'ok'
  );
  loadVisitIntoForm(visit, person);
}

// Fill the form from a visit (edit mode). Shared by onTokenChange and editVisit.
function loadVisitIntoForm(visit, person) {
  if (!b) return;
  hideSuggests();
  b.fDate.value = visit.date;
  b.fToken.value = String(visit.token);
  b.fName.value = (visit.name || '').toUpperCase();
  b.fMob.value = visit.mob || '';
  b.fAge.value = String(visit.age);
  b.fGender.value = visit.gender || (person && person.gender) || 'M';
  b.fWeight.value = String(visit.weight);
  b.fFollowup.value = visit.followup ? '1' : '0';
  b.fPayment.value = visit.payment ? '1' : '0';
  b.fFee.value = String(visit.fee);
  if (visit.followup) lockFee(visit.fee);
  else unlockFee();
  b.fPatientId.value =
    person && person.id != null
      ? String(person.id)
      : visit.personId != null
        ? String(visit.personId)
        : '';
  loadedVisitId = visit.id;
  refreshPreview();
}

// Load a visit into the Register form for editing. Used by Tokens on Enter.
// `visit` has personId; person is resolved here so callers don't have to.
export async function editVisit(visit) {
  if (!visit) return false;
  let person = null;
  if (visit.personId != null) person = await db.getPerson(visit.personId);
  loadVisitIntoForm(visit, person);
  return true;
}

// Alt+R: open the refund dialog for the visit currently loaded. Paid only.
async function refundCurrentVisit() {
  if (!loadedVisitId) {
    toast('No saved visit loaded to refund.', 'err');
    return;
  }
  const found = await db.findVisitByDateToken(b.fDate.value.trim(), Number(b.fToken.value));
  const visit = found && found.visit;
  if (!visit || visit.id !== loadedVisitId) {
    toast('Could not reload the visit.', 'err');
    return;
  }
  if (visit.followup) {
    toast('Free follow-up visit — no refund.', 'err');
    return;
  }
  try {
    const choice = await openRefundFor(visit);
    if (choice == null) return;
    toast(choice === '0' ? 'Refund cleared.' : `Refund set: ${refundLabel(choice)}.`, 'ok');
    const refound = await db.findVisitByDateToken(visit.date, visit.token);
    if (refound) loadVisitIntoForm(refound.visit, refound.person);
  } catch (err) {
    toast('Refund failed: ' + err.message, 'err');
  }
}

// Date change: if token was not hand-edited, recompute the next token for the
// new date. Otherwise leave the typed token alone.
async function onDateChange() {
  const patId = Number(b.fPatientId.value.trim()) || null;
  if (patId) applyFollowupRule(patId);
  if (tokenEdited) return;
  await refreshNextToken();
}

// Token blur: if empty, fill with the next available token (resets tokenEdited
// so Date changes recompute again).
async function onTokenBlur() {
  if (b.fToken.value.trim() === '') {
    await refreshNextToken();
  }
}

// Toast helper. kind: 'ok' | 'err' | undefined (errors are styled red).
function setMsg(text, kind) {
  toast(text, kind);
}

// Auto-followup rule: if the linked patient had a PAID visit within the last 6
// calendar days, mark this visit as a free follow-up and lock fee to 0.
// Otherwise leave the user's toggle alone.
let followupBusy = 0;
async function applyFollowupRule(personId) {
  const my = ++followupBusy;
  const day = (b.fDate && b.fDate.value) || db.localDay();
  if (!personId) {
    // No resolved person -> first-time patient, force paid.
    if (my !== followupBusy) return;
    if (b.fFollowup) b.fFollowup.value = '0';
    unlockFee();
    if (b.fFee && (!b.fFee.value || Number(b.fFee.value) === 0)) b.fFee.value = String(DEFAULT_FEE);
    setFollowupNote('');
    return;
  }
  let last = null;
  try {
    last = await db.lastPaidVisitDaysFor(personId, day);
  } catch (_) {
    last = null;
  }
  if (my !== followupBusy) return;
  const lastPaidDays = last && last.days != null ? last.days : null;
  // The rule lives in core/billing.js — same call the DB write path makes.
  const { followup } = evaluateFollowup({ lastPaidDays, explicit: null });
  if (followup === 1) {
    // Inside window -> free follow-up.
    if (b.fFollowup) b.fFollowup.value = '1';
    lockFee(0);
    const left = followupDaysLeft(lastPaidDays);
    setFollowupNote(
      `Free follow-up — last paid visit ${lastPaidDays === 0 ? 'today' : lastPaidDays + ' day(s) ago'}. Window closes in ${left} day(s).`
    );
  } else if (lastPaidDays != null && lastPaidDays > 6) {
    // Past window -> force paid, unlock fee, note the gap.
    if (b.fFollowup) b.fFollowup.value = '0';
    unlockFee();
    if (b.fFee && (!b.fFee.value || Number(b.fFee.value) === 0)) b.fFee.value = String(DEFAULT_FEE);
    setFollowupNote(
      `Paid visit — last paid visit was ${lastPaidDays} day(s) ago (outside the 6-day follow-up window).`
    );
  } else {
    // No prior paid visit -> first-time patient, force paid.
    if (b.fFollowup) b.fFollowup.value = '0';
    unlockFee();
    if (b.fFee && (!b.fFee.value || Number(b.fFee.value) === 0)) b.fFee.value = String(DEFAULT_FEE);
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
    if (!b.fFee.value || Number(b.fFee.value) === 0) b.fFee.value = String(DEFAULT_FEE);
  }
  setFollowupNote('');
  refreshPreview();
}

// Pat ID change: look up the person and populate. Empty = leave fields as-is
// (submit falls back to (name, mob) matching).
async function onPatIdChange() {
  const raw = b.fPatientId.value.trim();
  if (!raw) return;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    setMsg('Pat ID must be a number.', 'err');
    return;
  }
  const p = await db.getPerson(id);
  if (!p) {
    setMsg(`No patient with ID ${id}.`, 'err');
    applyFollowupRule(null)
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

// Reset the form for a new bill. resetDate=false keeps the current date (used
// when mid-edit on a specific day, e.g. a free-token lookup).
export function startNewBill(nextToken = true, resetDate = true) {
  clearToast();
  b.fName.value = '';
  b.fMob.value = '';
  b.fAge.value = '';
  b.fGender.value = 'M';
  b.fWeight.value = '';
  b.fFollowup.value = '0';
  b.fPayment.value = '0';
  unlockFee();
  b.fFee.value = String(DEFAULT_FEE);
  setFollowupNote('');
  b.fPatientId.value = '';
  // Fresh bill starts on today's date.
  if (resetDate && b.fDate) b.fDate.value = db.localDay();
  tokenEdited = false;
  loadedVisitId = null;
  hideSuggests();
  setMsg('');
  b.fName.focus();
  if (nextToken) refreshNextToken();
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

// Ask how to proceed when the form's identity differs from the linked patient.
// Returns 'update' | 'new' | 'cancel'.
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

// Variant: form identity matches an EXISTING patient (not the linked one).
// "Update" would collide, so only Reassign or Cancel are offered. Reuses the
// same dialog element; falls back to 'reassign' if markup is missing.
function askReassign(linked, other, current) {
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
    const row = (label, value) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value == null || value === '' ? '—' : String(value);
      dl.append(dt, dd);
    };
    row('Currently linked', `#${linked.id} ${linked.name}`);
    row('Reassign to', `#${other.id} ${other.name}`);
    row('Mobile', other.mob);
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

// Worker for onSubmit. The guard/disable lives on onSubmit — do NOT re-check
// `submitting` here, or the outer call would make this a no-op.
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

  const day = dateRaw || db.localDay();
  let patId = Number(b.fPatientId.value.trim()) || null;
  const weight = Number(weightRaw);
  const followup = b.fFollowup && b.fFollowup.value === '1' ? 1 : 0;
  const payment = b.fPayment && b.fPayment.value === '1' ? 1 : 0;
  const fee = Number(feeRaw);

  // If a patient is linked and the user edited their identity, ask how to
  // proceed before writing anything.
  if (patId) {
    const p = await db.getPerson(patId);
    // Identity unchanged -> nothing to resolve, no dialog.
    if (p && (p.name !== name || p.mob !== mob)) {
      // If the new (name, mob) belongs to a DIFFERENT existing patient, then
      // "Update" would collide — only offer Reassign or Cancel.
      // Exact compound-index lookup (a prefix search would be wrong here).
      const hit = await db.findPersonByNameMob(name, mob);
      const other = hit && hit.id !== patId ? hit : null;
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
  let token = visitInput.token || (await db.nextTokenForDate(day));
  visitInput.token = token;
  let result;
  // Bounded retry on token collision: re-derive the next token, back off briefly,
  // retry up to MAX_ATTEMPTS. Any other error propagates unchanged.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      result = await db.addVisit(visitInput);
      break;
    } catch (err) {
      if (err && err.name === 'DuplicateIdentityError') {
        setMsg(err.message, 'err');
        return;
      }
      if (err && err.name === 'ConstraintError' && attempt < MAX_ATTEMPTS) {
        token = await db.nextTokenForDate(day);
        visitInput.token = token;
        await new Promise((r) => setTimeout(r, 40 * attempt));
        continue;
      }
      throw err;
    }
  }
  const { rec, created } = result;
  // Form now reflects a committed visit — mark as loaded so "current visit"
  // actions (Alt+R refund) work without re-picking.
  loadedVisitId = rec.id;
  // Echo the resolved person id back so the next Save carries an explicit id.
  b.fPatientId.value = rec.personId != null ? String(rec.personId) : '';
  hideSuggests();

  // Reflect the resolved billing back into the form (auto-followup may have
  // flipped the flag or zeroed the fee server-side).
  if (b.fFollowup) b.fFollowup.value = rec.followup ? '1' : '0';
  if (b.fPayment) b.fPayment.value = rec.payment ? '1' : '0';
  if (b.fFee && rec.fee != null) {
    b.fFee.value = String(rec.fee);
    if (rec.followup) lockFee(rec.fee);
  }
  if (b.fWeight && rec.weight != null) b.fWeight.value = String(rec.weight);

  if (!testHooks.suppressPrint) {
    ps.print(
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
      () => ps.openDesigner()
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
  };
  ps.mount(b.host, {
    autoShow: false,
    openDesignerOnReady: true,
    seedDefaultOnReady: true,
    minimal: true,
  });
  const off = bindOff();
  off.on(b.form, 'submit', onSubmit);
  off.on(b.form, 'input', refreshPreview);
  off.on(document.getElementById('btn-new-bill'), 'click', startNewBill);
  off.on(b.fName, 'input', onNameInput);
  off.on(b.fPatientId, 'change', onPatIdChange);
  off.on(b.fToken, 'change', onTokenChange);
  off.on(b.fToken, 'blur', onTokenBlur);
  off.on(b.fDate, 'change', onDateChange);
  off.on(b.fDate, 'input', onDateChange);
  // Alt+R: refund the visit currently loaded in the form.
  off.on(document, 'keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'r' && e.key !== 'R') return;
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    refundCurrentVisit();
  });
  if (b.fFollowup) off.on(b.fFollowup, 'change', onFollowupChange);
  if (b.fFee)
    off.on(b.fFee, 'input', () => {
      // Manual edit clears the lock so onFollowupChange won't fight the user.
      if (b.fFee.dataset.locked === '1') unlockFee();
    });
  off.on(b.fName, 'blur', revalidateIdentity);
  off.on(b.fMob, 'blur', revalidateIdentity);
  off.on(b.fName, 'change', revalidateIdentity);
  off.on(b.fMob, 'change', revalidateIdentity);
  // Alt+S -> Save & Print (only while this page is mounted). Ctrl/Shift must be
  // unset so we don't shadow browser combos.
  off.on(window, 'keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      if (b.form && !submitting) b.form.requestSubmit();
    }
  });
  off.on(b.fName, 'keydown', onSuggestKey);
  off.on(document, 'mousedown', onDocMouseDown);
  b.off = off;
  refreshNextToken();
  b.fName.focus();
}

export function unmount() {
  if (b && b.off) b.off.off();
  submitting = false;
  clearToast();
  ps.reset();
}
