// Pure CSV encode/decode + backup payload parsing. No IO.
// Format: flat CSV, 1-byte delimiter '|' so the log stays small and
// greppable. csvEscape quotes any value that happens to contain the
// delimiter (names/mobs never do in practice, so no quoting in the common
// case).
//
// Two formats live here:
//   LOG_COLS   — the append-only logbook: one line per write, op-tagged.
//                Restore replays each line through addVisit / setVisitRefund.
//                Every op=1 line is SELF-DESCRIBING (full identity), so a
//                line never depends on earlier lines.
//   CSV_COLS   — the legacy snapshot dump. Still readable via csvToData so
//                old backups restore; no longer written.
//
// Space choices (all reversible at this file boundary):
//   * delimiter is 1 byte, not U+2016 (3 bytes)
//   * timestamps are epoch-seconds, not 24-char ISO strings

export const CSV_DELIM = '|'; // 1 byte

// Logbook op tags. op=1 = visit add, op=2 = refund edit.
export const OP_VISIT = 1;
export const OP_REFUND = 2;

// Refund tier is a small non-negative integer N; the refunded amount is
// N * 100. 0 (or blank) = no refund. Legacy 'R1'/'R2'/'R' read as 1/2/3.
export function normalizeRefundTier(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '' || s === '0') return 0;
  const legacy = { R1: 1, R2: 2, R: 3 };
  if (legacy[s] != null) return legacy[s];
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

// Legacy snapshot columns (pre-logbook whole-file dump). Read-only now.
export const CSV_COLS = [
  'date',
  'token',
  'name',
  'mob',
  'age',
  'gender',
  'weight',
  'followup',
  'payment',
  'fee',
  'refundTier',
  'personId',
  'createdAt',
  'updatedAt',
  // Person projection AFTER this write (the logbook's fast-restore columns).
  'personVisits',
  'personLastVisitAt',
  // Present only when this write reassigned the visit away from a previous
  // owner; the previous owner's projection after the write.
  'prevPersonId',
  'prevPersonVisits',
  'prevPersonLastVisitAt',
];

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

// Legacy snapshot line builder. Kept for tooling; not used by the logbook.
export function journalResultToCsvLine(result) {
  const { rec, person, prevPerson } = result;
  const row = {
    date: rec.day || rec.date,
    token: rec.token,
    name: rec.name,
    mob: rec.mob,
    age: rec.age,
    gender: rec.gender,
    weight: rec.weight,
    followup: rec.followup,
    payment: rec.payment,
    fee: rec.fee,
    refundTier: normalizeRefundTier(rec.refundTier),
    personId: rec.personId,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    personVisits: person ? person.visits : '',
    personLastVisitAt: person ? person.lastVisitAt : '',
    prevPersonId: prevPerson ? prevPerson.id : '',
    prevPersonVisits: prevPerson ? prevPerson.visits : '',
    prevPersonLastVisitAt: prevPerson ? prevPerson.lastVisitAt : '',
  };
  return CSV_COLS.map((k) => csvEscape(row[k])).join(CSV_DELIM);
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

// Legacy headers (pre-v4: no weight/followup/payment/fee; pre-v5: no
// refundTier). Accepted on read so old backups still restore.
const LEGACY_V3_CSV_COLS = ['date', 'token', 'name', 'mob', 'age', 'gender', 'personId', 'createdAt'];
const LEGACY_V4_CSV_COLS = [
  'date',
  'token',
  'name',
  'mob',
  'age',
  'gender',
  'weight',
  'followup',
  'payment',
  'fee',
  'personId',
  'createdAt',
];
export function csvToData(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) throw new Error('Empty backup file.');
  const header = parseCsvLine(lines[0]);
  const matches = (cols) => header.length === cols.length && header.every((h, i) => h === cols[i]);
  const isCurrent = matches(CSV_COLS);
  const isLegacy = matches(LEGACY_V4_CSV_COLS) || matches(LEGACY_V3_CSV_COLS);
  if (!isCurrent && !isLegacy) {
    throw new Error('Not a doctor-apt-list backup (unexpected header).');
  }
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const visits = [];
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    if (f.length < header.length) continue;
    const name = String(f[col.name] || '').trim();
    const mob = String(f[col.mob] || '').trim();
    if (!name && !mob) continue;
    const age = Number(f[col.age]);
    const gender = f[col.gender] == null ? '' : String(f[col.gender]).trim();
    const weightRaw = col.weight != null ? f[col.weight] : '';
    const weight = weightRaw === '' || weightRaw == null ? null : Number(weightRaw);
    const fuRaw = col.followup != null ? f[col.followup] : '';
    const followup = fuRaw === '1' ? 1 : fuRaw === '0' ? 0 : fuRaw === '' ? null : Number(fuRaw) ? 1 : 0;
    const payRaw = col.payment != null ? f[col.payment] : '';
    const payment = payRaw === '1' ? 1 : 0;
    const feeRaw = col.fee != null ? f[col.fee] : '';
    const fee = feeRaw === '' || feeRaw == null ? null : Number(feeRaw);
    const refundTier = col.refundTier != null ? normalizeRefundTier(f[col.refundTier]) : 0;
    const token = Number(f[col.token]);
    const day = f[col.date] || '';
    const createdAt = f[col.createdAt] || new Date().toISOString();
    visits.push({
      name,
      mob,
      age,
      gender,
      weight,
      followup,
      payment,
      fee,
      refundTier,
      token,
      day,
      date: day,
      createdAt,
    });
  }
  // People are not returned — they are a pure projection rebuilt from
  // visits on restore (PatientDb.replaceAll -> _writeVisit).
  return { schema: 'doctor-apt-list/patients', version: 2, visits };
}

// Decode a logbook file (header + op-lines) into replay ops. Accepts the
// current LOG_COLS header, and falls back to the legacy snapshot format so
// old backups still restore through the same replay path.
export function csvToLog(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) throw new Error('Empty backup file.');
  const header = parseCsvLine(lines[0]);
  const matches = (cols) => header.length === cols.length && header.every((h, i) => h === cols[i]);
  if (matches(LOG_COLS)) return parseLogLines(header, lines);
  // Legacy snapshot dump: convert each row into an op=1 visit.
  return snapshotToLog(csvToData(text));
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

// Legacy snapshot -> replay ops. Preserves personId as patId so ids survive.
function snapshotToLog(data) {
  const ops = [];
  for (const v of data.visits || []) {
    ops.push({
      op: OP_VISIT,
      date: v.day || v.date || '',
      token: Number(v.token),
      patId: v.personId != null ? Number(v.personId) : null,
      name: v.name,
      mob: v.mob,
      age: v.age,
      gender: v.gender,
      weight: v.weight,
      followup: v.followup,
      payment: v.payment,
      fee: v.fee,
    });
    const tier = normalizeRefundTier(v.refundTier);
    if (tier > 0) {
      ops.push({ op: OP_REFUND, date: v.day || v.date || '', token: Number(v.token), refundTier: tier });
    }
  }
  return ops;
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Accepts .csv (default) or legacy .json/{ payload.
export function parseBackup(text, filename = '') {
  const t = text.trim();
  if (/\.json$/i.test(filename) || t.startsWith('{')) {
    const data = JSON.parse(t);
    if (!data || data.schema !== 'doctor-apt-list/patients') {
      throw new Error('Not a doctor-apt-list backup file.');
    }
    if (Array.isArray(data.visits)) return snapshotToLog({ visits: data.visits });
    if (Array.isArray(data.records)) return snapshotToLog({ visits: data.records });
    throw new Error('Unrecognized backup contents.');
  }
  return csvToLog(text);
}
