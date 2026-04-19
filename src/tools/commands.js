import { spawn } from 'node:child_process';
import { checkTrust } from '../trust.js';
import { getWorkspaceRoot, resolveWorkspacePath } from '../workspace.js';

/**
 * Shell command execution tool.
 */

// Commands generally considered safe (read-only)
const SAFE_COMMANDS = [
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'which', 'echo',
  'pwd', 'whoami', 'date', 'uname', 'env', 'printenv', 'file', 'stat',
  'du', 'df', 'tree', 'diff', 'sort', 'uniq', 'tr', 'cut', 'awk', 'sed',
  'node --version', 'npm --version', 'git status', 'git log', 'git diff',
  'git branch', 'python --version', 'python3 --version', 'cargo --version',
  'go version', 'rustc --version', 'java --version',
];

function isSafeCommand(command) {
  const trimmed = command.trim();
  return SAFE_COMMANDS.some(safe => {
    return trimmed === safe || trimmed.startsWith(safe + ' ');
  });
}

export async function runCommand(args, trustLevel, policy = {}) {
  const command = args.command;
  const cwdResult = resolveWorkspacePath(args.cwd || '.', policy);
  if (cwdResult.error) return { error: cwdResult.error };
  const cwd = cwdResult.resolvedPath;
  const timeout = args.timeout || 30000; // 30s default
  const workspaceRoot = getWorkspaceRoot();

  const safe = isSafeCommand(command);
  const allowed = await checkTrust(
    'commands',
    trustLevel,
    `Run command: ${command}${cwd !== workspaceRoot ? ` (in ${cwd})` : ''}`,
    safe
  );
  if (!allowed) return { error: 'Permission denied' };

  const maxBytes = Math.max(1024, policy.commandMaxOutputBytes || 10000);
  // Hard cap live buffers at 4x the display cap so we don't OOM on a runaway
  // command, but still have enough to show a meaningful tail.
  const hardCap = maxBytes * 4;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;

    const child = spawn('bash', ['-c', command], {
      cwd,
      env: { ...process.env, PAGER: 'cat' },
    });

    const killTimer = setTimeout(() => {
      if (!child.killed) {
        killed = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        // Escalate to SIGKILL if still alive after 2s
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref();
      }
    }, timeout);
    killTimer.unref();

    const appendCapped = (buf, chunk) => {
      if (buf.length >= hardCap) return buf;
      const remaining = hardCap - buf.length;
      return buf + (chunk.length <= remaining ? chunk : chunk.slice(0, remaining));
    };

    child.stdout.on('data', (data) => {
      stdout = appendCapped(stdout, data.toString());
      if (stdout.length >= hardCap && stderr.length >= hardCap && !child.killed) {
        killed = true;
        try { child.kill('SIGTERM'); } catch {}
      }
    });

    child.stderr.on('data', (data) => {
      stderr = appendCapped(stderr, data.toString());
    });

    const finish = (code, errMsg) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const trunc = (s) => s.length > maxBytes
        ? s.slice(0, maxBytes) + `\n... (truncated at ${maxBytes} bytes, ${s.length}+ total)`
        : s;
      resolve({
        command,
        exitCode: typeof code === 'number' ? code : -1,
        stdout: trunc(stdout || ''),
        stderr: trunc(errMsg ? (stderr ? stderr + '\n' + errMsg : errMsg) : stderr || ''),
        killed,
        timedOut: killed,
      });
    };

    child.on('close', (code) => finish(code));
    child.on('error', (err) => finish(-1, err.message));
  });
}
