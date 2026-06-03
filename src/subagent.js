import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { normalizeAssistantResponse, parseToolCalls, executeTool } from './tools/index.js';
import { createSpinner } from './utils/spinner.js';
import { info, warn, success, dim } from './utils/logger.js';
import { getWorkspaceRoot } from './workspace.js';

/**
 * Subagent system.
 *
 * A subagent is a separate conversation that:
 *   - runs its own agent loop in the background
 *   - shares the main agent's provider, model, and trust config
 *   - has its own messages array (saved to ~/.creecode/subagents/<id>.json)
 *   - can be pinged (notified) when finished
 *   - routes its tool-call approval requests through a manager that the
 *     main agent (or, as a last resort, the human user) decides
 *
 * Lifecycle:
 *   spawn(task) -> queued -> running -> awaiting_approval -> running -> done
 *                                                  \-> denied  -> done
 */

let _idCounter = 0;
function nextId() { return `sub-${Date.now().toString(36)}-${(++_idCounter).toString(36)}`; }

function subDir() { return join(homedir(), '.creecode', 'subagents'); }
function subFilePath(id) { return join(subDir(), `${id}.json`); }

function saveSub(sub) {
  try {
    mkdirSync(subDir(), { recursive: true });
    const persisted = {
      id: sub.id,
      name: sub.name,
      task: sub.task,
      status: sub.status,
      createdAt: sub.createdAt,
      finishedAt: sub.finishedAt,
      summary: sub.summary,
      parentId: sub.parentId,
      // Persist only the role+content of messages (not internal flags).
      messages: sub.messages.map(m => ({ role: m.role, content: m.content })),
    };
    writeFileSync(subFilePath(sub.id), JSON.stringify(persisted, null, 2), 'utf-8');
  } catch {}
}

export class Subagent {
  constructor({ id, name, task, parentId, systemPrompt, provider, config, trustConfig }) {
    this.id = id || nextId();
    this.name = name || this.id;
    this.task = task;
    this.parentId = parentId || null;
    this.systemPrompt = systemPrompt || null;
    this.provider = provider;
    this.config = config;
    this.trustConfig = trustConfig;
    this.messages = [];
    this.status = 'queued';
    this.createdAt = new Date().toISOString();
    this.finishedAt = null;
    this.summary = null;
    this.approvalQueue = [];          // pending approval requests
    this.lastEvent = null;            // last event emitted to listeners
  }

  appendUserMessage(text) {
    this.messages.push({ role: 'user', content: text });
  }

  pushAssistantMessage(m) { this.messages.push(m); }
  pushToolResult(name, result) {
    this.messages.push({ role: 'user', content: `<tool_result name="${name}">\n${JSON.stringify(result, null, 2)}\n</tool_result>` });
  }

  async run(maxIterations) {
    if (this.status === 'done') return;
    this.status = 'running';
    saveSub(this);

    // Initial system prompt (or use the parent's). The sub gets the same
    // trust/workspace rules but its own conversation.
    const baseSystem = this.systemPrompt || buildSubagentSystemPrompt(this);
    this.messages.unshift({ role: 'system', content: baseSystem });

    let iter = 0;
    while (iter < (maxIterations || Infinity)) {
      iter++;
      try {
        const raw = await this.provider.streamChat(this.messages, {});
        const norm = normalizeAssistantResponse(raw);
        this.pushAssistantMessage(norm.assistantMessage);

        const parsed = parseToolCalls(norm.text);
        const toolCalls = norm.nativeToolCalls.length > 0 ? norm.nativeToolCalls : parsed.toolCalls;

        if (toolCalls.length === 0) {
          this.summary = (norm.text || '').slice(0, 2000);
          this.finishedAt = new Date().toISOString();
          this.status = 'done';
          saveSub(this);
          this.emit('finished', { id: this.id, summary: this.summary });
          return;
        }

        for (const tc of toolCalls) {
          const decision = await this.requestApproval(tc);
          if (decision.action === 'deny') {
            this.pushToolResult(tc.name, { error: `Denied by ${decision.decided_by}`, denied: true });
            continue;
          }
          const result = await executeTool(tc, this.trustConfig, this.config);
          this.pushToolResult(tc.name, result);
        }
      } catch (e) {
        this.summary = `Subagent error: ${e.message}`;
        this.finishedAt = new Date().toISOString();
        this.status = 'done';
        saveSub(this);
        this.emit('error', { id: this.id, error: e.message });
        return;
      }
    }
    this.summary = (this.summary || '') + '\n[reached iteration cap]';
    this.status = 'done';
    this.finishedAt = new Date().toISOString();
    saveSub(this);
    this.emit('finished', { id: this.id, summary: this.summary });
  }

  // Request approval for a tool call. Resolves to {action, decided_by, reason}.
  // Default: subagent-level trust decides. If blocked, escalates to manager.
  async requestApproval(tc) {
    // The executeTool function already enforces trust via checkTrust. To
    // require explicit approval, we do a "dry run" check first.
    const gate = await import('./trust.js');
    const cat = TOOL_CATEGORY_BY_NAME[tc.name] || 'commands';
    const trust = this.trustConfig[cat] || 'prompt-trust';
    // For prompt-trust categories, route the decision through the manager.
    if (trust === 'prompt-trust') {
      return this.manager.approveTool(this, tc);
    }
    // For full-trust / agent-decides: auto-approve here. executeTool still
    // does its own trust check downstream.
    return { action: 'approve', decided_by: 'subagent-auto', reason: `trust=${trust}` };
  }
}

// Map of static tool name -> category. Used by Subagent to know where to
// route approval requests. Duplicated from tools/index.js intentionally —
// this avoids a circular import.
const TOOL_CATEGORY_BY_NAME = {
  run_command: 'commands',
  apply_patch: 'files',
  delete_file: 'files',
  move_file: 'files',
  copy_file: 'files',
  write_file: 'files',
  edit_file: 'files',
  make_directory: 'files',
  http_request: 'network',
  http_download: 'network',
  git: 'git',
  kill_process: 'process',
  list_processes: 'process',
  get_env: 'process',
  // ... and many more. Fallback is 'commands' for unknown names.
};
// Make Subagent inherit EventEmitter so the manager can listen for finish.
Object.setPrototypeOf(Subagent.prototype, EventEmitter.prototype);

function buildSubagentSystemPrompt(sub) {
  return `You are a CreeCode subagent (id: ${sub.id}, task: "${sub.task}"). You run with the same tools and trust config as the main agent, but you are not interactive — your output goes back to the main agent when you finish. Stay focused on the assigned task. When you're done, respond with no tool calls and a concise summary of what you found/did.`;
}

/**
 * Manager: owns all subagents, routes approval requests to the main agent,
 * and notifies the main when a sub finishes.
 */
export class SubagentManager extends EventEmitter {
  constructor() {
    super();
    this.subs = new Map();
    this.mainAgent = null;  // the chat REPL context
    this.pendingApprovals = [];  // {sub, tool, resolve, reject}
  }

  attachMainAgent(ctx) { this.mainAgent = ctx; }

  spawn({ task, name, systemPrompt, parentId }) {
    if (!task) throw new Error('task is required');
    if (!this.mainAgent) throw new Error('No main agent attached');
    const sub = new Subagent({
      name,
      task,
      parentId,
      systemPrompt,
      provider: this.mainAgent.provider,
      config: this.mainAgent.config,
      trustConfig: this.mainAgent.trustConfig,
    });
    sub.manager = this;
    sub.appendUserMessage(`Task: ${task}\n\nWork on this and reply with a concise summary when done.`);
    this.subs.set(sub.id, sub);

    // Run in background. Save state, ping main on finish.
    sub.on('finished', (ev) => this._onSubFinished(sub, ev));
    sub.on('error', (ev) => this._onSubFinished(sub, { ...ev, error: true }));
    sub.run(this.mainAgent.config.maxIterations || 50).catch((e) => {
      this._onSubFinished(sub, { id: sub.id, error: e.message });
    });
    return sub;
  }

  _onSubFinished(sub, ev) {
    saveSub(sub);
    this.emit('sub-finished', { sub, event: ev });
    if (this.mainAgent?.onSubFinished) this.mainAgent.onSubFinished(sub, ev);
  }

  get(id) { return this.subs.get(id); }
  list() { return Array.from(this.subs.values()); }

  // Resolve a pending approval. Returns true if a matching request was found.
  resolveApproval(requestId, decision) {
    const idx = this.pendingApprovals.findIndex(p => p.id === requestId);
    if (idx === -1) return false;
    const p = this.pendingApprovals[idx];
    this.pendingApprovals.splice(idx, 1);
    p.resolve(decision);
    return true;
  }

  // Subagent calls this when a prompt-trust tool needs approval.
  async approveTool(sub, toolCall) {
    if (!this.mainAgent) {
      return { action: 'deny', decided_by: 'system', reason: 'no main agent attached' };
    }
    const requestId = `apr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve) => {
      this.pendingApprovals.push({ id: requestId, sub, tool: toolCall, resolve });
      this.emit('approval-needed', { requestId, sub, tool: toolCall });
      if (this.mainAgent?.onApprovalNeeded) this.mainAgent.onApprovalNeeded({ requestId, sub, tool: toolCall });
    });
  }

  kill(id) {
    const sub = this.subs.get(id);
    if (!sub) return false;
    sub.status = 'killed';
    sub.finishedAt = new Date().toISOString();
    sub.summary = '[killed by user]';
    saveSub(sub);
    // Resolve any pending approvals as denied.
    for (const p of this.pendingApprovals) {
      if (p.sub.id === id) {
        p.resolve({ action: 'deny', decided_by: 'kill', reason: 'subagent killed' });
      }
    }
    this.subs.delete(id);
    this._onSubFinished(sub, { id, killed: true });
    return true;
  }
}

export const subagentManager = new SubagentManager();
