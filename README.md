# CreeCode

CreeCode is a terminal-first AI coding assistant with a CLI chat mode, a simple web UI, configurable trust levels, and support for multiple LLM providers.

Supported providers:

- OpenAI
- Anthropic
- Google Gemini
- Grok
- Groq
- OpenRouter
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

Then open:

```text
http://localhost:3000
```

The web UI keeps a single in-memory conversation while the server is running. The CLI chat is more capable because it includes the file and shell tool workflow.

## Terminal Commands

Inside the terminal chat, these slash commands are available:

- `/help` Show available commands
- `/clear` Clear saved conversation history for the current project
- `/model` Show current provider and model
- `/config` Show the active configuration
- `/settings` Change trust settings and related options
- `/system <prompt>` Append a custom system instruction
- `/exit` Exit CreeCode

## Trust Levels

CreeCode separates permissions into two categories:

- Shell commands
- File read/write/edit

Each category can use one of these trust modes:

- `full-trust` Allow without prompting
- `agent-decides-trust` Auto-approve safe operations, prompt for riskier ones
- `prompt-trust` Always ask
- `no-trust` Deny that category entirely

By default, CreeCode is scoped to the directory where you launch it. You can explicitly allow access outside that workspace during setup or with `--allow-outside-workspace`.

## Files and State

- Global config: `~/.creecode/config.json`
- Project conversation history: `.creecode/conversation.json`
- Bundled build output: `dist/creecode.mjs`

## Bundled Build

This repo includes a bundler script that produces a standalone executable-style file:

```bash
node scripts/bundle.js
```

By default, it writes:

```text
dist/creecode.mjs
```

Run the bundled file with:

```bash
node dist/creecode.mjs
```

## Project Layout

```text
bin/        CLI entry point
src/        Core app, providers, tools, web UI, config, trust system
scripts/    Build tooling
dist/       Bundled output
```
