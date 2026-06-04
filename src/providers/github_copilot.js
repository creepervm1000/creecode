import { OpenAIProvider } from './openai.js';
import { getToken, setToken, requestDeviceCode, pollDeviceToken } from '../oauth.js';

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
  }

  async fetchWithRetry(url, options = {}, opts = {}) {
    await this.ensureCopilotToken();
    return super.fetchWithRetry(url, {
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
  }

  async ensureCopilotToken() {
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
    setToken('github-copilot', { ...stored, lastCopilotTokenAt: Date.now() });
  }
}

/**
 * Run the device-code auth flow. Returns the user-facing instructions.
 * Call this from a CLI subcommand or the in-REPL /settings wizard.
 */
export async function startGitHubCopilotAuth({ onPrompt } = {}) {
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
  setToken('github-copilot', { ghAccessToken: token.access_token, scope: token.scope });
  return { ok: true, scope: token.scope };
}
