# TODO — logbook backup refactor (IN PROGRESS)

Status: mid-refactor. `backup.js` was rewritten cleanly but a verification
step is pending — the linter was reporting stale errors, so the file needs a
manual re-read to confirm it's actually clean on disk.

## Goal

Append-only logbook backup + full-replay restore.

- Every `addVisit` / `setVisitRefund` appends ONE line to `apt-list-latest.csv`.
- No rewriting of the log body.
- Header line written once, when the file is first created.
- At the first write of each day, copy the whole `latest.csv` to
  `apt-list-YYYY-MM-DD.csv`; prune to newest 30.
- Restore = wipe DB, read the log in file order, and replay each line through
  the SAME functions that produced it: `addVisit` (op=1) and
  `setVisitRefund` (op=2). Correctness over speed — 10 minutes is fine.
- Legacy files (old snapshot CSVs, JSON payloads) also restore, via the
  compatibility branches already in `csv.js::csvToLog` and
  `db.js::replaceAll`.

## Log line format

`csv.js::LOG_COLS` — delimiter U+2016 (‖):

```
op ‖ date ‖ token ‖ patId ‖ name ‖ mob ‖ age ‖ gender ‖ weight ‖ followup ‖ payment ‖ fee ‖ refundTier
```

- `op=1` visit (the input to addVisit, so replay re-derives identically)
- `op=2` refund edit (only date, token, refundTier matter; rest blank)
- `patId` is the id the operator had at save time (blank for new patients).
  Replay passes it back so ids are preserved when the log has one.

## What is DONE (verify on disk)

- [x] `csv.js` — rewritten for the logbook: `LOG_COLS`, `csvHeaderLine`,
      `visitInputToLogLine`, `refundInputToLogLine`, `csvToLog`,
      `parseBackup` (JSON + legacy CSV fallbacks), `OP_VISIT`/`OP_REFUND`.
- [x] `db.js` — `setJournal` hook + `_emitJournal(entry)`; `addVisit` and
      `setVisitRefund` both emit input-shaped entries (op 1 / op 2);
      `replayLog(ops)` added (silences the journal while replaying);
      `replaceAll(data)` is a thin alias that converts legacy
      `{visits}`/`{records}` payloads to ops then calls `replayLog`;
      `exportAll()` returns `{ text, count }` (a fresh log CSV);
      `PatientDb` exports `setJournal`, `replayLog`, `replaceAll`, `exportAll`.
      Lint: **No errors found.**
- [x] `backup.js` — full rewrite: `_pending` queue, `_needsHeader`,
      `appendText`, `flush()` appends (never rewrites), daily snapshot copies
      `latest.csv` on first write of the day, `markDirty(entry)` is the
      journal target, `init()` calls `PatientDb.setJournal(markDirty)`,
      `restoreFromFolder`/`restoreFromFileObject` both use
      `csvToLog`/`parseBackup` -> `PatientDb.replayLog`.
- [x] `register.js` — removed the now-redundant `PatientBackup.markDirty()`
      call after submit (the journal covers it).

## What is PENDING

- [x] **Re-read `backup.js` on disk — VERIFIED CLEAN.** The mangled
      lines are gone; `flush()`, `restoreFromFolder`, `restoreFromFileObject`
      all read correctly. Linter agreed (no errors).¦

Now finish the remaining cleanup. First, delete the dead `visitsToCsv` from `csv.js`:

⟦replace
- [x] **Delete `visitsToCsv` from `csv.js`** — done; replaced by a
      `null` stub (nothing imports it anymore).
- [x] **Confirm `downloadCsv`** — reads `PatientDb.exportAll()` -> `{ text, count }`;
      `backup.js` passes `data.text` to the Blob. OK.
- [x] **`app.js`** — only uses `downloadCsv`, `pickOrBackup`,
      `restoreFromFolder`, `state`, `init`. All still exported. No changes
      needed. `init()` wires the journal via `PatientDb.setJournal(markDirty)`.

## Next session: start here

1. Run the app with `?dev=1`, click Clear, seed ~200 visits.
2. Save a few extra visits manually with refund tiers.
3. Copy `apt-list-latest.csv` from the backup folder to a scratch location.
4. Clear again (dev button).
5. Restore — verify visit count, patient count, and refund tiers match.
6. If OK: commit. If not: the replay path is where to look
   (`db.js::replayLog` / `backup.js::restoreFromFolder`).¦

⟦cmd¦run=git status --short¦run=git diff --stat
- [ ] **Dev seed (`src/dev/seed.js`)** — it calls
      `PatientDb.replaceAll({ version: 2, visits })`. That still works via the
      alias, but the seed also has an in-memory `people` list that's no
      longer used. Clean up or leave; behaviour is correct either way.
- [ ] **Test restore round-trip end to end:**
      1. Fresh boot, save 5 visits (some with refund tiers).
      2. Copy `apt-list-latest.csv` from the backup folder.
      3. `Clear` (dev) or wipe IndexedDB manually.
      4. Restore from the same folder — visit count, people projection, and
         refund tiers must match exactly.
- [ ] **Test legacy restore** — feed an old-format snapshot CSV (13-col
      header, no `op` column) through Restore. `csvToLog` should treat every
      line as op=1 and replay via `addVisit`.
- [ ] **Update `AGENTS.md`** once stable: logbook format, journal hook,
      replay semantics, `replayLog`/`exportAll` signatures, and the
      `backup.js` rewrite. Add a "single write path" note about `_emitJournal`
      being called from `addVisit`/`setVisitRefund` only.
- [ ] **Commit** with a clear message once the round-trip test passes.

## Known caveats / accepted tradeoffs

- Restore is O(N) replays — slow for a big log, by design (correctness over
  speed). Progress reporting is not implemented; for a very large log the
  tab may appear frozen. Consider a progress toast later.
- The log grows unbounded within a day. Daily snapshots are whole-file, and
  `latest.csv` is the only append target; if it ever needs truncation,
  implement `setFolder`/day-rollover truncation explicitly (currently
  `_needsHeader = true` is set on `setFolder`, but nothing truncates
  `latest.csv`).
- `people.lastVisitAt` may be undefined for very old rows; `listPeople`
  falls back to `updatedAt` for sorting.

## Session hygiene

- Linter `errors` output has been STALE multiple times this session. When in
  doubt, trust a fresh `read` of the file over an `errors` report.
- If a `replace` reports success but the surrounding errors don't change,
  re-read the target region before doing anything else.
