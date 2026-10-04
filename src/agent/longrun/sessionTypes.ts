/**
 * Long-run task sessions (Phase 19) — types, deterministic lifecycle
 * transitions, budgets and the compact checkpoint schema.
 *
 * A session wraps an EXISTING AgentCore task (no second core, no second
 * planner): it adds persistent, bounded, resumable lifecycle state on top of
 * the event stream the core already emits.
 *
 * Checkpoints store only what safe resume requires — ids, statuses, counts,
 * reasons — never tool inputs/outputs, screenshots, histories or secrets.
 */
import type { StorageAdapter } from '../taskState';

// ---------------------------------------------------------------- lifecycle

export type SessionState =
  | 'CREATED'
  | 'RUNNING'
  | 'PAUSED'
  | 'WAITING'
  | 'BLOCKED'
  | 'RECOVERING'
  | 'CANCELLED'
  | 'FAILED'
  | 'COMPLETED'
  | 'EXPIRED';

/** Terminal states — no transitions out (a cancelled task never resumes). */
export const TERMINAL_STATES: ReadonlySet<SessionState> = new Set([
  'CANCELLED',
  'FAILED',
  'COMPLETED',
  'EXPIRED',
]);

/**
 * Deterministic transition table (spec §5). Anything not listed is INVALID
 * and is rejected safely — a task can never silently jump into execution
 * from an unsafe state.
 */
const TRANSITIONS: Record<SessionState, SessionState[]> = {
  CREATED: ['RUNNING', 'CANCELLED', 'EXPIRED'],
  RUNNING: ['PAUSED', 'WAITING', 'BLOCKED', 'RECOVERING', 'CANCELLED', 'FAILED', 'COMPLETED', 'EXPIRED'],
  PAUSED: ['RUNNING', 'BLOCKED', 'CANCELLED', 'EXPIRED'],
  WAITING: ['RUNNING', 'PAUSED', 'BLOCKED', 'CANCELLED', 'FAILED', 'EXPIRED'],
  BLOCKED: ['RUNNING', 'CANCELLED', 'FAILED', 'EXPIRED'],
  RECOVERING: ['RUNNING', 'BLOCKED', 'CANCELLED', 'FAILED', 'EXPIRED'],
  CANCELLED: [],
  FAILED: [],
  COMPLETED: [],
  EXPIRED: [],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  if (from === to) return false;
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: SessionState): boolean {
  return TERMINAL_STATES.has(state);
}

// ------------------------------------------------------------------ budgets

/** Session budgets (spec §11) — bounded execution, reusing core/engine limits
 *  for steps/retries/replans; the session adds wall-clock, tool-call and
 *  recovery budgets. */
export interface SessionBudget {
  maxDurationMs: number;
  maxToolCalls: number;
  maxRecoveries: number;
  /** Safety net for plan growth beyond the core's own step cap. */
  maxStepCompletions: number;
}

export const DEFAULT_SESSION_BUDGET: SessionBudget = {
  maxDurationMs: 10 * 60_000,
  maxToolCalls: 60,
  maxRecoveries: 6,
  maxStepCompletions: 24,
};

export interface BudgetConsumed {
  toolCalls: number;
  recoveries: number;
  stepCompletions: number;
  startedAt: number;
}

export type BudgetExhaustion =
  | 'duration'
  | 'tool_calls'
  | 'recoveries'
  | 'step_completions'
  | null;

export function budgetExhaustion(
  budget: SessionBudget,
  consumed: BudgetConsumed,
  now: number
): BudgetExhaustion {
  if (now - consumed.startedAt > budget.maxDurationMs) return 'duration';
  if (consumed.toolCalls > budget.maxToolCalls) return 'tool_calls';
  if (consumed.recoveries > budget.maxRecoveries) return 'recoveries';
  if (consumed.stepCompletions > budget.maxStepCompletions) return 'step_completions';
  return null;
}

// --------------------------------------------------------------- checkpoint

export const CHECKPOINT_SCHEMA_VERSION = 1;

/** Action outcome classification for duplicate prevention (spec §16). */
export type ActionOutcome = 'DEFINITE_SUCCESS' | 'DEFINITE_FAILURE' | 'UNKNOWN';

/** One compact step record — status/id only, NEVER inputs or outputs. */
export interface CheckpointStep {
  id: string;
  description: string;
  toolName: string;
  status: string;
  attempts: number;
  verified?: boolean;
}

export interface SessionCheckpoint {
  schemaVersion: number;
  taskId: string;
  goal: string;
  createdAt: number;
  updatedAt: number;
  lifecycle: SessionState;
  planRevision: number;
  steps: CheckpointStep[];
  counts: {
    stepsCompleted: number;
    stepsFailed: number;
    toolCalls: number;
    recoveries: number;
    replans: number;
  };
  budget: SessionBudget;
  consumed: BudgetConsumed;
  /** Last action + its outcome class (duplicate prevention, spec §16). */
  lastAction?: { stepId: string; toolName: string; outcome: ActionOutcome };
  pauseReason?: string;
  failureReason?: string;
  blockReason?: string;
}

/** Validate an untrusted loaded checkpoint (spec §26) — structural only. */
export function validateCheckpoint(value: unknown): { ok: true; checkpoint: SessionCheckpoint } | { ok: false; reason: string } {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'checkpoint is not an object' };
  const c = value as Partial<SessionCheckpoint>;
  if (c.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    return { ok: false, reason: `incompatible schema version ${String(c.schemaVersion)}` };
  }
  if (typeof c.taskId !== 'string' || !c.taskId) return { ok: false, reason: 'missing task id' };
  if (typeof c.goal !== 'string') return { ok: false, reason: 'missing goal' };
  if (typeof c.lifecycle !== 'string' || !isSessionState(c.lifecycle)) return { ok: false, reason: 'invalid lifecycle state' };
  if (!Array.isArray(c.steps)) return { ok: false, reason: 'missing step list' };
  if (c.steps.length > 64) return { ok: false, reason: 'step list exceeds bounds' };
  if (!c.steps.every((s) => s && typeof s.id === 'string' && typeof s.toolName === 'string' && typeof s.status === 'string')) {
    return { ok: false, reason: 'malformed step record' };
  }
  if (!c.counts || typeof c.counts !== 'object') return { ok: false, reason: 'missing counts' };
  if (!c.budget || typeof c.budget !== 'object' || typeof c.budget.maxDurationMs !== 'number') {
    return { ok: false, reason: 'missing budget' };
  }
  if (!c.consumed || typeof c.consumed.startedAt !== 'number') return { ok: false, reason: 'missing budget consumption' };
  if (typeof c.createdAt !== 'number' || typeof c.updatedAt !== 'number') return { ok: false, reason: 'missing timestamps' };
  return { ok: true, checkpoint: value as SessionCheckpoint };
}

function isSessionState(value: string): value is SessionState {
  return ['CREATED', 'RUNNING', 'PAUSED', 'WAITING', 'BLOCKED', 'RECOVERING', 'CANCELLED', 'FAILED', 'COMPLETED', 'EXPIRED'].includes(value);
}

/** Stale beyond acceptable limits (spec §26) — checkpoints older than this
 *  are BLOCKED pending explicit revalidation, never auto-resumed. */
export const CHECKPOINT_STALE_MS = 24 * 60 * 60_000;

export function isStaleCheckpoint(checkpoint: SessionCheckpoint, now: number): boolean {
  return now - checkpoint.updatedAt > CHECKPOINT_STALE_MS;
}

// ------------------------------------------------------------------- store

export const LONGRUN_STORAGE_KEY = 'krisha_agent_longrun_v1';
export const MAX_PERSISTED_CHECKPOINTS = 24;

/** Bounded checkpoint persistence over the existing StorageAdapter pattern. */
export class CheckpointStore {
  private checkpoints = new Map<string, SessionCheckpoint>();

  constructor(
    private storage: StorageAdapter,
    private maxEntries: number = MAX_PERSISTED_CHECKPOINTS
  ) {
    this.load();
  }

  private load(): void {
    const raw = this.storage.getItem(LONGRUN_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const value of parsed) {
          const result = validateCheckpoint(value);
          // Corrupt entries fail safe: dropped at load, never executed.
          // (Explicit ===: non-strict compilation disables truthiness narrowing.)
          if (result.ok === true) this.checkpoints.set(result.checkpoint.taskId, result.checkpoint);
        }
      }
    } catch {
      // corrupted store — start clean
    }
  }

  private persist(): void {
    const all = [...this.checkpoints.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, this.maxEntries);
    try {
      this.storage.setItem(LONGRUN_STORAGE_KEY, JSON.stringify(all));
    } catch {
      // quota — non-fatal
    }
  }

  save(checkpoint: SessionCheckpoint): void {
    this.checkpoints.set(checkpoint.taskId, checkpoint);
    // Bounded retention: evict oldest terminal checkpoints beyond the cap.
    while (this.checkpoints.size > this.maxEntries) {
      const terminal = [...this.checkpoints.values()]
        .filter((c) => isTerminal(c.lifecycle))
        .sort((a, b) => a.updatedAt - b.updatedAt)[0];
      const victim = terminal ?? [...this.checkpoints.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
      this.checkpoints.delete(victim.taskId);
    }
    this.persist();
  }

  get(taskId: string): SessionCheckpoint | undefined {
    return this.checkpoints.get(taskId);
  }

  delete(taskId: string): void {
    this.checkpoints.delete(taskId);
    this.persist();
  }

  /** Cleanup of terminal sessions (completed/cancelled/expired/failed). */
  cleanupTerminal(keepRecent = 5): number {
    const terminal = [...this.checkpoints.values()]
      .filter((c) => isTerminal(c.lifecycle))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    let removed = 0;
    for (const c of terminal.slice(keepRecent)) {
      this.checkpoints.delete(c.taskId);
      removed++;
    }
    if (removed > 0) this.persist();
    return removed;
  }

  list(): SessionCheckpoint[] {
    return [...this.checkpoints.values()];
  }

  size(): number {
    return this.checkpoints.size;
  }
}
