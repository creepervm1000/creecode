#!/usr/bin/env node

import { Command } from 'commander';
import { run } from '../src/index.js';
import { APP_VERSION } from '../src/version.js';

const program = new Command();

program
  .name('creecode')
  .description('CLI coding assistant — supports 10+ LLM providers')
  .version(APP_VERSION)
  .option('--setup', 'Run the setup wizard')
  .option('--provider <provider>', 'LLM provider (openai, anthropic, gemini, grok, groq, openrouter, ollama, huggingface, custom-openai, custom-anthropic)')
  .option('--model <model>', 'Model name/ID to use')
  .option('--proxy <url>', 'HTTP/SOCKS proxy URL')
  .option('--base-url <url>', 'Custom API base URL')
  .option('--allow-outside-workspace', 'Allow file tools and command cwd outside the workspace root')
  .option('--webui', 'Launch the web UI instead of CLI chat')
  .option('--port <number>', 'Web UI port (default: 3000)', parseInt)
  .option('--models', 'List available models from the configured provider and exit')
  .action(async (options) => {
    try {
      await run({
        setup: options.setup,
        provider: options.provider,
        model: options.model,
        proxy: options.proxy,
        baseUrl: options.baseUrl,
        allowOutsideWorkspace: options.allowOutsideWorkspace,
        webui: options.webui,
        port: options.port,
        models: options.models,
      });
    } catch (err) {
      console.error(`Fatal: ${err.message}`);
      process.exit(1);
    }
  });

program.parseAsync();
