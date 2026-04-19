import { checkTrust } from '../trust.js';

export async function getEnv(args, trustLevel, config = {}) {
  const allowed = await checkTrust('process', trustLevel, `Read env ${args.name || '(all)'}`, true);
  if (!allowed) return { error: 'Permission denied' };
  const deny = config.envDenyKeys || ['TOKEN', 'KEY', 'SECRET', 'PASSWORD'];
  const filt = k => !deny.some(d => k.toUpperCase().includes(d));
  if (args.name) {
    if (!filt(args.name)) return { error: 'Key blocked by envDenyKeys policy' };
    return { name: args.name, value: process.env[args.name] ?? null };
  }
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (filt(k)) out[k] = v;
  return { env: out };
}
