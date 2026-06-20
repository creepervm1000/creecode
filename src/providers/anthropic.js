import { BaseProvider } from './base.js';

/**
 * Anthropic-compatible provider (real + gateway-safe version).
 * Works with:
 * - official Anthropic API
 * - OpenAI→Anthropic translation gateways
 * - mixed model registries (important for your setup)
 */
export class AnthropicProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);

    this.baseUrl = (config.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    this.model = config.model || 'claude-sonnet-4-20250514';
    this.anthropicVersion = config.anthropicVersion || '2023-06-01';

    // some gateways break without this, harmless for real Anthropic
    this.betaHeader = config.betaHeader || null;

    // fallback models (useful for your proxy situation)
    this.fallbackModels = config.fallbackModels || [
      'gpt-5.5',
      'claude-sonnet-4-6',
      'claude-opus-4-6'
    ];
  }

  _convertMessages(messages) {
    let system = '';
    const filtered = [];

    for (const msg of messages) {
      if (!msg) continue;

      if (msg.role === 'system') {
        system += (system ? '\n' : '') + msg.content;
      } else {
        filtered.push({
          role: msg.role,
          content: typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content)
        });
      }
    }

    return { system, messages: filtered };
  }

  async _request(body) {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.anthropicVersion
    };

    if (this.betaHeader) {
      headers['anthropic-beta'] = this.betaHeader;
    }

    const res = await this.request(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`anthropic error ${res.status}: ${text}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`invalid json response: ${text}`);
    }
  }

  async chat(messages) {
    const { system, messages: msgs } = this._convertMessages(messages);

    const body = {
      model: this.model,
      max_tokens: 1024,
      messages: msgs
    };

    if (system) body.system = system;

    const data = await this._request(body);

    const textBlocks = (data.content || [])
    .filter(b => b && b.type === 'text')
    .map(b => b.text);

    return textBlocks.join('').trim();
  }

  async streamChat(messages, onChunk) {
    const { system, messages: msgs } = this._convertMessages(messages);

    const body = {
      model: this.model,
      max_tokens: 1024,
      messages: msgs,
      stream: true
    };

    if (system) body.system = system;

    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.anthropicVersion
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`stream error ${res.status}: ${err}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    let buffer = '';
    let full = '';

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
        if (!payload || payload === '[DONE]') continue;

        try {
          const json = JSON.parse(payload);

          // Anthropic streaming format
          if (json.type === 'content_block_delta') {
            const text = json.delta?.text || '';
            if (text) {
              full += text;
              this.emitContent(onChunk, text);
            }
          }
        } catch {
          // ignore malformed chunks (common in proxies)
        }
      }
    }

    return full;
  }

  async listModels() {
    try {
      const res = await this.fetchWithRetry(`${this.baseUrl}/v1/models`, {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': this.anthropicVersion
        }
      });

      const text = await res.text();
      if (!res.ok) return [];

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return [];
      }

      const models = data.data || [];

      return models.map(m => ({
        id: m.id,
        display_name: m.display_name || m.id,
        tags: deriveAnthropicTags(m.id)
      }));
    } catch {
      return [];
    }
  }

  // optional helper for your situation (VERY useful for debugging proxies)
  async testModel(model) {
    const { system, messages } = this._convertMessages([
      { role: 'user', content: 'reply with model id only' }
    ]);

    return this._request({
      model,
      max_tokens: 50,
      messages,
      ...(system ? { system } : {})
    });
  }
}

function deriveAnthropicTags(id) {
  if (!id) return [];

  const tags = [];

  if (id.includes('opus')) tags.push('opus', 'flagship');
  if (id.includes('sonnet')) tags.push('sonnet', 'mid');
  if (id.includes('haiku')) tags.push('haiku', 'small');

  if (id.includes('claude-4')) tags.push('claude-4');
  if (id.includes('claude-3')) tags.push('claude-3');

  return tags;
}
