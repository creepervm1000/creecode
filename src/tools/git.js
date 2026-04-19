import { spawn } from 'node:child_process';
import { checkTrust } from '../trust.js';
import { getWorkspaceRoot } from '../workspace.js';

function runGit(args, cwd, timeout = 15000) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    const child = spawn('git', args, { cwd, env: { ...process.env, PAGER: 'cat' } });
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', e => resolve({ code: -1, stdout: '', stderr: e.message }));
    setTimeout(() => child.kill('SIGTERM'), timeout);
  });
}

const READ_ONLY = new Set(['status', 'diff', 'log', 'branch', 'show', 'blame', 'remote', 'rev-parse', 'ls-files']);

export async function gitCommand(args, trustLevel, config = {}) {
  const sub = args.subcommand;
  if (!sub) return { error: 'subcommand is required' };
  const extra = Array.isArray(args.args) ? args.args : [];
  const safe = READ_ONLY.has(sub);
  const allowed = await checkTrust('git', trustLevel, `git ${sub} ${extra.join(' ')}`, safe);
  if (!allowed) return { error: 'Permission denied' };
  const r = await runGit([sub, ...extra], getWorkspaceRoot());
  const maxLen = 10000;
  const trunc = s => s.length > maxLen ? s.slice(0, maxLen) + `\n...(truncated)` : s;
  return { exitCode: r.code, stdout: trunc(r.stdout), stderr: trunc(r.stderr) };
}
