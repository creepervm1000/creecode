# CreeCode

CreeCode is a terminal-first AI coding assistant with a CLI chat mode, a simple web UI, configurable trust levels, and support for multiple LLM providers.

Supported providers:

- OpenAI
- Anthropic
- Google Gemini
- Grok
- Groq
- OpenRouter
- Kilo Gateway
- Ollama
- HuggingFace
- Custom OpenAI-compatible APIs
- Custom Anthropic-compatible APIs

## What It Does

- Runs an interactive coding chat in your terminal
- Lets the model read files, edit files, list directories, and run shell commands
- Prompts for permission based on your trust settings
- Can launch a browser-based chat UI
- Saves provider settings in `~/.creecode/config.json`
- Saves per-project conversation history in `.creecode/conversation.json`

## Requirements

- Node.js 20 or newer
- An API key for your chosen provider, unless you use Ollama locally

Install dependencies before running CreeCode from source in a fresh checkout.

## Quick Start

Run from source:

```bash
node bin/creecode.js
```

On first launch, CreeCode opens an interactive setup wizard. It asks for:

- Provider
- API key
- Base URL
- Model
- Optional proxy
- Trust levels for commands and file access
- Whether to allow access outside the current workspace
- Whether to use the web UI by default

You can re-run setup any time with:

```bash
node bin/creecode.js --setup
```

## CLI Usage

```bash
node bin/creecode.js [options]
```

Available options:

- `--setup` Run the setup wizard
- `--provider <provider>` Override the saved provider
- `--model <model>` Override the saved model
- `--proxy <url>` Use an HTTP or SOCKS proxy
- `--base-url <url>` Use a custom API endpoint
- `--allow-outside-workspace` Allow file and command access outside the launch directory
- `--webui` Launch the web UI instead of terminal chat
- `--port <number>` Set the web UI port, default `3000`

Example:

```bash
node bin/creecode.js --provider openai --model gpt-4o
```

## Web UI

Start the web UI with:

```bash
node bin/creecode.js --webui --port 3000
```

Then open http://localhost:3000 in your browser.

## Configuration

The configuration file is stored at `~/.creecode/config.json` and contains:

- `provider` — The default LLM provider
- `model` — Default model name
- `apiKey` — Provider API key (keep private)
- `baseUrl` — Optional custom endpoint
- `proxy` — Optional HTTP / SOCKS proxy URL
- `trust` — Trust levels for `commands` and `files` (`prompt`, `safe`, `all`)
- `allowOutsideWorkspace` — Whether tools may touch paths outside the launch directory
- `useWebui` — Whether to launch the web UI by default

You can edit this file by hand or re-run `node bin/creecode.js --setup`.

## Conversation History

Per-project conversation history is stored in `.creecode/conversation.json` inside the workspace.
Delete the file to start a fresh session.

## Troubleshooting

- **`Permission denied` for a tool call** — raise the trust level in setup, or run with
  `--allow-outside-workspace` if the path is outside your workspace.
- **`429` from the provider** — your API key is rate-limited; try again later or switch provider
  with `--provider`.
- **Web UI shows a blank page** — clear the browser cache and confirm the port is not blocked.

## License

See the upstream repository for license details.
