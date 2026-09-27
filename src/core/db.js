// IndexedDB wrapper (Dexie). DB 'tokenbook'. Schema v3.
//
// Model: revisioned, append-only entities + a projection table per entity.
//   people      — append-only revisions. Keyed [rootId+v]. Truth for identity.
//   peopleProj  — one row per rootId. Current identity + list/search index.
//   visits      — append-only revisions. Keyed [rootId+v]. Truth for visits.
//   visitsProj  — one row per rootId. Current visit + list/day index.
//
// Invariants:
//   * Writes append a revision to people/visits AND put the projection row,
//     in the SAME Dexie transaction. Two stores, one atomic write.
//   * Revision rows are never mutated. Projection rows are mutated freely.
//   * `hidden` is soft-delete. A hidden projection row is filtered out of
//     every list/search/day query. History (revision tables) keeps everything.
//   * `rebuildProj()` recovers projections from revisions. Idempotent.
//   * addVisit is the ONLY write entry for visits. Both live and restore use it.
//
// Public shape: default export = singleton; `import db from './db.js'; db.addVisit(...)`.
// rawDb() exposes the current Dexie instance for bulk tools (seed.js).

import Dexie from 'https://unpkg.com/dexie@4.0.11/dist/modern/dexie.mjs';
import { localDay } from './day.js';
import {
  evaluateFollowup,
  normalizeFee,
  REFUND_TIER_STEP,
  refundAmountFor,
  normalizeRefundTier,
} from './billing.js';
import { csvHeaderLine, personRevToLogLine, visitRevToLogLine } from '../backup/csv.js';

const DB_NAME = 'tokenbook';

// Re-export the refund helpers from billing.js (canonical home) so existing
// callers that read them off the db module keep working.
export { REFUND_TIER_STEP, refundAmountFor, normalizeRefundTier };

class DB {
  constructor() {
    this._dbName = DB_NAME;
    this._db = new Dexie(this._dbName);
    this._declareSchema(this._db);
    this._openPromise = null;
    this._journal = null;
    this._journalBuffers = new Map();
    // Optional hook: fired after a pre-revision DB is dumped + recreated, with
    // { filename, stores }. app.js wires this to a toast so the backup is seen.
    this._migrationNotice = null;
  }

  setMigrationNotice(fn) {
    this._migrationNotice = typeof fn === 'function' ? fn : null;
  }

  // No prod data yet — schema resets freely. This IS version 1 of the
  // revisioned model; there is no older version to upgrade from. A local DB
  // left over from the pre-revision build cannot upgrade (its primary keys
  // differ), so openDb() deletes-and-recreates it after a JSON dump.
  _declareSchema(instance) {
    instance.version(1).stores({
      people: '[rootId+v], rootId, [name+mob], v',
      peopleProj: 'rootId, [name+mob], lastVisitAt, hidden',
      visits: '[rootId+v], rootId, [date+token], personId, v',
      visitsProj: 'rootId, [date+token], date, personId, hidden',
      meta: 'key',
    });
  }

  raw() {
    return this._db;
  }

  openDb() {
    if (!this._openPromise) {
      this._openPromise = this._db
        .open()
        .catch(async (err) => {
          // A leftover DB from the pre-revision build has different primary
          // keys (++id vs [rootId+v]); Dexie cannot upgrade in place and throws
          // UpgradeError. Never drop silently: dump the old DB to a JSON file
          // (browser download), then recreate.
          if (err && err.name === 'UpgradeError') {
            console.warn('[tokenbook] incompatible schema — backing up then recreating');
            // Close the failed Dexie connection FIRST and let IDB release it,
            // otherwise the later delete is blocked by our own open handle.
            try { this._db.close(); } catch (_) {}
            await new Promise((r) => setTimeout(r, 50));
            let dumpInfo = null;
            try {
              dumpInfo = await this._dumpRawDbToFile(this._dbName);
            } catch (dumpErr) {
              console.error('[tokenbook] pre-migration backup failed', dumpErr);
              throw dumpErr; // never delete without a backup
            }
            if (dumpInfo && this._migrationNotice) {
              try { this._migrationNotice(dumpInfo); } catch (_) {}
            }
            // Delete can still be blocked by another tab. Retry a few times.
            for (let i = 0; i < 5; i++) {
              try {
                await Dexie.delete(this._dbName);
                break;
              } catch (delErr) {
                console.warn('[tokenbook] delete blocked, retry', i + 1);
                await new Promise((r) => setTimeout(r, 200));
                if (i === 4) throw delErr;
              }
            }
            this._db = new Dexie(this._dbName);
            this._declareSchema(this._db);
            await this._db.open();
            return;
          }
          throw err;
        })
        .then(async () => {
          const m = await this._db.meta.get('singleton');
          if (!m) {
            await this._db.meta.put({ key: 'singleton', lastDay: null });
          }
        });
    }
    return this._openPromise;
  }

  // Read EVERY object store of an existing raw IndexedDB (no version arg, so
  // the current version is used) and trigger a JSON download. Used before a
  // destructive schema recreate so no data is ever silently dropped.
  _dumpRawDbToFile(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onerror = () => reject(req.error || new Error('indexedDB.open failed'));
      req.onupgradeneeded = () => {
        // No DB existed -> nothing to dump. Abort the implicit upgrade.
        req.transaction && req.transaction.abort();
      };
      req.onsuccess = () => {
        const idb = req.result;
        if (!idb.objectStoreNames.length) {
          idb.close();
          return resolve(null);
        }
        const storeNames = Array.from(idb.objectStoreNames);
        const dump = { db: name, version: idb.version, exportedAt: new Date().toISOString(), stores: {} };
        const tx = idb.transaction(storeNames, 'readonly');
        let remaining = storeNames.length;
        tx.onerror = () => { try { idb.close(); } catch (_) {} reject(tx.error); };
        for (const sn of storeNames) {
          const all = tx.objectStore(sn).getAll();
          all.onsuccess = () => {
            dump.stores[sn] = all.result;
            if (--remaining === 0) {
              try { idb.close(); } catch (_) {}
              const filename =
                name + '-pre-v3-backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
              try {
                const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (e) {
                return reject(e);
              }
              resolve({ filename, stores: storeNames.length });
            }
          };
          all.onerror = () => { try { idb.close(); } catch (_) {} reject(all.error); };
        }
      };
    });
  }

  async setDbName(name) {
    const next = name || DB_NAME;
    if (next === this._dbName) return;
    try { this._db.close(); } catch (e) { /* ignore */ }
    this._dbName = next;
    this._db = new Dexie(this._dbName);
    this._declareSchema(this._db);
    this._openPromise = null;
  }

  deleteDb() {
    return Dexie.delete(this._dbName);
  }

  localDay(d) {
    return localDay(d);
  }

  // ---------- revision helpers ----------

  // Append a person revision. `revAt` = when THIS revision was written; if the
  // caller did not set it (restore does, to preserve the original), stamp now.
  async _appendPersonRev(rec) {
    if (!rec.revAt) rec.revAt = new Date().toISOString();
    await this._db.people.add(rec);
    return { rootId: rec.rootId, v: rec.v };
  }

  // Append a visit revision. Same `revAt` rule as _appendPersonRev.
  async _appendVisitRev(rec) {
    if (!rec.revAt) rec.revAt = new Date().toISOString();
    await this._db.visits.add(rec);
    return { rootId: rec.rootId, v: rec.v };
  }

  async _nextRev(table, rootId) {
    if (rootId == null) return 1;
    const last = await this._db[table]
      .where('[rootId+v]')
      .between([rootId, Dexie.minKey], [rootId, Dexie.maxKey])
      .last();
    return last ? last.v + 1 : 1;
  }

  async _nextRootId(table) {
    const last = await this._db[table].orderBy('rootId').last();
    return (last && last.rootId ? last.rootId : 0) + 1;
  }

  async _currentPerson(rootId) {
    if (rootId == null) return null;
    return this._db.people
      .where('[rootId+v]')
      .between([rootId, Dexie.minKey], [rootId, Dexie.maxKey])
      .last();
  }

  async _currentVisit(rootId) {
    if (rootId == null) return null;
    return this._db.visits
      .where('[rootId+v]')
      .between([rootId, Dexie.minKey], [rootId, Dexie.maxKey])
      .last();
  }

  // Attach identity fields (name/mob/age/gender/weight) onto a visit-shaped
  // row for UI callers. `p` is a person row (revision or projection); null-safe.
  _joinIdentity(row, p) {
    if (!row) return row;
    const out = { ...row };
    if (p) {
      out.name = p.name;
      out.mob = p.mob;
      out.age = p.age;
      out.gender = p.gender;
      out.weight = row.weight != null ? row.weight : p.weight != null ? p.weight : null;
    }
    return out;
  }

  // Write (or overwrite) a projection row for a person rootId.
  async _putPersonProj(rootId) {
    const db = this._db;
    const cur = await this._currentPerson(rootId);
    if (!cur) {
      await db.peopleProj.delete(rootId);
      return null;
    }
    let count = 0;
    let lastVisitAt = null;
    const hits = await db.visitsProj.where('personId').equals(rootId).toArray();
    for (const h of hits) {
      if (h.hidden) continue;
      count++;
      // Anchor on the visit's IMMUTABLE createdAt, not updatedAt — otherwise a
      // rebuild (which re-stamps updatedAt) would drift lastVisitAt forward.
      const iso = h.createdAt || null;
      if (iso && (!lastVisitAt || iso > lastVisitAt)) lastVisitAt = iso;
    }
    const row = {
      rootId,
      v: cur.v,
      name: cur.name,
      mob: cur.mob,
      age: cur.age != null ? cur.age : null,
      gender: cur.gender != null ? cur.gender : null,
      weight: cur.weight != null ? cur.weight : null,
      visits: count,
      lastVisitAt,
      hidden: cur.hidden ? 1 : 0,
      updatedAt: new Date().toISOString(),
    };
    await db.peopleProj.put(row);
    return row;
  }

  async _putVisitProj(rootId) {
    const db = this._db;
    const cur = await this._currentVisit(rootId);
    if (!cur) {
      await db.visitsProj.delete(rootId);
      return null;
    }
    const row = {
      rootId,
      v: cur.v,
      personId: cur.personId,
      personV: cur.personV,
      date: cur.date,
      token: cur.token,
      weight: cur.weight != null ? cur.weight : null,
      followup: cur.followup ? 1 : 0,
      payment: cur.payment ? 1 : 0,
      fee: Number(cur.fee) || 0,
      refundTier: normalizeRefundTier(cur.refundTier),
      hidden: cur.hidden ? 1 : 0,
      createdAt: cur.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await db.visitsProj.put(row);
    return row;
  }

  // Rebuild every projection row from the revision tables. Idempotent.
  async rebuildProj() {
    const db = this._db;
    return db.transaction('rw', db.people, db.peopleProj, db.visits, db.visitsProj, async () => {
      await db.peopleProj.clear();
      await db.visitsProj.clear();
      const visitRoots = new Set();
      await db.visits.each((r) => visitRoots.add(r.rootId));
      for (const rid of visitRoots) await this._putVisitProj(rid);
      const personRoots = new Set();
      await db.people.each((r) => personRoots.add(r.rootId));
      for (const rid of personRoots) await this._putPersonProj(rid);
      return {
        people: await db.peopleProj.count(),
        visits: await db.visitsProj.count(),
      };
    });
  }

  // ---------- reads: current state (projection tables) ----------

  async nextTokenForDate(date) {
    const last = await this._db.visitsProj
      .where('[date+token]')
      .between([date, Dexie.minKey], [date, Dexie.maxKey])
      .last();
    return last ? last.token + 1 : 1;
  }

  async findVisitByDateToken(date, token) {
    const db = this._db;
    const proj = await db.visitsProj.where('[date+token]').equals([date, Number(token)]).first();
    if (!proj) return null;
    const rev = await this._currentVisit(proj.rootId);
    const person = proj.personId != null ? await db.peopleProj.get(proj.personId) : null;
    const visit = this._joinIdentity(rev || proj, person);
    return { visit, person: person || null, proj };
  }

  findPersonByNameMob(name, mob) {
    name = String(name || '').trim().toUpperCase();
    mob = String(mob || '').trim();
    if (!name || !mob) return Promise.resolve(null);
    return this._db.peopleProj.where('[name+mob]').equals([name, mob]).first();
  }

  getPerson(rootId) {
    if (rootId == null) return Promise.resolve(null);
    return this._db.peopleProj.get(rootId);
  }

  searchPeopleByMob(prefix, limit = 8) {
    if (!prefix) return Promise.resolve([]);
    return this._db.peopleProj.where('mob').startsWith(prefix).limit(limit).toArray();
  }

  searchPeopleByName(prefix, limit = 8) {
    prefix = String(prefix || '').trim().toUpperCase();
    if (!prefix) return Promise.resolve([]);
    return this._db.peopleProj.where('name').startsWith(prefix).limit(limit).toArray();
  }

  searchPeopleByPrefix(q, limit = 50) {
    q = String(q || '').trim();
    if (!q) return this.listPeople({ offset: 0, limit });
    if (/^\d/.test(q)) return this.searchPeopleByMob(q, limit);
    return this.searchPeopleByName(q, limit);
  }

  async listPeople({ offset = 0, limit = 50 } = {}) {
    const db = this._db;
    const indexed = await db.peopleProj
      .orderBy('lastVisitAt')
      .reverse()
      .offset(offset)
      .limit(limit)
      .toArray();
    if (indexed.length >= limit) return indexed;
    const have = new Set(indexed.map((p) => p.rootId));
    const rest = (await db.peopleProj.toArray())
      .filter((p) => !p.lastVisitAt && !have.has(p.rootId))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const need = limit - indexed.length;
    return indexed.concat(rest.slice(0, need));
  }

  countPeople() {
    return this._db.peopleProj.count();
  }

  visitCountsForPeople(rootIds) {
    const m = new Map();
    if (!rootIds || !rootIds.length) return Promise.resolve(m);
    return this._db.peopleProj.bulkGet(rootIds).then((rows) => {
      rows.forEach((p, i) => m.set(rootIds[i], p ? Number(p.visits) || 0 : 0));
      return m;
    });
  }

  // Visits on a day, issue order. O(rows that day). Hidden filtered.
  // Identity (name/mob/age/gender/weight) is JOINED from the person projection
  // so UI callers see the v2-shaped row without changes.
  async listByDate(date) {
    const rows = await this._db.visitsProj
      .where('[date+token]')
      .between([date, Dexie.minKey], [date, Dexie.maxKey])
      .toArray();
    const live = rows.filter((r) => !r.hidden);
    const ids = Array.from(new Set(live.map((r) => r.personId).filter((x) => x != null)));
    const people = await this._db.peopleProj.bulkGet(ids);
    const byId = new Map();
    ids.forEach((id, i) => byId.set(id, people[i] || null));
    return live.map((r) => this._joinIdentity(r, byId.get(r.personId)));
  }

  async listAll({ offset = 0, limit = 50 } = {}) {
    const rows = await this._db.visitsProj.toArray();
    rows.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return rows.filter((r) => !r.hidden).slice(offset, offset + limit);
  }

  countAll() {
    return this._db.visitsProj.count();
  }

  // Full visit history for one person, newest first. Reads CURRENT visits from
  // the projection (a reassigned-away visit must NOT appear), then joins each
  // visit's identity from the person revision pinned by (personId, personV) so
  // the operator sees the identity EXACTLY as it was at visit time.
  async visitsForPerson(personId) {
    if (personId == null) return [];
    const cur = await this._db.visitsProj.where('personId').equals(personId).toArray();
    const rows = cur
      .filter((r) => !r.hidden)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const out = [];
    const cache = new Map();
    for (const v of rows) {
      const key = personId + ':' + v.personV;
      let p = cache.get(key);
      if (p === undefined) {
        p = (await this._db.people.get([personId, v.personV])) || null;
        if (!p) p = await this._currentPerson(personId);
        cache.set(key, p);
      }
      out.push(this._joinIdentity(v, p));
    }
    return out;
  }

  revisionsOf(entity, rootId) {
    const table = entity === 'person' ? 'people' : 'visits';
    return this._db[table]
      .where('[rootId+v]')
      .between([rootId, Dexie.minKey], [rootId, Dexie.maxKey])
      .toArray();
  }

  // Newest PAID visit for a person, as a day-gap to `date`. `excludeRootId`
  // skips the visit currently being written/edited — otherwise a paid visit
  // would anchor on ITSELF and flip to a free follow-up on any edit.
  async lastPaidVisitDaysFor(personId, date, excludeRootId) {
    if (!personId) return null;
    const rows = await this._db.visitsProj.where('personId').equals(personId).toArray();
    const vis = rows
      .filter((v) => !v.hidden && v.rootId !== excludeRootId)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    for (const v of vis) {
      if (!v.followup) return { visit: v, days: this._daysBetween(v.date, date) };
    }
    return null;
  }

  _daysBetween(a, b) {
    if (!a || !b) return null;
    const da = new Date(a + 'T00:00:00');
    const db2 = new Date(b + 'T00:00:00');
    if (isNaN(da) || isNaN(db2)) return null;
    return Math.round((db2 - da) / 86400000);
  }

  daysBetween(a, b) {
    return this._daysBetween(a, b);
  }

  // ---------- write path ----------

  async _resolveBilling({ personId, date, followup, fee, excludeRootId }) {
    const baseFee = normalizeFee(fee);
    const explicit = followup === 0 || followup === 1 ? followup : null;
    let lastPaidDays = null;
    if (explicit !== 0) {
      const last = await this.lastPaidVisitDaysFor(personId, date, excludeRootId);
      if (last && last.days != null) lastPaidDays = last.days;
    }
    const { followup: fu, fee: outFee } = evaluateFollowup({ lastPaidDays, explicit, baseFee });
    return { followup: fu, fee: outFee };
  }

  async _resolvePerson({ rootId, name, mob, age, gender, weight }, nowIso) {
    const db = this._db;
    name = String(name).trim().toUpperCase();
    mob = String(mob).trim();
    gender = gender == null ? null : String(gender).trim() || null;

    let current = null;
    if (rootId != null) current = await this._currentPerson(rootId);
    if (!current) {
      const hit = await db.peopleProj.where('[name+mob]').equals([name, mob]).first();
      if (hit) {
        rootId = hit.rootId;
        current = await this._currentPerson(rootId);
      }
    }

    if (!current) {
      rootId = await this._nextRootId('people');
      const rec = {
        rootId,
        v: 1,
        name,
        mob,
        age: age == null || age === '' ? null : Number(age),
        gender,
        weight: weight == null || weight === '' ? null : Number(weight),
        hidden: 0,
        createdAt: nowIso,
      };
      await this._appendPersonRev(rec);
      this._emitJournalPerson(rec);
      return { rootId, v: 1, created: true };
    }

    const same =
      current.name === name &&
      current.mob === mob &&
      (age == null || age === '' ? current.age == null : Number(age) === current.age) &&
      (gender == null ? current.gender == null : gender === current.gender) &&
      (weight == null || weight === '' ? current.weight == null : Number(weight) === current.weight);
    if (same) return { rootId, v: current.v, created: false };

    const next = {
      ...current,
      v: current.v + 1,
      name,
      mob,
      age: age == null || age === '' ? null : Number(age),
      gender: gender == null ? current.gender : gender,
      weight: weight == null || weight === '' ? current.weight : Number(weight),
      hidden: current.hidden ? 1 : 0,
      createdAt: nowIso,
    };
    this._emitJournalPerson(next);
    await this._appendPersonRev(next);
    return { rootId, v: next.v, created: false };
  }

  addVisit(input) {
    let {
      name, mob, age, gender, token, date, personId, weight,
      followup, payment, fee, refundTier, preserve,
    } = input;

    name = name == null ? null : String(name).trim().toUpperCase();
    mob = mob == null ? null : String(mob).trim();
    age = age == null || age === '' ? null : Number(age);
    gender = gender == null ? null : String(gender).trim() || null;
    weight = weight == null || weight === '' ? null : Number(weight);
    if (weight != null && !Number.isFinite(weight)) weight = null;
    payment = payment === 0 || payment === 1 ? payment : payment === '1' ? 1 : 0;
    followup = followup === 0 || followup === 1 ? followup : followup == null ? null : Number(followup) ? 1 : 0;
    refundTier = normalizeRefundTier(refundTier);
    token = Number(token);
    const now = new Date();
    const nowIso = now.toISOString();
    date = date || localDay(now);
    personId = personId ? Number(personId) : null;

    const db = this._db;
    return db.transaction('rw', db.people, db.peopleProj, db.visits, db.visitsProj, async () => {
      if (preserve) {
        const rootId = preserve.rootId != null ? Number(preserve.rootId) : null;
        const v = preserve.v != null ? Number(preserve.v) : 1;
        const pv = preserve.personV != null ? Number(preserve.personV) : 1;
        const pid = preserve.personId != null ? Number(preserve.personId) : null;
        if (rootId == null || pid == null) {
          const e = new Error('Restore row missing rootId/personId.');
          e.name = 'MissingRootIdError';
          throw e;
        }
        const projP = await db.peopleProj.get(pid);
        if (!projP) {
          const existingPerson = await this._currentPerson(pid);
          if (!existingPerson) {
            const prec = {
              rootId: pid,
              v: 1,
              name: name || '',
              mob: mob || '',
              age,
              gender,
              weight,
              hidden: preserve.personHidden ? 1 : 0,
              createdAt: preserve.createdAt || nowIso,
              revAt: preserve.createdAt || nowIso,
            };
            await this._appendPersonRev(prec);
            await this._putPersonProj(pid);
          }
        }
        const rec = {
          rootId, v, personId: pid, personV: pv, date, token, weight,
          followup: followup != null ? followup : 0,
          payment,
          fee: fee == null ? 0 : Number(fee),
          refundTier,
          hidden: preserve.hidden ? 1 : 0,
          createdAt: preserve.createdAt || nowIso,
          revAt: preserve.createdAt || nowIso,
        };
        const exists = await db.visits.get([rootId, v]);
        if (!exists) await this._appendVisitRev(rec);
        const proj = await this._putVisitProj(rootId);
        await this._putPersonProj(pid);
        this._emitJournalVisit(rec);
        const person = await db.peopleProj.get(pid);
        return { rec: this._joinIdentity(proj, person), created: !exists, person };
      }

      const person = await this._resolvePerson(
        { rootId: personId, name, mob, age, gender, weight },
        nowIso
      );
      personId = person.rootId;
      const personV = person.v;

      // Resolve the target visit root FIRST so billing can exclude it from its
      // own follow-up anchor lookup (a paid visit must not follow up on itself).
      const existingProj = await db.visitsProj.where('[date+token]').equals([date, token]).first();
      const excludeRootId = existingProj ? existingProj.rootId : null;

      const billing = await this._resolveBilling({ personId, date, followup, fee, excludeRootId });
      followup = billing.followup;
      fee = billing.fee;

      let rootId;
      let v;
      let created = false;
      let prevPersonId = null;
      let visitCreatedAt = nowIso;
      if (existingProj) {
        rootId = existingProj.rootId;
        v = await this._nextRev('visits', rootId);
        prevPersonId = existingProj.personId;
        // Carry the visit's original createdAt across edits (immutable birth
        // time); `updatedAt` on the projection tracks the latest write.
        const cur = await this._currentVisit(rootId);
        if (cur && cur.createdAt) visitCreatedAt = cur.createdAt;
      } else {
        rootId = await this._nextRootId('visits');
        v = 1;
        created = true;
      }

      const rec = {
        rootId, v, personId, personV, date, token, weight, followup, payment, fee,
        refundTier, hidden: 0, createdAt: visitCreatedAt,
      };
      await this._appendVisitRev(rec);
      const proj = await this._putVisitProj(rootId);
      await this._putPersonProj(personId);
      // If the visit moved away from a previous owner, refresh that person's
      // projection too (its visit count / lastVisitAt just changed).
      if (prevPersonId != null && prevPersonId !== personId) {
        await this._putPersonProj(prevPersonId);
      }
      this._emitJournalVisit(rec);
      const personRow = await db.peopleProj.get(personId);
      return { rec: this._joinIdentity(proj, personRow), created, person: personRow };
    });
  }

  async setVisitRefund(rootId, tier) {
    const t = normalizeRefundTier(tier);
    const db = this._db;
    return db.transaction('rw', db.visits, db.visitsProj, db.peopleProj, async () => {
      const cur = await this._currentVisit(rootId);
      if (!cur) throw new Error('Visit not found: ' + rootId);
      // No-op: saving the same tier must not append a revision.
      if (normalizeRefundTier(cur.refundTier) === t) {
        return await db.visitsProj.get(rootId);
      }
      const rec = { ...cur, v: cur.v + 1, refundTier: t, revAt: undefined };
      await this._appendVisitRev(rec);
      const proj = await this._putVisitProj(rootId);
      this._emitJournalVisit(rec);
      return proj;
    });
  }

  async setVisitBilling(rootId, { followup, payment, fee }) {
    const db = this._db;
    return db.transaction('rw', db.visits, db.visitsProj, async () => {
      const cur = await this._currentVisit(rootId);
      if (!cur) throw new Error('Visit not found: ' + rootId);
      const nextFollowup = followup != null ? (followup ? 1 : 0) : cur.followup;
      const nextPayment = payment != null ? (payment ? 1 : 0) : cur.payment;
      const nextFee = fee != null ? Number(fee) : cur.fee;
      // No-op: nothing changed -> do not append a revision.
      if (
        nextFollowup === cur.followup &&
        nextPayment === cur.payment &&
        nextFee === cur.fee
      ) {
        return await db.visitsProj.get(rootId);
      }
      const rec = {
        ...cur,
        v: cur.v + 1,
        followup: nextFollowup,
        payment: nextPayment,
        fee: nextFee,
        revAt: undefined,
      };
      await this._appendVisitRev(rec);
      const proj = await this._putVisitProj(rootId);
      this._emitJournalVisit(rec);
      return proj;
    });
  }

  hideVisit(rootId) {
    return this.setVisitHidden(rootId, 1);
  }
  unhideVisit(rootId) {
    return this.setVisitHidden(rootId, 0);
  }
  async setVisitHidden(rootId, hidden) {
    const h = hidden ? 1 : 0;
    const db = this._db;
    return db.transaction('rw', db.visits, db.visitsProj, db.peopleProj, async () => {
      const cur = await this._currentVisit(rootId);
      if (!cur) throw new Error('Visit not found: ' + rootId);
      // No-op: already in the requested visibility state.
      if ((cur.hidden ? 1 : 0) === h) return await db.visitsProj.get(rootId);
      const rec = { ...cur, v: cur.v + 1, hidden: h, revAt: undefined };
      await this._appendVisitRev(rec);
      const proj = await this._putVisitProj(rootId);
      await this._putPersonProj(cur.personId);
      this._emitJournalVisit(rec);
      return proj;
    });
  }

  async deleteVisitsByDate(date) {
    const db = this._db;
    return db.transaction('rw', db.people, db.peopleProj, db.visits, db.visitsProj, async () => {
      const proj = await db.visitsProj
        .where('[date+token]')
        .between([date, Dexie.minKey], [date, Dexie.maxKey])
        .toArray();
      const peopleTouched = new Set();
      for (const p of proj) {
        peopleTouched.add(p.personId);
        await db.visits
          .where('[rootId+v]')
          .between([p.rootId, Dexie.minKey], [p.rootId, Dexie.maxKey])
          .delete();
        await db.visitsProj.delete(p.rootId);
      }
      for (const pid of peopleTouched) if (pid != null) await this._putPersonProj(pid);
      return { visits: proj.length };
    });
  }

  async deletePerson(rootId) {
    const db = this._db;
    return db.transaction('rw', db.people, db.peopleProj, async () => {
      await db.people
        .where('[rootId+v]')
        .between([rootId, Dexie.minKey], [rootId, Dexie.maxKey])
        .delete();
      await db.peopleProj.delete(rootId);
      return 1;
    });
  }

  async deletePeopleByNameMob(name, mob) {
    name = String(name || '').trim().toUpperCase();
    mob = String(mob || '').trim();
    if (!name || !mob) return 0;
    const hit = await this._db.peopleProj.where('[name+mob]').equals([name, mob]).first();
    if (!hit) return 0;
    return this.deletePerson(hit.rootId);
  }

  // ---------- restore ----------

  async replayLog(ops, { onProgress = null } = {}) {
    const db = this._db;
    return db.transaction('rw', db.people, db.peopleProj, db.visits, db.visitsProj, async () => {
      await db.people.clear();
      await db.peopleProj.clear();
      await db.visits.clear();
      await db.visitsProj.clear();

      const total = ops.length;
      const TICK = 250;
      let processed = 0;
      let restored = 0;
      let skipped = 0;
      const skippedRows = [];
      const tick = (force) => {
        if (!onProgress) return;
        if (!force && processed % TICK !== 0) return;
        try { onProgress({ processed, total, restored, skipped }); } catch (_) {}
      };

      for (const op of ops) {
        processed++;
        try {
          if (op.kind === 'person') await this._replayPerson(op);
          else if (op.kind === 'visit') await this._replayVisit(op);
          else {
            skipped++;
            skippedRows.push({ lineNo: op.lineNo, reason: 'unknown kind', raw: op.raw || '' });
            tick(false);
            continue;
          }
          restored++;
        } catch (e) {
          skipped++;
          skippedRows.push({ lineNo: op.lineNo, reason: e.message || String(e), raw: op.raw || '' });
        }
        tick(false);
      }
      tick(true);
      return { count: restored, skipped, skippedRows };
    });
  }

  async _replayPerson(op) {
    const db = this._db;
    if (op.rootId == null || op.v == null) throw new Error('person: missing rootId/v');
    const exists = await db.people.get([op.rootId, op.v]);
    if (!exists) {
      await db.people.add({
        rootId: op.rootId,
        v: op.v,
        name: op.name || '',
        mob: op.mob || '',
        age: op.age != null ? op.age : null,
        gender: op.gender != null ? op.gender : null,
        weight: op.weight != null ? op.weight : null,
        hidden: op.hidden ? 1 : 0,
        createdAt: op.createdAt || new Date().toISOString(),
        revAt: op.revAt || op.createdAt || new Date().toISOString(),
      });
    }
    await this._putPersonProj(op.rootId);
  }

  async _replayVisit(op) {
    const db = this._db;
    if (op.rootId == null || op.v == null) throw new Error('visit: missing rootId/v');
    if (op.personId == null) throw new Error('visit: missing personId');
    const exists = await db.visits.get([op.rootId, op.v]);
    if (!exists) {
      await db.visits.add({
        rootId: op.rootId,
        v: op.v,
        personId: op.personId,
        personV: op.personV != null ? op.personV : 1,
        date: op.date || '',
        token: op.token,
        weight: op.weight != null ? op.weight : null,
        followup: op.followup ? 1 : 0,
        payment: op.payment ? 1 : 0,
        fee: op.fee != null ? Number(op.fee) : 0,
        refundTier: normalizeRefundTier(op.refundTier),
        hidden: op.hidden ? 1 : 0,
        createdAt: op.createdAt || new Date().toISOString(),
        revAt: op.revAt || op.createdAt || new Date().toISOString(),
      });
    }
    await this._putVisitProj(op.rootId);
    await this._putPersonProj(op.personId);
  }

  // ---------- export ----------

  async exportAllStream(onChunk, { pageSize = 2000 } = {}) {
    const db = this._db;
    onChunk(csvHeaderLine() + '\n');
    let count = 0;
    let lastKey = [Dexie.minKey, Dexie.minKey];
    for (;;) {
      const rows = await db.people.where('[rootId+v]').above(lastKey).limit(pageSize).toArray();
      if (!rows.length) break;
      let buf = '';
      for (const p of rows) buf += personRevToLogLine(p) + '\n';
      onChunk(buf);
      count += rows.length;
      const last = rows[rows.length - 1];
      lastKey = [last.rootId, last.v];
      if (rows.length < pageSize) break;
    }
    lastKey = [Dexie.minKey, Dexie.minKey];
    for (;;) {
      const rows = await db.visits.where('[rootId+v]').above(lastKey).limit(pageSize).toArray();
      if (!rows.length) break;
      let buf = '';
      for (const v of rows) buf += visitRevToLogLine(v) + '\n';
      onChunk(buf);
      count += rows.length;
      const last = rows[rows.length - 1];
      lastKey = [last.rootId, last.v];
      if (rows.length < pageSize) break;
    }
    return { count };
  }

  async exportAll() {
    const db = this._db;
    const people = (await db.people.toArray()).sort((a, b) => a.rootId - b.rootId || a.v - b.v);
    const visits = (await db.visits.toArray()).sort((a, b) => a.rootId - b.rootId || a.v - b.v);
    const lines = [csvHeaderLine()];
    for (const p of people) lines.push(personRevToLogLine(p));
    for (const v of visits) lines.push(visitRevToLogLine(v));
    return { text: lines.join('\n') + '\n', count: people.length + visits.length };
  }

  refundAmountFor(tier) {
    return refundAmountFor(tier);
  }

  // ---------- journal ----------

  setJournal(fn) {
    this._journal = typeof fn === 'function' ? fn : null;
  }

  // Tag + emit a person revision for backup. Callers pass the full revision row.
  _emitJournalPerson(rec) {
    if (!this._journal) return;
    this._emitJournal({ kind: 'person', ...rec });
  }

  // Tag + emit a visit revision for backup.
  _emitJournalVisit(rec) {
    if (!this._journal) return;
    this._emitJournal({ kind: 'visit', ...rec });
  }

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
      let done = false;
      const clear = () => {
        if (done) return;
        done = true;
        this._journalBuffers.delete(txn);
      };
      const release = () => {
        clear();
        for (const e of fresh) this._deliverJournal(e);
      };
      const drop = () => clear();
      try {
        txn.on('complete', release);
        txn.on('abort', drop);
        txn.on('error', drop);
      } catch {
        clear();
        this._deliverJournal(entry);
      }
      if (this._journalBuffers.size > 256) {
        const oldest = this._journalBuffers.keys().next().value;
        if (oldest && oldest !== txn) this._journalBuffers.delete(oldest);
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
}

// ---------- singleton ----------

const clinicDb = new DB();

// Raw Dexie accessor for bulk tools (seed.js). Follows setDbName() swaps.
export function rawDb() {
  return clinicDb.raw();
}

export default clinicDb;
export { DB };
   