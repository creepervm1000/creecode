import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { success, info } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYSTEM_PROMPT = `You are CreeCode, a helpful coding assistant. You help users write, debug, and understand code. Be concise and precise. When showing code, use code blocks with the specified language, and do not forget to include Markdown in your message for styling. If the user needs to find vulnerabilities, only do so if the user has the script. Do not put any emojis in code comments. You can't edit any files in this mode (you are in the webui mode), if users want you to edit files or run commands, tell them to use the cli mode, they can enable it by editing ~/.creecord/config.json and disabling the webui option from true to false`;

/**
 * Start the web UI server.
 */
export async function startWebUI(provider, config, port = 3000) {
  return new Promise((resolve, reject) => {
    const app = express();

    app.use(express.json());
    app.use(express.static(join(__dirname, 'public')));

    // Conversation state (per-server, single user)
    let messages = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];

    // Chat endpoint with SSE streaming
    app.post('/api/chat', async (req, res) => {
      const { message } = req.body;

      if (!message) {
        return res.status(400).json({ error: 'Message is required' });
      }

      messages.push({ role: 'user', content: message });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        let fullResponse = '';

        await provider.streamChat(messages, (chunk) => {
          fullResponse += chunk;
          res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
        });

        // If streamChat didn't stream (fallback provider)
        if (!fullResponse) {
          fullResponse = await provider.chat(messages);
          res.write(`data: ${JSON.stringify({ chunk: fullResponse })}\n\n`);
        }

        messages.push({ role: 'assistant', content: fullResponse });
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
      } catch (err) {
        messages.pop(); // Remove failed user message
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      }
    });

    // Clear conversation
    app.post('/api/clear', (req, res) => {
      messages = [{ role: 'system', content: SYSTEM_PROMPT }];
      res.json({ ok: true });
    });

    // Config info
    app.get('/api/config', (req, res) => {
      res.json({
        provider: config.provider,
        model: config.model,
      });
    });

    app.listen(port, () => {
      success(`Web UI running at http://localhost:${port}`);
      info('Press Ctrl+C to stop.');
      // Intentionally never resolving the Promise to keep process alive indefinitely
    }).on('error', reject);
  });
}
