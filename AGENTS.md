# PROJECT
TokenBook — token/queue register app for a doctor's practice
Vanilla ES modules, no build step, no framework
Runs entirely client-side; all data in browser IndexedDB
Printing delegated to external paperstamp SDK (iframe embed)

# DIRECTORY
src/core/      persistence + domain logic
src/ui/        pages, router, DOM helpers, boot
src/ui/pages/  one module per route
src/backup/    folder/CSV backup + journal replay
src/print/     paperstamp lifecycle + default layout
src/dev/       dev-only seed/clear + selftest (opt-in, not prod)
styles.css     single global stylesheet
index.html     single page shell; all views are <section> toggles

# ENTRY-POINTS
index.html -> src/ui/app.js          boot: open DB, init backup, wire router, tab hotkeys
Alt+H (app.js)  open history modal for the patient id in the Register form (dynamic import ui/history.js)
index.html loads paperstamp SDK from downloaddoctor.github.io
?dev=1 query    enables Seed/Clear buttons (dynamic import src/dev/seed.js)
Test button     runs dev self-test (dynamic import src/dev/selftest.js) -> #test-dialog

# MODULES
core/db.js      class DB; default export = instance (`import db`); rawDb() -> Dexie for bulk tools; ONLY public write is addVisit -> _writeVisit
core/day.js     localDay() -> 'YYYY-MM-DD' in browser TZ
ui/app.js       boot, topbar tabs, backup/restore/log buttons; default-imports db + backup
ui/router.js    ROUTES registry, hash sync, Ctrl+1..4 / Alt+N; getRouter()/setRouter() module holder (app.js sets it) so pages can switch tabs
ui/dom.js       el/on/bindOff/timeAgo helpers
ui/toast.js     class Toast; default export = instance; named exports toast/clearToast are bound methods
ui/pages/*.js   register, tokens, patients, printLayout (each {mount,unmount})
ui/history.js   reusable patient-history modal (visit timeline); openHistory(personId), closeHistory(); own DOM + keyboard nav + Enter -> editVisit in Register; opened by Patients rows and Register Alt+H
dev/selftest.js   dev self-test: drives real register form + tokens refund dialog; verifies DB/log/replay
ui/pages/register.js test hooks __setTestHooks/__getForm/__submitForTest (dev only; default prod behavior)
print/ps.js     class Paperstamp; default export = singleton instance (`import ps`); host moves between pages
print/defaultLayout.js  seed layout pushed when plugin has none
backup/backup.js  class Backup; default export = instance (`import backup`); FSA folder backup; journal -> append CSV; flush serialized; named export hasFsAccess (Feature-detect; import it, NOT backup.hasFsAccess)
backup/csv.js     pure CSV encode/decode for the log format
backup/meta.js    class Meta; default export = instance (`import meta`); separate IDB for the directory handle

# RUNTIME-GRAPH
app.js -> db.openDb() -> Dexie (tokenbook)
app.js -> backup.init() -> db.setJournal(markDirty); validates persisted handle, clears if stale
backup button -> pickOrBackup -> setFolder (always opens picker) -> writeFullBackup (whole DB -> latest.csv + daily snapshot)
register submit -> db.addVisit() -> _writeVisit(log=true) -> journal -> backup.flush()
  -> PS.print() -> paperstamp iframe -> onDone
router.activateTab -> pages[name].mount()/unmount()
restore -> backup reads latest.csv/snapshot -> csvToLog -> db.replayLog -> addVisit({preserve}) -> _writeVisit(log=false)
Test button -> runSelfTest -> register (form driver, print suppressed) -> tokens refund dialog -> DB/log/replay checks -> cleanup

# SCHEMA
DB tokenbook (Dexie)
 people: '++id, name, mob, [name+mob], updatedAt'
   unique identity = (name, mob); holds latest age/gender/weight
   visits: count of that person's visits (O(1) maintained)
   lastVisitAt: max(visit.createdAt); undefined for pre-v3 rows
 visits: '++id, mob, createdAt, date, [date+token], personId'
   historical snapshot of name/mob/age/gender at time of visit
   unique key = (date, token); personId -> people.id
   `date` = 'YYYY-MM-DD' local day; single field (no duplicate `day`)
DB tokenbook-backup-meta, store kv: holds FileSystemDirectoryHandle under 'dirHandle'

# ENV
Browser-only; no server, no env vars
Requires File System Access API for folder backup (Chrome/Edge)
Fallback when unsupported: CSV download via db.exportAll
localStorage: tokenBook.selectedLayoutId (paperstamp layout choice)

# DEPENDENCIES
Dexie 4.0.11 (ESM from unpkg, no bundler)
paperstamp SDK (external script tag)
No npm runtime deps; package-lock.json present (dev tooling only)

# PUBLIC-API
db (default export of core/db.js, instance of DB): openDb, addVisit, setVisitRefund, replayLog ({count,skipped}),
  exportAll, listByDate, listAll, listPeople, searchPeople*, visitsForPerson,
  findVisitByDateToken, lastPaidVisitDaysFor, nextTokenForDate, setJournal, refundAmountFor
  addVisit input keys: name, mob, personId?, date, token, weight, followup, payment, fee, refundTier
backup (default export of backup/backup.js, instance of Backup): init, setFolder, pickOrBackup,
  writeFullBackup, flush, backupNow, restoreFromFolder, restoreFromFileObject, readLog, downloadCsv, state,
  setLogFileName, deleteLog
ps (default export of print/ps.js, instance of Paperstamp): mount, reset, preview(fieldValues, opts?), print,
  openDesigner(opts?), closeDesigner, listLayouts, designerMinimal()
  mount() takes {minimal} (default false) — Register passes minimal:true, Print Layout leaves it
  full; ps threads {minimal} into every openDesigner/setDesignerLayout call
  preview() and print() pass paperstamp options { keepZoom: true } by default so the
  plugin's zoom/pan is preserved (no reset to Fit); queued jobs carry options through flush()
meta (default export of backup/meta.js, instance of Meta): get, set, del
rawDb() (named export of core/db.js): current Dexie instance for bulk tools (seed.js)
register page: editVisit(visit) loads a visit into the form for editing (used by Tokens Enter); startNewBill; test hooks __setTestHooks({suppressPrint,bypassLayoutCheck}), __getForm, __submitForTest

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
people projection = {visits count, lastVisitAt=max createdAt}; identity is NOT derived from visits
identity ownership: current name/mob/age/gender/weight set only by explicit edits (_touchPerson/_applyIdentity, last-edited wins) or on gaining a newest visit (_bumpPersonOnGain); _recomputePerson never rewrites identity (would revert renames)
addVisit fast path: linked personId + unchanged name/mob skips [name+mob] lookup and clash check (plain edits do no identity resolution)
0-visit people are KEPT (visits=0, identity preserved); orphans are NOT deleted by app code
deletePeopleByNameMob(name,mob) deletes a person row exactly — DEV/TEST ONLY (self-test cleanup)
Follow-up window = 6 calendar days anchored on last PAID visit; fee forced to 0 when followup=1
Log is append-only; one full self-describing row per write; delimiter '|'; timestamps epoch-seconds
Log columns (LOG_COLS): date token personId name mob age gender weight followup payment fee refundTier createdAt updatedAt
Key names are uniform: `date` (not day), `personId` (not patId) across DB, journal, log, API
Restore = replayLog over log lines; clear both stores in one rw transaction; skips bad rows (returns {count,skipped})
flush() is serialized (_flushPromise); backupNow never no-ops; append verified by byte length
Backup button (pickOrBackup) ALWAYS opens the picker via setFolder; setFolder does a FULL DB write
  (writeFullBackup -> latest.csv overwrite + daily snapshot), not an append; auto-backup (markDirty) still appends
init() probes the persisted folder handle (validateHandle) and clears it if stale (isStaleHandleError)
hasFsAccess is a named export of backup.js; `backup.hasFsAccess` is undefined — always import the named binding
restore resets pending journal/timer (resetPendingForRestore) so stale lines can't re-append
Refund tier N: amount = N * 100; 0 = none; fee untouched by refunds
Identity collision on (name, mob) throws DuplicateIdentityError / ConstraintError
seed.js bypasses _writeVisit by design (bulk) and must mirror its projection and use `date`

# EXTENSION-POINTS
Module shape: stateful modules export a class + a default instance; call sites import
  the default (`import db from './db.js'`) and call methods on it. Pure helpers (dom.js,
  day.js, csv.js) stay as named function exports.
Add a page: create src/ui/pages/<name>.js exporting {mount,unmount}; register in
  src/ui/pages/index.js and add to ROUTES + PAGE_ID in src/ui/router.js
Default print layout: edit src/print/defaultLayout.js
Log format: LOG_COLS in src/backup/csv.js (keep parse/encode in sync; header rename is breaking)
Journal consumers: db.setJournal(fn)
Self-test: src/dev/selftest.js runSelfTest({onProgress,confirmReplay,router}); register test hooks gate print/dialogs
Self-test isolation: db.setDbName('tokenbook-devtest') + backup.setLogFileName('tokenbook-latest-devtest.csv'); DB dropped + name/log restored after; runs on current local day; replay auto-runs (no confirm — isolated)
db.setDbName/deleteDb + backup.setLogFileName/deleteLog are DEV/TEST ONLY (self-test isolation)
Backup dir handle: backup/meta.js (its own IDB, not Dexie)
