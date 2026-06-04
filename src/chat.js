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
import { createProvider, getProviderChoices, PROVIDERS, codexLogin, codexLogout, codexStatus, copilotStatus, copilotLogout, startGitHubCopilotAuth } from './providers/index.js';
import { showSidebar, clearSidebar, canShowSidebar, loadTodos, MIN_WIDTH } from './utils/sidebar.js';
import { subagentManager } from './subagent.js';
import { discoverSkills, initSkillDir, clearRuntimeTools, registerRuntimeTool } from './tools/index.js';
import { normalizeAssistantResponse } from './utils/normalize.js';
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

## Subagents
You can spawn background subagents with the \`spawn_subagent\` tool to work on independent tasks in parallel. Each sub runs its own agent loop with its own messages (saved to ~/.creecode/subagents/<id>.json). When a sub needs approval for a prompt-trust tool call, you'll get a synthetic message describing the request_id — call \`decide_subagent_approval\` with that id and action "approve" or "deny". If you can't decide, the user can step in via /approve or /deny. When a sub finishes, you'll get a [subagent ... finished] message with its summary. Use \`list_subagents\` to see what's running, \`subagent_status\` for detail, \`kill_subagent\` to terminate.

## Skills
Custom user-defined skills live in ~/.creecode/skills/<name>/. Each skill is a folder with a SKILL.md (description + arg schema) and a run.js or run.sh. They are exposed to you as \`skill_<name>\` tools. The user can /init-skill to scaffold an example and /refresh-skills to reload after editing.`;


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
  '/view': 'Show current viewable session (usage: /view [main|sub_id])',
  '/compact': 'Compress conversation history via a summarizing LLM call',
  '/sessions': 'List running subagents',
  '/session': 'Show a subagent\'s messages (usage: /session <id>)',
  '/approvals': 'List pending subagent approval requests',
  '/approve': 'Approve a pending request (usage: /approve <request_id>)',
  '/deny': 'Deny a pending request (usage: /deny <request_id>)',
  '/init-skill': 'Create an example skill in ~/.creecode/skills/example-hello',
  '/refresh-skills': 'Re-scan ~/.creecode/skills and register newly added ones',
  '/login': 'Log in to a provider (usage: /login codex|copilot)',
  '/logout': 'Log out of a provider (usage: /logout codex|copilot)',
  '/exit': 'Exit CreeCode',
};

const TOOL_CALL_MODE_CHOICES = [
  { name: 'XML Tags — model emits <tool_call> blocks', value: 'xml' },
  { name: 'Native — use provider-native tool calling when supported', value: 'native' },
  { name: 'Both — allow native tool calling and XML fallback', value: 'both' },
];

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
      const tmpProvider = new providerDef.class({
        baseUrl: config.baseUrl || providerDef.baseUrl,
        fetchFn: globalThis.fetch,
      });
      const models = await tmpProvider.listModels();
      if (models.length > 0) {
        const choices = models.map(m => {
          const tags = (m.tags || []).map(t => chalk.gray(`[${t}]`)).join(' ');
          return { name: tags ? `${m.id} ${tags}` : m.id, value: m.id };
        });
        choices.push({ name: chalk.yellow('— enter model name manually —'), value: '__manual__' });
        const pick = await select({ message: `Select a model (${models.length} available):`, choices });
        if (pick === '__manual__') {
          return await input({ message: 'Enter Ollama model name:', default: config.model || providerDef.defaultModel });
        }
        return pick;
      }
    } catch {
      // fall back to manual input below
    }
    return await input({
      message: 'Enter Ollama model name:',
      default: config.model || providerDef.defaultModel,
    });
  }

  // Generic path: ask the provider's class to list models (works for
  // OpenAI, Anthropic, Gemini, Codex, Copilot, etc.). Falls back to
  // manual input if the endpoint is unavailable or returns nothing.
  if (!providerDef.custom) {
    info(`Fetching model list for ${providerDef.name}...`);
    try {
      const tmpProvider = new providerDef.class({
        apiKey: config.apiKey || '',
        baseUrl: config.baseUrl || providerDef.baseUrl,
        model: config.model || providerDef.defaultModel,
        fetchFn: globalThis.fetch,
        toolCallMode: config.toolCallMode || 'xml',
      });
      const models = await tmpProvider.listModels();
      if (models.length > 0) {
        // Sort so the most relevant / current models are at the top.
        const sorted = [...models].sort((a, b) => {
          const cur = (config.model || '').toLowerCase();
          const ai = a.id.toLowerCase() === cur ? -2 : a.id.toLowerCase().includes(cur) ? -1 : 0;
          const bi = b.id.toLowerCase() === cur ? -2 : b.id.toLowerCase().includes(cur) ? -1 : 0;
          if (ai !== bi) return ai - bi;
          return a.id.localeCompare(b.id);
        });
        const choices = sorted.map(m => {
          const tags = (m.tags || []).map(t => chalk.gray(`[${t}]`)).join(' ');
          const display = m.display_name && m.display_name !== m.id ? `${m.id} — ${m.display_name}` : m.id;
          return { name: tags ? `${display} ${tags}` : display, value: m.id };
        });
        choices.push({ name: chalk.yellow('— enter model name manually —'), value: '__manual__' });
        const pick = await select({
          message: `Select a model (${models.length} available):`,
          choices,
          default: sorted[0]?.id,
        });
        if (pick === '__manual__') {
          return await input({
            message: 'Enter model name/ID:',
            default: config.model || providerDef.defaultModel,
            validate: (val) => val.length > 0 || 'Model name is required',
          });
        }
        return pick;
      }
    } catch (e) {
      warn(`Could not fetch model list (${e.message}). Falling back to manual entry.`);
    }
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

    // ---- Skills discovery ----
    // First-run convenience: if the user has never set up skills, drop a
    // starter example in place so the system isn't empty on first use.
    try { initSkillDir(config); } catch {}
    clearRuntimeTools();
    const skills = discoverSkills(config);
    for (const sk of skills) {
      try { registerRuntimeTool(skillToToolDef(sk)); } catch {}
    }
    if (skills.length > 0) {
      info(`Loaded ${skills.length} skill${skills.length === 1 ? '' : 's'}: ${skills.map(s => s.name).join(', ')}`);
    }

    // ---- Subagent manager wiring ----
    // Pings and approval requests are surfaced to the main agent as synthetic
    // user-turn messages, so the main agent can react on its next iteration.
    const mainCtx = {
      provider, config, trustConfig,
      onSubFinished: (sub, ev) => {
        const tag = ev.error ? 'error' : 'finished';
        const line = `\n[subagent ${sub.id} ${tag}]${ev.error ? ' ' + ev.error : ''}\n${sub.summary || ''}\n`;
        process.stdout.write('\n' + chalk.magenta(line) + '\n');
        if (isHandlingLine) {
          messages.push({ role: 'user', content: `[subagent ${sub.id} ${tag}] ${sub.summary || (ev.error || '')}` });
        }
      },
      onApprovalNeeded: ({ requestId, sub, tool }) => {
        const note = `\n[subagent ${sub.id} wants ${tool.name}] (request ${requestId})\n`;
        process.stdout.write('\n' + chalk.yellow(note) + '\n');
        if (isHandlingLine) {
          messages.push({
            role: 'user',
            content: `[subagent ${sub.id} requests approval] tool: ${tool.name} args: ${JSON.stringify(tool.args || {})} request_id: ${requestId}. Call decide_subagent_approval with that request_id and action "approve" or "deny".`,
          });
        } else {
          // Main is idle — surface as a one-line system nudge for the next
          // user turn rather than synthesizing tool calls.
          process.stdout.write(chalk.yellow('  (type something for the main agent to decide; or use /approvals)\n'));
          subagentManager._pendingIdle = subagentManager._pendingIdle || [];
          subagentManager._pendingIdle.push({ requestId, sub, tool });
        }
      },
    };
    subagentManager.attachMainAgent(mainCtx);

    console.log(chalk.cyan.bold('\n  CreeCode'));
    dim(`  Provider: ${config.provider} | Model: ${config.model || 'default'}`);
    dim(`  Trust — Commands: ${trustConfig.commands} | Files: ${trustConfig.files}`);
    if (process.stdout.columns >= MIN_WIDTH) {
      dim('  Task sidebar: auto-shown when terminal is wide enough (100+ cols)');
    }
    dim('  Type /help for commands, /exit to quit.\n');

    let isHandlingLine = false;
    const pendingInput = [];     // user input captured while the agent is busy
    // currentView is wrapped in an object so handleCommand (called by value)
    // can mutate it and the caller sees the change.
    const viewState = { current: 'main' };
    // Inject view info into the prompt so the user always knows what's live.
    function buildPrompt() {
      const todos = loadTodos(config);
      const pending = todos.filter(t => !t.done).length;
      const viewTag = viewState.current === 'main'
        ? chalk.cyan('main')
        : chalk.magenta(`sub:${viewState.current}`);
      const tail = pending > 0 ? chalk.cyan(`[${pending} task${pending > 1 ? 's' : ''}] `) : '';
      rl.setPrompt(chalk.green('❯ ') + viewTag + ' ' + tail);
    }

    buildPrompt();
    rl.prompt();

    rl.on('line', async (userInput) => {
      if (isClosing) return;

      // While the agent is busy, queue input instead of dropping it. The
      // agent loop drains the queue when it returns. /exit, /quit, and
      // Esc-cancel are still honored immediately (the cancellation flag
      // is checked in the loop).
      if (isHandlingLine) {
        pendingInput.push(userInput);
        return;
      }

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
          }, { viewState, buildPrompt });
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
          // Drain any input captured while the agent was running. We only
          // process the FIRST queued line here; the rest wait for the next
          // turn so the user can see the agent's final response first.
          if (pendingInput.length > 0) {
            const next = pendingInput.shift();
            isHandlingLine = true;
            try {
              const trimmedNext = next.trim();
              if (trimmedNext) {
                if (trimmedNext.startsWith('/')) {
                  await handleCommand(trimmedNext, messages, config, provider, rl, trustConfig, (p) => { provider = p; }, (sp) => { systemPrompt = sp; messages[0] = { role: 'system', content: systemPrompt }; }, { viewState, buildPrompt });
                } else {
                  messages.push({ role: 'user', content: trimmedNext });
                  await agentLoop(provider, messages, config, trustConfig, cancellation);
                  cancellation.value = false;
                }
              }
            } catch (e) { warn(`Queued input error: ${e.message}`); }
            finally { isHandlingLine = false; }
          }
          if (!isClosing) {
            rl.resume();
            setRawMode(true);
            buildPrompt();
            rl.prompt();
          }
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
async function handleCommand(input, messages, config, provider, rl, trustConfig, onProviderChange, onSystemPromptChange, state = {}) {
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

    case '/view': {
      // No arg -> show current view. arg "main" -> main. Otherwise treat
      // as a subagent id. The view is purely a display concern; it does
      // not redirect user input (that always goes to the main session).
      const { viewState, buildPrompt } = state;
      const arg = input.slice('/view'.length).trim();
      if (!arg) {
        if (viewState.current === 'main') {
          success('Viewing: main agent\n');
        } else {
          const sub = subagentManager.get(viewState.current);
          if (sub) success(`Viewing: ${sub.name || sub.id} (${sub.status})\n`);
          else { viewState.current = 'main'; success('Viewing: main agent (was stale)\n'); }
        }
        break;
      }
      if (arg === 'main' || arg === 'm') {
        viewState.current = 'main';
        success('Switched view to: main\n');
        buildPrompt();
        rl.prompt();
        break;
      }
      const sub = subagentManager.get(arg);
      if (!sub) { warn(`No subagent with id ${arg}. Use /sessions to list.\n`); break; }
      viewState.current = sub.id;
      success(`Switched view to: ${sub.name || sub.id} (${sub.status})\n`);
      buildPrompt();
      rl.prompt();
      break;
    }

    case '/compact': {
      // Compress conversation history with a summarizing LLM call.
      // Keeps the system prompt + summary + last few turns.
      const keepLast = 4;
      if (messages.length < keepLast + 2) {
        warn('Nothing to compact — conversation is too short.\n');
        break;
      }
      const sys = messages[0];
      const tail = messages.slice(-keepLast);
      const toSummarize = messages.slice(1, -keepLast);
      const transcript = toSummarize.map(m => {
        const role = m.role === 'assistant' ? 'AGENT' : m.role === 'tool' ? 'TOOL' : m.role.toUpperCase();
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `${role}: ${c.length > 2000 ? c.slice(0, 2000) + '...[truncated]' : c}`;
      }).join('\n\n');
      const summaryPrompt = `You are compressing a CreeCode conversation. Produce a concise summary that preserves:\n  - The user's original goal\n  - Key decisions and constraints the agent learned\n  - Important file paths, tool results, and identifiers\n  - Unresolved questions or pending actions\n\nDrop greetings, repetition, and irrelevant tangents. Output ONLY the summary text — no preamble, no headings, no markdown.\n\n---\nTRANSCRIPT:\n${transcript}\n---`;
      const spinner = createSpinner();
      spinner.start();
      try {
        const compactMessages = [
          { role: 'system', content: 'You are a precise conversation compressor.' },
          { role: 'user', content: summaryPrompt },
        ];
        const raw = await provider.streamChat(compactMessages, {});
        const norm = normalizeAssistantResponse(raw);
        const summary = norm.text.trim() || '(empty summary)';
        spinner.stop();
        success(`Compacted ${toSummarize.length} message(s) into a ${summary.length}-char summary.\n`);
        messages.length = 0;
        messages.push(sys);
        messages.push({ role: 'user', content: `[Compacted conversation — earlier turns replaced by this summary]\n\n${summary}` });
        messages.push({ role: 'assistant', content: 'Understood. I have the summary of the earlier conversation and the last few turns. Continuing from here.' });
        for (const m of tail) messages.push(m);
        saveHistory(messages);
      } catch (e) {
        spinner.stop();
        warn(`Compact failed: ${e.message}\n`);
      }
      break;
    }

    case '/settings':
      await openSettings(config, provider, trustConfig, onProviderChange, onSystemPromptChange);
      break;

    case '/sessions': {
      const list = subagentManager.list();
      if (list.length === 0) {
        dim('  No subagents running.\n');
      } else {
        console.log(chalk.white.bold('\n  Subagents\n'));
        for (const s of list) {
          const statusColor = s.status === 'running' ? chalk.yellow : s.status === 'done' ? chalk.green : chalk.gray;
          console.log(`  ${statusColor(s.status.padEnd(10))} ${chalk.cyan(s.id)}  ${chalk.gray(s.name)}`);
          console.log(`    ${chalk.gray('task:')} ${s.task.slice(0, 100)}`);
          if (s.summary) console.log(`    ${chalk.gray('summary:')} ${s.summary.slice(0, 100)}`);
        }
        const pending = subagentManager.pendingApprovals.length;
        if (pending > 0) {
          console.log(chalk.yellow(`\n  ${pending} pending approval request(s) — use /approvals\n`));
        } else {
          console.log();
        }
      }
      break;
    }

    case '/session': {
      const arg = input.slice('/session'.length).trim();
      if (!arg) { warn('usage: /session <subagent_id>\n'); break; }
      const sub = subagentManager.get(arg);
      if (!sub) { warn(`No subagent with id ${arg}\n`); break; }
      console.log(chalk.white.bold(`\n  Subagent ${sub.id} (${sub.name}) — ${sub.status}\n`));
      console.log(chalk.gray(`  task: ${sub.task}\n`));
      const last = sub.messages.slice(-12);
      for (const m of last) {
        const tag = m.role === 'user' ? chalk.blue('USER ') : m.role === 'assistant' ? chalk.green('AGENT') : chalk.gray(m.role.toUpperCase());
        const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        const text = body.length > 400 ? body.slice(0, 400) + '...' : body;
        console.log(`  ${tag}  ${text}\n`);
      }
      if (sub.summary) {
        console.log(chalk.gray('  summary: ') + sub.summary + '\n');
      }
      break;
    }

    case '/approvals': {
      const list = subagentManager.pendingApprovals;
      if (list.length === 0) { dim('  No pending approvals.\n'); break; }
      console.log(chalk.white.bold('\n  Pending approvals\n'));
      for (const p of list) {
        console.log(`  ${chalk.cyan(p.id)}  ${chalk.gray(p.sub.id + ' / ' + p.tool.name)}`);
        console.log(`    ${chalk.gray('args:')} ${JSON.stringify(p.tool.args || {}).slice(0, 200)}`);
      }
      console.log();
      break;
    }

    case '/approve': {
      const id = input.slice('/approve'.length).trim();
      if (!id) { warn('usage: /approve <request_id>\n'); break; }
      const ok = subagentManager.resolveApproval(id, { action: 'approve', decided_by: 'user', reason: 'user approved via /approve' });
      if (ok) success(`Approved ${id}\n`); else warn(`No pending request with id ${id}\n`);
      break;
    }

    case '/deny': {
      const id = input.slice('/deny'.length).trim();
      if (!id) { warn('usage: /deny <request_id>\n'); break; }
      const ok = subagentManager.resolveApproval(id, { action: 'deny', decided_by: 'user', reason: 'user denied via /deny' });
      if (ok) success(`Denied ${id}\n`); else warn(`No pending request with id ${id}\n`);
      break;
    }

    case '/init-skill': {
      try {
        const dir = initSkillDir(config);
        clearRuntimeTools();
        for (const sk of discoverSkills(config)) registerRuntimeTool(skillToToolDef(sk));
        success(`Skills dir: ${dir}`);
        info('Edit SKILL.md in any subdir under it, drop a run.js or run.sh, then /refresh-skills.\n');
      } catch (e) { warn(`Failed: ${e.message}\n`); }
      break;
    }

    case '/login': {
      const arg = input.slice('/login'.length).trim();
      if (!arg) { warn('usage: /login codex | /login copilot\n'); break; }
      if (arg === 'codex') {
        const spinner = createSpinner();
        spinner.start();
        try {
          const r = await codexLogin({ open: true });
          spinner.stop();
          success(`Logged in to Codex as ${r.email || 'unknown user'}.\n`);
        } catch (e) { spinner.stop(); warn(`Codex login failed: ${e.message}\n`); }
      } else if (arg === 'copilot') {
        // GitHub OAuth Device Flow (RFC 8628). Copilot API only accepts
        // tokens from GitHub OAuth apps with the `copilot` scope, not
        // personal access tokens.
        info('Requesting device code from GitHub...');
        let prompt;
        const result = await startGitHubCopilotAuth({
          onPrompt: (p) => { prompt = p; },
        });
        if (prompt) {
          console.log();
          info('To finish signing in to GitHub Copilot, open:');
          info(`  ${chalk.cyan(prompt.verifyUrl)}`);
          info(`and enter the code:  ${chalk.bold(prompt.userCode)}`);
          info('(polling for authorization...)');
        }
        success(`Logged in to GitHub Copilot (scope: ${result.scope || 'copilot'}).\n`);
      } else {
        warn(`Unknown provider "${arg}". Supported: codex, copilot\n`);
      }
      break;
    }

    case '/logout': {
      const arg = input.slice('/logout'.length).trim();
      if (arg === 'codex') { codexLogout(); success('Logged out of Codex.\n'); }
      else if (arg === 'copilot') { copilotLogout(); success('Copilot token cleared.\n'); }
      else warn('usage: /logout codex | /logout copilot\n');
      break;
    }

    case '/refresh-skills': {
      clearRuntimeTools();
      const list = discoverSkills(config);
      for (const sk of list) registerRuntimeTool(skillToToolDef(sk));
      success(`Reloaded ${list.length} skill${list.length === 1 ? '' : 's'}.\n`);
      break;
    }

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

  // Loop so the user can configure multiple things in one visit.
  for (;;) {
    const cdx = codexStatus();
    const cop = copilotStatus();
    const setting = await select({
      message: 'What would you like to configure?',
      choices: [
        { name: `Provider              [${config.provider}]`, value: 'provider' },
        { name: `Model                 [${config.model || 'default'}]`, value: 'model' },
        { name: `─── Auth ───`, value: '_sep_auth', disabled: true },
        { name: `  Login/Logout        /login codex|copilot   (status: codex=${cdx.logged_in ? '✓' : '✗'} copilot=${cop.logged_in ? '✓' : '✗'})`, value: 'auth' },
        { name: `─── Trust Levels ───`, value: '_sep_trust', disabled: true },
        ...Object.entries(TRUST_CATEGORIES).map(([k, v]) => ({
          name: `  ${v.padEnd(28)} [${trustConfig[k] || 'prompt-trust'}]`,
          value: `trust:${k}`,
        })),
        { name: `─── Network ───`, value: '_sep_net', disabled: true },
        { name: `  Network Timeout     [${config.networkTimeoutMs} ms]`, value: 'net:timeout' },
        { name: `  Network Max Bytes   [${config.networkMaxBytes}]`, value: 'net:maxbytes' },
        { name: `  Allowed Hosts       [${(config.networkAllowHosts || []).length || 'any'}]`, value: 'net:allow' },
        { name: `  Denied Hosts        [${(config.networkDenyHosts || []).length}]`, value: 'net:deny' },
        { name: `  Search Instance     [${config.searchInstance || '(none, auto)'} ]`, value: 'net:search' },
        { name: `  Proxy               [${config.proxy || '(none)'}]`, value: 'net:proxy' },
        { name: `─── Paths ───`, value: '_sep_path', disabled: true },
        { name: `  Allow Outside Workspace  [${config.allowOutsideWorkspace}]`, value: 'path:outside' },
        { name: `  Dangerous Paths Bypass  [${(config.dangerousPaths || []).length}]`, value: 'path:dangerous' },
        { name: `  Memory File        [${config.memoryFile || '~/.creecode/memory.json'}]`, value: 'path:memory' },
        { name: `  Skills Dir          [${config.skillsDir || '~/.creecode/skills'}]`, value: 'path:skills' },
        { name: `─── Commands ───`, value: '_sep_cmd', disabled: true },
        { name: `  Command Timeout     [${config.commandTimeoutMs} ms]`, value: 'cmd:timeout' },
        { name: `  Command Max Output  [${config.commandMaxOutputBytes} bytes]`, value: 'cmd:maxout' },
        { name: `─── Generation ───`, value: '_sep_gen', disabled: true },
        { name: `  Temperature         [${config.temperature}]`, value: 'gen:temperature' },
        { name: `  Top-P               [${config.topP}]`, value: 'gen:topp' },
        { name: `  Max Tokens          [${config.maxTokens}]`, value: 'gen:maxtokens' },
        { name: `  Tool Calling Mode   [${config.toolCallMode || 'xml'}]`, value: 'toolCallMode' },
        { name: `─── System ───`, value: '_sep_sys', disabled: true },
        { name: `  System Prompt Appendix  [${(config.systemPromptAppendix || '').slice(0, 40)}]`, value: 'sys:appendix' },
        { name: `  History Max Messages     [${config.historyMaxMessages}]`, value: 'sys:historymax' },
        { name: `  Auto-Compact History     [${config.autoCompactHistory}]`, value: 'sys:autocompact' },
        { name: `─── Tools ───`, value: '_sep_tools', disabled: true },
        { name: `  Disabled Tools     [${(config.disabledTools || []).length}]`, value: 'tools:disable' },
        { name: `  Enabled Tools      [${config.enabledTools ? config.enabledTools.length : 'all'}]`, value: 'tools:enable' },
        { name: 'Done', value: 'back' },
      ],
    });

    if (setting === 'back') { console.log(); return; }

    // Separators
    if (typeof setting === 'string' && setting.startsWith('_sep_')) continue;

    // Trust levels
    if (setting.startsWith('trust:')) {
      const k = setting.slice('trust:'.length);
      await editTrustLevel(k, trustConfig, config, onSystemPromptChange);
      continue;
    }

    // Settings key handlers
    if (setting === 'provider') {
      await editProvider(config, provider, trustConfig, onProviderChange, onSystemPromptChange);
      continue;
    }
    if (setting === 'model') {
      await editModel(config, provider, onProviderChange, onSystemPromptChange);
      continue;
    }
    if (setting === 'auth') {
      await editAuth();
      continue;
    }
    if (setting === 'toolCallMode') {
      await editToolCallMode(config, provider, trustConfig, onProviderChange, onSystemPromptChange);
      continue;
    }
    if (setting.startsWith('net:')) await editNet(setting.slice(4), config);
    else if (setting.startsWith('path:')) await editPath(setting.slice(5), config);
    else if (setting.startsWith('cmd:')) await editCmd(setting.slice(4), config);
    else if (setting.startsWith('gen:')) await editGen(setting.slice(4), config);
    else if (setting.startsWith('sys:')) await editSys(setting.slice(4), config);
    else if (setting.startsWith('tools:')) await editTools(setting.slice(6), config);
    else warn(`Unhandled setting: ${setting}\n`);
  }

  // Unreachable — kept to satisfy linters that don't see the inner return.
  console.log();
}

async function editTrustLevel(k, trustConfig, config, onSystemPromptChange) {
  const newLevel = await select({
    message: `Set trust level for ${TRUST_CATEGORIES[k]}:`,
    choices: Object.entries(TRUST_LEVELS).map(([id, l]) => ({ name: `${l.name} — ${l.description}`, value: id })),
    default: trustConfig[k] || 'prompt-trust',
  });
  trustConfig[k] = newLevel;
  config.trust = { ...trustConfig };
  saveConfig(config);
  const updated = buildSystemPrompt(trustConfig, config);
  onSystemPromptChange(updated);
  success(`${TRUST_CATEGORIES[k]} trust set to: ${newLevel}\n`);
}

async function editProvider(config, provider, trustConfig, onProviderChange, onSystemPromptChange) {
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
  } else if (providerDef.auth === 'oauth') {
    if (!(await confirm({ message: `Run OAuth login for ${providerDef.name} now?`, default: true }))) {
      nextConfig.apiKey = '';
    } else {
      try {
        const r = providerId === 'codex' ? await codexLogin({ open: true }) : null;
        if (r) success(`Logged in to ${providerDef.name} as ${r.email || 'user'}.\n`);
      } catch (e) { warn(`OAuth login failed: ${e.message}\n`); }
    }
  } else if (providerDef.auth === 'oauth-device') {
    if (!(await confirm({ message: `Run OAuth device flow for ${providerDef.name} now?`, default: true }))) {
      nextConfig.apiKey = '';
    } else {
      try {
        let prompt;
        const r = await startGitHubCopilotAuth({ onPrompt: (p) => { prompt = p; } });
        if (prompt) {
          console.log();
          info('Open this URL to authorize:');
          info(`  ${chalk.cyan(prompt.verifyUrl)}`);
          info(`and enter code:  ${chalk.bold(prompt.userCode)}`);
        }
        success(`Logged in to ${providerDef.name} (scope: ${r.scope || 'copilot'}).\n`);
      } catch (e) { warn(`OAuth login failed: ${e.message}\n`); }
    }
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
  success(`Provider set to: ${providerDef.name} (${config.model})\n`);
}

async function editModel(config, provider, onProviderChange, onSystemPromptChange) {
  const providerDef = PROVIDERS[config.provider];
  const newModel = await chooseModelFromProvider(config.provider, providerDef, config);
  config.model = newModel;
  const newProvider = createProvider(config);
  saveConfig(config);
  onProviderChange(newProvider);
  const updated = buildSystemPrompt(config.trust || {}, config);
  onSystemPromptChange(updated);
  success(`Model set to: ${newModel}\n`);
}

async function editAuth() {
  console.log(chalk.white.bold('\n  Auth status\n'));
  const cdx = codexStatus();
  const cop = copilotStatus();
  console.log(`  Codex:    ${cdx.logged_in ? chalk.green('logged in') : chalk.gray('not logged in')}${cdx.email ? ` (${cdx.email})` : ''}`);
  console.log(`  Copilot:  ${cop.logged_in ? chalk.green('logged in') : chalk.gray('not logged in')}${cop.token_preview ? ` (${cop.token_preview})` : ''}`);
  console.log();
  const action = await select({
    message: 'Action:',
    choices: [
      { name: 'Login to Codex (OAuth browser flow)', value: 'login-codex' },
      { name: 'Login to GitHub Copilot (device flow)', value: 'login-copilot' },
      { name: 'Logout Codex', value: 'logout-codex' },
      { name: 'Logout Copilot', value: 'logout-copilot' },
      { name: 'Cancel', value: 'cancel' },
    ],
  });
  if (action === 'login-codex') {
    const spinner = createSpinner();
    spinner.start();
    try { const r = await codexLogin({ open: true }); spinner.stop(); success(`Logged in as ${r.email || 'user'}.\n`); }
    catch (e) { spinner.stop(); warn(`Login failed: ${e.message}\n`); }
  } else if (action === 'login-copilot') {
    info('Requesting device code from GitHub...');
    let prompt;
    try {
      const r = await startGitHubCopilotAuth({ onPrompt: (p) => { prompt = p; } });
      if (prompt) {
        console.log();
        info('Open this URL to authorize:');
        info(`  ${chalk.cyan(prompt.verifyUrl)}`);
        info(`and enter code:  ${chalk.bold(prompt.userCode)}`);
      }
      success(`Logged in to GitHub Copilot (scope: ${r.scope || 'copilot'}).\n`);
    } catch (e) { warn(`Login failed: ${e.message}\n`); }
  } else if (action === 'logout-codex') { codexLogout(); success('Logged out of Codex.\n'); }
  else if (action === 'logout-copilot') { copilotLogout(); success('Copilot token cleared.\n'); }
}

async function editToolCallMode(config, provider, trustConfig, onProviderChange, onSystemPromptChange) {
  const newMode = await select({
    message: 'Set tool calling mode:',
    choices: TOOL_CALL_MODE_CHOICES,
    default: config.toolCallMode || 'xml',
  });
  config.toolCallMode = newMode;
  if (provider) provider.toolCallMode = newMode;
  saveConfig(config);
  const updated = buildSystemPrompt(trustConfig, config);
  onSystemPromptChange(updated);
  success(`Tool calling mode set to: ${newMode}\n`);
}

async function editNum(key, label, config) {
  const v = await input({ message: `${label}:`, default: String(config[key] ?? ''), validate: v => /^-?\d+(\.\d+)?$/.test(v) || 'must be a number' });
  config[key] = Number(v);
  saveConfig(config);
  success(`${label} = ${v}\n`);
}

async function editStr(key, label, config, validate) {
  const v = await input({ message: `${label}:`, default: String(config[key] ?? ''), validate });
  config[key] = v;
  saveConfig(config);
  success(`${label} = ${v}\n`);
}

async function editBool(key, label, config) {
  const v = await confirm({ message: `${label}?`, default: !!config[key] });
  config[key] = v;
  saveConfig(config);
  success(`${label} = ${v}\n`);
}

async function editList(key, label, config, help) {
  const cur = (config[key] || []).join(', ');
  const v = await input({ message: `${label} (comma-separated)${help ? ' — ' + help : ''}:`, default: cur });
  const arr = v.split(',').map(s => s.trim()).filter(Boolean);
  config[key] = arr;
  saveConfig(config);
  success(`${label} = [${arr.join(', ')}]\n`);
}

async function editNet(field, config) {
  switch (field) {
    case 'timeout': await editNum('networkTimeoutMs', 'Network timeout (ms)', config); break;
    case 'maxbytes': await editNum('networkMaxBytes', 'Network max response bytes', config); break;
    case 'allow': await editList('networkAllowHosts', 'Allowed hosts (empty = all)', config, 'e.g. api.openai.com'); break;
    case 'deny': await editList('networkDenyHosts', 'Denied hosts', config, 'e.g. 169.254.169.254'); break;
    case 'search': await editStr('searchInstance', 'SearXNG base URL (empty = use auto backends)', config, () => true); break;
    case 'proxy': await editStr('proxy', 'Proxy URL (http://host:port, empty = no proxy)', config, () => true); break;
  }
}

async function editPath(field, config) {
  switch (field) {
    case 'outside': await editBool('allowOutsideWorkspace', 'Allow file access outside workspace', config); break;
    case 'dangerous': await editList('dangerousPaths', 'Dangerous path bypass', config, 'absolute paths the agent MAY touch (use carefully)'); break;
    case 'memory': await editStr('memoryFile', 'Memory file path (empty = ~/.creecode/memory.json)', config, () => true); break;
    case 'skills': await editStr('skillsDir', 'Skills dir path (empty = ~/.creecode/skills)', config, () => true); break;
  }
}

async function editCmd(field, config) {
  switch (field) {
    case 'timeout': await editNum('commandTimeoutMs', 'Command timeout (ms)', config); break;
    case 'maxout': await editNum('commandMaxOutputBytes', 'Command max output bytes', config); break;
  }
}

async function editGen(field, config) {
  switch (field) {
    case 'temperature': await editNum('temperature', 'Temperature (0.0 - 2.0)', config); break;
    case 'topp': await editNum('topP', 'Top-P (0.0 - 1.0)', config); break;
    case 'maxtokens': await editNum('maxTokens', 'Max output tokens', config); break;
  }
}

async function editSys(field, config) {
  switch (field) {
    case 'appendix': {
      const v = await input({ message: 'System prompt appendix (extra instructions for the agent):', default: config.systemPromptAppendix || '' });
      config.systemPromptAppendix = v;
      saveConfig(config);
      success('System prompt appendix updated.\n');
      break;
    }
    case 'historymax': await editNum('historyMaxMessages', 'Max history messages kept in session file', config); break;
    case 'autocompact': await editBool('autoCompactHistory', 'Auto-compact history when near the cap', config); break;
  }
}

async function editTools(field, config) {
  switch (field) {
    case 'disable': {
      const cur = (config.disabledTools || []).join(', ');
      const v = await input({ message: 'Disabled tools (comma-separated, empty = none):', default: cur });
      config.disabledTools = v.split(',').map(s => s.trim()).filter(Boolean);
      saveConfig(config);
      success(`Disabled ${config.disabledTools.length} tool(s).\n`);
      break;
    }
    case 'enable': {
      const cur = (config.enabledTools || []).join(', ');
      const v = await input({ message: 'Enabled-only tools (empty = all enabled):', default: cur });
      config.enabledTools = v ? v.split(',').map(s => s.trim()).filter(Boolean) : null;
      saveConfig(config);
      success(`Enabled-only list updated.\n`);
      break;
    }
  }
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
