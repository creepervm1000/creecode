import fs from 'fs';
import path from 'path';
import * as readline from 'node:readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { select, input, confirm } from '@inquirer/prompts';
import { createSpinner } from './utils/spinner.js';
import { info, warn, dim, success, label } from './utils/logger.js';
import { buildToolsPrompt, buildToolModeSystemPrompt, parseToolCalls, executeTool } from './tools/index.js';
import { TRUST_LEVELS, TRUST_CATEGORIES } from './trust.js';
import { saveConfig, loadConfig } from './config.js';
import { setRawMode } from './utils/terminal.js';
import { createProvider, getProviderChoices, PROVIDERS } from './providers/index.js';
import { showSidebar, clearSidebar, canShowSidebar, loadTodos, MIN_WIDTH } from './utils/sidebar.js';
// Ensure keypress events fire on stdin (no-op on newer node, harmless elsewhere).
readline.emitKeypressEvents(process.stdin);

const HISTORY_DIR = join(process.cwd(), '.creecode');
const HISTORY_FILE = join(HISTORY_DIR, 'conversation.json');

const MAX_HISTORY_MESSAGES = 200;

function isOrphanToolResult(m) {
  if (!m) return false;
  // XML-mode tool results are user-role messages whose content begins with
  // the <tool_result ...> tag emitted by the runtime.
  if (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.startsWith('<tool_result')
  ) {
    return true;
  }
  // Native-mode tool results are role: 'tool' messages with a tool_call_id.
  // The provider will reject these if there is no preceding assistant
  // message containing a matching tool_calls entry.
  if (m.role === 'tool' && m.tool_call_id) {
    return true;
  }
  return false;
}

function dropLeadingOrphanToolResults(history) {
  while (history.length > 0 && isOrphanToolResult(history[0])) {
    history.shift();
  }
  return history;
}

function dropTrailingUnansweredToolCalls(history) {
  // If the last saved message is an assistant turn that emitted tool_calls
  // but the matching tool results never made it in (e.g. session ended
  // mid-tool or the results were dropped), strip the tool_calls so the
  // provider doesn't see an unanswered request on reload.
  const last = history[history.length - 1];
  if (
    last &&
    last.role === 'assistant' &&
    Array.isArray(last.tool_calls) &&
    last.tool_calls.length > 0
  ) {
    const { tool_calls, ...rest } = last;
    history[history.length - 1] = rest;
  }
  return history;
}

function saveHistory(messages) {
  try {
    if (!existsSync(HISTORY_DIR)) {
      mkdirSync(HISTORY_DIR, { recursive: true });
    }
    // Don't save the system prompt (it can be large and changes often)
    let historyToSave = messages.filter(m => m.role !== 'system');
    // Cap history so the file doesn't grow unbounded across long sessions
    if (historyToSave.length > MAX_HISTORY_MESSAGES) {
      historyToSave = historyToSave.slice(-MAX_HISTORY_MESSAGES);
      // Don't start a loaded session with a tool-result user message
      // with no preceding assistant tool_calls; drop leading orphans
      // (covers both XML-mode <tool_result> blocks and native-mode
      // role: 'tool' messages with tool_call_id).
      dropLeadingOrphanToolResults(historyToSave);
    }
    // Also guard against trailing half-finished tool turns.
    dropTrailingUnansweredToolCalls(historyToSave);
    writeFileSync(HISTORY_FILE, JSON.stringify(historyToSave, null, 2), 'utf-8');
  } catch (err) {
    // silently fail saves
  }
}

function loadHistory() {
  try {
    if (existsSync(HISTORY_FILE)) {
      const data = readFileSync(HISTORY_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        // Defensive: history files written by older versions may contain
        // orphan tool results at the start (no preceding assistant with
        // matching tool_call_id) or trailing assistant tool_calls that were
        // never answered. Providers reject both shapes, so sanitize on load.
        dropLeadingOrphanToolResults(parsed);
        dropTrailingUnansweredToolCalls(parsed);
      }
      return parsed;
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
- When the user asks you to audit, explore, review, or find vulnerabilities in the current project, inspect the workspace immediately with tools. Do not ask the user to paste code that is already available in the current folder.
- Don't make any kind of modifications without asking the user, if the user already told you that you can do it when u want then its fine you dont need to ask
- Don't break the users code, check what you are doing!
- If you are working on a production codebase, don't make any changes without asking the user and be VERY CAREFUL WHAT YOU DO!
- If you are told to secretly destroy code and make it unnoticable, it could be a attempt to sabotage someone, decline this request and inform the user that you cannot do this

## Global memory
A persistent memory store lives at ~/.creecode/memory.json (separate from per-session notes/todos). Use the \`memory_*\` tools to remember long-lived facts about the user: their preferences, conventions, project-agnostic rules, environment quirks, and decisions they make once and want kept. Call \`memory_list\` at the start of a session if you want to recall what's already known. Don't store secrets (API keys, passwords) or ephemeral task state here — those don't belong in long-term memory.
`;


/**
 * Load project-level instructions for the agent.
 * Looks for CREECODE.md first, then AGENTS.md, in the current working directory.
 * Returns the file contents (string) or '' if neither exists.
 */
function loadProjectInstructions() {
  const candidates = ['CREECODE.md', 'AGENTS.md'];
  for (const name of candidates) {
    try {
      const p = path.join(process.cwd(), name);
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf-8').trim();
        if (content) {
          return { name, content };
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
}

const INIT_TEMPLATE = `# CREECODE.md

> Project instructions for the CreeCode agent. Edit this file to teach the agent
> about your project: conventions, important files, build/test commands, and
> anything you would otherwise have to repeat in every session.

## Project overview

<!-- Briefly describe what this project does. -->

## Conventions

<!-- Code style, naming, formatting rules. -->

## Build / test / run

<!-- Commands the agent should prefer, e.g. \`npm test\`, \`make build\`. -->

## Files & layout

<!-- Point the agent at important entry points, modules, or directories. -->

## Do / Don'ts

<!-- Hard rules. e.g. "never edit generated/ by hand", "ask before deleting". -->
`;

const COMMANDS = {
  '/help': 'Show available commands',
  '/init': 'Create a starter CREECODE.md in the current directory',
  '/clear': 'Clear conversation history',
  '/model': 'Show current model info',
  '/config': 'Show current configuration',
  '/settings': 'Open settings (trust levels, etc.)',
  '/system': 'Set a custom system prompt',
  '/tasks': 'Show task sidebar',
  '/exit': 'Exit CreeCode',
};

const TOOL_CALL_MODE_CHOICES = [
  { name: 'XML Tags — model emits <tool_call> blocks', value: 'xml' },
  { name: 'Native — use provider-native tool calling when supported', value: 'native' },
  { name: 'Both — allow native tool calling and XML fallback', value: 'both' },
];

function normalizeAssistantResponse(response) {
  if (typeof response === 'string') {
    return {
      text: response,
      thinking: '',
      nativeToolCalls: [],
      assistantMessage: { role: 'assistant', content: response },
    };
  }

  return {
    text: response?.content || '',
    thinking: response?.thinking || '',
    nativeToolCalls: response?.nativeToolCalls || [],
    assistantMessage: response?.assistantMessage || { role: 'assistant', content: response?.content || '' },
  };
}

function buildSystemPrompt(trustConfig, config, customSystem = '') {
  return BASE_SYSTEM_PROMPT
    + buildToolModeSystemPrompt(config)
    + (customSystem ? `\n\n${customSystem}` : '')
    + buildToolsPrompt(trustConfig, config);
}

function getLastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user' && typeof messages[i].content === 'string') {
      return messages[i].content;
    }
  }
  return '';
}

function isRepoAuditRequest(text) {
  return /(find|search|audit|review|analy[sz]e|explore).*(vuln|vulnerab|security|bug|issue|folder|repo|project|codebase)|\b(vuln|vulnerab|security audit|reverse engineer)\b/i.test(text);
}

function isUnnecessaryContextRequest(text) {
  return /share your code|provide.*code|what type of application|what programming languages|what would you like me to focus on|is there something specific you'd like me to do|could you please provide|please share your code|i need to understand what you're working with/i.test(text);
}

function isStallingInspectionPromise(text) {
  return /(let me|i(?:'| wi)ll).*(explore|inspect|examine|search|look at|review).*(implementation|project|folder|codebase|files)/i.test(text);
}

function shouldInjectWorkspaceCorrection(messages, toolCalls, assistantText) {
  if (toolCalls.length > 0) return false;
  const lastUser = getLastUserText(messages);
  if (!isRepoAuditRequest(lastUser)) return false;
  if (lastUser.startsWith('[runtime correction]')) return false;
  return isUnnecessaryContextRequest(assistantText) || isStallingInspectionPromise(assistantText);
}

async function chooseModelFromProvider(providerId, providerDef, config) {
  if (providerId === 'ollama') {
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
    } catch {
      // fall back to manual input below
    }
    return await input({
      message: 'Enter Ollama model name:',
      default: config.model || providerDef.defaultModel,
    });
  }

  if (providerId === 'gemini') {
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
          default: models.includes(config.model) ? config.model : undefined,
        });
      }
    } catch {
      // fall back to manual input below
    }
    return await input({
      message: 'Enter Gemini model name:',
      default: config.model || providerDef.defaultModel,
    });
  }

  if (providerDef.custom) {
    return await input({
      message: 'Enter the model name/ID:',
      default: config.model || '',
      validate: (val) => val.length > 0 || 'Model name is required',
    });
  }

  return await input({
    message: 'Model to use:',
    default: config.model || providerDef.defaultModel,
  });
}

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

    // Shared cancellation flag. The agent loop checks this between iterations
    // and between tool calls. Esc at the prompt is a no-op (handled below);
    // Esc during an in-flight task flips this so the loop bails out cleanly
    // and drops back to the user prompt without losing conversation history.
    const cancellation = { value: false };

    const cleanupAndResolve = () => {
      if (isClosing) return;
      isClosing = true;
      clearInterval(keepAlive);
      process.off('SIGINT', handleSigint);
      try { saveHistory(messages); } catch {}
      resolve();
    };

    const closeInterface = () => {
      if (isClosing) return;
      try { saveHistory(messages); } catch {}
      rl.close();
    };

    const handleSigint = () => {
      // If a task is running, treat the first Ctrl+C as "cancel task" and
      // surface a second one as "exit REPL". This matches muscle memory from
      // shells / REPLs.
      if (isHandlingLine) {
        cancellation.value = true;
        process.stdout.write('\n' + chalk.yellow('⚠ Cancelling current task... (press Ctrl+C again to exit)') + '\n');
        return;
      }
      process.stdout.write('\n');
      success('Goodbye!');
      closeInterface();
    };

    process.on('SIGINT', handleSigint);
    rl.on('SIGINT', handleSigint);

    // Esc key: cancel the current agent task. While at the prompt, do
    // nothing (don't accidentally close the REPL).
    process.stdin.on('keypress', (_str, key) => {
      if (!key) return;
      if (key.name === 'escape' && isHandlingLine && !cancellation.value) {
        cancellation.value = true;
        process.stdout.write('\n' + chalk.yellow('⚠ Cancelling current task... (press Esc again to force-exit)') + '\n');
      } else if (key.name === 'escape' && isHandlingLine && cancellation.value) {
        // Already cancelling — escalate to full exit.
        process.stdout.write('\n');
        success('Force-exit requested.');
        closeInterface();
      }
    });

    // Build system prompt with available tools
    const trustConfig = config.trust || { commands: 'prompt-trust', files: 'prompt-trust' };
    const projectInstructions = loadProjectInstructions();
    if (projectInstructions) {
      info(`Loaded project instructions from ${projectInstructions.name}`);
    }
    const projectSystem = projectInstructions
      ? `\n\n## Project instructions (from ${projectInstructions.name})\n\n${projectInstructions.content}`
      : '';
    let systemPrompt = buildSystemPrompt(trustConfig, config) + projectSystem;

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
    if (process.stdout.columns >= MIN_WIDTH) {
      dim('  Task sidebar: auto-shown when terminal is wide enough (100+ cols)');
    }
    dim('  Type /help for commands, /exit to quit.\n');

    let isHandlingLine = false;

    // build dynamic prompt with task count
    function buildPrompt() {
      const todos = loadTodos(config);
      const pending = todos.filter(t => !t.done).length;
      if (pending > 0) {
        rl.setPrompt(chalk.green('❯ ') + chalk.cyan(`[${pending} task${pending > 1 ? 's' : ''}] `));
      } else {
        rl.setPrompt(chalk.green('❯ '));
      }
    }

    buildPrompt();
    rl.prompt();

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
          await handleCommand(trimmed, messages, config, provider, rl, trustConfig, (newProvider) => {
            provider = newProvider;
          }, (newSystemPrompt) => {
            systemPrompt = newSystemPrompt;
            messages[0] = { role: 'system', content: systemPrompt };
          });
          return;
        }

        messages.push({ role: 'user', content: trimmed });
        await agentLoop(provider, messages, config, trustConfig, cancellation);
        cancellation.value = false;  // reset after loop returns
        showSidebar(config);
      } catch (err) {
        warn(`Input loop error: ${err.message}`);
      } finally {
        isHandlingLine = false;
        if (!isClosing) {
          rl.resume();
          setRawMode(true);
          buildPrompt();
          rl.prompt();
        }
      }
    });

    // refresh sidebar on terminal resize
    process.stdout.on('resize', () => {
      if (!isHandlingLine && !isClosing) {
        buildPrompt();
        showSidebar(config);
        rl.prompt();
      }
    });

    setRawMode(true);
    buildPrompt();
    rl.prompt();
    showSidebar(config);

    rl.on('close', () => {
      clearSidebar();
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
 *
 * `cancellation` is a {value: boolean} ref. When set to true mid-loop, the
 * loop bails out at the next safe boundary (between iterations or between
 * tool calls), reverts the messages added during this turn, and saves
 * history so the user can keep typing from the same point.
 */
async function agentLoop(provider, messages, config, trustConfig, cancellation = { value: false }) {
  // No hard cap. The loop runs until the model stops emitting tool calls
  // or the user cancels via Esc / Ctrl+C. (The legacy `maxIterations`
  // config field is no longer honored.)
  const MAX_ITERATIONS = Infinity;
  let iteration = 0;
  // Remember length before the agent starts adding turns so we can cleanly
  // rewind on error instead of blindly popping the last message (which on
  // iter >= 2 is a tool-result user message, not the user's original input).
  const baselineLen = messages.length;

  // Bail helper: rewind any new messages added during this turn, save
  // history, return to caller.
  const cancel = (reason) => {
    if (messages.length > baselineLen) messages.length = baselineLen;
    else messages.pop();
    saveHistory(messages);
    info(reason || 'Task cancelled. Conversation preserved.');
  };

  while (iteration < MAX_ITERATIONS) {
    if (cancellation.value) {
      cancel();
      return;
    }
    iteration++;
    const spinner = createSpinner();
    spinner.start();

    let fullResponse = '';
    let rawResponse = '';
    let sawThinking = false;
    let sawContent = false;

    try {
      let firstChunk = true;
      rawResponse = await provider.streamChat(messages, {
        onThinking: (chunk) => {
          if (cancellation.value) return;  // silent: don't print more
          if (firstChunk) {
            spinner.stop();
            process.stdout.write('\n');
            firstChunk = false;
          }
          if (!sawThinking) {
            process.stdout.write(chalk.gray('Thinking:\n'));
            sawThinking = true;
          }
          process.stdout.write(chalk.gray(chunk));
        },
        onContent: (chunk) => {
          if (cancellation.value) return;  // silent: don't print more
          if (firstChunk) {
            spinner.stop();
            process.stdout.write('\n');
            firstChunk = false;
          }
          if (sawThinking && !sawContent) {
            process.stdout.write(chalk.white('\n\nAnswer:\n'));
          }
          sawContent = true;
          process.stdout.write(chalk.white(chunk));
        },
      });

      const normalized = normalizeAssistantResponse(rawResponse);
      fullResponse = normalized.text;

      if (cancellation.value) {
        spinner.stop();
        cancel('Task cancelled mid-response. Conversation preserved.');
        return;
      }

      if (firstChunk) {
        spinner.stop();
        process.stdout.write('\n' + chalk.white(fullResponse));
      } else if (sawThinking && !sawContent && fullResponse) {
        process.stdout.write(chalk.white('\n\nAnswer:\n' + fullResponse));
      }
      console.log('\n');
    } catch (err) {
      spinner.stop();
      // Cancellation can surface as a fetch abort — treat it as a clean cancel.
      if (cancellation.value) {
        cancel('Task cancelled. Conversation preserved.');
        return;
      }
      warn(`Error: ${err.message}\n`);
      // Rewind everything added since the user's input so the conversation
      // isn't left with an unanswered tool-result or half-finished turn.
      if (messages.length > baselineLen) {
        messages.length = baselineLen;
      } else {
        messages.pop();
      }
      saveHistory(messages);
      return;
    }

    // Parse tool calls from the response
    const normalized = normalizeAssistantResponse(rawResponse);
    const parsed = parseToolCalls(normalized.text);
    const usingNativeToolCalls = normalized.nativeToolCalls.length > 0;
    const toolCalls = usingNativeToolCalls ? normalized.nativeToolCalls : parsed.toolCalls;
    const hallucinatedToolResult = parsed.hallucinatedToolResult;
    messages.push(normalized.assistantMessage);

    if (hallucinatedToolResult && toolCalls.length === 0) {
      warn('Model hallucinated a <tool_result> block. Injecting correction.\n');
      messages.push({
        role: 'user',
        content: 'You wrote a <tool_result> block yourself. That tag is produced ONLY by the runtime, after you emit a <tool_call> and the runtime actually runs the tool. No tool was actually run. If you want to use a tool, emit <tool_call>...</tool_call> and STOP — wait for the real <tool_result> in the next message.',
      });
      continue;
    }

    if (shouldInjectWorkspaceCorrection(messages, toolCalls, normalized.text)) {
      warn('Model stalled instead of inspecting the workspace. Injecting correction.\n');
      messages.push({
        role: 'user',
        content: '[runtime correction] The repository is already available in the current workspace. Do not ask the user to paste code or describe the project. Immediately inspect the project using tools and continue the audit. Start by reading or searching relevant files now.',
      });
      continue;
    }

    if (toolCalls.length === 0) {
      saveHistory(messages);
      return;
    }

    // Execute tool calls (check cancellation between each so Esc feels snappy).
    const results = [];
    let cancelledMidTools = false;
    for (const tc of toolCalls) {
      if (cancellation.value) {
        cancelledMidTools = true;
        break;
      }
      console.log(chalk.cyan(`  ⚙ ${tc.name}`) + chalk.gray(` ${formatToolArgs(tc.args)}`));

      const result = await executeTool(tc, trustConfig, config);

      if (result.error) {
        console.log(chalk.red(`    ✖ ${result.error}\n`));
      } else {
        const summary = summarizeResult(tc.name, result);
        console.log(chalk.green(`    ✔ ${summary}\n`));
      }

      results.push({ tool: tc.name, toolCallId: tc.id, result });
    }

    if (cancelledMidTools) {
      // Drop the partial assistant turn + any tool results we already added.
      cancel('Task cancelled mid-execution. Conversation preserved.');
      return;
    }

    // Feed tool results back to the AI
    if (usingNativeToolCalls) {
      messages.push(...results.map(r => ({
        role: 'tool',
        tool_call_id: r.toolCallId,
        name: r.tool,
        content: JSON.stringify(r.result, null, 2),
      })));
    } else {
      const toolResultMessage = results.map(r =>
        `<tool_result name="${r.tool}">\n${JSON.stringify(r.result, null, 2)}\n</tool_result>`
      ).join('\n\n');

      messages.push({ role: 'user', content: toolResultMessage });
    }

    // Continue the loop so the AI can process results and potentially call more tools
  }

  // Hit maxIterations (only reachable if a non-Infinity cap is set). Append
  // a synthetic notice so history stays coherent and the next session can
  // pick up cleanly.
  if (Number.isFinite(MAX_ITERATIONS)) {
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant') {
      messages.push({
        role: 'user',
        content: `<tool_result name="__system__">\n{"interrupted": "agent reached maxIterations (${MAX_ITERATIONS}) — tool calls above were not executed"}\n</tool_result>`,
      });
    }
  }
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
async function handleCommand(input, messages, config, provider, rl, trustConfig, onProviderChange, onSystemPromptChange) {
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
        const currentSystemPrompt = messages[0]?.content || buildSystemPrompt(trustConfig, config);
        messages.length = 0;
        messages.push({ role: 'system', content: currentSystemPrompt });
      }
      saveHistory(messages);
      success('Conversation cleared.\n');
      break;

    case '/model':
      info(`Provider: ${config.provider}`);
      info(`Model: ${config.model}`);
      info(`Tool Calling: ${config.toolCallMode || 'xml'}`);
      info(`Base URL: ${config.baseUrl || 'default'}\n`);
      break;

    case '/config':
      console.log(chalk.gray(JSON.stringify(config, (k, v) => k === 'apiKey' ? '••••' : v, 2)));
      console.log();
      break;

    case '/tasks':
      showTasksPanel(config);
      break;

    case '/settings':
      await openSettings(config, provider, trustConfig, onProviderChange, onSystemPromptChange);
      break;

    case '/init':
      {
        const target = path.join(process.cwd(), 'CREECODE.md');
        if (fs.existsSync(target)) {
          warn(`CREECODE.md already exists at ${target}\n`);
        } else {
          try {
            fs.writeFileSync(target, INIT_TEMPLATE, 'utf-8');
            success(`Created ${target}`);
            info('Edit it to teach the agent about your project, then /clear to reload.\n');
          } catch (err) {
            warn(`Failed to create CREECODE.md: ${err.message}\n`);
          }
        }
      }
      break;

    default:
      if (input.startsWith('/system ')) {
        const newSystem = input.slice(8).trim();
        if (newSystem) {
          const updated = buildSystemPrompt(trustConfig, config, newSystem);
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
async function openSettings(config, provider, trustConfig, onProviderChange, onSystemPromptChange) {
  console.log(chalk.white.bold('\n  ⚙  Settings\n'));

  const setting = await select({
    message: 'What would you like to configure?',
    choices: [
      { name: `Provider             [${config.provider}]`, value: 'provider' },
      { name: `Model                [${config.model || 'default'}]`, value: 'model' },
      { name: `Commands Trust Level  [${trustConfig.commands}]`, value: 'commands' },
      { name: `File Edit Trust Level [${trustConfig.files}]`, value: 'files' },
      { name: `Tool Calling Mode   [${config.toolCallMode || 'xml'}]`, value: 'toolCallMode' },
      { name: 'Back', value: 'back' },
    ],
  });

  if (setting === 'back') {
    console.log();
    return;
  }

  if (setting === 'provider') {
    const providerId = await select({
      message: 'Choose provider:',
      choices: getProviderChoices(),
      default: config.provider,
    });
    const providerDef = PROVIDERS[providerId];
    const nextConfig = { ...config, provider: providerId };

    if (providerDef.custom) {
      nextConfig.baseUrl = await input({
        message: 'Enter the API base URL:',
        default: nextConfig.baseUrl || providerDef.baseUrl || '',
        validate: (val) => val.length > 0 || 'Base URL is required for custom providers',
      });
    } else {
      const useDefaultBaseUrl = await confirm({
        message: `Use default base URL (${providerDef.baseUrl})?`,
        default: true,
      });
      nextConfig.baseUrl = useDefaultBaseUrl
        ? providerDef.baseUrl
        : await input({
          message: 'Enter custom base URL:',
          default: nextConfig.baseUrl || providerDef.baseUrl,
        });
    }

    if (providerDef.needsKey) {
      nextConfig.apiKey = await input({
        message: `Enter ${providerDef.name} API key:`,
        default: nextConfig.apiKey || '',
        validate: (val) => val.length > 0 || 'API key is required',
      });
    } else {
      nextConfig.apiKey = '';
    }

    nextConfig.model = await chooseModelFromProvider(providerId, providerDef, nextConfig);
    const newProvider = createProvider(nextConfig);

    Object.assign(config, nextConfig);
    saveConfig(config);
    onProviderChange(newProvider);

    const updated = buildSystemPrompt(trustConfig, config);
    onSystemPromptChange(updated);

    success(`Provider set to: ${providerDef.name} (${config.model})`);
    console.log();
    return;
  }

  if (setting === 'model') {
    const providerDef = PROVIDERS[config.provider];
    config.model = await chooseModelFromProvider(config.provider, providerDef, config);
    const newProvider = createProvider(config);
    saveConfig(config);
    onProviderChange(newProvider);

    const updated = buildSystemPrompt(trustConfig, config);
    onSystemPromptChange(updated);

    success(`Model set to: ${config.model}`);
    console.log();
    return;
  }

  if (setting === 'toolCallMode') {
    const newMode = await select({
      message: 'Set tool calling mode:',
      choices: TOOL_CALL_MODE_CHOICES,
      default: config.toolCallMode || 'xml',
    });

    config.toolCallMode = newMode;
    provider.toolCallMode = newMode;
    saveConfig(config);

    const updated = buildSystemPrompt(trustConfig, config);
    onSystemPromptChange(updated);

    success(`Tool calling mode set to: ${newMode}`);
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

  config.trust = { ...trustConfig };
  saveConfig(config);

  const updated = buildSystemPrompt(trustConfig, config);
  onSystemPromptChange(updated);

  success(`${TRUST_CATEGORIES[setting]} trust set to: ${newLevel}`);
  console.log();
}

/**
 * Display full task list as a panel in the terminal.
 */
function showTasksPanel(config) {
  const todos = loadTodos(config);
  const pending = todos.filter(t => !t.done);
  const done = todos.filter(t => t.done);

  console.log(chalk.white.bold('\n  Tasks\n'));
  console.log(chalk.gray('  ' + '\u2500'.repeat(40)));

  if (pending.length === 0 && done.length === 0) {
    dim('  No tasks yet. Use add_todo tool or /tasks to check.');
    console.log();
    return;
  }

  if (pending.length > 0) {
    console.log(chalk.cyan(`  Pending (${pending.length})\n`));
    for (const t of pending) {
      const pColor = t.priority === 'high' ? chalk.red : t.priority === 'medium' ? chalk.yellow : chalk.gray;
      const pTag = t.priority ? ` ${pColor(`[${t.priority}]`)}` : '';
      const tag = t.tag ? chalk.magenta(` #${t.tag}`) : '';
      console.log(`  ${chalk.gray('\u25cb')} ${t.text}${pTag}${tag}`);
    }
  }

  if (done.length > 0) {
    console.log(chalk.green(`\n  Done (${done.length})\n`));
    for (const t of done) {
      console.log(`  ${chalk.green('\u2713')} ${chalk.gray.dim(t.text)}`);
    }
  }

  console.log(chalk.gray('  ' + '\u2500'.repeat(40)));
  console.log(chalk.gray(`  Total: ${todos.length} | Pending: ${pending.length} | Done: ${done.length}`));
  console.log();
}
