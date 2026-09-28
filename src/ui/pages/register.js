// Register page: form orchestration (mount/unmount, submit, edit, load).
// Autofill/billing/dialog helpers live in sibling register.*.js modules; shared
// state (DOM bag + flags) lives in register.ctx.js. Router calls mount()/unmount().

import db from '../../core/db.js';
import { defaultFee } from '../../core/billing.js';
import ps from '../../print/ps.js';
import { bindOff, isDialogOpen } from '../dom.js';
import { toast, clearToast } from '../toast.js';
import { openRefundFor, refundLabel } from '../refund.js';
import { openRevisions } from '../revisions.js';
import { askIdentityChange, askReassign } from './register.dialogs.js';
import { setB, getFlags, setHook } from './register.ctx.js';
import {
  refreshPreview,
  applyFollowupRule,
  setFollowupNote,
  lockFee,
  unlockFee,
  onFollowupChange,
  reseedFee,
} from './register.billing.js';
export { reseedFee };
import { hideSuggests, refreshNextToken, bindAutofill } from './register.autofill.js';

// DOM bag. Same object as register.ctx's bag (synced in mount()).
let b;

// ---- test hooks (dev self-test only) ----
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

// Toast helper. kind: 'ok' | 'err' | undefined (errors are styled red).
function setMsg(text, kind) {
  toast(text, kind);
}

// Fill the form from a visit (edit mode). Shared by onTokenChange and editVisit.
function loadVisitIntoForm(visit, person) {
  if (!b) return;
  const flags = getFlags();
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
    person && person.rootId != null
      ? String(person.rootId)
      : visit.personId != null
        ? String(visit.personId)
        : '';
  flags.loadedVisitId = visit.rootId;
  refreshPreview();
}

// Load a visit into the Register form for editing. Used by Tokens on Enter.
export async function editVisit(visit) {
  if (!visit) return false;
  let person = null;
  if (visit.personId != null) person = await db.getPerson(visit.personId);
  loadVisitIntoForm(visit, person);
  return true;
}

// Alt+R: open the refund dialog for the visit currently loaded. Paid only.
async function refundCurrentVisit() {
  const flags = getFlags();
  if (!flags.loadedVisitId) {
    toast('No saved visit loaded to refund.', 'err');
    return;
  }
  const found = await db.findVisitByDateToken(b.fDate.value.trim(), Number(b.fToken.value));
  const visit = found && found.visit;
  if (!visit || visit.rootId !== flags.loadedVisitId) {
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
  const flags = getFlags();
  const patId = Number(b.fPatientId.value.trim()) || null;
  if (patId) applyFollowupRule(patId);
  if (flags.tokenEdited) return;
  await refreshNextToken();
}

// Pat ID change: look up the person and populate. Empty = leave fields as-is
// (submit falls back to (name, mob) matching).
async function onPatIdChange() {
  const flags = getFlags();
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
    applyFollowupRule(null);
    return;
  }
  b.fName.value = (p.name || '').toUpperCase();
  b.fMob.value = p.mob || '';
  b.fAge.value = String(p.age);
  b.fGender.value = p.gender || 'M';
  b.fWeight.value = p.weight != null && p.weight !== '' ? String(p.weight) : '';
  hideSuggests();
  setMsg('');

  if (!flags.loadedVisitId) applyFollowupRule(p.rootId);
  else setFollowupNote('');
  refreshPreview();
}

// Reset the form for a new bill. resetDate=false keeps the current date.
export function startNewBill(nextToken = true, resetDate = true) {
  const flags = getFlags();
  clearToast();
  b.fName.value = '';
  b.fMob.value = '';
  b.fAge.value = '';
  b.fGender.value = 'M';
  b.fWeight.value = '';
  b.fFollowup.value = '0';
  b.fPayment.value = '0';
  unlockFee();
  b.fFee.value = String(defaultFee());
  setFollowupNote('');
  b.fPatientId.value = '';
  if (resetDate && b.fDate) b.fDate.value = db.localDay();
  flags.tokenEdited = false;
  flags.loadedVisitId = null;
  hideSuggests();
  setMsg('');
  b.fName.focus();
  if (nextToken) refreshNextToken();
}

async function onSubmit(e) {
  e.preventDefault();
  const flags = getFlags();
  if (flags.submitting) return;
  flags.submitting = true;
  const btn = b.saveBtn;
  if (btn) btn.disabled = true;
  try {
    await submitBill();
  } finally {
    flags.submitting = false;
    if (btn) btn.disabled = false;
  }
}

// Worker for onSubmit. The guard/disable lives on onSubmit — do NOT re-check
// `submitting` here, or the outer call would make this a no-op.
async function submitBill() {
  const flags = getFlags();
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
  const weight = Number(weightRaw);
  const followup = b.fFollowup && b.fFollowup.value === '1' ? 1 : 0;
  const payment = b.fPayment && b.fPayment.value === '1' ? 1 : 0;
  const fee = Number(feeRaw);

  // Patient ID: a typed id that matches no patient is DISCARDED (this becomes
  // a new patient, matched by (name, mob) on submit).
  let patId = Number(b.fPatientId.value.trim()) || null;
  if (patId) {
    const exists = await db.getPerson(patId);
    if (!exists) {
      b.fPatientId.value = '';
      patId = null;
    }
  }

  // If a patient is linked and the user edited their identity, ask how to proceed.
  if (patId) {
    const p = await db.getPerson(patId);
    if (p && (p.name !== name || p.mob !== mob)) {
      const hit = await db.findPersonByNameMob(name, mob);
      const other = hit && hit.rootId !== patId ? hit : null;
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

  // Token: a typed token with no visit at (day, token) is DISCARDED — a new
  // visit always uses the system-assigned next token for the day. (An existing
  // visit at that key is kept, so editing never renumbers.)
  let token = Number(b.fToken.value) || null;
  if (token != null) {
    const at = await db.findVisitByDateToken(day, token);
    if (!at) token = null;
  }
  if (token == null) token = await db.nextTokenForDate(day);
  b.fToken.value = String(token);

  const visitInput = {
    name,
    mob,
    age,
    gender,
    weight,
    followup,
    payment,
    fee,
    token,
    date: day,
    personId: patId,
  };
  let result;
  // Bounded retry on token collision (max 3 attempts, brief backoff).
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
  flags.loadedVisitId = rec.rootId;
  b.fPatientId.value = rec.personId != null ? String(rec.personId) : '';
  hideSuggests();

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
  const flags = getFlags();
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
  setB(b);
  // Register orchestrator callbacks that sibling modules invoke via ctx.
  setHook('setMsg', setMsg);
  setHook('startNewBill', startNewBill);
  setHook('loadVisitIntoForm', loadVisitIntoForm);

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
  off.on(b.fPatientId, 'change', onPatIdChange);
  off.on(b.fDate, 'change', onDateChange);
  off.on(b.fDate, 'input', onDateChange);
  // Autofill (name/mob suggest, token, identity revalidation) binds its own.
  bindAutofill(off);
  // Alt+R: refund the visit currently loaded in the form.
  off.on(document, 'keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'r' && e.key !== 'R') return;
    if (isDialogOpen()) return;
    e.preventDefault();
    refundCurrentVisit();
  });
  // Alt+V: revision history of the visit currently loaded in the form.
  off.on(document, 'keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'v' && e.key !== 'V') return;
    if (isDialogOpen()) return;
    e.preventDefault();
    if (flags.loadedVisitId == null) {
      toast('No saved visit loaded — nothing to show.', 'err');
      return;
    }
    openRevisions('visit', flags.loadedVisitId);
  });
  if (b.fFollowup) off.on(b.fFollowup, 'change', onFollowupChange);
  if (b.fFee)
    off.on(b.fFee, 'input', () => {
      if (b.fFee.dataset.locked === '1') unlockFee();
    });
  // Alt+S -> Save & Print (only while this page is mounted).
  off.on(window, 'keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      if (b.form && !flags.submitting) b.form.requestSubmit();
    }
  });
  b.off = off;
  // Date bounds: prevent absurd dates (typo year, far future). ±5 years from
  // today is generous for a clinic and catches the common year-typo case.
  {
    const now = new Date();
    const min = new Date(now); min.setFullYear(now.getFullYear() - 5);
    const max = new Date(now); max.setFullYear(now.getFullYear() + 2);
    const iso = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${dd}`;
    };
    if (b.fDate) {
      b.fDate.min = iso(min);
      b.fDate.max = iso(max);
    }
  }
  refreshNextToken();
  // Seed the fee from settings when the form opens empty (the field has no
  // hardcoded default in markup; startNewBill seeds it, but a plain mount
  // — e.g. first load, or after a settings change — must seed it too).
  if (b.fFee && b.fFee.value === '') b.fFee.value = String(defaultFee());
  refreshPreview();
  b.fName.focus();
}

export function unmount() {
  const flags = getFlags();
  if (b && b.off) b.off.off();
  flags.submitting = false;
  clearToast();
  ps.reset();
}
