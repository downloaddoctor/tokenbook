// Pure CSV encode/decode for the append-only logbook. No IO.
// Format: flat CSV, 1-byte delimiter '|'. csvEscape quotes any value that
// contains the delimiter (names/mobs never do in practice, so no quoting in
// the common case).
//
// One format: LOG_COLS. Every line is a FULL self-describing visit row, so a
// line never depends on earlier lines. Restore reads the log in file order
// and replays each row via addVisit({preserve}).
//
// Space choices:
//   * delimiter is 1 byte ('|'), not U+2016 (3 bytes)
//   * timestamps are epoch-SECONDS, not 24-char ISO strings

export const CSV_DELIM = '|'; // 1 byte

// Refund tier is a non-negative integer N; the amount is N * 100.
// 0 (or blank) = no refund.
export function normalizeRefundTier(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '' || s === '0') return 0;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Log line columns. Every line is a complete visit row.
export const LOG_COLS = [
  'date',
  'token',
  'personId',
  'name',
  'mob',
  'age',
  'gender',
  'weight',
  'followup',
  'payment',
  'fee',
  'refundTier',
  'createdAt',
  'updatedAt',
];

// ISO <-> epoch-SECONDS at the file boundary. The DB keeps ISO strings; only
// the log file uses seconds.
export function toEpoch(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return Math.floor(v / 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : '';
}
export function fromEpoch(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? new Date(n * 1000).toISOString() : null;
}

// Encode one journal entry. Full self-describing visit row.
// One key everywhere: the DB row, the journal emit, and the log column all
// use `personId`. Callers can pass the stored visit row verbatim.
export function visitInputToLogLine(entry) {
  const row = {
    date: entry.date != null ? entry.date : '',
    token: entry.token != null ? entry.token : '',
    personId: entry.personId != null ? entry.personId : '',
    name: entry.name != null ? entry.name : '',
    mob: entry.mob != null ? entry.mob : '',
    age: entry.age != null ? entry.age : '',
    gender: entry.gender != null ? entry.gender : '',
    weight: entry.weight != null ? entry.weight : '',
    followup: entry.followup != null ? entry.followup : '',
    payment: entry.payment != null ? entry.payment : '',
    fee: entry.fee != null ? entry.fee : '',
    refundTier: normalizeRefundTier(entry.refundTier),
    createdAt: toEpoch(entry.createdAt),
    updatedAt: toEpoch(entry.updatedAt),
  };
  return LOG_COLS.map((k) => csvEscape(row[k])).join(CSV_DELIM);
}


// Header for the logbook (what exportAll / append writers emit).
export function csvHeaderLine() {
  return LOG_COLS.join(CSV_DELIM);
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (s.includes(CSV_DELIM) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') {
      q = true;
    } else if (ch === CSV_DELIM) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Decode a logbook file (header + op-lines) into replay ops.
export function csvToLog(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) throw new Error('Empty backup file.');
  const header = parseCsvLine(lines[0]);
  const matches = (cols) => header.length === cols.length && header.every((h, i) => h === cols[i]);
  if (!matches(LOG_COLS)) {
    throw new Error('Not a tokenbook log (unexpected header).');
  }
  return parseLogLines(header, lines);
}

function parseLogLines(header, lines) {
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const has = (k) => col[k] != null;
  const ops = [];
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    // Short row = malformed / truncated write. Skip it rather than let it
    // abort the entire atomic restore.
    if (f.length < header.length) continue;
    const token = Number(f[col.token]);
    const date = f[col.date] || '';
    // A row must have a valid (date, token) to be replayable. Blank personId
    // is also fatal for a row: replay keys on it, so a row without one is a
    // corrupt line — skip it in parseLogLines rather than throw mid-replay.
    const personIdRaw = f[col.personId];
    const personId = personIdRaw === '' || personIdRaw == null ? null : Number(personIdRaw);
    if (!date || !Number.isInteger(token) || token < 1 || personId == null) continue;
    ops.push({
      date,
      token,
      personId,
      name: String(f[col.name] || '').trim(),
      mob: String(f[col.mob] || '').trim(),
      age: numOrNull(f[col.age]),
      gender: String(f[col.gender] || '').trim(),
      weight: numOrNull(f[col.weight]),
      followup: f[col.followup] === '' ? null : f[col.followup] === '1' ? 1 : 0,
      createdAt: fromEpoch(has('createdAt') ? f[col.createdAt] : ''),
      updatedAt: fromEpoch(has('updatedAt') ? f[col.updatedAt] : ''),
      payment: f[col.payment] === '1' ? 1 : 0,
      fee: numOrNull(f[col.fee]),
      refundTier: col.refundTier != null ? normalizeRefundTier(f[col.refundTier]) : 0,
    });
  }
  return ops;
}

// Accepts a log CSV and returns replay ops. (Logbook only — no legacy formats.)
// A .json file (accepted by the picker for legacy convenience) will fail the
// header check and surface the friendly csvToLog error.
export function parseBackup(text) {
  return csvToLog(text);
}
