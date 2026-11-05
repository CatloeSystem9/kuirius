/**
 * Goal Continuity v1 — tools.
 *
 * The whole tool surface of goal continuity. Read-only inspection tools are
 * riskLevel 'safe'; goal mutations are 'low' and require the
 * 'memory.access' permission. Every tool passes through the ToolRegistry →
 * Phase 18 SafetyGate like every other capability. The engine itself never
 * executes tools — resuming a goal restores context and proposes the next
 * step; it never performs one.
 */
import { fail, ok } from '../types';
import type { AgentTool } from '../types';
import type { GoalEngine } from './goalEngine';
import type { GoalStatus } from './goalTypes';

export interface GoalToolsDeps {
  goals: GoalEngine;
}

const GOAL_STATUSES: GoalStatus[] = ['proposed', 'active', 'paused', 'blocked', 'completed', 'abandoned'];

function goalSummary(goal: NonNullable<ReturnType<GoalEngine['get']>>) {
  return {
    id: goal.id,
    description: goal.description,
    status: goal.status,
    completed: goal.progress.completed,
    remaining: goal.progress.remaining,
    blockers: goal.progress.blockers,
    milestones: goal.milestones.length,
    projects: goal.projectRefs.map((r) => r.name || r.root),
    blockedByGoalIds: goal.blockedByGoalIds,
    lastActivityAt: goal.lastActivityAt,
    createdAt: goal.createdAt,
  };
}

export function createGoalTools(deps: GoalToolsDeps): AgentTool[] {
  const { goals } = deps;

  const goalList: AgentTool = {
    name: 'goal.list',
    description: 'List persisted goals with their lifecycle status, progress and blockers (read-only, bounded)',
    category: 'memory',
    riskLevel: 'safe',
    capabilities: ['goal.list'],
    permissions: ['memory.access'],
    verification: { strategy: 'self_reported', description: 'Bounded read of the persisted goal store' },
    inputSchema: { required: [], optional: ['status'], types: { status: 'string' }, description: 'Optional status filter (proposed/active/paused/blocked/completed/abandoned)' },
    async execute(input) {
      const raw = typeof input.status === 'string' ? (input.status.trim().toLowerCase() as GoalStatus) : undefined;
      if (raw && !GOAL_STATUSES.includes(raw)) return fail(`unknown goal status "${raw}"`, { errorKind: 'invalid_input' });
      return ok({ output: { goals: goals.list(raw).map(goalSummary), stats: goals.stats() } });
    },
  };

  const goalBrief: AgentTool = {
    name: 'goal.brief',
    description: 'Resumption briefing: which open goals relate to the current request, what was completed, what remains, blockers (context only — executes nothing)',
    category: 'memory',
    riskLevel: 'safe',
    capabilities: ['goal.brief'],
    permissions: ['memory.access'],
    verification: { strategy: 'self_reported', description: 'Deterministic local briefing over open goals' },
    inputSchema: { required: [], optional: ['input'], types: { input: 'string' }, description: 'Current user request to rank goals against; omit for the most recently active goals' },
    async execute(input) {
      const context = typeof input.input === 'string' ? input.input : '';
      const briefings = goals.resumptionBriefing(context);
      return ok({
        output: {
          briefings: briefings.map((b) => ({ goalId: b.goalId, description: b.description, relevance: Math.round(b.relevance * 100) / 100, lines: b.lines })),
          note: 'briefings restore context and propose next steps; no action is taken without the user',
        },
      });
    },
  };

  const goalCreate: AgentTool = {
    name: 'goal.create',
    description: 'Record a goal ONLY when the user explicitly stated it ("let\'s build X", "my goal is Y") — never from inferred intentions',
    category: 'memory',
    riskLevel: 'low',
    capabilities: ['goal.create'],
    permissions: ['memory.access'],
    verification: { strategy: 'self_reported', description: 'Bounded goal record with stable id, deduplicated against open goals' },
    inputSchema: {
      required: ['description'],
      optional: ['originMessage'],
      types: { description: 'string', originMessage: 'string' },
      description: 'description: the user-facing objective. originMessage: the user statement it came from (provenance).',
    },
    async execute(input) {
      const description = String(input.description ?? '').trim();
      if (!description) return fail('description is required', { errorKind: 'invalid_input' });
      const origin = typeof input.originMessage === 'string' ? input.originMessage : undefined;
      const created = goals.create(description, { ...(origin ? { originMessage: origin } : {}), explicit: true });
      if (!created) return fail('goal not created (duplicate of an open goal or invalid input)', { errorKind: 'invalid_input', retryable: false });
      return ok({ output: { goal: goalSummary(created) } });
    },
  };

  const goalUpdate: AgentTool = {
    name: 'goal.update',
    description: 'Update a goal the user referred to: lifecycle status (activate/pause/resume/block/complete/abandon), progress items, milestones — only on explicit user statements',
    category: 'memory',
    riskLevel: 'low',
    capabilities: ['goal.update'],
    permissions: ['memory.access'],
    verification: { strategy: 'self_reported', description: 'Guarded lifecycle transition (invalid transitions are rejected)' },
    inputSchema: {
      required: ['goalId'],
      optional: ['status', 'addCompleted', 'addRemaining', 'addBlocker', 'addMilestone', 'reason'],
      types: { goalId: 'string', status: 'string', addCompleted: 'string', addRemaining: 'string', addBlocker: 'string', addMilestone: 'string', reason: 'string' },
      description: 'goalId from goal.list. status: active/paused/blocked/completed/abandoned. add*: append bounded progress items.',
    },
    async execute(input) {
      const goalId = String(input.goalId ?? '').trim();
      if (!goalId) return fail('goalId is required', { errorKind: 'invalid_input' });
      if (!goals.get(goalId)) return fail(`no goal with id "${goalId}"`, { errorKind: 'not_found', retryable: false });

      let touched = false;
      const output: Record<string, unknown> = { goalId };

      if (typeof input.status === 'string') {
        const status = input.status.trim().toLowerCase() as GoalStatus;
        if (!GOAL_STATUSES.includes(status)) return fail(`unknown goal status "${input.status}"`, { errorKind: 'invalid_input' });
        const updated = goals.transition(goalId, status, typeof input.reason === 'string' ? input.reason : 'updated via goal.update');
        if (!updated) return fail(`transition to "${status}" is not valid from the current state`, { errorKind: 'invalid_input', retryable: false });
        output.status = updated.status;
        touched = true;
      }
      for (const [key, kind] of [['addCompleted', 'completed'], ['addRemaining', 'remaining'], ['addBlocker', 'blockers']] as const) {
        if (typeof input[key] === 'string' && input[key].trim()) {
          output[kind] = goals.addProgressItem(goalId, kind, String(input[key]));
          touched = touched || output[kind] === true;
        }
      }
      if (typeof input.addMilestone === 'string' && input.addMilestone.trim()) {
        output.milestoneRecorded = goals.recordMilestone(goalId, input.addMilestone);
        touched = touched || output.milestoneRecorded === true;
      }
      if (!touched) return fail('nothing to update: provide status or progress items', { errorKind: 'invalid_input' });
      const goal = goals.get(goalId);
      return ok({ output: { ...output, goal: goal ? goalSummary(goal) : undefined } });
    },
  };

  const goalForget: AgentTool = {
    name: 'goal.forget',
    description: 'Remove a goal and release its memory/graph mirrors (user-requested forgetting only)',
    category: 'memory',
    riskLevel: 'low',
    capabilities: ['goal.forget'],
    permissions: ['memory.access'],
    verification: { strategy: 'self_reported', description: 'Removal from the bounded goal store plus mirror release' },
    inputSchema: { required: ['goalId'], optional: [], types: { goalId: 'string' }, description: 'Goal id from goal.list' },
    async execute(input) {
      const goalId = String(input.goalId ?? '').trim();
      if (!goalId) return fail('goalId is required', { errorKind: 'invalid_input' });
      const removed = goals.forget(goalId);
      return removed
        ? ok({ output: { forgotten: true, goalId } })
        : fail(`no goal with id "${goalId}"`, { errorKind: 'not_found', retryable: false });
    },
  };

  return [goalList, goalBrief, goalCreate, goalUpdate, goalForget];
}
