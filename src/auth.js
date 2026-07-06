import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { safeJsonParse } from './utils/safe_json.js';

/**
 * Auth helper: stores per-provider OAuth / API tokens at
 * ~/.creecode/auth.json. Includes a PKCE-OAuth login flow used by Codex
 * (and any future OAuth-based provider) that opens the user's browser
 * and catches the redirect on a localhost callback server.
 *
 * Auth file shape:
 * {
 *   "providers": {
 *     "codex": {
 *       "accounts": {
 *         "account1": { "access_token": "...", "refresh_token": "...", "expires_at": 1234, ... },
 *         "account2": { ... }
 *       },
 *       "currentAccount": "account1"
 *     },
 *     "copilot": {
 *       "accounts": {
 *         "account1": { "ghAccessToken": "...", "scope": "copilot" },
 *         "account2": { ... }
 *       },
 *       "currentAccount": "account1"
 *     }
 *   }
 * }
 */

const AUTH_DIR = join(homedir(), '.creecode');
const AUTH_FILE = join(AUTH_DIR, 'auth.json');

function ensureDir() { mkdirSync(AUTH_DIR, { recursive: true }); }

export function loadAuth() {
  if (!existsSync(AUTH_FILE)) return { providers: {} };
  try { return safeJsonParse(readFileSync(AUTH_FILE, 'utf-8')); }
  catch { return { providers: {} }; }
}

export function saveAuth(data) {
  ensureDir();
  writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

export function getProviderAuth(providerId) {
  const a = loadAuth();
  const provider = a.providers?.[providerId];
  if (!provider) return null;
  if (provider.accounts) {
    const current = provider.currentAccount || Object.keys(provider.accounts)[0];
    return provider.accounts[current] || null;
  }
  return provider;
}

export function getProviderAccounts(providerId) {
  const a = loadAuth();
  const provider = a.providers?.[providerId];
  if (!provider) return {};
  if (provider.accounts) {
    return provider.accounts;
  }
  return { default: provider };
}

export function setProviderAuth(providerId, tokens, accountId = 'default') {
  const a = loadAuth();
  a.providers = a.providers || {};
  if (!a.providers[providerId] || !a.providers[providerId].accounts) {
    a.providers[providerId] = { accounts: {}, currentAccount: accountId };
  }
  a.providers[providerId].accounts[accountId] = tokens;
  a.providers[providerId].currentAccount = accountId;
  saveAuth(a);
}

export function setProviderCurrentAccount(providerId, accountId) {
  const a = loadAuth();
  if (a.providers?.[providerId]?.accounts?.[accountId]) {
    a.providers[providerId].currentAccount = accountId;
    saveAuth(a);
    return true;
  }
  return false;
}

export function clearProviderAuth(providerId, accountId) {
  const a = loadAuth();
  if (!a.providers?.[providerId]) return;
  if (accountId && a.providers[providerId].accounts) {
    delete a.providers[providerId].accounts[accountId];
    if (a.providers[providerId].currentAccount === accountId) {
      const remaining = Object.keys(a.providers[providerId].accounts);
      a.providers[providerId].currentAccount = remaining[0] || null;
    }
    if (Object.keys(a.providers[providerId].accounts).length === 0) {
      delete a.providers[providerId];
    }
  } else {
    delete a.providers[providerId];
  }
  saveAuth(a);
}

export function getProviderCurrentAccount(providerId) {
  const a = loadAuth();
  return a.providers?.[providerId]?.currentAccount || null;
}

// --- PKCE helpers ---

export function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function generateState() {
  return base64url(randomBytes(16));
}

export function openBrowser(url) {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'rundll32' : 'xdg-open';
  const args = platform() === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); }
  catch {}
}

// Start a localhost callback server, return { port, waitForCode } where
// waitForCode() is a Promise that resolves with the ?code= from the
// redirect, or rejects on timeout.
export function startCallbackServer(port, expectedPath, timeoutMs = 180000) {
  return new Promise((resolveServer, rejectServer) => {
    let resolveCode, rejectCode, timer;
    const server = createServer((req, res) => {
      try {
        const u = new URL(req.url, `http://localhost:${port}`);
        if (u.pathname === expectedPath) {
          const code = u.searchParams.get('code');
          const err = u.searchParams.get('error');
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!doctype html><html><body style="font-family:system-ui;padding:40px"><h2>${code ? 'OK' : 'Auth failed'}</h2><p>${code ? 'You can close this window and return to the terminal.' : (err || 'unknown error')}</p></body></html>`);
          if (code) resolveCode(code); else rejectCode(new Error(err || 'no code'));
          clearTimeout(timer);
          setTimeout(() => server.close(), 500);
        } else {
          res.writeHead(404);
          res.end('not found');
        }
      } catch (e) { /* ignore */ }
    });
    server.on('error', rejectServer);
    server.listen(port, '127.0.0.1', () => {
      resolveServer({
        port,
        close: () => { try { server.close(); } catch {} },
        waitForCode: () => new Promise((res, rej) => { resolveCode = res; rejectCode = rej; }),
      });
    });
    timer = setTimeout(() => {
      try { server.close(); } catch {}
      rejectServer(new Error(`OAuth callback timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}
