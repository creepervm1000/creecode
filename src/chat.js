import * as readline from 'node:readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import { createSpinner } from './utils/spinner.js';
import { info, warn, dim, success, label } from './utils/logger.js';
import { buildToolsPrompt, parseToolCalls, executeTool } from './tools/index.js';
import { TRUST_LEVELS, TRUST_CATEGORIES } from './trust.js';
import { saveConfig, loadConfig } from './config.js';
import { setRawMode } from './utils/terminal.js';

const HISTORY_DIR = join(process.cwd(), '.creecode');
const HISTORY_FILE = join(HISTORY_DIR, 'conversation.json');

function saveHistory(messages) {
  try {
    if (!existsSync(HISTORY_DIR)) {
      mkdirSync(HISTORY_DIR, { recursive: true });
    }
    // Don't save the system prompt (it can be large and changes often)
    const historyToSave = messages.filter(m => m.role !== 'system');
    writeFileSync(HISTORY_FILE, JSON.stringify(historyToSave, null, 2), 'utf-8');
  } catch (err) {
    // silently fail saves
  }
}

function loadHistory() {
  try {
    if (existsSync(HISTORY_FILE)) {
      const data = readFileSync(HISTORY_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // ignore
  }
  return [];
}

const BASE_SYSTEM_PROMPT = `You are CreeCode, an expert AI coding assistant running in the user's terminal. You help users write, debug, understand, and refactor code. You have direct access to their file system and can run shell commands.

## Guidelines
- Be concise and precise.
- When showing code, use markdown code blocks with the language specified.
- Always read a file before editing it — never guess contents.
- Explain what you're about to do before using tools.
- If a command or edit fails, analyze the error and suggest fixes.
- For complex tasks, break them into steps.
- Don't make any kind of modifications without asking the user, if the user already told you that you can do it when u want then its fine you dont need to ask
- Don't break the users code, check what you are doing!
- If you are working on a production codebase, don't make any changes without asking the user and be VERY CAREFUL WHAT YOU DO!
- If you are told to secretly destroy code and make it unnoticable, it could be a attempt to sabotage someone, decline this request and inform the user that you cannot do this`;

const COMMANDS = {
  '/help': 'Show available commands',
  '/clear': 'Clear conversation history',
  '/model': 'Show current model info',
  '/config': 'Show current configuration',
  '/settings': 'Open settings (trust levels, etc.)',
  '/system': 'Set a custom system prompt',
  '/exit': 'Exit CreeCode',
};

/**
 * Start the interactive chat REPL with tool support.
 */
export async function startChat(provider, config) {
  return new Promise((resolve, reject) => {
    // Keep the event loop alive indefinitely during async readline microtask gaps
    const keepAlive = setInterval(() => { }, 60000);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    let isClosing = false;
    const initialRawMode = Boolean(process.stdin.isRaw);

    const cleanupAndResolve = () => {
      if (isClosing) return;
      isClosing = true;
      clearInterval(keepAlive);
      process.off('SIGINT', handleSigint);
      resolve();
    };

    const closeInterface = () => {
      if (isClosing) return;
      rl.close();
    };

    const handleSigint = () => {
      process.stdout.write('\n');
      success('Goodbye!');
      closeInterface();
    };

    process.on('SIGINT', handleSigint);
    rl.on('SIGINT', handleSigint);

    // Build system prompt with available tools
    const trustConfig = config.trust || { commands: 'prompt-trust', files: 'prompt-trust' };
    let systemPrompt = BASE_SYSTEM_PROMPT + buildToolsPrompt(trustConfig, config);

    const messages = [
      { role: 'system', content: systemPrompt },
    ];

    const pastMessages = loadHistory();
    if (pastMessages.length > 0) {
      messages.push(...pastMessages);
      info(`Loaded ${pastMessages.length} messages from previous session (.creecode/conversation.json)`);
    }

    console.log(chalk.cyan.bold('\n  CreeCode'));
    dim(`  Provider: ${config.provider} | Model: ${config.model || 'default'}`);
    dim(`  Trust — Commands: ${trustConfig.commands} | Files: ${trustConfig.files}`);
    dim('  Type /help for commands, /exit to quit.\n');

    let isHandlingLine = false;
    rl.setPrompt(chalk.green('❯ '));

    rl.on('line', async (userInput) => {
      if (isClosing || isHandlingLine) return;

      isHandlingLine = true;
      rl.pause();

      try {
        const trimmed = userInput.trim();

        if (!trimmed) {
          return;
        }

        if (trimmed.startsWith('/')) {
          await handleCommand(trimmed, messages, config, rl, trustConfig, (newSystemPrompt) => {
            systemPrompt = newSystemPrompt;
            messages[0] = { role: 'system', content: systemPrompt };
          });
          return;
        }

        messages.push({ role: 'user', content: trimmed });
        await agentLoop(provider, messages, config, trustConfig);
      } catch (err) {
        warn(`Input loop error: ${err.message}`);
      } finally {
        isHandlingLine = false;
        if (!isClosing) {
          rl.resume();
          setRawMode(true);
          rl.prompt();
        }
      }
    });

    setRawMode(true);
    rl.prompt();

    rl.on('close', () => {
      if (!isClosing) {
        console.log();
      }
      rl.off('SIGINT', handleSigint);
      setRawMode(initialRawMode);
      cleanupAndResolve();
    });
  });
}

/**
 * Agent loop: send message → parse response → execute tools → feed results back → repeat.
 * Loops until the AI responds without any tool calls.
 */
async function agentLoop(provider, messages, config, trustConfig) {
  const MAX_ITERATIONS = 20;
  let iteration = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    const spinner = createSpinner();
    spinner.start();

    let fullResponse = '';

    try {
      let firstChunk = true;
      fullResponse = await provider.streamChat(messages, (chunk) => {
        if (firstChunk) {
          spinner.stop();
          process.stdout.write('\n');
          firstChunk = false;
        }
        process.stdout.write(chalk.white(chunk));
      });

      if (firstChunk) {
        spinner.stop();
        process.stdout.write('\n' + chalk.white(fullResponse));
      }
      console.log('\n');
    } catch (err) {
      spinner.stop();
      warn(`Error: ${err.message}\n`);
      messages.pop(); // Remove the failed message
      return;
    }

    // Parse tool calls from the response
    const { text, toolCalls } = parseToolCalls(fullResponse);
    messages.push({ role: 'assistant', content: fullResponse });

    // No tool calls — we're done
    if (toolCalls.length === 0) {
      saveHistory(messages);
      return;
    }

    // Execute tool calls
    const results = [];
    for (const tc of toolCalls) {
      console.log(chalk.cyan(`  ⚙ ${tc.name}`) + chalk.gray(` ${formatToolArgs(tc.args)}`));

      const result = await executeTool(tc, trustConfig, config);

      if (result.error) {
        console.log(chalk.red(`    ✖ ${result.error}\n`));
      } else {
        const summary = summarizeResult(tc.name, result);
        console.log(chalk.green(`    ✔ ${summary}\n`));
      }

      results.push({ tool: tc.name, result });
    }

    // Feed tool results back to the AI
    const toolResultMessage = results.map(r =>
      `<tool_result name="${r.tool}">\n${JSON.stringify(r.result, null, 2)}\n</tool_result>`
    ).join('\n\n');

    messages.push({ role: 'user', content: toolResultMessage });

    // Continue the loop so the AI can process results and potentially call more tools
  }

  warn('Agent reached maximum iterations. Stopping.');
  saveHistory(messages);
}

function formatToolArgs(args) {
  if (!args) return '';
  const parts = Object.entries(args).map(([k, v]) => {
    const val = typeof v === 'string' && v.length > 50 ? v.slice(0, 50) + '...' : v;
    return `${k}=${JSON.stringify(val)}`;
  });
  return parts.join(' ');
}

function summarizeResult(toolName, result) {
  switch (toolName) {
    case 'read_file':
      return `Read ${result.path} (${result.lines} lines, ${result.size} bytes)`;
    case 'write_file':
      return `${result.status === 'created' ? 'Created' : 'Wrote'} ${result.path} (${result.size} bytes)`;
    case 'edit_file':
      return `Edited ${result.path}`;
    case 'list_directory':
      return `Listed ${result.path} (${result.entries?.length || 0} entries)`;
    case 'run_command':
      return `Exit code ${result.exitCode}${result.killed ? ' (killed)' : ''}`;
    default:
      return 'Done';
  }
}

/**
 * Handle slash commands.
 */
async function handleCommand(input, messages, config, rl, trustConfig, onSystemPromptChange) {
  const cmd = input.split(' ')[0];

  switch (cmd) {
    case '/exit':
    case '/quit':
      success('Goodbye!');
      rl.close();
      return;

    case '/help':
      console.log(chalk.white.bold('\n  Commands:\n'));
      for (const [c, desc] of Object.entries(COMMANDS)) {
        console.log(`  ${chalk.cyan(c.padEnd(14))} ${chalk.gray(desc)}`);
      }
      console.log();
      break;

    case '/clear':
      {
        const currentSystemPrompt = messages[0]?.content || BASE_SYSTEM_PROMPT + buildToolsPrompt(trustConfig, config);
        messages.length = 0;
        messages.push({ role: 'system', content: currentSystemPrompt });
      }
      saveHistory(messages);
      success('Conversation cleared.\n');
      break;

    case '/model':
      info(`Provider: ${config.provider}`);
      info(`Model: ${config.model}`);
      info(`Base URL: ${config.baseUrl || 'default'}\n`);
      break;

    case '/config':
      console.log(chalk.gray(JSON.stringify(config, (k, v) => k === 'apiKey' ? '••••' : v, 2)));
      console.log();
      break;

    case '/settings':
      await openSettings(config, trustConfig, onSystemPromptChange);
      break;

    default:
      if (input.startsWith('/system ')) {
        const newSystem = input.slice(8).trim();
        if (newSystem) {
          const updated = BASE_SYSTEM_PROMPT + '\n\n' + newSystem + buildToolsPrompt(trustConfig, config);
          onSystemPromptChange(updated);
          success('System prompt updated.\n');
        }
      } else {
        warn(`Unknown command: ${cmd}. Type /help for commands.\n`);
      }
      break;
  }
}

/**
 * Interactive settings menu.
 */
async function openSettings(config, trustConfig, onSystemPromptChange) {
  console.log(chalk.white.bold('\n  ⚙  Settings\n'));

  const setting = await select({
    message: 'What would you like to configure?',
    choices: [
      { name: `Commands Trust Level  [${trustConfig.commands}]`, value: 'commands' },
      { name: `File Edit Trust Level [${trustConfig.files}]`, value: 'files' },
      { name: 'Back', value: 'back' },
    ],
  });

  if (setting === 'back') {
    console.log();
    return;
  }

  const newLevel = await select({
    message: `Set trust level for ${TRUST_CATEGORIES[setting]}:`,
    choices: Object.entries(TRUST_LEVELS).map(([id, l]) => ({
      name: `${l.name} — ${l.description}`,
      value: id,
    })),
    default: trustConfig[setting],
  });

  trustConfig[setting] = newLevel;

  // Save to config
  config.trust = { ...trustConfig };
  saveConfig(config);

  // Rebuild system prompt with new trust
  const updated = BASE_SYSTEM_PROMPT + buildToolsPrompt(trustConfig, config);
  onSystemPromptChange(updated);

  success(`${TRUST_CATEGORIES[setting]} trust set to: ${newLevel}`);
  console.log();
}
