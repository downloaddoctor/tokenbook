// Register billing: fee preview + auto-follow-up rule + fee lock. Reads the DOM
// bag from register.ctx; the follow-up RULE itself lives in core/billing.js.

import db from '../../core/db.js';
import ps from '../../print/ps.js';
import { evaluateFollowup, followupDaysLeft, defaultFee } from '../../core/billing.js';
import { getB, getFlags } from './register.ctx.js';

export function fieldValues() {
  const b = getB();
  return {
    name: b.fName.value.trim(),
    mob: b.fMob.value.trim(),
    age: b.fAge.value.trim(),
    gender: b.fGender.value.trim(),
    weight: b.fWeight ? b.fWeight.value.trim() : '',
    followup: b.fFollowup ? b.fFollowup.value : '0',
    payment: b.fPayment ? b.fPayment.value : '0',
    fee: b.fFee ? b.fFee.value.trim() : String(defaultFee()),
    date: b.fDate.value.trim(),
    token: b.fToken.value.trim(),
  };
}

let previewTimer = null;
export function refreshPreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = null;
    ps.preview(fieldValues());
  }, 90);
}

export function setFollowupNote(text) {
  const el = document.getElementById('followup-note');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

export function lockFee(v) {
  const b = getB();
  if (!b.fFee) return;
  b.fFee.value = String(v);
  b.fFee.readOnly = true;
  b.fFee.dataset.locked = '1';
}

export function unlockFee() {
  const b = getB();
  if (!b.fFee) return;
  delete b.fFee.dataset.locked;
  b.fFee.readOnly = false;
}

// Fill the fee field with the configured default when it is empty/zero.
function seedFee() {
  const b = getB();
  b.fFee.value = String(defaultFee());
}

// Force the fee field to the current default, unless a saved visit is loaded
// for editing (which must keep ITS fee). Called after a Settings save.
export function reseedFee() {
  const b = getB();
  if (!b || !b.fFee || b.fFee.readOnly) return;
  const flags = getFlags();
  if (flags.loadedVisitId != null) return;
  b.fFee.value = String(defaultFee());
  refreshPreview();
}

// Auto-followup rule: if the linked patient had a PAID visit within the last 6
// calendar days, mark this visit as a free follow-up and lock fee to 0.
let followupBusy = 0;
export async function applyFollowupRule(personId) {
  const b = getB();
  const my = ++followupBusy;
  const day = (b.fDate && b.fDate.value) || db.localDay();
  if (!personId) {
    if (my !== followupBusy) return;
    if (b.fFollowup) b.fFollowup.value = '0';
    unlockFee();
    seedFee();
    setFollowupNote('');
    return;
  }
  // Exclude the loaded visit from its own follow-up anchor lookup — a paid
  // visit must not follow up on itself when edited.
  const flags = getFlags();
  const excludeRootId = flags.loadedVisitId != null ? flags.loadedVisitId : null;
  let last = null;
  try {
    last = await db.lastPaidVisitDaysFor(personId, day, excludeRootId);
  } catch (_) {
    last = null;
  }
  if (my !== followupBusy) return;
  const lastPaidDays = last && last.days != null ? last.days : null;
  const { followup } = evaluateFollowup({ lastPaidDays, explicit: null });
  if (followup === 1) {
    if (b.fFollowup) b.fFollowup.value = '1';
    lockFee(0);
    const left = followupDaysLeft(lastPaidDays);
    setFollowupNote(
      `Free follow-up — last paid visit ${lastPaidDays === 0 ? 'today' : lastPaidDays + ' day(s) ago'}. Window closes in ${left} day(s).`
    );
  } else if (lastPaidDays != null && lastPaidDays > 6) {
    if (b.fFollowup) b.fFollowup.value = '0';
    unlockFee();
    seedFee();
    setFollowupNote(
      `Paid visit — last paid visit was ${lastPaidDays} day(s) ago (outside the 6-day follow-up window).`
    );
  } else {
    if (b.fFollowup) b.fFollowup.value = '0';
    unlockFee();
    seedFee();
    setFollowupNote('');
  }
}

export function onFollowupChange() {
  const b = getB();
  if (b.fFollowup.value === '1') lockFee(0);
  else {
    unlockFee();
    seedFee();
  }
  setFollowupNote('');
  refreshPreview();
}
