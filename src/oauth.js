import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { safeJsonParse } from './utils/safe_json.js';

/**
 * OAuth token store and device-code flow helper.
 *
 * Tokens are persisted at ~/.creecode/oauth.json with a per-provider entry:
 *   {
 *     "github-copilot": {
 *       "accounts": {
 *         "account1": { "ghAccessToken": "...", "scope": "copilot" },
 *         "account2": { ... }
 *       },
 *       "currentAccount": "account1"
 *     }
 *   }
 *
 * The device-code flow follows RFC 8628. Two steps:
 *   1. requestDeviceCode({ clientId, scope, deviceUrl }) -> { deviceCode, userCode, verifyUrl, interval }
 *   2. pollDeviceToken({ clientId, deviceCode, deviceTokenUrl, interval }) -> { access_token, refresh_token, ... }
 *
 * The verifier just plugs the right client_id/URL pair into these helpers.
 */

const STORE_PATH = join(homedir(), '.creecode', 'oauth.json');

export function loadTokens() {
  if (!existsSync(STORE_PATH)) return {};
  try { return safeJsonParse(readFileSync(STORE_PATH, 'utf-8')) || {}; } catch { return {}; }
}

export function saveTokens(tokens) {
  mkdirSync(join(homedir(), '.creecode'), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(tokens, null, 2), 'utf-8');
}

export function getToken(provider) {
  const all = loadTokens();
  const providerData = all[provider];
  if (!providerData) return null;
  if (providerData.accounts) {
    const current = providerData.currentAccount || Object.keys(providerData.accounts)[0];
    return providerData.accounts[current] || null;
  }
  return providerData;
}

export function getTokenAccounts(provider) {
  const all = loadTokens();
  const providerData = all[provider];
  if (!providerData) return {};
  if (providerData.accounts) {
    return providerData.accounts;
  }
  return { default: providerData };
}

export function setToken(provider, data, accountId = 'default') {
  const all = loadTokens();
  if (!all[provider] || !all[provider].accounts) {
    all[provider] = { accounts: {}, currentAccount: accountId };
  }
  all[provider].accounts[accountId] = { ...(all[provider].accounts[accountId] || {}), ...data, saved_at: Date.now() };
  all[provider].currentAccount = accountId;
  saveTokens(all);
}

export function setTokenCurrentAccount(provider, accountId) {
  const all = loadTokens();
  if (all[provider]?.accounts?.[accountId]) {
    all[provider].currentAccount = accountId;
    saveTokens(all);
    return true;
  }
  return false;
}

export function getTokenCurrentAccount(provider) {
  const all = loadTokens();
  return all[provider]?.currentAccount || null;
}

export function clearToken(provider, accountId) {
  const all = loadTokens();
  if (!all[provider]) return;
  if (accountId && all[provider].accounts) {
    delete all[provider].accounts[accountId];
    if (all[provider].currentAccount === accountId) {
      const remaining = Object.keys(all[provider].accounts);
      all[provider].currentAccount = remaining[0] || null;
    }
    if (Object.keys(all[provider].accounts).length === 0) {
      delete all[provider];
    }
  } else {
    delete all[provider];
  }
  saveTokens(all);
}

/**
 * Generic RFC 8628 device-code request.
 * Returns: { deviceCode, userCode, verifyUrl, interval, expiresIn }
 */
export async function requestDeviceCode({ url, clientId, scope }) {
  const body = new URLSearchParams({ client_id: clientId, scope });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Device code request failed: HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verifyUrl: data.verification_uri || data.verification_url,
    interval: data.interval || 5,
    expiresIn: data.expires_in || 900,
  };
}

/**
 * Poll the device-token endpoint until authorization completes, expires, or
 * is denied. Returns the parsed token response on success.
 */
export async function pollDeviceToken({ url, clientId, deviceCode, interval, expiresIn, onTick }) {
  const start = Date.now();
  let wait = (interval || 5) * 1000;
  while (Date.now() - start < (expiresIn || 900) * 1000) {
    await new Promise(r => setTimeout(r, wait));
    if (onTick) onTick();
    let data;
    try {
      const body = new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: body.toString(),
      });
      data = await res.json();
    } catch (e) {
      continue;  // network blip, retry
    }
    if (data.access_token || data.token) {
      return data;
    }
    if (data.error === 'authorization_pending' || data.error === 'slow_down') {
      if (data.error === 'slow_down') wait = Math.min(wait + 5000, 30000);
      continue;
    }
    if (data.error === 'expired_token') {
      throw new Error('Device code expired before authorization completed.');
    }
    if (data.error === 'access_denied') {
      throw new Error('Authorization was denied by the user.');
    }
    if (data.error) {
      throw new Error(`OAuth error: ${data.error}${data.error_description ? ' — ' + data.error_description : ''}`);
    }
  }
  throw new Error('Device code flow timed out.');
}
