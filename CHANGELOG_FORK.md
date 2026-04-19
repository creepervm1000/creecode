# creecode fork — claudeopus4.7-browseruse

Added on top of upstream:

## New tools (13)
- `apply_patch` — apply unified diff to a file
- `glob_files` — glob-match files (`**`, `*`, `?`)
- `grep_text` — regex search across files with file-glob filter
- `file_stat` — size/type/mtime
- `move_file`, `copy_file`, `delete_file`, `make_directory`
- `json_query` — read JSON with dot/bracket path
- `git` — any git subcommand with read-only auto-approve
- `http_request`, `http_download` — net with allow/deny hosts
- `list_processes`, `kill_process`, `get_env` — process + env (secrets filtered)
- `add_note`, `list_notes`, `clear_notes` — persistent scratchpad in `.creecode/notes.json`
- `think` — private scratchpad tool for planning

## New trust categories
`network`, `git`, `process`, `notes`, `meta` — in addition to `files`, `commands`.
Trust config moved under a `trust` object with sensible defaults.

## New settings (config.json)
- Model: `temperature`, `maxTokens`, `topP`, `systemPromptAppendix`
- Loop: `maxIterations`, `historyMaxMessages`, `autoCompactHistory`
- Command: `commandTimeoutMs`, `commandMaxOutputBytes`
- Network: `networkTimeoutMs`, `networkMaxBytes`, `networkAllowHosts`, `networkDenyHosts`
- Tool gating: `disabledTools`, `enabledTools` (whitelist)
- UI: `theme`, `logLevel`, `telemetry`, `editor`
- Web UI: `webui`, `webuiPort`, `webuiHost`, `webuiAuthToken`
- Safety: `envDenyKeys`, `notesFile`
- Trust (per category) under `trust.*`

All settings are documented inline in `src/config.js` (`DEFAULT_CONFIG`).
