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
];

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (s.includes(CSV_DELIM) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function visitsToCsv(visits) {
  const sorted = [...visits].sort((a, b) => {
    if ((a.day || '') !== (b.day || '')) return (a.day || '').localeCompare(b.day || '');
    return (Number(a.token) || 0) - (Number(b.token) || 0);
  });
  const lines = [CSV_COLS.join(CSV_DELIM)];
  for (const v of sorted) lines.push(CSV_COLS.map((k) => csvEscape(v[k])).join(CSV_DELIM));
  return lines.join('\n') + '\n';
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
  const people = [];
  const byKey = new Map();
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
    const key = name + '\u0000' + mob;
    let person = byKey.get(key);
    if (!person) {
      person = {
        id: people.length + 1,
        name,
        mob,
        age,
        gender,
        weight: weight != null ? weight : undefined,
        createdAt,
        updatedAt: createdAt,
      };
      byKey.set(key, person);
      people.push(person);
    } else {
      person.age = age;
      if (gender) person.gender = gender;
      if (weight != null) person.weight = weight;
      person.updatedAt = createdAt;
    }
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
      personId: person.id,
    });
  }
  return { schema: 'doctor-apt-list/patients', version: 2, people, visits };
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
      return { version: 2, people: data.people || [], visits: data.visits };
    }
    if (Array.isArray(data.records)) return { version: 1, records: data.records };
    throw new Error('Unrecognized backup contents.');
  }
  return csvToData(text);
}
