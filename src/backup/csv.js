// Pure CSV encode/decode for the append-only logbook. No IO. Schema v3.
//
// Format (v3):
//   #head|schema|schemaNo|type1|type2|...   ← one per entity schema
//   <schemaNo>|<value1>|<value2>|...        ← one row per appended revision
//
//   * Values are positional, matching the #head column order for that schemaNo.
//   * Types are declared in the #head line: str, int, num, epoch, bool.
//     A `?` suffix (e.g. `age:int?`) marks a nullable field.
//   * Delimiter is `|`. Never changes.
//   * Timestamps are epoch-SECONDS at the file boundary (DB keeps ISO).
//   * Projections (peopleProj/visitsProj) and meta are NOT written to the log.
//     They are rebuilt on restore.
//   * Unknown schemaNo → line skipped (forward-compatible).

import { normalizeRefundTier } from '../core/billing.js';

export const CSV_DELIM = '|';

// ---- schema registry (the ONLY place column shape lives) ----

// Users revision (audit trail). schemaNo 0. NEVER carries secrets — no
// salt/hash/iter/sessionToken. Rebuilt on restore so attribution survives; a
// restored user must have its password reset by an admin.
export const SCHEMA_USER = {
  no: 0,
  name: 'user',
  cols: [
    'id:int',
    'v:int',
    'username:str',
    'role:str',
    'disabled:int',
    'createdAt:epoch',
    'revAt:epoch?',
  ],
};

// People revision. Every field is written; nullable fields carry null as ''.
// userId/username = the acting user at THIS revision (nullable: pre-auth rows).
export const SCHEMA_PEOPLE = {
  no: 1,
  name: 'people',
  cols: [
    'rootId:int',
    'v:int',
    'name:str',
    'mob:str',
    'age:int?',
    'gender:str?',
    'weight:num?',
    'hidden:int',
    'createdAt:epoch',
    'revAt:epoch?',
    'userId:int?',
    'userV:int?',
  ],
};

// Visits revision. userId/userV = acting user + its revision at THIS write.
export const SCHEMA_VISITS = {
  no: 2,
  name: 'visits',
  cols: [
    'rootId:int',
    'v:int',
    'personId:int',
    'personV:int',
    'date:str',
    'token:int',
    'weight:num?',
    'followup:int',
    'payment:int',
    'fee:num',
    'refundTier:int',
    'hidden:int',
    'createdAt:epoch',
    'revAt:epoch?',
    'userId:int?',
    'userV:int?',
  ],
};

// App settings (singleton): one line per backup. Not revisioned — restore
// applies the values, overwriting current settings.
export const SCHEMA_SETTINGS = {
  no: 3,
  name: 'settings',
  cols: ['defaultFee:num', 'followupWindowDays:int', 'revAt:epoch?'],
};

export const SCHEMAS = [SCHEMA_USER, SCHEMA_PEOPLE, SCHEMA_VISITS, SCHEMA_SETTINGS];

// #head schema name -> op kind used by csvToLog/replayLog. One place to extend
// when a new entity is logged (avoids a growing ternary).
export const KIND_BY_SCHEMA = {
  user: 'user',
  people: 'person',
  visits: 'visit',
  settings: 'settings',
};

// ---- head block ----

export function csvHeaderLine() {
  const lines = ['#head|schema|schemaNo|columns'];
  for (const s of SCHEMAS) lines.push('#head|' + s.name + '|' + s.no + '|' + s.cols.join(CSV_DELIM));
  return lines.join('\n');
}

// ---- refTier normalization: owned by core/billing.js, re-exported here ----
export { normalizeRefundTier };

// ---- epoch <-> ISO at the file boundary ----

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

// ---- escaping ----

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (s.includes(CSV_DELIM) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function parseCsvLine(line) {
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

// ---- value encoding per type ----

function encVal(type, v) {
  if (v == null || v === '') return '';
  if (type === 'epoch') return toEpoch(v);
  return v;
}

function rowForLine(schema, row) {
  const values = [];
  for (let i = 0; i < schema.cols.length; i++) {
    const key = schema.cols[i].split(':')[0];
    // Strip the nullable `?` suffix so `epoch?` still encodes as an epoch.
    const type = schema.cols[i].split(':')[1].replace(/\?$/, '');
    let v = row[key];
    if (type === 'int') v = v == null || v === '' ? '' : Number(v);
    if (type === 'num') v = v == null || v === '' ? '' : Number(v);
    if (key === 'refundTier') v = normalizeRefundTier(v);
    if (key === 'hidden') v = v ? 1 : 0;
    if (key === 'followup' || key === 'payment') v = v ? 1 : 0;
    values.push(csvEscape(encVal(type, v)));
  }
  return schema.no + CSV_DELIM + values.join(CSV_DELIM);
}

// Encode a people revision row.
export function personRevToLogLine(p) {
  return rowForLine(SCHEMA_PEOPLE, p);
}

// Encode a visits revision row.
export function visitRevToLogLine(v) {
  return rowForLine(SCHEMA_VISITS, v);
}

// Encode a user revision row. Secrets are NOT part of SCHEMA_USER, so only the
// identity/role/disabled fields are ever written.
export function userRevToLogLine(u) {
  return rowForLine(SCHEMA_USER, u);
}

// Encode the settings singleton line.
export function settingsToLogLine(s) {
  return rowForLine(SCHEMA_SETTINGS, s || {});
}

// ---- decoding ----

// Parse a full log file. Returns { ops, skippedRows }.
//   ops: [{ kind:'person'|'visit', lineNo, raw, ...fields }]
//   skippedRows: [{ lineNo, reason, raw }]
export function csvToLog(text) {
  const lines = text.split(/\r?\n/);
  const heads = [];
  const body = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === '') continue;
    if (raw.startsWith('#head')) {
      heads.push({ lineNo: i + 1, fields: parseCsvLine(raw) });
      continue;
    }
    body.push({ lineNo: i + 1, raw });
  }
  if (!heads.length) throw new Error('Not a tokenbook v3 log (no #head lines).');

  // Build schemaNo -> { no, name, cols:[{key,type,nullable}] }
  const schemaMap = new Map();
  for (const h of heads) {
    // #head|people|1|rootId:int|v:int|...
    const f = h.fields;
    if (f.length < 4) continue;
    const sName = f[1];
    const sNo = Number(f[2]);
    // spec form: `key:type` or `key:type?` (nullable). `?` suffix only — the
    // `|` delimiter must never appear inside a spec.
    const cols = f.slice(3).map((spec) => {
      const nullable = spec.endsWith('?');
      const base = nullable ? spec.slice(0, -1) : spec;
      const [key, type] = base.split(':');
      return { key, type: type || 'str', nullable };
    });
    schemaMap.set(sNo, { no: sNo, name: sName, cols });
  }
  if (!schemaMap.size) throw new Error('Not a tokenbook v3 log (empty #head block).');

  const ops = [];
  const skippedRows = [];
  for (const { lineNo, raw } of body) {
    const f = parseCsvLine(raw);
    const sNo = Number(f[0]);
    const schema = schemaMap.get(sNo);
    if (!schema) {
      skippedRows.push({ lineNo, reason: 'unknown schemaNo ' + f[0], raw });
      continue;
    }
    if (f.length - 1 < schema.cols.length) {
      skippedRows.push({
        lineNo,
        reason: `short row (${f.length - 1} fields, expected ${schema.cols.length})`,
        raw,
      });
      continue;
    }
    const kind = KIND_BY_SCHEMA[schema.name] || 'visit';
    const row = { kind, lineNo, raw };
    for (let i = 0; i < schema.cols.length; i++) {
      const { key, type } = schema.cols[i];
      const rawVal = f[i + 1];
      row[key] = decodeVal(type, rawVal);
    }
    ops.push(row);
  }
  return { ops, skippedRows };
}

function decodeVal(type, v) {
  if (v === '' || v == null) return null;
  if (type === 'int') {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  if (type === 'num') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'epoch') return fromEpoch(v);
  if (type === 'bool') return v === '1' || v === 'true' ? 1 : 0;
  return String(v);
}

export function parseBackup(text) {
  return csvToLog(text);
}
