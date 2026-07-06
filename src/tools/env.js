import { checkTrust } from '../trust.js';

const DEFAULT_DENY = ['TOKEN', 'KEY', 'SECRET', 'PASSWORD', 'CREDENTIAL'];

function makeDenyPatterns(denyKeys) {
  const keys = denyKeys && denyKeys.length > 0 ? denyKeys : DEFAULT_DENY;
  return keys.map(d => new RegExp('\\b' + d + '\\b', 'i'));
}

function isAllowed(key, patterns) {
  return !patterns.some(re => re.test(key));
}

export async function getEnv(args, trustLevel, config = {}) {
  const allowed = await checkTrust('process', trustLevel, `Read env ${args.name || '(all)'}`, true);
  if (!allowed) return { error: 'Permission denied' };
  const denyPatterns = makeDenyPatterns(config.envDenyKeys);
  if (args.name) {
    if (!isAllowed(args.name, denyPatterns)) return { error: 'Key blocked by envDenyKeys policy' };
    return { name: args.name, value: process.env[args.name] ?? null };
  }
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (isAllowed(k, denyPatterns)) out[k] = v;
  return { env: out };
}
