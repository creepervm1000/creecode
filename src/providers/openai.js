import { BaseProvider } from './base.js';
import { buildNativeToolDefinitions } from '../tools/index.js';

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

  buildHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };

    if (this.isOpenRouter()) {
      headers['HTTP-Referer'] = 'https://git.creepernet.qzz.io/creeper/creecode';
      headers['X-OpenRouter-Title'] = 'CreeCode';
      headers['X-Title'] = 'CreeCode';
      headers['X-OpenRouter-Categories'] = 'cli-agent';
    }

    return headers;
  }

  isOpenRouter() {
    return this.baseUrl.includes('openrouter.ai');
  }

  supportsNativeToolCalling() {
    return true;
  }

  shouldUseNativeToolCalling() {
    return ['native', 'both'].includes(this.toolCallMode) && this.supportsNativeToolCalling();
  }

  buildPayload(messages, { stream = false } = {}) {
    // Strip empty tool_calls from stored messages (some providers reject [])
    const clean = messages.map(m => {
      if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length === 0) {
        const { tool_calls, ...rest } = m;
        return rest;
      }
      return m;
    });

    const payload = {
      model: this.model,
      messages: clean,
    };

    if (stream && !this.shouldUseNativeToolCalling()) {
      payload.stream = true;
    }

    if (this.shouldUseNativeToolCalling()) {
      payload.tools = buildNativeToolDefinitions();
      payload.tool_choice = 'auto';
    }

    return payload;
  }

  parseAssistantMessage(message = {}) {
    const content = typeof message.content === 'string' ? message.content : '';
    const nativeToolCalls = (message.tool_calls || [])
      .filter(tc => tc?.type === 'function' && tc.function?.name)
      .map(tc => {
        let args = {};
        const rawArgs = tc.function?.arguments || '{}';
        try {
          args = rawArgs ? JSON.parse(rawArgs) : {};
        } catch {
          args = { _raw: rawArgs };
        }
        return {
          id: tc.id,
          name: tc.function.name,
          args,
        };
      });

    return {
      content,
      nativeToolCalls,
      assistantMessage: {
        role: 'assistant',
        content,
        ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
      },
    };
  }

  async chat(messages) {
    const res = await this.request(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(this.buildPayload(messages)),
    });

    const data = await res.json();
    const message = data.choices?.[0]?.message || {};
    return this.shouldUseNativeToolCalling()
      ? this.parseAssistantMessage(message)
      : (message.content || '');
  }

  async streamChat(messages, onChunk) {
    if (this.shouldUseNativeToolCalling()) {
      const res = await this.request(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildPayload(messages)),
      });

      const data = await res.json();
      const parsed = this.parseAssistantMessage(data.choices?.[0]?.message || {});
      this.emitContent(onChunk, parsed.content);
      return parsed;
    }

    const res = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(this.buildPayload(messages, { stream: true })),
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
            this.emitContent(onChunk, chunk);
          }
        } catch {
          // skip malformed chunks
        }
      }
    }

    return full;
  }

  // List available models via the /models endpoint. Returns an array of
  // { id, owned_by, tags }. Subclasses can override for richer data.
  async listModels() {
    try {
      const res = await this.fetchWithRetry(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.data || []).map(m => ({
        id: m.id,
        owned_by: m.owned_by || null,
        tags: deriveOpenAiTags(m.id),
        created: m.created || null,
      }));
    } catch { return []; }
  }
}

export function deriveOpenAiTags(id) {
  if (!id) return [];
  const tags = [];
  if (id.includes('codex')) tags.push('codex');
  if (id.includes('vision') || id.includes('gpt-4o') || id.includes('gpt-4-turbo')) tags.push('vision');
  if (/^o\d|^o1|^o3/.test(id)) tags.push('reasoning');
  if (id.includes('mini') || id.includes('nano')) tags.push('small');
  if (id.includes('gpt-4o')) tags.push('flagship');
  if (id.includes('gpt-3.5')) tags.push('legacy');
  if (id.includes('instruct') || id.includes('davinci') || id.includes('curie') || id.includes('babbage')) tags.push('instruct');
  return tags;
}
