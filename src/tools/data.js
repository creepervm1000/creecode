import { readFileSync, existsSync } from 'node:fs';
import { checkTrust } from '../trust.js';
import { resolveWorkspacePath } from '../workspace.js';

/**
 * Data file format tools: CSV, YAML, TOML.
 * No external deps. Parsers cover common cases (flat / one-level nested,
 * lists). For complex/nested YAML use a real library.
 */

// ---- CSV parser (RFC 4180-ish) ----
function parseCsv(text, opts = {}) {
  const delim = opts.delimiter || ',';
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
      i++; continue;
    }
    if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      i++; continue;
    }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (opts.trim) for (const r of rows) for (let k = 0; k < r.length; k++) r[k] = r[k].trim();
  // drop trailing empty row
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

function rowsToObjects(rows, hasHeader) {
  if (rows.length === 0) return { headers: [], records: [] };
  if (hasHeader === undefined) hasHeader = true;
  if (!hasHeader) return { headers: null, records: rows };
  const headers = rows[0];
  const records = rows.slice(1).map(r => {
    const o = {};
    for (let i = 0; i < headers.length; i++) o[headers[i]] = r[i] !== undefined ? r[i] : '';
    return o;
  });
  return { headers, records };
}

function inferType(v) {
  if (v === '' || v == null) return '';
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+([eE][-+]?\d+)?$/.test(v)) return parseFloat(v);
  if (/^"(.*)"$/.test(v)) return v.slice(1, -1).replace(/\\"/g, '"');
  if (/^'(.*)'$/.test(v)) return v.slice(1, -1);
  return v;
}

export async function csvParse(args) {
  const text = args.input == null ? '' : String(args.input);
  if (!text) return { error: 'input is required' };
  const rows = parseCsv(text, { delimiter: args.delimiter, trim: args.trim !== false });
  const { headers, records } = rowsToObjects(rows, args.has_header !== false);
  let typed = records;
  if (args.infer_types) {
    typed = records.map(r => {
      const o = {};
      for (const [k, v] of Object.entries(r)) o[k] = inferType(v);
      return o;
    });
  }
  return { headers, count: typed.length, records: typed };
}

export async function csvRead(args, trustLevel, config = {}) {
  const p = resolveWorkspacePath(args.path, config);
  if (p.error) return { error: p.error };
  if (!existsSync(p.resolvedPath)) return { error: 'File not found' };
  const allowed = await checkTrust('data', trustLevel, `Read CSV: ${p.resolvedPath}`, true);
  if (!allowed) return { error: 'Permission denied' };
  const text = readFileSync(p.resolvedPath, 'utf-8');
  const rows = parseCsv(text, { delimiter: args.delimiter, trim: args.trim !== false });
  const { headers, records } = rowsToObjects(rows, args.has_header !== false);
  let typed = records;
  if (args.infer_types) {
    typed = records.map(r => {
      const o = {};
      for (const [k, v] of Object.entries(r)) o[k] = inferType(v);
      return o;
    });
  }
  return { path: p.resolvedPath, headers, count: typed.length, records: typed };
}

// ---- Tiny YAML reader (flat + lists + 1-level nesting) ----
function parseFlatYaml(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  let currentArray = null; // { indent, key, arr }
  for (let raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^ */)[0].length;
    const line = raw.slice(indent);
    // list item
    const listMatch = line.match(/^-\s+(.*)$/);
    if (listMatch) {
      // find the array on the stack with the matching indent
      let arr = null;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].isArray && stack[i].indent === indent) { arr = stack[i]; break; }
      }
      if (!arr) {
        // Implicit: attach to last key on top container at indent-1? Skip — too brittle.
        continue;
      }
      arr.arr.push(coerceScalar(listMatch[1].trim()));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const rest = kv[2].trim();
    // pop stack while indent <= top indent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const top = stack[stack.length - 1];
    if (rest === '' || rest === '|' || rest === '>') {
      // nested mapping
      const child = {};
      top.obj[key] = child;
      stack.push({ indent, obj: child });
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      // inline flow array: [a, b, c]
      const inner = rest.slice(1, -1).trim();
      const parts = inner ? inner.split(',').map(s => coerceScalar(s.trim())) : [];
      top.obj[key] = parts;
    } else {
      top.obj[key] = coerceScalar(rest);
    }
  }
  return root;
}

function coerceScalar(v) {
  if (v === undefined || v === null) return null;
  v = String(v).trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+([eE][-+]?\d+)?$/.test(v)) return parseFloat(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

export async function yamlRead(args, trustLevel, config = {}) {
  const p = resolveWorkspacePath(args.path, config);
  if (p.error) return { error: p.error };
  if (!existsSync(p.resolvedPath)) return { error: 'File not found' };
  const allowed = await checkTrust('data', trustLevel, `Read YAML: ${p.resolvedPath}`, true);
  if (!allowed) return { error: 'Permission denied' };
  const text = readFileSync(p.resolvedPath, 'utf-8');
  try {
    const data = parseFlatYaml(text);
    return { path: p.resolvedPath, data, note: 'Flat / shallow YAML only. For deeply nested YAML use a real parser.' };
  } catch (e) { return { error: `YAML parse failed: ${e.message}` }; }
}

// ---- Tiny TOML reader (sections, flat key=value, basic types, arrays) ----
function parseToml(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  let current = root;
  for (let raw of lines) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      const section = line.slice(1, -1).trim();
      if (!root[section]) root[section] = {};
      current = root[section];
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    current[key] = coerceToml(val);
  }
  return root;
}

function coerceToml(v) {
  if (v === '' || v === '~' || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+([eE][-+]?\d+)?$/.test(v)) return parseFloat(v);
  if (v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    // very simple: split on commas, but respect nested brackets
    const out = [];
    let cur = '';
    let depth = 0;
    let inStr = null;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (inStr) { cur += c; if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'") { inStr = c; cur += c; continue; }
      if (c === '[' || c === '{') { depth++; cur += c; continue; }
      if (c === ']' || c === '}') { depth--; cur += c; continue; }
      if (c === ',' && depth === 0) { out.push(coerceToml(cur.trim())); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(coerceToml(cur.trim()));
    return out;
  }
  return v;
}

export async function tomlRead(args, trustLevel, config = {}) {
  const p = resolveWorkspacePath(args.path, config);
  if (p.error) return { error: p.error };
  if (!existsSync(p.resolvedPath)) return { error: 'File not found' };
  const allowed = await checkTrust('data', trustLevel, `Read TOML: ${p.resolvedPath}`, true);
  if (!allowed) return { error: 'Permission denied' };
  const text = readFileSync(p.resolvedPath, 'utf-8');
  try {
    const data = parseToml(text);
    return { path: p.resolvedPath, data };
  } catch (e) { return { error: `TOML parse failed: ${e.message}` }; }
}
