import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getWorkspaceRoot } from '../workspace.js';
import chalk from 'chalk';

// ── layout config ──────────────────────────────────────────────
const MIN_WIDTH = 100;
const PANEL_WIDTH = 26;
const SEP_WIDTH = 1;

// ── data helpers ────────────────────────────────────────────────

function todoPath(config) {
  return config?.todoFile || join(getWorkspaceRoot(), '.creecode', 'todo.json');
}

function loadTodos(config) {
  const p = todoPath(config);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return []; }
}

function tw() { return process.stdout.columns || 80; }
function th() { return process.stdout.rows || 24; }

// ── panel builder ──────────────────────────────────────────────

function buildPanel(config) {
  const todos = loadTodos(config);
  const pending = todos.filter(t => !t.done);
  if (pending.length === 0) return null;

  const lines = [];

  // title
  lines.push(chalk.bold.cyan(' TASKS') + ' ' + chalk.dim(`(${pending.length})`));

  // top separator
  lines.push(chalk.dim('\u2500'.repeat(PANEL_WIDTH)));

  // task rows
  const maxRows = Math.min(pending.length, 20, th() - 6);
  for (let i = 0; i < maxRows; i++) {
    const t = pending[i];
    let text = t.text || '';
    const maxLen = PANEL_WIDTH - 5;
    if (text.length > maxLen) text = text.slice(0, maxLen - 1) + '\u2026';

    const dot = t.priority === 'high' ? chalk.red('\u25cf')
               : t.priority === 'medium' ? chalk.yellow('\u25cf')
               : chalk.dim(' ');

    lines.push(chalk.dim('\u25cb') + ' ' + dot + ' ' + text);
  }

  if (pending.length > maxRows) {
    lines.push(chalk.dim(` +${pending.length - maxRows} more`));
  }

  // bottom separator
  lines.push(chalk.dim('\u2500'.repeat(PANEL_WIDTH)));

  return lines;
}

// ── render engine ──────────────────────────────────────────────

export function showSidebar(config) {
  const width = tw();
  const height = th();

  if (width < MIN_WIDTH) {
    clearSidebar();
    return false;
  }

  const lines = buildPanel(config);
  if (!lines) {
    clearSidebar();
    return false;
  }

  const sepCol = width - PANEL_WIDTH - SEP_WIDTH;
  const panelCol = sepCol + SEP_WIDTH;

  let buf = '';

  // save cursor
  buf += '\x1b7';

  // draw panel lines with separator
  for (let i = 0; i < lines.length; i++) {
    buf += `\x1b[${i + 1};${sepCol}H`;
    buf += chalk.dim('\u2502');
    buf += ' ';
    buf += lines[i];
    // clear from end of content to right edge
    buf += `\x1b[${width}G\x1b[K`;
  }

  // extend separator through remaining terminal rows
  for (let i = lines.length; i < height - 1; i++) {
    buf += `\x1b[${i + 1};${sepCol}H`;
    buf += chalk.dim('\u2502');
    buf += `\x1b[${width}G\x1b[K`;
  }

  // restore cursor
  buf += '\x1b8';

  process.stdout.write(buf);
  return true;
}

export function clearSidebar() {
  const width = tw();
  const height = th();
  if (width < MIN_WIDTH) return;

  const sepCol = width - PANEL_WIDTH - SEP_WIDTH;

  let buf = '\x1b7';
  for (let row = 1; row <= height; row++) {
    buf += `\x1b[${row};${sepCol}H\x1b[${width}G\x1b[K`;
  }
  buf += '\x1b8';
  process.stdout.write(buf);
}

export function canShowSidebar(config) {
  if (tw() < MIN_WIDTH) return false;
  const todos = loadTodos(config);
  return todos.some(t => !t.done);
}

export function getSidebarWidth(config) {
  if (!canShowSidebar(config)) return 0;
  return PANEL_WIDTH + SEP_WIDTH + 1;
}

export { loadTodos, MIN_WIDTH };
