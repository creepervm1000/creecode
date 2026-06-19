import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createProvider } from './providers/index.js';
import { buildToolsPrompt, buildToolModeSystemPrompt, parseToolCalls, executeTool } from './tools/index.js';
import { DEFAULT_CONFIG } from './config.js';

function loadConfigFile(configPath) {
  const resolved = configPath.startsWith('/') ? configPath : join(process.cwd(), configPath);
  if (!existsSync(resolved)) {
    console.error(`config file not found: ${resolved}`);
    console.error('copy config.example.json to config.json and fill in your values');
    process.exit(1);
  }
  const raw = readFileSync(resolved, 'utf-8');
  const config = JSON.parse(raw);
  if (!config.creechat?.token) {
    console.error('config is missing creechat.token');
    process.exit(1);
  }
  if (!config.creechat?.baseUrl) {
    console.error('config is missing creechat.baseUrl');
    process.exit(1);
  }
  return config;
}

const sessions = new Map();
const MAX_SESSION_MESSAGES = 200;
const MAX_TOOL_ITERATIONS = 25;

function getSessionMessages(conversationId) {
  if (!sessions.has(conversationId)) sessions.set(conversationId, []);
  return sessions.get(conversationId);
}

function pruneSession(conversationId) {
  const msgs = getSessionMessages(conversationId);
  if (msgs.length > MAX_SESSION_MESSAGES) {
    const pruned = msgs.slice(-MAX_SESSION_MESSAGES);
    while (pruned.length > 0 && pruned[0].role === 'user' && typeof pruned[0].content === 'string' && pruned[0].content.startsWith('<tool_result')) {
      pruned.shift();
    }
    sessions.set(conversationId, pruned);
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

const BASE_SYSTEM_PROMPT = `You are CreeCode, an expert AI coding assistant running as a CreeChat bot. You help users write, debug, understand, and refactor code. You have direct access to the file system and can run shell commands.

## Guidelines
- Be concise and precise.
- When showing code, use markdown code blocks with the language specified.
- Always read a file before editing it.
- Explain what you are about to do before using tools.
- If a command or edit fails, analyze the error and suggest fixes.
- For complex tasks, break them into steps.
- You are in CreeChat. Keep responses readable in plain text / markdown-like chat formatting.
- Each user message includes "[User: @username (ID: uuid)]" to identify the speaker.
- Don't make any kind of modifications without asking the user, unless they already told you to go ahead.
- Don't break the user's code, check what you are doing.
- If you are working on a production codebase, don't make any changes without asking the user and be VERY CAREFUL.

## CreeChat Context
- You are running inside a CreeChat conversation (DM or group).
- Bots are plaintext-only and only see plaintext, non-deleted messages.
- Do not expose CreeChat data outside the conversation.
- Keep replies reasonably short; split long replies when needed.
- Use search_creechat_users to find verified CreeChat users by username.
- Use get_creechat_user to inspect a specific CreeChat user by UUID.
- If this bot is configured as an AI agent, you may also use creechat_dm_user and the CreeChat block/unblock tools when appropriate.`;

function buildSystemPrompt(trustConfig, agentConfig) {
  return BASE_SYSTEM_PROMPT
    + buildToolModeSystemPrompt(agentConfig)
    + (agentConfig.systemPromptAppendix ? `\n\n${agentConfig.systemPromptAppendix}` : '')
    + buildToolsPrompt(trustConfig, agentConfig);
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
      pruneSession(agentConfig._sessionConversationId);
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

function creechatApiUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}${path}`;
}

async function creechatRequest(baseUrl, token, method, path, body) {
  const headers = { Authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(creechatApiUrl(baseUrl, path), init);
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!resp.ok) {
    const detail = data?.error || data?.message || text || `http ${resp.status}`;
    throw new Error(`creechat api error ${resp.status}: ${detail}`);
  }
  return data;
}

async function getBotInfo(baseUrl, token) {
  return await creechatRequest(baseUrl, token, 'GET', '/api/bot/me');
}

async function getConversations(baseUrl, token) {
  return await creechatRequest(baseUrl, token, 'GET', '/api/bot/conversations');
}

async function getUpdates(baseUrl, token, { offset = 0, timeout = 25, limit = 100 } = {}) {
  const qs = new URLSearchParams({
    offset: String(offset),
    timeout: String(Math.min(30, Math.max(0, timeout))),
    limit: String(limit),
    token,
  });
  return await creechatRequest(baseUrl, token, 'GET', `/api/bot/updates?${qs.toString()}`);
}

async function sendMessage(baseUrl, token, conversationId, text) {
  return await creechatRequest(baseUrl, token, 'POST', '/api/bot/sendMessage', { conversationId, text });
}

async function editMessage(baseUrl, token, messageId, text) {
  return await creechatRequest(baseUrl, token, 'POST', '/api/bot/editMessage', { messageId, text });
}

async function deleteMessage(baseUrl, token, messageId) {
  return await creechatRequest(baseUrl, token, 'POST', '/api/bot/deleteMessage', { messageId });
}

function splitCreeChatMessage(text, maxLen = 4000) {
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

function buildConversationIndex(conversations = []) {
  const byId = new Map();
  for (const conv of conversations) byId.set(conv.id, conv);
  return byId;
}

function shouldHandleConversation(ccConfig, conversation, update) {
  const allowedConversations = ccConfig.allowedConversations || [];
  const allowedGroups = ccConfig.allowedGroups || [];
  const allowedUsers = ccConfig.allowedUsers || [];

  if (allowedConversations.length > 0 && !allowedConversations.includes(conversation?.id)) return false;

  if (conversation?.type === 'group') {
    if (allowedGroups.length > 0 && !allowedGroups.includes(conversation.id)) return false;
    return ccConfig.listenAll === true;
  }

  if (conversation?.type === 'dm') {
    if (allowedUsers.length === 0) return true;
    return allowedUsers.includes(update.message.senderId) || allowedUsers.includes(update.senderUsername);
  }

  return true;
}

async function handleUpdate(baseUrl, token, update, conversationsById, ccConfig, agentConfig, provider, trustConfig) {
  const msg = update.message;
  if (!msg || msg.deletedAt || msg.e2e) return;
  const content = String(msg.body || '').trim();
  if (!content) return;

  const conversation = conversationsById.get(msg.conversationId) || null;
  if (!shouldHandleConversation(ccConfig, conversation, update)) return;

  const conversationId = msg.conversationId;
  const sessionMessages = getSessionMessages(conversationId);
  agentConfig._sessionConversationId = conversationId;
  agentConfig._creechatBaseUrl = baseUrl;
  agentConfig._creechatToken = token;
  agentConfig._creechatConversation = conversation;
  agentConfig._currentUser = {
    id: msg.senderId,
    username: update.senderUsername || null,
    conversationId,
  };

  const userLabel = update.senderUsername ? `@${update.senderUsername}` : `user_${msg.senderId}`;

  if (sessionMessages.length === 0) {
    sessionMessages.push({ role: 'system', content: buildSystemPrompt(trustConfig, agentConfig) });
  }

  sessionMessages.push({
    role: 'user',
    content: content + `\n\n[User: ${userLabel} (ID: ${msg.senderId})]`,
  });

  let statusMessageId = null;
  let toolCallCount = 0;

  try {
    const reply = await agentLoop(provider, sessionMessages, agentConfig, trustConfig, async (tc) => {
      toolCallCount++;
      const statusText = `running ${tc.name} (${toolCallCount})...`;
      try {
        if (statusMessageId) {
          await editMessage(baseUrl, token, statusMessageId, statusText);
        } else {
          const sent = await sendMessage(baseUrl, token, conversationId, statusText);
          statusMessageId = sent?.message?.id || sent?.id || null;
        }
      } catch {}
    });

    if (statusMessageId) {
      try { await deleteMessage(baseUrl, token, statusMessageId); } catch {}
    }

    const chunks = splitCreeChatMessage(reply);
    for (const chunk of chunks) {
      await sendMessage(baseUrl, token, conversationId, chunk);
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (err) {
    if (statusMessageId) {
      try { await deleteMessage(baseUrl, token, statusMessageId); } catch {}
    }
    try {
      await sendMessage(baseUrl, token, conversationId, `error: ${err.message}`);
    } catch (err2) {
      console.error('failed to send error message:', err2.message);
    }
  }
}

export async function startCreeChatBot(configPath = 'config.json') {
  console.log('creecode-creechat starting...\n');

  const fileConfig = loadConfigFile(configPath);
  const ccConfig = fileConfig.creechat || {};

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
  const token = ccConfig.token;
  const baseUrl = ccConfig.baseUrl;

  console.log(`provider: ${agentConfig.provider}`);
  console.log(`model: ${agentConfig.model || 'default'}`);
  console.log(`tool calling: ${agentConfig.toolCallMode}`);
  console.log(`creechat base url: ${baseUrl}`);
  console.log(`allowed conversations: ${(ccConfig.allowedConversations || []).join(', ') || 'all'}`);
  console.log(`allowed groups: ${(ccConfig.allowedGroups || []).join(', ') || 'all'}`);
  console.log(`allowed users: ${(ccConfig.allowedUsers || []).join(', ') || 'all dms'}`);
  console.log(`listen all groups: ${ccConfig.listenAll === true}`);
  console.log();

  let botInfo;
  try {
    botInfo = await getBotInfo(baseUrl, token);
    console.log(`logged in as @${botInfo.bot?.username || 'unknown'}`);
    console.log(`bot id: ${botInfo.bot?.id || 'unknown'}`);
  } catch (err) {
    console.error('failed to get bot info:', err.message);
    process.exit(1);
  }

  let updateOffset = Number(ccConfig.offset || 0);
  console.log('polling for updates...\n');

  const shutdown = async () => {
    console.log('\nshutting down...');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (true) {
    try {
      const convs = await getConversations(baseUrl, token);
      const conversationsById = buildConversationIndex(convs?.conversations || []);
      const res = await getUpdates(baseUrl, token, {
        offset: updateOffset,
        timeout: ccConfig.pollTimeout ?? 25,
        limit: ccConfig.pollLimit ?? 100,
      });
      const updates = res?.updates || [];

      for (const update of updates) {
        updateOffset = Math.max(updateOffset, Number(update.updateId || 0) + 1);
        handleUpdate(baseUrl, token, update, conversationsById, ccConfig, agentConfig, provider, trustConfig).catch(err => {
          console.error('update handler error:', err.message);
        });
      }

      if (updates.length === 0) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error('polling error:', err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}
