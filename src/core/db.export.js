// Export: stream the whole DB as the log CSV (used by backup + the Log dialog).
// Split out of db.js; attached to DB.prototype via Object.assign.
//
// Contract: exportAllStream(onChunk) emits text chunks and returns { count }.
// Rows are ordered users-first (so restore can resolve attribution), then
// people, then visits, then the settings singleton line. Count = users +
// people + visits + 1 (settings).

import Dexie from 'https://unpkg.com/dexie@4.0.11/dist/modern/dexie.mjs';
import {
  csvHeaderLine,
  detailsLine,
  personRevToLogLine,
  visitRevToLogLine,
  userRevToLogLine,
  settingsToLogLine,
} from '../backup/csv.js';
import { APP_VERSION } from './version.js';

export const exportMethods = {
  // App/data-model version written into the #details line. Read from the
  // shared APP_VERSION constant so a bump lands everywhere at once.
  async _appVersion() {
    return 'v' + APP_VERSION;
  },

  // Real counts for the #details line: current (non-hidden) people + visits
  // + user accounts.
  async _logCounts() {
    const db = this._db;
    const [visits, people, users] = await Promise.all([
      db.visitsProj.where('hidden').equals(0).count(),
      db.peopleProj.where('hidden').equals(0).count(),
      db.users.count(),
    ]);
    return { visits, people, users };
  },

  async exportAllStream(onChunk, { pageSize = 2000 } = {}) {
    const db = this._db;
    // #details first (human-readable; ignored by the parser), then #head block.
    const counts = await this._logCounts();
    onChunk(detailsLine(await this._appVersion(), new Date().toISOString(), counts) + '\n');
    onChunk(csvHeaderLine() + '\n');
    let count = 0;
    // Users first (schemaNo 0) so attribution resolves during a streaming read.
    let lastUserKey = [Dexie.minKey, Dexie.minKey];
    for (; ;) {
      const rows = await db.userRevs.where('[id+v]').above(lastUserKey).limit(pageSize).toArray();
      if (!rows.length) break;
      let buf = '';
      for (const u of rows) buf += userRevToLogLine(u) + '\n';
      onChunk(buf);
      count += rows.length;
      const last = rows[rows.length - 1];
      lastUserKey = [last.id, last.v];
      if (rows.length < pageSize) break;
    }
    let lastKey = [Dexie.minKey, Dexie.minKey];
    for (; ;) {
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
    for (; ;) {
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
    // Settings singleton (schemaNo 3): one line, so a restore carries policy.
    const settings = await this.getSettings();
    onChunk(settingsToLogLine({ ...settings, revAt: new Date().toISOString() }) + '\n');
    count += 1;
    return { count };
  },

  async exportAll() {
    const db = this._db;
    const users = (await db.userRevs.toArray()).sort((a, b) => a.id - b.id || a.v - b.v);
    const people = (await db.people.toArray()).sort((a, b) => a.rootId - b.rootId || a.v - b.v);
    const visits = (await db.visits.toArray()).sort((a, b) => a.rootId - b.rootId || a.v - b.v);
    const counts = await this._logCounts();
    const lines = [
      detailsLine(await this._appVersion(), new Date().toISOString(), counts),
      csvHeaderLine(),
    ];
    for (const u of users) lines.push(userRevToLogLine(u));
    for (const p of people) lines.push(personRevToLogLine(p));
    for (const v of visits) lines.push(visitRevToLogLine(v));
    const settings = await this.getSettings();
    lines.push(settingsToLogLine({ ...settings, revAt: new Date().toISOString() }));
    return {
      text: lines.join('\n') + '\n',
      count: users.length + people.length + visits.length + 1,
    };
  },
};
