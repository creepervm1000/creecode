/**
 * Base provider class. All LLM providers extend this.
 */

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);
const DEFAULT_RETRY_DELAY_MS = 2000;
const DEFAULT_RETRY_ATTEMPTS = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export class BaseProvider {
  constructor(config = {}) {
    this.apiKey = config.apiKey || '';
    this.apiKeys = config.apiKeys || [];
    this.model = config.model || '';
    this.baseUrl = config.baseUrl || '';
    this.fetchFn = config.fetchFn || globalThis.fetch;
    this.toolCallMode = config.toolCallMode || 'xml';
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.retryAttempts = config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    this.currentKeyIndex = 0;
    this.enableKeyRotation = this.apiKeys.length > 1 || (this.apiKey && this.apiKeys.length === 1);
  }

  supportsNativeToolCalling() {
    return false;
  }

  emitContent(callbacks, chunk) {
    if (!chunk) return;
    if (typeof callbacks === 'function') {
      callbacks(chunk);
      return;
    }
    if (callbacks?.onContent) callbacks.onContent(chunk);
  }

  emitThinking(callbacks, chunk) {
    if (!chunk) return;
    if (callbacks?.onThinking) callbacks.onThinking(chunk);
  }

  getCurrentApiKey() {
    if (this.enableKeyRotation && this.apiKeys.length > 0) {
      return this.apiKeys[this.currentKeyIndex];
    }
    return this.apiKey;
  }

  rotateApiKey() {
    if (!this.enableKeyRotation || this.apiKeys.length <= 1) {
      return false;
    }
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    return true;
  }

  async fetchWithRetry(url, options = {}, opts = {}) {
    const maxAttempts = Math.max(1, opts.attempts ?? this.retryAttempts);
    const delayMs = opts.delayMs ?? this.retryDelayMs;
    const onRetry = opts.onRetry;
    let lastErr = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res;
      try {
        const currentKey = this.getCurrentApiKey();
        const headers = { ...(options.headers || {}) };
        if (currentKey && !headers.Authorization) {
          headers.Authorization = `Bearer ${currentKey}`;
        }
        res = await this.fetchFn(url, { ...options, headers });
      } catch (e) {
        lastErr = e;
        if (attempt === maxAttempts) throw e;
        if (onRetry) onRetry(attempt, null, e);
        await sleep(delayMs);
        continue;
      }
      if (res.ok) return res;
      const retriable = RETRYABLE_STATUSES.has(res.status);
      await res.text().catch(() => '');
      if (!retriable) {
        throw new Error(`API error ${res.status}`);
      }
      if (res.status === 429 && this.rotateApiKey()) {
        if (onRetry) onRetry(attempt, res.status, new Error('Rate limited, rotating key'));
        await sleep(delayMs);
        continue;
      }
      if (attempt === maxAttempts) {
        throw new Error(`API error ${res.status} (after ${maxAttempts} attempts)`);
      }
      lastErr = new Error(`API error ${res.status}`);
      if (onRetry) onRetry(attempt, res.status, lastErr);
      await sleep(delayMs);
    }
    throw lastErr || new Error('fetchWithRetry: exhausted attempts');
  }

  async request(url, options) {
    const res = await this.fetchWithRetry(url, options);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API error ${res.status}: ${body}`);
    }
    return res;
  }
}
