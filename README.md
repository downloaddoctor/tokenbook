# TokenBook

[MIT licensed](LICENSE).

An offline-first **token / queue register for a small clinic**. Issue and print
daily tokens, keep a patient registry and visit history, handle free follow-ups
and refunds, and maintain an append-only CSV logbook backed up to a folder you
choose.

No build step, no framework, no server — plain ES modules running entirely in
the browser. Works offline and installs as a PWA.

## Features

- **Register** — issue a token for a patient, auto-fill from history, print it.
- **Follow-ups** — a paid visit within 6 days makes the next visit a free
  follow-up (fee forced to 0). The rule lives in one place (`src/core/billing.js`).
- **Tokens** — per-day list of visits, with per-row refund tiers.
- **Patients** — unique patient registry, drill-in visit history, indexed paging.
- **Backup** — append-only CSV logbook written to a folder you pick (File System
  Access API), with daily snapshots and archived full backups.
- **Offline PWA** — service worker precaches the app shell; a deploy sentinel
  (`version.txt`) drives cache invalidation.
- **Printing** — via the external [paperstamp](https://github.com/downloaddoctor/paperstamp)
  SDK (iframe embed), with an editable default layout.

## Tech

- Vanilla ES modules, no bundler, no npm runtime deps.
- Data in IndexedDB via [Dexie](https://dexie.org) 4 (loaded from unpkg).
- Folder backup via the File System Access API (Chrome/Edge).
- Fonts: Inter (Google Fonts).

## Data model

Revisioned, append-only entities + a per-entity projection.

- **people** (truth) — append-only revisions of a patient's identity, keyed
  `[rootId+v]`. Every edit appends a new revision; nothing is overwritten.
- **visits** (truth) — append-only revisions of a visit, keyed `[rootId+v]`.
  A visit stores no identity of its own — it points at a person via
  `(personId, personV)`, so historical reads show the patient *as they were* at
  visit time.
- **peopleProj / visitsProj** (projections) — one mutable row per `rootId`, the
  current state + indexes used by lists, search, day/range queries, and paging.
  Rebuildable from the revision tables via `db.rebuildProj()`.
- **users / userRevs** — auth. Passwords are PBKDF2-SHA256; secrets live ONLY
  on `users` and are never written to the log or revision tables.

**`db.addVisit()` is the only visit write path.** Live saves and restores both
funnel through it, so the CSV log and the DB can never disagree. Each write
appends a revision **and** updates the projection in one Dexie transaction.

Soft delete: `hidden = 1` on the current revision removes the row from every
list/search/day query. Revision tables keep the full history.

## Backup layout

The backup folder is yours to choose (e.g. a pendrive):

```
tokenbook-latest.csv              live append-only log
daily/
  tokenbook-YYYY-MM-DD.csv        once/day snapshot (30 kept)
archive/
  tokenbook-<timestamp>.csv       prior full backups (30 kept)
```

- Each write **appends** one row (never rewrites the file body).
- On the first open of a date, the whole DB is snapshotted into `daily/`.
- A full backup first moves the old `latest.csv` into `archive/`, then rewrites.
- Restore replays a log through the same write path that produced it.

### Log format

Delimiter `|`. Line 1 is a human-readable `#details` line
(`#details|TokenBook|<ver>|<iso>|visits=N|people=N|users=N`), ignored on parse.
Then a `#head` block declares each schema's column order and types:

```
#head|schema|schemaNo|columns
#head|user|0|id:int|v:int|username:str|role:str|disabled:int|createdAt:epoch|revAt:epoch?
#head|people|1|rootId:int|v:int|name:str|mob:str|age:int?|...
#head|visits|2|rootId:int|v:int|personId:int|personV:int|date:str|token:int|...
#head|settings|3|defaultFee:num|followupWindowDays:int|revAt:epoch?
```

Then one row per appended revision, positional against that schema's `#head`:

```
<schemaNo>|<value1>|<value2>|...
```

Types: `str`, `int`, `num`, `epoch`, `bool`; `?` = nullable.
Timestamps are epoch-seconds at the file boundary (the DB keeps ISO).
Projections, `meta`, and user secrets are **not** in the log — they are rebuilt
or device-local on restore. Unknown `schemaNo` → row skipped (forward-compatible).

## Keyboard shortcuts

| Keys | Action |
|------|--------|
| `Ctrl+1..4` | Switch tabs |
| `Alt+1..4` | Switch + focus primary input |
| `Alt+N` | New visit |
| `Alt+S` | Save & print (Register) |
| `Alt+R` | Refund the loaded visit |
| `Alt+H` | History for the form's patient |
| `Alt+L` | Log dialog |
| `Alt+B` | Backup |

## Run locally

```sh
# VS Code Live Server, or any static server:
npx http-server -c-1
python -m http.server 8080
```

Then open the served URL. Add `?dev=1` for the Seed/Clear buttons and the
self-test (Test button).

## Development notes

- **No build step.** Files are served as-is.
- **Enable the git hook once** (bumps the deploy sentinel and regenerates the
  service-worker asset list on commit):

  ```sh
  git config core.hooksPath .githooks
  ```

- **Service worker asset list** is auto-generated by
  `scripts/gen-shell-assets.sh` (run by the pre-commit hook) between the
  `SHELL_ASSETS:BEGIN/END` markers in `sw.js`. Don't hand-edit it.
- **`version.txt`** is the deploy sentinel and must change on every deploy that
  touches a cached asset — the hook does this automatically.
- **`src/dev/`** (seed, self-test) is dev-only and never precached.

## License

[MIT](LICENSE) © TokenBook contributors.
