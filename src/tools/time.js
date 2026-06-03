/**
 * Time tools. current_time returns the system clock in requested formats/tzs.
 * cron_next calculates the next N runs of a 5-field cron expression.
 */

export async function currentTime(args) {
  const now = args.now ? new Date(args.now) : new Date();
  if (isNaN(now.getTime())) return { error: `Invalid date: ${args.now}` };
  const tz = args.timezone || 'UTC';
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, weekday: 'short',
    }).formatToParts(now);
  } catch (e) { return { error: `Invalid timezone: ${tz} (${e.message})` }; }
  const get = (t) => (parts.find(p => p.type === t) || {}).value;
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const iso = `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}${getOffset(now, tz)}`;
  return {
    timestamp: now.getTime(),
    iso,
    timezone: tz,
    utc: now.toISOString(),
    weekday: map.weekday,
    unix: Math.floor(now.getTime() / 1000),
  };
}

function getOffset(date, tz) {
  // Compute offset of `tz` at `date` (e.g. "+01:00" or "Z").
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, timeZoneName: 'shortOffset', year: 'numeric',
    });
    const parts = dtf.formatToParts(date);
    const tzn = parts.find(p => p.type === 'timeZoneName');
    if (!tzn) return 'Z';
    const m = tzn.value.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
    if (!m) return tzn.value === 'GMT' ? 'Z' : '';
    const h = m[1].padStart(3, m[1].startsWith('-') ? '-' : '+');
    const mm = (m[2] || '00').padStart(2, '0');
    return `${h}:${mm}`;
  } catch { return ''; }
}

// --- Minimal cron: 5 fields, no @-extensions, no L/W/#, no seconds ---
const FIELD_RANGES = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'weekday', min: 0, max: 6 },
];

function expandField(spec, def) {
  const { min, max } = def;
  if (spec === '*') return { type: 'all', min, max };
  // step: split on the LAST '/' so range/n and */n both work.
  let step = 1;
  let base = spec;
  const slash = spec.lastIndexOf('/');
  if (slash >= 0) {
    step = parseInt(spec.slice(slash + 1), 10);
    if (!Number.isFinite(step) || step < 1) throw new Error(`Bad step: ${spec}`);
    base = spec.slice(0, slash);
  }
  // list a,b,c
  if (base.includes(',')) {
    const values = new Set();
    for (const part of base.split(',')) {
      const v = expandField(part, def);
      for (let i = v.min; i <= v.max; i += (v.type === 'step' || v.type === 'range' ? Math.max(1, v.step) : 1)) values.add(i);
    }
    return { type: 'set', values };
  }
  // wildcard with step: */n
  if (base === '*') return { type: 'range', min, max, step };
  // range a-b
  let m = base.match(/^(\d+)-(\d+)$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a < min || a > max || b < min || b > max) throw new Error(`${base} out of range ${min}-${max}`);
    return { type: 'range', min: a, max: b, step };
  }
  // single
  m = base.match(/^(\d+)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n < min || n > max) throw new Error(`${base} out of range ${min}-${max}`);
    return { type: 'set', values: new Set([n]) };
  }
  throw new Error(`Unparseable field: ${spec}`);
}

function fieldMatches(field, value) {
  if (field.type === 'all') return true;
  if (field.type === 'set') return field.values.has(value);
  if (field.type === 'range') {
    if (value < field.min || value > field.max) return false;
    return ((value - field.min) % field.step) === 0;
  }
  if (field.type === 'step') {
    if (value < field.min) return false;
    return ((value - field.min) % field.step) === 0;
  }
  return false;
}

function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Cron must have 5 fields (minute hour day month weekday)');
  return parts.map((p, i) => expandField(p, FIELD_RANGES[i]));
}

function dayMatchesDate(fields, date) {
  // In standard cron, day-of-month and day-of-week are OR'd only when both
  // are restricted (not '*'). We follow that convention.
  const dom = fields[2];
  const dow = fields[4];
  const day = date.getUTCDate();
  const weekday = date.getUTCDay();
  const domWild = dom.type === 'all';
  const dowWild = dow.type === 'all';
  if (domWild && dowWild) return true;
  if (domWild) return fieldMatches(dow, weekday);
  if (dowWild) return fieldMatches(dom, day);
  return fieldMatches(dom, day) || fieldMatches(dow, weekday);
}

export async function cronNext(args) {
  const expr = (args.expression || '').trim();
  if (!expr) return { error: 'expression is required' };
  const count = Math.max(1, Math.min(100, args.count || 5));
  const fromMs = args.now ? new Date(args.now).getTime() : Date.now();
  let fields;
  try { fields = parseCron(expr); }
  catch (e) { return { error: `Invalid cron: ${e.message}` }; }

  const results = [];
  // Iterate minute by minute from the next minute. Capped at 5 years of search
  // (~2.6M minutes) to avoid infinite loops on impossible expressions.
  let cur = new Date(Math.floor((fromMs + 60000) / 60000) * 60000);
  const cap = fromMs + (5 * 366 * 24 * 3600 * 1000);
  while (results.length < count && cur.getTime() < cap) {
    const m = cur.getUTCMinutes();
    const h = cur.getUTCHours();
    const dom = cur.getUTCDate();
    const mon = cur.getUTCMonth() + 1;
    const dow = cur.getUTCDay();
    if (
      fieldMatches(fields[0], m) &&
      fieldMatches(fields[1], h) &&
      dayMatchesDate(fields, cur) &&
      fieldMatches(fields[3], mon)
    ) {
      results.push(cur.toISOString());
    }
    cur = new Date(cur.getTime() + 60000);
  }
  return { expression: expr, count: results.length, next: results, note: 'Computed in UTC.' };
}
