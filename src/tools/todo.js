import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getWorkspaceRoot } from '../workspace.js';
import { safeJsonParse } from '../utils/safe_json.js';

function todoPath(config) {
  return config.todoFile ? config.todoFile : join(getWorkspaceRoot(), '.creecode', 'todo.json');
}
function load(config) {
  const p = todoPath(config);
  if (!existsSync(p)) return [];
  try { return safeJsonParse(readFileSync(p, 'utf-8')); } catch { return []; }
}
function save(config, todos) {
  const p = todoPath(config);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(todos, null, 2), 'utf-8');
}

export async function addTodo(args, _t, config = {}) {
  const todos = load(config);
  const text = args.text;
  if (!text || !text.trim()) return { error: 'text is required' };
  const todo = {
    id: Date.now(),
    text: text.trim(),
    done: false,
    priority: args.priority || null,
    tag: args.tag || null,
    created_at: new Date().toISOString(),
    done_at: null,
  };
  if (args.insert_before_id) {
    const idx = todos.findIndex(t => t.id === args.insert_before_id);
    if (idx >= 0) {
      todos.splice(idx, 0, todo);
    } else {
      todos.push(todo);
    }
  } else if (args.insert_after_id) {
    const idx = todos.findIndex(t => t.id === args.insert_after_id);
    if (idx >= 0) {
      todos.splice(idx + 1, 0, todo);
    } else {
      todos.push(todo);
    }
  } else {
    todos.push(todo);
  }
  save(config, todos);
  return { status: 'added', id: todo.id, count: todos.length, pending: todos.filter(t => !t.done).length };
}

export async function listTodos(args, _t, config = {}) {
  const todos = load(config);
  const filter = args.filter || 'all';
  const tag = args.tag || null;
  let filtered = todos;
  if (filter === 'pending') filtered = todos.filter(t => !t.done);
  else if (filter === 'done') filtered = todos.filter(t => t.done);
  if (tag) filtered = filtered.filter(t => t.tag === tag);
  return {
    todos: filtered,
    total: todos.length,
    pending: todos.filter(t => !t.done).length,
    done: todos.filter(t => t.done).length,
  };
}

export async function updateTodo(args, _t, config = {}) {
  const todos = load(config);
  const id = args.id;
  if (!id) return { error: 'id is required' };
  const idx = todos.findIndex(t => t.id === id || String(t.id) === String(id));
  if (idx < 0) return { error: `todo ${id} not found` };
  if (args.done === true) {
    todos[idx].done = true;
    todos[idx].done_at = new Date().toISOString();
  } else if (args.done === false) {
    todos[idx].done = false;
    todos[idx].done_at = null;
  }
  if (args.text !== undefined) todos[idx].text = String(args.text).trim();
  if (args.priority !== undefined) todos[idx].priority = args.priority;
  if (args.tag !== undefined) todos[idx].tag = args.tag || null;
  save(config, todos);
  return { status: 'updated', todo: todos[idx] };
}

export async function deleteTodo(args, _t, config = {}) {
  const todos = load(config);
  const id = args.id;
  if (!id) return { error: 'id is required' };
  const idx = todos.findIndex(t => t.id === id || String(t.id) === String(id));
  if (idx < 0) return { error: `todo ${id} not found` };
  const removed = todos.splice(idx, 1)[0];
  save(config, todos);
  return { status: 'deleted', todo: removed, count: todos.length };
}

export async function clearTodos(args, _t, config = {}) {
  const filter = args.filter || 'all';
  if (filter === 'done') {
    const todos = load(config);
    const remaining = todos.filter(t => !t.done);
    save(config, remaining);
    return { status: 'cleared', removed: todos.length - remaining.length, remaining: remaining.length };
  }
  save(config, []);
  return { status: 'cleared' };
}
