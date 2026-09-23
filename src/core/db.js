// IndexedDB wrapper for patient records. Backed by Dexie.
// DB: doctor-apt-list, v1. Two stores:
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
//
// Class shape: all state lives on the instance (`this._db`, `this._openPromise`,
// `this._journal`, `this._journalBuffers`). External code uses the default
// instance export (`import db from './db.js'; db.addVisit(...)`). `rawDb()`
// returns the current Dexie instance for bulk tooling (seed.js).

import Dexie from 'https://unpkg.com/dexie@4.0.11/dist/modern/dexie.mjs';
import { localDay } from './day.js';
import { csvHeaderLine, visitInputToLogLine, normalizeRefundTier } from '../backup/csv.js';

const DB_NAME = 'doctor-apt-list';

// Refund tier step: amount = tier * STEP. Exported as a module constant so
// billing/tokens pages can read it without instantiating anything.
export const REFUND_TIER_STEP = 100;
export function refundAmountFor(tier) {
  return normalizeRefundTier(tier) * REFUND_TIER_STEP;
}

class DB {
  constructor() {
    // The active Dexie instance. Swappable so the self-test can run against an
    // isolated database (doctor-apt-list-devtest) and wipe/replay it without
    // touching real data. Default is the real DB_NAME.
    this._dbName = DB_NAME;
    this._db = new Dexie(this._dbName);
    this._declareSchema(this._db);
    // Shared open promise so concurrent callers get the same connection handle.
    this._openPromise = null;
    // Journal hook: backup.js registers a callback at boot. Every successful
    // addVisit / setVisitRefund emits the INPUT it was called with (not the
    // derived output), so restoring from the log replays through the same code
    // path and re-derives identically. Keeps db.js free of any dependency on
    // the backup module (no import cycle).
    this._journal = null;
    // Per-transaction journal buffers. Key = Dexie Transaction, value = entries.
    // Entries are released on the transaction's 'complete' event and dropped on
    // 'abort'/'error', so the backup log only ever records committed writes.
    this._journalBuffers = new Map();
  }

  // Single declared version. No production data yet, so the schema can be
  // reset freely; the declared number only needs to be self-consistent.
  _declareSchema(instance) {
    instance.version(1).stores({
      people: '++id, name, mob, [name+mob], updatedAt',
      visits: '++id, mob, createdAt, date, [date+token], personId',
    });
  }

  // Raw Dexie instance for bulk tooling (dev/seed.js writes directly and must
  // bypass _writeVisit by design). Not part of the app's public surface.
  raw() {
    return this._db;
  }

  openDb() {
    if (!this._openPromise) this._openPromise = this._db.open();
    return this._openPromise;
  }

  // DEV/TEST ONLY: swap to a different database (e.g. the self-test DB). Closes
  // the current connection, recreates the Dexie instance + schema, and resets
  // the open promise. All methods reference `this._db`, so they follow the swap.
  async setDbName(name) {
    const next = name || DB_NAME;
    if (next === this._dbName) return;
    try { this._db.close(); } catch (e) { /* ignore */ }
    this._dbName = next;
    this._db = new Dexie(this._dbName);
    this._declareSchema(this._db);
    this._openPromise = null;
  }

  // DEV/TEST ONLY: delete the current database entirely.
  deleteDb() {
    return Dexie.delete(this._dbName);
  }

  localDay(d) {
    return localDay(d);
  }

  nextTokenForDate(date) {
    return this._db.visits
      .where('[date+token]')
      .between([date, Dexie.minKey], [date, Dexie.maxKey])
      .last()
      .then((v) => (v ? v.token + 1 : 1));
  }

  // Find the person by (name, mob); create if absent; refresh their stored age.
  findOrCreatePerson({ name, mob, age, gender }) {
    name = String(name).trim().toUpperCase();
    mob = String(mob).trim();
    const now = new Date().toISOString();
    gender = gender == null ? '' : String(gender).trim();
    const db = this._db;
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

  // Delete a person row by exact (name, mob). DEV/TEST ONLY — the app itself
  // never deletes people (0-visit people are kept). Used by the self-test to
  // clean up its fixed TEST PATIENT identities between runs.
  async deletePeopleByNameMob(name, mob) {
    name = String(name || '').trim().toUpperCase();
    mob = String(mob || '').trim();
    if (!name || !mob) return 0;
    const db = this._db;
    return db.transaction('rw', db.people, async () => {
      const rows = await db.people.where('[name+mob]').equals([name, mob]).toArray();
      for (const p of rows) await db.people.delete(p.id);
      return rows.length;
    });
  }

  // Exact (name, mob) lookup via the compound index. Used to detect identity
  // collisions when an edit would rename a person onto another person's identity.
  findPersonByNameMob(name, mob) {
    name = String(name || '').trim().toUpperCase();
    mob = String(mob || '').trim();
    if (!name || !mob) return Promise.resolve(null);
    return this._db.people.where('[name+mob]').equals([name, mob]).first();
  }

  // Prefix search on mobile number for autofill. Matches as-is (no reordering).
  searchPeopleByMob(prefix, limit = 8) {
    if (!prefix) return Promise.resolve([]);
    return this._db.people.where('mob').startsWith(prefix).limit(limit).toArray();
  }

  // Prefix search on name for autofill. Matches as-is (no reordering).
  searchPeopleByName(prefix, limit = 8) {
    prefix = String(prefix || '').trim().toUpperCase();
    if (!prefix) return Promise.resolve([]);
    return this._db.people.where('name').startsWith(prefix).limit(limit).toArray();
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
  addVisit(input) {
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
    const db = this._db;

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
        return this._writeVisit(rec, nowIso, false);
      }

      // ---- live save path: resolve identity + billing -------------------
      let person = null;
      // Fast path: a linked person whose identity is UNCHANGED needs no
      // [name+mob] lookup at all — an edit that doesn't touch the name/mobile
      // must not run identity resolution.
      let identityChanged = false;
      if (personId) {
        person = await db.people.get(personId);
        if (person && (person.name !== name || person.mob !== mob)) identityChanged = true;
      }
      if (!person) {
        person = await db.people.where('[name+mob]').equals([name, mob]).first();
      }
      if (person) {
        // Only when the identity is actually changing do we guard against
        // another person already holding the target (name, mob).
        if (identityChanged) {
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
      const billing = await this._resolveBilling({ personId, date, followup, fee });
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
        date,
        createdAt: createdAt || nowIso,
        updatedAt: updatedAt || createdAt || nowIso,
        personId,
      };
      // _writeVisit journals this write itself (log defaults to true).
      return this._writeVisit(rec, nowIso);
    });
  }

  // THE write path. Takes a fully-formed visit record (all fields resolved by
  // the caller) and:
  //   1. upserts the visit on (date, token)
  //   2. maintains the people projection (count, lastVisitAt, updatedAt)
  //   3. emits one journal line (unless log=false) — the single place backup
  //      learns about a committed write
  // Must run inside the caller's rw transaction.
  async _writeVisit(rec, nowIso, log = true) {
    const db = this._db;
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
        await this._recomputePerson(prevPersonId);
        prevPerson = await db.people.get(prevPersonId); // null if orphan-deleted
        await this._bumpPersonOnGain(personId, rec, visitCreatedAt, nowIso);
      } else {
        await this._touchPerson(personId, rec, visitCreatedAt, nowIso);
      }
    } else {
      stored = { ...rec };
      stored.id = await db.visits.add(stored);
      await this._bumpPersonOnGain(personId, stored, stored.createdAt || nowIso, nowIso);
      created = true;
    }

    const person = await db.people.get(personId);
    if (log) this._emitJournal(stored);
    return { rec: stored, created, person, prevPerson };
  }

  // O(1) field bump when a person GAINS a visit (new visit, or a visit was
  // reassigned TO them).
  async _bumpPersonOnGain(personId, rec, visitCreatedAt, nowIso) {
    const db = this._db;
    const p = await db.people.get(personId);
    if (!p) return;
    p.visits = (Number.isFinite(p.visits) ? p.visits : 0) + 1;
    const isNewest = !p.lastVisitAt || (visitCreatedAt || '') > (p.lastVisitAt || '');
    if (isNewest) {
      p.lastVisitAt = visitCreatedAt;
      this._applyIdentity(p, rec);
    }
    p.updatedAt = nowIso;
    await db.people.put(p);
  }

  // O(1) touch when a person's own visit was edited in place.
  async _touchPerson(personId, rec, visitCreatedAt, nowIso) {
    const db = this._db;
    const p = await db.people.get(personId);
    if (!p) return;
    this._applyIdentity(p, rec);
    p.updatedAt = nowIso;
    await db.people.put(p);
  }

  // Mirror a visit's identity snapshot onto the person row.
  _applyIdentity(p, rec) {
    if (!p || !rec) return;
    p.name = String(rec.name || p.name || '').trim().toUpperCase();
    if (rec.mob != null) p.mob = rec.mob;
    if (rec.age != null) p.age = rec.age;
    if (rec.gender) p.gender = rec.gender;
    if (rec.weight != null) p.weight = rec.weight;
  }

  // Re-derive a person's projection (visits count + lastVisitAt) from their
  // current visits. Identity is NOT re-derived here — see _applyIdentity.
  async _recomputePerson(personId) {
    const db = this._db;
    const p = await db.people.get(personId);
    if (!p) return;
    const visits = await db.visits.where('personId').equals(personId).toArray();
    if (!visits.length) {
      p.visits = 0;
      p.lastVisitAt = undefined;
      p.updatedAt = new Date().toISOString();
      await db.people.put(p);
      return;
    }
    let newest = visits[0];
    for (const v of visits) {
      if ((v.createdAt || '') > (newest.createdAt || '')) newest = v;
    }
    p.visits = visits.length;
    p.lastVisitAt = newest.createdAt || undefined;
    p.updatedAt = new Date().toISOString();
    await db.people.put(p);
  }

  // Walk back through a person's visits (newest first) and return the last
  // visit whose `followup` is falsy (i.e. a PAID visit).
  async _lastPaidVisitDaysFor(personId, date) {
    if (!personId) return null;
    const db = this._db;
    const rows = await db.visits.where('personId').equals(personId).toArray();
    if (!rows.length) return null;
    rows.sort((a, b) => {
      const ad = a.date || '';
      const bd = b.date || '';
      if (ad !== bd) return bd.localeCompare(ad);
      return (b.token || 0) - (a.token || 0);
    });
    for (const v of rows) {
      if (!v.followup) return { visit: v, days: this._daysBetween(v.date, date) };
    }
    return null;
  }

  // Public alias kept for the register page and the self-test.
  lastPaidVisitDaysFor(personId, date) {
    return this._lastPaidVisitDaysFor(personId, date);
  }

  // Whole-day difference between two 'YYYY-MM-DD' strings (b - a).
  _daysBetween(a, b) {
    if (!a || !b) return null;
    const da = new Date(a + 'T00:00:00');
    const db2 = new Date(b + 'T00:00:00');
    if (isNaN(da) || isNaN(db2)) return null;
    return Math.round((db2 - da) / 86400000);
  }

  // Public alias kept for the self-test / external callers.
  daysBetween(a, b) {
    return this._daysBetween(a, b);
  }

  // Compute fee + auto-followup for a candidate visit.
  async _resolveBilling({ personId, date, followup, fee }) {
    const baseFee = Number.isFinite(Number(fee)) && Number(fee) > 0 ? Number(fee) : 300;
    const explicit = followup === 0 || followup === 1 ? followup : null;
    let anchoredOn = null;
    let auto = false;
    if (explicit !== 0) {
      const last = await this._lastPaidVisitDaysFor(personId, date);
      if (last && last.days != null && last.days >= 0 && last.days <= 6) {
        auto = true;
        anchoredOn = { visitId: last.visit.id, days: last.days, date: last.visit.date };
      }
    }
    const fu = explicit != null ? explicit : auto ? 1 : 0;
    const outFee = fu === 1 ? 0 : baseFee;
    return { followup: fu, fee: outFee, anchoredOn };
  }

  // Journal hook: backup.js registers a callback at boot.
  setJournal(fn) {
    this._journal = typeof fn === 'function' ? fn : null;
  }

  // Journal buffering: entries emitted during a Dexie transaction are held per
  // transaction and released only on 'complete'.
  _emitJournal(entry) {
    if (!this._journal) return;
    const txn = Dexie.currentTransaction;
    if (txn) {
      const buf = this._journalBuffers.get(txn);
      if (buf) {
        buf.push(entry);
        return;
      }
      const fresh = [entry];
      this._journalBuffers.set(txn, fresh);
      const release = () => {
        this._journalBuffers.delete(txn);
        for (const e of fresh) this._deliverJournal(e);
      };
      const drop = () => this._journalBuffers.delete(txn);
      try {
        txn.on('complete', release);
        txn.on('abort', drop);
        txn.on('error', drop);
      } catch {
        this._journalBuffers.delete(txn);
        this._deliverJournal(entry);
      }
      return;
    }
    this._deliverJournal(entry);
  }

  _deliverJournal(entry) {
    try {
      this._journal(entry);
    } catch (e) {
      console.error('journal', e);
    }
  }

  listByDate(date) {
    const db = this._db;
    return db.visits
      .where('[date+token]')
      .between([date, Dexie.minKey], [date, Dexie.maxKey])
      .toArray();
  }

  // Delete every visit on `date` and recompute the people projection for the
  // affected people (0-visit people are KEPT, not deleted).
  async deleteVisitsByDate(date) {
    const db = this._db;
    return db.transaction('rw', db.people, db.visits, async () => {
      const rows = await db.visits
        .where('[date+token]')
        .between([date, Dexie.minKey], [date, Dexie.maxKey])
        .toArray();
      const peopleBefore = new Set();
      for (const v of rows) {
        if (v.personId != null) peopleBefore.add(v.personId);
        await db.visits.delete(v.id);
      }
      for (const pid of peopleBefore) {
        const p = await db.people.get(pid);
        if (!p) continue;
        await this._recomputePerson(pid);
      }
      return { visits: rows.length, people: 0 };
    });
  }

  // Post-visit edit: set (or clear) the refund tier on a single visit.
  async setVisitRefund(visitId, tier, whenIso) {
    const t = normalizeRefundTier(tier);
    const nowIso = whenIso || new Date().toISOString();
    const db = this._db;
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
      const result = await this._writeVisit(rec, nowIso);
      return result.rec;
    });
  }

  // List unique patients, most recently SEEN first.
  listPeople({ offset = 0, limit = 50 } = {}) {
    return this._db.people.toArray().then((rows) => {
      rows.sort((a, b) =>
        (b.lastVisitAt || b.updatedAt || '').localeCompare(a.lastVisitAt || a.updatedAt || '')
      );
      return rows.slice(offset, offset + limit);
    });
  }

  countPeople() {
    return this._db.people.count();
  }

  getPerson(id) {
    return this._db.people.get(id);
  }

  // Prefix search across name OR mob. Dedups by id.
  async searchPeopleByPrefix(q, limit = 50) {
    q = String(q || '').trim();
    if (!q) return this.listPeople({ offset: 0, limit });
    const db = this._db;
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

  // Number of visits per person, keyed by personId.
  async visitCountsForPeople(ids) {
    const m = new Map();
    if (!ids || !ids.length) return m;
    const db = this._db;
    const people = await db.people.bulkGet(ids);
    const missing = [];
    people.forEach((p) => {
      if (!p) return;
      if (Number.isFinite(p.visits)) m.set(p.id, p.visits);
      else missing.push(p.id);
    });
    if (missing.length) {
      const rows = await db.visits.where('personId').anyOf(missing).toArray();
      for (const r of rows) m.set(r.personId, (m.get(r.personId) || 0) + 1);
      for (const id of missing) if (!m.has(id)) m.set(id, 0);
    }
    return m;
  }

  // Full visit history for one person, newest first.
  visitsForPerson(personId) {
    return this._db.visits.where('personId').equals(personId).reverse().sortBy('createdAt');
  }

  // Look up a single visit by its identity (date, token), plus its person row.
  async findVisitByDateToken(date, token) {
    const db = this._db;
    const visit = await db.visits.where('[date+token]').equals([date, Number(token)]).first();
    if (!visit) return null;
    const person = visit.personId ? await db.people.get(visit.personId) : null;
    return { visit, person };
  }

  listAll({ offset = 0, limit = 50 } = {}) {
    return this._db.visits.orderBy('createdAt').reverse().offset(offset).limit(limit).toArray();
  }

  countAll() {
    return this._db.visits.count();
  }

  // Replay a logbook: wipe stores, then run every row through the SAME write
  // path that produced it — addVisit({preserve}).
  async replayLog(ops) {
    const db = this._db;
    return await db.transaction('rw', db.people, db.visits, async () => {
      await db.people.clear();
      await db.visits.clear();
      let n = 0;
      let skipped = 0;
      for (const op of ops) {
        if (op.personId == null || !op.date || !Number.isInteger(op.token) || op.token < 1) {
          skipped++;
          continue;
        }
        await this.addVisit({
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

  // Serialize the current DB as a fresh log (header + one full row per visit).
  async exportAll() {
    const db = this._db;
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

  // Post-visit edit: set (or clear) the refund tier on a single visit.
  // (Kept as a named alias so callers see both `setVisitRefund` and this name.)
  refundAmountFor(tier) {
    return refundAmountFor(tier);
  }
}

const clinicDb = new DB();

// Raw Dexie accessor for bulk tools (seed.js). Returns whatever the current
// instance is — after setDbName() this points at the swapped DB.
export function rawDb() {
  return clinicDb.raw();
}

export default clinicDb;
export { DB };
