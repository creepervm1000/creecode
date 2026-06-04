import { OpenAIProvider } from './openai.js';
import { getToken, setToken, requestDeviceCode, pollDeviceToken } from '../oauth.js';

/**
 * OpenAI Codex (ChatGPT OAuth) provider.
 *
 * Auth: OAuth Device Flow at auth0.openai.com with scope
 *   "openid profile email offline_access"
 * The returned access_token can be used as a Bearer token against the
 * standard OpenAI-compatible API at https://api.openai.com/v1.
 *
 * Public client_id used by the official Codex CLI:
 *   "app_EMoamEEZ73f0CkXaXp7hrann"
 */
const DEVICE_URL = 'https://auth0.openai.com/oauth/device/code';
const TOKEN_URL = 'https://auth0.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPE = 'openid profile email offline_access';

export class OpenAICodexProvider extends OpenAIProvider {
  constructor(config = {}) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://api.openai.com/v1',
      apiKey: config.apiKey || 'placeholder',
    });
  }

  async fetchWithRetry(url, options = {}, opts = {}) {
    const token = this._getAccessToken();
    return super.fetchWithRetry(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        'Authorization': `Bearer ${token}`,
        'ChatGPT-Account-Id': this._accountId() || '',
      },
    }, opts);
  }

  _getAccessToken() {
    const stored = getToken('openai-codex');
    if (!stored || !stored.access_token) {
      throw new Error('OpenAI Codex not authenticated. Run "creecode auth openai-codex" or use the /settings provider wizard.');
    }
    return stored.access_token;
  }

  _accountId() {
    const stored = getToken('openai-codex');
    if (!stored || !stored.id_token) return null;
    try {
      const payload = JSON.parse(Buffer.from(stored.id_token.split('.')[1], 'base64').toString('utf-8'));
      return payload['https://api.openai.com/auth']?.chatgpt_account_id || null;
    } catch { return null; }
  }
}

export async function startOpenAICodexAuth({ onPrompt } = {}) {
  const dc = await requestDeviceCode({ url: DEVICE_URL, clientId: CLIENT_ID, scope: SCOPE });
  if (onPrompt) onPrompt({
    verifyUrl: dc.verifyUrl,
    userCode: dc.userCode,
    interval: dc.interval,
  });
  const token = await pollDeviceToken({
    url: TOKEN_URL,
    clientId: CLIENT_ID,
    deviceCode: dc.deviceCode,
    interval: dc.interval,
    expiresIn: dc.expiresIn,
  });
  setToken('openai-codex', {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    id_token: token.id_token,
    expires_in: token.expires_in,
    scope: token.scope,
    obtained_at: Date.now(),
  });
  return { ok: true, scope: token.scope };
}
