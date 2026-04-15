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

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const child = spawn('bash', ['-c', command], {
      cwd,
      env: { ...process.env, PAGER: 'cat' },
      timeout,
    });

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      // Truncate very long output
      const maxLen = 10000;
      if (stdout.length > maxLen) {
        stdout = stdout.slice(0, maxLen) + `\n... (truncated, ${stdout.length} total chars)`;
      }
      if (stderr.length > maxLen) {
        stderr = stderr.slice(0, maxLen) + `\n... (truncated, ${stderr.length} total chars)`;
      }

      resolve({
        command,
        exitCode: code,
        stdout: stdout || '',
        stderr: stderr || '',
        killed,
      });
    });

    child.on('error', (err) => {
      resolve({
        command,
        exitCode: -1,
        stdout: '',
        stderr: err.message,
        killed: false,
      });
    });

    // Kill on timeout
    setTimeout(() => {
      if (!child.killed) {
        killed = true;
        child.kill('SIGTERM');
      }
    }, timeout);
  });
}
