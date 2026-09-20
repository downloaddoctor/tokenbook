// Pure CSV encode/decode + backup payload parsing. No IO.
// Format: flat CSV, one row per visit, delimiter U+2016 (‖) so ordinary
// names never need quoting.

export const CSV_DELIM = '\u2016'; // ‖
export const CSV_COLS = ['date', 'token', 'name', 'mob', 'age', 'gender', 'personId', 'createdAt'];

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

export function csvToData(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) throw new Error('Empty backup file.');
  const header = parseCsvLine(lines[0]);
  if (header.length !== CSV_COLS.length || header.some((h, i) => h !== CSV_COLS[i])) {
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
    const token = Number(f[col.token]);
    const day = f[col.date] || '';
    const createdAt = f[col.createdAt] || new Date().toISOString();
    const key = name + '\u0000' + mob;
    let person = byKey.get(key);
    if (!person) {
      person = { id: people.length + 1, name, mob, age, gender, createdAt, updatedAt: createdAt };
      byKey.set(key, person);
      people.push(person);
    } else {
      person.age = age;
      if (gender) person.gender = gender;
      person.updatedAt = createdAt;
    }
    visits.push({ name, mob, age, gender, token, day, date: day, createdAt, personId: person.id });
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
