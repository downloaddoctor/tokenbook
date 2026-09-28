// Journal: buffer + deliver revision rows to a subscriber (backup.js's
// markDirty). Split out of db.js; attached to DB.prototype via Object.assign.
//
// Invariant: entries are buffered per Dexie transaction and delivered only on
// 'complete'. Rolled-back writes never reach the journal, so the backup log
// can never disagree with the DB.

import Dexie from 'https://unpkg.com/dexie@4.0.11/dist/modern/dexie.mjs';

export const journalMethods = {
  setJournal(fn) {
    this._journal = typeof fn === 'function' ? fn : null;
  },

  // Tag + emit a person revision for backup. Callers pass the full revision row.
  _emitJournalPerson(rec) {
    if (!this._journal) return;
    this._emitJournal({ kind: 'person', ...rec });
  },

  // Tag + emit a visit revision for backup.
  _emitJournalVisit(rec) {
    if (!this._journal) return;
    this._emitJournal({ kind: 'visit', ...rec });
  },

  // Tag + emit a user revision for backup (secrets excluded by SCHEMA_USER).
  _emitJournalUser(rec) {
    if (!this._journal) return;
    this._emitJournal({ kind: 'user', ...rec });
  },

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
  },

  _deliverJournal(entry) {
    try {
      this._journal(entry);
    } catch (e) {
      console.error('journal', e);
    }
  },
};
