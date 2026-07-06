import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { checkTrust } from '../trust.js';
import { safeJsonParse } from '../utils/safe_json.js';

/**
 * Global memory store. Unlike notes (workspace-scoped) and todos (workspace-
 * scoped), memory lives at ~/.creecode/memory.json and persists across every
 * project / workspace. Use it for long-lived facts about the user, their
 * preferences, and conventions they want remembered.
 *
 * Schema:
 *   {
 *     "version": 1,
 *     "entries": [
 *       { "id": 1, "text": "...", "tag": "preference", "created_at": "...", "updated_at": "..." }
 *     ]
 *   }
 *
 * IDs are monotonically increasing across the file. Deletions don't shrink
 * the next-id counter; the gap is fine.
 */

function memoryPath(config) {
  return config.memoryFile || join(homedir(), '.creecode', 'memory.json');
}

function empty() { return { version: 1, entries: [] }; }

function load(config) {
  const p = memoryPath(config);
  if (!existsSync(p)) return empty();
  try {
    const raw = safeJsonParse(readFileSync(p, 'utf-8'));
    if (!raw || !Array.isArray(raw.entries)) return empty();
    return { version: raw.version || 1, entries: raw.entries };
  } catch {
    return empty();
  }
}

function persist(config, data) {
  const p = memoryPath(config);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

function nextId(entries) {
  return entries.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;
}

function findById(entries, id) {
  return entries.find(e => e.id === id) || null;
}

function gate(trustLevel, desc) {
  return checkTrust('memory', trustLevel, desc, true);
}

export async function memoryList(args, trustLevel, config = {}) {
  if (!await gate(trustLevel, 'List memory entries')) return { error: 'Permission denied' };
  const data = load(config);
  let entries = data.entries;
  if (args.tag) entries = entries.filter(e => e.tag === args.tag);
  if (args.search) {
    const re = new RegExp(args.search, args.case_insensitive ? 'i' : '');
    entries = entries.filter(e => re.test(e.text) || (e.tag && re.test(e.tag)));
  }
  return {
    path: memoryPath(config),
    total: data.entries.length,
    shown: entries.length,
    entries,
  };
}

export async function memoryGet(args, trustLevel, config = {}) {
  if (!await gate(trustLevel, `Get memory entry ${args.id}`)) return { error: 'Permission denied' };
  const id = parseInt(args.id, 10);
  if (!Number.isFinite(id)) return { error: 'id must be a number' };
  const e = findById(load(config).entries, id);
  if (!e) return { error: `No memory entry with id ${id}` };
  return e;
}

export async function memoryAdd(args, trustLevel, config = {}) {
  if (!await gate(trustLevel, 'Add memory entry')) return { error: 'Permission denied' };
  const text = (args.text || '').toString();
  if (!text.trim()) return { error: 'text is required' };
  const data = load(config);
  const now = new Date().toISOString();
  const entry = {
    id: nextId(data.entries),
    text,
    tag: args.tag || null,
    created_at: now,
    updated_at: now,
  };
  data.entries.push(entry);
  persist(config, data);
  return { status: 'added', entry, total: data.entries.length };
}

export async function memoryAppend(args, trustLevel, config = {}) {
  if (!await gate(trustLevel, `Append to memory entry ${args.id}`)) return { error: 'Permission denied' };
  const id = parseInt(args.id, 10);
  if (!Number.isFinite(id)) return { error: 'id must be a number' };
  const text = args.text == null ? '' : String(args.text);
  const data = load(config);
  const e = findById(data.entries, id);
  if (!e) return { error: `No memory entry with id ${id}` };
  // Append with a newline separator unless the existing text already ends in one.
  const sep = e.text.endsWith('\n') || e.text.length === 0 ? '' : '\n';
  e.text = e.text + sep + text;
  e.updated_at = new Date().toISOString();
  persist(config, data);
  return { status: 'appended', entry: e };
}

export async function memoryEdit(args, trustLevel, config = {}) {
  if (!await gate(trustLevel, `Edit memory entry ${args.id}`)) return { error: 'Permission denied' };
  const id = parseInt(args.id, 10);
  if (!Number.isFinite(id)) return { error: 'id must be a number' };
  if (args.text == null) return { error: 'text is required' };
  const data = load(config);
  const e = findById(data.entries, id);
  if (!e) return { error: `No memory entry with id ${id}` };
  e.text = String(args.text);
  if (args.tag !== undefined) e.tag = args.tag || null;
  e.updated_at = new Date().toISOString();
  persist(config, data);
  return { status: 'edited', entry: e };
}

// Remove a single line (1-based) from the entry's multi-line text. If the
// resulting text is empty after removal, the field becomes an empty string.
export async function memoryClearLine(args, trustLevel, config = {}) {
  if (!await gate(trustLevel, `Clear line ${args.line} of memory entry ${args.id}`)) return { error: 'Permission denied' };
  const id = parseInt(args.id, 10);
  const line = parseInt(args.line, 10);
  if (!Number.isFinite(id) || !Number.isFinite(line)) return { error: 'id and line must be numbers' };
  if (line < 1) return { error: 'line is 1-based' };
  const data = load(config);
  const e = findById(data.entries, id);
  if (!e) return { error: `No memory entry with id ${id}` };
  const lines = e.text.split('\n');
  if (line > lines.length) return { error: `Entry ${id} has only ${lines.length} line(s)` };
  lines.splice(line - 1, 1);
  e.text = lines.join('\n');
  e.updated_at = new Date().toISOString();
  persist(config, data);
  return { status: 'cleared', entry: e, removed_line: line };
}

export async function memoryRemove(args, trustLevel, config = {}) {
  if (!await gate(trustLevel, `Remove memory entry ${args.id}`)) return { error: 'Permission denied' };
  const id = parseInt(args.id, 10);
  if (!Number.isFinite(id)) return { error: 'id must be a number' };
  const data = load(config);
  const idx = data.entries.findIndex(e => e.id === id);
  if (idx === -1) return { error: `No memory entry with id ${id}` };
  const [removed] = data.entries.splice(idx, 1);
  persist(config, data);
  return { status: 'removed', entry: removed, total: data.entries.length };
}

export async function memoryClear(args, trustLevel, config = {}) {
  const desc = args.tag ? `Clear memory entries tagged "${args.tag}"` : 'Clear all memory entries';
  if (!await gate(trustLevel, desc)) return { error: 'Permission denied' };
  const data = load(config);
  const before = data.entries.length;
  if (args.tag) data.entries = data.entries.filter(e => e.tag !== args.tag);
  else data.entries = [];
  persist(config, data);
  return { status: 'cleared', removed: before - data.entries.length, remaining: data.entries.length };
}

export async function memorySearch(args, trustLevel, config = {}) {
  if (!await gate(trustLevel, 'Search memory')) return { error: 'Permission denied' };
  const pattern = args.pattern;
  if (!pattern) return { error: 'pattern is required' };
  let re;
  try { re = new RegExp(pattern, args.case_insensitive ? 'gi' : 'g'); }
  catch (e) { return { error: `Invalid regex: ${e.message}` }; }
  const matches = [];
  for (const e of load(config).entries) {
    const m = e.text.match(re);
    if (m) matches.push({ id: e.id, tag: e.tag, matches: m, snippet: e.text.length > 120 ? e.text.slice(0, 120) + '...' : e.text });
  }
  return { pattern, count: matches.length, matches };
}
