/**
 * Adaptive Observer (Phase 13, spec §3–8, §14) — the event/task-driven
 * observation orchestrator on top of the Phase 4 ScreenObserver.
 *
 * It decides WHEN to observe (deterministic decision engine), HOW MUCH
 * budget a capture may consume (bounded budgets), WHAT region to analyze
 * (region-aware crops), and WHEN cached state is safe to reuse (stale-state
 * protection). It runs NO polling loop and owns NO image data: captures go
 * through the ScreenObserver (permission-gated, bounded snapshot cache) and
 * failures are returned as structured results so Phase 11 recovery can
 * handle them.
 */
import type { AgentEvent, AgentEventBus } from '../events';
import { ScreenObserver } from '../vision/screenObserver';
import { compareSignatures } from '../vision/signatures';
import type { Bounds, ScreenState } from '../vision/visionTypes';
import { ObserverError } from '../vision/visionTypes';
import { resolveRegionBounds } from '../vision/regionCrop';
import type {
  ObservationBudgetStatus,
  ObservationChange,
  ObservationChangeKind,
  ObservationDecision,
  ObservationPriority,
  ObservationRequest,
  ObservationResult,
  ObservationState,
  ObservationTrigger,
} from './observationTypes';
import { ObservationBudgetTracker } from './observationBudget';
import { classifyChange, decide } from './observationDecider';
import { isStale, resolvePolicy } from './observationPolicy';

const DEFAULT_OBSERVE_TIMEOUT_MS = 10_000;
const PENDING_TRIGGER_TTL_MS = 5_000;
const MAX_RETRIES = 2;

export interface AdaptiveObserverOptions {
  screenObserver: ScreenObserver;
  events?: AgentEventBus;
  /** Budget overrides (bounded by defaults; 0 disables the observer). */
  budget?: Partial<import('./observationTypes').ObservationBudgetConfig>;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export class AdaptiveObserver {
  private screenObserver: ScreenObserver;
  private budget: ObservationBudgetTracker;
  private nowFn: () => number;

  private activeTaskId: string | null = null;
  private stopped = false;
  private lastAction: { kind: 'mouse' | 'keyboard' | 'browser' | 'app' | 'fs' | 'none'; at: number } | null = null;
  private verificationStatus: 'passed' | 'failed' | 'inconclusive' | 'none' = 'none';
  private recoveryActive = false;
  private pendingTrigger: ObservationTrigger | null = null;
  private pendingTriggerAt: number | null = null;
  private pendingPriority: ObservationPriority = 'NORMAL';
  private changeStreak = 0;
  private quietStreak = 0;
  private lastChange: ObservationChange | null = null;
  private lastDecision: ObservationDecision | null = null;

  constructor(options: AdaptiveObserverOptions) {
    this.screenObserver = options.screenObserver;
    this.budget = new ObservationBudgetTracker(options.budget);
    this.nowFn = options.now ?? Date.now;
  }

  // -------------------------------------------------------------- lifecycle

  /** Mark a task active — observation becomes task-driven. */
  beginTask(taskId: string): void {
    this.activeTaskId = taskId;
    this.stopped = false;
    this.budget.resetTask(taskId);
    this.changeStreak = 0;
    this.quietStreak = 0;
  }

  /** Task finished: stop task observation and purge temporary visual data. */
  endTask(taskId: string): void {
    if (this.activeTaskId === taskId || !this.activeTaskId) {
      this.activeTaskId = null;
      this.stopped = true;
      this.recoveryActive = false;
      this.verificationStatus = 'none';
      this.budget.resetAll();
      this.screenObserver.purgeSnapshots();
    }
  }

  /** Explicit stop (user interruption / emergency stop). */
  stopObservation(): void {
    this.stopped = true;
  }

  /** Resume after a stop (a new task or explicit restart). */
  resume(): void {
    this.stopped = false;
  }

  // ------------------------------------------------------------ observability

  getDiagnostics(): ObservationState {
    const cached = this.screenObserver.peekCurrentState();
    return {
      lastObservationAt: cached?.timestamp ?? null,
      lastStateId: cached?.id ?? null,
      changeStreak: this.changeStreak,
      quietStreak: this.quietStreak,
      consecutiveCaptures: this.budget.check(this.activeTaskId ?? 'default', this.nowFn()).consecutive,
      pendingTrigger: this.pendingTrigger,
      pendingTriggerAt: this.pendingTriggerAt,
      mode: this.currentPolicy().mode,
      stopped: this.stopped,
    };
  }

  budgetStatus(): ObservationBudgetStatus {
    return this.budget.check(this.activeTaskId ?? 'default', this.nowFn());
  }

  private currentPolicy() {
    const now = this.nowFn();
    return resolvePolicy({
      taskActive: this.activeTaskId !== null,
      changeStreak: this.changeStreak,
      quietStreak: this.quietStreak,
      verificationStatus: this.verificationStatus,
      lastActionKind: this.lastAction?.kind ?? 'none',
      justActed: this.lastAction ? now - this.lastAction.at < 2_000 : false,
    });
  }

  // ----------------------------------------------------------- context feeds

  /** Record a completed computer action (mouse/keyboard/browser/app/fs). */
  recordAction(kind: 'mouse' | 'keyboard' | 'browser' | 'app' | 'fs', trigger?: ObservationTrigger): void {
    this.lastAction = { kind, at: this.nowFn() };
    this.setPendingTrigger(
      trigger ?? (kind === 'mouse' ? 'after_mouse_action' : kind === 'keyboard' ? 'after_keyboard_action' : kind === 'browser' ? 'browser_navigation' : kind === 'app' ? 'app_state_changed' : 'fs_operation'),
      kind === 'fs' ? 'LOW' : 'HIGH'
    );
  }

  /** Feed a verification outcome (failed verification forces re-observation). */
  notifyVerification(status: 'passed' | 'failed' | 'inconclusive'): void {
    this.verificationStatus = status;
    if (status !== 'passed') this.setPendingTrigger('verification_failed', 'HIGH');
  }

  /** Feed recovery state (Phase 11): recovery always invalidates stale state. */
  notifyRecovery(active: boolean): void {
    this.recoveryActive = active;
    if (active) this.setPendingTrigger('recovery_request', 'CRITICAL');
  }

  /** Record a screen-change classification (from cheap signature diffs). */
  notifyChange(kind: ObservationChangeKind, changedFraction?: number): void {
    this.lastChange = { kind, changedFraction, detectedAt: this.nowFn() };
    if (kind === 'none') {
      this.quietStreak += 1;
      this.changeStreak = 0;
    } else if (kind === 'minor') {
      this.quietStreak = 0;
    } else {
      this.changeStreak += 1;
      this.quietStreak = 0;
      this.setPendingTrigger('screen_change', kind === 'major' ? 'HIGH' : 'NORMAL');
    }
  }

  private setPendingTrigger(trigger: ObservationTrigger, priority: ObservationPriority): void {
    const now = this.nowFn();
    if (this.pendingTrigger && this.pendingTriggerAt && now - this.pendingTriggerAt < PENDING_TRIGGER_TTL_MS) {
      // Keep the higher-priority trigger; dedup within the TTL window.
      if (rank(priority) < rank(this.pendingPriority)) return;
    }
    this.pendingTrigger = trigger;
    this.pendingTriggerAt = now;
    this.pendingPriority = priority;
  }

  // ------------------------------------------------------------- observation

  /**
   * The single entry point for observation. Consults the decision engine,
   * enforces budgets, captures (full-screen or region) through the
   * ScreenObserver, and classifies the change. Supports cancellation and a
   * hard timeout; failures are structured — never silent, never looped.
   */
  async observe(request: ObservationRequest, signal?: AbortSignal): Promise<ObservationResult> {
    const startedAt = this.nowFn();
    const taskId = request.taskId ?? this.activeTaskId ?? 'default';
    const decision = this.decideFor(taskId, request);
    this.lastDecision = decision;

    const finish = (
      status: ObservationResult['status'],
      extra: Partial<ObservationResult>
    ): ObservationResult => ({
      status,
      decision,
      reusedFromCache: false,
      durationMs: this.nowFn() - startedAt,
      budget: this.budgetStatus(),
      ...extra,
    });

    if (this.stopped) {
      return finish('stopped', {});
    }

    switch (decision.action) {
      case 'STOP_OBSERVATION':
        return finish('stopped', {});
      case 'DELAY_OBSERVATION':
        this.budget.recordReuseOrWait(taskId);
        return finish('delayed', {});
      case 'REUSE_VALID_STATE':
      case 'OBSERVE_AFTER_ACTION': {
        // The decider only returns these when the cached state is within the
        // reuse window — safe to reuse for targeting now; the post-action
        // verification happens through the action's own change detection.
        const cached = this.screenObserver.peekCurrentState();
        if (cached) {
          this.budget.recordReuseOrWait(taskId);
          return finish('reused', { state: cached, reusedFromCache: true });
        }
        break; // nothing to reuse — fall through to capture
      }
      default:
        break;
    }

    // ---- capture path (OBSERVE_NOW / OBSERVE_REGION / OBSERVE_AFTER_ACTION
    // fall-through / REUSE with empty cache) --------------------------------
    if (signal?.aborted) {
      return finish('cancelled', {});
    }
    const budgetCheck = this.budget.check(taskId, this.nowFn());
    if (!budgetCheck.allowed) {
      return finish('budget_exhausted', {});
    }

    const regionBounds = resolveRegionBounds(decision.region);
    const timeoutMs = request.timeoutMs ?? DEFAULT_OBSERVE_TIMEOUT_MS;

    let attempts = 0;
    let lastError: { kind: string; message: string } | undefined;
    while (attempts <= MAX_RETRIES) {
      if (signal?.aborted) return finish('cancelled', {});
      try {
        const { state, changedFraction } = await this.capture(taskId, request, regionBounds, timeoutMs, signal);
        const changeKind = classifyChange(changedFraction);
        this.notifyChange(changeKind);
        if (changeKind === 'none') this.budget.recordUnchanged(taskId);
        else this.budget.recordChanged(taskId);
        // A successful fresh capture resolves uncertainty and recovery needs.
        this.verificationStatus = 'none';
        this.recoveryActive = false;
        return finish('observed', { state, changeKind });
      } catch (err) {
        if (signal?.aborted) return finish('cancelled', {});
        lastError = err instanceof ObserverError
          ? { kind: err.kind, message: err.message }
          : { kind: 'capture_failed', message: String((err as any)?.message || err) };
        const retryable = lastError.kind === 'timeout' || lastError.kind === 'capture_failed' || lastError.kind === 'analysis_failed';
        attempts += 1;
        if (!retryable || attempts > MAX_RETRIES || !this.budget.recordRetry(taskId)) break;
      }
    }

    return finish('failed', { error: lastError });
  }

  /** Decision only (no capture) — for callers that want to preview the choice. */
  decideFor(taskId: string, request: ObservationRequest): ObservationDecision {
    const now = this.nowFn();
    const policy = this.currentPolicy();
    const cached = this.screenObserver.peekCurrentState();
    const lastObservation = cached ? { stateId: cached.id, timestamp: cached.timestamp } : null;

    const trigger = request.trigger === 'explicit_request' && this.pendingTrigger && this.pendingTriggerAt && now - this.pendingTriggerAt < PENDING_TRIGGER_TTL_MS
      ? this.pendingTrigger
      : request.trigger;
    if (trigger !== request.trigger) {
      // Consumed the pending trigger.
      this.pendingTrigger = null;
      this.pendingTriggerAt = null;
    }

    return decide({
      now,
      trigger,
      priority: request.priority,
      policy,
      lastObservation,
      lastAction: this.lastAction,
      task: { active: this.activeTaskId !== null },
      verification: { status: this.verificationStatus },
      recovery: { active: this.recoveryActive },
      budget: this.budget.check(taskId, now),
      workflow: request.trigger === 'learned_workflow_requirement' ? { reused: true, requireFresh: request.requireFresh } : null,
      requireFreshFlag: request.requireFresh === true,
      change: this.lastChange,
      changedFraction: this.lastChange?.changedFraction,
    });
  }

  // ------------------------------------------------------------------ capture

  private async capture(
    taskId: string,
    request: ObservationRequest,
    regionBounds: Bounds | null,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ state: ScreenState; changedFraction?: number }> {
    const previous = this.screenObserver.peekCurrentState();
    const capturePromise = this.screenObserver.getCurrentState({
      // OBSERVE_NOW and post-action verification always want a FRESH frame;
      // region captures too (the point is current, focused evidence).
      // analyze:'local' — adaptive evidence stays on-device (offline vision).
      maxAgeMs: 0,
      analyze: 'local',
      region: regionBounds ?? undefined,
      question: request.question,
    });
    const state = await withTimeout(capturePromise, timeoutMs, signal);
    this.budget.recordCapture(taskId, this.nowFn());

    let changedFraction: number | undefined;
    if (previous && previous.id !== state.id) {
      changedFraction = compareSignatures(previous.signature, state.signature).changedFraction;
    }
    return { state, changedFraction };
  }

  // ---------------------------------------------------------- event wiring

  /**
   * Subscribe to the shared event bus. HIGH/CRITICAL triggers attempt an
   * immediate bounded observation ONLY while a task is active (never while
   * idle — no unnecessary screenshots). LOW/NORMAL triggers are recorded
   * and consumed by the next explicit observe() decision.
   */
  attach(events: AgentEventBus): () => void {
    const unsubs: Array<() => void> = [];

    const on = (name: Parameters<AgentEventBus['on']>[0], handler: (event: AgentEvent) => void) => {
      unsubs.push(events.on(name, handler));
    };

    on('TASK_STARTED', (e) => {
      if (typeof e.taskId === 'string') this.beginTask(e.taskId);
    });
    const endTask = (e: AgentEvent) => {
      if (typeof e.taskId === 'string') this.endTask(e.taskId);
      else this.endTask(this.activeTaskId ?? '');
    };
    on('TASK_COMPLETED', endTask);
    on('TASK_FAILED', endTask);
    on('TASK_CANCELLED', endTask);

    on('MOUSE_CLICK_COMPLETED', () => this.recordAction('mouse'));
    on('CURSOR_MOVE_COMPLETED', () => this.recordAction('mouse'));
    on('KEYBOARD_ACTION_COMPLETED', () => this.recordAction('keyboard'));
    on('BROWSER_NAVIGATED', () => this.recordAction('browser'));
    on('APP_LAUNCHED', () => this.recordAction('app'));
    on('APP_STATE_CHANGED', () => this.recordAction('app'));
    on('APP_CLOSED', () => this.recordAction('app'));
    on('FS_OPERATION_COMPLETED', () => this.recordAction('fs'));

    on('MOUSE_ACTION_FAILED', () => this.notifyVerification('failed'));
    on('KEYBOARD_ACTION_FAILED', () => this.notifyVerification('failed'));

    const recovery = () => this.notifyRecovery(true);
    on('RECOVERY_STARTED', recovery);
    on('COMPUTER_RECOVERY_STARTED', recovery);
    on('BROWSER_RECOVERY_STARTED', recovery);
    on('RECOVERY_SUCCEEDED', () => this.notifyRecovery(false));
    on('RECOVERY_FAILED', () => this.notifyRecovery(false));
    on('RECOVERY_ABORTED', () => this.notifyRecovery(false));

    on('SCREEN_CHANGED', () => {
      // Cheap signal only: recorded for the next decision, never a capture
      // by itself (no polling, no reflex captures).
      this.setPendingTrigger('screen_change', 'NORMAL');
    });

    return () => {
      for (const unsub of unsubs) unsub();
      unsubs.length = 0;
    };
  }

  getLastDecision(): ObservationDecision | null {
    return this.lastDecision;
  }
}

function rank(priority: ObservationPriority): number {
  return { LOW: 0, NORMAL: 1, HIGH: 2, CRITICAL: 3 }[priority];
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(new ObserverError('capture_failed', 'observation cancelled'));
    };
    if (signal) {
      if (signal.aborted) {
        reject(new ObserverError('capture_failed', 'observation cancelled'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new ObserverError('timeout', `observation timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}
