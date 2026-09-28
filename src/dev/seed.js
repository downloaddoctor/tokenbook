// Dev-only seed / clear. Generates realistic visit history for Patients list,
// history modal, restore, and pagination at scale.
//
// BULK-WRITES revisions + projections directly, bypassing addVisit on purpose
// (replaying 100k rows through the per-row path takes minutes). v3 shape:
//   people / visits         — revision tables, one revision per root (v=1).
//   peopleProj / visitsProj — projections, one row per root.
// The seed generates ONE revision per entity. Because there are no edits in a
// seed, the projection is simply the same data with `visits`/`lastVisitAt`
// derived. If addVisit's projection logic changes, update this file to match.
//
// Guarded by ?dev=1 at the call site (app.js). Do not import from prod pages.

import { rawDb } from '../core/db.js';
import { isWithinFollowupWindow, defaultFee } from '../core/billing.js';
import { localDay } from '../core/day.js';

const FIRST = [
  'Ramesh', 'Suresh', 'Mahesh', 'Rajesh', 'Naresh', 'Dinesh', 'Mukesh', 'Rakesh', 'Ganesh', 'Yogesh',
  'Priya', 'Anita', 'Sunita', 'Kavita', 'Rekha', 'Meena', 'Geeta', 'Seema', 'Neha', 'Pooja',
  'Arjun', 'Karan', 'Rohan', 'Rahul', 'Amit', 'Sumit', 'Nikhil', 'Vikram', 'Manish', 'Sandeep',
  'Deepa', 'Rani', 'Nisha', 'Ritu', 'Divya', 'Shreya', 'Tanya', 'Sneha', 'Aarti', 'Swati',
  'Farhan', 'Imran', 'Salman', 'Aamir', 'Zoya', 'Fatima', 'Ayesha', 'Sana', 'Rizwan', 'Arif',
];
const LAST = [
  'Kumar', 'Sharma', 'Patel', 'Singh', 'Gupta', 'Verma', 'Yadav', 'Joshi', 'Nair', 'Reddy',
  'Chauhan', 'Mehta', 'Shah', 'Desai', 'Iyer', 'Rao', 'Bansal', 'Mishra', 'Tiwari', 'Agarwal',
];
const GENDERS = ['M', 'M', 'M', 'F', 'F', 'F', 'O'];
const MOB_PREFIX = ['9', '8', '7', '6'];

function randInt(n) {
  return Math.floor(Math.random() * n);
}
function pick(arr) {
  return arr[randInt(arr.length)];
}
function randMob() {
  let s = MOB_PREFIX[randInt(MOB_PREFIX.length)];
  for (let i = 0; i < 9; i++) s += String(randInt(10));
  return s;
}
function isoAt(date) {
  return date.toISOString();
}
function addDays(base, n) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}
// Random time within clinic hours (09:00–19:00), so createdAt has a plausible
// order within a day.
function atClinicHour(d) {
  const out = new Date(d);
  out.setHours(9 + randInt(10), randInt(60), randInt(60), 0);
  return out;
}

// Generate `total` visits across `days` from a pool of `patients` identities.
// Writes in chunks with an onProgress(written, total) callback. Bulk-writes
// final rows directly (not via addVisit) for speed; projection computed to
// match what _writeVisit would produce.
export async function seed({
  total = 10000,
  days = 200,
  patients = 500,
  onProgress = null,
} = {}) {
  const t0 = Date.now();
  // Quota pre-check: abort before a partial write if the origin is nearly full.
  // Estimate ~250 bytes/visit + ~200 bytes/person; require 1.5x headroom.
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      const need = (total * 250 + patients * 200) * 1.5;
      if (est.quota && est.quota - (est.usage || 0) < need) {
        const mb = (n) => (n / 1048576).toFixed(1);
        throw new Error(
          `Not enough storage for the seed. Need ~${mb(need)} MB, have ~${mb(
            est.quota - (est.usage || 0)
          )} MB free.`
        );
      }
    } catch (e) {
      if (e && /Not enough storage/.test(e.message)) throw e;
      // storage.estimate unavailable/blocked -> proceed (best effort).
    }
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 1. patient pool with explicit ids.
  const personList = [];
  const usedMob = new Set();
  for (let i = 0; i < patients; i++) {
    let mob;
    do {
      mob = randMob();
    } while (usedMob.has(mob));
    usedMob.add(mob);
    const name = (pick(FIRST) + ' ' + pick(LAST)).toUpperCase();
    const gender = pick(GENDERS);
    const baseAge = 1 + randInt(85);
    const baseWeight = 60 + Math.random() * 35;
    personList.push({
      _baseWeight: baseWeight,
      name,
      mob,
      age: baseAge,
      gender,
      weight: Math.round(baseWeight),
      id: i + 1,
    });
  }

  // 2. visits day by day until `total` reached.
  const perDay = Math.max(1, Math.ceil(total / days));
  const rawVisits = [];
  for (let off = 0; off < days && rawVisits.length < total; off++) {
    const d = addDays(today, -days + off);
    const date = localDay(d);
    for (let k = 0; k < perDay && rawVisits.length < total; k++) {
      const p = personList[randInt(personList.length)];
      const when = atClinicHour(d);
      const weight = Math.round((p._baseWeight + (Math.random() * 6 - 3)) * 10) / 10;
      rawVisits.push({
        _person: p,
        _offset: off,
        createdAt: isoAt(when),
        date,
        age: p.age,
        weight,
        payment: randInt(2),
      });
    }
  }

  // 3. per-patient chronology -> followup / fee / refund (6-day paid window).
  const byPerson = new Map();
  for (const v of rawVisits) {
    let arr = byPerson.get(v._person);
    if (!arr) {
      arr = [];
      byPerson.set(v._person, arr);
    }
    arr.push(v);
  }
  for (const [, arr] of byPerson) {
    arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let lastPaidOffset = null;
    for (const v of arr) {
      const since = lastPaidOffset == null ? null : v._offset - lastPaidOffset;
      const followup = isWithinFollowupWindow(since) ? 1 : 0;
      v.followup = followup;
      v.fee = followup ? 0 : defaultFee();
      v.refundTier = !followup && randInt(20) === 0 ? 1 + randInt(3) : 0;
      if (!followup) lastPaidOffset = v._offset;
    }
  }

  // 4. global sort by createdAt, assign per-day token (1..N).
  rawVisits.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const perDayCount = new Map();
  for (const v of rawVisits) {
    const t = (perDayCount.get(v.date) || 0) + 1;
    perDayCount.set(v.date, t);
    v.token = t;
  }

  // 5. final visit rows. v3: visits carry NO identity; only the revision fields
  // and a personV pointer (always 1 in seed — one revision per person).
  const idByPerson = new Map(personList.map((p) => [p, p.id]));
  const visits = rawVisits.map((v, i) => ({
    rootId: i + 1,
    v: 1,
    personId: idByPerson.get(v._person),
    personV: 1,
    date: v.date,
    token: v.token,
    weight: v.weight,
    followup: v.followup,
    payment: v.payment,
    fee: v.fee,
    refundTier: v.refundTier,
    hidden: 0,
    createdAt: v.createdAt,
    revAt: v.createdAt,
  }));

  // 6a. people revision rows. v3: one revision per person (v=1). Identity lives
  // here; visits only point at it via (personId, personV).
  // revAt = the seed write time (NEVER the visit's createdAt — that is a fixed
  // per-visit value and would collapse activity ordering).
  const seededAt = new Date().toISOString();
  const peopleRevs = personList.map((p) => ({
    rootId: p.id,
    v: 1,
    name: p.name,
    mob: p.mob,
    age: p.age,
    gender: p.gender,
    weight: p.weight,
    hidden: 0,
    createdAt: visits.find((v) => v.personId === p.id)?.createdAt || seededAt,
    revAt: seededAt,
    userId: null,
    userV: null,
  }));

  // 6b. people projection: one row per rootId with visit count + lastVisitAt.
  const proj = new Map();
  for (const p of personList) {
    proj.set(p.id, {
      rootId: p.id,
      v: 1,
      name: p.name,
      mob: p.mob,
      age: p.age,
      gender: p.gender,
      weight: p.weight,
      visits: 0,
      lastVisitAt: null,
      hidden: 0,
      updatedAt: null,
    });
  }
  for (const v of visits) {
    const pr = proj.get(v.personId);
    if (!pr) continue;
    pr.visits++;
    if (!pr.lastVisitAt || v.createdAt > pr.lastVisitAt) pr.lastVisitAt = v.createdAt;
    if (!pr.updatedAt || v.createdAt > pr.updatedAt) pr.updatedAt = v.createdAt;
  }
  const peopleProj = Array.from(proj.values()).filter((p) => p.visits > 0);
  // Keep the person revision set in sync: drop revisions for people with no
  // visits, so people/peopleProj have the same rootId set.
  const keep = new Set(peopleProj.map((p) => p.rootId));
  const keptPeopleRevs = peopleRevs.filter((p) => keep.has(p.rootId));

  // 6c. visits projection: one row per visit rootId (v=1 in seed).
  const visitsProj = visits.map((v) => ({
    rootId: v.rootId,
    v: 1,
    personId: v.personId,
    personV: 1,
    date: v.date,
    token: v.token,
    weight: v.weight,
    followup: v.followup,
    payment: v.payment,
    fee: v.fee,
    refundTier: v.refundTier,
    hidden: 0,
    createdAt: v.createdAt,
    updatedAt: v.createdAt,
  }));

  // 7. write in chunks, reporting progress and yielding so the UI repaints.
  const raw = rawDb();
  await raw.transaction(
    'rw',
    raw.people,
    raw.peopleProj,
    raw.visits,
    raw.visitsProj,
    async () => {
      await raw.people.clear();
      await raw.peopleProj.clear();
      await raw.visits.clear();
      await raw.visitsProj.clear();
    }
  );

  await raw.people.bulkPut(keptPeopleRevs);
  await raw.peopleProj.bulkPut(peopleProj);

  // Row-chunk sized for ~100 progress steps (≈1% each), with a floor so tiny
  // seeds still show a few steps and huge seeds don't thrash (max 2000/chunk).
  // A 0ms yield between chunks lets the statusbar repaint.
  const CHUNK = Math.max(1, Math.min(2000, Math.ceil(visits.length / 100)));
  let written = 0;
  for (let i = 0; i < visits.length; i += CHUNK) {
    const slice = visits.slice(i, i + CHUNK);
    const sliceProj = visitsProj.slice(i, i + CHUNK);
    await raw.visits.bulkPut(slice);
    await raw.visitsProj.bulkPut(sliceProj);
    written += slice.length;
    if (onProgress) onProgress(written, visits.length);
    await new Promise((r) => setTimeout(r, 0));
  }

  return { people: peopleProj.length, visits: visits.length, days, ms: Date.now() - t0 };
}

export async function clearAll() {
  const raw = rawDb();
  await raw.transaction(
    'rw',
    raw.people,
    raw.peopleProj,
    raw.visits,
    raw.visitsProj,
    async () => {
      await raw.people.clear();
      await raw.peopleProj.clear();
      await raw.visits.clear();
      await raw.visitsProj.clear();
    }
  );
}

// Defaults for seed(); blank/cancelled prompt keeps the default per field.
// Kept here so the UI layer stays free of seeding policy.
export const SEED_CONFIG = { total: 10000, days: 200, patients: 500 };

// Prompt for seed size. Blank/non-numeric keeps the default. Returns null if
// the user cancels any prompt.
export function promptSeedConfig() {
  const ask = (label, def) => {
    const raw = window.prompt(`${label} (default ${def})`, String(def));
    if (raw === null) return null; // cancelled
    const s = raw.trim();
    if (s === '') return def;
    const n = Math.floor(Number(s));
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const total = ask('Visits to generate', SEED_CONFIG.total);
  if (total === null) return null;
  const days = ask('Days of history', SEED_CONFIG.days);
  if (days === null) return null;
  const patients = ask('Patient pool size', SEED_CONFIG.patients);
  if (patients === null) return null;
  return { total, days, patients };
}
