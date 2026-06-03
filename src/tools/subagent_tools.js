import { subagentManager } from '../subagent.js';

/**
 * Subagent control surface — exposed as tools so the main agent can manage
 * subagents, and as slash commands so the user can manage them directly.
 */

export async function spawnSubagent(args, _trust, _config = {}) {
  const mgr = subagentManager;
  if (!mgr.mainAgent) return { error: 'No main agent attached to the subagent manager.' };
  const task = (args.task || '').trim();
  if (!task) return { error: 'task is required' };
  try {
    const sub = mgr.spawn({
      task,
      name: args.name || undefined,
      systemPrompt: args.system_prompt || undefined,
      parentId: 'main',
    });
    return {
      status: 'spawned',
      subagent_id: sub.id,
      name: sub.name,
      task: sub.task,
    };
  } catch (e) { return { error: e.message }; }
}

export async function listSubagents(_a, _t, _c = {}) {
  const list = subagentManager.list().map(s => ({
    id: s.id,
    name: s.name,
    status: s.status,
    task: s.task,
    created_at: s.createdAt,
    finished_at: s.finishedAt,
    summary_preview: s.summary ? s.summary.slice(0, 120) : null,
  }));
  return { count: list.length, subagents: list, pending_approvals: subagentManager.pendingApprovals.length };
}

export async function subagentStatus(args, _t, _c = {}) {
  const sub = subagentManager.get(args.id);
  if (!sub) return { error: `No subagent with id ${args.id}` };
  return {
    id: sub.id,
    name: sub.name,
    status: sub.status,
    task: sub.task,
    created_at: sub.createdAt,
    finished_at: sub.finishedAt,
    summary: sub.summary,
    pending_approvals: sub.approvalQueue.length,
    message_count: sub.messages.length,
  };
}

export async function decideSubagentApproval(args, _t, _c = {}) {
  const requestId = args.request_id;
  if (!requestId) return { error: 'request_id is required' };
  const action = (args.action || '').toLowerCase();
  if (!['approve', 'deny'].includes(action)) return { error: 'action must be "approve" or "deny"' };
  const ok = subagentManager.resolveApproval(requestId, {
    action,
    decided_by: 'main-agent',
    reason: args.reason || null,
  });
  if (!ok) return { error: `No pending approval with id ${requestId}` };
  return { status: 'decided', request_id: requestId, action };
}

export async function killSubagent(args, _t, _c = {}) {
  const ok = subagentManager.kill(args.id);
  if (!ok) return { error: `No subagent with id ${args.id}` };
  return { status: 'killed', id: args.id };
}
