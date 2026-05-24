import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { OllamaProvider } from './ollama.js';
import { HuggingFaceProvider } from './huggingface.js';

/**
 * Provider registry — maps provider IDs to their class and default config.
 */
export const PROVIDERS = {
  creecodego: {
    name: 'CreeCode Go',
    class: OpenAIProvider,
    baseUrl: 'https://creecodego.creepernet.qzz.io',
    defaultModel: 'kilocode/minimax/minimax-m2.5',
    needsKey: true,
  },
  openai: {
    name: 'OpenAI',
    class: OpenAIProvider,
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    needsKey: true,
  },
  anthropic: {
    name: 'Anthropic (Claude)',
    class: AnthropicProvider,
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-20250514',
    needsKey: true,
  },
  gemini: {
    name: 'Google Gemini',
    class: GeminiProvider,
    baseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-2.5-flash',
    needsKey: true,
  },
  grok: {
    name: 'Grok (xAI)',
    class: OpenAIProvider,
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-3',
    needsKey: true,
  },
  glm: {
    name: 'GLM (Z.ai)',
    class: OpenAIProvider,
    baseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'GLM-4.7-Flash',
    needsKey: true,
  },
  groq: {
    name: 'Groq',
    class: OpenAIProvider,
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    needsKey: true,
  },
  openrouter: {
    name: 'OpenRouter',
    class: OpenAIProvider,
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o',
    needsKey: true,
  },
  kilo: {
    name: 'Kilo Gateway',
    class: OpenAIProvider,
    baseUrl: 'https://api.kilo.ai/api/gateway',
    defaultModel: 'kilo-auto/free',
    needsKey: true,
  },
  opencode: {
    name: 'OpenCode Zen',
    class: OpenAIProvider,
    baseUrl: 'https://opencode.ai/zen/v1',
    defaultModel: 'zen-v1',
    needsKey: true,
  },
  ollama: {
    name: 'Ollama (Local)',
    class: OllamaProvider,
    baseUrl: 'http://localhost:11434',
    defaultModel: 'llama3.2',
    needsKey: false,
  },
  huggingface: {
    name: 'HuggingFace',
    class: HuggingFaceProvider,
    baseUrl: 'https://api-inference.huggingface.co',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    needsKey: true,
  },
  'custom-openai': {
    name: 'Custom OpenAI-Compatible',
    class: OpenAIProvider,
    baseUrl: '',
    defaultModel: '',
    needsKey: true,
    custom: true,
  },
  'custom-anthropic': {
    name: 'Custom Anthropic-Compatible',
    class: AnthropicProvider,
    baseUrl: '',
    defaultModel: '',
    needsKey: true,
    custom: true,
  },
};

/**
 * Get a list of provider choices for the onboarding prompt.
 */
export function getProviderChoices() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    name: p.name,
    value: id,
  }));
}

/**
 * Create a provider instance from config.
 */
export function createProvider(config) {
  const providerId = config.provider;
  const providerDef = PROVIDERS[providerId];

  if (!providerDef) {
    throw new Error(`Unknown provider: ${providerId}. Available: ${Object.keys(PROVIDERS).join(', ')}`);
  }

  const ProviderClass = providerDef.class;
  return new ProviderClass({
    apiKey: config.apiKey || '',
    model: config.model || providerDef.defaultModel,
    baseUrl: config.baseUrl || providerDef.baseUrl,
    fetchFn: config.fetchFn || globalThis.fetch,
    toolCallMode: config.toolCallMode || 'xml',
  });
}
