import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { checkTrust } from '../trust.js';
import { resolveWorkspacePath } from '../workspace.js';

function applyUnifiedDiff(original, diff) {
  const lines = diff.split('\n');
  const srcLines = original.split('\n');
  const out = [];
  let i = 0, srcIdx = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      const m = line.match(/-(\d+)(?:,(\d+))? \+(\d+)/);
      if (!m) return null;
      const oldStart = parseInt(m[1], 10) - 1;
      while (srcIdx < oldStart) { out.push(srcLines[srcIdx++]); }
      i++;
      while (i < lines.length && !lines[i].startsWith('@@')) {
        const l = lines[i];
        if (l.startsWith('+')) out.push(l.slice(1));
        else if (l.startsWith('-')) srcIdx++;
        else if (l.startsWith(' ')) { out.push(srcLines[srcIdx++]); }
        else if (l === '') { /* trailing */ }
        i++;
      }
    } else { i++; }
  }
  while (srcIdx < srcLines.length) out.push(srcLines[srcIdx++]);
  return out.join('\n');
}

export async function applyPatch(args, trustLevel, config = {}) {
  const p = resolveWorkspacePath(args.path, config); if (p.error) return { error: p.error };
  if (!existsSync(p.resolvedPath)) return { error: 'File not found' };
  const allowed = await checkTrust('files', trustLevel, `Apply patch to ${p.resolvedPath}`, false);
  if (!allowed) return { error: 'Permission denied' };
  const original = readFileSync(p.resolvedPath, 'utf-8');
  const patched = applyUnifiedDiff(original, args.diff);
  if (patched === null) return { error: 'Failed to parse unified diff' };
  writeFileSync(p.resolvedPath, patched, 'utf-8');
  return { status: 'patched', path: p.resolvedPath };
}
