import { spawn } from 'node:child_process';
import { checkTrust } from '../trust.js';

export async function listProcesses(args, trustLevel) {
  const allowed = await checkTrust('process', trustLevel, 'List processes', true);
  if (!allowed) return { error: 'Permission denied' };
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('ps', ['-eo', 'pid,ppid,user,comm,%cpu,%mem,etime,args']);
    child.stdout.on('data', d => out += d.toString());
    child.on('close', () => resolve({ output: out.slice(0, 20000) }));
    child.on('error', e => resolve({ error: e.message }));
  });
}

export async function killProcess(args, trustLevel) {
  const allowed = await checkTrust('process', trustLevel, `Kill pid ${args.pid} signal ${args.signal || 'SIGTERM'}`, false);
  if (!allowed) return { error: 'Permission denied' };
  try { process.kill(args.pid, args.signal || 'SIGTERM'); return { status: 'signalled', pid: args.pid }; }
  catch (e) { return { error: e.message }; }
}
