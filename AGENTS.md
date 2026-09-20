# AGENTS

## PROJECT

Static browser app. No build step, no npm, no server.
Cashier enters patient (name, mob, age, gender); app stores in IndexedDB and prints via paperstamp.
Multi-page SPA: top-bar nav-tab buttons swap <section.page> panels; tab clicks sync location.hash so browser back/forward work.

## DIRECTORY

index.html -> app shell (topbar, pages); loads paperstamp SDK (classic) then src/ui/app.js (module)
styles.css -> all styling (topbar, split layouts, tables, ps-host, .kbd)
src/core/day.js -> localDay(date) -> 'YYYY-MM-DD'
src/core/db.js -> window.PatientDb (Dexie-backed IndexedDB wrapper)
src/backup/csv.js -> pure CSV encode/decode + parseBackup (no IO)
src/backup/meta.js -> own IDB apt-list-backup-meta (dirHandle persistence)
src/backup/backup.js -> PatientBackup (File System Access + fallback)
src/print/defaultLayout.js -> defaultLayoutDef() used to seed empty plugin
src/print/ps.js -> PS (paperstamp lifecycle + SDK-backed saved-layout resolver)
src/ui/dom.js -> el, on, bindOff, timeAgo, setText, setClass
src/ui/router.js -> ROUTES, routeFromHash, createRouter (tab + hash + keydown)
src/ui/pages/*.js -> register, tokens, patients, printLayout; each exports {mount,unmount}
src/ui/pages/index.js -> Pages = { register, tokens, patients, printLayout }
src/ui/app.js -> entry: boot, topbar wiring, DB open, backup init, router

## ENTRY-POINTS

index.html -> paperstamp SDK (classic script) + <script type=module src=src/ui/app.js>
src/ui/app.js async IIFE -> router.wire() + topbar button wiring -> PatientDb.openDb() -> PatientBackup.init() -> router.activateTab(routeFromHash())

## MODULES

src/core/db.js (Dexie)
DB doctor-apt-list v3, two stores:
  people: one row per unique (name, mob) identity; index name_mob unique; holds latest age + gender
  visits: one row per token; denormalized name/mob/age/gender snapshot + personId -> people
exports: openDb, localDay, nextTokenForDay, findOrCreatePerson, searchPeopleByMob, searchPeopleByName, addVisit, listByDay, listAll, countAll, listPeople, countPeople, getPerson, searchPeopleByPrefix, visitCountsForPeople, visitsForPerson, replaceAll, exportAll
v1 -> v2 upgrade: none (app not in production; Dexie declares v2 only)
v2 -> v3 upgrade: schema unchanged; adds people.lastVisitAt (no backfill — undefined until next visit)
names are stored uppercase: db.js uppercases `name` on every write path (addVisit, findOrCreatePerson, replaceAll, CSV/legacy import). register.js uppercases on submit + on autofill. #f-name has CSS text-transform:uppercase for display. Searches uppercase the query (searchPeopleByName, searchPeopleByPrefix). mob is left as typed (digits).
visits are the source of truth. people is a derived cache: createdAt=earliest visit, name/mob/age/gender/updatedAt/lastVisitAt=latest visit. Writes to people only from addVisit and rebuildPeopleFromVisits.
addVisit person identity resolution:
  1. patId given and found -> use it; update name/mob/age/gender/lastVisitAt
  2. no patId, (name,mob) matches -> reuse; bump lastVisitAt/updatedAt
  3. otherwise -> create new person (lastVisitAt set)
  rename collision (identity change to an existing other person's [name+mob]) -> throw DuplicateIdentityError
addVisit visit upsert: key = (day, token), day = form's date (or today). If a visit exists at that key -> UPDATE in place (same id, createdAt kept, updatedAt bumped, personId may change); else INSERT.
addVisit returns { rec, created } (created=false -> update path)
people.lastVisitAt -> ISO of most recent visit; set by addVisit, restored/derived by rebuildPeopleFromVisits (called from replaceAll); undefined only if the person has no visits
rebuildPeopleFromVisits() -> re-derives every person row from its visit stream (earliest -> createdAt, latest -> name/mob/age/gender/updatedAt/lastVisitAt). Called from replaceAll after bulk put so CSV/JSON restore is always self-consistent. Exported for devtools/recovery.
visits.updatedAt -> ISO; set on insert (= createdAt) and on every update
visits unique index day_token ensures at most one visit per (day, token) per day
register message uses created flag: "Saved. Token N." (new) vs "Updated. Token N." (existing)
people.updatedAt -> bumped on any person touch (currently every addVisit); kept for compat + sort
addVisit -> appends a visit row (new token each visit) linked via personId
src/backup/csv.js
pure functions: visitsToCsv, csvToData, parseBackup, CSV_DELIM, CSV_COLS
format: flat CSV, one row per visit; delimiter U+2016 (‖); cols date,token,name,mob,age,gender,personId,createdAt
src/backup/meta.js
openMeta/metaGet/metaSet/metaDel over IDB apt-list-backup-meta (store kv)
src/backup/backup.js
owns dirHandle persistence via meta.js (key dirHandle)
single folder leg (typically a pendrive); no local + offsite pair
files in folder: apt-list-latest.csv (rolling) + apt-list-YYYY-MM-DD.csv (once/day, keep 30 newest by pruneSnapshots)
writes are atomic-ish (create-writable then close); failure never blocks a save
init() -> load persisted handle -> queryPermission -> {ok|needs-gesture|unsupported}
pickOrBackup() -> setFolder (first time) | reconnect (perm dropped) | flush (perm granted)
downloadCsv() -> PatientDb.exportAll -> visitsToCsv -> Blob download 'clinic-register-YYYY-MM-DD.csv' (fallback when File System Access unavailable or picker cancelled)
Backup button -> hasFsAccess ? pickOrBackup : downloadCsv; AbortError (picker cancel) also falls back to downloadCsv silently
markDirty() -> debounce 2s -> flush(); visibilitychange->hidden flushes if dirty
flush() -> PatientDb.exportAll -> visitsToCsv -> write latest + today snapshot -> prune
restoreFromFolder() -> read latest.csv | newest snapshot -> parseBackup -> PatientDb.replaceAll
restoreFromFileObject(file) -> upload fallback (.csv or legacy .json)
parseBackup(text,filename) -> .csv (default) | legacy .json/{ -> replaceAll payload (v2 people+visits | v1 records)
csvToData -> rebuilds people by dedup on (name, mob); reassigns personId (CSV personId is informational)
state() -> { hasFolder, folderName, lastAt, lastError } for UI
updateStatus() -> writes #backup-status (ok/err classes)
src/print/ps.js
singleton PaperStamp embed; one lp instance moved between host els
imports defaultLayoutDef from src/print/defaultLayout.js
mount(hostEl,{force,autoShow,openDesignerOnReady,seedDefaultOnReady}) -> embed or no-op if same host
onReady -> listLayouts -> [seedDefaultIfEmpty] -> flush -> if openDesignerOnReady && active -> setDesignerLayout(active) else openDesigner()
pending queue while !ready (print, preview, previewById, printById, designer, closeDesigner, listLayouts)
listLayouts(cb) -> lp.listLayoutDefs() -> caches layoutDefs map {name:layoutDef}
seedDefaultIfEmpty(cb) -> if 0 layouts: import(defaultLayoutDef()) + re-list; then syncActive() sets activeLayoutId to first layout if current missing (seedDefaultOnReady)
selectedLayoutId/setSelectedLayoutId -> in-memory activeLayoutId + localStorage[aptList.selectedLayoutId]
activeLayoutDef -> layoutDefs[activeLayoutId] or null
preview(fv) -> previewById if saved layout active, else no-op; Register calls this on every form input to swap out of designer mode into live preview
print(fv, onPrinted?) -> printById if saved layout active, else status 'no layout selected'; onPrinted queued and fired from SDK onDone (after dialog closes)
saved layouts live in PLUGIN origin localStorage; host is cross-origin so SDK API is required
reset() -> destroy embed, clear host, next mount() re-embeds
src/ui/pages/*.js
Pages = { register, tokens, patients, printLayout } (built in src/ui/pages/index.js)
each: { mount() binds + renders, unmount() removes listeners }
register also exports startNewBill (used by router Alt+N via app.js)
bindOff() from src/ui/dom.js collects (el,type,fn,opts) tuples for clean unmount
page modules import only: core/db.js, print/ps.js, backup/backup.js (register), ui/dom.js — no cross-page imports
register.mount -> PS.mount(register-ps-host, {autoShow:false, openDesignerOnReady:true, seedDefaultOnReady:true}) — designer is the idle state (same mount pattern as Print Layout)
register form 'input' -> refreshPreview -> PS.preview(fv) — swaps host from designer into live preview while typing
register has editable f-date/f-token inputs (pre-filled by refreshNextToken, user can override before submit)
register has Pat ID input (after Gender): typed id -> getPerson -> populate name/mob/age/gender; autofill pick fills it; New Bill clears it; empty falls back to (name,mob) matching at addVisit
register submit passes patId; DuplicateIdentityError -> shows message and aborts (no new person created)
register submit guard: onSubmit sets `submitting` + disables btn-save-print; submitBill is the worker (must NOT re-check `submitting`) — double-guarding makes the button a no-op
register identity-change confirm: if patId set and form name/mob differ from person -> <dialog id=pat-id-confirm> asks Update (keep patId, update person) | Use as new (drop patId, dedup on name+mob) | Cancel (abort). Esc = Cancel. Fails open (returns 'update') if dialog markup missing.
Pat ID echo: after a successful addVisit, rec.personId is written back into f-pat-id (so a just-created patient carries an explicit id on next Save)
register exposes startNewBill() -> clears name/mob/age (gender=M), hides suggests, focuses name, bumps next token; wired to #btn-new-bill click
register submit -> db add -> PS.print(fv, cb); form is NOT reset (host stays on printed values); cb=PS.openDesigner() returns host to idle state after print dialog closes
register.unmount -> PS.reset() (mirrors Print Layout teardown)
tokens.mount -> date filter -> PatientDb.listByDay -> table (one row per visit)
patients.mount -> listPeople (paginated 50, sorted by updatedAt desc) + countPeople; empty search; searchPeopleByPrefix otherwise
patients row -> ID, Name, Mobile, Age, Visits (visitCountsForPeople), Last visit (updatedAt)
patients row click -> history modal -> visitsForPerson(personId) -> table (date, token, age-at-visit, gender-at-visit, time)
patients modal close -> X button, backdrop click, or Escape
people.updatedAt bumped by addVisit -> doubles as "last visit" for the patients list and its sort order
printLayout.mount -> PS.mount(print-layout-ps-host,{autoShow:false,openDesignerOnReady:true,seedDefaultOnReady:true}) -> designer opens with seeded default layout when plugin empty
printLayout.unmount -> PS.reset()
src/ui/router.js
ROUTES: register, tokens, patients, printLayout
createRouter({pages, onNewBill}) -> { activateTab, wire, currentTab }
route id -> DOM section id mapped via PAGE_ID (register->page-register, printLayout->page-print-layout)
activateTab(name, force=false) -> unmount prev -> hide all pages -> show target -> mount next; force re-mounts current tab (used after restore)
wire() -> nav-tab clicks + hashchange + keydown shortcuts
nav-tab buttons (.tabs .nav-tab, data-route attr) -> click -> activateTab(name) -> location.hash synced
hashchange listener -> activateTab(routeFromHash(), false, false) (back/forward support, no loop)
keydown (no meta/shift, exactly one of Ctrl|Alt): Ctrl/Alt+1..4 -> activateTab(ROUTES[n-1]); Alt+N -> activateTab('register') + onNewBill()
<=860px: .topbar wraps, .tabs becomes full-width scrollable row (no hamburger/collapse — topbar replaces the old sidebar)
src/ui/app.js
boot IIFE -> router.wire() -> topbar backup/restore button wiring -> PatientDb.openDb -> PatientBackup.init -> router.activateTab(routeFromHash())
backup/restore buttons -> PatientBackup; restore re-invokes router.activateTab(currentTab, true)

## RUNTIME-GRAPH

module load (end of body) -> src/ui/app.js IIFE -> router.wire() -> PatientDb.openDb -> PatientBackup.init -> router.activateTab(routeFromHash())
nav-tab click -> activateTab(name) -> Pages[prev].unmount -> hide/show sections -> Pages[next].mount
register submit -> PatientDb.nextTokenForDay -> PatientDb.addVisit (reuses/creates person) -> PS.print(fv, cb); form values kept; cb=PS.openDesigner() fires on print done, returning host to idle designer view
# next bill starts via New Bill button or Alt+N -> Pages.register.startNewBill
register form input -> PS.preview(fv) (swaps host out of designer into live preview)
Backup btn -> PatientBackup.pickOrBackup -> setFolder|reconnect|flush
Restore btn -> restoreFromFolder (if handle set) | FILE_RESTORE -> restoreFromFileObject -> router.activateTab(currentTab, true)
register name/mob input -> debounced PatientDb.searchPeopleByName | searchPeopleByMob -> suggestion list -> pick fills name+mob+age -> refreshPreview
tokens mount -> PatientDb.listByDay(day) -> table
patients mount -> PatientDb.listPeople (paged) + visitCountsForPeople -> registry table; row click -> visitsForPerson -> history modal
tokens mount -> PatientDb.listByDay (paged by day) -> visit log table
register mount -> PS.mount(autoShow:false,openDesignerOnReady:true,seedDefaultOnReady:true) -> listLayouts -> seedDefaultIfEmpty -> flush -> setDesignerLayout(active) (identical flow to printLayout mount)
printLayout mount -> PS.mount(autoShow:false,openDesignerOnReady:true,seedDefaultOnReady:true) -> listLayouts -> seedDefaultIfEmpty -> flush -> setDesignerLayout(active)
printLayout unmount -> PS.reset
Backup btn -> PatientBackup.pickOrBackup -> setFolder|reconnect|flush
Restore btn -> restoreFromFolder (if handle set) | FILE_RESTORE -> restoreFromFileObject -> activateTab(currentTab, force=true)
register submit -> addVisit -> PatientBackup.markDirty -> debounce 2s -> flush -> PatientDb.exportAll -> CSV to folder
visibilitychange(hidden) -> if dirty -> flush
boot -> PatientBackup.init -> load handle -> queryPermission -> status line (#backup-status)

## SCHEMA

people record:
id:number (auto)
name:string
mob:string
age:number (latest known)
gender:string M|F|O (latest known; '' if unknown)
createdAt:string ISO
updatedAt:string ISO
visits record:
id:number (auto)
name/mob/age/gender: snapshot at issue time (historical)
token:number (per-day, starts at 1, unique per day)
day:string YYYY-MM-DD local (form's date; the key for upsert)
date:string YYYY-MM-DD local (mirrors day; kept for print field)
createdAt:string ISO (first save)
updatedAt:string ISO (last save; = createdAt on insert)
personId:number -> people.id
unique index day_token=[day,token] on visits; unique index name_mob=[name,mob] on people

## ENV

none. All data client-side.
Backup folder handle persisted in IDB apt-list-backup-meta (kv.dirHandle).
Backup cadence: event-driven only (after DB change, debounced 2s; flush on tab hide). No interval timer.
Backup failure never blocks a save — only the status line changes.
paperstamp layouts persist in localStorage[paperstampLayouts] (paperstamp's own key).
Selected layout id cached in localStorage[aptList.selectedLayoutId].
Saved layoutDefs are NOT in host localStorage (cross-origin plugin); fetched via PS.listLayouts().

## DEPENDENCIES

external: https://downloaddoctor.github.io/paperstamp/sdk.js (paperstamp host SDK v1, loaded as classic script before src/ui/app.js)
external: https://unpkg.com/dexie@4.0.11/dist/modern/dexie.mjs (Dexie 4, ESM)
browser APIs: ES modules, IndexedDB, File System Access API (optional), Blob/URL download fallback

## KNOWN-INVARIANTS

single PC, single browser profile (IndexedDB is per-origin per-profile)
token uniqueness enforced by unique index day_token; on ConstraintError app retries once
person uniqueness enforced by unique index name_mob; addVisit reuses existing person -> one identity per (name, mob), many visits/tokens
people.id is the stable patient id (surfaced as ID in Patients, editable via Pat ID on Register); visits link back via personId
people.updatedAt is bumped on every addVisit; people.lastVisitAt set only by addVisit (pre-v3 rows undefined)
Patients "Last visit" column shows lastVisitAt (falls back to updatedAt); list sorts by updatedAt desc
addVisit identity: patId > (name,mob) match > create; rename to an existing other person's (name,mob) throws DuplicateIdentityError (register shows it, aborts save)
Patients page = people registry (one row per person); Tokens page = per-visit log for a day
history modal reads visitsForPerson(id); visits store age/gender snapshots so history is historically accurate even if the person's age/gender changes later
billing name+mob autofill uses prefix search (searchPeopleByName / searchPeopleByMob); pick fills all three fields
billing date/token are user-editable, not read-only; submit uses form values (falls back to auto-computed if empty)
suggestion dropdowns use mousedown (not click) so pick fires before input blur; outside mousedown hides them
billing form retained after save — user must invoke New Bill (button or Alt+N) to clear identity fields and bump token
keyboard tab shortcuts require exactly one modifier (Ctrl XOR Alt), no meta/shift, to avoid hijacking browser combos
paperstamp prints client-side; window.print() dialog cannot be suppressed without --kiosk-printing
item text rendered via textContent (no HTML injection in field values)
src/print/ps.js owns exactly one lp instance; mount() with a NEW host element destroys + re-embeds (Register and Print Layout hosts differ, so navigating between them re-embeds)
page modules must pair every addEventListener with bindOff for clean unmount
no window globals in code; modules import each other directly (ESM)
index.html loads exactly one module script (src/ui/app.js); paperstamp SDK stays classic
import graph: app -> {router, pages/index, backup, core/db}; pages/* -> {core/db, print/ps, backup (billing), ui/dom}; backup -> {core/db, csv, meta}; print/ps -> defaultLayout; router -> no imports (uses document + Pages passed in)
only one <section.page> visible at a time (activateTab toggles [hidden]; [hidden]{display:none!important} guards #page-print-layout flex)
activateTab(name, force) — force flag re-mounts current tab after destructive ops (restore)
exactly one paperstamp iframe at a time (PS.mount clears other .ps-host containers)

## EXTENSION-POINTS

add fields -> extend src/core/db.js schema (people + visits) + src/backup/csv.js CSV_COLS + src/print/defaultLayout.js items + form inputs + tables
add patient-registry column -> src/ui/pages/patients.js cells array + index.html patients-table header + optional db.js aggregate (like visitCountsForPeople)
add route -> add <section.page id=page-X> + src/ui/pages/X.js {mount,unmount} + register in src/ui/pages/index.js + add to ROUTES in src/ui/router.js
add layout selection UI -> PS.listLayouts(cb), write PS.setSelectedLayoutId (single-layout model: no picker in Billing)
swap storage backend -> replace src/core/db.js, keep PatientDb export surface
swap view layer -> replace src/ui/pages/*.js with Preact components; router expects {mount,unmount} only
swap print backend -> replace src/print/ps.js, keep PS export surface
