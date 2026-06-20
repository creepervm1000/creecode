import { OpenAIProvider } from './openai.js';
import { getProviderAuth, setProviderAuth, getProviderAccounts, setProviderCurrentAccount, getProviderCurrentAccount, clearProviderAuth, generatePkce, generateState, openBrowser, startCallbackServer } from '../auth.js';
import { info, warn } from '../utils/logger.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * OpenAI Codex provider.
 *
 * Authenticates with OpenAI via OAuth (PKCE) using a user's ChatGPT/Codex
 * subscription. Tokens are stored in ~/.creecode/auth.json under
 * `providers.codex`. The provider is wire-compatible with OpenAIProvider
 * (same /v1/chat/completions endpoint) — only the Authorization header
 * source differs.
 *
 * Usage from the REPL:  /login codex
 *   - opens the browser to OpenAI's auth page
 *   - waits for the localhost callback
 *   - exchanges the code for access + refresh tokens
 *   - stores them and starts working
 *
 * Use /logout codex to clear.
 *
 * Token refresh: handled transparently in getAccessToken() — if the
 * access token is within 60s of expiry, refresh.
 *
 * Multi-account support: stores multiple accounts under `providers.codex.accounts`
 * and rotates on rate limits (429).
 */

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';  // public OAuth client id from openai-codex
const AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_PORT = 1455;
const DEFAULT_REDIRECT = `http://localhost:${DEFAULT_PORT}/auth/callback`;
const SCOPES = ['openid', 'profile', 'email', 'offline_access'];

async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: DEFAULT_REDIRECT,
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Codex token exchange failed (${res.status}): ${text}`);
  }
  return await res.json();
}

async function refreshTokens(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Codex refresh failed (${res.status}): ${text}`);
  }
  return await res.json();
}

function decodeJwtPayload(jwt) {
  if (!jwt) return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded + '='.repeat((4 - padded.length % 4) % 4), 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch { return null; }
}

export async function codexLogin({ port = DEFAULT_PORT, open = true, printUrl, accountId = 'default' } = {}) {
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: DEFAULT_REDIRECT,
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
  });
  const url = `${AUTH_URL}?${params.toString()}`;

  if (printUrl) printUrl(url);
  if (open) {
    info('Opening browser for OpenAI Codex login...');
    openBrowser(url);
  } else {
    info('Open this URL in your browser to continue:');
    info(url);
  }
  info(`(waiting for callback on http://localhost:${port}/auth/callback)`);

  const server = await startCallbackServer(port, '/auth/callback');
  let code;
  try { code = await server.waitForCode(); }
  finally { server.close(); }

  info('Got auth code. Exchanging for tokens...');
  const tok = await exchangeCode(code, verifier);
  const idClaims = decodeJwtPayload(tok.id_token);
  const stored = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (tok.expires_in || 3600),
    id_token: tok.id_token,
    account_id: idClaims?.['https://api.openai.com/auth']?.chatgpt_account_id
              || idClaims?.chatgpt_account_id
              || null,
    email: idClaims?.email || null,
  };
  setProviderAuth('codex', stored, accountId);
  return { ok: true, email: stored.email, account_id: stored.account_id };
}

export function codexLogout(accountId) {
  clearProviderAuth('codex', accountId);
  return { ok: true };
}

export function codexStatus() {
  const accounts = getProviderAccounts('codex');
  if (!accounts || Object.keys(accounts).length === 0) return { logged_in: false };
  const current = getProviderCurrentAccount('codex') || Object.keys(accounts)[0];
  const a = accounts[current];
  if (!a) return { logged_in: false };
  const exp = a.expires_at ? new Date(a.expires_at * 1000).toISOString() : null;
  return { logged_in: true, email: a.email, account_id: a.account_id, expires_at: exp, currentAccount: current, accounts: Object.keys(accounts) };
}

export class CodexProvider extends OpenAIProvider {
  constructor(config = {}) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://api.openai.com/v1',
      model: config.model || 'gpt-5-codex',
    });
    this.kind = 'codex';
    this.accounts = config.accounts || [];
    this.currentAccountIndex = 0;
    this.enableAccountRotation = this.accounts.length > 1;
  }

  getCurrentAccountId() {
    if (this.enableAccountRotation && this.accounts.length > 0) {
      return this.accounts[this.currentAccountIndex];
    }
    return getProviderCurrentAccount('codex') || 'default';
  }

  rotateAccount() {
    if (!this.enableAccountRotation || this.accounts.length <= 1) {
      return false;
    }
    this.currentAccountIndex = (this.currentAccountIndex + 1) % this.accounts.length;
    return true;
  }

  async getAccessToken(accountId) {
    const targetAccount = accountId || this.getCurrentAccountId();
    let auth = getProviderAuth('codex');
    if (!auth || !auth.access_token) {
      throw new Error('Not logged in to Codex. Run: /login codex');
    }
    const now = Math.floor(Date.now() / 1000);
    if (auth.expires_at && auth.expires_at - now < 60 && auth.refresh_token) {
      try {
        const refreshed = await refreshTokens(auth.refresh_token);
        auth = {
          ...auth,
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token || auth.refresh_token,
          expires_at: Math.floor(Date.now() / 1000) + (refreshed.expires_in || 3600),
          id_token: refreshed.id_token || auth.id_token,
        };
        setProviderAuth('codex', auth, targetAccount);
      } catch (e) {
        throw new Error(`Codex token refresh failed: ${e.message}. Run: /login codex`);
      }
    }
    return auth.access_token;
  }

  buildHeaders() {
    if (!this._token) throw new Error('CodexProvider: token not loaded. Call ensureAuth() first.');
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this._token}`,
      'ChatGPT-Account-ID': this._accountId || '',
    };
  }

  async ensureAuth(accountId) {
    this._token = await this.getAccessToken(accountId);
    const targetAccount = accountId || this.getCurrentAccountId();
    const a = getProviderAccounts('codex')[targetAccount];
    this._accountId = a?.account_id || '';
  }

  async fetchWithRetry(url, options = {}, opts = {}) {
    const onRetry = opts.onRetry;
    let lastErr = null;
    const maxAttempts = Math.max(1, opts.attempts ?? this.retryAttempts);
    const delayMs = opts.delayMs ?? this.retryDelayMs;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const accountId = this.getCurrentAccountId();
        await this.ensureAuth(accountId);
        const res = await super.fetchWithRetry(url, {
          ...options,
          headers: {
            ...(options.headers || {}),
            'Authorization': `Bearer ${this._token}`,
            'ChatGPT-Account-ID': this._accountId || '',
          },
        }, opts);
        return res;
      } catch (e) {
        lastErr = e;
        if (e.message.includes('429') && this.rotateAccount()) {
          if (onRetry) onRetry(attempt, 429, new Error('Rate limited, rotating account'));
          await sleep(delayMs);
          continue;
        }
        if (attempt === maxAttempts) throw e;
        if (onRetry) onRetry(attempt, null, e);
        await sleep(delayMs);
      }
    }
    throw lastErr || new Error('fetchWithRetry: exhausted attempts');
  }

  async chat(messages) {
    await this.ensureAuth();
    return super.chat(messages);
  }

  async streamChat(messages, onChunk) {
    await this.ensureAuth();
    return super.streamChat(messages, onChunk);
  }

  async listModels() {
    await this.ensureAuth();
    try {
      const res = await this.fetchWithRetry(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this._token}`, 'ChatGPT-Account-ID': this._accountId || '' },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.data || []).map(m => ({
        id: m.id,
        owned_by: m.owned_by || null,
        tags: m.id.includes('codex') ? ['codex'] : [],
        created: m.created || null,
      }));
    } catch { return []; }
  }
}
