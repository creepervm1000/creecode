import { select, input, password, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { getProviderChoices, PROVIDERS } from './providers/index.js';
import { saveConfig } from './config.js';
import { TRUST_LEVELS, TRUST_CATEGORIES } from './trust.js';
import { banner, success, info, warn, label, error } from './utils/logger.js';

/**
 * Fetch models from any OpenAI-compatible /v1/models endpoint.
 */
export async function listOpenAIModels(baseUrl, apiKey) {
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;
    const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.data && Array.isArray(data.data)) {
      return data.data.map(m => m.id || m.name).filter(Boolean);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * List models from the configured provider and print them.
 */
export async function listModels(config) {
  const providerDef = PROVIDERS[config.provider];
  if (!providerDef) {
    error(`Unknown provider: ${config.provider}`);
    process.exit(1);
  }

  const baseUrl = (config.baseUrl || providerDef.baseUrl || '').replace(/\/+$/, '');
  console.log(`\n${chalk.bold('Provider:')} ${providerDef.name}`);
  console.log(`${chalk.bold('Base URL:')} ${baseUrl}\n`);

  if (config.provider === 'ollama') {
    try {
      const res = await fetch(`${baseUrl}/api/tags`);
      const data = await res.json();
      const models = (data.models || []).map(m => m.name);
      if (models.length === 0) {
        console.log('No models found.');
        return;
      }
      models.forEach(m => console.log(`  ${m}`));
    } catch (err) {
      error(`Failed to fetch Ollama models: ${err.message}`);
    }
    return;
  }

  if (config.provider === 'gemini' && providerDef.class?.prototype?.listModels) {
    try {
      const provider = new providerDef.class({
        apiKey: config.apiKey || '',
        baseUrl,
        fetchFn: globalThis.fetch,
      });
      const models = await provider.listModels();
      if (models.length === 0) {
        console.log('No models found.');
        return;
      }
      models.forEach(m => console.log(`  ${m}`));
    } catch (err) {
      error(`Failed to fetch Gemini models: ${err.message}`);
    }
    return;
  }

  // Default: try OpenAI-compatible /v1/models
  if (config.apiKey) {
    const models = await listOpenAIModels(baseUrl, config.apiKey);
    if (models && models.length > 0) {
      models.forEach(m => console.log(`  ${m}`));
      return;
    }
  }

  error('Could not fetch model list. Check your API key and base URL.');
}

const TOOL_CALL_MODE_CHOICES = [
  { name: 'XML Tags — model emits <tool_call> blocks', value: 'xml' },
  { name: 'Native — use provider-native tool calling when supported', value: 'native' },
  { name: 'Both — allow native tool calling and XML fallback', value: 'both' },
];

async function chooseModelFromProvider(provider, providerDef, config) {
  const baseUrl = (config.baseUrl || providerDef.baseUrl || '').replace(/\/+$/, '');

  // Try OpenAI-compatible /v1/models listing for all providers with an API key
  if (providerDef.needsKey && config.apiKey && providerDef.class?.name !== 'GeminiProvider') {
    info(`Fetching available models from ${baseUrl}...`);
    const models = await listOpenAIModels(baseUrl, config.apiKey);
    if (models && models.length > 0) {
      try {
        return await select({
          message: 'Select a model:',
          choices: models.map(m => ({ name: m, value: m })),
          default: models.includes(config.model) ? config.model : undefined,
        });
      } catch {
        // fall through
      }
    }
    warn('Could not fetch model list. You can enter a model name manually.');
  }

  if (provider === 'ollama') {
    info('Checking for available Ollama models...');
    try {
      const res = await fetch(`${config.baseUrl || 'http://localhost:11434'}/api/tags`);
      const data = await res.json();
      const models = (data.models || []).map(m => m.name);
      if (models.length > 0) {
        return await select({
          message: 'Select a model:',
          choices: models.map(m => ({ name: m, value: m })),
        });
      }
      return await input({
        message: 'No models found. Enter model name manually:',
        default: providerDef.defaultModel,
      });
    } catch {
      return await input({
        message: 'Could not connect to Ollama. Enter model name:',
        default: providerDef.defaultModel,
      });
    }
  }

  if (provider === 'gemini') {
    info('Checking Gemini models available to your API key...');
    try {
      const geminiProvider = new providerDef.class({
        apiKey: config.apiKey || '',
        baseUrl: config.baseUrl || providerDef.baseUrl,
        fetchFn: globalThis.fetch,
      });
      const models = await geminiProvider.listModels();
      if (models.length > 0) {
        return await select({
          message: 'Select a Gemini model:',
          choices: models.map(m => ({ name: m, value: m })),
          default: models.includes(providerDef.defaultModel) ? providerDef.defaultModel : undefined,
        });
      }
      return await input({
        message: 'No Gemini models were returned. Enter model name manually:',
        default: providerDef.defaultModel,
      });
    } catch {
      return await input({
        message: 'Could not list Gemini models. Enter model name manually:',
        default: providerDef.defaultModel,
      });
    }
  }

  if (providerDef.custom) {
    return await input({
      message: 'Enter the model name/ID:',
      validate: (val) => val.length > 0 || 'Model name is required',
    });
  }

  return await input({
    message: 'Model to use:',
    default: providerDef.defaultModel,
  });
}

/**
 * Interactive first-run onboarding wizard.
 * Returns the completed config object.
 */
export async function runOnboarding() {
  banner();
  console.log(chalk.white.bold('  Welcome! Let\'s set up CreeCode.\n'));
  info('This wizard will configure your LLM provider and preferences.');
  console.log();

  // 1. Provider selection
  const provider = await select({
    message: 'Choose your LLM provider:',
    choices: getProviderChoices(),
  });

  const providerDef = PROVIDERS[provider];
  const config = { provider };

  // 2. API Key (skip for Ollama)
  if (providerDef.needsKey) {
    config.apiKey = await password({
      message: `Enter your ${providerDef.name} API key:`,
      mask: '*',
      validate: (val) => val.length > 0 || 'API key is required',
    });
  }

  // 3. Base URL
  if (providerDef.custom) {
    config.baseUrl = await input({
      message: 'Enter the API base URL:',
      validate: (val) => val.length > 0 || 'Base URL is required for custom providers',
    });
  } else {
    const changeUrl = await confirm({
      message: `Use default base URL (${providerDef.baseUrl})?`,
      default: true,
    });
    if (!changeUrl) {
      config.baseUrl = await input({
        message: 'Enter custom base URL:',
        default: providerDef.baseUrl,
      });
    } else {
      config.baseUrl = providerDef.baseUrl;
    }
  }

  // 4. Model
  config.model = await chooseModelFromProvider(provider, providerDef, config);

  // 5. Proxy
  const useProxy = await confirm({
    message: 'Use a proxy? (HTTP/SOCKS)',
    default: false,
  });
  if (useProxy) {
    config.proxy = await input({
      message: 'Enter proxy URL (e.g. http://127.0.0.1:8080, socks5://...):',
      validate: (val) => val.length > 0 || 'Proxy URL is required',
    });
  }

  // 6. Trust Levels
  console.log();
  console.log(chalk.white.bold('  ── Trust & Permissions ──\n'));
  info('CreeCode can edit files and run commands. Set your comfort level:\n');

  const trustChoices = Object.entries(TRUST_LEVELS).map(([id, l]) => ({
    name: `${l.name} — ${l.description}`,
    value: id,
  }));

  const commandsTrust = await select({
    message: 'Trust level for Shell Commands:',
    choices: trustChoices,
    default: 'agent-decides-trust',
  });

  const filesTrust = await select({
    message: 'Trust level for File Read/Write/Edit:',
    choices: trustChoices,
    default: 'agent-decides-trust',
  });

  config.trust = {
    commands: commandsTrust,
    files: filesTrust,
  };

  console.log();
  console.log(chalk.white.bold('  ── Workspace Scope ──\n'));
  info('By default, CreeCode is limited to the folder where you launch it.');

  config.allowOutsideWorkspace = await confirm({
    message: 'Allow the model to access files and run commands outside the workspace root?',
    default: false,
  });

  config.toolCallMode = await select({
    message: 'Tool calling mode:',
    choices: TOOL_CALL_MODE_CHOICES,
    default: 'xml',
  });

  // 7. Web UI
  config.webui = await confirm({
    message: 'Enable web UI by default?',
    default: false,
  });

  if (config.webui) {
    config.webuiPort = parseInt(await input({
      message: 'Web UI port:',
      default: '3000',
    }), 10);
  }

  // 8. Summary
  console.log();
  console.log(chalk.white.bold('  ── Configuration Summary ──\n'));
  label('Provider', providerDef.name);
  label('Model', config.model);
  label('Base URL', config.baseUrl || providerDef.baseUrl);
  label('API Key', config.apiKey ? '••••' + config.apiKey.slice(-4) : 'N/A');
  label('Proxy', config.proxy || 'None');
  label('Commands Trust', config.trust.commands);
  label('Files Trust', config.trust.files);
  label('Outside Workspace', config.allowOutsideWorkspace ? 'Allowed' : 'Blocked');
  label('Tool Calling', config.toolCallMode);
  label('Web UI', config.webui ? `Enabled (port ${config.webuiPort || 3000})` : 'Disabled');
  console.log();

  const confirmed = await confirm({
    message: 'Save this configuration?',
    default: true,
  });

  if (confirmed) {
    saveConfig(config);
    success('Configuration saved to ~/.creecode/config.json');
  } else {
    info('Configuration not saved. You can re-run setup with: creecode --setup');
  }

  console.log();
  return config;
}
