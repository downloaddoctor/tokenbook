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
function addVisit({ name, mob, age, gender, token, date, patId }) {
  name = String(name).trim().toUpperCase();
  mob = String(mob).trim();
  age = Number(age);
  gender = gender == null ? '' : String(gender).trim();
  token = Number(token);
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
      person.updatedAt = nowIso;
      person.lastVisitAt = nowIso;
      await db.people.put(person);
      personId = person.id;
    } else {
      personId = await db.people.add({
        name,
        mob,
        age,
        gender,
        createdAt: nowIso,
        updatedAt: nowIso,
        lastVisitAt: nowIso,
      });
    }

    // ---- visit upsert on (day, token) ----
    const existing = await db.visits.where('[day+token]').equals([day, token]).first();
    if (existing) {
      existing.name = name;
      existing.mob = mob;
      existing.age = age;
      existing.gender = gender;
      existing.date = day;
      existing.personId = personId;
      existing.updatedAt = nowIso;
      await db.visits.put(existing);
      return { rec: existing, created: false };
    }

    const rec = {
      name,
      mob,
      age,
      gender,
      token,
      day,
      date: day,
      createdAt: nowIso,
      updatedAt: nowIso,
      personId,
    };
    rec.id = await db.visits.add(rec);
    return { rec, created: true };
  });
}

function listByDay(day) {
  return db.visits
    .where('[day+token]')
    .between([day, Dexie.minKey], [day, Dexie.maxKey])
    .toArray();
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

// Number of visits per person, keyed by personId. Uses the personId index;
// one indexed read for the whole page of ids.
async function visitCountsForPeople(ids) {
  const m = new Map();
  if (!ids || !ids.length) return m;
  const rows = await db.visits.where('personId').anyOf(ids).toArray();
  for (const r of rows) m.set(r.personId, (m.get(r.personId) || 0) + 1);
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
    const groups = new Map(); // personId -> { first, last }
    for (const v of all) {
      if (v.personId == null) continue;
      const ts = v.createdAt || '';
      let g = groups.get(v.personId);
      if (!g) {
        groups.set(v.personId, { first: v, last: v });
        continue;
      }
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
      p.createdAt = g.first.createdAt || p.createdAt;
      p.updatedAt = g.last.createdAt || p.updatedAt;
      p.lastVisitAt = g.last.createdAt || p.lastVisitAt;
      await db.people.put(p);
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
  replaceAll,
  exportAll,
};
