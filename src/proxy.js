/**
 * Proxy support for HTTP/HTTPS requests.
 * Returns a custom fetch function that routes through the proxy.
 */

// Cache the undici import and per-proxy-url ProxyAgent across calls so we
// don't re-import undici twice per request and don't rebuild the agent on
// every fetch (which defeats TCP pooling).
let undiciPromise = null;
const agentCache = new Map();

function loadUndici() {
  if (!undiciPromise) {
    undiciPromise = import('undici');
  }
  return undiciPromise;
}

export function createProxyFetch(proxyUrl) {
  if (!proxyUrl) {
    return globalThis.fetch;
  }

  return async (url, options = {}) => {
    const { ProxyAgent, fetch: undiciFetch } = await loadUndici();
    let agent = agentCache.get(proxyUrl);
    if (!agent) {
      agent = new ProxyAgent(proxyUrl);
      agentCache.set(proxyUrl, agent);
    }
    return undiciFetch(url, { ...options, dispatcher: agent });
  };
}
