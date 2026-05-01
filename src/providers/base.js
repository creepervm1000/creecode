/**
 * Base provider class. All LLM providers extend this.
 */
export class BaseProvider {
  constructor(config = {}) {
    this.apiKey = config.apiKey || '';
    this.model = config.model || '';
    this.baseUrl = config.baseUrl || '';
    this.fetchFn = config.fetchFn || globalThis.fetch;
    this.toolCallMode = config.toolCallMode || 'xml';
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
   * Helper to make fetch requests with error handling.
   */
  async request(url, options) {
    const res = await this.fetchFn(url, options);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API error ${res.status}: ${body}`);
    }
    return res;
  }
}
