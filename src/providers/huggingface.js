import { BaseProvider } from './base.js';

/**
 * HuggingFace Inference API provider.
 * Uses the text-generation endpoint with chat-compatible models.
 */
export class HuggingFaceProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.baseUrl = config.baseUrl || 'https://api-inference.huggingface.co';
    this.model = config.model || 'meta-llama/Llama-3.3-70B-Instruct';
  }

  async chat(messages) {
    const url = `${this.baseUrl}/models/${this.model}/v1/chat/completions`;

    const res = await this.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: 4096,
      }),
    });

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  async streamChat(messages, onChunk) {
    const url = `${this.baseUrl}/models/${this.model}/v1/chat/completions`;

    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: 4096,
        stream: true,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`HuggingFace error ${res.status}: ${errBody}`);
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
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;

        try {
          const json = JSON.parse(payload);
          const chunk = json.choices?.[0]?.delta?.content || '';
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
