import { readFile, writeFile, editFile, listDirectory } from './files.js';
import { runCommand } from './commands.js';
import { allowOutsideWorkspace, getWorkspaceRoot } from '../workspace.js';

/**
 * Tool definitions — used in the system prompt to tell the AI what's available.
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file',
    parameters: {
      path: { type: 'string', description: 'Absolute or relative path to the file', required: true },
    },
    category: 'files',
    handler: readFile,
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content',
    parameters: {
      path: { type: 'string', description: 'Absolute or relative path to the file', required: true },
      content: { type: 'string', description: 'The full content to write to the file', required: true },
    },
    category: 'files',
    handler: writeFile,
  },
  {
    name: 'edit_file',
    description: 'Edit a file by replacing specific text. Use this for targeted changes instead of rewriting the whole file.',
    parameters: {
      path: { type: 'string', description: 'Path to the file to edit', required: true },
      old_text: { type: 'string', description: 'The exact existing text to find and replace (must match exactly)', required: true },
      new_text: { type: 'string', description: 'The replacement text', required: true },
    },
    category: 'files',
    handler: editFile,
  },
  {
    name: 'list_directory',
    description: 'List all files and folders in a directory',
    parameters: {
      path: { type: 'string', description: 'Path to the directory (default: current directory)', required: false },
    },
    category: 'files',
    handler: listDirectory,
  },
  {
    name: 'run_command',
    description: 'Run a shell command and return the output. Use for installing packages, running tests, building projects, git operations, etc.',
    parameters: {
      command: { type: 'string', description: 'The shell command to execute', required: true },
      cwd: { type: 'string', description: 'Working directory (default: current directory)', required: false },
      timeout: { type: 'number', description: 'Timeout in ms (default: 30000)', required: false },
    },
    category: 'commands',
    handler: runCommand,
  },
];

/**
 * Build the tools section of the system prompt.
 */
export function buildToolsPrompt(trustConfig, config = {}) {
  const workspaceRoot = getWorkspaceRoot();
  const workspaceNote = allowOutsideWorkspace(config)
    ? `Outside-workspace access is enabled. Prefer staying in ${workspaceRoot} unless the task clearly requires leaving it.`
    : `All file paths and command working directories must stay inside ${workspaceRoot}.`;
  const availableTools = TOOL_DEFINITIONS.filter(t => {
    const level = trustConfig[t.category];
    return level !== 'no-trust';
  });

  if (availableTools.length === 0) {
    return '\nYou have no tool access. You can only provide text responses.';
  }

  let prompt = `\n## Available Tools\n\nWorkspace root: ${workspaceRoot}\n${workspaceNote}\n\nYou can use tools by including a tool call block in your response. Use this exact format:\n\n<tool_call>\n{"name": "tool_name", "args": {"param1": "value1"}}\n</tool_call>\n\nYou may include multiple tool calls in one response. Always explain what you're doing before calling a tool.\n\nAvailable tools:\n`;

  for (const tool of availableTools) {
    const params = Object.entries(tool.parameters)
      .map(([name, p]) => `    - ${name} (${p.type}${p.required ? ', required' : ', optional'}): ${p.description}`)
      .join('\n');
    prompt += `\n### ${tool.name}\n${tool.description}\nParameters:\n${params}\n`;
  }

  prompt += `\nIMPORTANT RULES:\n- Always read a file before editing it.\n- Use edit_file for small targeted changes, write_file for creating new files or full rewrites.\n- ${allowOutsideWorkspace(config) ? 'Outside-workspace access is allowed, but only use it when the task clearly requires it.' : 'All file paths and command working directories must stay inside the workspace root.'}\n- Explain your changes to the user.\n- If a command fails, analyze the error and try to fix it.\n- Do NOT hallucinate file contents — always read first.\n`;

  return prompt;
}

/**
 * Parse tool calls from the AI response.
 * Returns { text, toolCalls } where text is the response with tool calls removed.
 */
export function parseToolCalls(response) {
  const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const toolCalls = [];
  let match;

  while ((match = toolCallRegex.exec(response)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      toolCalls.push(parsed);
    } catch {
      // Skip malformed tool calls
    }
  }

  // Remove tool call blocks from visible text
  const text = response.replace(toolCallRegex, '').trim();
  return { text, toolCalls };
}

/**
 * Execute a single tool call.
 */
export async function executeTool(toolCall, trustConfig, config = {}) {
  const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolCall.name);
  if (!toolDef) {
    return { error: `Unknown tool: ${toolCall.name}` };
  }

  const trustLevel = trustConfig[toolDef.category] || 'prompt-trust';
  const args = toolCall.args || toolCall.arguments || {};
  return await toolDef.handler(args, trustLevel, config);
}
