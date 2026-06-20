import { OpenAIProvider } from './openai.js';
import { getToken, getTokenAccounts, getTokenCurrentAccount, setToken, setTokenCurrentAccount, clearToken, requestDeviceCode, pollDeviceToken } from '../oauth.js';

/**
 * GitHub Copilot provider.
 *
 * Auth: GitHub OAuth Device Flow with scope "copilot". The access token is
 * exchanged at https://api.github.com/copilot_internal/v2/token for a
 * short-lived Copilot API token. We cache the latter and refresh as needed.
 *
 * Endpoint: https://api.githubcopilot.com — OpenAI-compatible (so we extend
 * OpenAIProvider and just override auth + base URL).
 *
 * Public client_id for Copilot CLI:
 *   "Iv1.b507a08c87ecfe98"  (the one used by the official gh/copilot extension)
 *
 * Multi-account support: stores multiple accounts under `github-copilot.accounts`
 * and rotates on rate limits (429).
 */
const GH_DEVICE_URL = 'https://github.com/login/device/code';
const GH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GH_COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const COPILOT_API = 'https://api.githubcopilot.com';
const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const SCOPE = 'read:user copilot';

export class GitHubCopilotProvider extends OpenAIProvider {
  constructor(config = {}) {
    super({
      ...config,
      baseUrl: config.baseUrl || COPILOT_API,
      apiKey: config.apiKey || 'placeholder',
    });
    this.copilotToken = null;     // { token, expiresAt }
    this.accounts = config.accounts || [];
    this.currentAccountIndex = 0;
    this.enableAccountRotation = this.accounts.length > 1;
  }

  getCurrentAccountId() {
    if (this.enableAccountRotation && this.accounts.length > 0) {
      return this.accounts[this.currentAccountIndex];
    }
    return getTokenCurrentAccount('github-copilot') || 'default';
  }

  rotateAccount() {
    if (!this.enableAccountRotation || this.accounts.length <= 1) {
      return false;
    }
    this.currentAccountIndex = (this.currentAccountIndex + 1) % this.accounts.length;
    return true;
  }

  async fetchWithRetry(url, options = {}, opts = {}) {
    const onRetry = opts.onRetry;
    let lastErr = null;
    const maxAttempts = Math.max(1, opts.attempts ?? this.retryAttempts);
    const delayMs = opts.delayMs ?? this.retryDelayMs;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const accountId = this.getCurrentAccountId();
        await this.ensureCopilotToken(accountId);
        const res = await super.fetchWithRetry(url, {
          ...options,
          headers: {
            ...(options.headers || {}),
            'Authorization': `Bearer ${this.copilotToken.token}`,
            'Editor-Version': 'vscode/1.85.1',
            'Editor-Plugin-Version': 'copilot/1.155.0',
            'User-Agent': 'GitHubCopilotChat/0.11.1',
            'Copilot-Integration-Id': 'vscode-chat',
          },
        }, opts);
        return res;
      } catch (e) {
        lastErr = e;
        if (e.message.includes('429') && this.rotateAccount()) {
          if (onRetry) onRetry(attempt, 429, new Error('Rate limited, rotating account'));
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        if (attempt === maxAttempts) throw e;
        if (onRetry) onRetry(attempt, null, e);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    throw lastErr || new Error('fetchWithRetry: exhausted attempts');
  }

  async ensureCopilotToken(accountId) {
    const targetAccount = accountId || this.getCurrentAccountId();
    const now = Date.now();
    if (this.copilotToken && this.copilotToken.expiresAt - now > 60_000) return;
    const stored = getToken('github-copilot');
    if (!stored || !stored.ghAccessToken) {
      throw new Error('GitHub Copilot not authenticated. Run "creecode auth github-copilot" or use the /settings provider wizard.');
    }
    // Exchange the OAuth token for a short-lived Copilot API token.
    const res = await fetch(GH_COPILOT_TOKEN_URL, {
      headers: {
        'Authorization': `token ${stored.ghAccessToken}`,
        'Accept': 'application/json',
        'User-Agent': 'GitHubCopilotChat/0.11.1',
      },
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Copilot token exchange failed: HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    this.copilotToken = {
      token: data.token,
      expiresAt: Date.now() + ((data.expires_at - Math.floor(Date.now() / 1000)) * 1000) - 60_000,
    };
    setToken('github-copilot', { ...stored, lastCopilotTokenAt: Date.now() }, targetAccount);
  }
}

/**
 * Run the device-code auth flow. Returns the user-facing instructions.
 * Call this from a CLI subcommand or the in-REPL /settings wizard.
 */
export async function startGitHubCopilotAuth({ onPrompt, accountId = 'default' } = {}) {
  const dc = await requestDeviceCode({ url: GH_DEVICE_URL, clientId: CLIENT_ID, scope: SCOPE });
  if (onPrompt) onPrompt({
    verifyUrl: dc.verifyUrl,
    userCode: dc.userCode,
    interval: dc.interval,
  });
  const token = await pollDeviceToken({
    url: GH_TOKEN_URL,
    clientId: CLIENT_ID,
    deviceCode: dc.deviceCode,
    interval: dc.interval,
    expiresIn: dc.expiresIn,
  });
  setToken('github-copilot', { ghAccessToken: token.access_token, scope: token.scope }, accountId);
  return { ok: true, scope: token.scope };
}

/**
 * Status / logout helpers for /settings and /login /logout.
 */
export function copilotStatus() {
  const accounts = getTokenAccounts('github-copilot');
  if (!accounts || Object.keys(accounts).length === 0) return { logged_in: false };
  const current = getTokenCurrentAccount('github-copilot') || Object.keys(accounts)[0];
  const a = accounts[current];
  if (!a || !a.ghAccessToken) return { logged_in: false };
  return {
    logged_in: true,
    token_preview: a.ghAccessToken.slice(0, 6) + '…' + a.ghAccessToken.slice(-4),
    scope: a.scope || null,
    currentAccount: current,
    accounts: Object.keys(accounts),
  };
}

export function copilotLogout(accountId) {
  clearToken('github-copilot', accountId);
  return { ok: true };
}
