import { BaseProvider } from './base.js';

/**
 * Ollama provider for local models.
 * Connects to Ollama's REST API (default: localhost:11434).
 */
export class OllamaProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
    this.model = config.model || 'llama3.2';
  }

  /**
   * List available models from Ollama.
   */
  async listModels() {
    try {
      const res = await this.request(`${this.baseUrl}/api/tags`, {
        method: 'GET',
      });
      const data = await res.json();
      return (data.models || []).map(m => m.name);
    } catch {
      return [];
    }
  }

  async chat(messages) {
    const res = await this.request(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
      }),
    });

    const data = await res.json();
    return data.message?.content || '';
  }

  async streamChat(messages, onChunk) {
    const res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Ollama error ${res.status}: ${errBody}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          const chunk = json.message?.content || '';
          if (chunk) {
            full += chunk;
            if (onChunk) onChunk(chunk);
          }
        } catch {
          // skip
        }
      }
    }

    return full;
  }
}
