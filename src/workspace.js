import { isAbsolute, relative, resolve } from 'node:path';

export function getWorkspaceRoot() {
  return resolve(process.cwd());
}

export function allowOutsideWorkspace(policy = {}) {
  return Boolean(policy.allowOutsideWorkspace);
}

export function isWithinWorkspace(targetPath, workspaceRoot = getWorkspaceRoot()) {
  const rel = relative(workspaceRoot, targetPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function resolveWorkspacePath(targetPath = '.', policy = {}) {
  const workspaceRoot = getWorkspaceRoot();
  const resolvedPath = resolve(workspaceRoot, targetPath);

  if (allowOutsideWorkspace(policy)) {
    return { workspaceRoot, resolvedPath };
  }

  if (!isWithinWorkspace(resolvedPath, workspaceRoot)) {
    return {
      error: `Path is outside the workspace root: ${workspaceRoot}`,
      workspaceRoot,
      resolvedPath,
    };
  }

  return { workspaceRoot, resolvedPath };
}
