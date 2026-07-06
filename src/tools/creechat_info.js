/**
 * CreeChat AI-agent tools.
 * These are only useful when running inside the CreeChat integration.
 */

import { safeJsonParse } from '../utils/safe_json.js';

function apiUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}${path}`;
}

async function creechatRequest(baseUrl, token, method, path, body) {
  if (!baseUrl || !token) {
    return { error: 'CreeChat baseUrl/token not available in config' };
  }

  const headers = { Authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  try {
    const resp = await fetch(apiUrl(baseUrl, path), init);
    const text = await resp.text();
    let data = null;
    try { data = text ? safeJsonParse(text) : null; } catch {}
    if (!resp.ok) {
      return { error: `creechat api error ${resp.status}: ${data?.error || data?.message || text || 'request failed'}` };
    }
    return data;
  } catch (err) {
    return { error: `creechat request failed: ${err.message}` };
  }
}

function getCtx(config = {}) {
  return {
    baseUrl: config._creechatBaseUrl,
    token: config._creechatToken,
  };
}

export async function searchCreeChatUsers(args, trustLevel, config = {}) {
  const { baseUrl, token } = getCtx(config);
  const query = String(args.query || '').trim();
  if (!query) return { error: 'query is required' };
  const qs = new URLSearchParams({ query });
  return await creechatRequest(baseUrl, token, 'GET', `/api/bot/users?${qs.toString()}`);
}

export async function getCreeChatUser(args, trustLevel, config = {}) {
  const { baseUrl, token } = getCtx(config);
  const userId = String(args.userId || '').trim();
  if (!userId) return { error: 'userId is required' };
  return await creechatRequest(baseUrl, token, 'GET', `/api/bot/user/${encodeURIComponent(userId)}`);
}

export async function creechatDmUser(args, trustLevel, config = {}) {
  const { baseUrl, token } = getCtx(config);
  const userId = String(args.userId || '').trim();
  const text = String(args.text || '');
  if (!userId) return { error: 'userId is required' };
  if (!text) return { error: 'text is required' };
  return await creechatRequest(baseUrl, token, 'POST', '/api/bot/dm', { userId, text });
}

export async function creechatBlockUser(args, trustLevel, config = {}) {
  const { baseUrl, token } = getCtx(config);
  const userId = String(args.userId || '').trim();
  if (!userId) return { error: 'userId is required' };
  return await creechatRequest(baseUrl, token, 'POST', '/api/bot/block', { userId });
}

export async function creechatUnblockUser(args, trustLevel, config = {}) {
  const { baseUrl, token } = getCtx(config);
  const userId = String(args.userId || '').trim();
  if (!userId) return { error: 'userId is required' };
  return await creechatRequest(baseUrl, token, 'DELETE', `/api/bot/block/${encodeURIComponent(userId)}`);
}

export async function listCreeChatBlocks(args, trustLevel, config = {}) {
  const { baseUrl, token } = getCtx(config);
  return await creechatRequest(baseUrl, token, 'GET', '/api/bot/blocks');
}
