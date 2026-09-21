// Dev-only seed / clear. Generates realistic visit history so the Patients
// list, history modal, restore, and pagination can be exercised.
//
// Invariant: visits are the source of truth. This writes visits directly,
// which goes through the same _writeVisit path a restore takes. Exactly
// one write path, so seed, save, and restore cannot diverge.
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
// Day-heavy seed: every day in the range gets `minPerDay`..`maxPerDay`
// visits (defaults 70–200, avg ~135). Patients are drawn from the pool at
// random each day; a patient can appear more than once on a day only rarely.
// Follow-up logic walks each patient's own chronology so it stays valid.
export async function seed({
  days = 60,
  patients = 500,
  minPerDay = 70,
  maxPerDay = 200,
} = {}) {
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
      _baseWeight: 60 + Math.random() * 35, // 60–95, per-patient baseline
      name,
      mob,
      age: baseAge,
      gender,
      weight: 60 + Math.round(Math.random() * 35),
      createdAt: isoAt(createdAt),
      updatedAt: isoAt(createdAt),
      lastVisitAt: isoAt(createdAt),
    });
  }

  // 2. build visits day-by-day so per-day counts are guaranteed.
  //    Per visit:
  //      - payment (0 cash | 1 UPI) random
  //      - followup decided later from each patient's own timeline
  //      - refundTier stays '0' by default; a few paid visits become R1/R2/R
  //      - weight wobbles ±3 around the patient's baseline
  const rawVisits = [];
  const span = maxPerDay - minPerDay + 1;
  for (let off = 0; off < days; off++) {
    const targetCount = minPerDay + randInt(span);
    // Dedup names within a day: pick distinct patients for the targetCount.
    // If the pool is smaller than targetCount, allow repeats (stress case).
    const shuffled = personList.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const todays = [];
    if (targetCount <= shuffled.length) {
      for (let i = 0; i < targetCount; i++) todays.push(shuffled[i]);
    } else {
      // allow repeats when the pool is smaller than the day
      for (let i = 0; i < targetCount; i++) todays.push(shuffled[randInt(shuffled.length)]);
    }
    for (const p of todays) {
      const d = atClinicHour(addDays(today, -days + off));
      const weight = Math.round((p._baseWeight + (Math.random() * 6 - 3)) * 10) / 10;
      rawVisits.push({
        _person: p,
        _offset: off,
        createdAt: isoAt(d),
        day: localDayOf(d),
        date: localDayOf(d),
        age: p.age,
        weight,
        payment: randInt(2), // 0 cash | 1 upi
      });
    }
  }

  // 3. per patient, sort their visits oldest -> newest and decide followup
  //    vs paid from the 6-day window anchored on the last PAID visit.
  const byPerson = new Map();
  for (const v of rawVisits) {
    let arr = byPerson.get(v._person);
    if (!arr) {
      arr = [];
      byPerson.set(v._person, arr);
    }
    arr.push(v);
  }
  for (const [p, arr] of byPerson) {
    arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let lastPaidOffset = null;
    for (const v of arr) {
      const daysSincePaid = lastPaidOffset == null ? null : v._offset - lastPaidOffset;
      const followup = daysSincePaid != null && daysSincePaid >= 0 && daysSincePaid <= 6 ? 1 : 0;
      v.followup = followup;
      v.fee = followup ? 0 : 300;
      v.refundTier = !followup && randInt(20) === 0 ? ['R1', 'R2', 'R'][randInt(3)] : '0';
      if (!followup) lastPaidOffset = v._offset;
    }
  }

  // 4. sort globally by createdAt, assign per-day token (1..N).
  rawVisits.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const perDay = new Map();
  for (const v of rawVisits) {
    const t = (perDay.get(v.day) || 0) + 1;
    perDay.set(v.day, t);
    v.token = t;
  }

  // 5. build people with explicit ids + visits referencing them.
  //    We assign ids up front so a single bulkPut works for both stores.
  const people = personList.map((p, i) => {
    const { _baseWeight, ...row } = p;
    return { ...row, id: i + 1 };
  });
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
      personId: pid,
    };
  });

  // 6. write. Uses the same single path restore takes: replaceAll replays
  // every row through _writeVisit, which builds the people projection.
  await PatientDb.replaceAll({ version: 2, visits });

  return { people: people.length, visits: visits.length, days };
}

export async function clearAll() {
  await db.transaction('rw', db.people, db.visits, async () => {
    await db.people.clear();
    await db.visits.clear();
  });
}
