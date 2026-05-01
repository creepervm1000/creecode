import { BaseProvider } from './base.js';
import { buildNativeToolDefinitions } from '../tools/index.js';

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

  supportsNativeToolCalling() {
    return true;
  }

  shouldUseNativeToolCalling() {
    return ['native', 'both'].includes(this.toolCallMode) && this.supportsNativeToolCalling();
  }

  supportsSeparateThinking() {
    return /qwen3|qwen3-coder|gpt-oss|deepseek/i.test(this.model);
  }

  buildPayload(messages, { stream = false } = {}) {
    const payload = {
      model: this.model,
      messages,
      stream,
    };

    if (this.shouldUseNativeToolCalling()) {
      payload.tools = buildNativeToolDefinitions();
    }

    if (this.supportsSeparateThinking()) {
      payload.think = true;
    }

    return payload;
  }

  parseAssistantMessage(message = {}) {
    const content = typeof message.content === 'string' ? message.content : '';
    const thinking = typeof message.thinking === 'string' ? message.thinking : '';
    const nativeToolCalls = (message.tool_calls || [])
      .filter(tc => tc?.function?.name)
      .map(tc => ({
        name: tc.function.name,
        args: tc.function.arguments || {},
      }));

    return {
      content,
      thinking,
      nativeToolCalls,
      assistantMessage: {
        role: 'assistant',
        content,
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      },
    };
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
      body: JSON.stringify(this.buildPayload(messages, { stream: false })),
    });

    const data = await res.json();
    return this.shouldUseNativeToolCalling()
      ? this.parseAssistantMessage(data.message || {})
      : this.supportsSeparateThinking()
        ? this.parseAssistantMessage(data.message || {})
        : (data.message?.content || '');
  }

  async streamChat(messages, onChunk) {
    const res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildPayload(messages, { stream: true })),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Ollama error ${res.status}: ${errBody}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let thinking = '';
    let buffer = '';
    let toolCalls = [];

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
          const thinkingChunk = json.message?.thinking || '';
          if (thinkingChunk) {
            thinking += thinkingChunk;
            this.emitThinking(onChunk, thinkingChunk);
          }
          const chunk = json.message?.content || '';
          if (chunk) {
            full += chunk;
            this.emitContent(onChunk, chunk);
          }
          if (json.message?.tool_calls?.length) {
            toolCalls.push(...json.message.tool_calls);
          }
        } catch {
          // skip
        }
      }
    }

    if (this.shouldUseNativeToolCalling()) {
      return this.parseAssistantMessage({
        content: full,
        thinking,
        tool_calls: toolCalls,
      });
    }

    if (this.supportsSeparateThinking()) {
      return this.parseAssistantMessage({
        content: full,
        thinking,
      });
    }

    return full;
  }
}
