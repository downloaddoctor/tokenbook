// Pure CSV encode/decode + backup payload parsing. No IO.
// Format: flat CSV, one row per visit, delimiter U+2016 (‖) so ordinary
// names never need quoting.

export const CSV_DELIM = '\u2016'; // ‖
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

// Build one CSV line from a _writeVisit result. Used by the append-only
// logbook writer — one line per write, no header rewrite.
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
    refundTier: rec.refundTier != null ? rec.refundTier : '0',
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

export function csvHeaderLine() {
  return CSV_COLS.join(CSV_DELIM);
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (s.includes(CSV_DELIM) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Removed — the logbook writes one line per write, not whole-file dumps.
// Kept as a stub in case something still imports it during the transition.
export const visitsToCsv = null;

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
    const refundRaw = col.refundTier != null ? String(f[col.refundTier] || '').trim() : '';
    const refundTier = ['0', 'R1', 'R2', 'R'].includes(refundRaw) ? refundRaw : '0';
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

// Accepts .csv (default) or legacy .json/{ payload.
export function parseBackup(text, filename = '') {
  const t = text.trim();
  if (/\.json$/i.test(filename) || t.startsWith('{')) {
    const data = JSON.parse(t);
    if (!data || data.schema !== 'doctor-apt-list/patients') {
      throw new Error('Not a doctor-apt-list backup file.');
    }
    if (Array.isArray(data.visits)) {
      // people is ignored — replaceAll rebuilds it from visits.
      return { version: 2, visits: data.visits };
    }
    if (Array.isArray(data.records)) return { version: 1, records: data.records };
    throw new Error('Unrecognized backup contents.');
  }
  return csvToData(text);
}
