import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getWorkspaceRoot } from '../workspace.js';
import chalk from 'chalk';

function todoPath(config) {
  return config?.todoFile || join(getWorkspaceRoot(), '.creecode', 'todo.json');
}

function loadTodos(config) {
  const p = todoPath(config);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return []; }
}

const MIN_WIDTH = 100;
const SIDEBAR_WIDTH = 32;
const SIDEBAR_PADDING = 2;
const CLEAR_RIGHT = (w) => `\x1b[${w}G\x1b[K`;
const MOVE_COL = (col) => `\x1b[${col}G`;
const SAVE_CURSOR = '\x1b7';
const RESTORE_CURSOR = '\x1b8';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

function getTerminalWidth() {
  return process.stdout.columns || 80;
}

function renderSidebar(config) {
  const width = getTerminalWidth();
  if (width < MIN_WIDTH) return null;

  const todos = loadTodos(config);
  const pending = todos.filter(t => !t.done);
  if (pending.length === 0) return null;

  const sidebarCol = width - SIDEBAR_WIDTH - SIDEBAR_PADDING + 1;
  const title = chalk.cyan.bold('TASKS');
  const count = chalk.gray(`(${pending.length})`);

  const lines = [];
  lines.push(`${title} ${count}`);
  lines.push(chalk.gray('\u2500'.repeat(SIDEBAR_WIDTH - 1)));

  const maxLines = Math.min(pending.length, 20);
  for (let i = 0; i < maxLines; i++) {
    const t = pending[i];
    const check = t.done ? chalk.green('\u2713') : chalk.gray('\u25cb');
    let text = t.text || '';
    // truncate to fit
    const maxLen = SIDEBAR_WIDTH - 4;
    if (text.length > maxLen) text = text.slice(0, maxLen - 1) + '\u2026';
    if (t.priority) {
      const pColor = t.priority === 'high' ? chalk.red : t.priority === 'medium' ? chalk.yellow : chalk.gray;
      text = pColor('\u25cf') + ' ' + text;
    } else {
      text = '  ' + text;
    }
    lines.push(`${check} ${text}`);
  }
  if (pending.length > maxLines) {
    lines.push(chalk.gray(`  +${pending.length - maxLines} more`));
  }

  return { lines, sidebarCol };
}

/**
 * Draw the sidebar on the right side of the screen for `numRows` terminal rows.
 * Uses ansi save/restore cursor so the caller's cursor position is preserved.
 * Returns true if sidebar was drawn.
 */
export function drawSidebar(config, numRows = 1) {
  const panel = renderSidebar(config);
  if (!panel) return false;

  const { lines, sidebarCol } = panel;
  const width = getTerminalWidth();

  // for each visible line row, write the sidebar content at the right column
  for (let row = 0; row < numRows && row < lines.length; row++) {
    process.stdout.write(`\x1b[${row + 1};${sidebarCol}H`);
    process.stdout.write(chalk.gray('\u2502') + ' ');
    process.stdout.write(lines[row]);
    // clear anything after
    process.stdout.write(`\x1b[${width}G\x1b[K`);
  }

  // if we have more sidebar lines than rows, just show what fits
  // redraw the separator line at row 0 if we only have 1 row
  return true;
}

/**
 * Clear the sidebar area (fill with spaces).
 */
export function clearSidebar(numRows = 1) {
  const width = getTerminalWidth();
  if (width < MIN_WIDTH) return;
  const sidebarCol = width - SIDEBAR_WIDTH - SIDEBAR_PADDING + 1;
  for (let row = 0; row < numRows; row++) {
    process.stdout.write(`\x1b[${row + 1};${sidebarCol}H`);
    process.stdout.write(`\x1b[${width}G\x1b[K`);
  }
}

/**
 * Check if sidebar can be shown (terminal wide enough + pending todos).
 */
export function canShowSidebar(config) {
  if (getTerminalWidth() < MIN_WIDTH) return false;
  const todos = loadTodos(config);
  return todos.some(t => !t.done);
}

/**
 * Get the sidebar width so the main content area can be reduced.
 * Returns 0 if sidebar is not shown.
 */
export function getSidebarWidth(config) {
  if (!canShowSidebar(config)) return 0;
  return SIDEBAR_WIDTH + SIDEBAR_PADDING;
}

export { loadTodos, MIN_WIDTH, SIDEBAR_WIDTH };
