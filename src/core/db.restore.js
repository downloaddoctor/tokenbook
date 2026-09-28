// Restore: replay a parsed backup log through the same write path that
// produced it. Split out of db.js for readability; attached to DB.prototype
// via Object.assign in db.js. All methods use `this.*` (the DB instance).
//
// Contract: replayLog(ops) clears the four revision/projection stores +
// userRevs, then applies each op. The `users` projection is intentionally
// NOT cleared — passwords live only there and a restore must not destroy
// them.

import { normalizeRefundTier } from './billing.js';

export const restoreMethods = {
  async replayLog(ops, { onProgress = null } = {}) {
    const db = this._db;
    return db.transaction(
      'rw',
      db.people,
      db.peopleProj,
      db.visits,
      db.visitsProj,
      db.userRevs,
      db.users,
      db.meta,
      async () => {
        await db.people.clear();
        await db.peopleProj.clear();
        await db.visits.clear();
        await db.visitsProj.clear();
        await db.userRevs.clear();
        // NOTE: the `users` projection is NOT cleared — passwords live only there
        // and must never be destroyed by a restore. User revisions are merged in
        // (idempotent) so attribution resolves; existing credentials survive.

        const total = ops.length;
        // Throttle progress by TIME (~every 400ms), not by row count: keeps the
        // statusbar steady and readable no matter how big the restore is.
        const PROGRESS_MS = 100;
        let lastTick = 0;
        let processed = 0;
        let restored = 0;
        let skipped = 0;
        const skippedRows = [];
        const tick = (force) => {
          if (!onProgress) return;
          const now = Date.now();
          if (!force && now - lastTick < PROGRESS_MS) return;
          lastTick = now;
          try { onProgress({ processed, total, restored, skipped }); } catch (_) { }
        };

        for (const op of ops) {
          processed++;
          try {
            if (op.kind === 'person') await this._replayPerson(op);
            else if (op.kind === 'visit') await this._replayVisit(op);
            else if (op.kind === 'user') await this._replayUser(op);
            else if (op.kind === 'settings') await this._replaySettings(op);
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
      }
    );
  },

  // Apply a settings singleton from the log. Missing/invalid fields are
  // ignored (keeps current settings for those keys).
  async _replaySettings(op) {
    const patch = {};
    if (op.defaultFee != null && Number.isFinite(Number(op.defaultFee))) {
      patch.defaultFee = Number(op.defaultFee);
    }
    if (op.followupWindowDays != null && Number.isFinite(Number(op.followupWindowDays))) {
      patch.followupWindowDays = Number(op.followupWindowDays);
    }
    if (!Object.keys(patch).length) throw new Error('settings: no valid fields');
    const cur = await this.getSettings();
    await this._db.meta.put({ key: 'settings', value: { ...cur, ...patch } });
  },

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
        userId: op.userId != null ? op.userId : null,
        userV: op.userV != null ? op.userV : null,
      });
    }
    await this._putPersonProj(op.rootId);
  },

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
        userId: op.userId != null ? op.userId : null,
        userV: op.userV != null ? op.userV : null,
      });
    }
    await this._putVisitProj(op.rootId);
    await this._putPersonProj(op.personId);
  },

  // Replay a user revision into userRevs ONLY. The `users` projection (which
  // holds secrets) is intentionally NOT touched: a restore must not recreate
  // or overwrite credentials. A user present in the log but absent locally
  // gets a secret-less projection stub so attribution renders; an admin must
  // set its password before it can log in.
  async _replayUser(op) {
    const db = this._db;
    if (op.id == null || op.v == null) throw new Error('user: missing id/v');
    const exists = await db.userRevs.get([op.id, op.v]);
    if (!exists) {
      await db.userRevs.add({
        id: op.id,
        v: op.v,
        username: op.username || '',
        role: op.role === 'admin' ? 'admin' : 'user',
        disabled: op.disabled ? 1 : 0,
        createdAt: op.createdAt || new Date().toISOString(),
        revAt: op.revAt || op.createdAt || new Date().toISOString(),
      });
    }
    const proj = await db.users.get(op.id);
    if (!proj) {
      await db.users.add({
        id: op.id,
        username: op.username || '',
        role: op.role === 'admin' ? 'admin' : 'user',
        salt: '',
        hash: '',
        iter: 0,
        disabled: op.disabled ? 1 : 0,
        sessionToken: '',
        createdAt: op.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastLoginAt: null,
      });
    }
  },
};
