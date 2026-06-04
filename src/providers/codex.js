import { OpenAIProvider } from './openai.js';
import { getProviderAuth, setProviderAuth, generatePkce, generateState, openBrowser, startCallbackServer, clearProviderAuth } from '../auth.js';
import { info, warn } from '../utils/logger.js';

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

export async function codexLogin({ port = DEFAULT_PORT, open = true, printUrl } = {}) {
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
  setProviderAuth('codex', stored);
  return { ok: true, email: stored.email, account_id: stored.account_id };
}

export function codexLogout() {
  clearProviderAuth('codex');
  return { ok: true };
}

export function codexStatus() {
  const a = getProviderAuth('codex');
  if (!a) return { logged_in: false };
  const exp = a.expires_at ? new Date(a.expires_at * 1000).toISOString() : null;
  return { logged_in: true, email: a.email, account_id: a.account_id, expires_at: exp };
}

export class CodexProvider extends OpenAIProvider {
  constructor(config = {}) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://api.openai.com/v1',
      model: config.model || 'gpt-5-codex',
    });
    this.kind = 'codex';
  }

  async getAccessToken() {
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
        setProviderAuth('codex', auth);
      } catch (e) {
        throw new Error(`Codex token refresh failed: ${e.message}. Run: /login codex`);
      }
    }
    return auth.access_token;
  }

  buildHeaders() {
    // Async: we need the access token. But buildHeaders is sync in OpenAI.
    // We override the request path to inject the token at fetch time.
    // The parent class calls buildHeaders in chat() and streamChat().
    // To stay compatible, we expose a sync token cache updated by ensureAuth.
    if (!this._token) throw new Error('CodexProvider: token not loaded. Call ensureAuth() first.');
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this._token}`,
      'ChatGPT-Account-ID': this._accountId || '',
    };
  }

  async ensureAuth() {
    this._token = await this.getAccessToken();
    const a = getProviderAuth('codex');
    this._accountId = a?.account_id || '';
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
    // OpenAI's /models endpoint works with OAuth tokens too. We tag each
    // entry with a brief note about whether it looks like a codex model.
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
