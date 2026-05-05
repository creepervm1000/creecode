# Contributing to CreeCode

Thanks for your interest in contributing! This guide explains how to set up the project,
run it locally, and submit changes.

## Setup

```bash
git clone <your-fork-url>
cd creecode
npm install
node bin/creecode.js
```

## Project Layout

- `bin/` — CLI entry point
- `src/providers/` — LLM provider adapters (OpenAI, Anthropic, Gemini, Ollama, etc.)
- `src/tools/` — Tool implementations exposed to the model (files, shell, git, http, ...)
- `src/webui/` — Optional browser-based chat UI
- `scripts/` — Build / bundle scripts

## Workflow

1. Fork the repository on the CreeperNet Git instance.
2. Create a feature branch: `git checkout -b feat/my-change`.
3. Make focused commits with descriptive messages.
4. Run `node bin/creecode.js` and verify the change locally.
5. Open a pull request against `main` of the upstream repository.

## Commit Style

We loosely follow Conventional Commits:

- `feat:` — new user-facing feature
- `fix:` — bug fix
- `docs:` — documentation only
- `chore:` — tooling, deps, formatting
- `refactor:` — code change that does not alter behavior

## Adding a New Tool

1. Create `src/tools/<name>.js` exporting one or more handler functions.
2. Register the tool in `src/tools/index.js` inside `TOOL_DEFINITIONS`.
3. Document the tool in the README if it changes user-visible behavior.

## Adding a New Provider

1. Add `src/providers/<name>.js` extending `base.js`.
2. Wire it into `src/providers/index.js`.
3. Add the provider name to the onboarding prompt.

## Code Style

- ES modules, Node 20+
- 2-space indentation, single quotes, trailing commas where supported
- Keep handlers small and side-effect free where possible
