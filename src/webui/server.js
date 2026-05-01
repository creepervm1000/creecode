import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { success, info } from '../utils/logger.js';
import { buildToolsPrompt, parseToolCalls, executeTool } from '../tools/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_SYSTEM_PROMPT = `You are CreeCode, a helpful coding assistant running in the Web UI. You help users write, debug, and understand code. Be concise and precise. When showing code, use code blocks with the specified language, and do not forget to include Markdown in your message for styling. If the user needs to find vulnerabilities, only do so if the user has the script. Do not put any emojis in code comments.

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

export async function startWebUI(provider, config, port = 3000) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use(express.static(join(__dirname, 'public')));

    const trustConfig = config.trust || { commands: 'prompt-trust', files: 'prompt-trust' };
    const systemPrompt = BASE_SYSTEM_PROMPT + buildToolsPrompt(trustConfig, config);

    let messages = [{ role: 'system', content: systemPrompt }];

    app.post('/api/chat', async (req, res) => {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'Message is required' });

      const baselineLen = messages.length;
      messages.push({ role: 'user', content: message });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const send = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);

      try {
        let iteration = 0;
        while (iteration < MAX_ITERATIONS) {
          iteration++;
          let fullResponse = '';
          let rawResponse = '';
          try {
            rawResponse = await provider.streamChat(messages, (chunk) => {
              fullResponse ||= '';
              send({ chunk });
            });
            const normalized = normalizeAssistantResponse(rawResponse);
            fullResponse = normalized.text;
            if (!fullResponse && typeof rawResponse === 'string') {
              rawResponse = await provider.chat(messages);
              const chatNormalized = normalizeAssistantResponse(rawResponse);
              fullResponse = chatNormalized.text;
              send({ chunk: fullResponse });
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
            send({ notice: 'Model hallucinated a <tool_result> block. Injecting correction.' });
            messages.push({
              role: 'user',
              content: 'You wrote a <tool_result> block yourself. That tag is produced ONLY by the runtime, after you emit a <tool_call> and the runtime actually runs the tool. No tool was actually run. If you want to use a tool, emit <tool_call>...</tool_call> and STOP — wait for the real <tool_result> in the next message.',
            });
            continue;
          }

          if (toolCalls.length === 0) {
            send({ done: true });
            return res.end();
          }

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
      messages = [{ role: 'system', content: systemPrompt }];
      res.json({ ok: true });
    });

    app.get('/api/config', (req, res) => {
      res.json({ provider: config.provider, model: config.model, toolCallMode: config.toolCallMode || 'xml', toolsEnabled: true });
    });

    app.listen(port, () => {
      success(`Web UI running at http://localhost:${port}`);
      info('Tools enabled in Web UI (files, commands, etc.) — trust config applies.');
    }).on('error', reject);
  });
}
