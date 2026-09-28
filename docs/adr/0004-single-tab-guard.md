# 0004 — Single-tab guard via Web Locks

Status: Accepted

## Context
The app's data model assumes a single writer: `_nextRootId` / `_nextRev` derive
the next id from the current max, and the CSV logbook is appended without a
file-level lock. Two tabs sharing one origin can race on rootId allocation,
append interleaved lines to the CSV, or double-fire the daily snapshot.

Earlier alternatives (do nothing, or ask the user to close extra tabs) rely on
habit, not a guarantee — a stray Ctrl+click on a link is enough to break it.

## Decision
The FIRST thing `app.js` does at boot is `acquireTabLock()` (Web Locks API,
`navigator.locks.request` with `ifAvailable: true`). The first tab holds the
lock for its page lifetime; a later tab's request is denied and the caller shows
a full-screen "TokenBook is already open" card with a Retry button (which
reloads the page and re-probes).

Release is automatic — Web Locks drops the lock when the tab is closed,
navigated away, or crashes. No heartbeat, no `beforeunload` handler.

Browsers without `navigator.locks` get a permissive pass (`{ok:true}`); the
single-tab guarantee is lost there, but the app still boots.

## Consequences
- No two-tab races on rootId allocation, log appends, or daily snapshots.
- A second tab never touches IndexedDB or the session, so auth/disable logic
  does not need cross-tab invalidation for correctness.
- Older Safari (<15.4) loses the guarantee; documented as a known limitation.
- A stale lock from a crashed tab cannot happen — the browser releases on
  unload.

Related: none.
