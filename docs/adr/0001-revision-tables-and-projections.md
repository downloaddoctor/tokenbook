# 0001 — Revision tables + projection tables

Status: Accepted

## Context
TokenBook needs an audit trail (who changed what, when) AND fast current-state
reads (list by day, search by name/mobile, paging). A single mutable row per
entity cannot serve both: history is lost on update, and querying history at
read time is slow and awkward.

## Decision
Store every entity as an append-only series of **revisions** keyed `[rootId+v]`
(`people`, `visits`), plus one **projection** row per `rootId` (`peopleProj`,
`visitsProj`) holding the current state and every index the UI needs.

- Writes append a revision AND put the projection in ONE Dexie transaction.
- Revision rows are never mutated. Projection rows are mutated freely.
- The projection is disposable: `db.rebuildProj()` reconstructs it from
  revisions. It is not part of the backup.

## Consequences
- Cheap current-state reads (projection indexes) and full history for free.
- Every read path must use the projection; every audit path uses revisions.
  Mixing them is a bug class.
- Every write is 2 stores in 1 tx — slightly more work, but atomic.
- Storage grows with edits (revisions accumulate). Acceptable for a clinic.

Related: 0002, 0003.
