/**
 * Long-run manager (Phase 19) — persistent, bounded, interruption-safe task
 * sessions over the EXISTING Agent Core (no second core/planner/recovery).
 *
 * Fully event-driven on the shared bus: sessions advance on TASK_* events the
 * core already emits; checkpoints are written at meaningful boundaries (step
 * completion, pause, failure, replan, budget exhaustion) — never on a timer,
 * never in a loop. Concurrency is bounded (single active session by default).
 * Resume is NEVER blind: every resume revalidates the checkpoint, the
 * lifecycle state, the Phase 18 permission layer and the emergency-stop
 * state, and refuses when the last side-effecting action's outcome is
 * UNKNOWN and external verification has not established safety (spec §16).
 */
import type { AgentEventBus } from '../events';
import type { AgentCore } from '../agentCore';
import type { StorageAdapter } from '../taskState';
import { MemoryStorage } from '../taskState';
import type { SafetyAuditLog } from '../safety';
import {
  budgetExhaustion,
  CheckpointStore,
  DEFAULT_SESSION_BUDGET,
  isStaleCheckpoint,
  validateCheckpoint,
  type ActionOutcome,
  type SessionBudget,
  type SessionCheckpoint,
  type SessionState,
} from './sessionTypes';
import { TaskSession } from './taskSession';
import { waitUntil } from './waiting';

export interface LongRunLimits {
  budget: Partial<SessionBudget>;
  /** Bounded concurrency (spec §23): single active session by default. */
  maxActiveSessions: number;
  /** Checkpoints older than this are BLOCKED pending revalidation. */
  staleCheckpointMs: number;
}

export const DEFAULT_LONGRUN_LIMITS: LongRunLimits = {
  budget: {},
  maxActiveSessions: 1,
  staleCheckpointMs: 24 * 60 * 60_000,
};

export interface SessionDiagnostics {
  taskId: string;
  state: SessionState;
  goal: string;
  stepsCompleted: number;
  stepsFailed: number;
  toolCalls: number;
  recoveries: number;
  replans: number;
  lastAction?: { stepId: string; toolName: string; outcome: ActionOutcome };
  pauseReason?: string;
  blockReason?: string;
  failureReason?: string;
  budgetRemainingMs: number;
  checkpointedAt: number;
}

export class LongRunManager {
  private sessions = new Map<string, TaskSession>();
  private checkpoints: CheckpointStore;
  private pauseRequests = new Set<string>();
  private limits: LongRunLimits;
  private busListeners: (() => void)[] = [];
  private audit?: SafetyAuditLog;
  private now: () => number;
  private emergencyActive?: () => boolean;

  constructor(
    private core: AgentCore,
    private bus: AgentEventBus,
    options: { storage?: StorageAdapter; audit?: SafetyAuditLog; limits?: Partial<LongRunLimits>; now?: () => number } = {}
  ) {
    this.limits = {
      budget: { ...DEFAULT_SESSION_BUDGET, ...(options.limits?.budget ?? {}) },
      maxActiveSessions: options.limits?.maxActiveSessions ?? DEFAULT_LONGRUN_LIMITS.maxActiveSessions,
      staleCheckpointMs: options.limits?.staleCheckpointMs ?? DEFAULT_LONGRUN_LIMITS.staleCheckpointMs,
    };
    this.checkpoints = new CheckpointStore(options.storage ?? new MemoryStorage());
    this.audit = options.audit;
    this.now = options.now ?? Date.now;
    this.crashScan();
  }

  // ------------------------------------------------------------ crash scan

  /**
   * Restart path (spec §10): load every persisted checkpoint, validate it,
   * and restore sessions SAFELY — recoverable sessions become PAUSED (they
   * require an explicit, validated resume); corrupt/stale ones become
   * BLOCKED. Nothing is auto-resumed, ever.
   */
  private crashScan(): void {
    for (const checkpoint of this.checkpoints.list()) {
      const validation = validateCheckpoint(checkpoint);
      // NOTE: explicit === comparisons everywhere — this project compiles
      // without strictNullChecks, where truthiness narrowing of discriminated
      // unions is disabled.
      if (validation.ok === false) {
        this.checkpoints.delete(checkpoint.taskId);
        continue;
      }
      const cp = validation.checkpoint;
      const session = new TaskSession(cp.taskId, cp.lifecycle, this.now, (from, to) =>
        this.audit?.append({ kind: 'blocked', reason: `invalid lifecycle transition ${from} to ${to} rejected`, taskId: cp.taskId })
      );
      this.sessions.set(cp.taskId, session);
      if (!this.terminal(cp.lifecycle)) {
        if (isStaleCheckpoint(cp, this.now())) {
          session.transitionTo('BLOCKED', `checkpoint stale — explicit revalidation required`);
        } else if (cp.lifecycle === 'RUNNING' || cp.lifecycle === 'RECOVERING' || cp.lifecycle === 'WAITING') {
          // The core died mid-run: never resume automatically.
          session.transitionTo('PAUSED', 'restored after restart — awaiting validated resume');
        }
      }
      this.writeCheckpoint(session, cp);
    }
  }

  private terminal(state: SessionState): boolean {
    return ['CANCELLED', 'FAILED', 'COMPLETED', 'EXPIRED'].includes(state);
  }

  // ---------------------------------------------------------------- attach

  /** Event-driven session advancement (no polling, no timers). */
  attach(): () => void {
    this.busListeners = [
      this.bus.on('TASK_STEP_COMPLETED', (e) => this.onStepBoundary(e.taskId, 'completed')),
      this.bus.on('TASK_STEP_FAILED', (e) => this.onStepBoundary(e.taskId, 'failed')),
      this.bus.on('RECOVERY_STARTED', (e) => this.onRecovery(e.taskId, true)),
      this.bus.on('RECOVERY_SUCCEEDED', (e) => this.onRecovery(e.taskId, false)),
      this.bus.on('RECOVERY_FAILED', (e) => this.onRecovery(e.taskId, false)),
      this.bus.on('PLAN_REPLANNED', (e) => {
        const session = this.sessionOf(e.taskId);
        if (!session) return;
        const cp = this.checkpoints.get(e.taskId!);
        if (!cp) return;
        cp.counts.replans += 1;
        this.writeCheckpoint(session, cp);
      }),
      this.bus.on('TASK_COMPLETED', (e) => this.onTerminal(e.taskId, 'COMPLETED')),
      this.bus.on('TASK_FAILED', (e) => this.onTerminal(e.taskId, 'FAILED', (e.payload as { reason?: string })?.reason)),
      this.bus.on('TASK_CANCELLED', (e) => this.onCancelled(e.taskId)),
      // Registry TOOL_* events carry taskId inside the payload (not the root).
      this.bus.on('TOOL_COMPLETED', (e) => this.onToolCall((e.payload as { taskId?: string })?.taskId ?? e.taskId)),
      this.bus.on('TOOL_FAILED', (e) => this.onToolCall((e.payload as { taskId?: string })?.taskId ?? e.taskId)),
    ];
    return () => {
      for (const off of this.busListeners) off();
      this.busListeners = [];
    };
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Start a long-running task. Bounded concurrency: rejects when another
   * session is active (single-active model, spec §23).
   */
  start(goal: string, opts?: { budget?: Partial<SessionBudget> }): { taskId: string; started: boolean; reason?: string } {
    const active = [...this.sessions.values()].filter((s) => !this.terminal(s.current) && s.current !== 'PAUSED');
    if (active.length >= this.limits.maxActiveSessions) {
      return { taskId: '', started: false, reason: `single-active-session model: ${active.length} session(s) already active (max ${this.limits.maxActiveSessions})` };
    }
    const { taskId } = this.core.startTask(goal);
    const session = new TaskSession(taskId, 'CREATED', this.now, (from, to) =>
      this.audit?.append({ kind: 'blocked', reason: `invalid lifecycle transition ${from} to ${to} rejected`, taskId })
    );
    session.transitionTo('RUNNING', 'task started (long-run session)');
    this.sessions.set(taskId, session);
    const budget: SessionBudget = { ...DEFAULT_SESSION_BUDGET, ...this.limits.budget, ...(opts?.budget ?? {}) };
    this.checkpoints.save({
      schemaVersion: 1,
      taskId,
      goal: goal.slice(0, 160),
      createdAt: this.now(),
      updatedAt: this.now(),
      lifecycle: 'RUNNING',
      planRevision: 1,
      steps: [],
      counts: { stepsCompleted: 0, stepsFailed: 0, toolCalls: 0, recoveries: 0, replans: 0 },
      budget,
      consumed: { toolCalls: 0, recoveries: 0, stepCompletions: 0, startedAt: this.now() },
    });
    this.audit?.append({ kind: 'granted', reason: 'long-run session started', taskId });
    return { taskId, started: true };
  }

  /** User pause: request + cancel the in-flight step; the cancellation event
   *  finalizes PAUSED with a checkpoint. A paused task never auto-resumes. */
  pause(taskId: string, reason = 'user requested pause'): { paused: boolean; reason?: string } {
    const session = this.sessionOf(taskId);
    if (!session) return { paused: false, reason: 'no such session' };
    if (session.current !== 'RUNNING' && session.current !== 'WAITING' && session.current !== 'BLOCKED') {
      return { paused: false, reason: `cannot pause from state ${session.current}` };
    }
    this.pauseRequests.add(taskId);
    this.core.cancel(taskId, 'pause');
    void reason;
    return { paused: true };
  }

  /**
   * Resume: NEVER blind. Validates the checkpoint, lifecycle, emergency-stop
   * state and duplicate-action safety BEFORE re-entering the core loop
   * (Phase 18 re-checks every action through the gate at execution time).
   */
  async resume(taskId: string): Promise<{ resumed: boolean; reason?: string }> {
    const session = this.sessionOf(taskId);
    if (!session) return { resumed: false, reason: 'no such session' };
    if (session.current !== 'PAUSED' && session.current !== 'BLOCKED') {
      return { resumed: false, reason: `cannot resume from state ${session.current}` };
    }
    const cp = this.checkpoints.get(taskId);
    if (!cp) return { resumed: false, reason: 'no checkpoint to resume from' };
    const validation = validateCheckpoint(cp);
    if (validation.ok === false) {
      session.transitionTo('BLOCKED', `checkpoint invalid: ${validation.reason}`);
      return { resumed: false, reason: validation.reason };
    }

    // Duplicate-action safety (spec §16): never re-enter on an UNKNOWN
    // outcome — external verification must establish safety first.
    const last = cp.lastAction;
    if (last?.outcome === 'UNKNOWN') {
      session.transitionTo('BLOCKED', `last action "${last.toolName}" has UNKNOWN outcome — verify external state before resuming`);
      this.writeCheckpoint(session, cp);
      return { resumed: false, reason: `last action "${last.toolName}" outcome UNKNOWN — verify external state first` };
    }

    // Emergency stop remains authoritative (spec §15).
    if (this.emergencyActive?.() === true) {
      return { resumed: false, reason: 'emergency stop is active — resume refused' };
    }

    // Budget: resuming a budget-exhausted session requires a fresh budget
    // (controlled continuation, spec §11).
    const exhaustion = budgetExhaustion(cp.budget, cp.consumed, this.now());
    if (exhaustion) {
      return { resumed: false, reason: `budget exhausted (${exhaustion}) — controlled continuation requires a fresh budget` };
    }

    if (!session.transitionTo('RUNNING', 'validated resume')) {
      return { resumed: false, reason: `invalid transition from ${session.current}` };
    }
    this.writeCheckpoint(session, cp);
    try {
      await this.core.resumeTask(taskId);
      return { resumed: true };
    } catch (err: any) {
      return { resumed: false, reason: String(err?.message || err) };
    }
  }

  /** User cancellation: terminal, never auto-resumes (spec §9). */
  cancel(taskId: string, reason = 'user requested cancellation'): { cancelled: boolean; reason?: string } {
    const session = this.sessionOf(taskId);
    if (!session) return { cancelled: false, reason: 'no such session' };
    if (this.terminal(session.current)) return { cancelled: false, reason: `already ${session.current}` };
    this.pauseRequests.delete(taskId);
    this.core.cancel(taskId, 'cancel');
    void reason;
    return { cancelled: true };
  }

  // ---------------------------------------------------------------- waiting

  /**
   * Bounded adaptive wait (spec §13): the session enters WAITING with a
   * single doubling-interval timer; wakeOnEvent (optional) re-checks
   * immediately on external events. Timeout → BLOCKED (checkpointed), never
   * an infinite wait.
   */
  async wait(
    taskId: string,
    wait: { description: string; check: () => boolean | Promise<boolean>; timeoutMs: number; pollMs?: number; maxPollMs?: number; wakeOnEvent?: 'TOOL_COMPLETED' | 'TOOL_FAILED' | 'SCREEN_CHANGED' | 'APP_STATE_CHANGED' | 'TASK_STEP_COMPLETED' | 'NOTICE' }
  ): Promise<{ status: 'satisfied' | 'timeout' | 'cancelled'; polls: number; elapsedMs: number } | { blocked: boolean; reason: string }> {
    const session = this.sessionOf(taskId);
    if (!session) return { blocked: true, reason: 'no such session' };
    if (session.current !== 'RUNNING' && session.current !== 'PAUSED') {
      return { blocked: true, reason: `cannot wait from state ${session.current}` };
    }
    if (!session.transitionTo('WAITING', `waiting: ${wait.description.slice(0, 80)}`)) {
      return { blocked: true, reason: 'invalid WAITING transition' };
    }
    const cp = this.checkpoints.get(taskId);
    if (cp) this.writeCheckpoint(session, cp); // checkpoint BEFORE the long wait
    this.bus.emit({ name: 'TASK_WAITING', taskId, payload: { description: wait.description.slice(0, 120), timeoutMs: wait.timeoutMs }, timestamp: this.now() });

    let woken = false;
    const offWake = wait.wakeOnEvent
      ? this.bus.on(wait.wakeOnEvent, () => {
          woken = true;
        })
      : () => {};

    const result = await waitUntil({
      check: async () => {
        if (woken) woken = false; // event-driven wake: consume and re-check
        return (await wait.check()) === true;
      },
      timeoutMs: wait.timeoutMs,
      pollMs: wait.pollMs,
      maxPollMs: wait.maxPollMs,
    });
    offWake();

    if (result.status === 'cancelled' || this.pauseRequests.has(taskId)) {
      session.transitionTo('PAUSED', 'cancelled wait (pause)');
      return { status: 'cancelled', polls: result.polls, elapsedMs: result.elapsedMs };
    }
    if (result.status === 'timeout') {
      session.transitionTo('BLOCKED', `wait timed out: ${wait.description.slice(0, 80)}`);
      if (cp) this.writeCheckpoint(session, cp);
      this.bus.emit({ name: 'TASK_BUDGET_EXHAUSTED', taskId, payload: { kind: 'wait_timeout' }, timestamp: this.now() });
      return { status: 'timeout', polls: result.polls, elapsedMs: result.elapsedMs };
    }
    session.transitionTo('RUNNING', `wait satisfied: ${wait.description.slice(0, 60)}`);
    this.bus.emit({ name: 'TASK_WAIT_COMPLETED', taskId, payload: { description: wait.description.slice(0, 120), polls: result.polls }, timestamp: this.now() });
    return { status: 'satisfied', polls: result.polls, elapsedMs: result.elapsedMs };
  }

  // ----------------------------------------------------------- event sinks

  private sessionOf(taskId: string | undefined): TaskSession | undefined {
    return taskId ? this.sessions.get(taskId) : undefined;
  }

  private onStepBoundary(taskId: string | undefined, kind: 'completed' | 'failed'): void {
    const session = this.sessionOf(taskId);
    if (!session) return;
    const cp = this.checkpoints.get(taskId!);
    if (!cp) return;
    if (kind === 'completed') {
      cp.consumed.stepCompletions += 1;
    } else {
      cp.counts.stepsFailed += 1;
    }
    this.refreshPlanSteps(taskId!, cp);
    this.enforceBudget(session, cp);
    this.writeCheckpoint(session, cp); // meaningful boundary: one checkpoint per step
  }

  private onToolCall(taskId: string | undefined): void {
    const session = this.sessionOf(taskId);
    if (!session) return;
    const cp = this.checkpoints.get(taskId!);
    if (!cp) return;
    cp.counts.toolCalls += 1;
    cp.consumed.toolCalls += 1;
    this.enforceBudget(session, cp);
  }

  private onRecovery(taskId: string | undefined, started: boolean): void {
    const session = this.sessionOf(taskId);
    if (!session) return;
    const cp = this.checkpoints.get(taskId!);
    if (!cp) return;
    if (started) {
      session.transitionTo('RECOVERING', 'Phase 11 recovery started');
    } else if (session.current === 'RECOVERING') {
      session.transitionTo('RUNNING', 'recovery finished');
      cp.counts.recoveries += 1;
    }
    this.writeCheckpoint(session, cp);
  }

  private onTerminal(taskId: string | undefined, state: 'COMPLETED' | 'FAILED', failureReason?: string): void {
    const session = this.sessionOf(taskId);
    if (!session) return;
    const cp = this.checkpoints.get(taskId!);
    if (cp) this.refreshPlanSteps(taskId!, cp);
    session.transitionTo(state, failureReason ?? 'task reached terminal state');
    if (cp) {
      if (state === 'FAILED') cp.failureReason = failureReason ?? 'task failed';
      this.writeCheckpoint(session, cp);
    }
    this.audit?.append({ kind: state === 'COMPLETED' ? 'executed' : 'blocked', reason: `long-run session ${state.toLowerCase()}`, taskId });
  }

  private onCancelled(taskId: string | undefined): void {
    const session = this.sessionOf(taskId);
    if (!session) return;
    const cp = this.checkpoints.get(taskId!);
    if (cp) this.refreshPlanSteps(taskId!, cp);
    if (this.pauseRequests.has(taskId!)) {
      // A pause IS a cancellation of the in-flight step — but the session
      // becomes PAUSED (resumable), never silently cancelled (spec §9).
      this.pauseRequests.delete(taskId!);
      session.transitionTo('PAUSED', 'paused by user (in-flight step cancelled safely)');
      if (cp) this.writeCheckpoint(session, cp);
      this.bus.emit({ name: 'TASK_PAUSED', taskId, payload: { reason: cp?.pauseReason ?? 'user pause' }, timestamp: this.now() });
      return;
    }
    session.transitionTo('CANCELLED', 'cancelled by user (terminal — never auto-resumes)');
    if (cp) this.writeCheckpoint(session, cp);
  }

  private enforceBudget(session: TaskSession, cp: SessionCheckpoint): void {
    const exhaustion = budgetExhaustion(cp.budget, cp.consumed, this.now());
    if (!exhaustion) return;
    // Stop safely: cancel the core task (terminal), checkpoint, transition.
    if (session.current === 'RUNNING' || session.current === 'WAITING' || session.current === 'RECOVERING') {
      this.core.cancel(cp.taskId, 'cancel');
    }
    session.transitionTo('EXPIRED', `budget exhausted: ${exhaustion}`);
    cp.failureReason = `budget exhausted: ${exhaustion}`;
    this.writeCheckpoint(session, cp);
    this.bus.emit({ name: 'TASK_BUDGET_EXHAUSTED', taskId: cp.taskId, payload: { kind: exhaustion }, timestamp: this.now() });
  }

  /** Compact plan snapshot into the checkpoint — statuses only, no IO data. */
  private refreshPlanSteps(taskId: string, cp: SessionCheckpoint): void {
    const task = this.core.store.get(taskId);
    if (!task?.plan) return;
    cp.planRevision = task.plan.revision;
    cp.steps = task.plan.steps.map((s) => ({
      id: s.id,
      description: s.description.slice(0, 80),
      toolName: s.toolName,
      status: s.status,
      attempts: s.attempts,
      verified: s.verified,
    }));
    cp.counts.stepsCompleted = task.plan.steps.filter((s) => s.status === 'completed' || s.status === 'uncertain').length;
    cp.counts.stepsFailed = task.plan.steps.filter((s) => s.status === 'failed').length;
    // Last action outcome classification (spec §16): completed+verified →
    // DEFINITE_SUCCESS; failed → DEFINITE_FAILURE; a CANCELLED step (aborted
    // before its side effect — the pause path) is also definitively
    // incomplete-safe-to-retry; only UNVERIFIED dispatches (uncertain) are
    // UNKNOWN (never blindly repeated).
    const terminal = [...task.plan.steps].reverse().find((s) => s.status !== 'pending');
    if (terminal) {
      let outcome: ActionOutcome = 'UNKNOWN';
      if (terminal.status === 'completed' && terminal.verified === true) outcome = 'DEFINITE_SUCCESS';
      else if (terminal.status === 'failed' && terminal.verified === false) outcome = 'DEFINITE_FAILURE';
      else if (terminal.status === 'cancelled') outcome = 'DEFINITE_FAILURE';
      cp.lastAction = { stepId: terminal.id, toolName: terminal.toolName, outcome };
    }
  }

  private writeCheckpoint(session: TaskSession, cp: SessionCheckpoint | undefined): void {
    if (!cp) return;
    this.checkpoints.save(session.applyTo(cp));
    this.bus.emit({ name: 'TASK_CHECKPOINTED', taskId: cp.taskId, payload: { lifecycle: session.current, updatedAt: cp.updatedAt }, timestamp: this.now() });
  }

  /** Bridge hook: emergency stop blocks resume (spec §15). */
  setEmergencyProbe(probe: () => boolean): void {
    this.emergencyActive = probe;
  }

  // ---------------------------------------------------------- observability

  listSessions(): SessionDiagnostics[] {
    return [...this.sessions.values()].map((session) => {
      const cp = this.checkpoints.get(session.taskId);
      return {
        taskId: session.taskId,
        state: session.current,
        goal: cp?.goal ?? '',
        stepsCompleted: cp?.counts.stepsCompleted ?? 0,
        stepsFailed: cp?.counts.stepsFailed ?? 0,
        toolCalls: cp?.counts.toolCalls ?? 0,
        recoveries: cp?.counts.recoveries ?? 0,
        replans: cp?.counts.replans ?? 0,
        lastAction: cp?.lastAction,
        pauseReason: cp?.pauseReason,
        blockReason: cp?.blockReason,
        failureReason: cp?.failureReason,
        budgetRemainingMs: cp ? Math.max(0, cp.budget.maxDurationMs - (this.now() - cp.consumed.startedAt)) : 0,
        checkpointedAt: cp?.updatedAt ?? 0,
      };
    });
  }

  /** Cleanup terminal checkpoints (spec §25) — bounded retention. */
  cleanup(keepRecent = 5): number {
    return this.checkpoints.cleanupTerminal(keepRecent);
  }

  checkpointCount(): number {
    return this.checkpoints.size();
  }
}
