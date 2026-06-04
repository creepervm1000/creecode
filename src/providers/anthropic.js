import { BaseProvider } from './base.js';

/**
 * Anthropic-compatible provider.
 * Works with: Anthropic (Claude) and any custom Anthropic-compatible endpoint.
 */
export class AnthropicProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
    this.model = config.model || 'claude-sonnet-4-20250514';
    this.anthropicVersion = config.anthropicVersion || '2023-06-01';
  }

  _convertMessages(messages) {
    // Anthropic requires system to be separate from messages
    let system = '';
    const filtered = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system += (system ? '\n' : '') + msg.content;
      } else {
        filtered.push({ role: msg.role, content: msg.content });
      }
    }

    return { system, messages: filtered };
  }

  async chat(messages) {
    const { system, messages: msgs } = this._convertMessages(messages);

    const body = {
      model: this.model,
      max_tokens: 8192,
      messages: msgs,
    };
    if (system) body.system = system;

    const res = await this.request(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.anthropicVersion,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    // Anthropic returns content as an array of blocks
    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    return textBlocks.map(b => b.text).join('') || '';
  }

  async streamChat(messages, onChunk) {
    const { system, messages: msgs } = this._convertMessages(messages);

    const body = {
      model: this.model,
      max_tokens: 8192,
      messages: msgs,
      stream: true,
    };
    if (system) body.system = system;

    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.anthropicVersion,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`API error ${res.status}: ${errBody}`);
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

        try {
          const json = JSON.parse(payload);
          if (json.type === 'content_block_delta' && json.delta?.text) {
            full += json.delta.text;
            this.emitContent(onChunk, json.delta.text);
          }
        } catch {
          // skip
        }
      }
    }

    return full;
  }

  async listModels() {
    try {
      const res = await this.fetchWithRetry(`${this.baseUrl}/v1/models`, {
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.data || []).map(m => ({
        id: m.id,
        display_name: m.display_name || null,
        tags: deriveAnthropicTags(m.id),
      }));
    } catch { return []; }
  }
}

function deriveAnthropicTags(id) {
  if (!id) return [];
  const tags = [];
  if (id.includes('opus')) tags.push('opus', 'flagship');
  else if (id.includes('sonnet')) tags.push('sonnet', 'mid');
  else if (id.includes('haiku')) tags.push('haiku', 'small');
  if (id.includes('claude-3-5') || id.includes('claude-3.5')) tags.push('claude-3.5');
  else if (id.includes('claude-3')) tags.push('claude-3');
  else if (id.includes('claude-4') || id.includes('claude-sonnet-4') || id.includes('claude-opus-4')) tags.push('claude-4');
  if (id.includes('vision')) tags.push('vision');
  return tags;
}
