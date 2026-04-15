import { BaseProvider } from './base.js';

/**
 * OpenAI-compatible provider.
 * Works with: OpenAI, Grok (xAI), Groq, OpenRouter, and any custom OpenAI-compatible endpoint.
 */
export class OpenAIProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.model = config.model || 'gpt-4o';
  }

  async chat(messages) {
    const res = await this.request(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        ...(this.baseUrl.includes('openrouter.ai') && {
          'HTTP-Referer': 'https://git.creepernet.qzz.io/creeper/creecode',
          'X-Title': 'CreeCode',
        }),
      },
      body: JSON.stringify({
        model: this.model,
        messages,
      }),
    });

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  async streamChat(messages, onChunk) {
    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        ...(this.baseUrl.includes('openrouter.ai') && {
          'HTTP-Referer': 'https://git.creepernet.qzz.io/creeper/creecode',
          'X-Title': 'CreeCode',
        }),
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API error ${res.status}: ${body}`);
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
        if (!trimmed || !trimmed.startsWith('data:')) continue;
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
          // skip malformed chunks
        }
      }
    }

    return full;
  }
}
