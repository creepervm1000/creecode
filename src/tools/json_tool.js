import { readFileSync } from 'node:fs';
import { checkTrust } from '../trust.js';
import { resolveWorkspacePath } from '../workspace.js';

function getPath(obj, path) {
  if (!path || path === '.') return obj;
  const parts = path.replace(/^\.+/, '').split(/\.|\[|\]/).filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

export async function jsonQuery(args, trustLevel, config = {}) {
  const p = resolveWorkspacePath(args.path, config); if (p.error) return { error: p.error };
  const allowed = await checkTrust('files', trustLevel, `Read JSON: ${p.resolvedPath}`, true);
  if (!allowed) return { error: 'Permission denied' };
  let data;
  try { data = JSON.parse(readFileSync(p.resolvedPath, 'utf-8')); } catch (e) { return { error: e.message }; }
  const result = getPath(data, args.query || '.');
  return { result };
}
