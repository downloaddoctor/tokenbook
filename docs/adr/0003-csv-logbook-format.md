# 0003 — CSV logbook format (`#details` + `#head` + positional rows)

Status: Accepted

## Context
Backups must be human-inspectable (a clinic may open the CSV in a spreadsheet),
forward-compatible (older readers must not choke on new fields), and cheap to
append (write one line, never rewrite the file).

## Decision
The log is line-oriented, delimiter `|`, and self-describing per file:

1. Line 1: `#details|TokenBook|<ver>|<iso>|visits=N|people=N|users=N` —
   human-readable summary. Ignored by the parser.
2. A `#head` block, one line per schema:
   `#head|<name>|<schemaNo>|<col:type>[|<col:type>...]`.
   Types: `str`, `int`, `num`, `epoch`, `bool`; `?` = nullable.
3. Body: one row per appended revision — `<schemaNo>|<v1>|<v2>|...`, positional
   against that schema's `#head` column order.

Timestamps are epoch-SECONDS at the file boundary (DB keeps ISO). Projections,
`meta`, and user secrets are NOT in the log; they are rebuilt (projections) or
device-local (meta, secrets). Unknown `schemaNo` rows are skipped, not fatal.

## Consequences
- Adding a column is a new entry in that schema's `cols`; older readers ignore
  unknown trailing columns.
- Rows are positional, so column reordering within a schema is a breaking
  change — never reorder, always append.
- The `#details` counts are advisory only; the body is the source of truth.
- Human-readable in a spreadsheet; greppable in a terminal.

Related: 0001, 0002.
