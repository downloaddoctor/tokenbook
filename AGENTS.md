# PROJECT
Clinic register + token/queue app for a doctor's practice
Vanilla ES modules, no build step, no framework
Runs entirely client-side; all data in browser IndexedDB
Printing delegated to external paperstamp SDK (iframe embed)

# DIRECTORY
src/core/      persistence + domain logic
src/ui/        pages, router, DOM helpers, boot
src/ui/pages/  one module per route
src/backup/    folder/CSV backup + journal replay
src/print/     paperstamp lifecycle + default layout
src/dev/       dev-only seed/clear (opt-in, not prod)
styles.css     single global stylesheet
index.html     single page shell; all views are <section> toggles

# ENTRY-POINTS
index.html -> src/ui/app.js          boot: open DB, init backup, wire router, tab hotkeys
index.html loads paperstamp SDK from downloaddoctor.github.io
?dev=1 query    enables Seed/Clear buttons (dynamic import src/dev/seed.js)

# MODULES
core/db.js      Dexie wrapper; ONLY public write is addVisit -> _writeVisit
core/day.js     localDay() -> 'YYYY-MM-DD' in browser TZ
ui/app.js       boot, topbar tabs, backup/restore/log buttons
ui/router.js    ROUTES registry, hash sync, Ctrl+1..4 / Alt+N
ui/dom.js       el/on/bindOff/timeAgo helpers
ui/toast.js     transient bottom-left notifications
ui/pages/*.js   register, tokens, patients, printLayout (each {mount,unmount})
print/ps.js     singleton paperstamp embed manager; host moves between pages
print/defaultLayout.js  seed layout pushed when plugin has none
backup/backup.js  File System Access folder backup; journal -> append CSV; flush serialized
backup/csv.js     pure CSV encode/decode for the log format
backup/meta.js    separate IDB for persisting the directory handle

# RUNTIME-GRAPH
app.js -> PatientDb.openDb() -> Dexie (doctor-apt-list)
app.js -> PatientBackup.init() -> PatientDb.setJournal(markDirty)
register submit -> PatientDb.addVisit() -> _writeVisit(log=true) -> journal -> backup.flush()
  -> PS.print() -> paperstamp iframe -> onDone
router.activateTab -> pages[name].mount()/unmount()
restore -> backup reads latest.csv/snapshot -> csvToLog -> PatientDb.replayLog -> addVisit({preserve}) -> _writeVisit(log=false)

# SCHEMA
DB doctor-apt-list (Dexie)
 people: '++id, name, mob, [name+mob], updatedAt'
   unique identity = (name, mob); holds latest age/gender/weight
   visits: count of that person's visits (O(1) maintained)
   lastVisitAt: max(visit.createdAt); undefined for pre-v3 rows
 visits: '++id, mob, createdAt, date, [date+token], personId'
   historical snapshot of name/mob/age/gender at time of visit
   unique key = (date, token); personId -> people.id
   `date` = 'YYYY-MM-DD' local day; single field (no duplicate `day`)
DB apt-list-backup-meta, store kv: holds FileSystemDirectoryHandle under 'dirHandle'

# ENV
Browser-only; no server, no env vars
Requires File System Access API for folder backup (Chrome/Edge)
Fallback when unsupported: CSV download via PatientDb.exportAll
localStorage: aptList.selectedLayoutId (paperstamp layout choice)

# DEPENDENCIES
Dexie 4.0.11 (ESM from unpkg, no bundler)
paperstamp SDK (external script tag)
No npm runtime deps; package-lock.json present (dev tooling only)

# PUBLIC-API
PatientDb (core/db.js): openDb, addVisit, setVisitRefund, replayLog ({count,skipped}),
  exportAll, listByDate, listAll, listPeople, searchPeople*, visitsForPerson,
  findVisitByDateToken, lastPaidVisitDaysFor, nextTokenForDate, setJournal, refundAmountFor
  addVisit input keys: name, mob, personId?, date, token, weight, followup, payment, fee, refundTier
PatientBackup (backup/backup.js): init, setFolder, pickOrBackup, flush, backupNow,
  restoreFromFolder, restoreFromFileObject, readLog, downloadCsv, state
PS (print/ps.js): mount, reset, preview, print, openDesigner, closeDesigner, listLayouts

# CONFIG
.prettierrc: singleQuote, semi, printWidth 100, eol lf, trailingComma es5
.gitattributes: * text=auto eol=lf

# BUILD
None. Serve files statically; ES modules load directly from browser.

# TESTING
No test suite. Manual via ?dev=1 Seed/Clear buttons.

# KNOWN-INVARIANTS
addVisit is the ONLY write entry point; both live and restore funnel into _writeVisit
_writeVisit(rec, nowIso, log=true) journals the committed row itself; restore passes log=false
Journal buffered per Dexie transaction; released on 'complete', dropped on 'abort'/'error'
  (rolled-back writes never reach the log)
people projection = {visits count, lastVisitAt=max createdAt, newest visit's identity}
Follow-up window = 6 calendar days anchored on last PAID visit; fee forced to 0 when followup=1
Log is append-only; one full self-describing row per write; delimiter '|'; timestamps epoch-seconds
Log columns (LOG_COLS): date token personId name mob age gender weight followup payment fee refundTier createdAt updatedAt
Key names are uniform: `date` (not day), `personId` (not patId) across DB, journal, log, API
Restore = replayLog over log lines; clear both stores in one rw transaction; skips bad rows (returns {count,skipped})
flush() is serialized (_flushPromise); backupNow never no-ops; append verified by byte length
restore resets pending journal/timer (resetPendingForRestore) so stale lines can't re-append
Refund tier N: amount = N * 100; 0 = none; fee untouched by refunds
Identity collision on (name, mob) throws DuplicateIdentityError / ConstraintError
seed.js bypasses _writeVisit by design (bulk) and must mirror its projection and use `date`

# EXTENSION-POINTS
Add a page: create src/ui/pages/<name>.js exporting {mount,unmount}; register in
  src/ui/pages/index.js and add to ROUTES + PAGE_ID in src/ui/router.js
Default print layout: edit src/print/defaultLayout.js
Log format: LOG_COLS in src/backup/csv.js (keep parse/encode in sync; header rename is breaking)
Journal consumers: PatientDb.setJournal(fn)
Backup dir handle: backup/meta.js (its own IDB, not Dexie)
