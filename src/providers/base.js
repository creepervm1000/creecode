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
    this.model = config.model || '';
    this.baseUrl = config.baseUrl || '';
    this.fetchFn = config.fetchFn || globalThis.fetch;
    this.toolCallMode = config.toolCallMode || 'xml';
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.retryAttempts = config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
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

  /**
   * Send messages and get a complete response.
   * @param {Array<{role: string, content: string}>} messages
   * @returns {Promise<string>} assistant message
   */
  async chat(messages) {
    throw new Error('chat() not implemented');
  }

  /**
   * Stream a response token-by-token.
   * @param {Array<{role: string, content: string}>} messages
   * @param {function(string): void} onChunk - called with each text chunk
   * @returns {Promise<string>} full assembled response
   */
  async streamChat(messages, onChunk) {
    // Default: fall back to non-streaming
    const response = await this.chat(messages);
    if (typeof response === 'string') {
      this.emitContent(onChunk, response);
    } else {
      this.emitThinking(onChunk, response?.thinking || '');
      this.emitContent(onChunk, response?.content || '');
    }
    return response;
  }

  /**
   * Fetch with automatic retry on transient HTTP errors (502/503/504, etc.)
   * and on network failures. Uses a fixed delay between attempts (default 2s).
   * Streaming responses (response.body) are passed through as-is on success —
   * a mid-stream disconnect will surface as a normal stream error, not a retry.
   */
  async fetchWithRetry(url, options = {}, opts = {}) {
    const maxAttempts = Math.max(1, opts.attempts ?? this.retryAttempts);
    const delayMs = opts.delayMs ?? this.retryDelayMs;
    const onRetry = opts.onRetry;  // (attempt, status, error) => void
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res;
      try {
        res = await this.fetchFn(url, options);
      } catch (e) {
        // Network-level error: retriable.
        lastErr = e;
        if (attempt === maxAttempts) throw e;
        if (onRetry) onRetry(attempt, null, e);
        await sleep(delayMs);
        continue;
      }
      if (res.ok) return res;
      const retriable = RETRYABLE_STATUSES.has(res.status);
      // Drain the body so the socket can be reused.
      await res.text().catch(() => '');
      if (!retriable) {
        // Non-retriable: surface immediately, do not loop.
        throw new Error(`API error ${res.status}`);
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

  /**
   * Helper to make fetch requests with error handling. Retries on transient
   * 5xx and 429/408 errors.
   */
  async request(url, options) {
    const res = await this.fetchWithRetry(url, options);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API error ${res.status}: ${body}`);
    }
    return res;
  }
}
