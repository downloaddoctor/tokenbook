// IndexedDB wrapper for patient records. Backed by Dexie.
// DB: doctor-apt-list, v6. Two stores:
//   people  — one row per unique (name, mob) identity. keyPath id, autoIncrement.
//             unique index [name+mob]. Holds latest known age/gender. Used for
//             uniqueness enforcement and register autofill/search.
//             lastVisitAt: ISO of the most recent addVisit (undefined for rows
//             that predate v3 — not backfilled).
//   visits  — one row per token issued. keyPath id, autoIncrement. Denormalizes
//             name/mob/age/gender AS OF THAT VISIT (historical snapshot, so old
//             tokens still print/list correctly even if a person changes later).
//             Carries personId linking back to `people`.
// No legacy v1 store: app is not yet in production, so v1 `patients` is dropped.

import Dexie from 'https://unpkg.com/dexie@4.0.11/dist/modern/dexie.mjs';
import { localDay } from './day.js';
import { csvHeaderLine, visitInputToLogLine, normalizeRefundTier } from '../backup/csv.js';

const DB_NAME = 'doctor-apt-list';

const db = new Dexie(DB_NAME);
db.version(1).stores({
  // v6 adds people.visits (count of that person's visits). Maintained
  // incrementally by _writeVisit; read by visitCountsForPeople so the
  // Patients page doesn't scan the visits store per page. No backfill —
  // old rows read as undefined and fall back to a per-page visit scan.
  people: '++id, name, mob, [name+mob], updatedAt',
  visits: '++id, mob, createdAt, date, [date+token], personId',
});

// Shared open promise so concurrent callers get the same connection handle.
let _openPromise = null;
function openDb() {
  if (!_openPromise) _openPromise = db.open();
  return _openPromise;
}

function nextTokenForDate(date) {
  return db.visits
    .where('[date+token]')
    .between([date, Dexie.minKey], [date, Dexie.maxKey])
    .last()
    .then((v) => (v ? v.token + 1 : 1));
}

// Find the person by (name, mob); create if absent; refresh their stored age.
function findOrCreatePerson({ name, mob, age, gender }) {
  name = String(name).trim().toUpperCase();
  mob = String(mob).trim();
  const now = new Date().toISOString();
  gender = gender == null ? '' : String(gender).trim();
  return db.transaction('rw', db.people, async () => {
    const existing = await db.people.where('[name+mob]').equals([name, mob]).first();
    if (existing) {
      existing.age = age;
      if (gender) existing.gender = gender;
      existing.updatedAt = now;
      await db.people.put(existing);
      return existing;
    }
    const id = await db.people.add({ name, mob, age, gender, createdAt: now, updatedAt: now });
    return { id, name, mob, age, gender, createdAt: now, updatedAt: now };
  });
}

// Prefix search on mobile number for billing autofill, most recently seen first.
function searchPeopleByMob(prefix, limit = 8) {
  if (!prefix) return Promise.resolve([]);
  return db.people
    .where('mob')
    .startsWith(prefix)
    .reverse()
    .sortBy('updatedAt')
    .then((rows) => rows.slice(0, limit));
}

// Prefix search on name for billing autofill, most recently seen first.
function searchPeopleByName(prefix, limit = 8) {
  prefix = String(prefix || '').trim().toUpperCase();
  if (!prefix) return Promise.resolve([]);
  return db.people
    .where('name')
    .startsWith(prefix)
    .reverse()
    .sortBy('updatedAt')
    .then((rows) => rows.slice(0, limit));
}

// Upsert a visit, keyed on (date, token). `date` comes from the form's date
// (or today if blank). If a visit already exists at that (date, token), it is
// UPDATED in place (same id, createdAt preserved, updatedAt bumped); the
// person is reassigned to whoever the form now describes. Otherwise a new
// visit is inserted.
//
// Person identity resolution, in order:
//   1. personId given and found -> use it (update that person's fields).
//   2. no personId, (name, mob) matches -> reuse that person.
//   3. otherwise -> create a new person.
// In cases 1 and 2, if the update would make this person collide with a
// different person sharing (name, mob), throw — the unique index must hold.
//
// Returns { rec, created }: created=false means an existing visit was updated.
// Find the most recent visit for `personId` and return {visit, days} where
// days = calendar days between that visit's date and `date` (0 = same day).
// Used by the follow-up rule (window anchors on the last PAID visit).
async function _lastVisitDaysFor(personId, date) {
  if (!personId) return null;
  const rows = await db.visits.where('personId').equals(personId).toArray();
  if (!rows.length) return null;
  let best = null;
  for (const v of rows) {
    if (!best || (v.date || '') > (best.date || '')) best = v;
    else if ((v.date || '') === (best.date || '') && (v.token || 0) > (best.token || 0)) best = v;
  }
  if (!best) return null;
  return { visit: best, days: _daysBetween(best.date, date) };
}

// Whole-day difference between two 'YYYY-MM-DD' strings (b - a). Both must
// parse as local calendar dates; returns null on bad input.
function _daysBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(a + 'T00:00:00');
  const db2 = new Date(b + 'T00:00:00');
  if (isNaN(da) || isNaN(db2)) return null;
  return Math.round((db2 - da) / 86400000);
}

// Walk back through a person's visits (newest first) and return the last
// visit whose `followup` is falsy (i.e. a PAID visit). Returns {visit, days}
// where days = calendar days between that paid visit and `date`. If the most
// recent visit is within 6 days AND that paid visit is the anchor, the caller
// marks this visit as a follow-up.
async function _lastPaidVisitDaysFor(personId, date) {
  if (!personId) return null;
  const rows = await db.visits.where('personId').equals(personId).toArray();
  if (!rows.length) return null;
  rows.sort((a, b) => {
    const ad = a.date || '';
    const bd = b.date || '';
    if (ad !== bd) return bd.localeCompare(ad);
    return (b.token || 0) - (a.token || 0);
  });
  for (const v of rows) {
    if (!v.followup) return { visit: v, days: _daysBetween(v.date, date) };
  }
  return null;
}

// Compute fee + auto-followup for a candidate visit. Rules:
//   - explicit followup flag (0/1) wins for the followup bit
//   - if the patient had a PAID visit within the last 6 days (calendar),
//     followup is forced to 1 unless the caller passed followup=0 explicitly
//     AND no paid visit exists in the window
//   - fee = 0 when followup=1, else the given fee (default 300)
// Returns {followup, fee, anchoredOn: {visitId|null, days|null}}.
async function _resolveBilling({ personId, date, followup, fee }) {
  const baseFee = Number.isFinite(Number(fee)) && Number(fee) > 0 ? Number(fee) : 300;
  const explicit = followup === 0 || followup === 1 ? followup : null;
  let anchoredOn = null;
  let auto = false;
  if (explicit !== 0) {
    const last = await _lastPaidVisitDaysFor(personId, date);
    if (last && last.days != null && last.days >= 0 && last.days <= 6) {
      auto = true;
      anchoredOn = { visitId: last.visit.id, days: last.days, date: last.visit.date };
    }
  }
  const fu = explicit != null ? explicit : auto ? 1 : 0;
  const outFee = fu === 1 ? 0 : baseFee;
  return { followup: fu, fee: outFee, anchoredOn };
}

// Journal hook: backup.js registers a callback at boot. Every successful
// addVisit / setVisitRefund emits the INPUT it was called with (not the
// derived output), so restoring from the log replays through the same code
// path and re-derives identically. Keeps db.js free of any dependency on
// the backup module (no import cycle).
let _journal = null;
// Per-transaction journal buffers. Key = Dexie Transaction, value = entries.
// Entries are released on the transaction's 'complete' event and dropped on
// 'abort'/'error', so the backup log only ever records committed writes.
const _journalBuffers = new Map();
function setJournal(fn) {
  _journal = typeof fn === 'function' ? fn : null;
}

// Journal buffering: entries emitted during a Dexie transaction are held per
// transaction and released only on 'complete'. If the transaction aborts or
// errors, the buffer is dropped — a rolled-back write never reaches the log.
// Outside any transaction, entries flush immediately.
function _emitJournal(entry) {
  if (!_journal) return;
  const txn = Dexie.currentTransaction;
  if (txn) {
    const buf = _journalBuffers.get(txn);
    if (buf) {
      buf.push(entry);
      return;
    }
    const fresh = [entry];
    _journalBuffers.set(txn, fresh);
    const release = () => {
      _journalBuffers.delete(txn);
      for (const e of fresh) _deliverJournal(e);
    };
    const drop = () => _journalBuffers.delete(txn);
    try {
      txn.on('complete', release);
      txn.on('abort', drop);
      txn.on('error', drop);
    } catch {
      // Transaction already settled or not observable — deliver now.
      _journalBuffers.delete(txn);
      _deliverJournal(entry);
    }
    return;
  }
  _deliverJournal(entry);
}

function _deliverJournal(entry) {
  try {
    _journal(entry);
  } catch (e) {
    console.error('journal', e);
  }
}

// The ONLY public write entry point. Two modes:
//
//   live save (default): the form gives (name, mob, personId?, weight,
//     followup, payment, fee). addVisit resolves which person this visit
//     belongs to and derives followup/fee from that person's paid history.
//
//   restore (input.preserve set): every derived field is taken verbatim from
//     the backup row — personId, followup, fee, refundTier, createdAt,
//     updatedAt. No identity lookup, no billing scan. A person row is seeded
//     on first sight of each preserve.personId so _writeVisit's projection
//     helpers find it.
//
// Both modes funnel into _writeVisit — the single place that touches visits +
// the people projection. Save and restore cannot diverge.
function addVisit(input) {
  const { preserve } = input;
  let { name, mob, age, gender, token, date, personId, weight, followup, payment, fee, refundTier, createdAt, updatedAt } = input;
  // Normalize: blank/missing becomes null (so it never coerces to 0 or ''),
  // real values are trimmed/typed. Both the live and restore paths supply
  // full values; the null branch is defensive.
  name = name == null ? null : String(name).trim().toUpperCase();
  mob = mob == null ? null : String(mob).trim();
  age = age == null || age === '' ? null : Number(age);
  gender = gender == null ? null : String(gender).trim();
  token = Number(token);
  weight = weight == null || weight === '' ? null : Number(weight);
  if (weight != null && !Number.isFinite(weight)) weight = null;
  payment = payment === 0 || payment === 1 ? payment : payment === '1' ? 1 : 0;
  followup = followup === 0 || followup === 1 ? followup : followup == null ? null : Number(followup) ? 1 : 0;
  // refundTier is a non-negative integer N; amount = N * 100 (0 = none).
  refundTier = normalizeRefundTier(refundTier);
  const now = new Date();
  const nowIso = now.toISOString();
  date = date || localDay(now); // form's date drives the visit key
  personId = personId ? Number(personId) : null;

  return db.transaction('rw', db.people, db.visits, async () => {
    if (preserve) {
      // ---- restore path: trust the backup row -------------------------
      personId = preserve.personId != null ? Number(preserve.personId) : null;
      if (personId == null) {
        const e = new Error('Restore row missing personId.');
        e.name = 'MissingPersonIdError';
        throw e;
      }
      // Seed the person row on first sight; _writeVisit bumps it after.
      const exists = await db.people.get(personId);
      if (!exists) {
        await db.people.add({
          id: personId,
          name,
          mob,
          age,
          gender,
          weight: weight != null ? weight : undefined,
          visits: 0,
          createdAt: preserve.createdAt || nowIso,
          updatedAt: preserve.updatedAt || preserve.createdAt || nowIso,
        });
      }
      const rec = {
        name,
        mob,
        age,
        gender,
        weight,
        followup: preserve.followup != null ? preserve.followup : followup != null ? followup : 0,
        payment,
        fee: preserve.fee != null ? Number(preserve.fee) : fee == null ? 0 : Number(fee),
        refundTier: normalizeRefundTier(preserve.refundTier),
        token,
        date,
        createdAt: preserve.createdAt || nowIso,
        updatedAt: preserve.updatedAt || preserve.createdAt || nowIso,
        personId,
      };
      // Restore: never journal — replay must not append to the log it reads.
      return _writeVisit(rec, nowIso, false);
    }

    // ---- live save path: resolve identity + billing -------------------
    let person = null;
    if (personId) {
      person = await db.people.get(personId);
    }
    if (!person) {
      person = await db.people.where('[name+mob]').equals([name, mob]).first();
    }
    if (person) {
      // Guard: if the identity is changing, no other person may already hold
      // the target (name, mob) — the unique index would reject the put, but
      // we want a clearer message for the UI to surface.
      if (person.name !== name || person.mob !== mob) {
        const clash = await db.people.where('[name+mob]').equals([name, mob]).first();
        if (clash && clash.id !== person.id) {
          const e = new Error('Another patient already has this name + mobile.');
          e.name = 'DuplicateIdentityError';
          throw e;
        }
      }
      person.name = name;
      person.mob = mob;
      person.age = age;
      if (gender) person.gender = gender;
      if (weight != null) person.weight = weight;
      // updatedAt / lastVisitAt / visits are set by _writeVisit below, so a
      // visit that is later reassigned away doesn't stamp this person with a
      // visit they never keep.
      if (!Number.isFinite(person.visits)) person.visits = 0;
      await db.people.put(person);
      personId = person.id;
    } else {
      personId = await db.people.add({
        name,
        mob,
        age,
        gender,
        weight: weight != null ? weight : undefined,
        visits: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }

    // Resolve followup + fee AFTER personId is known (auto-followup needs the
    // person's prior paid-visit history).
    const billing = await _resolveBilling({ personId, date, followup, fee });
    followup = billing.followup;
    fee = billing.fee;

    const rec = {
      name,
      mob,
      age,
      gender,
      weight,
      followup,
      payment,
      fee,
      refundTier,
      token,
      date: createdAt || nowIso,
      updatedAt: updatedAt || createdAt || nowIso,
      personId,
    };
    // _writeVisit journals this write itself (log defaults to true).
    return _writeVisit(rec, nowIso);
  });
}

// THE write path. Takes a fully-formed visit record (all fields resolved by
// the caller) and:
//   1. upserts the visit on (date, token)
//   2. maintains the people projection (count, lastVisitAt, updatedAt,
//      orphan delete) via _bumpPersonOnGain / _touchPerson / _recomputePerson
//   3. emits one journal line (unless log=false) — the single place backup
//      learns about a committed write
// Must run inside the caller's rw transaction. Timestamps in `rec` are
// authoritative (a restore carries its own createdAt/updatedAt); `nowIso` is
// used only for row-touch bookkeeping (person.updatedAt).
// log=true (default): live add / refund edits — journal the row.
// log=false: restore/replay — never append to the log being read.
async function _writeVisit(rec, nowIso, log = true) {
  const { date, token, personId } = rec;
  const existing = await db.visits.where('[date+token]').equals([date, token]).first();
  let stored;
  let created;
  let prevPerson = null;

  if (existing) {
    const prevPersonId = existing.personId;
    const reassignedAway = prevPersonId != null && prevPersonId !== personId;
    const visitCreatedAt = rec.createdAt || existing.createdAt || nowIso;

    existing.name = rec.name;
    existing.mob = rec.mob;
    existing.age = rec.age;
    existing.gender = rec.gender;
    existing.weight = rec.weight;
    existing.followup = rec.followup;
    existing.payment = rec.payment;
    existing.fee = rec.fee;
    existing.refundTier = rec.refundTier != null ? rec.refundTier : existing.refundTier;
    existing.date = date;
    existing.personId = personId;
    if (rec.createdAt) existing.createdAt = rec.createdAt;
    existing.updatedAt = rec.updatedAt || nowIso;
    await db.visits.put(existing);
    stored = existing;
    created = false;

    if (reassignedAway) {
      await _recomputePerson(prevPersonId);
      prevPerson = await db.people.get(prevPersonId); // null if orphan-deleted
      await _bumpPersonOnGain(personId, rec, visitCreatedAt, nowIso);
    } else {
      await _touchPerson(personId, rec, visitCreatedAt, nowIso);
    }
  } else {
    stored = { ...rec };
    stored.id = await db.visits.add(stored);
    await _bumpPersonOnGain(personId, stored, stored.createdAt || nowIso, nowIso);
    created = true;
  }

  const person = await db.people.get(personId);
  // Journal lives HERE, behind the `log` flag: every committed write that
  // should be backed up emits exactly one full self-describing row. Restore
  // calls _writeVisit(..., log=false) so replay never re-appends the log it
  // is reading. This makes the flag the single source of truth for what gets
  // journaled, instead of the caller remembering to emit.
  // The stored row is handed over verbatim; it already uses `personId`,
  // the one key shared by the DB, the journal, and the log column.
  if (log) _emitJournal(stored);
  return { rec: stored, created, person, prevPerson };
}

// O(1) field bump when a person GAINS a visit (new visit, or a visit was
// reassigned TO them). `visitCreatedAt` is the newly-owned visit's own
// createdAt, which becomes lastVisitAt if it is newer than the current one
// (it almost always is — visits are created in order).
async function _bumpPersonOnGain(personId, rec, visitCreatedAt, nowIso) {
  const p = await db.people.get(personId);
  if (!p) return;
  p.visits = (Number.isFinite(p.visits) ? p.visits : 0) + 1;
  const isNewest = !p.lastVisitAt || (visitCreatedAt || '') > (p.lastVisitAt || '');
  if (isNewest) {
    p.lastVisitAt = visitCreatedAt;
    // The projection mirrors the person's NEWEST visit's identity snapshot.
    // Without this, restore would freeze the projection at the first visit.
    _applyIdentity(p, rec);
  }
  p.updatedAt = nowIso;
  await db.people.put(p);
}

// O(1) touch when a person's own visit was edited in place. lastVisitAt must
// NOT be bumped to now — it reflects when the patient actually came. Identity
// is refreshed only when the edited visit is still the person's newest.
async function _touchPerson(personId, rec, visitCreatedAt, nowIso) {
  const p = await db.people.get(personId);
  if (!p) return;
  const isNewest = !p.lastVisitAt || (visitCreatedAt || '') > (p.lastVisitAt || '');
  if (isNewest) _applyIdentity(p, rec);
  p.updatedAt = nowIso;
  await db.people.put(p);
}

// Mirror a visit's identity snapshot onto the person row. `name/mob/age/
// gender/weight` are the "latest known" values per schema; only called when
// the source visit is the person's newest.
function _applyIdentity(p, rec) {
  if (!p || !rec) return;
  p.name = String(rec.name || p.name || '').trim().toUpperCase();
  if (rec.mob != null) p.mob = rec.mob;
  if (rec.age != null) p.age = rec.age;
  if (rec.gender) p.gender = rec.gender;
  if (rec.weight != null) p.weight = rec.weight;
}

// Re-derive a person's projection from their current visits:
//   visits       = count of their visits
//   lastVisitAt  = max(createdAt) over those visits  <- "when the patient
//                  actually came", NOT when the row was touched
//   name/mob/age/gender/weight = snapshot of the newest visit
//   updatedAt    = now (row-touch timestamp; used only for sort)
// If the person has no visits left, the row is deleted (orphan).
// Must be called AFTER any visit write that could change who owns which
// visits, and it queries by the (already-updated) personId index.
async function _recomputePerson(personId) {
  const p = await db.people.get(personId);
  if (!p) return;
  const visits = await db.visits.where('personId').equals(personId).toArray();
  if (!visits.length) {
    await db.people.delete(personId);
    return;
  }
  let newest = visits[0];
  for (const v of visits) {
    if ((v.createdAt || '') > (newest.createdAt || '')) newest = v;
  }
  p.visits = visits.length;
  p.lastVisitAt = newest.createdAt || undefined;
  p.name = String(newest.name || p.name || '').trim().toUpperCase();
  p.mob = newest.mob != null ? newest.mob : p.mob;
  p.age = newest.age;
  if (newest.gender) p.gender = newest.gender;
  if (newest.weight != null) p.weight = newest.weight;
  p.updatedAt = new Date().toISOString();
  await db.people.put(p);
}

function listByDate(date) {
  return db.visits
    .where('[date+token]')
    .between([date, Dexie.minKey], [date, Dexie.maxKey])
    .toArray();
}

// Refund tier is a non-negative integer N; amount = N * 100 (0 = none).
// Wire decoding (including legacy R1/R2/R) lives in csv.js::normalizeRefundTier.
export const REFUND_TIER_STEP = 100;
export function refundAmountFor(tier) {
  return normalizeRefundTier(tier) * REFUND_TIER_STEP;
}

// Post-visit edit: set (or clear) the refund tier on a single visit. Pass
// 0 or null to clear. Fee is left untouched — see refundAmountFor().
// Routes through _writeVisit so a refund change is logged the same way an
// addVisit is (one append, one people projection touch).
async function setVisitRefund(visitId, tier, whenIso) {
  const t = normalizeRefundTier(tier);
  const nowIso = whenIso || new Date().toISOString();
  return db.transaction('rw', db.people, db.visits, async () => {
    const v = await db.visits.get(visitId);
    if (!v) throw new Error('Visit not found: ' + visitId);
    const rec = {
      name: v.name,
      mob: v.mob,
      age: v.age,
      gender: v.gender,
      weight: v.weight,
      followup: v.followup,
      payment: v.payment,
      fee: v.fee,
      refundTier: t,
      token: v.token,
      date: v.date,
      createdAt: v.createdAt,
      updatedAt: nowIso,
      personId: v.personId,
    };
    // _writeVisit journals this write itself. A refund is a FULL
    // self-describing row (same shape as a visit add), so replay has one code
    // path and never depends on an earlier line still being present.
    const result = await _writeVisit(rec, nowIso);
    return result.rec;
  });
}

// ---- people (patient registry) ----

// List unique patients, most recently SEEN first. Sorting by lastVisitAt
// (falling back to updatedAt) means restore preserves the operator-visible
// order, and a same-day edit that only touches updatedAt never re-orders the
// list under them.
function listPeople({ offset = 0, limit = 50 } = {}) {
  // Dexie's Collection.sortBy() only accepts a keyPath string/array, not a
  // comparator — so fetch all rows and sort in JS on the derived
  // lastVisitAt||updatedAt key.
  return db.people.toArray().then((rows) => {
    rows.sort((a, b) =>
      (b.lastVisitAt || b.updatedAt || '').localeCompare(a.lastVisitAt || a.updatedAt || '')
    );
    return rows.slice(offset, offset + limit);
  });
}

function countPeople() {
  return db.people.count();
}

function getPerson(id) {
  return db.people.get(id);
}

// Prefix search across name OR mob. Dedups by id. Returns up to `limit` people.
async function searchPeopleByPrefix(q, limit = 50) {
  q = String(q || '').trim();
  if (!q) return listPeople({ offset: 0, limit });
  const qUpper = q.toUpperCase();
  const byName = await db.people.where('name').startsWith(qUpper).limit(limit).toArray();
  const byMob = await db.people.where('mob').startsWith(q).limit(limit).toArray();
  const seen = new Set();
  const out = [];
  for (const p of [...byName, ...byMob]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return out.slice(0, limit);
}

// Number of visits per person, keyed by personId. Reads people.visits (v6+)
// so this is O(ids) instead of scanning the visits store. Falls back to a
// live count for any person whose counter is missing (pre-v6 rows).
async function visitCountsForPeople(ids) {
  const m = new Map();
  if (!ids || !ids.length) return m;
  const people = await db.people.bulkGet(ids);
  const missing = [];
  people.forEach((p, i) => {
    if (!p) return;
    if (Number.isFinite(p.visits)) m.set(p.id, p.visits);
    else missing.push(p.id);
  });
  if (missing.length) {
    const rows = await db.visits.where('personId').anyOf(missing).toArray();
    for (const r of rows) m.set(r.personId, (m.get(r.personId) || 0) + 1);
    // Ensure ids with zero visits are still present.
    for (const id of missing) if (!m.has(id)) m.set(id, 0);
  }
  return m;
}

// Full visit history for one person, newest first.
function visitsForPerson(personId) {
  return db.visits.where('personId').equals(personId).reverse().sortBy('createdAt');
}

// Look up a single visit by its identity (date, token), plus its person row.
// Returns { visit, person } or null when no visit exists at that key.
async function findVisitByDateToken(date, token) {
  const visit = await db.visits.where('[date+token]').equals([date, Number(token)]).first();
  if (!visit) return null;
  const person = visit.personId ? await db.people.get(visit.personId) : null;
  return { visit, person };
}

function listAll({ offset = 0, limit = 50 } = {}) {
  return db.visits.orderBy('createdAt').reverse().offset(offset).limit(limit).toArray();
}

function countAll() {
  return db.visits.count();
}

// Replay a logbook: wipe stores, then run every row through the SAME write
// path that produced it — addVisit({preserve}). The restore path calls
// _writeVisit with log=false, so replay never re-appends the log it reads
// (no journal silencing needed here).
//
// Correctness over speed: a large log can take a while, but the result is
// byte-identical to the live DB those writes would have produced.
async function replayLog(ops) {
  // Single rw transaction for the whole replay. Nested addVisit transactions
  // join this one, so the entire restore is one atomic commit — N
  // transactions collapse to 1, and a failure leaves nothing half-restored.
  return await db.transaction('rw', db.people, db.visits, async () => {
    await db.people.clear();
    await db.visits.clear();
    let n = 0;
    let skipped = 0;
    for (const op of ops) {
      // Defensive: csv.js already filters these, but a caller could hand us
      // a raw op list. Skip rather than abort the whole atomic restore —
      // one bad row must not cost every good row.
      if (op.personId == null || !op.date || !Number.isInteger(op.token) || op.token < 1) {
        skipped++;
        continue;
      }
      // One replay path: the log row carries the resolved personId plus
      // final billing fields and timestamps, so replay is a verbatim
      // restore — no identity lookup, no billing scan, ids preserved, O(N).
      await addVisit({
        name: op.name,
        mob: op.mob,
        age: op.age,
        gender: op.gender,
        weight: op.weight,
        payment: op.payment,
        token: op.token,
        date: op.date,
        personId: op.personId,
        preserve: {
          personId: op.personId,
          followup: op.followup,
          fee: op.fee,
          refundTier: op.refundTier,
          createdAt: op.createdAt,
          updatedAt: op.updatedAt,
        },
      });
      n++;
    }
    return { count: n, skipped };
  });
}

// Serialize the current DB as a fresh log (header + one full row per visit,
// refundTier included in-row). Used by downloadCsv when File System Access
// isn't available and by dev tooling. Not used by the append-only folder
// backup path — that one appends from the journal.
async function exportAll() {
  const [visits] = await Promise.all([db.visits.toArray()]);
  const lines = [csvHeaderLine()];
  const sorted = visits.slice().sort((a, b) => {
    if ((a.date || '') !== (b.date || '')) return (a.date || '').localeCompare(b.date || '');
    return (Number(a.token) || 0) - (Number(b.token) || 0);
  });
  let count = 0;
  for (const v of sorted) {
    lines.push(
      visitInputToLogLine({
        date: v.date || '',
        token: v.token,
        personId: v.personId,
        name: v.name,
        mob: v.mob,
        age: v.age,
        gender: v.gender,
        weight: v.weight,
        followup: v.followup,
        payment: v.payment,
        fee: v.fee,
        refundTier: v.refundTier,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      })
    );
    count++;
  }
  return { text: lines.join('\n') + '\n', count };
}

// Exported for dev seed + recovery tools; not part of the app's public surface.
export { db };

export const PatientDb = {
  openDb,
  localDay,
  nextTokenForDate,
  findOrCreatePerson,
  searchPeopleByMob,
  searchPeopleByName,
  addVisit,
  listByDate,
  listAll,
  countAll,
  listPeople,
  countPeople,
  getPerson,
  searchPeopleByPrefix,
  visitCountsForPeople,
  visitsForPerson,
  findVisitByDateToken,
  lastPaidVisitDaysFor: _lastPaidVisitDaysFor,
  daysBetween: _daysBetween,
  setVisitRefund,
  setJournal,
  replayLog,
  refundAmountFor,
  exportAll,
};
