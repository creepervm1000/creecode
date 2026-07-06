import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { success, info } from '../utils/logger.js';
import { buildToolsPrompt, buildToolModeSystemPrompt, parseToolCalls, executeTool } from '../tools/index.js';

const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 30;
const rateLimitStore = new Map();

function rateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip) || { count: 0, reset: now + RATE_LIMIT_WINDOW };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + RATE_LIMIT_WINDOW; }
  entry.count++;
  rateLimitStore.set(ip, entry);
  return entry.count > RATE_LIMIT_MAX;
}

function sanitizeJson(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) {
      return Object.assign({}, input);
    }
  }
  return input;
}

function authMiddleware(config) {
  const token = config.webuiAuthToken;
  if (!token) return (req, res, next) => next();
  return (req, res, next) => {
    const provided = req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
                     req.headers['x-auth-token'] ||
                     req.query?.token;
    if (!provided || provided !== token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_SYSTEM_PROMPT = `You are CreeCode, a helpful coding assistant running in the Web UI. You help users write, debug, and understand code. Be concise and precise. When showing code, use code blocks with the specified language, and do not forget to include Markdown in your message for styling. When the user asks you to audit, explore, review, or find vulnerabilities in the current project, inspect the workspace immediately with tools. Do not ask the user to paste code that is already available in the current folder. If the user needs to find vulnerabilities, only do so if the user has the script. Do not put any emojis in code comments.

Web UI mode has the SAME tool access as the CLI: you can read/write/edit files, run commands, search, and use the other tools. Trust prompts that would normally appear in the terminal are auto-resolved on the server according to the user's config; operations that are not permitted by config will return an error and you should report it.`;

const MAX_ITERATIONS = 20;

function normalizeAssistantResponse(response) {
  if (typeof response === 'string') {
    return {
      text: response,
      nativeToolCalls: [],
      assistantMessage: { role: 'assistant', content: response },
    };
  }

  return {
    text: response?.content || '',
    nativeToolCalls: response?.nativeToolCalls || [],
    assistantMessage: response?.assistantMessage || { role: 'assistant', content: response?.content || '' },
  };
}

function buildSystemPrompt(config, trustConfig) {
  return BASE_SYSTEM_PROMPT + buildToolModeSystemPrompt(config) + buildToolsPrompt(trustConfig, config);
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

/**
 * Strip tool_call XML from text so it never reaches the browser.
 */
function stripToolCallXml(text) {
  if (!text) return text;
  return text
    .replace(/<tool_call[^>]*>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/gi, '')
    .trim();
}

export async function startWebUI(provider, config, port = 3000) {
  return new Promise((resolve, reject) => {
    const app = express();

    const csrfToken = randomBytes(32).toString('hex');

    app.use((req, res, next) => {
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; form-action 'self'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('X-XSS-Protection', '0');
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      next();
    });

    app.use(express.json({ limit: '1mb' }));
    app.use(express.static(join(__dirname, 'public')));
    app.use(authMiddleware(config));

    const trustConfig = config.trust || { commands: 'prompt-trust', files: 'prompt-trust' };
    const systemPrompt = buildSystemPrompt(config, trustConfig);

    let messages = [{ role: 'system', content: systemPrompt }];

    app.get('/api/csrf', (req, res) => {
      res.json({ token: csrfToken });
    });

    app.post('/api/chat', async (req, res) => {
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      if (rateLimit(clientIp)) {
        return res.status(429).json({ error: 'Too many requests' });
      }

      const body = sanitizeJson(req.body);
      const { message } = body;
      if (!message) return res.status(400).json({ error: 'Message is required' });
      if (typeof message !== 'string' || message.length > 100000) {
        return res.status(400).json({ error: 'Message too long or invalid' });
      }

      const baselineLen = messages.length;
      messages.push({ role: 'user', content: message });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const send = (evt) => {
        if (res.destroyed) return;
        try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch {}
      };

      try {
        let iteration = 0;
        while (iteration < MAX_ITERATIONS) {
          iteration++;
          let fullResponse = '';
          let rawResponse = '';

          // Buffer the full response instead of streaming raw chunks
          try {
            rawResponse = await provider.streamChat(messages, (chunk) => {
              fullResponse ||= '';
              // Don't stream chunks to client — buffer to strip tool call XML
            });
            const normalized = normalizeAssistantResponse(rawResponse);
            fullResponse = normalized.text;
            if (!fullResponse && typeof rawResponse === 'string') {
              rawResponse = await provider.chat(messages);
              const chatNormalized = normalizeAssistantResponse(rawResponse);
              fullResponse = chatNormalized.text;
            }
          } catch (err) {
            if (messages.length > baselineLen) messages.length = baselineLen;
            else messages.pop();
            send({ error: err.message });
            return res.end();
          }

          const normalized = normalizeAssistantResponse(rawResponse);
          const parsed = parseToolCalls(normalized.text);
          const usingNativeToolCalls = normalized.nativeToolCalls.length > 0;
          const toolCalls = usingNativeToolCalls ? normalized.nativeToolCalls : parsed.toolCalls;
          const hallucinatedToolResult = parsed.hallucinatedToolResult;
          messages.push(normalized.assistantMessage);

          if (hallucinatedToolResult && toolCalls.length === 0) {
            send({ notice: 'Model hallucinated a tool_result. Injecting correction.' });
            messages.push({
              role: 'user',
              content: 'You wrote a <tool_result> block yourself. That tag is produced ONLY by the runtime, after you emit a ⛃ and the runtime actually runs the tool. No tool was actually run. If you want to use a tool, emit ⛃...⤴ and STOP — wait for the real <tool_result> in the next message.',
            });
            continue;
          }

          if (shouldInjectWorkspaceCorrection(messages, toolCalls, normalized.text)) {
            send({ notice: 'Model stalled instead of inspecting the workspace. Injecting correction.' });
            messages.push({
              role: 'user',
              content: '[runtime correction] The repository is already available in the current workspace. Do not ask the user to paste code or describe the project. Immediately inspect the project using tools and continue the audit. Start by reading or searching relevant files now.',
            });
            continue;
          }

          // Send clean text with tool call XML stripped
          const cleanText = stripToolCallXml(fullResponse);

          if (toolCalls.length === 0) {
            // Final response — no more tool calls
            if (cleanText) {
              send({ text: cleanText });
            }
            send({ done: true });
            return res.end();
          }

          // Has tool calls — send clean text first, then tool events
          if (cleanText) {
            send({ text: cleanText });
          }

          // Execute tools and send events
          const results = [];
          for (const tc of toolCalls) {
            send({ tool: { name: tc.name, args: tc.args, status: 'start' } });
            const result = await executeTool(tc, trustConfig, config);
            send({ tool: { name: tc.name, args: tc.args, status: result.error ? 'error' : 'ok', result } });
            results.push({ tool: tc.name, toolCallId: tc.id, result });
          }

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
        }

        send({ notice: `Agent reached ${MAX_ITERATIONS} iterations; stopping.` });
        const last = messages[messages.length - 1];
        if (last && last.role === 'assistant') {
          messages.push({
            role: 'user',
            content: '<tool_result name="__system__">\n{"interrupted": "agent reached maximum iterations — tool calls above were not executed"}\n</tool_result>',
          });
        }
        send({ done: true });
        res.end();
      } catch (err) {
        send({ error: err.message });
        res.end();
      }
    });

    app.post('/api/clear', (req, res) => {
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      if (rateLimit(clientIp)) return res.status(429).json({ error: 'Too many requests' });
      messages = [{ role: 'system', content: systemPrompt }];
      res.json({ ok: true });
    });

    app.get('/api/config', (req, res) => {
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      if (rateLimit(clientIp)) return res.status(429).json({ error: 'Too many requests' });
      res.json({ provider: config.provider, model: config.model, toolCallMode: config.toolCallMode || 'xml', toolsEnabled: true });
    });

    app.listen(port, () => {
      success(`Web UI running at http://localhost:${port}`);
      info('Tools enabled in Web UI (files, commands, etc.) — trust config applies.');
    }).on('error', reject);
  });
}
