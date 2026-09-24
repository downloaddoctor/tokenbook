# PROJECT
TokenBook — token/queue register for a doctor's practice.
Vanilla ES modules, no build step, no framework, no bundler.
Client-only: all data in browser IndexedDB (Dexie). Printing via external paperstamp SDK (iframe embed).
Offline PWA (service worker + manifest), hosted on GitHub Pages.
Deploy invariant: version.txt MUST be bumped on every deploy that changes a cached shell asset.
  SW reads it as the deploy sentinel. .githooks/pre-commit does this automatically.
  Enable once: git config core.hooksPath .githooks

# DIRECTORY
src/core/       persistence + domain logic (db, day, time, billing)
src/ui/         boot, router, DOM helpers, toast, reusable modals (history, refund)
src/ui/pages/   one module per route (register, tokens, patients, printLayout)
src/backup/     FSA folder backup, CSV log codec, folder-handle meta store
src/print/      paperstamp lifecycle + default layout
src/dev/        dev-only seed/clear + selftest (opt-in, never imported by prod)
index.html      SPA shell; all views are <section hidden> toggles
styles.css      single global stylesheet
sw.js           service worker (precache SHELL_ASSETS + sentinel update check)
pw.js           SW registration + update-reload UX (30s localStorage guard)
manifest.webmanifest + favicon.svg   PWA metadata + icon
version.txt     deploy sentinel (NOT precached)

# ENTRY-POINTS
index.html -> pw.js              PWA bootstrap (registers sw.js)
pw.js -> sw.js                   precache + sentinel update check
sw.js sentinel = ./version.txt   HEAD validator diff decides which assets refetch
index.html -> src/ui/app.js      boot: open DB, init backup, wire router, tab hotkeys
Alt+H (app.js)                   history modal for current form patient (dynamic import ui/history.js)
Alt+L (app.js)                   Log dialog (clicks btn-log)
Alt+B (app.js)                   Backup (clicks btn-backup)
Alt+R (register)                 refund dialog for loaded visit (paid only) via ui/refund.js
Alt+N                            new visit (via router onNewBill)
Alt+S (register)                 submit form (Alt+S while Register mounted)
Ctrl+1..4                        switch tabs; Alt+1..4 switch + focus primary input
?dev=1                           shows Seed/Clear buttons (dynamic import src/dev/seed.js)
Test button                      runs dev self-test (dynamic import src/dev/selftest.js)

# MODULES
core/db.js       class DB; default export = instance (import db); rawDb() -> Dexie for bulk tools.
                 ONLY public write entry: addVisit(). All writes (live + restore) funnel into _writeVisit.
core/day.js      localDay() -> 'YYYY-MM-DD' in browser TZ
core/time.js     timeAgo(when, {compact, fallback}) -> relative string
core/billing.js  follow-up window + default fee; single source for form + DB + seed
                 FOLLOWUP_WINDOW_DAYS=6, DEFAULT_FEE=300
                 evaluateFollowup({lastPaidDays, explicit, baseFee}) -> {followup, fee, auto}
                 isWithinFollowupWindow(days), followupDaysLeft(days), normalizeFee(fee)
ui/app.js        boot + global buttons (backup/restore/log/test); topbar wiring; Alt+H/L/B handler; boot() wrapped in .catch (fatal toast)
ui/router.js     ROUTES, hash sync, keyboard shortcuts; getRouter()/setRouter() module holder so pages can switch tabs
ui/dom.js        el/on/bindOff/setText/setClass helpers; re-exports timeAgo
ui/toast.js      class Toast; default export = singleton; named toast/clearToast = bound methods
ui/history.js    reusable patient-history modal; openHistory(personId), closeHistory(); own DOM + keyboard nav + Enter -> editVisit
ui/refund.js     reusable refund dialog; openRefundDialog(visit)->tier|null; openRefundFor(visit) writes DB; refundLabel(tier)
ui/pages/index.js       Pages registry {register, tokens, patients, printLayout}
ui/pages/register.js    form + autofill + submit + print; exports editVisit, startNewBill, __setTestHooks/__getForm/__submitForTest
ui/pages/tokens.js      day list + per-row refund dialog
ui/pages/patients.js    patient registry + drill-in history modal
ui/pages/printLayout.js paperstamp full designer
print/ps.js             class Paperstamp; default export = singleton; host moves between pages (never destroyed until reset)
print/defaultLayout.js  seed layout pushed when plugin has none
backup/backup.js        class Backup; default export = instance; append-only journal -> CSV; named export hasFsAccess
backup/csv.js           pure CSV codec; LOG_COLS is the only format
backup/meta.js          class Meta; default export = instance; separate IDB for the directory handle
dev/seed.js             bulk seed/clear (rawDb direct writes); mirrors _writeVisit projection; ?dev=1 only
dev/selftest.js         runSelfTest({onProgress, confirmReplay, router}); isolated DB + log; drives real UI

# RUNTIME-GRAPH
app.js -> db.openDb() -> Dexie('tokenbook')
app.js -> backup.init() -> db.setJournal(markDirty); validates persisted handle, clears if stale
register submit -> db.addVisit() -> _writeVisit(log=true) -> journal -> backup.markDirty -> debounced flush() -> append latest.csv
  -> ps.print() -> paperstamp iframe -> onDone
router.activateTab(name) -> pages[name].unmount() (prev) then mount() (next)
backup button -> pickOrBackup -> setFolder (ALWAYS opens picker) -> writeFullBackup (db.exportAllStream -> latest.csv overwrite + daily snapshot; streamed, never one big string)
restore button -> (folder set?) restoreFromFolder : file picker -> csvToLog -> db.replayLog -> addVisit({preserve}) -> _writeVisit(log=false)
Test button -> runSelfTest -> register (form driver) -> tokens refund dialog -> DB/log/replay checks -> cleanup -> drop isolated DB

# SCHEMA
DB tokenbook (Dexie v1)
 people: '++id, name, mob, [name+mob], updatedAt, lastVisitAt'  (v2)
   identity = (name, mob), unique via [name+mob]
   visits: count projection (O(1) maintained by _bump/_touch/_recompute)
   lastVisitAt: max(createdAt over visits); undefined for pre-projection rows
   age/gender/weight: latest known values (last explicit edit wins)
 visits: '++id, mob, createdAt, date, [date+token], personId, [personId+createdAt]'  (v2)
   unique key = (date, token); personId -> people.id
   historical snapshot of name/mob/age/gender/weight at time of visit
   date = 'YYYY-MM-DD' local day (single field; no legacy `day`)
DB tokenbook-backup-meta, store kv: { key: 'dirHandle', value: FileSystemDirectoryHandle }

# LOG FORMAT (LOG_COLS, delimiter '|', timestamps epoch-seconds)
 date token personId name mob age gender weight followup payment fee refundTier createdAt updatedAt
 Every line is a full self-describing visit row (never depends on earlier lines).
 Header written once at file creation; daily snapshot tokenbook-YYYY-MM-DD.csv.
 KEEP_SNAPSHOTS = 30. Append is byte-length verified.

# ENV
Browser-only; no server, no env vars.
Folder backup requires File System Access API (Chrome/Edge).
Fallback when unsupported: CSV download via db.exportAll.
localStorage keys: tokenBook.selectedLayoutId (paperstamp), tokenbook-reload-guard (pw.js).

# DEPENDENCIES
Dexie 4.0.11 (ESM from unpkg; cached cross-origin by sw.js)
Inter (Google Fonts; cached cross-origin by sw.js). body uses tabular-nums globally.
paperstamp SDK (external <script> from downloaddoctor.github.io; excluded from sw.js because it ships its own SW)
No npm runtime deps; package-lock.json is dev tooling only.

# PUBLIC-API
db (core/db.js default): openDb, addVisit, setVisitRefund, replayLog, exportAll, exportAllStream,
  listByDate, listAll, listPeople, searchPeopleByPrefix/Name/Mob, visitCountsForPeople,
  visitsForPerson, findVisitByDateToken, lastPaidVisitDaysFor, nextTokenForDate, getPerson,
  setJournal, refundAmountFor, localDay, raw (-> Dexie), setDbName/deleteDb (DEV/TEST)
  addVisit input keys: name, mob, personId?, date, token, weight, followup, payment, fee, refundTier, preserve?
backup (backup/backup.js default): init, setFolder, pickOrBackup, writeFullBackup, flush, backupNow,
  restoreFromFolder, restoreFromFileObject, readLog, pendingLines, downloadCsv, state,
  setLogFileName, deleteLog (last two DEV/TEST)
backup named: hasFsAccess (import it, NOT backup.hasFsAccess)
ps (print/ps.js default): mount(host, {force, autoShow, openDesignerOnReady, seedDefaultOnReady, minimal}),
  reset, preview(fields, opts?), print(fields, onPrinted?), openDesigner(opts?), closeDesigner,
  listLayouts(cb), setSelectedLayoutId, designerMinimal
meta (backup/meta.js default): get, set, del
rawDb() (core/db.js named): current Dexie instance for bulk tools
register page: editVisit(visit), startNewBill(nextToken?, resetDate?), __setTestHooks, __getForm, __submitForTest

# CONFIG
.prettierrc: singleQuote, semi, printWidth 100, eol lf, trailingComma es5
.gitattributes: * text=auto eol=lf
index.html CSP meta: default-src self; script-src needs 'unsafe-inline' (paperstamp SDK injects an inline bootstrap).
  Other origins: unpkg (Dexie), fonts.googleapis/gstatic, downloaddoctor.github.io (SDK iframe).
  SRI intentionally omitted (Google Fonts CSS is UA-dependent; SDK ships its own SW).

# BUILD
None. Serve files statically; ES modules load directly in the browser.

# TESTING
No test suite. Manual: ?dev=1 Seed/Clear; Test button runs dev self-test (isolated DB + log).

# KNOWN-INVARIANTS
addVisit is the ONLY write entry; live and restore funnel into _writeVisit.
_writeVisit(rec, nowIso, log=true) journals itself; restore passes log=false (never re-appends to the log it reads).
Journal buffers per Dexie transaction; released on 'complete', dropped on abort/error — rolled-back writes never reach the log.
people projection = { visits count, lastVisitAt = max createdAt }. Identity is NOT derived from visits.
identity ownership: current name/mob/age/gender/weight set only by explicit edits (_touchPerson/_applyIdentity) or when a person gains their newest visit (_bumpPersonOnGain). _recomputePerson never rewrites identity (would revert renames).
addVisit fast path: linked personId + unchanged name/mob skips [name+mob] lookup AND clash check.
0-visit people are KEPT (visits=0, identity preserved); orphans are NOT deleted by app code.
deletePeopleByNameMob / db.setDbName / db.deleteDb / backup.setLogFileName / backup.deleteLog are DEV/TEST ONLY.
Follow-up window = 6 calendar days anchored on last PAID visit; fee forced to 0 when followup=1.
Rule lives ONLY in core/billing.js (evaluateFollowup); register form, db._resolveBilling, and dev/seed all call it.
Refund tier N: amount = N*100. 0 = none. Refunds do NOT touch the fee field.
Log is append-only; delimiter '|'; timestamps epoch-seconds; header rename is breaking.
Restore = replayLog over log lines; clears both stores in one rw transaction; skips bad rows (returns {count, skipped}).
flush() serialized via _flushPromise; backupNow never no-ops; append verified by byte-length.
Backup button ALWAYS opens the picker (pickOrBackup -> setFolder -> writeFullBackup). Auto-backup (markDirty) appends to the current folder.
init() probes persisted handle (validateHandle) and clears it if stale (isStaleHandleError).
hasFsAccess is a NAMED export of backup.js; backup.hasFsAccess is undefined.
restore calls resetPendingForRestore() so stale journal lines can't re-append.
Identity collision on (name, mob) throws DuplicateIdentityError (register) or ConstraintError (Dexie).
seed.js bypasses _writeVisit by design (bulk) and MUST mirror its projection; uses `date` like the live path.
Key names uniform: `date` (not day), `personId` (not patId) across DB, journal, log, API.
Self-test isolation: db.setDbName('tokenbook-devtest') + backup.setLogFileName('tokenbook-latest-devtest.csv'); DB dropped + name/log restored after. Runs on the current local day.

# EXTENSION-POINTS
Module shape: stateful modules export a class + a default instance; call sites import the
  default (`import db from './db.js'`) and call methods. Pure helpers (dom.js, day.js, time.js,
  csv.js) stay as named function exports.
Add a page: create src/ui/pages/<name>.js exporting { mount, unmount }; register in
  src/ui/pages/index.js; add to ROUTES + PAGE_ID in src/ui/router.js.
Default print layout: edit src/print/defaultLayout.js.
Log format: LOG_COLS in src/backup/csv.js (keep parse/encode in sync; header rename is breaking).
Journal consumers: db.setJournal(fn) (currently: backup._markDirty).
Self-test: src/dev/selftest.js runSelfTest({onProgress, confirmReplay, router}); test hooks gate print/dialogs.
Backup dir handle: backup/meta.js (its own IDB, not Dexie).
