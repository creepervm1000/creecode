import { readFile, writeFile, editFile, listDirectory } from './files.js';
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
import { getEnv } from './env.js';
import { allowOutsideWorkspace, getWorkspaceRoot } from '../workspace.js';

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
  { name: 'think', description: 'Private scratchpad — use to plan without calling a real tool', category: 'meta', handler: think,
    parameters: { thought: { type: 'string', required: true, description: 'Your reasoning' } } },
];

function isToolEnabled(tool, config) {
  const disabled = config.disabledTools || [];
  if (disabled.includes(tool.name)) return false;
  const enabled = config.enabledTools;
  if (Array.isArray(enabled) && enabled.length > 0 && !enabled.includes(tool.name)) return false;
  return true;
}

export function buildToolsPrompt(trustConfig, config = {}) {
  const workspaceRoot = getWorkspaceRoot();
  const workspaceNote = allowOutsideWorkspace(config)
    ? `Outside-workspace access is enabled. Prefer staying in ${workspaceRoot} unless the task clearly requires leaving it.`
    : `All file paths and command working directories must stay inside ${workspaceRoot}.`;
  const availableTools = TOOL_DEFINITIONS.filter(t => {
    const level = trustConfig[t.category];
    if (level === 'no-trust') return false;
    return isToolEnabled(t, config);
  });

  if (availableTools.length === 0) {
    return '\nYou have no tool access. You can only provide text responses.';
  }

  let prompt = `\n## Available Tools\n\nWorkspace root: ${workspaceRoot}\n${workspaceNote}\n\nYou can use tools by including a tool call block in your response. Use this exact format:\n\n<tool_call>\n{"name": "tool_name", "args": {"param1": "value1"}}\n</tool_call>\n\nYou may include multiple tool calls in one response. Always explain what you're doing before calling a tool.\n\n**CRITICAL — DO NOT HALLUCINATE TOOL RESULTS.** Never write a \`<tool_result>...</tool_result>\` block yourself. That tag is produced ONLY by the runtime, AFTER you emit a \`<tool_call>\` and the runtime actually runs the tool.\n\nAvailable tools:\n`;

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

export function parseToolCalls(response) {
  const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const toolResultRegex = /<tool_result(?:\s[^>]*)?>[\s\S]*?<\/tool_result>/g;
  const toolCalls = [];
  let match;
  while ((match = toolCallRegex.exec(response)) !== null) {
    try { toolCalls.push(JSON.parse(match[1])); } catch { /* skip */ }
  }
  const hallucinatedToolResult = toolResultRegex.test(response);
  toolResultRegex.lastIndex = 0;
  const text = response.replace(toolCallRegex, '').replace(toolResultRegex, '').trim();
  return { text, toolCalls, hallucinatedToolResult };
}

export async function executeTool(toolCall, trustConfig, config = {}) {
  const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolCall.name);
  if (!toolDef) return { error: `Unknown tool: ${toolCall.name}` };
  if (!isToolEnabled(toolDef, config)) return { error: `Tool disabled by config: ${toolDef.name}` };
  const trustLevel = trustConfig[toolDef.category] || 'prompt-trust';
  const args = toolCall.args || toolCall.arguments || {};
  return await toolDef.handler(args, trustLevel, config);
}
