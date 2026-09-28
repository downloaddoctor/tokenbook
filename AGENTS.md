# PROJECT
TokenBook — token/queue register for a doctor's practice.
Vanilla ES modules, no build step, no framework, no bundler.
Client-only: all data in browser IndexedDB (Dexie). Printing via external paperstamp SDK (iframe embed).
Offline PWA (service worker + manifest), hosted on GitHub Pages.
Deploy invariant: version.txt MUST be bumped on every deploy that changes a cached shell asset.
  SW reads it as the deploy sentinel. .githooks/pre-commit does this automatically.
  Enable once: git config core.hooksPath .githooks
Save invariant: token + patient ID are corrected at SAVE, not on change.
  A token with no visit at (day, token) is discarded -> nextTokenForDate(day).
  A patient ID matching no person is discarded -> new patient (matched by name+mob).

# DIRECTORY
src/core/       persistence + domain logic (db, day, time, billing, auth)
src/ui/         boot, auth gate, router, DOM helpers, toast, reusable modals (history, refund)
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
index.html -> src/ui/app.js      boot: open DB -> auth gate -> bootAuthed(router)bootAuthed settings load          db.getSettings() -> billing.setConfig (defaultFee, followupWindowDays)
Settings button (topbar ⚙ svg)   admin-only modal (wireSettings) -> db.setSettings + setConfig + reseedFeebootAuthed(router)               ONLY runs with a session: hideGate, applySessionToShell (Users tab + whoami + Logout),
                                 backup init, storage.persist, router.activateTab, ?dev=1 tools. Re-runnable across logout/login.
auth gate (app.js)               requireAuth() -> create-admin (0 users) | login | authed -> bootAuthed
Logout (topbar)                  core/auth.logout() then showAuthGate -> bootAuthed
Alt+H (app.js)                   history modal for current form patient (dynamic import ui/history.js)
Alt+L (app.js)                   Log dialog (clicks btn-log) — admin only (no-op for non-admins)
Alt+B (app.js)                   Backup (clicks btn-backup)
Alt+R (register)                 refund dialog for loaded visit (paid only) via ui/refund.js
Alt+V (register)                 revision history for loaded visit via ui/revisions.js (needs a saved visit)
Alt+N                            new visit (via router onNewBill)
Alt+S (register)                 submit form (Alt+S while Register mounted)
Ctrl+1..5                        switch tabs; Alt+1..5 switch + focus primary input (Users tab only for admins)
?dev=1                           shows Seed/Clear buttons (dynamic import src/dev/seed.js)
Test button                      runs dev self-test (dynamic import src/dev/selftest.js)

# MODULES
core/db.js       class DB; default export = instance (import db); rawDb() -> Dexie for bulk tools.
                 ONLY public write entry: addVisit(). Each write APPENDS a revision
                 ([rootId+v]) to people/visits AND puts peopleProj/visitsProj.
                 Reads of current state use the projections; history uses revisions.
core/day.js      localDay() -> 'YYYY-MM-DD' in browser TZ
core/time.js     timeAgo(when, {compact, fallback}) -> relative string
core/billing.js  follow-up window + default fee; single source for form + DB + seed.
                 Live config via setConfig({defaultFee, followupWindowDays}); getters defaultFee()/followupWindowDays()/getConfig().
                 Constants FOLLOWUP_WINDOW_DAYS=6 / DEFAULT_FEE=300 are FALLBACKS only — app.js loads meta['settings'] at boot.
                 evaluateFollowup({lastPaidDays, explicit, baseFee}) -> {followup, fee, auto}
                 isWithinFollowupWindow(days), followupDaysLeft(days), normalizeFee(fee)
ui/app.js        boot + global buttons (backup/restore/log/test); topbar wiring; Alt+H/L/B handler; boot() wrapped in .catch (fatal toast)
ui/router.js     ROUTES=['register','tokens','patients','printLayout','users'], hash sync, Alt/Ctrl+1..N shortcuts; getRouter()/setRouter() module holder so pages can switch tabs. ADMIN_ONLY set + createRouter({canAccess}) gate admin-only routes: a non-admin request is rewritten to 'register' and the hash resynced (typed hash cannot bypass). app.js supplies canAccess from a cached sessionIsAdmin flag.
ui/dom.js        el (byId) + bindOff (listener collector) + highlightRow/clearHighlight (row-highlight primitives) + isTypingTarget/isDialogOpen (keydown guards) + showModal (dialog->returnValue Promise) + showError; re-exports timeAgo (canonical: core/time.js)
ui/listNav.js    createListNav(cfg) — shared keyboard list/table nav (arrows/Home/End/Enter/Escape). Optional header(search)/footer(pager) handoff; body nav always on. Used by history, revisions, tokens, patients.
ui/toast.js      class Toast; default export = singleton; named toast/clearToast = bound methods
ui/history.js    reusable patient-history modal; openHistory(personId), closeHistory(); row nav via ui/listNav + Enter -> editVisit. Rows come from visitsForPerson (current revisions + joined identity). "Identity revisions" button -> openRevisions('person', id).
ui/revisions.js  reusable revision-history modal; openRevisions(entity, rootId), closeRevisions(); timeline of every appended revision (newest first) + per-step diff (diffRevisions); shows rev.revAt (write time), not createdAt. Opened from ui/refund.js (visit) and ui/history.js (person), and Alt+V on Register. Also openUserActivity(userId, username): one user's patient+visit changes merged newest-first (account changes excluded); called from a Users-page row click.
ui/refund.js     reusable refund dialog; openRefundDialog(visit)->tier|null; openRefundFor(visit) writes DB; refundLabel(tier)
ui/pages/index.js       Pages registry {register, tokens, patients, printLayout, users}
ui/pages/register.js    orchestrator: mount/unmount, submitBill, startNewBill, editVisit, loadVisitIntoForm; exports __setTestHooks/__getForm/__submitForTest
ui/pages/register.ctx.js      shared DOM bag (getB/setB) + flags (getFlags) + cross-module hook registry (setHook/call)
ui/pages/register.billing.js  fieldValues, refreshPreview, applyFollowupRule, setFollowupNote, lockFee/unlockFee, onFollowupChange
ui/pages/register.autofill.js name/mob suggest list, pickPerson, identity revalidation, token/date handlers; exports hideSuggests, refreshNextToken, bindAutofill
ui/pages/register.dialogs.js  identity-change / reassign prompts (pure DOM, no shared state)
ui/pages/tokens.js      Day/Month/Range list + per-row refund dialog (db.listByDate / listByDateRange)
ui/pages/patients.js    patient registry + drill-in history modal
ui/pages/printLayout.js paperstamp full designer
ui/pages/users.js       admin-only user management: list/create/disable/reset; hides own Disable; reset self -> re-gate. Row click -> openUserActivity (that user's patient+visit changes). Reached only via the admin-only 'users' route.
core/auth.js            PBKDF2-SHA256 (150k iter, 16B salt, 32B key) + session. Only writer of the `users` store.
                        requireAuth() -> {state:'create-admin'|'login'|'authed', user}. currentUser() verifies localStorage
                        session token against users.sessionToken (rotation invalidates other tabs). logout() clears both.
ui/auth.js              full-screen auth gate rendered into #auth-root (not a router page). showAuthGate({onAuthed}),
                        hideGate(); shell (#app-topbar/#main/#statusbar) hidden while locked. Create-admin vs Login by needsFirstAdmin().
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
backup button -> pickOrBackup -> setFolder (ALWAYS opens picker) -> writeFullBackup
  archiveLatest moves existing latest.csv -> archive/tokenbook-<timestamp>.csv (keep 30) BEFORE overwrite
  db.exportAllStream pages by [date+token] key range (.above(lastKey)) -> latest.csv; never one big string
  snapshotDaily writes daily/tokenbook-<date>.csv once/day (keep 30); taken on init() when permission granted AND in writeFullBackup/flush (idempotent)
restore button -> (folder set?) restoreFromFolder : file picker -> csvToLog -> db.replayLog -> addVisit({preserve}) -> _writeVisit(log=false)
Test button -> runSelfTest -> register (form driver) -> tokens refund dialog -> DB/log/replay checks -> cleanup -> drop isolated DB

# SCHEMA
DB tokenbook (Dexie v1 + v2 users) — revisioned, append-only entities + projections.
(No prior version shipped; a leftover pre-revision DB is dumped to JSON then
recreated on first open.)
Dexie `.stores()` declares ONLY the primary key + indexed fields. IndexedDB is
schemaless — columns are whatever the code writes. Full column lists below.

 people  ('[rootId+v], rootId, [name+mob], v')
   rootId     int     PK1  stable person id
   v          int     PK2  revision (1,2,3,...)
   name       string       UPPER, trimmed
   mob        string
   age        int|null
   gender     string|null  '' when unknown
   weight     num|null
   hidden     0|1          per-revision soft delete
   createdAt  iso          when THIS revision was written
   -- append-only identity history. No visit data here.

 peopleProj  ('rootId, [name+mob], lastVisitAt, hidden')
   rootId     int     PK
   v          int          current revision's v
   name       string
   mob        string
   age        int|null
   gender     string|null
   weight     num|null
   visits     int          count of current (non-hidden) visits
   lastVisitAt iso|null    max visit updatedAt
   hidden     0|1
   updatedAt  iso
   -- one row per person root. Source of truth for every list/search/point read.

 visits  ('[rootId+v], rootId, [date+token], personId, v')
   rootId     int     PK1  stable visit id
   v          int     PK2  revision
   personId   int          -> people.rootId
   personV    int          people.v pinned at THIS visit revision's write time
   date       'YYYY-MM-DD'
   token      int
   weight     num|null     per-visit fact (NOT identity)
   followup   0|1
   payment    0|1          0=Cash 1=UPI
   fee        num
   refundTier int          0..N; amount = N*100
   hidden     0|1
   createdAt  iso          when the VISIT was first created (immutable)
   revAt      iso          when THIS revision was written
   -- append-only. NO name/mob/age/gender — identity lives on people.

 visitsProj  ('rootId, [date+token], date, personId, hidden')
   rootId     int     PK
   v          int          current revision's v
   personId   int
   personV    int
   date       'YYYY-MM-DD'
   token      int
   weight     num|null
   followup   0|1
   payment    0|1
   fee        num
   refundTier int
   hidden     0|1
   createdAt  iso          original visit creation time (immutable across edits)
   updatedAt  iso          last write time
   -- one row per visit root. read-side joins identity from peopleProj/
      people revision (listByDate / visitsForPerson).

 meta  ('key')
   key        string  PK   'singleton' | 'settings'
   lastDay    'YYYY-MM-DD'|null  daily-snapshot idempotency (key='singleton')
   value      { defaultFee, followupWindowDays }  (key='settings', app prefs)
   -- 'singleton' is app-only. 'settings' IS logged (schemaNo 3) so a restore
      carries billing policy.

 users  ('++id, &username, role, disabled')   [Dexie v2, added for auth] — CURRENT-STATE projection
   id           int     PK  autoincrement
   username     string  UNIQUE, UPPER-cased
   role         'admin'|'user'
   salt, hash   string  base64 (PBKDF2-SHA256, 150k iter); SECRETS, never logged
   iter         int     PBKDF2 iteration count
   disabled     0|1
   sessionToken string  rotated on login/reset; SECRET, never logged
   createdAt, updatedAt, lastLoginAt  iso

 userRevs  ('[id+v], id, v')   [Dexie v3] — append-only user history
   id           int     PK1  -> users.id
   v            int     PK2  revision
   username, role, disabled, createdAt, revAt
   -- NO secrets. Logged as schemaNo 0. Rebuilds attribution after a restore;
      the `users` projection (with secrets) is NEVER cleared/overwritten by replay.
   id           int     PK  autoincrement
   username     string  UNIQUE, UPPER-cased
   role         'admin'|'user'  ('user' = all except Print Layout + Users + Users)
   salt, hash   string  base64 (PBKDF2-SHA256, 150k iter)
   iter         int     PBKDF2 iteration count (per-row, forward-compatible)
   disabled     0|1
   sessionToken string  rotated on login/reset; '' = no live session
   createdAt, updatedAt, lastLoginAt  iso
   -- NOT revisioned, NOT in the CSV log, NOT backed up. Auth is local-only;
      a restore wipes people/visits but leaves users intact.

DB tokenbook-backup-meta, store kv: { key: 'dirHandle', value: FileSystemDirectoryHandle }

# LOG FORMAT (schemaNo-tagged, delimiter '|', timestamps epoch-seconds)
 Head block (one per schema, typed columns):
   #head|schema|schemaNo|columns
   #head|user|0|id:int|v:int|username:str|role:str|disabled:int|createdAt:epoch|revAt:epoch?
   #head|settings|3|defaultFee:num|followupWindowDays:int|revAt:epoch?   (singleton, one line/backup)
   #head|people|1|rootId:int|v:int|name:str|mob:str|age:int?|gender:str?|weight:num?|hidden:int|createdAt:epoch|revAt:epoch?|userId:int?|userV:int?
   #head|visits|2|rootId:int|v:int|personId:int|personV:int|date:str|token:int|weight:num?|followup:int|payment:int|fee:num|refundTier:int|hidden:int|createdAt:epoch|revAt:epoch?|userId:int?|userV:int?
 userId/userV = acting user + its revision at that write (audit; nullable for pre-auth rows).
 Users are logged WITHOUT secrets (no salt/hash/iter/sessionToken) as schemaNo 0, append-only [id+v].
 Data line = `schemaNo|value1|value2|...` in the declared column order.
 Only revision tables are logged. peopleProj/visitsProj/meta are NEVER in the log.
 Restore = replay revisions (insert [rootId+v], idempotent), then rebuildProj().
 Unknown schemaNo → line skipped (forward-compatible). Types: str/int/num/epoch/bool.
 A `?` suffix marks a nullable column (e.g. `weight:num?`). Never use `|` in a spec — it is the delimiter.
 Daily snapshot daily/tokenbook-YYYY-MM-DD.csv (first open of the date); KEEP_SNAPSHOTS = 30.
 Prior full backups archived to archive/tokenbook-<timestamp>.csv; KEEP_ARCHIVES = 30.

# ENV
Browser-only; no server, no env vars.
Folder backup requires File System Access API (Chrome/Edge).
Fallback when unsupported: CSV download via db.exportAll.
`?dev=1` → pw.js unregisters the SW and deletes tokenbook-* caches, then skips
  registration. Dev sessions always see fresh files (no cache-first shell).
localStorage keys: tokenBook.selectedLayoutId (paperstamp), tokenbook-reload-guard (pw.js), tokenbook-session (auth).

# DEPENDENCIES
Dexie 4.0.11 (ESM from unpkg; cached cross-origin by sw.js)
Inter (Google Fonts; cached cross-origin by sw.js). body uses tabular-nums globally.
paperstamp SDK (external <script> from downloaddoctor.github.io; excluded from sw.js because it ships its own SW)
No npm runtime deps; package-lock.json is dev tooling only.

# PUBLIC-API
db (core/db.js default): openDb, addVisit, setVisitRefund(rootId,tier), setVisitBilling(rootId,{...}),
  hideVisit/unhideVisit/setVisitHidden(rootId,0|1), rebuildProj, replayLog,
  exportAll, exportAllStream, listByDate, listByDateRange, listByDateRangePage, countByDateRange, totalsByDateRange, listAll, listPeople, searchPeopleByPrefix/Name/Mob,
  visitCountsForPeople, visitsForPerson, revisionsOf(entity,rootId), findVisitByDateToken,
  lastPaidVisitDaysFor, nextTokenForDate, getPerson, findPersonByNameMob,
  getSettings, setSettings(patch),
  setJournal, setActor(fn), appendUserRevision(user,{log}), userRevisions(id),
  activityForUser(userId,{offset,limit}) -> {items,total,hasMore} (plain userId index, newest-first),
  refundAmountFor, localDay, raw (-> Dexie),
  deleteVisitsByDate, deletePerson, deletePeopleByNameMob, setDbName, deleteDb (DEV/TEST)
  addVisit input keys: name, mob, age?, gender?, personId?, date, token, weight, followup,
    payment, fee, refundTier, preserve?  (preserve carries { rootId, v, personId, personV,
    hidden, createdAt } for restore)
  Return shapes (load-bearing): findVisitByDateToken -> { visit, person, proj } where `visit`
    is identity-joined; addVisit -> { rec, created, person } (rec identity-joined);
    listByDate/visitsForPerson -> rows with identity joined.
  Row identity: DB rows use `rootId` (NOT `id`). `id` only appears on DOM dataset attrs.
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
index.html CSP meta: max protection — script-src has NO 'unsafe-inline'. The only inline
  script allowed is VS Code Live Server's injected reload snippet, pinned by its sha256 hash
  (dev-only; absent on GitHub Pages). If Live Server updates and injects different bytes,
  console reports a new hash -> paste it into script-src.
  Other origins: unpkg (Dexie), fonts.googleapis/gstatic, downloaddoctor.github.io (SDK iframe).
  style-src keeps 'unsafe-inline' for the layout designer's style attributes.
  SRI intentionally omitted (Google Fonts CSS varies by UA; SDK unversioned; Dexie via import()).

# BUILD
None. Serve files statically; ES modules load directly in the browser.

# TESTING
No test suite. Manual: ?dev=1 Seed/Clear; Test button runs dev self-test (isolated DB + log).

# KNOWN-INVARIANTS
addVisit is the ONLY write entry; live and restore funnel into _writeVisit.
_writeVisit(rec, nowIso, log=true) journals itself; restore passes log=false (never re-appends to the log it reads).
Journal buffers per Dexie transaction; released on 'complete', dropped on abort/error — rolled-back writes never reach the log.
people projection = { visits count, lastVisitAt = max createdAt }. Identity is NOT derived from visits.
identity ownership: name/mob/age/gender/weight live ONLY on people revisions. Visits point at them via (personId, personV). No identity is ever copied onto a visit.
Every write APPENDS: people/visits get a new [rootId+v] row; peopleProj/visitsProj get a put. Revision rows are never mutated. The projection is the only mutable state and it is rebuildable from revisions (rebuildProj).
The CURRENT revision of a root = MAX(v). Current reads go through the projection tables; history/audit reads go through the revision tables.
`hidden` (0|1) is per-revision and is soft delete. A hidden current revision disappears from all list/search/day queries. Hide = append rev with hidden=1; unhide = append rev with hidden=0.
0-visit people are KEPT (visits=0); orphans are NOT deleted by app code.
deleteVisitsByDate / deletePerson / deletePeopleByNameMob / db.setDbName / db.deleteDb / backup.setLogFileName / backup.deleteLog are DEV/TEST ONLY. Hard delete removes all revisions for a rootId AND its projection row.
A leftover pre-revision DB (different PK) makes Dexie throw UpgradeError on open; openDb dumps every store to a JSON download, then deletes and recreates. No silent data loss.
Follow-up window = 6 calendar days anchored on last PAID visit; fee forced to 0 when followup=1.
Rule lives ONLY in core/billing.js (evaluateFollowup); register form, db._resolveBilling, and dev/seed all call it.
Refund tier N: amount = N*100. 0 = none. Refunds do NOT touch the fee field. setVisitRefund takes a ROOT id (not a DB row id).
Log is append-only; delimiter '|'; timestamps epoch-seconds; schema is declared once per entity in the #head block.
Restore = replayLog over parsed ops; clears all four stores + inserts revisions verbatim (idempotent on [rootId+v]); rebuilds projections. Returns {count, skipped, skippedRows}; skippedRows carry {lineNo, reason, raw}.
Public helper return shapes are load-bearing: csvToLog/parseBackup return {ops, skippedRows} (not an array); replayLog(ops, {onProgress}). findVisitByDateToken returns {visit, person, proj}; addVisit returns {rec, created, person}. Changing any of these requires updating backup.js, ui/*.js, dev/selftest.js.
DB rows use `rootId`; `.id` is reserved for DOM dataset attributes. Any code reading `.id` on a DB row is a bug.
flush() serialized via _flushPromise; backupNow never no-ops; append verified by byte-length.
Backup button ALWAYS opens the picker (pickOrBackup -> setFolder -> writeFullBackup). Auto-backup (markDirty) appends to the current folder.
init() probes persisted handle (validateHandle) and clears it if stale (isStaleHandleError).
hasFsAccess is a NAMED export of backup.js; backup.hasFsAccess is undefined.
restore calls resetPendingForRestore() so stale journal lines can't re-append.
Identity collision on (name, mob) throws DuplicateIdentityError (register) or ConstraintError (Dexie).
Roles are 'admin' | 'user' (normalizeRole).
Every people/visits revision is stamped with the acting user: userId + userV (int pair, mirrors personId+personV). db.setActor(fn) is wired once in app.js from currentUserSync(). Null for pre-auth rows.
User writes (create/disable/enable/reset) append a userRevs revision + emit a 'user' journal op. Secrets (salt/hash/iter/sessionToken) are NEVER in userRevs or the CSV.
replayLog replays 'user' ops into userRevs only; the `users` projection (secrets) is NOT cleared — a restored user keeps its local password, or gets a secret-less stub an admin must reset.
Auth is client-only, local-only: users live in the `users` store; passwords are PBKDF2-SHA256 (WebCrypto) — never stored in plaintext.
First run (users count = 0) ALWAYS shows Create-Admin regardless of hash/URL; creating it auto-logs in as admin.
app.js boots the shell ONLY after requireAuth() returns authed; the auth gate is not a router page and cannot be bypassed by hash.
Session = localStorage 'tokenbook-session' {userId, token, exp}; currentUser() re-reads the user row and compares tokens — login/reset/disable on ANY tab invalidates other tabs on their next check.
Admin-only routes = {printLayout, users} (router.ADMIN_ONLY). Users (role='user'): Users AND Print Layout tabs are hidden, and both routes bounce to Register (via router canAccess + applySessionToShell bounce).
Statusbar roles: 'user' sees ONLY Backup. Restore/Log/Test (#btn-restore/#btn-log/#btn-test) are hidden by applySessionToShell; dev Seed/Clear are (a) only created for admins even with ?dev=1, and (b) tagged .dev-only so a role change hides them. Alt+L (Log) is a no-op for non-admins; Alt+B (Backup) works for all. #file-restore is a programmatic-only picker, ALWAYS hidden — never toggle it (else it renders as a native Choose File). Print Layout is admin-only because it exposes the paperstamp designer.
users store is NOT revisioned, NOT journaled, NOT in the CSV backup, and is untouched by restore.
seed.js bypasses addVisit by design (bulk) and MUST write all four stores (people, peopleProj, visits, visitsProj); uses `date` and `rootId` like the live path. It emits ONE revision (v=1) per entity. If addVisit's projection logic changes, update seed to match.
Key names uniform: `date` (not day), `personId` (not patId) across DB, journal, log, API.
Self-test isolation: db.setDbName('tokenbook-devtest') + backup.setLogFileName('tokenbook-latest-devtest.csv'); DB dropped + name/log restored after. Runs on the current local day.

# EXTENSION-POINTS
Module shape: stateful modules export a class + a default instance; call sites import the
  default (`import db from './db.js'`) and call methods. Pure helpers (dom.js, day.js, time.js,
  csv.js) stay as named function exports.
Add a page: create src/ui/pages/<name>.js exporting { mount, unmount }; register in
  src/ui/pages/index.js; add to ROUTES + PAGE_ID in src/ui/router.js.
Default print layout: edit src/print/defaultLayout.js.
Log format: SCHEMA_PEOPLE / SCHEMA_VISITS in src/backup/csv.js define the #head column order and types. Keep the encoder (personRevToLogLine / visitRevToLogLine) and decoder (csvToLog) in sync via those constants. Adding a column = new entry in `cols`; old readers ignore unknown trailing columns.
Journal consumers: db.setJournal(fn) (currently: backup._markDirty).
Self-test: src/dev/selftest.js runSelfTest({onProgress, confirmReplay, router}); test hooks gate print/dialogs.
Backup dir handle: backup/meta.js (its own IDB, not Dexie).
