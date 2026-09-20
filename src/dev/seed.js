// Dev-only seed / clear. Generates realistic visit history so the Patients
// list, history modal, restore, and pagination can be exercised.
//
// Invariant: visits are the source of truth. This writes visits directly,
// then calls rebuildPeopleFromVisits() to project the people table — exactly
// the same path a restore takes.
//
// Guarded by ?dev=1 at the call site (app.js). Do not import from prod pages.

import { db, PatientDb } from '../core/db.js';

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

// Build the seed in memory: N patients, each with a random visit history
// over the last `days` days. Then sort globally, assign tokens per day, and
// bulk-write visits + people in one transaction.
export async function seed({ days = 60, patients = 500, maxVisitsPer = 15 } = {}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 1. patients
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
    const createdAt = addDays(today, -days);

    personList.push({
      name,
      mob,
      age: baseAge,
      gender,
      createdAt: isoAt(createdAt),
      updatedAt: isoAt(createdAt),
      lastVisitAt: isoAt(createdAt),
    });
  }

  // 2. visits: each patient gets 1..maxVisitsPer visits over the range.
  //    Age ticks up across their own visits so history looks real.
  const rawVisits = [];
  for (const p of personList) {
    const count = 1 + randInt(maxVisitsPer);
    const dayOffsets = new Set();
    while (dayOffsets.size < count) dayOffsets.add(randInt(days));
    const offsets = [...dayOffsets].sort((a, b) => a - b); // oldest -> newest
    offsets.forEach((offset, idx) => {
      const d = atClinicHour(addDays(today, -days + offset));
      rawVisits.push({
        _person: p,
        createdAt: isoAt(d),
        day: localDayOf(d),
        date: localDayOf(d),
        // age increases roughly one year per 365 days of history; for a
        // 60-day window, mostly constant, occasionally +1
        age: p.age + Math.floor(offset / 365) + (idx > 0 && randInt(10) === 0 ? 1 : 0),
      });
    });
  }

  // 3. sort globally by createdAt, assign per-day token (1..N).
  rawVisits.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const perDay = new Map();
  for (const v of rawVisits) {
    const t = (perDay.get(v.day) || 0) + 1;
    perDay.set(v.day, t);
    v.token = t;
  }

  // 4. build people with explicit ids + visits referencing them.
  //    We assign ids up front so a single bulkPut works for both stores.
  const people = personList.map((p, i) => ({ ...p, id: i + 1 }));
  const idByPerson = new Map(personList.map((p, i) => [p, i + 1]));
  const visits = rawVisits.map((v, i) => {
    const p = v._person;
    const pid = idByPerson.get(p) ?? null;
    return {
      id: i + 1,
      name: p.name,
      mob: p.mob,
      age: v.age,
      gender: p.gender,
      token: v.token,
      day: v.day,
      date: v.date,
      createdAt: v.createdAt,
      updatedAt: v.createdAt,
      personId: pid,
    };
  });

  // 5. write + rebuild (people projection from visits).
  await db.transaction('rw', db.people, db.visits, async () => {
    await db.people.clear();
    await db.visits.clear();
    await db.people.bulkPut(people);
    await db.visits.bulkPut(visits);
  });
  await PatientDb.rebuildPeopleFromVisits();

  return { people: people.length, visits: visits.length, days };
}

export async function clearAll() {
  await db.transaction('rw', db.people, db.visits, async () => {
    await db.people.clear();
    await db.visits.clear();
  });
}
