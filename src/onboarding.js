import { select, input, password, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { getProviderChoices, PROVIDERS } from './providers/index.js';
import { saveConfig } from './config.js';
import { TRUST_LEVELS, TRUST_CATEGORIES } from './trust.js';
import { banner, success, info, label } from './utils/logger.js';

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
  if (provider === 'ollama') {
    info('Checking for available Ollama models...');
    try {
      const res = await fetch(`${config.baseUrl || 'http://localhost:11434'}/api/tags`);
      const data = await res.json();
      const models = (data.models || []).map(m => m.name);
      if (models.length > 0) {
        config.model = await select({
          message: 'Select a model:',
          choices: models.map(m => ({ name: m, value: m })),
        });
      } else {
        config.model = await input({
          message: 'No models found. Enter model name manually:',
          default: providerDef.defaultModel,
        });
      }
    } catch {
      config.model = await input({
        message: 'Could not connect to Ollama. Enter model name:',
        default: providerDef.defaultModel,
      });
    }
  } else if (providerDef.custom) {
    config.model = await input({
      message: 'Enter the model name/ID:',
      validate: (val) => val.length > 0 || 'Model name is required',
    });
  } else {
    config.model = await input({
      message: 'Model to use:',
      default: providerDef.defaultModel,
    });
  }

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
