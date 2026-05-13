import { loadConfig, configExists, mergeConfig } from './config.js';
import { runOnboarding, listModels } from './onboarding.js';
import { createProvider, PROVIDERS } from './providers/index.js';
import { createProxyFetch } from './proxy.js';
import { startChat } from './chat.js';
import { startWebUI } from './webui/server.js';
import { banner, error, info, success, warn } from './utils/logger.js';
import { setRawMode } from './utils/terminal.js';

/**
 * Main application orchestrator.
 */
export async function run(cliOptions = {}) {
  // Restore terminal raw mode on exit (fixes CMD corruption after Ctrl+C)
  const restoreTerm = () => { try { setRawMode(false); } catch {} };
  process.on('exit', restoreTerm);
  process.on('SIGINT', () => { restoreTerm(); process.exit(0); });
  process.on('SIGTERM', restoreTerm);
  // Re-run setup if requested
  if (cliOptions.setup) {
    const config = await runOnboarding();
    if (!config.provider) process.exit(0);
    // Continue to chat with the new config
    return startSession(config, cliOptions);
  }

  // List models and exit
  if (cliOptions.models) {
    const cfg = configExists() ? loadConfig() : null;
    if (!cfg || !cfg.provider) {
      error('No provider configured. Run: creecode --setup');
      process.exit(1);
    }
    await listModels(cfg);
    return;
  }

  // First run → onboarding
  if (!configExists()) {
    const config = await runOnboarding();
    if (!config.provider) process.exit(0);
    return startSession(config, cliOptions);
  }

  // Load saved config, merge with CLI flags
  const saved = loadConfig();
  const config = mergeConfig(saved, {
    provider: cliOptions.provider,
    model: cliOptions.model,
    proxy: cliOptions.proxy,
    baseUrl: cliOptions.baseUrl,
    allowOutsideWorkspace: cliOptions.allowOutsideWorkspace,
  });

  if (!config.provider) {
    error('No provider configured. Run: creecode --setup');
    process.exit(1);
  }

  return startSession(config, cliOptions);
}

async function startSession(config, cliOptions) {
  config.allowOutsideWorkspace = Boolean(config.allowOutsideWorkspace);

  // Set up proxy fetch if configured
  const proxyUrl = config.proxy || null;
  const fetchFn = createProxyFetch(proxyUrl);
  config.fetchFn = fetchFn;

  // Create provider
  let provider;
  try {
    provider = createProvider(config);
  } catch (err) {
    error(err.message);
    process.exit(1);
  }

  // Start web UI if requested
  const shouldWebUI = cliOptions.webui || config.webui;
  if (shouldWebUI) {
    const port = cliOptions.port || config.webuiPort || 3000;
    await startWebUI(provider, config, port);
    return;
  }

  // Start CLI chat
  banner();
  if (config.allowOutsideWorkspace) {
    warn('Outside-workspace access is enabled for this session.');
  }
  await startChat(provider, config);
}
