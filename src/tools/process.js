import { spawn, execSync } from 'node:child_process';
import { checkTrust } from '../trust.js';

const IS_WIN = process.platform === 'win32';

export async function listProcesses(args, trustLevel) {
  const allowed = await checkTrust('process', trustLevel, 'List processes', true);
  if (!allowed) return { error: 'Permission denied' };

  if (IS_WIN) {
    // Windows: use tasklist
    return new Promise((resolve) => {
      let out = '', settled = false;
      const child = spawn('tasklist', ['/V', '/FO', 'CSV']);
      const killTimer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 10000);
      killTimer.unref();
      child.stdout.on('data', d => out += d.toString());
      child.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve({ output: out.slice(0, 20000) });
      });
      child.on('error', e => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve({ error: e.message });
      });
    });
  }

  // Linux/macOS: use ps
  return new Promise((resolve) => {
    let out = '', settled = false;
    const tryRun = (fmtArgs, onReject) => {
      const child = spawn('ps', fmtArgs);
      const killTimer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 10000);
      killTimer.unref();
      child.stdout.on('data', d => out += d.toString());
      child.on('close', code => {
        if (settled) return;
        clearTimeout(killTimer);
        if (code !== 0 && onReject) { out = ''; onReject(); return; }
        settled = true;
        resolve({ output: out.slice(0, 20000) });
      });
      child.on('error', e => {
        if (settled) return;
        clearTimeout(killTimer);
        if (onReject) { onReject(); return; }
        settled = true;
        resolve({ error: e.message });
      });
    };
    tryRun(['-eo', 'pid,ppid,user,comm,%cpu,%mem,etime,args'], () => {
      tryRun(['-axo', 'pid,ppid,user,comm,%cpu,%mem,etime,args']);
    });
  });
}

export async function killProcess(args, trustLevel) {
  const allowed = await checkTrust('process', trustLevel, `Kill pid ${args.pid} signal ${args.signal || 'SIGTERM'}`, false);
  if (!allowed) return { error: 'Permission denied' };
  try { process.kill(args.pid, args.signal || 'SIGTERM'); return { status: 'signalled', pid: args.pid }; }
  catch (e) { return { error: e.message }; }
}
