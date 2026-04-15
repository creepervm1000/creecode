/**
 * Proxy support for HTTP/HTTPS requests.
 * Returns a custom fetch function that routes through the proxy.
 */

export function createProxyFetch(proxyUrl) {
  if (!proxyUrl) {
    return globalThis.fetch;
  }

  // Use undici ProxyAgent for HTTP/HTTPS proxies
  return async (url, options = {}) => {
    const { ProxyAgent } = await import('undici');
    const agent = new ProxyAgent(proxyUrl);

    const { default: undiciFetch } = await import('undici').then(m => ({ default: m.fetch }));

    return undiciFetch(url, {
      ...options,
      dispatcher: agent,
    });
  };
}
