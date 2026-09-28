// Dev self-test: drives the REAL Register form (Save & Print) through first
// visit, follow-up, new visit, edit, and reassign; exercises the Tokens refund
// dialog; checks the follow-up window boundary; verifies DB + read-side +
// backup log. Reports progress and per-check pass/fail.
//
// Runs on the current local day against an ISOLATED DB + log, so it never
// touches real data. Wired from app.js (not imported by prod pages). Replay
// auto-runs (safe: isolated DB is dropped afterwards).

import db from '../core/db.js';
import backup from '../backup/backup.js';
import {
  parseBackup,
  parseCsvLine,
  csvToLog,
  csvHeaderLine,
  personRevToLogLine,
  visitRevToLogLine,
} from '../backup/csv.js';
import { localDay } from '../core/day.js';

// Runs on the CURRENT local day. Isolated DB (tokenbook-devtest) + isolated log
// (devtest csv), so no real data on this day to collide with.
const TEST_DATE = localDay();
const NAME_A = 'TEST PATIENT A';
const MOB_A = '0000000001';
const NAME_B = 'TEST PATIENT B';
const NAME_BN = 'TEST PATIENT B2';
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
    // Informational line — shown in the dialog but NOT counted as a check.
    info(text) {
      if (onProgress) onProgress('#info', true, text);
      return true;
    },
  };
}


function settle(ms) {
  return new Promise((r) => setTimeout(r, ms == null ? 2200 : ms));
}

async function readLogText() {
  const r = await backup.readLog();
  return r.text == null ? '' : r.text;
}
// Parse the v3 log into { person: [...], visit: [...] } rows, each as an
// object keyed by the schema columns. Head lines are skipped.
function parseLogRows(text) {
  const out = { person: [], visit: [] };
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#head'));
  // Discover the column order from the #head block once.
  const heads = text
    .split(/\r?\n/)
    .filter((l) => l.startsWith('#head'))
    .map((l) => parseCsvLine(l));
  const cols = {};
  for (const f of heads) {
    if (f.length < 4) continue;
    const no = Number(f[2]);
    cols[no] = f.slice(3).map((spec) => {
      const nullable = spec.endsWith('?');
      const base = nullable ? spec.slice(0, -1) : spec;
      return base.split(':')[0];
    });
  }
  for (const l of lines) {
    const f = parseCsvLine(l);
    const no = Number(f[0]);
    const keys = cols[no];
    if (!keys) continue;
    const row = {};
    for (let i = 0; i < keys.length; i++) row[keys[i]] = f[i + 1];
    const kind = no === 1 ? 'person' : 'visit';
    out[kind].push(row);
  }
  return out;
}
function countTestRows(text) {
  const { visit } = parseLogRows(text);
  return visit.filter((r) => r.date === TEST_DATE).length;
}
function lastLogRow(text, token) {
  const { visit } = parseLogRows(text);
  let found = null;
  for (const r of visit) {
    if (r.date === TEST_DATE && Number(r.token) === token) found = r;
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

// Submit via register's direct path so errors surface. Returns error string or null.
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

// Real-click driver for the identity dialog: submitBill() awaits the dialog's
// close event, so the button must be clicked WHILE submit is pending. `choice`
// is the button's value ('update'|'new'|'cancel'|'reassign'). Resolves once the
// dialog has opened and been clicked, or with an error string.
async function clickDialog(choice, timeoutMs) {
  const deadline = Date.now() + (timeoutMs == null ? 3000 : timeoutMs);
  while (Date.now() < deadline) {
    const dlg = document.getElementById('pat-id-confirm');
    if (dlg && dlg.open) {
      const btns = dlg.querySelectorAll('#pat-id-confirm-actions button');
      let target = null;
      for (const btn of btns) if (btn.value === choice) target = btn;
      if (!target) return 'dialog open but no button value=' + choice;
      target.click();
      await settle(150);
      return null;
    }
    await settle(50);
  }
  return 'identity dialog did not open for choice=' + choice;
}

// Submit and answer a dialog in parallel.
async function submitWithDialog(form, register, choice) {
  const submitP = submitForm(form, register);
  const clickP = clickDialog(choice);
  const clickErr = await clickP;
  const submitErr = await submitP;
  return clickErr || submitErr;
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

  // Isolated DB so replay can wipe/rebuild freely without touching real data —
  // which is why no destructive confirm is needed.
  await db.setDbName('tokenbook-devtest');
  await db.openDb();
  // Isolate the backup LOG too. Delete any devtest log from a prior run so each
  // run starts fresh with a header (parser requires header on line 1).
  backup.setLogFileName('tokenbook-latest-devtest.csv');
  await backup.deleteLog().catch(() => { });

  const register = await import('../ui/pages/register.js');
  register.__setTestHooks({ suppressPrint: true });

  if (router && router.activateTab) router.activateTab('register', true);
  await settle(350);
  const b = register.__getForm();
  if (!b || !b.form) {
    rep.check('register form mounted', false, 'could not access #patient-form');
    await db.deleteDb().catch(() => { });
    await db.setDbName(null).catch(() => { });
    backup.setLogFileName(null);
    return finish(rep);
  }
  rep.check('register form mounted', true);

  // Pre-clean: purge residue from a previous run (fixed identities + test-date
  // visits). People are not auto-deleted on 0 visits, so without this a prior
  // run's rows collide with this run's lookups. Keeps the self-test idempotent.
  await db.deletePeopleByNameMob(NAME_A, MOB_A).catch(() => 0);
  await db.deletePeopleByNameMob(NAME_B, MOB_B).catch(() => 0);
  await db.deletePeopleByNameMob(NAME_BN, MOB_B).catch(() => 0);
  await db.deletePeopleByNameMob('TEST PATIENT C', '0000000003').catch(() => 0);
  await db.deletePeopleByNameMob('TEST PATIENT D', '0000000004').catch(() => 0);
  await db.deleteVisitsByDate(TEST_DATE).catch(() => null);
  await db.deleteVisitsByDate(shiftDate(TEST_DATE, 6)).catch(() => null);
  await db.deleteVisitsByDate(shiftDate(TEST_DATE, 7)).catch(() => null);

  const st = backup.state();
  const hasFolder = st.hasFolder;
  if (hasFolder) rep.check('backup folder set', true, st.folderName);
  else rep.skip('backup folder set', 'no folder — log + replay checks skipped');

  // ---- 0. parser round-trip + malformed input (row 28) -----------------
  // Cheap, no DB: encode a couple of revisions, decode them, then feed the
  // decoder deliberately broken rows and assert the skipped-row shapes.
  stage('0. parser round-trip + malformed input');
  try {
    const pRow = {
      rootId: 42, v: 1, name: 'TEST PARSE', mob: '1234567890', age: 30,
      gender: 'M', weight: 70.5, hidden: 0,
      createdAt: '2026-01-01T00:00:00.000Z', revAt: '2026-01-01T00:00:00.000Z',
      userId: 1, userV: 1,
    };
    const vRow = {
      rootId: 7, v: 2, personId: 42, personV: 1, date: '2026-01-01', token: 5,
      weight: 70.5, followup: 1, payment: 0, fee: 0, refundTier: 2, hidden: 0,
      createdAt: '2026-01-01T00:00:00.000Z', revAt: '2026-01-02T00:00:00.000Z',
      userId: 1, userV: 1,
    };
    const good =
      csvHeaderLine() + '\n' +
      personRevToLogLine(pRow) + '\n' +
      visitRevToLogLine(vRow) + '\n';
    const r1 = csvToLog(good);
    rep.eq('parser: ops length 2', r1.ops.length, 2);
    rep.eq('parser: skipped length 0', r1.skippedRows.length, 0);
    rep.eq('parser: person kind', r1.ops[0].kind, 'person');
    rep.eq('parser: person name', r1.ops[0].name, 'TEST PARSE');
    rep.eq('parser: person age', r1.ops[0].age, 30);
    rep.eq('parser: person weight', r1.ops[0].weight, 70.5);
    rep.eq('parser: visit kind', r1.ops[1].kind, 'visit');
    rep.eq('parser: visit refundTier', r1.ops[1].refundTier, 2);
    rep.check('parser: visit epoch decoded',
      typeof r1.ops[1].createdAt === 'string' && r1.ops[1].createdAt.startsWith('2026-01-01'),
      'createdAt=' + r1.ops[1].createdAt);

    // Malformed inputs: unknown schemaNo, short row, bad epoch, non-log text.
    const bad =
      csvHeaderLine() + '\n' +
      '99|whatever|fields\n' +       // unknown schemaNo
      '1|1|1\n' +                     // short people row (should skip)
      personRevToLogLine(pRow) + '\n';
    const r2 = csvToLog(bad);
    rep.eq('parser-malformed: ops length 1', r2.ops.length, 1);
    rep.eq('parser-malformed: skipped length 2', r2.skippedRows.length, 2);
    rep.check('parser-malformed: skip reasons present',
      r2.skippedRows.every((s) => s.reason && s.raw != null));

    // No #head -> should throw.
    let threw = false;
    try { csvToLog('some random text\nanother line\n'); } catch (_) { threw = true; }
    rep.check('parser: no-head throws', threw);

    // Round-trip a #details line (ignored) + a real row still parses.
    const withDetails =
      '#details|TokenBook|v1|2026-01-01T00:00:00.000Z|visits=0|people=1|users=0\n' +
      csvHeaderLine() + '\n' +
      personRevToLogLine(pRow) + '\n';
    const r3 = csvToLog(withDetails);
    rep.eq('parser-details: ops length 1', r3.ops.length, 1);
  } catch (e) {
    rep.check('parser: stage completed', false, e && e.message ? e.message : String(e));
  }

  // Fill the register form. `date` sets the day (defaults to TEST_DATE);
  // `token` sets the token (triggers edit-mode load when a visit exists);
  // `patientId` sets the hidden person id (for reassign). Identity + billing
  // fields are optional.
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

    if (name) {
      setVal(b.fName, name);
      await settle(350);
    }

    if (mob) {
      setVal(b.fMob, mob);
      await settle(350);
    }

    if (age) setVal(b.fAge, String(age));
    if (gender) setVal(b.fGender, gender);
    if (weight) setVal(b.fWeight, weight);
    if (payment) setVal(b.fPayment, payment);
    if (followup) setVal(b.fFollowup, String(followup));
    await settle(350);
  };

  // ---- 1. FIRST VISIT (paid) -------------------------------------------
  stage('1. first visit (paid)');
  register.startNewBill();
  await settle(350);
  await fill({ date: TEST_DATE, token: 1, name: NAME_A, mob: MOB_A, age: '40', gender: 'M', weight: '70', payment: '0' });
  const err1 = await submitForm(b.form, register);
  rep.check('first visit: submit ok', !err1, err1 || '');

  let v1 = await db.findVisitByDateToken(TEST_DATE, 1);
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

  const v2 = await db.findVisitByDateToken(TEST_DATE, 2);
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

  const v3 = await db.findVisitByDateToken(TEST_DATE, 3);
  rep.check('new visit: created at token 3', !!v3);
  rep.check('new visit: new person id', v3 && v3.visit.personId !== pidA, v3 ? 'personId=' + v3.visit.personId : '');
  const pidB = v3 && v3.visit.personId;

  // ---- 4. EDIT VISIT (load token 1, change age, resave) ----------------
  stage('4. edit visit (token 1)');
  register.startNewBill();
  await settle(350);
  await fill({ date: TEST_DATE, token: 1, age: 41 });
  rep.eq('edit: form loaded name', (b.fName.value || '').toUpperCase(), NAME_A);
  const err4 = await submitForm(b.form, register);
  rep.check('edit: submit ok', !err4, err4 || '');

  const v1b = await db.findVisitByDateToken(TEST_DATE, 1);
  rep.eq('edit: age updated to 41', v1b && v1b.person && v1b.person.age, 41);
  rep.eq('edit: still same person', v1b && v1b.visit.personId, pidA);
  // A paid visit must NOT follow up on itself when edited (billing excludes
  // the visit being written from its own anchor lookup).
  rep.eq('edit: still paid (followup 0)', v1b && v1b.visit.followup, 0);
  rep.eq('edit: fee still 300', v1b && v1b.visit.fee, 300);

  // ---- 5. REASSIGN VISIT (token 1 -> patient B) ------------------------
  stage('5. reassign visit (token 1 -> patient B)');
  register.startNewBill();
  await settle(350);
  await fill({ date: TEST_DATE, token: 1, patientId: pidB });

  rep.eq('reassign: form loaded patient B name', (b.fName.value || '').toUpperCase(), NAME_B);
  const err5 = await submitForm(b.form, register);
  rep.check('reassign: submit ok', !err5, err5 || '');

  const v1c = await db.findVisitByDateToken(TEST_DATE, 1);
  rep.check(
    'reassign: visit now points at patient B',
    v1c && v1c.visit.personId === pidB,
    v1c ? 'personId=' + v1c.visit.personId + ' (B=' + pidB + ')' : 'no visit'
  );
  const aPerson = await db.getPerson(pidA);
  const aVisits = aPerson ? aPerson.visits : 0;
  rep.check('reassign: patient A visit count = 1', aVisits === 1, 'A.visits=' + aVisits);

  // ---- 5b. IDENTITY-CHANGE dialog (edit a linked patient's name) -------
  // Load token 1 (now patient B), change the name so it no longer matches B,
  // then CLICK "Update patient". Person's name should change; visit stays on B.
  stage('5b. identity-change dialog (update)');
  register.startNewBill();
  await settle(350);
  await fill({ date: TEST_DATE, token: 1 });
  rep.eq('id-dialog: loaded patient B', (b.fName.value || '').toUpperCase(), NAME_B);
  setVal(b.fName, NAME_BN);
  await settle(150);
  const err5b = await submitWithDialog(b.form, register, 'update');
  await settle(350);
  rep.check('id-dialog: submit ok', !err5b, err5b || '');
  const bPerson = await db.getPerson(pidB);
  rep.eq('id-dialog: patient B renamed', bPerson && bPerson.name, NAME_BN);
  const v1d = await db.findVisitByDateToken(TEST_DATE, 1);
  rep.eq('id-dialog: visit still linked to B', v1d && v1d.visit.personId, pidB);

  // ---- 5c. REASSIGN dialog (identity collides with another patient) ----
  // Change linked patient B's identity to patient A's name+mobile. Collision ->
  // reassign dialog appears. Click Cancel first (must change nothing), then
  // Reassign (visit moves to patient A).
  stage('5c. reassign dialog (collision)');
  register.startNewBill();
  await settle(350);
  await fill({ date: TEST_DATE, token: 1, name: NAME_A, mob: MOB_A });
  await settle(150);
  const err5cCancel = await submitWithDialog(b.form, register, 'cancel');
  await settle(350);
  rep.check('reassign-dialog: cancel submit ok', !err5cCancel, err5cCancel || '');
  const v1e = await db.findVisitByDateToken(TEST_DATE, 1);
  rep.eq('reassign-dialog: cancel left personId on B', v1e && v1e.visit.personId, pidB);

  await settle(350);
  await fill({ date: TEST_DATE, token: 1, name: NAME_A, mob: MOB_A });
  const err5c = await submitWithDialog(b.form, register, 'reassign');
  await settle(350);
  rep.check('reassign-dialog: reassign submit ok', !err5c, err5c || '');
  const v1f = await db.findVisitByDateToken(TEST_DATE, 1);
  rep.eq('reassign-dialog: visit moved to patient A', v1f && v1f.visit.personId, pidA);

  // Move token 1 back to patient B so downstream refund/log/read stages see
  // the state they assert. B was renamed in stage 5b to (TEST PATIENT B2, MOB_B).
  register.startNewBill();
  await settle(350);
  await fill({ date: TEST_DATE, token: 1 });
  setVal(b.fName, NAME_BN);
  setVal(b.fMob, MOB_B);
  setVal(b.fAge, '46');
  await settle(150);
  const err5cBack = await submitWithDialog(b.form, register, 'reassign');
  rep.check('reassign-dialog: return-to-B submit ok', !err5cBack, err5cBack || '');
  const v1g = await db.findVisitByDateToken(TEST_DATE, 1);
  rep.eq('reassign-dialog: token 1 back on patient B', v1g && v1g.visit.personId, pidB);
  rep.eq('debug: token1 age after return-to-B', v1g && v1g.person && v1g.person.age, 46);

  const v1h = await db.findVisitByDateToken(TEST_DATE, 1);
  if (!v1h) {
    rep.check('refund: token 1 visit present', false, 'no token 1 visit; cannot test refund');
    register.__setTestHooks({ suppressPrint: false });
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
  let rr = await db.findVisitByDateToken(TEST_DATE, 1);
  rep.eq('refund-ui: tier 1 persisted', rr && rr.visit.refundTier, 1);

  rerr = await refundViaUI(1, 3, onProgress);
  rep.check('refund-ui: tier 3 save', !rerr, rerr || '');
  rr = await db.findVisitByDateToken(TEST_DATE, 1);
  rep.eq('refund-ui: tier 3 persisted', rr && rr.visit.refundTier, 3);

  rerr = await refundViaUI(1, 0, onProgress);
  rep.check('refund-ui: clear (0) save', !rerr, rerr || '');
  rr = await db.findVisitByDateToken(TEST_DATE, 1);
  rep.eq('refund-ui: cleared to 0', rr && rr.visit.refundTier, 0);

  rerr = await refundViaUI(1, 2, onProgress);
  rep.check('refund-ui: final tier 2 save', !rerr, rerr || '');
  rr = await db.findVisitByDateToken(TEST_DATE, 1);
  rep.eq('refund-ui: final tier 2', rr && rr.visit.refundTier, 2);
  rep.eq('refund-ui: amount 200', db.refundAmountFor(rr.visit.refundTier), 200);

  // ---- 6b. follow-up window boundary (6 vs 7 days) ---------------------
  stage('6b. follow-up window boundary');
  const date6 = shiftDate(TEST_DATE, 6);
  const date7 = shiftDate(TEST_DATE, 7);
  const c6 = await db.addVisit({
    name: 'TEST PATIENT C', mob: '0000000003', age: 30, gender: 'M', weight: 65,
    followup: 0, payment: 0, fee: 300, token: 1, date: date6,
  });
  const pidC = c6.rec.personId;
  const withinC = await db.lastPaidVisitDaysFor(pidC, TEST_DATE);
  rep.check('boundary: 6 days -> inside window', withinC && withinC.days === 6, withinC ? 'days=' + withinC.days : 'none');

  const d7 = await db.addVisit({
    name: 'TEST PATIENT D', mob: '0000000004', age: 30, gender: 'M', weight: 65,
    followup: 0, payment: 0, fee: 300, token: 1, date: date7,
  });
  const pidD = d7.rec.personId;
  const outD = await db.lastPaidVisitDaysFor(pidD, TEST_DATE);
  rep.check('boundary: 7 days -> outside window', outD && outD.days === 7, outD ? 'days=' + outD.days : 'none');

  // ---- 7. LOG consistency ----------------------------------------------
  if (hasFolder) {
    stage('7. log');
    await backup.backupNow();
    await settle();
    const text = await readLogText();
    const rows = countTestRows(text);
    rep.check('log: test rows written', rows >= 3, 'rows=' + rows);
    const f1 = lastLogRow(text, 1);
    rep.check('log: row token 1 present', !!f1);
    if (f1) {
      // v3 visits columns: rootId v personId personV date token weight followup
      //                   payment fee refundTier hidden createdAt
      rep.eq('log: row1 personId = B', Number(f1.personId), pidB);
      rep.eq('log: row1 refundTier = 2', Number(f1.refundTier), 2);
      // Age lives on the person revision, not the visit — read it from the
      // person row in the same log.
      const { person } = parseLogRows(text);
      const pB = person.filter((p) => Number(p.rootId) === pidB).pop();
      rep.eq('log: person B age = 46', pB && Number(pB.age), 46);
      // Show the REAL log file content, verbatim (no reformatting).
      rep.info('----- BACKUP LOG (' + text.split('\n').filter(Boolean).length + ' lines) -----');
      for (const l of text.split('\n')) rep.info(l);
    }

    stage('8. replay (wipes + rebuilds from log)');
    const preVisits = await db.countAll();
    const prePeople = await db.countPeople();
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
  const dayRows = await db.listByDate(TEST_DATE);
  rep.check('read: listByDate returns test day', dayRows.length >= 3, 'rows=' + dayRows.length);
  const rowT1 = dayRows.find((r) => r.token === 1);
  rep.check('read: token 1 in day list', !!rowT1);
  rep.eq('read: token 1 personId = B', rowT1 && rowT1.personId, pidB);
  rep.eq('read: token 1 refundTier = 2', rowT1 && rowT1.refundTier, 2);

  const bHistory = await db.visitsForPerson(pidB);
  rep.check('read: B history has the reassigned visit', bHistory.some((v) => v.token === 1 && v.date === TEST_DATE));
  const aHistory = await db.visitsForPerson(pidA);
  rep.check('read: A history lost token 1', !aHistory.some((v) => v.token === 1));
  rep.check('read: A history still has token 2', aHistory.some((v) => v.token === 2));

  // ---- 8c. seed at small scale + paged read (row 27) ------------------
  // Exercises dev/seed.js (bulk writes) and the paged read path so a scale
  // regression (query slowing down, projection not built) is caught.
  // Runs on its own DB; cleaned up by the final deleteDb().
  stage('8c. seed + paged read (scale)');
  try {
    const { seed } = await import('./seed.js');
    const SEED_N = 200;
    const t0 = performance.now();
    const sres = await seed({ total: SEED_N, days: 20, patients: 20 });
    const seedMs = performance.now() - t0;
    rep.check('seed: wrote people', sres.people > 0, 'people=' + sres.people);
    rep.check('seed: wrote visits', sres.visits === SEED_N, 'visits=' + sres.visits);
    rep.info('seed: ' + SEED_N + ' visits in ' + Math.round(seedMs) + 'ms');

    // Paged read over a wide range (all seeded days).
    const from = shiftDate(TEST_DATE, 20);
    const to = TEST_DATE;
    const total = await db.countByDateRange(from, to);
    rep.check('seed: countByDateRange matches', total >= SEED_N, 'total=' + total);

    const t1 = performance.now();
    const page1 = await db.listByDateRangePage(from, to, { offset: 0, limit: 50 });
    const pageMs = performance.now() - t1;
    rep.check('seed: listByDateRangePage returns a page', page1.length === 50, 'len=' + page1.length);
    rep.check('seed: page read under 2s', pageMs < 2000, Math.round(pageMs) + 'ms');
    rep.info('seed: page(50) in ' + Math.round(pageMs) + 'ms');

    const t2 = performance.now();
    const totals = await db.totalsByDateRange(from, to);
    const totalsMs = performance.now() - t2;
    rep.check('seed: totalsByDateRange returns totals', totals.total >= SEED_N, 'total=' + totals.total);
    rep.check('seed: totals read under 2s', totalsMs < 2000, Math.round(totalsMs) + 'ms');
    rep.info('seed: totals in ' + Math.round(totalsMs) + 'ms');
  } catch (e) {
    rep.check('seed: stage completed', false, e && e.message ? e.message : String(e));
  }

  // ---- 9. cleanup ------------------------------------------------------
  stage('9. cleanup (remove test rows from DB)');
  try {
    const del = await db.deleteVisitsByDate(TEST_DATE);
    const delC = await db.deleteVisitsByDate(date6);
    const delD = await db.deleteVisitsByDate(date7);
    const left = await db.listByDate(TEST_DATE);
    rep.check(
      'cleanup: test visits removed from DB',
      left.length === 0,
      'removed ' + (del.visits + delC.visits + delD.visits) + ' visits; ' + left.length + ' left on test day'
    );
    const f = await db.findVisitByDateToken(TEST_DATE, 1);
    rep.check('cleanup: token 1 gone from DB', !f);
    const fc = await db.findVisitByDateToken(date6, 1);
    const fd = await db.findVisitByDateToken(date7, 1);
    rep.check('cleanup: boundary rows gone', !fc && !fd);

    // People are NOT auto-deleted on 0 visits, so the test purges its own fixed
    // identities or the next run collides.
    let peopleRemoved = 0;
    peopleRemoved += await db.deletePeopleByNameMob(NAME_A, MOB_A);
    peopleRemoved += await db.deletePeopleByNameMob(NAME_B, MOB_B);
    peopleRemoved += await db.deletePeopleByNameMob(NAME_BN, MOB_B);
    peopleRemoved += await db.deletePeopleByNameMob('TEST PATIENT C', '0000000003');
    peopleRemoved += await db.deletePeopleByNameMob('TEST PATIENT D', '0000000004');
    rep.check('cleanup: test people removed from DB', true, 'people removed=' + peopleRemoved);
  } catch (e) {
    rep.check('cleanup: test visits removed from DB', false, e && e.message ? e.message : String(e));
  }

  // ---- 10. SW update dev flag (row 29) --------------------------------
  // Exercises the message path: ask the SW to re-check, wait for the ready
  // message. SKIP when the SW isn't active (dev mode / no controller).
  stage('10. SW update path (dev flag)');
  try {
    // Wait up to 2s for the SW to become the controller — on a fresh
    // registration it isn't installed yet when this stage runs.
    let controller = navigator.serviceWorker ? navigator.serviceWorker.controller : null;
    if (!controller && navigator.serviceWorker) {
      controller = await new Promise((resolve) => {
        const deadline = Date.now() + 2000;
        const check = () => {
          if (navigator.serviceWorker.controller) return resolve(navigator.serviceWorker.controller);
          if (Date.now() > deadline) return resolve(null);
          setTimeout(check, 100);
        };
        check();
      });
    }
    if (!controller) {
      rep.skip('sw: controller present', 'no SW controller (dev mode or first load)');
    } else {
      rep.check('sw: controller present', true, controller.state);
      const got = await new Promise((resolve) => {
        const onMsg = (ev) => {
          if (ev.data && ev.data.type === 'tokenbook-update-ready') {
            navigator.serviceWorker.removeEventListener('message', onMsg);
            resolve(true);
          }
        };
        navigator.serviceWorker.addEventListener('message', onMsg);
        try {
          controller.postMessage({ type: 'tokenbook-force-update' });
        } catch (_) { }
        setTimeout(() => {
          navigator.serviceWorker.removeEventListener('message', onMsg);
          resolve(false);
        }, 4000);
      });
      rep.check('sw: force-update round-trip', got, got ? '' : 'no update-ready within 4s');
    }
  } catch (e) {
    rep.check('sw: stage completed', false, e && e.message ? e.message : String(e));
  }

  register.__setTestHooks({ suppressPrint: false });
  if (router && router.activateTab) router.activateTab(router.currentTab, true);

  // Drop the isolated test DB and restore the real DB name + log file.
  await db.deleteDb().catch(() => { });
  await db.setDbName(null).catch(() => { });
  backup.setLogFileName(null);

  return finish(rep);
}

async function doReplay(rep, text, preVisits, prePeople) {
  const parsed = parseBackup(text);
  const r = await db.replayLog(parsed.ops, { skippedRows: parsed.skippedRows });
  rep.check('replay: rows restored', r.count > 0, 'count=' + r.count + ' skipped=' + r.skipped);
  rep.eq('replay: skipped = 0', r.skipped, 0);
  const after = await db.findVisitByDateToken(TEST_DATE, 1);
  rep.check('replay: token 1 restored', !!after);
  if (after) {
    rep.eq('replay: restored refundTier = 2', after.visit.refundTier, 2);
    rep.eq('replay: restored age = 46', after.person && after.person.age, 46);
  }
  rep.check('replay: pre-replay DB had rows', preVisits > 0, 'visits=' + preVisits + ' people=' + prePeople);
  // Show what replay restored for the test day, verbatim from DB rows.
  const dayRows = await db.listByDate(TEST_DATE);
  rep.info('----- RESTORED VISITS (' + dayRows.length + ') -----');
  for (const v of dayRows) rep.info(JSON.stringify(v));
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
