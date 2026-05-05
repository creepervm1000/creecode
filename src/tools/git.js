import { spawn } from 'node:child_process';
import { checkTrust } from '../trust.js';
import { getWorkspaceRoot } from '../workspace.js';

function runGit(args, cwd, timeout = 15000) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false;
    const child = spawn('git', args, { cwd, env: { ...process.env, PAGER: 'cat' } });
    const killTimer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
    }, timeout);
    killTimer.unref();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(result);
    };
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => finish({ code, stdout, stderr }));
    child.on('error', e => finish({ code: -1, stdout: '', stderr: e.message }));
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
