# TokenBook — Agent Guide

Offline-first clinic token/queue register. Vanilla ES modules, no build step, no npm. IndexedDB via Dexie (unpkg). PWA with service-worker shell.

## PROJECT DIRECTORY
src/
 core/ — data + domain (db, billing, auth, day, time)
 backup/ — CSV logbook + folder backup (backup, csv, meta)
 ui/ — shell, router, pages, reusable modals
 print/ — paperstamp integration + default layout
 dev/ — dev-only seed + self-test (never precached)
scripts/ — gen-shell-assets.sh (SW shell list) + check.sh (node --check every tracked JS; run by pre-commit, warn-only)
.githooks/ — pre-commit (asset list + version bump)

## ENTRY-POINTS
index.html — app shell markup; loads pw.js + src/ui/app.js as modules
src/ui/app.js — boot: openDb → auth gate → router; wires backup/restore/log/test/settings
pw.js — PWA registration; ?dev=1 disables SW + nukes caches; ?forceUpdate=1 bypasses the reload guard + posts a force-update message to the SW (manual test of the update path)
sw.js — service worker; SHELL_ASSETS auto-generated between markers; message handler 'tokenbook-force-update' clears the sentinel + re-checks (dev/manual test only)

## MODULES
core/tabLock.js — single-tab guard via Web Locks API (acquireTabLock); first tab wins, later tabs blocked
core/diag.js — console.warn/error ring buffer (install/recent) + diagnostics snapshot for the Log dialog's Copy button
core/db.js — Dexie singleton. addVisit is THE only visit write entry. Revision tables (people/visits) + projection tables (peopleProj/visitsProj). rebuildProj() recovers from revisions. Split method groups (db.restore.js, db.journal.js) attach to DB.prototype via Object.assign.
core/db.restore.js — replayLog + _replayPerson/_replayVisit/_replayUser/_replaySettings (restoreMethods)
core/db.journal.js — setJournal + _emitJournal* + _emitJournal + _deliverJournal (journalMethods)
core/db.export.js — exportAll + exportAllStream + _logCounts + _appVersion (exportMethods)
core/version.js — APP_VERSION constant (shared by db.js + db.export.js to avoid a cycle)
core/billing.js — follow-up rule + refund tiers + live config (defaultFee, followupWindowDays) via setConfig
core/auth.js — users in IDB; PBKDF2-SHA256 (150k iters); session token in localStorage 'tokenbook-session'; login lockout (5 fails → 5 min) via user.failedLogins/lockedUntil; iter clamped [10k, 5M] on verify; all user inserts via _insertUser (uniqueness enforced)
core/day.js — localDay() 'YYYY-MM-DD'
core/time.js — timeAgo()
backup/backup.js — append-only CSV logbook to user folder (File System Access); daily snapshots + archive rotation
backup/csv.js — schema registry (SCHEMA_USER/PEOPLE/VISITS/SETTINGS); encode/decode; delimiter '|'; timestamps epoch-seconds at file boundary
backup/meta.js — separate IDB 'tokenbook-backup-meta' for the directory handle
ui/app.js — boot sequence + global wiring (backup buttons, log dialog, self-test, settings modal)
ui/auth.js — full-screen gate (login | create-admin)
ui/router.js — tab activation; ROUTES + ADMIN_ONLY
ui/pages/index.js — Pages registry
ui/pages/register.js — Register orchestrator; exports mount/unmount/editVisit/startNewBill/reseedFee
ui/pages/register.ctx.js — shared DOM bag + flags + hook registry (breaks circular imports)
ui/pages/register.billing.js — fee preview, follow-up rule, fee lock
ui/pages/register.autofill.js — name/mob suggest, token/date change, identity revalidation
ui/pages/register.dialogs.js — identity-change + reassign prompts
ui/pages/tokens.js — day/month/range list; row → refund
ui/pages/patients.js — unique patient registry; row → history modal
ui/pages/printLayout.js — paperstamp designer host
ui/pages/users.js — admin user management
ui/history.js — patient visit timeline modal; Enter → edit in Register
ui/revisions.js — revision timeline modal; diff engine; user activity timeline
ui/refund.js — refund dialog; openRefundFor(visit) persists
ui/listNav.js — shared keyboard list/table navigation factory
ui/toast.js — bottom-left auto-dismiss toast; keeps a session ring of recent messages (toastHistory()) shown in the Log dialog
ui/dom.js — tiny DOM helpers (el, bindOff, showModal, highlightRow, ...)
print/ps.js — paperstamp lifecycle singleton; mount/print/preview/openDesigner/reset
print/defaultLayout.js — seed layout when plugin has none

## ARCHITECTURE
- Revisioned append-only entities + per-entity projection. people/visits = truth; peopleProj/visitsProj = current state + indexes.
- Every write appends a revision AND updates the projection in ONE Dexie transaction.
- addVisit (db.js) is the only visit write path; live saves and restores both use it.
- Identity lives on the person revision; visits point via (personId, personV). UI rows join identity from peopleProj.
- hidden = soft delete; projections filtered out; revision tables keep history.
- register.ctx hook registry breaks circular imports between register.* modules.

## SCHEMA
DB 'tokenbook' v1. Stores: people, peopleProj, visits, visitsProj, meta, users, userRevs.
people '[rootId+v], rootId, [name+mob], v, userId'
 rootId v name mob age? gender? weight? hidden createdAt revAt? userId? userV?
peopleProj 'rootId, [name+mob], lastVisitAt, hidden'
 rootId v name mob age gender weight visits lastVisitAt hidden updatedAt
visits '[rootId+v], rootId, [date+token], personId, v, userId'
 rootId v personId personV date token weight? followup payment fee refundTier hidden createdAt revAt? userId? userV?
visitsProj 'rootId, [date+token], date, personId, hidden'
 rootId v personId personV date token weight followup payment fee refundTier hidden createdAt updatedAt
meta 'key' — { key:'singleton', lastDay } | { key:'settings', value:{defaultFee,followupWindowDays} }
users '++id, &username, role, disabled' — id username role salt hash iter disabled sessionToken createdAt updatedAt lastLoginAt
userRevs '[id+v], id, v' — id v username role disabled createdAt revAt

### LOG FORMAT (backup/csv.js — the backup contract)
Delimiter '|'. Line 1 is `#details|TokenBook|<ver>|<iso>|visits=N|people=N|users=N` (human-readable; ignored on parse).
Then a `#head` block (one line per schema): `#head|<name>|<schemaNo>|<col:type>[|<col:type>...]`.
Then one row per appended revision: `<schemaNo>|<value1>|<value2>|...` — positional, matching that schema's #head column order.
Types: str, int, num, epoch, bool; `?` suffix = nullable (e.g. `age:int?`).
Timestamps (createdAt/revAt) are epoch-SECONDS at the file boundary (DB keeps ISO).
SchemaNos: 0 user, 1 people, 2 visits, 3 settings.
NOT in the log: peopleProj/visitsProj (rebuilt on restore), meta (device-local), users secrets (salt/hash/iter/sessionToken).
Unknown schemaNo → row skipped (forward-compatible).

## ENV
No package.json. Dexie loaded from unpkg (runtime-cached). Google Fonts (Inter). paperstamp SDK from downloaddoctor.github.io (own SW — NOT in RUNTIME_HOSTS).
?dev=1 → Seed/Clear buttons + self-test (admin only).

## RUNTIME-GRAPH
index.html → pw.js + src/ui/app.js
app.js → core/db, backup/backup, ui/pages/index, ui/router, ui/toast, ui/dom, core/auth, core/billing, ui/auth
ui/router → pages[tab].mount/unmount
ui/pages/register → core/db, core/billing, print/ps, ui/refund, ui/revisions, register.* siblings

## DEPENDENCIES
Runtime: Dexie 4 (unpkg), paperstamp SDK (iframe), Inter (Google Fonts)
Dev: none (no bundler, no test runner)

## CONFIG
.gitattributes: text=auto eol=lf
.prettierrc: singleQuote, semi, LF, printWidth 100
.githooks/pre-commit: regenerates sw.js SHELL_ASSETS + bumps version.txt sentinel when cached assets staged
Enable once: git config core.hooksPath .githooks

## BUILD
None. Files served as-is. Local: npx http-server -c-1 or python -m http.server 8080.

## TESTING
?dev=1 (admin) → Test button runs src/dev/selftest.js against isolated DB 'tokenbook-devtest' + isolated log. Seed button generates realistic history.
Self-test must remain idempotent — it pre-cleans fixed identities and test-day visits.

## INVARIANTS
- Single-tab only: acquireTabLock() runs FIRST in boot (before openDb + auth gate). A second tab shows a block screen and never touches IDB or the session.
- addVisit is the ONLY visit write entry (live + restore both funnel through it).
- Every write: revision append + projection put in the SAME transaction.
- Projection tables are the read path; revision tables are the truth/audit.
- No-op guards: re-saving unchanged state must not append a revision.
- A paid visit must exclude itself from its own follow-up anchor lookup.
- Backup log is append-only: never rewrite the file body (archive before full rewrite).
- Restore does NOT touch the `users` projection (passwords live there).
- Log carries NO secrets (SCHEMA_USER excludes salt/hash/sessionToken).
- sw.js SHELL_ASSETS between markers is auto-generated — do not hand-edit.
- version.txt is the deploy sentinel; must change on every deploy touching a cached asset.
- src/dev/ is dev-only and never precached.
- Session token lives in localStorage ('tokenbook-session'), so any XSS on the origin = full session takeover. Accepted for the offline single-origin clinic app. Do NOT add third-party scripts to index.html without revisiting this — a compromised CDN would defeat the token model.
- users.username is normalized (trim + uppercase) and its uniqueness is enforced by _insertUser. Any new user-creation path MUST go through _insertUser, not db.raw().users.add directly.

## EXTENSIONS
ADRs live in docs/adr/ (0001 revisions+projections, 0002 single write path, 0003 CSV log format, 0004 single-tab guard).
New entity → add SCHEMA_* in backup/csv.js + KIND_BY_SCHEMA entry + replay handler in db.js + revision/projection stores.
New route → ROUTES + PAGE_ID in ui/router.js + page section in index.html + Pages entry.
New shell asset → tracked file matching CACHED regex in .githooks/pre-commit (hook regenerates sw.js).
Once real data ships: schema bumps MUST be append-only version(N+1) — never renumber a released schema.
