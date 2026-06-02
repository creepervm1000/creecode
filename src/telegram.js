import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProvider } from './providers/index.js';
import { buildToolsPrompt, buildToolModeSystemPrompt, parseToolCalls, executeTool } from './tools/index.js';
import { DEFAULT_CONFIG } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfigFile(configPath) {
  const resolved = configPath.startsWith('/') ? configPath : join(process.cwd(), configPath);
  if (!existsSync(resolved)) {
    console.error(`config file not found: ${resolved}`);
    console.error('copy config.example.json to config.json and fill in your values');
    process.exit(1);
  }
  const raw = readFileSync(resolved, 'utf-8');
  const config = JSON.parse(raw);
  if (!config.telegram?.token) {
    console.error('config is missing telegram.token');
    process.exit(1);
  }
  return config;
}

// per-chat conversation sessions
const sessions = new Map();

const MAX_SESSION_MESSAGES = 200;
const MAX_TOOL_ITERATIONS = 25;

function getSessionMessages(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, []);
  return sessions.get(chatId);
}

function pruneSession(chatId) {
  const msgs = getSessionMessages(chatId);
  if (msgs.length > MAX_SESSION_MESSAGES) {
    const pruned = msgs.slice(-MAX_SESSION_MESSAGES);
    while (pruned.length > 0 && pruned[0].role === 'user' && typeof pruned[0].content === 'string' && pruned[0].content.startsWith('<tool_result')) {
      pruned.shift();
    }
    sessions.set(chatId, pruned);
  }
}

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

const BASE_SYSTEM_PROMPT = `You are CreeCode, an expert AI coding assistant running as a Telegram bot. You help users write, debug, understand, and refactor code. You have direct access to the file system and can run shell commands.

## Guidelines
- Be concise and precise.
- When showing code, use markdown code blocks with the language specified.
- Always read a file before editing it.
- Explain what you are about to do before using tools.
- If a command or edit fails, analyze the error and suggest fixes.
- For complex tasks, break them into steps.
- Each message includes "[User: @username (ID: 12345)]" to identify the speaker.
- Use the get_telegram_user tool to look up any Telegram user by ID.
- Use the get_telegram_chat tool to look up chat/group info.
- Don't make any kind of modifications without asking the user, unless they already told you to go ahead.
- Don't break the user's code, check what you are doing.
- If you are working on a production codebase, don't make any changes without asking the user and be VERY CAREFUL.

## Telegram Context
- You are running inside a Telegram chat (could be a private DM or a group).
- Telegram messages have a 4096 character limit. Long responses will be split.
- Use Telegram Markdown or HTML formatting sparingly (the API strips unknown tags).`;

function buildSystemPrompt(trustConfig, agentConfig) {
  return BASE_SYSTEM_PROMPT
    + buildToolModeSystemPrompt(agentConfig)
    + (agentConfig.systemPromptAppendix ? `\n\n${agentConfig.systemPromptAppendix}` : '')
    + buildToolsPrompt(trustConfig, agentConfig);
}

function formatToolResult(toolName, result) {
  if (result.error) return `${toolName}: error - ${result.error}`;
  const str = JSON.stringify(result, null, 2);
  return str.length > 1500 ? str.slice(0, 1500) + '\n...(truncated)' : str;
}

function isContextWindowError(err) {
  const msg = (err.message || '').toLowerCase();
  return (
    /maximum.*context.*(length|size|exceeded)/i.test(msg) ||
    /token.*(limit|cap|maximum|exceeded|too.*many|too.*long)/i.test(msg) ||
    /context.*(length|size|limit|window).*(exceeded|too|overflow)/i.test(msg) ||
    /input.*(too.*large|too.*long|exceeds)/i.test(msg) ||
    /prompt.*(too.*large|too.*long|exceed)/i.test(msg) ||
    /max_tokens.*exceed/i.test(msg) ||
    /model.*maximum.*context/i.test(msg) ||
    /reduce.*(amount|number).*messages/i.test(msg) ||
    msg.includes('400') && (msg.includes('token') || msg.includes('context') || msg.includes('input'))
  );
}

function messagesToTranscript(msgs) {
  return msgs.map(m => {
    const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role;
    let content = '';
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content.map(c => c.text || JSON.stringify(c)).join(' ');
    }
    if (m.tool_calls) {
      content += '\n[tool calls: ' + m.tool_calls.map(tc => tc.function?.name || tc.name).join(', ') + ']';
    }
    if (m.role === 'tool') {
      content = content.length > 300 ? content.slice(0, 300) + '...(truncated)' : content;
    }
    if (content.length > 1500) content = content.slice(0, 1500) + '...(truncated)';
    return `${role}: ${content}`;
  }).join('\n\n');
}

async function summarizeMessages(provider, msgs, agentConfig) {
  const transcript = messagesToTranscript(msgs);
  const summaryPrompt = `You are being asked to summarize part of a conversation that was cut off due to context window limits.

Below is the conversation history that is being removed. Write a concise summary covering:
- What the user was working on or asking about
- Key files, code, or tools that were involved
- Any decisions, conclusions, or progress made
- The current state of the task (what was left to do next)

Keep it factual and brief. This summary will be injected so the conversation can continue smoothly.

---
${transcript}
---

Write the summary now:`;

  try {
    const result = await provider.streamChat([
      { role: 'system', content: 'You are a concise conversation summarizer. Write factual summaries. Do not add commentary or framing.' },
      { role: 'user', content: summaryPrompt },
    ], { onThinking: () => {}, onContent: () => {} });
    const text = typeof result === 'string' ? result : (result?.content || result?.text || '');
    return text.length > 2000 ? text.slice(0, 2000) + '...(summary truncated)' : text;
  } catch (err) {
    console.error('context summary generation failed:', err.message);
    return '[older conversation was removed to fit the token limit. no summary available.]';
  }
}

async function shortenMessages(provider, messages, agentConfig, keepSystemPrompt = true) {
  const systemIdx = keepSystemPrompt && messages.length > 0 && messages[0].role === 'system' ? 1 : 0;
  const nonSystem = messages.length - systemIdx;

  if (nonSystem <= 2) return false;

  const keepCount = Math.max(2, Math.ceil(nonSystem / 2));
  const dropped = messages.slice(systemIdx, systemIdx + (nonSystem - keepCount));
  const kept = messages.slice(systemIdx + (nonSystem - keepCount));

  console.error(`summarizing ${dropped.length} dropped messages...`);
  const summary = await summarizeMessages(provider, dropped, agentConfig);

  const shortened = keepSystemPrompt ? [messages[0]] : [];
  shortened.push(
    {
      role: 'user',
      content: `[context window shortened. here is a summary of the earlier part of the conversation that was removed:]\n\n${summary}\n\n[continue naturally from the remaining messages below.]`,
    },
    {
      role: 'assistant',
      content: 'understood, i have the context from the summary. continuing from where we left off.',
    },
  );
  shortened.push(...kept);

  messages.length = 0;
  messages.push(...shortened);
  return true;
}

async function callWithRetry(provider, messages, agentConfig, onChunk, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await provider.streamChat(messages, onChunk);
    } catch (err) {
      if (isContextWindowError(err) && attempt < maxRetries - 1) {
        console.error(`context window exceeded (attempt ${attempt + 1}/${maxRetries}), shortening history...`);
        const didShorten = await shortenMessages(provider, messages, agentConfig);
        if (!didShorten) throw err;
        continue;
      }
      throw err;
    }
  }
}

async function agentLoop(provider, messages, agentConfig, trustConfig, onToolCall) {
  let iteration = 0;
  const baselineLen = messages.length;

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;

    let rawResponse;
    try {
      rawResponse = await callWithRetry(provider, messages, agentConfig, {
        onThinking: () => {},
        onContent: () => {},
      });
    } catch (err) {
      if (messages.length > baselineLen) {
        messages.length = baselineLen;
      } else if (messages.length > 0) {
        messages.pop();
      }
      throw err;
    }

    const normalized = normalizeAssistantResponse(rawResponse);
    const parsed = parseToolCalls(normalized.text);
    const usingNative = normalized.nativeToolCalls.length > 0;
    const toolCalls = usingNative ? normalized.nativeToolCalls : parsed.toolCalls;
    const hallucinated = parsed.hallucinatedToolResult;
    messages.push(normalized.assistantMessage);

    if (hallucinated && toolCalls.length === 0) {
      messages.push({
        role: 'user',
        content: 'You wrote a <tool_result> block yourself. That tag is produced ONLY by the runtime. No tool was actually run. Emit a tool call and STOP.',
      });
      continue;
    }

    if (toolCalls.length === 0) {
      pruneSession(agentConfig._sessionChatId);
      return normalized.text;
    }

    const results = [];
    for (const tc of toolCalls) {
      const result = await executeTool(tc, trustConfig, agentConfig);
      if (onToolCall) onToolCall(tc, result);
      results.push({ tool: tc.name, toolCallId: tc.id, result });
    }

    if (usingNative) {
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
  }

  return normalizeAssistantResponse(messages[messages.length - 1] || { content: 'agent reached max iterations' }).text + '\n\n*(stopped: max tool iterations reached)*';
}

// --- Telegram Bot API helpers ---

function telegramApiUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function telegramRequest(token, method, body = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== null) {
      params.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  }
  const resp = await fetch(telegramApiUrl(token, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const data = await resp.json();
  if (!data.ok) {
    throw new Error(`telegram api error ${data.error_code}: ${data.description}`);
  }
  return data.result;
}

async function sendTelegramMessage(token, chatId, text, opts = {}) {
  try {
    await telegramRequest(token, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: opts.parseMode || undefined,
      disable_web_page_preview: true,
      ...opts,
    });
  } catch (err) {
    if (opts.parseMode) {
      await telegramRequest(token, 'sendMessage', {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      });
    } else {
      throw err;
    }
  }
}

async function sendTelegramChatAction(token, chatId, action) {
  try {
    await telegramRequest(token, 'sendChatAction', {
      chat_id: chatId,
      action,
    });
  } catch {}
}

function splitTelegramMessage(text, maxLen = 4096) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.5) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}

async function handleMessage(token, update, tgConfig, agentConfig, provider, trustConfig) {
  const message = update.message;
  if (!message) return;

  if (message.from?.is_bot) return;

  const chatId = message.chat.id;
  const allowedChats = tgConfig.allowedChats || [];

  if (allowedChats.length > 0 && !allowedChats.includes(String(chatId)) && !allowedChats.includes(chatId)) return;

  const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup';
  const botUsername = tgConfig.username ? `@${tgConfig.username.replace('@', '')}` : null;

  let content = message.text || message.caption || '';
  if (!content) return;

  if (isGroup && !tgConfig.listenAll) {
    if (botUsername) {
      const mentionPattern = new RegExp(`\\b${botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (!mentionPattern.test(content)) return;
      content = content.replace(mentionPattern, '').trim();
    }
  }

  if (!content.trim()) return;

  const sessionMessages = getSessionMessages(String(chatId));
  agentConfig._sessionChatId = String(chatId);
  agentConfig._telegramToken = token;

  const user = message.from;
  agentConfig._currentUser = {
    id: user.id,
    username: user.username || null,
    firstName: user.first_name || null,
    lastName: user.last_name || null,
    languageCode: user.language_code || null,
    isBot: user.is_bot || false,
  };

  const userLabel = user.username ? `@${user.username}` : (user.first_name || `user_${user.id}`);
  agentConfig._currentUser.label = userLabel;

  if (sessionMessages.length === 0) {
    sessionMessages.push({ role: 'system', content: buildSystemPrompt(trustConfig, agentConfig) });
  }

  sessionMessages.push({
    role: 'user',
    content: content + `\n\n[User: ${userLabel} (ID: ${user.id})]`,
  });

  sendTelegramChatAction(token, chatId, 'typing').catch(() => {});
  const typingInterval = setInterval(() => sendTelegramChatAction(token, chatId, 'typing').catch(() => {}), 5000);

  const toolCallCount = { n: 0 };
  let statusMsgId = null;

  try {
    const reply = await agentLoop(provider, sessionMessages, agentConfig, trustConfig, async (tc, result) => {
      toolCallCount.n++;
      const statusText = `running \`${tc.name}\` (${toolCallCount.n})...`;
      try {
        if (statusMsgId) {
          await telegramRequest(token, 'deleteMessage', { chat_id: chatId, message_id: statusMsgId });
        }
        const sent = await telegramRequest(token, 'sendMessage', {
          chat_id: chatId,
          text: statusText,
        });
        statusMsgId = sent.message_id;
      } catch {}
    });

    clearInterval(typingInterval);

    if (statusMsgId) {
      try { await telegramRequest(token, 'deleteMessage', { chat_id: chatId, message_id: statusMsgId }); } catch {}
    }

    const chunks = splitTelegramMessage(reply);
    for (const chunk of chunks) {
      await sendTelegramMessage(token, chatId, chunk);
    }
  } catch (err) {
    clearInterval(typingInterval);
    if (statusMsgId) {
      try { await telegramRequest(token, 'deleteMessage', { chat_id: chatId, message_id: statusMsgId }); } catch {}
    }
    try {
      await sendTelegramMessage(token, chatId, `error: ${err.message}`);
    } catch (err2) {
      console.error('failed to send error message:', err2.message);
    }
  }
}

export async function startTelegramBot(configPath = 'config.json') {
  console.log('creecode-telegram starting...\n');

  const fileConfig = loadConfigFile(configPath);
  const tgConfig = fileConfig.telegram || {};

  const providerConfig = fileConfig.provider || {};
  const agentConfig = {
    ...DEFAULT_CONFIG,
    provider: providerConfig.name || 'openai',
    apiKey: providerConfig.apiKey || '',
    model: providerConfig.model || '',
    baseUrl: providerConfig.baseUrl || '',
    toolCallMode: fileConfig.toolCallMode || 'xml',
    trust: {
      ...DEFAULT_CONFIG.trust,
      ...(fileConfig.trust || {}),
    },
    temperature: fileConfig.temperature ?? 0.2,
    maxTokens: fileConfig.maxTokens ?? 4096,
    allowOutsideWorkspace: fileConfig.allowOutsideWorkspace === true,
    disabledTools: fileConfig.disabledTools || [],
    systemPromptAppendix: fileConfig.systemPromptAppendix || '',
  };

  let provider;
  try {
    provider = createProvider(agentConfig);
  } catch (err) {
    console.error('failed to create provider:', err.message);
    process.exit(1);
  }

  const trustConfig = agentConfig.trust;

  console.log(`provider: ${agentConfig.provider}`);
  console.log(`model: ${agentConfig.model || 'default'}`);
  console.log(`tool calling: ${agentConfig.toolCallMode}`);
  console.log(`allowed chats: ${(tgConfig.allowedChats || []).join(', ') || 'all'}`);
  console.log(`listen all: ${tgConfig.listenAll === true}`);
  console.log();

  const token = tgConfig.token;

  let botInfo;
  try {
    botInfo = await telegramRequest(token, 'getMe');
    console.log(`logged in as @${botInfo.username} (${botInfo.first_name})`);
    console.log(`bot id: ${botInfo.id}`);
    tgConfig.username = botInfo.username;
  } catch (err) {
    console.error('failed to get bot info:', err.message);
    process.exit(1);
  }

  // delete webhook so we can use long polling
  try {
    await telegramRequest(token, 'deleteWebhook', { drop_pending_updates: false });
  } catch {}

  let updateOffset = 0;
  console.log('polling for updates...\n');

  const shutdown = async () => {
    console.log('\nshutting down...');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // long polling loop
  while (true) {
    try {
      const updates = await telegramRequest(token, 'getUpdates', {
        offset: updateOffset,
        timeout: 30,
        allowed_updates: '["message"]',
      });

      for (const update of updates) {
        updateOffset = update.update_id + 1;

        if (update.message) {
          handleMessage(token, update, tgConfig, agentConfig, provider, trustConfig).catch(err => {
            console.error('message handler error:', err.message);
          });
        }

        if (update.message?.text === '/start') {
          await sendTelegramMessage(token, update.message.chat.id,
            'creecode-telegram is running. send me a message and i\'ll help you with code.\n\n' +
            'in groups, mention me with @' + botInfo.username + ' to get my attention.'
          );
        }

        if (update.message?.text === '/clear') {
          sessions.delete(String(update.message.chat.id));
          await sendTelegramMessage(token, update.message.chat.id, 'conversation cleared.');
        }
      }
    } catch (err) {
      console.error('polling error:', err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}
