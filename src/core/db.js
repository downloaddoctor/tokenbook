// IndexedDB wrapper for patient records. Backed by Dexie.
// DB: doctor-apt-list, v3. Two stores:
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

const DB_NAME = 'doctor-apt-list';

const db = new Dexie(DB_NAME);
db.version(2).stores({
  people: '++id, name, mob, [name+mob], updatedAt',
  visits: '++id, mob, createdAt, day, [day+token], personId',
});
db.version(3).stores({
  // Schema is identical to v2; v3 only adds the lastVisitAt field. No index
  // change, no backfill — existing rows keep lastVisitAt undefined until their
  // next visit.
  people: '++id, name, mob, [name+mob], updatedAt',
  visits: '++id, mob, createdAt, day, [day+token], personId',
});
db.version(4).stores({
  // v4 adds billing fields on visits (weight, followup, payment, fee) and
  // people.weight. No new indexes, no backfill — old rows keep these
  // undefined until the next visit.
  people: '++id, name, mob, [name+mob], updatedAt',
  visits: '++id, mob, createdAt, day, [day+token], personId',
});
db.version(5).stores({
  // v5 adds visits.refundTier ('0'|'R1'|'R2'|'R'). Post-visit edit set from
  // the Tokens page; fee stays as originally charged. No backfill — old
  // rows read as undefined (= no refund).
  people: '++id, name, mob, [name+mob], updatedAt',
  visits: '++id, mob, createdAt, day, [day+token], personId',
});
db.version(6).stores({
  // v6 adds people.visits (count of that person's visits). Maintained by
  // addVisit + rebuildPeopleFromVisits; read by visitCountsForPeople so the
  // Patients page doesn't scan the visits store per page. No backfill — old
  // rows read as undefined; use rebuildPeopleFromVisits() to populate.
  people: '++id, name, mob, [name+mob], updatedAt',
  visits: '++id, mob, createdAt, day, [day+token], personId',
});

let _openPromise = null;
function openDb() {
  if (!_openPromise) _openPromise = db.open();
  return _openPromise;
}

function nextTokenForDay(day) {
  return db.visits
    .where('[day+token]')
    .between([day, Dexie.minKey], [day, Dexie.maxKey])
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

// Upsert a visit, keyed on (day, token). `day` comes from the form's date
// (or today if blank). If a visit already exists at that (day, token), it is
// UPDATED in place (same id, createdAt preserved, updatedAt bumped); the
// person is reassigned to whoever the form now describes. Otherwise a new
// visit is inserted.
//
// Person identity resolution, in order:
//   1. patId given and found -> use it (update that person's fields).
//   2. no patId, (name, mob) matches -> reuse that person.
//   3. otherwise -> create a new person.
// In cases 1 and 2, if the update would make this person collide with a
// different person sharing (name, mob), throw — the unique index must hold.
//
// Returns { rec, created }: created=false means an existing visit was updated.
// Find the most recent visit for `personId` and return {visit, days} where
// days = calendar days between that visit's day and `day` (0 = same day).
// Used by the follow-up rule (window anchors on the last PAID visit).
async function _lastVisitDaysFor(personId, day) {
  if (!personId) return null;
  const rows = await db.visits.where('personId').equals(personId).toArray();
  if (!rows.length) return null;
  let best = null;
  for (const v of rows) {
    if (!best || (v.day || '') > (best.day || '')) best = v;
    else if ((v.day || '') === (best.day || '') && (v.token || 0) > (best.token || 0)) best = v;
  }
  if (!best) return null;
  return { visit: best, days: _daysBetween(best.day, day) };
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
// where days = calendar days between that paid visit and `day`. If the most
// recent visit is within 6 days AND that paid visit is the anchor, the caller
// marks this visit as a follow-up.
async function _lastPaidVisitDaysFor(personId, day) {
  if (!personId) return null;
  const rows = await db.visits.where('personId').equals(personId).toArray();
  if (!rows.length) return null;
  rows.sort((a, b) => {
    const ad = a.day || '';
    const bd = b.day || '';
    if (ad !== bd) return bd.localeCompare(ad);
    return (b.token || 0) - (a.token || 0);
  });
  for (const v of rows) {
    if (!v.followup) return { visit: v, days: _daysBetween(v.day, day) };
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
async function _resolveBilling({ personId, day, followup, fee }) {
  const baseFee = Number.isFinite(Number(fee)) && Number(fee) > 0 ? Number(fee) : 300;
  const explicit = followup === 0 || followup === 1 ? followup : null;
  let anchoredOn = null;
  let auto = false;
  if (explicit !== 0) {
    const last = await _lastPaidVisitDaysFor(personId, day);
    if (last && last.days != null && last.days >= 0 && last.days <= 6) {
      auto = true;
      anchoredOn = { visitId: last.visit.id, days: last.days, day: last.visit.day };
    }
  }
  const fu = explicit != null ? explicit : auto ? 1 : 0;
  const outFee = fu === 1 ? 0 : baseFee;
  return { followup: fu, fee: outFee, anchoredOn };
}

function addVisit({ name, mob, age, gender, token, date, patId, weight, followup, payment, fee }) {
  name = String(name).trim().toUpperCase();
  mob = String(mob).trim();
  age = Number(age);
  gender = gender == null ? '' : String(gender).trim();
  token = Number(token);
  weight = weight == null || weight === '' ? null : Number(weight);
  if (weight != null && !Number.isFinite(weight)) weight = null;
  payment = payment === 0 || payment === 1 ? payment : 0;
  followup = followup === 0 || followup === 1 ? followup : null;
  const now = new Date();
  const nowIso = now.toISOString();
  const day = date || localDay(now); // form's date drives the visit key
  patId = patId ? Number(patId) : null;

  return db.transaction('rw', db.people, db.visits, async () => {
    let person = null;

    if (patId) {
      person = await db.people.get(patId);
    }
    if (!person) {
      person = await db.people.where('[name+mob]').equals([name, mob]).first();
    }

    let personId;
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
      // updatedAt / lastVisitAt / visits are set by the visit-write paths
      // below, so a visit that is later reassigned away doesn't stamp this
      // person with a visit they never keep.
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
    const billing = await _resolveBilling({ personId, day, followup, fee });
    followup = billing.followup;
    fee = billing.fee;

    // ---- visit upsert on (day, token) ----
    // The people projection (visits count, lastVisitAt, updatedAt) is
    // maintained INCREMENTALLY here. Only the reassign-away branch needs to
    // scan the old owner's visits — every other case is O(1).
    const existing = await db.visits.where('[day+token]').equals([day, token]).first();
    if (existing) {
      const prevPersonId = existing.personId;
      const reassignedAway = prevPersonId != null && prevPersonId !== personId;

      // Snapshot the visit's own createdAt before overwriting (used below to
      // stamp the new owner's lastVisitAt when this visit moves people).
      const visitCreatedAt = existing.createdAt || nowIso;

      existing.name = name;
      existing.mob = mob;
      existing.age = age;
      existing.gender = gender;
      existing.weight = weight;
      existing.followup = followup;
      existing.payment = payment;
      existing.fee = fee;
      existing.date = day;
      existing.personId = personId;
      existing.updatedAt = nowIso;
      await db.visits.put(existing);

      if (reassignedAway) {
        // Old owner loses this visit: rescan only them (may become orphan).
        await _recomputePerson(prevPersonId);
        // New owner gains this visit: O(1) bump with this visit's createdAt.
        await _bumpPersonOnGain(personId, visitCreatedAt, nowIso);
      } else {
        // Same-person edit: nothing about the set changed. Bump updatedAt
        // only; lastVisitAt stays at the visit's createdAt.
        await _touchPerson(personId, nowIso);
      }
      return { rec: existing, created: false };
    }

    const rec = {
      name,
      mob,
      age,
      gender,
      weight,
      followup,
      payment,
      fee,
      token,
      day,
      date: day,
      createdAt: nowIso,
      updatedAt: nowIso,
      personId,
    };
    rec.id = await db.visits.add(rec);
    // Brand-new visit: O(1) bump with the new visit's createdAt (= now).
    await _bumpPersonOnGain(personId, nowIso, nowIso);
    return { rec, created: true };
  });
}

// O(1) field bump when a person GAINS a visit (new visit, or a visit was
// reassigned TO them). `visitCreatedAt` is the newly-owned visit's own
// createdAt, which becomes lastVisitAt if it is newer than the current one
// (it almost always is — visits are created in order).
async function _bumpPersonOnGain(personId, visitCreatedAt, nowIso) {
  const p = await db.people.get(personId);
  if (!p) return;
  p.visits = (Number.isFinite(p.visits) ? p.visits : 0) + 1;
  if (!p.lastVisitAt || (visitCreatedAt || '') > (p.lastVisitAt || '')) {
    p.lastVisitAt = visitCreatedAt;
  }
  p.updatedAt = nowIso;
  await db.people.put(p);
}

// O(1) touch when a person's own visit was edited in place: nothing about
// the visit set changed, so only updatedAt moves. lastVisitAt must NOT be
// bumped to now — it reflects when the patient actually came.
async function _touchPerson(personId, nowIso) {
  const p = await db.people.get(personId);
  if (!p) return;
  p.updatedAt = nowIso;
  await db.people.put(p);
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

function listByDay(day) {
  return db.visits
    .where('[day+token]')
    .between([day, Dexie.minKey], [day, Dexie.maxKey])
    .toArray();
}

// Refund tiers — amount is derived from the tier and NOT stored on the visit.
// Fee stays at what was originally charged; refundAmount is computed on read.
export const REFUND_TIERS = { '0': 0, R1: 100, R2: 200, R: 300 };
export function refundAmountFor(tier) {
  return REFUND_TIERS[String(tier || '0')] || 0;
}

// Post-visit edit: set (or clear) the refund tier on a single visit. Pass
// '0' or null to clear. Fee is left untouched — see refundAmountFor().
async function setVisitRefund(visitId, tier) {
  const t = tier == null || tier === 0 || tier === '0' ? '0' : String(tier);
  if (!(t in REFUND_TIERS)) {
    const e = new Error('Unknown refund tier: ' + tier);
    e.name = 'InvalidRefundTierError';
    throw e;
  }
  const nowIso = new Date().toISOString();
  return db.transaction('rw', db.visits, async () => {
    const v = await db.visits.get(visitId);
    if (!v) throw new Error('Visit not found: ' + visitId);
    v.refundTier = t;
    v.updatedAt = nowIso;
    await db.visits.put(v);
    return v;
  });
}

// ---- people (patient registry) ----

// List unique patients, most recently seen first. `updatedAt` is bumped by
// addVisit every time that person gets a new visit, so it doubles as
// "last seen at".
function listPeople({ offset = 0, limit = 50 } = {}) {
  return db.people.orderBy('updatedAt').reverse().offset(offset).limit(limit).toArray();
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

// Look up a single visit by its identity (day, token), plus its person row.
// Returns { visit, person } or null when no visit exists at that key.
async function findVisitByDayToken(day, token) {
  const visit = await db.visits.where('[day+token]').equals([day, Number(token)]).first();
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

// Derive `people` from `visits`. This is the invariant: visits are the
// source of truth; a person row is a projection of their visit stream.
//   - createdAt    = earliest visit's createdAt
//   - name/mob     = latest visit's name/mob
//   - age/gender   = latest visit's age/gender
//   - updatedAt    = latest visit's createdAt
//   - lastVisitAt  = latest visit's createdAt
// Called after a bulk restore so the rebuilt table is consistent regardless
// of what the backup file claimed. Runs inside its own rw transaction.
async function rebuildPeopleFromVisits() {
  return db.transaction('rw', db.people, db.visits, async () => {
    const all = await db.visits.toArray();
    const groups = new Map(); // personId -> { first, last, count }
    for (const v of all) {
      if (v.personId == null) continue;
      const ts = v.createdAt || '';
      let g = groups.get(v.personId);
      if (!g) {
        groups.set(v.personId, { first: v, last: v, count: 1 });
        continue;
      }
      g.count++;
      if (ts < (g.first.createdAt || '')) g.first = v;
      if (ts > (g.last.createdAt || '')) g.last = v;
    }
    for (const [pid, g] of groups) {
      const p = await db.people.get(pid);
      if (!p) continue;
      p.name = String(g.last.name || p.name || '').trim().toUpperCase();
      p.mob = g.last.mob != null ? g.last.mob : p.mob;
      p.age = g.last.age;
      if (g.last.gender) p.gender = g.last.gender;
      if (g.last.weight != null) p.weight = g.last.weight;
      p.createdAt = g.first.createdAt || p.createdAt;
      p.updatedAt = g.last.createdAt || p.updatedAt;
      p.lastVisitAt = g.last.createdAt || p.lastVisitAt;
      p.visits = g.count;
      await db.people.put(p);
    }
    // Any person with no visits left in the visits store gets counter 0.
    const allPeople = await db.people.toArray();
    for (const p of allPeople) {
      if (!groups.has(p.id)) {
        p.visits = 0;
        await db.people.put(p);
      }
    }
  });
}

// Full restore. Accepts either the current export shape ({version:2, people,
// visits}) or a v1 export ({version:1, records}) for backward compatibility.
// `people` is rebuilt from `visits` afterwards, so person-side fields always
// match the visit stream (regardless of what the file carried).
async function replaceAll(data) {
  const isV1 = !data.version || data.version === 1;
  let { people, visits } = isV1
    ? synthesizePeopleFromLegacyRecords(data.records || [])
    : { people: data.people || [], visits: data.visits || [] };
  // Normalize stored names to uppercase (import may carry mixed case from
  // older CSVs / hand-edited exports).
  people = people.map((p) => ({ ...p, name: String(p.name || '').trim().toUpperCase() }));
  visits = visits.map((v) => ({ ...v, name: String(v.name || '').trim().toUpperCase() }));

  const n = await db.transaction('rw', db.people, db.visits, async () => {
    await db.people.clear();
    await db.visits.clear();
    if (people.length) await db.people.bulkPut(people);
    if (visits.length) await db.visits.bulkPut(visits);
    return visits.length;
  });
  // Project people from the visit stream so derived fields (lastVisitAt,
  // updatedAt, age, gender) are always consistent with the visits.
  await rebuildPeopleFromVisits();
  return n;
}

function synthesizePeopleFromLegacyRecords(records) {
  const people = [];
  const byKey = new Map();
  const visits = records.map((r) => {
    const name = String(r.name || '').trim().toUpperCase();
    const mob = String(r.mob || '').trim();
    const age = Number(r.age);
    const gender = r.gender == null ? '' : String(r.gender).trim();
    const key = name + '\u0000' + mob;
    let person = byKey.get(key);
    if (!person) {
      person = {
        id: people.length + 1,
        name,
        mob,
        age,
        gender,
        createdAt: r.createdAt || new Date().toISOString(),
        updatedAt: r.createdAt || new Date().toISOString(),
      };
      byKey.set(key, person);
      people.push(person);
    } else {
      person.age = age;
      if (gender) person.gender = gender;
      person.updatedAt = r.createdAt || person.updatedAt;
    }
    return {
      id: typeof r.id === 'number' ? r.id : undefined,
      name,
      mob,
      age,
      gender,
      token: Number(r.token),
      day: r.day,
      date: r.date || r.day,
      createdAt: r.createdAt || new Date().toISOString(),
      personId: person.id,
    };
  });
  return { people, visits };
}

async function exportAll() {
  const [people, visits] = await Promise.all([db.people.toArray(), db.visits.toArray()]);
  return {
    schema: 'doctor-apt-list/patients',
    version: 2,
    exportedAt: new Date().toISOString(),
    count: visits.length,
    people,
    visits,
  };
}

// Exported for dev seed + recovery tools; not part of the app's public surface.
export { db };

export const PatientDb = {
  openDb,
  localDay,
  nextTokenForDay,
  findOrCreatePerson,
  searchPeopleByMob,
  searchPeopleByName,
  addVisit,
  listByDay,
  listAll,
  countAll,
  listPeople,
  countPeople,
  getPerson,
  searchPeopleByPrefix,
  visitCountsForPeople,
  visitsForPerson,
  findVisitByDayToken,
  rebuildPeopleFromVisits,
  lastPaidVisitDaysFor: _lastPaidVisitDaysFor,
  daysBetween: _daysBetween,
  setVisitRefund,
  REFUND_TIERS,
  refundAmountFor,
  replaceAll,
  exportAll,
};
