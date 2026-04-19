import { renameSync, copyFileSync, unlinkSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { checkTrust } from '../trust.js';
import { resolveWorkspacePath } from '../workspace.js';

export async function moveFile(args, trustLevel, policy = {}) {
  const a = resolveWorkspacePath(args.from, policy); if (a.error) return { error: a.error };
  const b = resolveWorkspacePath(args.to, policy); if (b.error) return { error: b.error };
  const allowed = await checkTrust('files', trustLevel, `Move ${a.resolvedPath} -> ${b.resolvedPath}`, false);
  if (!allowed) return { error: 'Permission denied' };
  try { renameSync(a.resolvedPath, b.resolvedPath); return { status: 'moved', from: a.resolvedPath, to: b.resolvedPath }; }
  catch (e) { return { error: e.message }; }
}

export async function copyFile(args, trustLevel, policy = {}) {
  const a = resolveWorkspacePath(args.from, policy); if (a.error) return { error: a.error };
  const b = resolveWorkspacePath(args.to, policy); if (b.error) return { error: b.error };
  const allowed = await checkTrust('files', trustLevel, `Copy ${a.resolvedPath} -> ${b.resolvedPath}`, true);
  if (!allowed) return { error: 'Permission denied' };
  try { copyFileSync(a.resolvedPath, b.resolvedPath); return { status: 'copied' }; }
  catch (e) { return { error: e.message }; }
}

export async function deleteFile(args, trustLevel, policy = {}) {
  const p = resolveWorkspacePath(args.path, policy); if (p.error) return { error: p.error };
  const allowed = await checkTrust('files', trustLevel, `Delete ${p.resolvedPath}`, false);
  if (!allowed) return { error: 'Permission denied' };
  try {
    if (!existsSync(p.resolvedPath)) return { error: 'Not found' };
    const st = statSync(p.resolvedPath);
    if (st.isDirectory()) rmSync(p.resolvedPath, { recursive: true, force: true });
    else unlinkSync(p.resolvedPath);
    return { status: 'deleted', path: p.resolvedPath };
  } catch (e) { return { error: e.message }; }
}

export async function makeDirectory(args, trustLevel, policy = {}) {
  const p = resolveWorkspacePath(args.path, policy); if (p.error) return { error: p.error };
  const allowed = await checkTrust('files', trustLevel, `Create directory ${p.resolvedPath}`, true);
  if (!allowed) return { error: 'Permission denied' };
  try { mkdirSync(p.resolvedPath, { recursive: true }); return { status: 'created', path: p.resolvedPath }; }
  catch (e) { return { error: e.message }; }
}
