import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkTrust } from '../trust.js';
import { resolveWorkspacePath } from '../workspace.js';

function hostAllowed(url, config) {
  try {
    const u = new URL(url);
    const deny = config.networkDenyHosts || [];
    const allow = config.networkAllowHosts || [];
    if (deny.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) return false;
    if (allow.length === 0) return true;
    return allow.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch { return false; }
}

export async function httpRequest(args, trustLevel, config = {}) {
  if (!hostAllowed(args.url, config)) return { error: `Host not allowed by network policy: ${args.url}` };
  const allowed = await checkTrust('network', trustLevel, `HTTP ${args.method || 'GET'} ${args.url}`, (args.method || 'GET').toUpperCase() === 'GET');
  if (!allowed) return { error: 'Permission denied' };
  const fetchFn = config.fetchFn || fetch;
  const timeout = args.timeout || config.networkTimeoutMs || 30000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetchFn(args.url, {
      method: args.method || 'GET',
      headers: args.headers || {},
      body: args.body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    const maxBytes = config.networkMaxBytes || 200000;
    return {
      status: res.status,
      ok: res.ok,
      headers: Object.fromEntries(res.headers.entries()),
      body: text.length > maxBytes ? text.slice(0, maxBytes) + `\n...(truncated ${text.length} total)` : text,
    };
  } catch (e) { return { error: e.message }; }
  finally { clearTimeout(t); }
}

export async function httpDownload(args, trustLevel, config = {}) {
  if (!hostAllowed(args.url, config)) return { error: `Host not allowed: ${args.url}` };
  const p = resolveWorkspacePath(args.path, config); if (p.error) return { error: p.error };
  const allowed = await checkTrust('network', trustLevel, `Download ${args.url} -> ${p.resolvedPath}`, false);
  if (!allowed) return { error: 'Permission denied' };
  const fetchFn = config.fetchFn || fetch;
  try {
    const res = await fetchFn(args.url);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(p.resolvedPath), { recursive: true });
    writeFileSync(p.resolvedPath, buf);
    return { status: 'downloaded', path: p.resolvedPath, bytes: buf.length };
  } catch (e) { return { error: e.message }; }
}
