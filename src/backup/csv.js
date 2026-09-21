// Pure CSV encode/decode for the append-only logbook. No IO.
// Format: flat CSV, 1-byte delimiter '|'. csvEscape quotes any value that
// contains the delimiter (names/mobs never do in practice, so no quoting in
// the common case).
//
// One format: LOG_COLS — one op-tagged line per write. Restore replays each
// line through addVisit / setVisitRefund. Every op=1 line is SELF-DESCRIBING
// (full identity), so a line never depends on earlier lines.
//
// Space choices:
//   * delimiter is 1 byte ('|'), not U+2016 (3 bytes)
//   * timestamps are epoch-SECONDS, not 24-char ISO strings

export const CSV_DELIM = '|'; // 1 byte

// Logbook op tags. op=1 = visit add, op=2 = refund edit.
export const OP_VISIT = 1;
export const OP_REFUND = 2;

// Refund tier is a non-negative integer N; the amount is N * 100.
// 0 (or blank) = no refund.
export function normalizeRefundTier(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '' || s === '0') return 0;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Log line columns. Full rows — every op=1 line carries the complete visit.
export const LOG_COLS = [
  'op',
  'date',
  'token',
  'patId',
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

// Encode one op=1 journal entry. Full self-describing row.
export function visitInputToLogLine(entry) {
  const row = {
    op: entry.op != null ? entry.op : OP_VISIT,
    date: entry.date != null ? entry.date : '',
    token: entry.token != null ? entry.token : '',
    patId: entry.patId != null ? entry.patId : '',
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

// Encode one op=2 refund edit. Only date/token/refundTier carry meaning.
export function refundInputToLogLine(entry) {
  const row = {
    op: OP_REFUND,
    date: entry.date,
    token: entry.token,
    patId: '',
    name: '',
    mob: '',
    age: '',
    gender: '',
    weight: '',
    followup: '',
    payment: '',
    fee: '',
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
    throw new Error('Not a doctor-apt-list log (unexpected header).');
  }
  return parseLogLines(header, lines);
}

function parseLogLines(header, lines) {
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const has = (k) => col[k] != null;
  const ops = [];
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    if (f.length < header.length) continue;
    const op = Number(f[col.op]) === OP_REFUND ? OP_REFUND : OP_VISIT;
    const token = Number(f[col.token]);
    const date = f[col.date] || '';
    if (op === OP_REFUND) {
      ops.push({
        op: OP_REFUND,
        date,
        token,
        refundTier: normalizeRefundTier(f[col.refundTier]),
        updatedAt: fromEpoch(has('updatedAt') ? f[col.updatedAt] : ''),
      });
      continue;
    }
    const patIdRaw = f[col.patId];
    ops.push({
      op: OP_VISIT,
      date,
      token,
      patId: patIdRaw === '' || patIdRaw == null ? null : Number(patIdRaw),
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
export function parseBackup(text) {
  return csvToLog(text);
}
