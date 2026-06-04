import { OpenAIProvider } from './openai.js';
import { getProviderAuth, setProviderAuth, clearProviderAuth } from '../auth.js';

/**
 * GitHub Copilot provider.
 *
 * Authenticates with a GitHub token that has Copilot access. The token
 * is stored in ~/.creecode/auth.json under `providers.copilot`. The
 * provider targets the official Copilot API endpoint used by VS Code /
 * other Copilot integrations, which is OpenAI-compatible.
 *
 *   POST https://api.githubcopilot.com/chat/completions
 *   Authorization: Bearer <github_token>
 *   Editor-Version: creecode/1.0
 *   Copilot-Integration-Id: vscode-chat
 *
 * Get a token via `gh auth token` (with copilot scope), a fine-grained
 * PAT with Copilot access, or paste a token in /settings → Copilot.
 *
 * Use /logout copilot to clear.
 */

const DEFAULT_BASE = 'https://api.githubcopilot.com';
const DEFAULT_MODEL = 'gpt-4o';

export function copilotStatus() {
  const a = getProviderAuth('copilot');
  if (!a || !a.token) return { logged_in: false };
  return { logged_in: true, token_preview: a.token.slice(0, 6) + '…' + a.token.slice(-4), source: a.source || 'manual' };
}

export function copilotSetToken(token, source = 'manual') {
  if (!token) return { ok: false, error: 'token is required' };
  setProviderAuth('copilot', { token, source, set_at: new Date().toISOString() });
  return { ok: true };
}

export function copilotLogout() {
  clearProviderAuth('copilot');
  return { ok: true };
}

export class CopilotProvider extends OpenAIProvider {
  constructor(config = {}) {
    super({
      ...config,
      baseUrl: config.baseUrl || DEFAULT_BASE,
      model: config.model || DEFAULT_MODEL,
    });
    this.kind = 'copilot';
  }

  async getToken() {
    const a = getProviderAuth('copilot');
    if (!a || !a.token) {
      throw new Error('Not logged in to GitHub Copilot. Use /settings → Copilot to set a token, or run: /login copilot');
    }
    return a.token;
  }

  async ensureAuth() {
    this._token = await this.getToken();
  }

  buildHeaders() {
    if (!this._token) throw new Error('CopilotProvider: token not loaded. Call ensureAuth() first.');
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this._token}`,
      'Editor-Version': 'creecode/1.0',
      'Editor-Plugin-Version': 'creecode/1.0',
      'Copilot-Integration-Id': 'vscode-chat',
      'User-Agent': 'GithubCopilot/1.0',
    };
  }

  async chat(messages) {
    await this.ensureAuth();
    return super.chat(messages);
  }

  async streamChat(messages, onChunk) {
    await this.ensureAuth();
    return super.streamChat(messages, onChunk);
  }

  async listModels() {
    await this.ensureAuth();
    try {
      const res = await this.fetchWithRetry(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this._token}` },
      });
      if (!res.ok) return [];
      const data = await res.json();
      // Copilot's /models returns { data: [{ id, name, ... }] } and may
      // also have a `capabilities` map per model.
      return (data.data || []).map(m => {
        const caps = m.capabilities || {};
        const tags = [];
        if (caps.type === 'chat') tags.push('chat');
        if (caps.family) tags.push(caps.family);
        if (caps.limits?.max_prompt_tokens) tags.push(`${caps.limits.max_prompt_tokens}ctx`);
        if (m.id.includes('claude')) tags.push('claude');
        if (m.id.includes('gpt-4')) tags.push('gpt-4');
        if (m.id.includes('o1') || m.id.includes('o3')) tags.push('reasoning');
        if (m.id.includes('gemini')) tags.push('gemini');
        return { id: m.id, name: m.name || m.id, owned_by: m.vendor || caps.family || null, tags, capabilities: caps };
      });
    } catch { return []; }
  }
}
