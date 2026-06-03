import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, relative, join } from 'node:path';
import { checkTrust } from '../trust.js';
import { resolveWorkspacePath, getWorkspaceRoot } from '../workspace.js';

/**
 * File tools for the coding agent.
 */

export async function readFile(args, trustLevel, policy = {}) {
  const pathResult = resolveWorkspacePath(args.path, policy);
  if (pathResult.error) return { error: pathResult.error };
  const filePath = pathResult.resolvedPath;
  const allowed = await checkTrust('files', trustLevel, `Read file: ${filePath}`, true);
  if (!allowed) return { error: 'Permission denied' };

  try {
    if (!existsSync(filePath)) {
      return { error: `File not found: ${filePath}` };
    }
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    return {
      path: filePath,
      content,
      lines: lines.length,
      size: statSync(filePath).size,
    };
  } catch (err) {
    return { error: `Failed to read file: ${err.message}` };
  }
}

export async function writeFile(args, trustLevel, policy = {}) {
  const pathResult = resolveWorkspacePath(args.path, policy);
  if (pathResult.error) return { error: pathResult.error };
  const filePath = pathResult.resolvedPath;
  const isNew = !existsSync(filePath);
  const desc = isNew ? `Create file: ${filePath}` : `Overwrite file: ${filePath}`;
  const isSafe = isNew;

  const allowed = await checkTrust('files', trustLevel, desc, isSafe);
  if (!allowed) return { error: 'Permission denied' };

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, args.content, 'utf-8');
    return {
      path: filePath,
      status: isNew ? 'created' : 'overwritten',
      size: args.content.length,
    };
  } catch (err) {
    return { error: `Failed to write file: ${err.message}` };
  }
}

export async function editFile(args, trustLevel, policy = {}) {
  const pathResult = resolveWorkspacePath(args.path, policy);
  if (pathResult.error) return { error: pathResult.error };
  const filePath = pathResult.resolvedPath;
  const allowed = await checkTrust('files', trustLevel, `Edit file: ${filePath}\n    Replace: "${truncate(args.old_text, 60)}"\n    With:    "${truncate(args.new_text, 60)}"`, false);
  if (!allowed) return { error: 'Permission denied' };

  try {
    if (!existsSync(filePath)) {
      return { error: `File not found: ${filePath}` };
    }
    const original = readFileSync(filePath, 'utf-8');
    if (args.old_text === args.new_text) {
      return { error: 'old_text and new_text are identical — no edit to apply.' };
    }
    if (!original.includes(args.old_text)) {
      return {
        error: 'Target text not found in file. old_text must match exactly (including whitespace and indentation).',
        hint: 'Tip: read the file first, copy a UNIQUE snippet of 3-10 lines including surrounding context, and pass it verbatim.',
      };
    }
    let occurrences = 0;
    let searchIdx = 0;
    while (true) {
      const hit = original.indexOf(args.old_text, searchIdx);
      if (hit === -1) break;
      occurrences++;
      searchIdx = hit + Math.max(1, args.old_text.length);
    }
    if (occurrences > 1 && !args.replace_all) {
      return {
        error: `old_text matched ${occurrences} places. Add surrounding context to make it unique, or pass "replace_all": true to edit every occurrence.`,
        occurrences,
      };
    }
    const content = args.replace_all
      ? original.split(args.old_text).join(args.new_text)
      : original.replace(args.old_text, args.new_text);
    writeFileSync(filePath, content, 'utf-8');
    return {
      path: filePath,
      status: 'edited',
      occurrences_replaced: args.replace_all ? occurrences : 1,
    };
  } catch (err) {
    return { error: `Failed to edit file: ${err.message}` };
  }
}

export async function listDirectory(args, trustLevel, policy = {}) {
  const pathResult = resolveWorkspacePath(args.path || '.', policy);
  if (pathResult.error) return { error: pathResult.error };
  const dirPath = pathResult.resolvedPath;
  const allowed = await checkTrust('files', trustLevel, `List directory: ${dirPath}`, true);
  if (!allowed) return { error: 'Permission denied' };

  try {
    if (!existsSync(dirPath)) {
      return { error: `Directory not found: ${dirPath}` };
    }
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const items = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
    }));
    return { path: dirPath, entries: items };
  } catch (err) {
    return { error: `Failed to list directory: ${err.message}` };
  }
}

function truncate(str, max) {
  if (!str) return '';
  const single = str.replace(/\n/g, '\\n');
  return single.length > max ? single.slice(0, max) + '...' : single;
}

// ---- Extras ----

const FS_IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', '.venv', '__pycache__']);

function* walkFs(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (FS_IGNORE.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkFs(p);
    else if (e.isFile()) yield p;
  }
}

function globToRegex(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '.';
    else if ('.+^$(){}|\\[]'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(re + '$');
}

export async function readFileLines(args, trustLevel, policy = {}) {
  const p = resolveWorkspacePath(args.path, policy);
  if (p.error) return { error: p.error };
  if (!existsSync(p.resolvedPath)) return { error: 'File not found' };
  const allowed = await checkTrust('files', trustLevel, `Read lines ${args.start || 1}-${args.end != null ? args.end : '?'} of: ${p.resolvedPath}`, true);
  if (!allowed) return { error: 'Permission denied' };
  const start = Math.max(1, parseInt(args.start, 10) || 1);
  const end = args.end == null ? Infinity : Math.max(start, parseInt(args.end, 10));
  const content = readFileSync(p.resolvedPath, 'utf-8');
  const lines = content.split('\n');
  const slice = lines.slice(start - 1, end);
  return {
    path: p.resolvedPath,
    start,
    end: Math.min(end, lines.length),
    total_lines: lines.length,
    lines: slice,
    truncated_start: start > 1,
    truncated_end: end < lines.length,
  };
}

export async function fileHash(args, trustLevel, policy = {}) {
  const p = resolveWorkspacePath(args.path, policy);
  if (p.error) return { error: p.error };
  if (!existsSync(p.resolvedPath)) return { error: 'File not found' };
  const algo = (args.algorithm || 'sha256').toLowerCase();
  const allowed = await checkTrust('files', trustLevel, `Hash (${algo}): ${p.resolvedPath}`, true);
  if (!allowed) return { error: 'Permission denied' };
  const buf = readFileSync(p.resolvedPath);
  const hex = createHash(algo).update(buf).digest('hex');
  return { path: p.resolvedPath, algorithm: algo, bytes: buf.length, hex };
}

function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(' ' + a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push('-' + a[i]); i++; }
    else { out.push('+' + b[j]); j++; }
  }
  while (i < n) out.push('-' + a[i++]);
  while (j < m) out.push('+' + b[j++]);
  return out;
}

export async function diffFiles(args, trustLevel, policy = {}) {
  const a = resolveWorkspacePath(args.path_a, policy);
  const b = resolveWorkspacePath(args.path_b, policy);
  if (a.error) return { error: a.error };
  if (b.error) return { error: b.error };
  if (!existsSync(a.resolvedPath)) return { error: `path_a not found: ${a.resolvedPath}` };
  if (!existsSync(b.resolvedPath)) return { error: `path_b not found: ${b.resolvedPath}` };
  const allowed = await checkTrust('files', trustLevel, `Diff: ${a.resolvedPath} <-> ${b.resolvedPath}`, true);
  if (!allowed) return { error: 'Permission denied' };
  const ca = readFileSync(a.resolvedPath, 'utf-8');
  const cb = readFileSync(b.resolvedPath, 'utf-8');
  const la = ca.split('\n');
  const lb = cb.split('\n');
  const diff = lcsDiff(la, lb);
  let added = 0, removed = 0;
  for (const l of diff) { if (l[0] === '+') added++; else if (l[0] === '-') removed++; }
  const maxBytes = Math.min(200000, policy.networkMaxBytes || 200000);
  let body = diff.join('\n');
  let truncated = false;
  if (body.length > maxBytes) { body = body.slice(0, maxBytes) + `\n... (truncated at ${maxBytes} bytes)`; truncated = true; }
  return {
    path_a: a.resolvedPath,
    path_b: b.resolvedPath,
    identical: added === 0 && removed === 0,
    added,
    removed,
    diff: body,
    truncated,
  };
}

export async function findReplace(args, trustLevel, policy = {}) {
  const base = resolveWorkspacePath(args.path || '.', policy);
  if (base.error) return { error: base.error };
  if (!existsSync(base.resolvedPath)) return { error: 'Path not found' };
  const pattern = args.pattern;
  const replacement = args.replacement;
  if (!pattern) return { error: 'pattern is required' };
  if (replacement == null) return { error: 'replacement is required' };
  const allowed = await checkTrust('files', trustLevel, `Regex replace /${pattern}/ in ${base.resolvedPath}`, false);
  if (!allowed) return { error: 'Permission denied' };
  const flags = (args.flags || 'g').replace(/[^gimsuyd]/g, '');
  let re;
  try { re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g'); }
  catch (e) { return { error: `Invalid regex: ${e.message}` }; }
  const reFilter = args.file_glob ? globToRegex(args.file_glob) : null;
  const root = getWorkspaceRoot();
  const changed = [];
  let total = 0;
  for (const f of walkFs(base.resolvedPath)) {
    const rel = relative(root, f);
    if (reFilter && !reFilter.test(rel)) continue;
    let content;
    try { content = readFileSync(f, 'utf-8'); } catch { continue; }
    if (!re.test(content)) { re.lastIndex = 0; continue; }
    re.lastIndex = 0;
    let count = 0;
    const next = content.replace(re, () => { count++; return replacement; });
    if (count === 0) continue;
    if (!args.dry_run) writeFileSync(f, next, 'utf-8');
    total += count;
    changed.push({ path: rel, replacements: count });
    if (changed.length >= 500) break;
  }
  return { files_changed: changed.length, total_replacements: total, dry_run: !!args.dry_run, files: changed };
}
