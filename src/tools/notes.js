import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getWorkspaceRoot } from '../workspace.js';
import { safeJsonParse } from '../utils/safe_json.js';

function notesPath(config) {
  return config.notesFile ? config.notesFile : join(getWorkspaceRoot(), '.creecode', 'notes.json');
}
function load(config) {
  const p = notesPath(config);
  if (!existsSync(p)) return [];
  try { return safeJsonParse(readFileSync(p, 'utf-8')); } catch { return []; }
}
function save(config, notes) {
  const p = notesPath(config);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(notes, null, 2), 'utf-8');
}

export async function addNote(args, _t, config = {}) {
  const notes = load(config);
  notes.push({ id: notes.length + 1, text: args.text, tag: args.tag || null, at: new Date().toISOString() });
  save(config, notes);
  return { status: 'added', count: notes.length };
}
export async function listNotes(_a, _t, config = {}) { return { notes: load(config) }; }
export async function clearNotes(_a, _t, config = {}) { save(config, []); return { status: 'cleared' }; }
