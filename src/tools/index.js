import { safeJsonParse } from '../utils/safe_json.js';
import { readFile, writeFile, editFile, listDirectory, readFileLines, fileHash, diffFiles, findReplace } from './files.js';
import { runCommand } from './commands.js';
import { grepText, globFiles, fileStat } from './search.js';
import { moveFile, copyFile, deleteFile, makeDirectory } from './fs_ops.js';
import { httpRequest, httpDownload } from './http.js';
import { gitCommand } from './git.js';
import { listProcesses, killProcess } from './process.js';
import { applyPatch } from './patch.js';
import { addNote, listNotes, clearNotes } from './notes.js';
import { jsonQuery } from './json_tool.js';
import { think } from './think.js';
import { addTodo, listTodos, updateTodo, deleteTodo, clearTodos } from './todo.js';
import { getEnv } from './env.js';
import { getDiscordUserInfo } from './discord_info.js';
import { getTelegramUserInfo, getTelegramChatInfo } from './telegram_info.js';
import { searchCreeChatUsers, getCreeChatUser, creechatDmUser, creechatBlockUser, creechatUnblockUser, listCreeChatBlocks } from './creechat_info.js';
import { webSearch, webFetch, webExtractLinks, webExtractMeta } from './web.js';
import { base64Encode, base64Decode, hashText, urlEncode, urlDecode, jsonFormat, jsonValidate, uuidGenerate, randomString, jwtDecode, regexTest } from './text.js';
import { csvParse, csvRead, yamlRead, tomlRead } from './data.js';
import { currentTime, cronNext } from './time.js';
import { osInfo, projectTree, diskUsage } from './system.js';
import { memoryList, memoryGet, memoryAdd, memoryAppend, memoryEdit, memoryClearLine, memoryRemove, memoryClear, memorySearch } from './memory.js';
import { discoverSkills, skillToToolDef, initSkillDir, runSkill } from './skills.js';
import { spawnSubagent, listSubagents, subagentStatus, decideSubagentApproval, killSubagent } from './subagent_tools.js';
import { allowOutsideWorkspace, getWorkspaceRoot } from '../workspace.js';

// Re-exports for downstream modules (subagent.js, chat.js) so they don't need
// to import from internal tool files directly.
export { discoverSkills, skillToToolDef, initSkillDir, runSkill };
export { spawnSubagent, listSubagents, subagentStatus, decideSubagentApproval, killSubagent };
export { normalizeAssistantResponse } from '../utils/normalize.js';

// Runtime-registered tools (skills, etc.) — added at session start, removed
// at session end. Static tool defs are in TOOL_DEFINITIONS below.
const RUNTIME_TOOLS = new Map();

export function registerRuntimeTool(toolDef) {
  RUNTIME_TOOLS.set(toolDef.name, toolDef);
}

export function unregisterRuntimeTool(name) {
  RUNTIME_TOOLS.delete(name);
}

export function clearRuntimeTools() {
  RUNTIME_TOOLS.clear();
}

export function getRuntimeTools() {
  return Array.from(RUNTIME_TOOLS.values());
}

function getAllToolDefs() {
  return [...TOOL_DEFINITIONS, ...RUNTIME_TOOLS.values()];
}

export const TOOL_DEFINITIONS = [
  { name: 'read_file', description: 'Read the contents of a file', category: 'files', handler: readFile,
    parameters: { path: { type: 'string', description: 'Path to file', required: true } } },
  { name: 'write_file', description: 'Create or overwrite a file', category: 'files', handler: writeFile,
    parameters: { path: { type: 'string', description: 'Path', required: true }, content: { type: 'string', description: 'Full content', required: true } } },
  { name: 'edit_file', description: 'Find/replace exact text in a file', category: 'files', handler: editFile,
    parameters: { path: { type: 'string', required: true, description: 'Path' }, old_text: { type: 'string', required: true, description: 'Exact text to replace (must be unique unless replace_all=true)' }, new_text: { type: 'string', required: true, description: 'Replacement' }, replace_all: { type: 'boolean', required: false, description: 'Replace every occurrence instead of erroring when ambiguous' } } },
  { name: 'apply_patch', description: 'Apply a unified diff patch to a file', category: 'files', handler: applyPatch,
    parameters: { path: { type: 'string', required: true, description: 'Path' }, diff: { type: 'string', required: true, description: 'Unified diff body' } } },
  { name: 'list_directory', description: 'List files and folders in a directory', category: 'files', handler: listDirectory,
    parameters: { path: { type: 'string', required: false, description: 'Directory (default: .)' } } },
  { name: 'glob_files', description: 'Find files matching a glob (**, *, ?)', category: 'files', handler: globFiles,
    parameters: { pattern: { type: 'string', required: true, description: 'Glob, e.g. src/**/*.js' }, path: { type: 'string', required: false, description: 'Base path' }, limit: { type: 'number', required: false, description: 'Max results' } } },
  { name: 'grep_text', description: 'Regex search across files in a path', category: 'files', handler: grepText,
    parameters: { pattern: { type: 'string', required: true, description: 'Regex pattern' }, path: { type: 'string', required: false, description: 'Base path' }, file_glob: { type: 'string', required: false, description: 'Limit to files matching glob' }, ignore_case: { type: 'boolean', required: false, description: 'Case-insensitive' }, max_matches: { type: 'number', required: false, description: 'Cap results' } } },
  { name: 'file_stat', description: 'Get file size/type/mtime', category: 'files', handler: fileStat,
    parameters: { path: { type: 'string', required: true, description: 'Path' } } },
  { name: 'move_file', description: 'Rename/move a file', category: 'files', handler: moveFile,
    parameters: { from: { type: 'string', required: true, description: 'Source' }, to: { type: 'string', required: true, description: 'Destination' } } },
  { name: 'copy_file', description: 'Copy a file', category: 'files', handler: copyFile,
    parameters: { from: { type: 'string', required: true, description: 'Source' }, to: { type: 'string', required: true, description: 'Destination' } } },
  { name: 'delete_file', description: 'Delete a file or directory (recursive)', category: 'files', handler: deleteFile,
    parameters: { path: { type: 'string', required: true, description: 'Path' } } },
  { name: 'make_directory', description: 'Create a directory (recursive)', category: 'files', handler: makeDirectory,
    parameters: { path: { type: 'string', required: true, description: 'Path' } } },
  { name: 'json_query', description: 'Read a JSON file and return a dot/bracket path from it', category: 'files', handler: jsonQuery,
    parameters: { path: { type: 'string', required: true, description: 'JSON file' }, query: { type: 'string', required: false, description: 'e.g. .a.b[0].c' } } },
  { name: 'run_command', description: 'Run a shell command', category: 'commands', handler: runCommand,
    parameters: { command: { type: 'string', required: true, description: 'Command' }, cwd: { type: 'string', required: false, description: 'Working dir' }, timeout: { type: 'number', required: false, description: 'ms' } } },
  { name: 'git', description: 'Run a git subcommand (status, diff, log, commit, branch, ...)', category: 'git', handler: gitCommand,
    parameters: { subcommand: { type: 'string', required: true, description: 'e.g. status, diff, log' }, args: { type: 'array', required: false, description: 'Extra args array' } } },
  { name: 'list_processes', description: 'List processes (ps -eo)', category: 'process', handler: listProcesses, parameters: {} },
  { name: 'kill_process', description: 'Send a signal to a pid', category: 'process', handler: killProcess,
    parameters: { pid: { type: 'number', required: true, description: 'PID' }, signal: { type: 'string', required: false, description: 'e.g. SIGTERM' } } },
  { name: 'get_env', description: 'Read environment variables (secrets filtered)', category: 'process', handler: getEnv,
    parameters: { name: { type: 'string', required: false, description: 'Single var name, or omit for all' } } },
  { name: 'http_request', description: 'Make an HTTP request (respects networkAllow/DenyHosts)', category: 'network', handler: httpRequest,
    parameters: { url: { type: 'string', required: true, description: 'URL' }, method: { type: 'string', required: false, description: 'GET/POST/...' }, headers: { type: 'object', required: false, description: 'Header map' }, body: { type: 'string', required: false, description: 'Request body' }, timeout: { type: 'number', required: false, description: 'ms' } } },
  { name: 'http_download', description: 'Download a URL to a workspace path', category: 'network', handler: httpDownload,
    parameters: { url: { type: 'string', required: true, description: 'URL' }, path: { type: 'string', required: true, description: 'Destination path' } } },
  { name: 'add_note', description: 'Append a scratchpad note to .creecode/notes.json', category: 'notes', handler: addNote,
    parameters: { text: { type: 'string', required: true, description: 'Note text' }, tag: { type: 'string', required: false, description: 'Optional tag' } } },
  { name: 'list_notes', description: 'List all saved notes', category: 'notes', handler: listNotes, parameters: {} },
  { name: 'clear_notes', description: 'Clear all notes', category: 'notes', handler: clearNotes, parameters: {} },
  { name: 'add_todo', description: 'Add a todo item to .creecode/todo.json', category: 'notes', handler: addTodo,
    parameters: { text: { type: 'string', required: true, description: 'Task description' }, priority: { type: 'string', required: false, description: 'Optional priority (e.g. high, medium, low)' }, tag: { type: 'string', required: false, description: 'Optional tag for grouping' }, insert_before_id: { type: 'number', required: false, description: 'Insert before this todo id' }, insert_after_id: { type: 'number', required: false, description: 'Insert after this todo id' } } },
  { name: 'list_todos', description: 'List todo items (filter by status or tag)', category: 'notes', handler: listTodos,
    parameters: { filter: { type: 'string', required: false, description: '"all", "pending", or "done" (default: all)' }, tag: { type: 'string', required: false, description: 'Filter by tag' } } },
  { name: 'update_todo', description: 'Update a todo (mark done, change text/priority/tag)', category: 'notes', handler: updateTodo,
    parameters: { id: { type: 'number', required: true, description: 'Todo id' }, done: { type: 'boolean', required: false, description: 'Mark as done or undone' }, text: { type: 'string', required: false, description: 'New text' }, priority: { type: 'string', required: false, description: 'New priority' }, tag: { type: 'string', required: false, description: 'New tag' } } },
  { name: 'delete_todo', description: 'Delete a single todo item', category: 'notes', handler: deleteTodo,
    parameters: { id: { type: 'number', required: true, description: 'Todo id' } } },
  { name: 'clear_todos', description: 'Clear todos (all, or only completed)', category: 'notes', handler: clearTodos,
    parameters: { filter: { type: 'string', required: false, description: '"all" or "done" (default: all)' } } },
  { name: 'think', description: 'Private scratchpad — use to plan without calling a real tool', category: 'meta', handler: think,
    parameters: { thought: { type: "string", required: true, description: "Your reasoning" } } },
  { name: "get_discord_user", description: "Look up a Discord user by ID or mention (e.g. <@123456>)", category: "discord", handler: getDiscordUserInfo,
    parameters: { userId: { type: "string", description: "User ID (123456) or mention (<@123456>)", required: true } } },
  { name: "get_telegram_user", description: "Look up a Telegram user by ID", category: "telegram", handler: getTelegramUserInfo,
    parameters: { userId: { type: "string", description: "Telegram user ID (numeric)", required: true } } },
  { name: "get_telegram_chat", description: "Look up a Telegram chat/group info by ID", category: "telegram", handler: getTelegramChatInfo,
    parameters: { chatId: { type: "string", description: "Telegram chat ID (numeric)", required: true } } },
  { name: "search_creechat_users", description: "Search CreeChat verified users by username query", category: "network", handler: searchCreeChatUsers,
    parameters: { query: { type: "string", description: "Username search string", required: true } } },
  { name: "get_creechat_user", description: "Get public CreeChat user info by user ID", category: "network", handler: getCreeChatUser,
    parameters: { userId: { type: "string", description: "CreeChat user UUID", required: true } } },
  { name: "creechat_dm_user", description: "Proactively send a DM to a CreeChat user (AI-agent bots only)", category: "network", handler: creechatDmUser,
    parameters: { userId: { type: "string", description: "Target CreeChat user UUID", required: true }, text: { type: "string", description: "Message text", required: true } } },
  { name: "creechat_block_user", description: "Block a CreeChat user (AI-agent bots only)", category: "network", handler: creechatBlockUser,
    parameters: { userId: { type: "string", description: "Target CreeChat user UUID", required: true } } },
  { name: "creechat_unblock_user", description: "Unblock a CreeChat user (AI-agent bots only)", category: "network", handler: creechatUnblockUser,
    parameters: { userId: { type: "string", description: "Target CreeChat user UUID", required: true } } },
  { name: "list_creechat_blocks", description: "List CreeChat users blocked by the bot (AI-agent bots only)", category: "network", handler: listCreeChatBlocks,
    parameters: {} },
  { name: 'web_search', description: 'Search the web via pluggable backends (auto falls through: searxng -> ddg -> bing -> wikipedia)', category: 'web', handler: webSearch,
    parameters: { query: { type: 'string', required: true, description: 'Search query' }, limit: { type: 'number', required: false, description: 'Max results (1-50, default 10)' }, backend: { type: 'string', required: false, description: '"auto" (default) | "wikipedia" | "ddg" | "bing" | "searxng"' } } },
  { name: 'web_fetch', description: 'Fetch a URL and convert HTML to readable text or markdown', category: 'web', handler: webFetch,
    parameters: { url: { type: 'string', required: true, description: 'URL to fetch' }, format: { type: 'string', required: false, description: '"text", "markdown", or "html" (default text)' }, timeout: { type: 'number', required: false, description: 'Timeout in ms' }, max_bytes: { type: 'number', required: false, description: 'Cap response size' } } },
  { name: 'web_extract_links', description: 'Fetch a URL and extract all <a href> links (internal/external)', category: 'web', handler: webExtractLinks,
    parameters: { url: { type: 'string', required: true, description: 'URL' }, timeout: { type: 'number', required: false, description: 'Timeout in ms' } } },
  { name: 'web_extract_meta', description: 'Fetch a URL and extract <title>, meta description, og:* / twitter:* tags, canonical, lang, headings', category: 'web', handler: webExtractMeta,
    parameters: { url: { type: 'string', required: true, description: 'URL' }, timeout: { type: 'number', required: false, description: 'Timeout in ms' } } },
  { name: 'base64_encode', description: 'Base64 / base64url encode a string', category: 'text', handler: base64Encode,
    parameters: { input: { type: 'string', required: true, description: 'String to encode' }, input_encoding: { type: 'string', required: false, description: 'utf-8 | latin1 | hex (default utf-8)' }, url_safe: { type: 'boolean', required: false, description: 'Use base64url alphabet' } } },
  { name: 'base64_decode', description: 'Base64 / base64url decode to a string', category: 'text', handler: base64Decode,
    parameters: { input: { type: 'string', required: true, description: 'String to decode' }, output_encoding: { type: 'string', required: false, description: 'utf-8 | latin1 | hex | base64 (default utf-8)' }, url_safe: { type: 'boolean', required: false, description: 'Treat input as base64url' } } },
  { name: 'hash_text', description: 'Hash a string (md5, sha1, sha224, sha256, sha384, sha512)', category: 'text', handler: hashText,
    parameters: { input: { type: 'string', required: true, description: 'String to hash' }, algorithm: { type: 'string', required: false, description: 'Hash algo (default sha256)' }, encoding: { type: 'string', required: false, description: 'Input encoding: utf-8 | latin1 | hex (default utf-8)' } } },
  { name: 'url_encode', description: 'Percent-encode a string (URI or URI-component)', category: 'text', handler: urlEncode,
    parameters: { input: { type: 'string', required: true, description: 'String to encode' }, component: { type: 'boolean', required: false, description: 'true=encodeURIComponent, false=encodeURI (default true)' } } },
  { name: 'url_decode', description: 'Percent-decode a string (URI or URI-component)', category: 'text', handler: urlDecode,
    parameters: { input: { type: 'string', required: true, description: 'String to decode' }, component: { type: 'boolean', required: false, description: 'true=decodeURIComponent, false=decodeURI (default true)' } } },
  { name: 'json_format', description: 'Pretty-print JSON (or report invalid)', category: 'text', handler: jsonFormat,
    parameters: { input: { type: 'string', required: true, description: 'JSON string' }, indent: { type: 'number', required: false, description: 'Indent spaces (default 2)' } } },
  { name: 'json_validate', description: 'Validate a JSON string and report type/shape', category: 'text', handler: jsonValidate,
    parameters: { input: { type: 'string', required: true, description: 'JSON string' } } },
  { name: 'uuid', description: 'Generate a random UUID v4 (RFC 4122)', category: 'text', handler: uuidGenerate, parameters: {} },
  { name: 'random_string', description: 'Generate a random string from a chosen alphabet', category: 'text', handler: randomString,
    parameters: { length: { type: 'number', required: false, description: 'Length (1-1024, default 16)' }, alphabet: { type: 'string', required: false, description: 'alphanumeric | alpha | numeric | hex | base64 | base64url' } } },
  { name: 'jwt_decode', description: 'Decode a JWT header/payload/signature (no signature verification)', category: 'text', handler: jwtDecode,
    parameters: { token: { type: 'string', required: true, description: 'JWT' } } },
  { name: 'regex_test', description: 'Test a regex against an input string; returns matches and groups', category: 'text', handler: regexTest,
    parameters: { pattern: { type: 'string', required: true, description: 'Regex pattern' }, input: { type: 'string', required: true, description: 'String to test' }, flags: { type: 'string', required: false, description: 'Regex flags (default none)' } } },
  { name: 'csv_parse', description: 'Parse a CSV string into records', category: 'data', handler: csvParse,
    parameters: { input: { type: 'string', required: true, description: 'CSV text' }, delimiter: { type: 'string', required: false, description: 'Field delimiter (default ",")' }, has_header: { type: 'boolean', required: false, description: 'Treat first row as header (default true)' }, infer_types: { type: 'boolean', required: false, description: 'Coerce numbers/booleans/null' } } },
  { name: 'csv_read', description: 'Read a workspace CSV file into records', category: 'data', handler: csvRead,
    parameters: { path: { type: 'string', required: true, description: 'Workspace path' }, delimiter: { type: 'string', required: false, description: 'Field delimiter' }, has_header: { type: 'boolean', required: false, description: 'Treat first row as header (default true)' }, infer_types: { type: 'boolean', required: false, description: 'Coerce numbers/booleans/null' } } },
  { name: 'yaml_read', description: 'Read a workspace YAML file (flat / shallow nested)', category: 'data', handler: yamlRead,
    parameters: { path: { type: 'string', required: true, description: 'Workspace path to .yaml/.yml' } } },
  { name: 'toml_read', description: 'Read a workspace TOML file (sections + flat key=value)', category: 'data', handler: tomlRead,
    parameters: { path: { type: 'string', required: true, description: 'Workspace path to .toml' } } },
  { name: 'current_time', description: 'Get the current time in a given timezone (default UTC)', category: 'time', handler: currentTime,
    parameters: { timezone: { type: 'string', required: false, description: 'IANA tz name (default UTC)' }, now: { type: 'string', required: false, description: 'ISO timestamp to format (default now)' } } },
  { name: 'cron_next', description: 'Calculate the next N runs of a 5-field cron expression (UTC)', category: 'time', handler: cronNext,
    parameters: { expression: { type: 'string', required: true, description: 'Cron expression (minute hour day month weekday)' }, count: { type: 'number', required: false, description: 'How many future runs (1-100, default 5)' }, now: { type: 'string', required: false, description: 'ISO timestamp to compute from (default now)' } } },
  { name: 'os_info', description: 'Report host, kernel, node, CPUs, memory, NICs, workspace root', category: 'system', handler: osInfo, parameters: {} },
  { name: 'project_tree', description: 'Render a directory tree (skipping .git/node_modules/dist/...)', category: 'system', handler: projectTree,
    parameters: { path: { type: 'string', required: false, description: 'Root path (default workspace root)' }, max_depth: { type: 'number', required: false, description: 'Max depth (default 5)' }, ignore: { type: 'array', required: false, description: 'Additional names to ignore' } } },
  { name: 'disk_usage', description: 'Total file/dir/byte count under a path', category: 'system', handler: diskUsage,
    parameters: { path: { type: 'string', required: false, description: 'Root path (default workspace root)' } } },
  { name: 'read_file_lines', description: 'Read a specific line range from a file', category: 'files', handler: readFileLines,
    parameters: { path: { type: 'string', required: true, description: 'Workspace path' }, start: { type: 'number', required: false, description: '1-based start line (default 1)' }, end: { type: 'number', required: false, description: '1-based end line (default: end of file)' } } },
  { name: 'file_hash', description: 'Hash a workspace file (md5/sha1/sha256/...)', category: 'files', handler: fileHash,
    parameters: { path: { type: 'string', required: true, description: 'Workspace path' }, algorithm: { type: 'string', required: false, description: 'md5 | sha1 | sha256 | sha384 | sha512 (default sha256)' } } },
  { name: 'diff_files', description: 'Unified diff between two workspace files', category: 'files', handler: diffFiles,
    parameters: { path_a: { type: 'string', required: true, description: 'First path' }, path_b: { type: 'string', required: true, description: 'Second path' } } },
  { name: 'find_replace', description: 'Regex find-and-replace across files under a path', category: 'files', handler: findReplace,
    parameters: { pattern: { type: 'string', required: true, description: 'Regex pattern' }, replacement: { type: 'string', required: true, description: 'Replacement string ($1, $2, ... supported)' }, path: { type: 'string', required: false, description: 'Root path (default workspace root)' }, file_glob: { type: 'string', required: false, description: 'Restrict to files matching this glob' }, flags: { type: 'string', required: false, description: 'Regex flags (default "g")' }, dry_run: { type: 'boolean', required: false, description: 'If true, do not write changes' } } },
  { name: 'memory_list', description: 'List global memory entries (~/.creecode/memory.json)', category: 'memory', handler: memoryList,
    parameters: { tag: { type: 'string', required: false, description: 'Filter by tag' }, search: { type: 'string', required: false, description: 'Regex search across text and tag' }, case_insensitive: { type: 'boolean', required: false, description: 'Case-insensitive search (default false)' } } },
  { name: 'memory_get', description: 'Fetch a single global memory entry by id', category: 'memory', handler: memoryGet,
    parameters: { id: { type: 'number', required: true, description: 'Entry id' } } },
  { name: 'memory_add', description: 'Add a new global memory entry', category: 'memory', handler: memoryAdd,
    parameters: { text: { type: 'string', required: true, description: 'Memory text' }, tag: { type: 'string', required: false, description: 'Optional tag (e.g. "preference", "convention")' } } },
  { name: 'memory_append', description: 'Append text to an existing memory entry (newline-separated)', category: 'memory', handler: memoryAppend,
    parameters: { id: { type: 'number', required: true, description: 'Entry id' }, text: { type: 'string', required: true, description: 'Text to append' } } },
  { name: 'memory_edit', description: 'Replace the text (and optionally tag) of a memory entry', category: 'memory', handler: memoryEdit,
    parameters: { id: { type: 'number', required: true, description: 'Entry id' }, text: { type: 'string', required: true, description: 'New text' }, tag: { type: 'string', required: false, description: 'New tag (pass empty string to clear)' } } },
  { name: 'memory_clear_line', description: 'Remove a specific 1-based line from a multi-line memory entry', category: 'memory', handler: memoryClearLine,
    parameters: { id: { type: 'number', required: true, description: 'Entry id' }, line: { type: 'number', required: true, description: '1-based line number to remove' } } },
  { name: 'memory_remove', description: 'Delete a memory entry by id', category: 'memory', handler: memoryRemove,
    parameters: { id: { type: 'number', required: true, description: 'Entry id' } } },
  { name: 'memory_clear', description: 'Wipe all memory entries, or all with a given tag', category: 'memory', handler: memoryClear,
    parameters: { tag: { type: 'string', required: false, description: 'If set, only clear entries with this tag' } } },
  { name: 'memory_search', description: 'Regex search across global memory entries', category: 'memory', handler: memorySearch,
    parameters: { pattern: { type: 'string', required: true, description: 'Regex pattern' }, case_insensitive: { type: 'boolean', required: false, description: 'Case-insensitive (default false)' } } },
  { name: 'spawn_subagent', description: 'Spawn a subagent to work on a task in the background. Subagent tool calls in prompt-trust categories route back here for approval.', category: 'subagents', handler: spawnSubagent,
    parameters: { task: { type: 'string', required: true, description: 'What the subagent should do' }, name: { type: 'string', required: false, description: 'Optional display name' }, system_prompt: { type: 'string', required: false, description: 'Optional override system prompt' } } },
  { name: 'list_subagents', description: 'List all subagents and their status', category: 'subagents', handler: listSubagents, parameters: {} },
  { name: 'subagent_status', description: 'Get status, summary, and message count of a subagent', category: 'subagents', handler: subagentStatus,
    parameters: { id: { type: 'string', required: true, description: 'Subagent id' } } },
  { name: 'decide_subagent_approval', description: 'Approve or deny a pending subagent tool-call approval request', category: 'subagents', handler: decideSubagentApproval,
    parameters: { request_id: { type: 'string', required: true, description: 'Approval request id' }, action: { type: 'string', required: true, description: '"approve" or "deny"' }, reason: { type: 'string', required: false, description: 'Optional reason' } } },
  { name: 'kill_subagent', description: 'Terminate a running subagent', category: 'subagents', handler: killSubagent,
    parameters: { id: { type: 'string', required: true, description: 'Subagent id' } } },
];

const TOOL_CALL_MODE_DESCRIPTIONS = {
  xml: 'Use XML-style <tool_call> blocks in model output.',
  native: 'Use provider-native tool calling when supported; otherwise fall back to XML tool blocks.',
  both: 'Allow either provider-native tool calling or XML <tool_call> blocks.',
};

export function buildToolModeSystemPrompt(config = {}) {
  const toolCallMode = config.toolCallMode || 'xml';

  if (toolCallMode === 'native') {
    return `\n## Tool Calling Behavior\n- Prefer provider-native tool calling whenever it is available.\n- Do not print XML <tool_call> blocks unless native tool calling is unavailable or fails.\n- Never fabricate tool results in plain text.\n`;
  }

  if (toolCallMode === 'both') {
    return `\n## Tool Calling Behavior\n- Prefer provider-native tool calling when available.\n- If native tool calling is unavailable or unreliable, fall back to XML <tool_call> blocks.\n- Never fabricate tool results in plain text.\n`;
  }

  return `\n## Tool Calling Behavior\n- Use XML <tool_call> blocks for tool use.\n- Do not rely on provider-native tool calling.\n- Never fabricate tool results in plain text.\n`;
}

function isToolEnabled(tool, config) {
  const disabled = config.disabledTools || [];
  if (disabled.includes(tool.name)) return false;
  const enabled = config.enabledTools;
  if (Array.isArray(enabled) && enabled.length > 0 && !enabled.includes(tool.name)) return false;
  return true;
}

export function buildToolsPrompt(trustConfig, config = {}) {
  const workspaceRoot = getWorkspaceRoot();
  const toolCallMode = config.toolCallMode || 'xml';
  const workspaceNote = allowOutsideWorkspace(config)
    ? `Outside-workspace access is enabled. Prefer staying in ${workspaceRoot} unless the task clearly requires leaving it.`
    : `All file paths and command working directories must stay inside ${workspaceRoot}.`;
  const availableTools = getAllToolDefs().filter(t => {
    const level = trustConfig[t.category];
    if (level === 'no-trust') return false;
    return isToolEnabled(t, config);
  });

  if (availableTools.length === 0) {
    return '\nYou have no tool access. You can only provide text responses.';
  }

  let prompt = `\n## Available Tools\n\nWorkspace root: ${workspaceRoot}\n${workspaceNote}\nTool calling mode: ${toolCallMode} — ${TOOL_CALL_MODE_DESCRIPTIONS[toolCallMode] || TOOL_CALL_MODE_DESCRIPTIONS.xml}\n\n`;

  if (toolCallMode === 'xml') {
    prompt += `Use tools by including a tool call block in your response. Use this exact format:\n\n<tool_call>\n{"name": "tool_name", "args": {"param1": "value1"}}\n</tool_call>\n\n`;
  } else if (toolCallMode === 'native') {
    prompt += `If the provider supports native tool calling, call tools natively instead of printing fake results. If native tool calling is unavailable, fall back to this XML format:\n\n<tool_call>\n{"name": "tool_name", "args": {"param1": "value1"}}\n</tool_call>\n\n`;
  } else {
    prompt += `You may use either provider-native tool calling or this XML fallback format:\n\n<tool_call>\n{"name": "tool_name", "args": {"param1": "value1"}}\n</tool_call>\n\n`;
  }

  prompt += `You may include multiple tool calls in one response. Always explain what you're doing before calling a tool.\n\n**CRITICAL — DO NOT HALLUCINATE TOOL RESULTS.** Never write a \`<tool_result>...</tool_result>\` block yourself. That tag is produced ONLY by the runtime, AFTER you emit a tool call and the runtime actually runs the tool.\n\nAvailable tools:\n`;

  const byCat = {};
  for (const tool of availableTools) (byCat[tool.category] ||= []).push(tool);
  for (const [cat, tools] of Object.entries(byCat)) {
    prompt += `\n### Category: ${cat}\n`;
    for (const tool of tools) {
      const params = Object.entries(tool.parameters || {})
        .map(([name, p]) => `    - ${name} (${p.type}${p.required ? ', required' : ', optional'}): ${p.description}`)
        .join('\n');
      prompt += `\n**${tool.name}** — ${tool.description}\n${params ? 'Parameters:\n' + params + '\n' : ''}`;
    }
  }

  prompt += `\nIMPORTANT RULES:\n- Read a file before editing it.\n- Prefer edit_file / apply_patch for targeted edits over write_file.\n- ${allowOutsideWorkspace(config) ? 'Outside-workspace access is allowed, but only when required.' : 'Stay inside the workspace root.'}\n- Explain your changes.\n- Do NOT fabricate tool_result blocks.\n`;

  if (config.systemPromptAppendix) {
    prompt += `\n## User-provided system prompt appendix\n${config.systemPromptAppendix}\n`;
  }
  return prompt;
}

export function buildNativeToolDefinitions() {
  return TOOL_DEFINITIONS.map(tool => {
    const properties = {};
    const required = [];

    for (const [name, param] of Object.entries(tool.parameters || {})) {
      let type = param.type;
      if (type === 'number') type = 'number';
      else if (type === 'boolean') type = 'boolean';
      else if (type === 'object') type = 'object';
      else if (type === 'array') type = 'array';
      else type = 'string';

      properties[name] = {
        type,
        description: param.description,
      };
      if (param.required) required.push(name);
    }

    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties,
          additionalProperties: false,
          ...(required.length > 0 ? { required } : {}),
        },
      },
    };
  });
}

export function parseToolCalls(response) {
  const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const trailingToolCallRegex = /<tool_call>\s*([\s\S]*?)\s*$/;
  const toolResultRegex = /<tool_result(?:\s[^>]*)?>[\s\S]*?<\/tool_result>/g;
  const toolCalls = [];
  let match;
  while ((match = toolCallRegex.exec(response)) !== null) {
    try { toolCalls.push(safeJsonParse(match[1])); } catch { /* skip */ }
  }
  let trailingToolCallText = null;
  if (toolCalls.length === 0) {
    const trailingMatch = response.match(trailingToolCallRegex);
    if (trailingMatch) {
      try {
        const parsed = safeJsonParse(trailingMatch[1]);
        toolCalls.push(parsed);
        trailingToolCallText = trailingMatch[0];
      } catch {
        // Ignore incomplete or malformed trailing tool calls.
      }
    }
  }
  const hallucinatedToolResult = toolResultRegex.test(response);
  toolResultRegex.lastIndex = 0;
  const text = response
    .replace(toolCallRegex, '')
    .replace(toolResultRegex, '')
    .replace(trailingToolCallText || '', '')
    .trim();
  return { text, toolCalls, hallucinatedToolResult };
}

export async function executeTool(toolCall, trustConfig, config = {}) {
  const toolDef = RUNTIME_TOOLS.get(toolCall.name) || TOOL_DEFINITIONS.find(t => t.name === toolCall.name);
  if (!toolDef) return { error: `Unknown tool: ${toolCall.name}` };
  if (!isToolEnabled(toolDef, config)) return { error: `Tool disabled by config: ${toolDef.name}` };
  const trustLevel = trustConfig[toolDef.category] || 'prompt-trust';
  const args = toolCall.args
    || toolCall.arguments
    || Object.fromEntries(
      Object.entries(toolCall).filter(([key]) => !['name', 'id', 'type'].includes(key))
    );
  return await toolDef.handler(args, trustLevel, config);
}
