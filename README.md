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
