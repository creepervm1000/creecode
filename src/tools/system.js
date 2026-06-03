import { cpus, totalmem, freemem, platform, arch, release, hostname, userInfo, uptime as osUptime, networkInterfaces, homedir, tmpdir } from 'node:os';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { checkTrust } from '../trust.js';
import { getWorkspaceRoot, resolveWorkspacePath } from '../workspace.js';

/**
 * System info & project tree. Read-only.
 */

export async function osInfo() {
  const cpusInfo = cpus() || [];
  return {
    hostname: hostname(),
    user: userInfo().username,
    home: homedir(),
    tmp: tmpdir(),
    platform,
    arch,
    kernel: release(),
    uptime_seconds: Math.floor(osUptime()),
    node_version: process.version,
    pid: process.pid,
    cwd: process.cwd(),
    workspace_root: getWorkspaceRoot(),
    cpus: { model: cpusInfo[0]?.model, count: cpusInfo.length, speed_mhz: cpusInfo[0]?.speed },
    memory: {
      total_bytes: totalmem(),
      free_bytes: freemem(),
      used_bytes: totalmem() - freemem(),
      process_rss_bytes: process.memoryUsage().rss,
      process_heap_bytes: process.memoryUsage().heapUsed,
    },
    network: summarizeNics(),
  };
}

function summarizeNics() {
  const out = [];
  try {
    for (const [name, infos] of Object.entries(networkInterfaces() || {})) {
      for (const i of infos || []) {
        if (i.family === 'IPv4') out.push({ name, ipv4: i.address, internal: !!i.internal });
      }
    }
  } catch {}
  return out;
}

const DEFAULT_IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', '.venv', '__pycache__', '.creecode', 'coverage', '.parcel-cache']);

function buildTree(dir, prefix, ignore, maxDepth, depth, out) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  // directories first, then files; alpha sort
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  let visible = entries.filter(e => !ignore.has(e.name));
  for (let i = 0; i < visible.length; i++) {
    const e = visible[i];
    const last = i === visible.length - 1;
    const connector = last ? '└── ' : '├── ';
    const child = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(prefix + connector + e.name + sep);
      buildTree(child, prefix + (last ? '    ' : '│   '), ignore, maxDepth, depth + 1, out);
    } else {
      let size = '';
      try {
        const st = statSync(child);
        size = ` (${formatBytes(st.size)})`;
      } catch {}
      out.push(prefix + connector + e.name + size);
    }
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}G`;
}

export async function projectTree(args, trustLevel, config = {}) {
  const p = resolveWorkspacePath(args.path || '.', config);
  if (p.error) return { error: p.error };
  if (!existsSync(p.resolvedPath)) return { error: 'Path not found' };
  const allowed = await checkTrust('system', trustLevel, `List tree: ${p.resolvedPath}`, true);
  if (!allowed) return { error: 'Permission denied' };
  const maxDepth = Math.max(0, Math.min(20, args.max_depth || 5));
  const ignoreList = new Set(DEFAULT_IGNORE);
  if (Array.isArray(args.ignore)) for (const x of args.ignore) ignoreList.add(x);
  const out = [`.${sep}`];
  buildTree(p.resolvedPath, '', ignoreList, maxDepth, 1, out);
  return { path: p.resolvedPath, lines: out.length, tree: out.join('\n') };
}

export async function diskUsage(args, trustLevel, config = {}) {
  const p = resolveWorkspacePath(args.path || '.', config);
  if (p.error) return { error: p.error };
  if (!existsSync(p.resolvedPath)) return { error: 'Path not found' };
  const allowed = await checkTrust('system', trustLevel, `Disk usage: ${p.resolvedPath}`, true);
  if (!allowed) return { error: 'Permission denied' };
  const total = { files: 0, dirs: 0, bytes: 0 };
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = join(dir, e.name);
      if (e.isDirectory()) { total.dirs++; walk(child); }
      else if (e.isFile()) {
        total.files++;
        try { total.bytes += statSync(child).size; } catch {}
      }
    }
  }
  walk(p.resolvedPath);
  return {
    path: p.resolvedPath,
    files: total.files,
    directories: total.dirs,
    bytes: total.bytes,
    human: formatBytes(total.bytes),
  };
}
