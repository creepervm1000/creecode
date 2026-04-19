import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkTrust } from '../trust.js';
import { resolveWorkspacePath, getWorkspaceRoot } from '../workspace.js';

const DEFAULT_IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', '.venv', '__pycache__']);

function* walk(dir, ignore) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (ignore.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, ignore);
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

export async function grepText(args, trustLevel, policy = {}) {
  const base = resolveWorkspacePath(args.path || '.', policy);
  if (base.error) return { error: base.error };
  const allowed = await checkTrust('files', trustLevel, `Search text in ${base.resolvedPath}`, true);
  if (!allowed) return { error: 'Permission denied' };
  const pattern = args.pattern;
  if (!pattern) return { error: 'pattern is required' };
  const flags = args.ignore_case ? 'i' : '';
  let re;
  try { re = new RegExp(pattern, flags); } catch (e) { return { error: `Invalid regex: ${e.message}` }; }
  const maxMatches = args.max_matches || 200;
  const fileGlob = args.file_glob ? globToRegex(args.file_glob) : null;
  const root = getWorkspaceRoot();
  const matches = [];
  for (const f of walk(base.resolvedPath, DEFAULT_IGNORE)) {
    if (fileGlob && !fileGlob.test(relative(root, f))) continue;
    let content;
    try { content = readFileSync(f, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        matches.push({ file: relative(root, f), line: i + 1, text: lines[i].slice(0, 400) });
        if (matches.length >= maxMatches) return { matches, truncated: true };
      }
    }
  }
  return { matches, truncated: false };
}

export async function globFiles(args, trustLevel, policy = {}) {
  const base = resolveWorkspacePath(args.path || '.', policy);
  if (base.error) return { error: base.error };
  const allowed = await checkTrust('files', trustLevel, `Glob files under ${base.resolvedPath}`, true);
  if (!allowed) return { error: 'Permission denied' };
  const re = globToRegex(args.pattern || '**/*');
  const root = getWorkspaceRoot();
  const limit = args.limit || 500;
  const out = [];
  for (const f of walk(base.resolvedPath, DEFAULT_IGNORE)) {
    const rel = relative(root, f);
    if (re.test(rel)) {
      const st = statSync(f);
      out.push({ path: rel, size: st.size });
      if (out.length >= limit) break;
    }
  }
  return { files: out };
}

export async function fileStat(args, trustLevel, policy = {}) {
  const p = resolveWorkspacePath(args.path, policy);
  if (p.error) return { error: p.error };
  const allowed = await checkTrust('files', trustLevel, `Stat ${p.resolvedPath}`, true);
  if (!allowed) return { error: 'Permission denied' };
  if (!existsSync(p.resolvedPath)) return { error: 'Not found' };
  const st = statSync(p.resolvedPath);
  return {
    path: p.resolvedPath,
    size: st.size,
    is_file: st.isFile(),
    is_directory: st.isDirectory(),
    modified: st.mtime.toISOString(),
  };
}
