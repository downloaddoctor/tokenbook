// Dev self-test: drives the REAL Register form (Save & Print) through first
// visit, follow-up, new visit, edit and reassign; exercises the Tokens refund
// dialog; checks the follow-up window boundary; then verifies the DB, the
// read-side (tokens list + patient history) and the backup log. Reports
// progress and a final per-check pass/fail.
//
// Uses date '1970-01-01' so test rows are isolated. NOT imported by prod
// pages; wired from app.js. Replay is destructive and gated by confirmReplay.

import { PatientDb } from '../core/db.js';
import { PatientBackup } from '../backup/backup.js';

const TEST_DATE = '1970-01-01';
const NAME_A = 'TEST PATIENT A';
const MOB_A = '0000000001';
const NAME_B = 'TEST PATIENT B';
const MOB_B = '0000000002';

function makeReporter(onProgress) {
  const results = [];
  const emit = (r) => {
    results.push(r);
    if (onProgress) onProgress(r.name, r.ok, r.detail, r.status);
  };
  return {
    results,
    check(name, ok, detail) {
      emit({ name, ok: !!ok, status: ok ? 'PASS' : 'FAIL', detail: detail || '' });
      return !!ok;
    },
    eq(name, actual, expected, detail) {
      const ok = actual === expected;
      return this.check(
        name,
        ok,
        ok ? detail || '' : 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)
      );
    },
    skip(name, detail) {
      emit({ name, ok: true, status: 'SKIP', detail: detail || '' });
      return true;
    },
  };
}

function settle(ms) {
  return new Promise((r) => setTimeout(r, ms == null ? 2200 : ms));
}

async function readLogText() {
  const r = await PatientBackup.readLog();
  return r.text == null ? '' : r.text;
}
function logRows(text) {
  return text.split('\n').filter((l) => l && l.indexOf('|') > 0);
}
function countTestRows(text) {
  return logRows(text).filter((l) => l.split('|')[0] === TEST_DATE).length;
}
function lastLogRow(text, token) {
  let found = null;
  for (const l of logRows(text)) {
    const f = l.split('|');
    if (f[0] === TEST_DATE && Number(f[1]) === token) found = f;
  }
  return found;
}

// ---- UI form driver ---------------------------------------------------
function setVal(el, value, type) {
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event(type || 'input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// Submit via the register module's direct path so errors surface. Returns an
// error message string, or null on success.
async function submitForm(form, register) {
  if (register && register.__submitForTest) {
    try {
      await register.__submitForTest();
      return null;
    } catch (e) {
      return e && e.message ? e.message : String(e);
    }
  }
  form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit'));
  await settle(300);
  return null;
}

// Shift a 'YYYY-MM-DD' string by -offsetDays.
function shiftDate(dateStr, offsetDays) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Find a token row in the Tokens table and drive the refund dialog.
async function refundViaUI(tok, tier, onProgress) {
  const trs = document.querySelectorAll('#tokens-table tbody tr[data-id]');
  let rowEl = null;
  for (const tr of trs) {
    const first = tr.querySelector('td');
    if (first && Number(first.textContent) === tok) {
      rowEl = tr;
      break;
    }
  }

  if (!rowEl) return 'token ' + tok + ' row not found';
  rowEl.click();
  await settle(250);
  const dlg = document.getElementById('refund-dialog');
  const sel = document.getElementById('refund-tier');
  if (!dlg || !sel) return 'refund dialog missing';
  if (!dlg.open) return 'refund dialog did not open';
  sel.value = String(tier);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const save = dlg.querySelector('#refund-save');
  if (!save) return 'save button missing';
  save.click();
  await settle(250);
  return null;
}

export async function runSelfTest({ onProgress, confirmReplay, router } = {}) {
  const rep = makeReporter(onProgress);
  const stage = (s) => onProgress && onProgress('#stage', true, s);

  const register = await import('../ui/pages/register.js');
  register.__setTestHooks({ suppressPrint: true, bypassLayoutCheck: true, answerIdentity: null });

  if (router && router.activateTab) router.activateTab('register', true);
  await settle(350);
  const b = register.__getForm();
  if (!b || !b.form) {
    rep.check('register form mounted', false, 'could not access #patient-form');
    return finish(rep);
  }
  rep.check('register form mounted', true);

  const st = PatientBackup.state();
  const hasFolder = st.hasFolder;
  if (hasFolder) rep.check('backup folder set', true, st.folderName);
  else rep.skip('backup folder set', 'no folder — log + replay checks skipped');

  // Fill the register form. `date` sets the day (defaults to TEST_DATE);
  // `token` sets the token field (triggers edit-mode load when a visit exists);
  // `patientId` sets the hidden person id (used for reassign). Identity and
  // billing fields are optional.
  const fill = async ({ date, token, patientId, name, mob, age, gender, weight, payment, followup } = {}) => {
    if (date) {
      setVal(b.fDate, date || TEST_DATE);
      await settle(400);
    }
    if (token) {
      setVal(b.fToken, String(token));
      await settle(400);
    }
    if (patientId) {
      setVal(b.fPatientId, String(patientId));
      await settle(400);
    }
    if (name) setVal(b.fName, name);
    if (mob) setVal(b.fMob, mob);
    if (age) setVal(b.fAge, age);
    if (gender) setVal(b.fGender, gender);
    if (weight) setVal(b.fWeight, weight);
    if (payment) setVal(b.fPayment, payment);
    if (followup) setVal(b.fFollowup, String(followup));
    await settle(120);
  };

  // ---- 1. FIRST VISIT (paid) -------------------------------------------
  stage('1. first visit (paid)');
  register.startNewBill();
  await settle(350);
  await fill({ date: TEST_DATE, token: 1, name: NAME_A, mob: MOB_A, age: '40', gender: 'M', weight: '70', payment: '0' });
  const err1 = await submitForm(b.form, register);
  rep.check('first visit: submit ok', !err1, err1 || '');

  let v1 = await PatientDb.findVisitByDateToken(TEST_DATE, 1);
  rep.check('first visit: created at token 1', !!v1);
  rep.check('first visit: personId set', v1 && Number.isInteger(v1.visit.personId), v1 ? 'personId=' + v1.visit.personId : '');
  rep.eq('first visit: fee 300', v1 && v1.visit.fee, 300);
  rep.eq('first visit: followup 0', v1 && v1.visit.followup, 0);
  const pidA = v1 && v1.visit.personId;

  // ---- 2. FOLLOW-UP VISIT (same patient, within window) ----------------
  stage('2. follow-up visit (free)');
  register.startNewBill();
  await settle(350);
  await fill({ date: TEST_DATE, token: 2, patientId: pidA });
  const err2 = await submitForm(b.form, register);
  rep.check('follow-up: submit ok', !err2, err2 || '');

  const v2 = await PatientDb.findVisitByDateToken(TEST_DATE, 2);
  rep.check('follow-up: created at token 2', !!v2);
  rep.eq('follow-up: same person', v2 && v2.visit.personId, pidA);
  rep.eq('follow-up: auto followup 1', v2 && v2.visit.followup, 1);
  rep.eq('follow-up: fee 0', v2 && v2.visit.fee, 0);

  // ---- 3. NEW VISIT (different patient) --------------------------------
  stage('3. new visit (new patient)');
  register.startNewBill();
  await settle(350);
  await fill({ date: TEST_DATE, token: 3, name: NAME_B, mob: MOB_B, age: '55', gender: 'F', weight: '60', payment: '1' });
  const err3 = await submitForm(b.form, register);
  rep.check('new visit: submit ok', !err3, err3 || '');

  const v3 = await PatientDb.findVisitByDateToken(TEST_DATE, 3);
  rep.check('new visit: created at token 3', !!v3);
  rep.check('new visit: new person id', v3 && v3.visit.personId !== pidA, v3 ? 'personId=' + v3.visit.personId : '');
  const pidB = v3 && v3.visit.personId;

  // ---- 4. EDIT VISIT (load token 1, change age, resave) ----------------
  stage('4. edit visit (token 1)');
  register.startNewBill();
  await settle(350);
  await fill({ date: TEST_DATE, token: 1 });
  rep.eq('edit: form loaded name', (b.fName.value || '').toUpperCase(), NAME_A);
  setVal(b.fAge, '41');
  // Keep it a PAID visit: the follow-up rule may have flipped it to free when
  // the visit loaded (patient A has a same-day paid visit). Force paid so the
  // refund stage that follows can open the dialog.
  // setVal(b.fFollowup, '0');
  await settle(200);
  const err4 = await submitForm(b.form, register);
  rep.check('edit: submit ok', !err4, err4 || '');

  const v1b = await PatientDb.findVisitByDateToken(TEST_DATE, 1);
  rep.eq('edit: age updated to 41', v1b && v1b.visit.age, 41);
  rep.eq('edit: still same person', v1b && v1b.visit.personId, pidA);

  // ---- 5. REASSIGN VISIT (token 1 -> patient B) ------------------------
  stage('5. reassign visit (token 1 -> patient B)');
  register.startNewBill();
  await settle(350);
  await fill({ date: TEST_DATE, token: 1 });
  const beforeAssign = await PatientDb.findVisitByDateToken(TEST_DATE, 1);
  if (!beforeAssign || !beforeAssign.visit) {
    rep.check('reassign: token 1 present before reassign', false, 'token 1 missing');
  } else {
    setVal(b.fPatientId, String(pidB));
    await settle(400);
    rep.eq('reassign: form loaded patient B name', (b.fName.value || '').toUpperCase(), NAME_B);
    // Keep it PAID so the refund stage can exercise the dialog.
    // setVal(b.fFollowup, '0');
    await settle(150);
    const err5 = await submitForm(b.form, register);
    rep.check('reassign: submit ok', !err5, err5 || '');

    const v1c = await PatientDb.findVisitByDateToken(TEST_DATE, 1);
    rep.check(
      'reassign: visit now points at patient B',
      v1c && v1c.visit.personId === pidB,
      v1c ? 'personId=' + v1c.visit.personId + ' (B=' + pidB + ')' : 'no visit'
    );
    const aPerson = await PatientDb.getPerson(pidA);
    const aVisits = aPerson ? aPerson.visits : 0;
    rep.check('reassign: patient A visit count = 1', aVisits === 1, 'A.visits=' + aVisits);
  }

  const v1c = await PatientDb.findVisitByDateToken(TEST_DATE, 1);
  if (!v1c) {
    rep.check('refund: token 1 visit present', false, 'no token 1 visit; cannot test refund');
    register.__setTestHooks({ suppressPrint: false, bypassLayoutCheck: false, answerIdentity: null });
    return finish(rep);
  }

  // ---- 6. REFUND via the Tokens-page dialog ----------------------------
  stage('6. refund via UI dialog (tokens page)');
  await import('../ui/pages/tokens.js');
  if (router && router.activateTab) router.activateTab('tokens', true);
  await settle(1300);
  const tokensDateEl = document.getElementById('tokens-date');
  if (tokensDateEl) {
    setVal(tokensDateEl, TEST_DATE);
    await settle(350);
  }
  await settle(1300);

  const rowsInTable = document.querySelectorAll('#tokens-table tbody tr[data-id]').length;
  rep.check('refund-ui: token list rendered', rowsInTable > 0, 'rows=' + rowsInTable);
 
  await settle(350);
  let rerr = await refundViaUI(1, 1, onProgress);
  rep.check('refund-ui: tier 1 save', !rerr, rerr || '');
  let rr = await PatientDb.findVisitByDateToken(TEST_DATE, 1);
  rep.eq('refund-ui: tier 1 persisted', rr && rr.visit.refundTier, 1);

  rerr = await refundViaUI(1, 3, onProgress);
  rep.check('refund-ui: tier 3 save', !rerr, rerr || '');
  rr = await PatientDb.findVisitByDateToken(TEST_DATE, 1);
  rep.eq('refund-ui: tier 3 persisted', rr && rr.visit.refundTier, 3);

  rerr = await refundViaUI(1, 0, onProgress);
  rep.check('refund-ui: clear (0) save', !rerr, rerr || '');
  rr = await PatientDb.findVisitByDateToken(TEST_DATE, 1);
  rep.eq('refund-ui: cleared to 0', rr && rr.visit.refundTier, 0);

  rerr = await refundViaUI(1, 2, onProgress);
  rep.check('refund-ui: final tier 2 save', !rerr, rerr || '');
  rr = await PatientDb.findVisitByDateToken(TEST_DATE, 1);
  rep.eq('refund-ui: final tier 2', rr && rr.visit.refundTier, 2);
  rep.eq('refund-ui: amount 200', PatientDb.refundAmountFor(rr.visit.refundTier), 200);

  // ---- 6b. follow-up window boundary (6 vs 7 days) ---------------------
  stage('6b. follow-up window boundary');
  const date6 = shiftDate(TEST_DATE, 6);
  const date7 = shiftDate(TEST_DATE, 7);
  const c6 = await PatientDb.addVisit({
    name: 'TEST PATIENT C', mob: '0000000003', age: 30, gender: 'M', weight: 65,
    followup: 0, payment: 0, fee: 300, token: 1, date: date6,
  });
  const pidC = c6.rec.personId;
  const withinC = await PatientDb.lastPaidVisitDaysFor(pidC, TEST_DATE);
  rep.check('boundary: 6 days -> inside window', withinC && withinC.days === 6, withinC ? 'days=' + withinC.days : 'none');

  const d7 = await PatientDb.addVisit({
    name: 'TEST PATIENT D', mob: '0000000004', age: 30, gender: 'M', weight: 65,
    followup: 0, payment: 0, fee: 300, token: 1, date: date7,
  });
  const pidD = d7.rec.personId;
  const outD = await PatientDb.lastPaidVisitDaysFor(pidD, TEST_DATE);
  rep.check('boundary: 7 days -> outside window', outD && outD.days === 7, outD ? 'days=' + outD.days : 'none');

  // ---- 7. LOG consistency ----------------------------------------------
  if (hasFolder) {
    stage('7. log');
    await PatientBackup.backupNow();
    await settle();
    const text = await readLogText();
    const rows = countTestRows(text);
    rep.check('log: test rows written', rows >= 3, 'rows=' + rows);
    const f1 = lastLogRow(text, 1);
    rep.check('log: row token 1 present', !!f1);
    if (f1) {
      // date token personId name mob age gender weight followup payment fee refundTier createdAt updatedAt
      rep.eq('log: row1 personId = B', Number(f1[2]), pidB);
      rep.eq('log: row1 age = 41', Number(f1[6]), 41);
      rep.eq('log: row1 refundTier = 2', Number(f1[11]), 2);
    }

    stage('8. replay (wipes + rebuilds from log)');
    const preVisits = await PatientDb.countAll();
    const prePeople = await PatientDb.countPeople();
    if (confirmReplay) {
      const ok = await confirmReplay({ visits: preVisits, people: prePeople });
      if (!ok) rep.skip('replay: cancelled by user', 'DB left untouched');
      else await doReplay(rep, text, preVisits, prePeople);
    } else {
      await doReplay(rep, text, preVisits, prePeople);
    }
  } else {
    rep.skip('log + replay checks', 'no folder — press Backup to set one, then re-run');
  }

  // ---- 8b. read-side: tokens list + patient history --------------------
  stage('8b. read-side checks');
  const dayRows = await PatientDb.listByDate(TEST_DATE);
  rep.check('read: listByDate returns test day', dayRows.length >= 3, 'rows=' + dayRows.length);
  const rowT1 = dayRows.find((r) => r.token === 1);
  rep.check('read: token 1 in day list', !!rowT1);
  rep.eq('read: token 1 personId = B', rowT1 && rowT1.personId, pidB);
  rep.eq('read: token 1 refundTier = 2', rowT1 && rowT1.refundTier, 2);

  const bHistory = await PatientDb.visitsForPerson(pidB);
  rep.check('read: B history has the reassigned visit', bHistory.some((v) => v.token === 1 && v.date === TEST_DATE));
  const aHistory = await PatientDb.visitsForPerson(pidA);
  rep.check('read: A history lost token 1', !aHistory.some((v) => v.token === 1));
  rep.check('read: A history still has token 2', aHistory.some((v) => v.token === 2));

  // ---- 9. cleanup ------------------------------------------------------
  stage('9. cleanup (remove test rows from DB)');
  try {
    const del = await PatientDb.deleteVisitsByDate(TEST_DATE);
    const delC = await PatientDb.deleteVisitsByDate(date6);
    const delD = await PatientDb.deleteVisitsByDate(date7);
    const left = await PatientDb.listByDate(TEST_DATE);
    rep.check(
      'cleanup: test visits removed from DB',
      left.length === 0,
      'removed ' + (del.visits + delC.visits + delD.visits) + ' visits; ' + left.length + ' left on test day'
    );
    const f = await PatientDb.findVisitByDateToken(TEST_DATE, 1);
    rep.check('cleanup: token 1 gone from DB', !f);
    const fc = await PatientDb.findVisitByDateToken(date6, 1);
    const fd = await PatientDb.findVisitByDateToken(date7, 1);
    rep.check('cleanup: boundary rows gone', !fc && !fd);
  } catch (e) {
    rep.check('cleanup: test visits removed from DB', false, e && e.message ? e.message : String(e));
  }

  register.__setTestHooks({ suppressPrint: false, bypassLayoutCheck: false, answerIdentity: null });
  if (router && router.activateTab) router.activateTab(router.currentTab, true);

  return finish(rep);
}

async function doReplay(rep, text, preVisits, prePeople) {
  const ops = await PatientBackup.parseBackup(text);
  const r = await PatientDb.replayLog(ops);
  rep.check('replay: rows restored', r.count > 0, 'count=' + r.count + ' skipped=' + r.skipped);
  rep.eq('replay: skipped = 0', r.skipped, 0);
  const after = await PatientDb.findVisitByDateToken(TEST_DATE, 1);
  rep.check('replay: token 1 restored', !!after);
  if (after) {
    rep.eq('replay: restored refundTier = 2', after.visit.refundTier, 2);
    rep.eq('replay: restored age = 41', after.visit.age, 41);
  }
  rep.check('replay: pre-replay DB had rows', preVisits > 0, 'visits=' + preVisits + ' people=' + prePeople);
}

function finish(rep) {
  const failed = rep.results.filter((r) => !r.ok);
  const skipped = rep.results.filter((r) => r.status === 'SKIP').length;
  const passed = rep.results.filter((r) => r.status === 'PASS').length;
  return {
    ok: failed.length === 0,
    total: rep.results.length,
    passed,
    skipped,
    failed: failed.length,
    results: rep.results,
  };
}
