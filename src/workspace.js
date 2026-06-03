import { isAbsolute, relative, resolve, sep } from 'node:path';
import { platform } from 'node:os';

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

// Paths that are ALWAYS denied, even when allowOutsideWorkspace is true.
// Goal: stop the agent from nuking operating systems, firmware, other drives,
// etc. — regardless of trust level or sandbox configuration.
const SYSTEM_PATH_PATTERNS = platform() === 'win32' ? [
  // Windows: OS + Program Files on any drive root.
  /^[a-z]:[\\/]?$/i,                                 // drive root: C:\, D:\
  /^[a-z]:[\\/]windows[\\/]?$/i,                      // C:\Windows
  /^[a-z]:[\\/]program files([\\/].*)?$/i,            // C:\Program Files\...
  /^[a-z]:[\\/]program files \(x86\)([\\/].*)?$/i,    // C:\Program Files (x86)\...
  /^[a-z]:[\\/]programdata[\\/]?$/i,                  // C:\ProgramData
  /^[a-z]:[\\/]system volume information[\\/]?$/i,    // C:\System Volume Information
  /^[a-z]:[\\/](windows|recycler|\\$recycle\\.bin)[\\/]?$/i,
  /^[a-z]:[\\/](bootmgr|pagefile\\.sys|hiberfil\\.sys)$/i,
] : [
  // Unix: system directories that are dangerous to delete/write.
  /^\/($|\/)$/,                                      // /
  /^\/bin\/?$/, /^\/sbin\/?$/, /^\/lib\/?$/, /^\/lib64\/?$/,
  /^\/usr\/?(bin|sbin|lib|lib64|src|include|local)?\/?$/,
  /^\/etc\/?$/, /^\/boot\/?$/, /^\/root\/?$/,
  /^\/proc\/?$/, /^\/sys\/?$/, /^\/dev\/?$/,
  /^\/(var|srv|opt|mnt|media)(\/.*)?$/,
];

function normalizeForMatch(p) {
  // Resolve to absolute, then strip trailing separator (except drive roots).
  let s = resolve(p);
  if (s.length > 1 && (s.endsWith(sep) || s.endsWith('/'))) s = s.slice(0, -1);
  return s;
}

export function isDangerousPath(targetPath, policy = {}) {
  if (!targetPath) return false;
  const norm = normalizeForMatch(targetPath);
  for (const re of SYSTEM_PATH_PATTERNS) {
    if (re.test(norm)) return true;
  }
  for (const dangerous of policy.dangerousPaths || []) {
    if (!dangerous) continue;
    const d = normalizeForMatch(dangerous);
    if (norm === d) return true;
    if (norm.startsWith(d + sep) || norm.startsWith(d + '/')) return true;
  }
  return false;
}

export function resolveWorkspacePath(targetPath = '.', policy = {}) {
  const workspaceRoot = getWorkspaceRoot();
  let resolvedPath;
  try { resolvedPath = resolve(workspaceRoot, targetPath || '.'); }
  catch (e) { return { error: `Cannot resolve path: ${e.message}`, workspaceRoot, resolvedPath: null }; }

  // Hard system-path block — always denies, even with allowOutsideWorkspace.
  if (isDangerousPath(resolvedPath, policy)) {
    return {
      error: `Refusing to operate on dangerous system path: ${resolvedPath}. Add an explicit override in config.dangerousPaths bypass list if you really need this (not recommended).`,
      workspaceRoot,
      resolvedPath,
      dangerous: true,
    };
  }

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

// Heuristics for catching destructive shell commands even when the path
// is passed as a flag argument or relative.
const DANGEROUS_CMD_PATTERNS = platform() === 'win32' ? [
  // Recursive delete of root or system dirs.
  /\b(rm|del|rd|rmdir)\b[^\n]*\s\/[sq](\s|\/)[^\n]*[a-z]:\\(windows|program files|programdata|users\\all)/i,
  // `format X:` from any context.
  /\bformat\s+[a-z]:/i,
  // `diskpart clean` on physical disk.
  /\bdiskpart\b[^\n]*\bclean\b/i,
  // cipher /w on a drive root.
  /\bcipher\b[^\n]*\/w[^\n]*[a-z]:\\/i,
] : [
  // rm -rf with absolute root / system path
  /\brm\b[^\n]*\s-rf?[^\n]*\s+(\/|\/etc|\/boot|\/usr|\/var|\/bin|\/sbin)\b/i,
  // dd into a block device
  /\bdd\b[^\n]*\bof=\/dev\//i,
  // mkfs on a block device
  /\bmkfs[^\n]*\/dev\//i,
  // fdisk / parted writes
  /\b(fdisk|parted|sfdisk)\b[^\n]*\/dev\//i,
  // shutdown / reboot
  /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/i,
  // fork-bomb
  /:\(\)\s*\{.*\};\s*:/,
];

export function commandTouchesDangerous(cmd, policy = {}) {
  if (!cmd) return null;
  // Split out simple tokens (skip flags) to check each path-like arg.
  const tokens = String(cmd).split(/[\s|&;()<>]+/);
  for (const tok of tokens) {
    if (!tok || tok.startsWith('-') || tok.startsWith('--')) continue;
    if (isDangerousPath(tok, policy)) return { reason: 'path', value: tok };
  }
  for (const re of DANGEROUS_CMD_PATTERNS) {
    if (re.test(cmd)) return { reason: 'pattern', value: re.source };
  }
  return null;
}
