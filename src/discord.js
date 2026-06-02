import { Client, GatewayIntentBits, Partials } from 'discord.js';
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
  if (!config.discord?.token) {
    console.error('config is missing discord.token');
    process.exit(1);
  }
  return config;
}

// per-channel conversation sessions
const sessions = new Map();

const MAX_SESSION_MESSAGES = 200;
const MAX_TOOL_ITERATIONS = 25;

function getSessionKey(channelId, threadId) {
  return threadId || channelId;
}

function getSessionMessages(key) {
  if (!sessions.has(key)) sessions.set(key, []);
  return sessions.get(key);
}

function pruneSession(key) {
  const msgs = getSessionMessages(key);
  if (msgs.length > MAX_SESSION_MESSAGES) {
    const pruned = msgs.slice(-MAX_SESSION_MESSAGES);
    // drop leading orphan tool-results
    while (pruned.length > 0 && pruned[0].role === 'user' && typeof pruned[0].content === 'string' && pruned[0].content.startsWith('<tool_result')) {
      pruned.shift();
    }
    sessions.set(key, pruned);
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

const BASE_SYSTEM_PROMPT = `You are CreeCode, an expert AI coding assistant running in a Discord channel. You help users write, debug, understand, and refactor code. You have direct access to the file system and can run shell commands.

## Guidelines
- Be concise and precise.
- When showing code, use markdown code blocks with the language specified.
- Always read a file before editing it.
- Explain what you are about to do before using tools.
- If a command or edit fails, analyze the error and suggest fixes.
- For complex tasks, break them into steps.
- You are in a shared channel. Other users may see your responses. Be professional.
- Don't make any kind of modifications without asking the user, unless they already told you to go ahead.
- Don't break the user's code, check what you are doing.
- If you are working on a production codebase, don't make any changes without asking the user and be VERY CAREFUL.

## Discord Context
- Each message includes "[User: @username [role1, role2] (ID: 123456)]" to identify the speaker
- Use the get_discord_user tool to look up any Discord user by ID or mention (format: <@123456> or raw ID)
- You are in a server channel, not DMs`;

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

/**
 * check if an error is a context window / token limit error.
 * catches common patterns from openai, anthropic, openrouter, etc.
 */
function isContextWindowError(err) {
  const msg = (err.message || '').toLowerCase();
  return (
    /maximum.*context.*(length|size|exceeded)/i.test(msg) ||
    /token.*(limit|cap|maximum|exceeded|too.*many|too.*long)/i.test(msg) ||
    /context.*(length|size|limit|window).*(exceeded|too|overflow)/i.test(msg) ||
    /input.*(too.*large|too.*long|exceeds)/i.test(msg) ||
    /prompt.*(too.*large|too.*long|exceeds)/i.test(msg) ||
    /max_tokens.*exceed/i.test(msg) ||
    /model.*maximum.*context/i.test(msg) ||
    /reduce.*(amount|number).*messages/i.test(msg) ||
    msg.includes('400') && (msg.includes('token') || msg.includes('context') || msg.includes('input'))
  );
}

/**
 * convert a message array into a plain text transcript for summarization.
 */
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
    // truncate very long messages to keep the summary prompt manageable
    if (content.length > 1500) content = content.slice(0, 1500) + '...(truncated)';
    return `${role}: ${content}`;
  }).join('\n\n');
}

/**
 * ask the provider to summarize a chunk of conversation history.
 * returns the summary text, or a fallback marker if summarization fails.
 */
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
    // cap summary length to prevent it from being too large itself
    return text.length > 2000 ? text.slice(0, 2000) + '...(summary truncated)' : text;
  } catch (err) {
    console.error('context summary generation failed:', err.message);
    return '[older conversation was removed to fit the token limit. no summary available.]';
  }
}

/**
 * shorten the message array to fit within the context window.
 * keeps the system prompt (index 0), drops oldest non-system messages,
 * summarizes the dropped portion via a separate LLM call,
 * and inserts the summary so the model retains context.
 */
async function shortenMessages(provider, messages, agentConfig, keepSystemPrompt = true) {
  const systemIdx = keepSystemPrompt && messages.length > 0 && messages[0].role === 'system' ? 1 : 0;
  const nonSystem = messages.length - systemIdx;

  if (nonSystem <= 2) return false;

  // drop the oldest half of non-system messages
  const keepCount = Math.max(2, Math.ceil(nonSystem / 2));
  const dropped = messages.slice(systemIdx, systemIdx + (nonSystem - keepCount));
  const kept = messages.slice(systemIdx + (nonSystem - keepCount));

  // summarize the dropped messages
  console.error(`summarizing ${dropped.length} dropped messages...`);
  const summary = await summarizeMessages(provider, dropped, agentConfig);

  // rebuild: system prompt + summary marker + kept messages
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

/**
 * run a provider call with context window error recovery.
 * if the api returns a context length error, shortens history (with summary)
 * and retries up to 3 times.
 */
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
      pruneSession(getSessionKey(agentConfig._sessionKey, agentConfig._sessionThread));
      return normalized.text;
    }

    // execute tools
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

async function handleMessage(client, message, dcConfig, agentConfig, provider, trustConfig) {
  // ignore bots and DMs (only respond in allowed channels)
  if (message.author.bot) return;
  if (!message.guild) return;

  const allowedChannels = dcConfig.channels || [];
  const allowedServers = dcConfig.servers || [];

  if (allowedServers.length > 0 && !allowedServers.includes(message.guild.id)) return;
  if (allowedChannels.length > 0 && !allowedChannels.includes(message.channel.id)) return;

  // respond if mentioned, replied to, or channel is in "listen all" mode
  const isMentioned = message.mentions.has(client.user);
  const isReply = message.reference?.messageId && message.mentions.has(client.user);
  const listenAll = dcConfig.listenAll === true;
  if (!isMentioned && !isReply && !listenAll) return;

  // strip mention prefix
  let content = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
  if (!content) return;

  const isThread = message.channel.isThread === true;
  const sessionKey = getSessionKey(message.channel.id, isThread ? message.channel.id : null);
  agentConfig._sessionKey = message.channel.id;
  agentConfig._sessionThread = isThread ? message.channel.id : null;
  agentConfig._discordClient = client;
  agentConfig._currentUser = {
    id: message.author.id,
    username: message.author.username,
    globalName: message.author.globalName || null,
    discriminator: message.author.discriminator || '0',
    bot: message.author.bot,
    guildMember: message.member ? {
      nick: message.member.nickname,
      roles: message.member.roles.cache.map(r => r.name),
      joinedAt: message.member.joinedAt ? message.member.joinedAt.toISOString() : null,
    } : null,
  };

  const messages = getSessionMessages(sessionKey);
  if (messages.length === 0) {
    messages.push({ role: 'system', content: buildSystemPrompt(trustConfig, agentConfig) });
  }

  const roles = agentConfig._currentUser && agentConfig._currentUser.guildMember && agentConfig._currentUser.guildMember.roles && agentConfig._currentUser.guildMember.roles.length
    ? " [" + agentConfig._currentUser.guildMember.roles.join(", ") + "]"
    : "";
  const userLabel = agentConfig._currentUser ? "@" + (agentConfig._currentUser.globalName || agentConfig._currentUser.username) : "unknown";
  messages.push({ role: 'user', content: content + "\n\n[User: " + userLabel + roles + " (ID: " + (agentConfig._currentUser ? agentConfig._currentUser.id : "unknown") + ")]" });

  // send typing indicator immediately and every 5s until done
  message.channel.sendTyping().catch(() => {});
  const typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 5000);

  let statusMsg = null;
  const toolCallCount = { n: 0 };

  try {
    const reply = await agentLoop(provider, messages, agentConfig, trustConfig, async (tc, result) => {
      toolCallCount.n++;
      const statusText = `running \`${tc.name}\` (${toolCallCount.n})...`;
      if (statusMsg) {
        try {
          await statusMsg.edit(statusText);
        } catch {}
      } else {
        try {
          statusMsg = await message.reply(statusText);
        } catch {}
      }
    });

    clearInterval(typingInterval);

    // delete status message if we created one
    if (statusMsg) {
      try { await statusMsg.delete(); } catch {}
    }

    // discord message length limit is 2000 chars
    if (reply.length <= 2000) {
      await message.reply(reply);
    } else {
      const chunks = splitMessage(reply, 2000);
      for (const chunk of chunks) {
        await message.channel.send(chunk);
      }
    }
  } catch (err) {
    clearInterval(typingInterval);
    if (statusMsg) {
      try { await statusMsg.delete(); } catch {}
    }
    await message.reply(`error: ${err.message}`).catch(() => {
      message.channel.send(`error: ${err.message}`).catch(() => {});
    });
  }
}

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx < maxLength * 0.5) splitIdx = maxLength;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}

export async function startDiscordBot(configPath = 'config.json') {
  console.log('creecode-discord starting...\n');

  const fileConfig = loadConfigFile(configPath);
  const dcConfig = fileConfig.discord || {};

  // build agent config from file, merging with defaults
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
  console.log(`servers: ${(dcConfig.servers || []).join(', ') || 'all'}`);
  console.log(`channels: ${(dcConfig.channels || []).join(', ') || 'all'}`);
  console.log(`listen all: ${dcConfig.listenAll === true}`);
  console.log();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel],
  });

  client.on('ready', () => {
    console.log(`logged in as ${client.user.tag}`);
    console.log(`watching for mentions in configured channels\n`);
  });

  client.on('messageCreate', async (message) => {
    try {
      await handleMessage(client, message, dcConfig, agentConfig, provider, trustConfig);
    } catch (err) {
      console.error('message handler error:', err);
    }
  });

  client.on('error', (err) => {
    console.error('discord client error:', err);
  });

  process.on('SIGINT', () => {
    console.log('\nshutting down...');
    client.destroy();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    client.destroy();
    process.exit(0);
  });

  await client.login(dcConfig.token);
}
