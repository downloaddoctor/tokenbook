// Dev-only seed / clear. Generates realistic visit history so the Patients
// list, history modal, restore, and pagination can be exercised at scale.
//
// NOTE: this BULK-WRITES visits + the people projection directly, bypassing
// _writeVisit. That is deliberate — replaying 100k rows through the per-row
// write path takes minutes and gives no progress. The projection built here
// must therefore MATCH what _writeVisit produces:
//   people.visits       = count of that person's visits
//   people.lastVisitAt  = max(createdAt) over those visits
//   people.name/mob/age/gender/weight = snapshot of the NEWEST visit
//   people.createdAt    = min(createdAt) over those visits
//   people.updatedAt    = max(createdAt) over those visits (row-touch proxy)
// If _writeVisit's projection logic changes, update this file to match.
//
// Guarded by ?dev=1 at the call site (app.js). Do not import from prod pages.

import { db } from '../core/db.js';

const FIRST = [
  'Ramesh','Suresh','Mahesh','Rajesh','Naresh','Dinesh','Mukesh','Rakesh','Ganesh','Yogesh',
  'Priya','Anita','Sunita','Kavita','Rekha','Meena','Geeta','Seema','Neha','Pooja',
  'Arjun','Karan','Rohan','Rahul','Amit','Sumit','Nikhil','Vikram','Manish','Sandeep',
  'Deepa','Rani','Nisha','Ritu','Divya','Shreya','Tanya','Sneha','Aarti','Swati',
  'Farhan','Imran','Salman','Aamir','Zoya','Fatima','Ayesha','Sana','Rizwan','Arif',
];
const LAST = [
  'Kumar','Sharma','Patel','Singh','Gupta','Verma','Yadav','Joshi','Nair','Reddy',
  'Chauhan','Mehta','Shah','Desai','Iyer','Rao','Bansal','Mishra','Tiwari','Agarwal',
];
const GENDERS = ['M','M','M','F','F','F','O'];
const MOB_PREFIX = ['9','8','7','6'];

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
function localDayOf(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
// Random time-of-day within clinic hours (09:00 – 19:00), so createdAt has
// a plausible ordering within a day.
function atClinicHour(d) {
  const out = new Date(d);
  out.setHours(9 + randInt(10), randInt(60), randInt(60), 0);
  return out;
}

// Generate `total` visits across `days`, drawn from a pool of `patients`
// identities. Writes in chunks with an onProgress(written, total) callback so
// the UI can show a live counter. Bulk-writes final rows directly (not via
// addVisit) because replaying 100k rows through the per-row write path would
// take minutes; the projection is computed here to match what _writeVisit
// would have produced.
export async function seed({
  total = 100000,
  days = 366,
  patients = 30000,
  onProgress = null,
} = {}) {
  const t0 = Date.now();
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
    const day = localDayOf(d);
    for (let k = 0; k < perDay && rawVisits.length < total; k++) {
      const p = personList[randInt(personList.length)];
      const when = atClinicHour(d);
      const weight = Math.round((p._baseWeight + (Math.random() * 6 - 3)) * 10) / 10;
      rawVisits.push({
        _person: p,
        _offset: off,
        createdAt: isoAt(when),
        day,
        date: day,
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
      const followup = since != null && since >= 0 && since <= 6 ? 1 : 0;
      v.followup = followup;
      v.fee = followup ? 0 : 300;
      v.refundTier = !followup && randInt(20) === 0 ? 1 + randInt(3) : 0;
      if (!followup) lastPaidOffset = v._offset;
    }
  }

  // 4. global sort by createdAt, assign per-day token (1..N).
  rawVisits.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const perDayCount = new Map();
  for (const v of rawVisits) {
    const t = (perDayCount.get(v.day) || 0) + 1;
    perDayCount.set(v.day, t);
    v.token = t;
  }

  // 5. final visit rows.
  const idByPerson = new Map(personList.map((p) => [p, p.id]));
  const visits = rawVisits.map((v, i) => ({
    id: i + 1,
    name: v._person.name,
    mob: v._person.mob,
    age: v.age,
    gender: v._person.gender,
    weight: v.weight,
    followup: v.followup,
    payment: v.payment,
    fee: v.fee,
    refundTier: v.refundTier,
    token: v.token,
    day: v.day,
    date: v.date,
    createdAt: v.createdAt,
    updatedAt: v.createdAt,
    personId: idByPerson.get(v._person),
  }));

  // 6. people projection: visits count, lastVisitAt, newest identity.
  const proj = new Map();
  for (const p of personList) {
    proj.set(p.id, {
      id: p.id,
      name: p.name,
      mob: p.mob,
      age: p.age,
      gender: p.gender,
      weight: p.weight,
      visits: 0,
      lastVisitAt: null,
      createdAt: null,
      updatedAt: null,
    });
  }
  for (const v of visits) {
    const pr = proj.get(v.personId);
    if (!pr) continue;
    pr.visits++;
    if (!pr.lastVisitAt || v.createdAt > pr.lastVisitAt) {
      pr.lastVisitAt = v.createdAt;
      pr.name = v.name;
      pr.mob = v.mob;
      pr.age = v.age;
      pr.gender = v.gender;
      if (v.weight != null) pr.weight = v.weight;
    }
    if (!pr.createdAt || v.createdAt < pr.createdAt) pr.createdAt = v.createdAt;
    if (!pr.updatedAt || v.createdAt > pr.updatedAt) pr.updatedAt = v.createdAt;
  }
  const people = Array.from(proj.values()).filter((p) => p.visits > 0);

  // 7. write in chunks, reporting progress and yielding so the UI repaints.
  await db.transaction('rw', db.people, db.visits, async () => {
    await db.people.clear();
    await db.visits.clear();
  });

  const CHUNK = 5000;
  let written = 0;
  for (let i = 0; i < visits.length; i += CHUNK) {
    const slice = visits.slice(i, i + CHUNK);
    await db.visits.bulkPut(slice);
    written += slice.length;
    if (onProgress) onProgress(written, visits.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  await db.people.bulkPut(people);

  return { people: people.length, visits: visits.length, days, ms: Date.now() - t0 };
}

export async function clearAll() {
  await db.transaction('rw', db.people, db.visits, async () => {
    await db.people.clear();
    await db.visits.clear();
  });
}
