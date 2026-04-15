import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkTrust } from '../trust.js';
import { resolveWorkspacePath } from '../workspace.js';

/**
 * File tools for the coding agent.
 */

export async function readFile(args, trustLevel, policy = {}) {
  const pathResult = resolveWorkspacePath(args.path, policy);
  if (pathResult.error) return { error: pathResult.error };
  const filePath = pathResult.resolvedPath;
  const allowed = await checkTrust('files', trustLevel, `Read file: ${filePath}`, true);
  if (!allowed) return { error: 'Permission denied' };

  try {
    if (!existsSync(filePath)) {
      return { error: `File not found: ${filePath}` };
    }
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    return {
      path: filePath,
      content,
      lines: lines.length,
      size: statSync(filePath).size,
    };
  } catch (err) {
    return { error: `Failed to read file: ${err.message}` };
  }
}

export async function writeFile(args, trustLevel, policy = {}) {
  const pathResult = resolveWorkspacePath(args.path, policy);
  if (pathResult.error) return { error: pathResult.error };
  const filePath = pathResult.resolvedPath;
  const isNew = !existsSync(filePath);
  const desc = isNew ? `Create file: ${filePath}` : `Overwrite file: ${filePath}`;
  const isSafe = isNew; // Creating new files is generally safer than overwriting

  const allowed = await checkTrust('files', trustLevel, desc, isSafe);
  if (!allowed) return { error: 'Permission denied' };

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, args.content, 'utf-8');
    return {
      path: filePath,
      status: isNew ? 'created' : 'overwritten',
      size: args.content.length,
    };
  } catch (err) {
    return { error: `Failed to write file: ${err.message}` };
  }
}

export async function editFile(args, trustLevel, policy = {}) {
  const pathResult = resolveWorkspacePath(args.path, policy);
  if (pathResult.error) return { error: pathResult.error };
  const filePath = pathResult.resolvedPath;
  const allowed = await checkTrust('files', trustLevel, `Edit file: ${filePath}\n    Replace: "${truncate(args.old_text, 60)}"\n    With:    "${truncate(args.new_text, 60)}"`, false);
  if (!allowed) return { error: 'Permission denied' };

  try {
    if (!existsSync(filePath)) {
      return { error: `File not found: ${filePath}` };
    }
    let content = readFileSync(filePath, 'utf-8');
    if (!content.includes(args.old_text)) {
      return { error: 'Target text not found in file. Make sure old_text matches exactly.' };
    }
    content = content.replace(args.old_text, args.new_text);
    writeFileSync(filePath, content, 'utf-8');
    return {
      path: filePath,
      status: 'edited',
    };
  } catch (err) {
    return { error: `Failed to edit file: ${err.message}` };
  }
}

export async function listDirectory(args, trustLevel, policy = {}) {
  const pathResult = resolveWorkspacePath(args.path || '.', policy);
  if (pathResult.error) return { error: pathResult.error };
  const dirPath = pathResult.resolvedPath;
  const allowed = await checkTrust('files', trustLevel, `List directory: ${dirPath}`, true);
  if (!allowed) return { error: 'Permission denied' };

  try {
    if (!existsSync(dirPath)) {
      return { error: `Directory not found: ${dirPath}` };
    }
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const items = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
    }));
    return { path: dirPath, entries: items };
  } catch (err) {
    return { error: `Failed to list directory: ${err.message}` };
  }
}

function truncate(str, max) {
  if (!str) return '';
  const single = str.replace(/\n/g, '\\n');
  return single.length > max ? single.slice(0, max) + '...' : single;
}
