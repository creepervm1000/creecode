import { BaseProvider } from './base.js';

/**
 * Google Gemini provider using the native REST API.
 */
export class GeminiProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';
    this.model = config.model || 'gemini-2.5-flash';
  }

  _convertMessages(messages) {
    // Convert OpenAI-style messages to Gemini's contents format
    let systemInstruction = '';
    const contents = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction += (systemInstruction ? '\n' : '') + msg.content;
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    return { systemInstruction, contents };
  }

  async chat(messages) {
    const { systemInstruction, contents } = this._convertMessages(messages);

    const body = { contents };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const res = await this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    return parts.map(p => p.text || '').join('');
  }

  async streamChat(messages, onChunk) {
    const { systemInstruction, contents } = this._convertMessages(messages);

    const body = { contents };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const url = `${this.baseUrl}/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;

    const res = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Gemini API error ${res.status}: ${errBody}`);
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
          const parts = json.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (part.text) {
              full += part.text;
              this.emitContent(onChunk, part.text);
            }
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
      const url = `${this.baseUrl}/v1beta/models?key=${encodeURIComponent(this.apiKey)}&pageSize=200`;
      const res = await this.fetchWithRetry(url);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.models || []).map(m => {
        const id = (m.name || '').replace(/^models\//, '');
        return {
          id,
          display_name: m.displayName || null,
          tags: deriveGeminiTags(id, m),
          input_token_limit: m.inputTokenLimit || null,
          output_token_limit: m.outputTokenLimit || null,
        };
      });
    } catch { return []; }
  }
}

function deriveGeminiTags(id, raw) {
  const tags = [];
  if (id.includes('flash')) tags.push('flash', 'fast');
  if (id.includes('pro')) tags.push('pro', 'flagship');
  if (id.includes('nano')) tags.push('nano', 'small');
  if (id.includes('lite')) tags.push('lite');
  if (raw?.supportedGenerationMethods?.includes('generateContent')) tags.push('chat');
  if (raw?.supportedGenerationMethods?.includes('embedContent')) tags.push('embed');
  return tags;
}
