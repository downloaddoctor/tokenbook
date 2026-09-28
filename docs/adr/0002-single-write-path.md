# 0002 — Single visit write path (`addVisit`)

Status: Accepted

## Context
Visits are written from two places: live form saves and restore-from-log. If
those two paths diverge, the DB can hold rows that the log would never produce
(or vice versa) — a silent integrity break that only shows up at the next
restore.

## Decision
`db.addVisit()` is the ONLY visit write entry. Both live saves and restore
funnel through it. Person resolution, follow-up billing, revision append,
projection update, and journal emit all happen inside it.

Restore passes a `preserve` block (rootId, v, personId, personV, hidden,
createdAt) so replay inserts the ORIGINAL revision rather than a new one. The
journal is suppressed for restore, so a log is never re-appended while it is
being read.

## Consequences
- Live and restore cannot produce structurally different rows.
- Every change to visit semantics (new field, new validation) lands in one
  place and applies to restore for free.
- `addVisit` is a hot file; splitting it means splitting "the write path"
  across files, which is not what we want. Keep the logic together.
- `seed.js` (dev-only) deliberately bypasses `addVisit` for bulk speed; it
  MUST keep its projection logic in sync — an accepted dev-only exception.

Related: 0001, 0003.
