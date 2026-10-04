/**
 * Agent Core (Phase 1) — the central cycle:
 *
 *   INPUT → GOAL → PLAN → TOOL → RESULT → VERIFY → NEXT STEP
 *
 * Guarantees:
 *  - every step runs under an abort signal (cancellation) and a hard timeout
 *  - failed steps retry up to a limit with backoff, then trigger alternative
 *    planning (Phase 11 hook) or fail the task honestly
 *  - every transition emits events on the AgentEventBus
 *  - no infinite loops: hard cap on steps and attempts
 *  - task state is persisted through the TaskStore after every mutation
 */
import type { AgentTask, PlanStep, ToolResult, Verification } from './types';
import type { AgentEventBus } from './events';
import type { ToolRegistry } from './toolRegistry';
import type { TaskStore } from './taskState';
import type { Planner } from './planner';
import type { AgentTool } from './types';
import { HeuristicPlanner, extractGoal } from './planner';
import { selectToolForCapability } from './toolSelector';
import { PermissionManager } from './permissions';
import { evaluateCondition, resolveContextRefs, resolveContextPath, boundContextValue } from './context';
import { RecoveryManager } from './recovery';
import type { PlanEngine } from './planning';

export interface AgentCoreOptions {
  registry: ToolRegistry;
  events: AgentEventBus;
  store: TaskStore;
  planner?: Planner;
  permissions?: PermissionManager;
  recovery?: RecoveryManager;
  /** Phase 16: hierarchical planning layer (validation, node lifecycle, bounded replanning). */
  planning?: PlanEngine;
  stepTimeoutMs?: number;
  maxAttemptsPerStep?: number;
  retryDelayMs?: number;
  maxSteps?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class AgentCore {
  readonly registry: ToolRegistry;
  readonly events: AgentEventBus;
  readonly store: TaskStore;
  readonly permissions: PermissionManager;
  readonly recovery: RecoveryManager;
  private planner: Planner;
  private planning?: PlanEngine;
  private stepTimeoutMs: number;
  private maxAttemptsPerStep: number;
  private retryDelayMs: number;
  private maxSteps: number;
  private controllers = new Map<string, AbortController>();
  /** Cancel mode per task (Phase 19): 'pause' records 'interrupted' (resumable). */
  private cancelModes = new Map<string, 'cancel' | 'pause'>();
  /** Adaptive observation layer (Phase 13) — optional; honors learned-workflow freshness. */
  private adaptive?: import('./observation/adaptiveObserver').AdaptiveObserver;

  constructor(options: AgentCoreOptions) {
    this.registry = options.registry;
    this.events = options.events;
    this.store = options.store;
    this.planner = options.planner ?? new HeuristicPlanner();
    this.permissions = options.permissions ?? new PermissionManager();
    this.recovery = options.recovery ?? new RecoveryManager({
      registry: this.registry,
      events: this.events,
      permissions: this.permissions,
    });
    this.planning = options.planning;
    this.stepTimeoutMs = options.stepTimeoutMs ?? 30_000;
    this.maxAttemptsPerStep = options.maxAttemptsPerStep ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 300;
    this.maxSteps = options.maxSteps ?? 10;
  }

  /** Wire the Phase 13 adaptive observation layer (optional). */
  setAdaptiveObserver(adaptive: import('./observation/adaptiveObserver').AdaptiveObserver): void {
    this.adaptive = adaptive;
  }

  /** Submit a user request. Resolves when the task reaches a terminal state. */
  async submit(input: string): Promise<AgentTask> {
    const { promise } = this.startTask(input);
    return promise;
  }

  /**
   * Phase 19: start a task WITHOUT awaiting its completion — the detached
   * entry point long-running sessions use. The returned promise still
   * resolves at the terminal state.
   */
  startTask(input: string): { taskId: string; promise: Promise<AgentTask> } {
    const now = Date.now();
    const goal = extractGoal(input);
    const task = this.store.create(goal, now);
    this.recovery.resetTask(task.id);

    this.events.emit({ name: 'USER_MESSAGE', taskId: task.id, payload: { input }, timestamp: Date.now() });
    this.events.emit({ name: 'TASK_STARTED', taskId: task.id, payload: { goal }, timestamp: Date.now() });

    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    const promise = this.executeTask(task.id, controller);
    return { taskId: task.id, promise };
  }

  /**
   * Phase 19: resume a previously interrupted/paused task from its recorded
   * plan. Already-completed/skipped steps are NOT re-run; failed steps are
   * retried (the long-run manager performs safety/idempotency validation
   * BEFORE calling this — resume is never blind).
   */
  async resumeTask(taskId: string): Promise<AgentTask> {
    const task = this.store.get(taskId);
    if (!task || !task.plan) {
      const message = `Cannot resume: task "${taskId}" not found or has no plan`;
      this.events.emit({ name: 'TASK_FAILED', taskId, payload: { error: message, reason: 'resume_invalid' }, timestamp: Date.now() });
      throw new Error(message);
    }
    if (this.controllers.has(taskId)) {
      const message = `Cannot resume: task "${taskId}" is already running`;
      this.events.emit({ name: 'TASK_FAILED', taskId, payload: { error: message, reason: 'resume_running' }, timestamp: Date.now() });
      throw new Error(message);
    }
    if (task.status === 'cancelled') {
      const message = `Cannot resume: task "${taskId}" was cancelled (cancellation is terminal)`;
      this.events.emit({ name: 'TASK_FAILED', taskId, payload: { error: message, reason: 'resume_cancelled' }, timestamp: Date.now() });
      throw new Error(message);
    }

    // Revalidate the plan through the Phase 16 planning layer — a resumed
    // task runs under the same plan-validity rules as a fresh one.
    if (this.planning) {
      const attached = this.planning.attachPlan(taskId, task.goal.description, task.plan.steps);
      if (!attached.ok) {
        this.store.update(taskId, (t) => {
          t.status = 'failed';
          t.error = attached.reason;
          t.completedAt = Date.now();
          t.summary = this.buildSummary(t);
        });
        this.events.emit({ name: 'TASK_FAILED', taskId, payload: { error: attached.reason, reason: 'resume_plan_invalid' }, timestamp: Date.now() });
        throw new Error(`Cannot resume: ${attached.reason}`);
      }
    }

    this.recovery.resetTask(taskId);
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    this.events.emit({ name: 'TASK_RESUMED', taskId, payload: { goal: task.goal }, timestamp: Date.now() });

    try {
      await this.runLoop(this.store.get(taskId)!);
      return this.store.get(taskId)!;
    } catch (err: any) {
      const mode = this.cancelModes.get(taskId) ?? 'cancel';
      const aborted = controller.signal.aborted;
      const message = err?.name === 'AbortError' || aborted ? (mode === 'pause' ? 'Task paused' : 'Task cancelled') : String(err?.message || err);
      this.planning?.cancelTask(taskId);
      this.planning?.finishTask(taskId, aborted ? 'cancelled' : 'failed');
      this.store.update(taskId, (t) => {
        t.status = aborted ? (mode === 'pause' ? 'interrupted' : 'cancelled') : 'failed';
        t.error = message;
        if (!(aborted && mode === 'pause')) t.completedAt = Date.now();
        t.summary = this.buildSummary(t);
      });
      this.events.emit({ name: aborted && mode === 'pause' ? 'TASK_PAUSED' : aborted ? 'TASK_CANCELLED' : 'TASK_FAILED', taskId, payload: { error: message }, timestamp: Date.now() });
      return this.store.get(taskId)!;
    } finally {
      this.controllers.delete(taskId);
      this.cancelModes.delete(taskId);
    }
  }

  /** Shared execution body for submit/startTask (single execution loop). */
  private async executeTask(taskId: string, controller: AbortController): Promise<AgentTask> {
    try {
      const task = this.store.get(taskId)!;
      // PLAN
      const plan = this.planner.makePlan(task.goal);
      if (plan.steps.length > this.maxSteps) {
        plan.steps = plan.steps.slice(0, this.maxSteps);
      }
      this.store.update(taskId, (t) => {
        t.plan = plan;
        t.status = 'running';
      });
      this.events.emit({ name: 'TASK_PLANNED', taskId, payload: { steps: plan.steps.map((s) => ({ id: s.id, toolName: s.toolName, description: s.description })) }, timestamp: Date.now() });

      // PHASE 16: derive + validate the hierarchical plan. Malformed plans
      // never execute (spec §8) — the task fails honestly with the reason.
      if (this.planning) {
        const attached = this.planning.attachPlan(taskId, plan.goal.description, plan.steps);
        if (!attached.ok) {
          this.store.update(taskId, (t) => {
            t.status = 'failed';
            t.error = attached.reason;
            t.completedAt = Date.now();
            t.summary = this.buildSummary(t);
          });
          this.events.emit({ name: 'TASK_FAILED', taskId, payload: { error: attached.reason, reason: 'plan_validation_failed' }, timestamp: Date.now() });
          return this.store.get(taskId)!;
        }
      }

      // ACTION LOOP
      await this.runLoop(task);
      return this.store.get(taskId)!;
    } catch (err: any) {
      const aborted = controller.signal.aborted;
      const message = err?.name === 'AbortError' || aborted ? 'Task cancelled' : String(err?.message || err);
      this.planning?.cancelTask(taskId);
      this.planning?.finishTask(taskId, aborted ? 'cancelled' : 'failed');
      this.store.update(taskId, (t) => {
        t.status = aborted ? 'cancelled' : 'failed';
        t.error = message;
        t.completedAt = Date.now();
        t.summary = this.buildSummary(t);
      });
      this.events.emit({ name: aborted ? 'TASK_CANCELLED' : 'TASK_FAILED', taskId, payload: { error: message }, timestamp: Date.now() });
      return this.store.get(taskId)!;
    } finally {
      this.controllers.delete(taskId);
      this.cancelModes.delete(taskId);
    }
  }

  /**
   * Request cancellation of a running task. mode 'pause' (Phase 19) records
   * the task as 'interrupted' (resumable) instead of terminally cancelled —
   * the long-run manager translates the event into a PAUSED session.
   */
  cancel(taskId: string, mode: 'cancel' | 'pause' = 'cancel'): boolean {
    const controller = this.controllers.get(taskId);
    if (!controller) return false;
    this.cancelModes.set(taskId, mode);
    controller.abort();
    this.planning?.cancelTask(taskId);
    return true;
  }

  /** Cancel every in-flight task (emergency stop). */
  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  isRunning(taskId: string): boolean {
    return this.controllers.has(taskId);
  }

  private async runLoop(task: AgentTask): Promise<void> {
    const controller = this.controllers.get(task.id);
    const signal = controller?.signal ?? new AbortController().signal;

    // Snapshot the plan reference; store.update mutates the same object.
    const taskNow = this.store.get(task.id)!;
    const plan = taskNow.plan!;

    for (let index = 0; index < plan.steps.length; index++) {
      if (signal.aborted) {
        // Phase 19: cancellation mode is read AT cancellation time — a pause
        // request may arrive long after the loop started. Pause leaves pending
        // steps 'pending' (resumable) and stores the task as 'interrupted';
        // cancel marks them terminally 'cancelled'.
        const cancelMode = this.cancelModes.get(task.id) ?? 'cancel';
        if (cancelMode !== 'pause') {
          this.markRemaining(plan, index, 'cancelled');
        }
        this.planning?.cancelTask(task.id);
        this.planning?.finishTask(task.id, 'cancelled');
        this.store.update(task.id, (t) => {
          t.status = cancelMode === 'pause' ? 'interrupted' : 'cancelled';
          if (cancelMode !== 'pause') t.completedAt = Date.now();
          t.summary = this.buildSummary(t);
        });
        this.events.emit({ name: 'TASK_CANCELLED', taskId: task.id, timestamp: Date.now() });
        return;
      }

      const step = plan.steps[index];
      // Phase 19 (resume): steps that already completed/skipped in a previous
      // execution are never re-run; 'failed' and 'cancelled' steps ARE
      // retried on resume (that is the point of resuming — duplicate-action
      // safety is validated by the long-run manager BEFORE resume).
      if (step.status === 'completed' || step.status === 'skipped' || step.status === 'uncertain') {
        continue;
      }
      this.store.update(task.id, (t) => {
        t.currentStepIndex = index;
      });

      const taskBeforeStep = this.store.get(task.id)!;

      // ---- Dependency check (Phase 10): a step whose declared dependencies
      // did not complete is skipped, not blindly executed.
      const unmetDeps = (step.dependsOn ?? []).filter((depId) => {
        const dep = plan.steps.find((s) => s.id === depId);
        return dep ? dep.status !== 'completed' && dep.status !== 'uncertain' : true;
      });
      if (unmetDeps.length > 0) {
        step.status = 'skipped';
        this.planning?.nodeSkipped(task.id, step.id, `unmet dependencies: ${unmetDeps.join(', ')}`);
        this.events.emit({
          name: 'TASK_STEP_SKIPPED',
          taskId: task.id,
          stepId: step.id,
          payload: { description: step.description, reason: `unmet dependencies: ${unmetDeps.join(', ')}` },
          timestamp: Date.now(),
        });
        continue;
      }

      // ---- Dynamic next-step selection (Phase 10): evaluate the run
      // condition against the current task context — skip steps whose
      // objective is already satisfied.
      const condition = evaluateCondition(step.condition, taskBeforeStep.context ?? {});
      if (!condition.run) {
        step.status = 'skipped';
        this.planning?.nodeSkipped(task.id, step.id, condition.reason);
        this.events.emit({
          name: 'TASK_STEP_SKIPPED',
          taskId: task.id,
          stepId: step.id,
          payload: { description: step.description, reason: condition.reason },
          timestamp: Date.now(),
        });
        continue;
      }

      // ---- Tool chaining (Phase 10): resolve {$context} references in the
      // step input against the current task context.
      const taskContext = taskBeforeStep.context ?? {};
      const validation = this.recovery.getContextManager().validateStepInputs(step, taskContext);
      if (!validation.safe) {
        step.status = 'failed';
        step.error = `Context reference invalid or missing: ${[...validation.invalidKeys, ...validation.missingKeys].join(', ')}`;
        this.planning?.nodeFailed(task.id, step.id, step.error, 'invalid_input');
        this.planning?.finishTask(task.id, 'failed');
        const rec = await this.recovery.handleFailure({
          taskId: task.id,
          step,
          error: step.error,
          taskContext,
          signal,
        });
        if (step.outputKey) {
          this.store.update(task.id, (t) => {
            if (t.context && step.outputKey) {
              const updated = { ...t.context };
              delete updated[step.outputKey];
              t.context = updated;
            }
          });
        }
        this.markRemaining(plan, index + 1, 'skipped');
        this.store.update(task.id, (t) => {
          t.status = 'failed';
          t.error = rec.reason || step.error;
          t.completedAt = Date.now();
          t.summary = this.buildSummary(t);
        });
        this.events.emit({ name: 'TASK_FAILED', taskId: task.id, payload: { error: step.error, stepId: step.id }, timestamp: Date.now() });
        return;
      }
      step.input = resolveContextRefs(step.input, taskContext);

      this.planning?.nodeStarted(task.id, step.id);
      const finishedStep = await this.runStepWithRetry(step, taskNow, signal);

      // ---- Context store (Phase 10): bounded output preserved for later steps.
      if (step.outputKey && finishedStep.result && finishedStep.result.output !== undefined) {
        const key = step.outputKey;
        const bounded = boundContextValue(finishedStep.result.output);
        this.store.update(task.id, (t) => {
          t.context = { ...(t.context ?? {}), [key]: bounded };
        });
        if (finishedStep.status === 'completed') {
          this.recovery.getContextManager().markValid(key);
        } else {
          this.recovery.getContextManager().markUnknown(key);
        }
      }

      // PHASE 16: node outcome — verification-aware completion (spec §11).
      if (finishedStep.status === 'completed' || finishedStep.status === 'uncertain') {
        this.planning?.nodeCompleted(
          task.id,
          step.id,
          finishedStep.result,
          finishedStep.status === 'completed' ? 'completed' : 'uncertain'
        );
      }

      if (finishedStep.status === 'cancelled') {
        // Phase 19: pause-mode cancellation stores the task as 'interrupted'
        // (resumable); pending steps stay 'pending' for the validated resume;
        // the long-run manager translates the event to PAUSED. Mode is read
        // AT cancellation time (a pause may arrive mid-step).
        const pauseMode = (this.cancelModes.get(task.id) ?? 'cancel') === 'pause';
        if (!pauseMode) this.markRemaining(plan, index + 1, 'cancelled');
        this.planning?.cancelTask(task.id);
        this.planning?.finishTask(task.id, 'cancelled');
        this.store.update(task.id, (t) => {
          t.status = pauseMode ? 'interrupted' : 'cancelled';
          if (!pauseMode) t.completedAt = Date.now();
          t.summary = pauseMode ? `Paused: ${step.description}` : this.buildSummary(t);
        });
        this.events.emit({ name: 'TASK_CANCELLED', taskId: task.id, timestamp: Date.now() });
        return;
      }

      if (finishedStep.status !== 'completed' && finishedStep.status !== 'uncertain') {
        // PHASE 16: record the failure in the plan tree (root-keyed signature).
        this.planning?.nodeFailed(task.id, step.id, finishedStep.error || 'unknown error', finishedStep.result?.errorKind ?? 'unknown');
        // Invalidate failed step output in context immediately (Phase 11 context safety)
        if (step.outputKey) {
          this.recovery.getContextManager().invalidateOutput(this.store.get(task.id)?.context ?? {}, step.outputKey);
          this.store.update(task.id, (t) => {
            if (t.context && step.outputKey) {
              const updated = { ...t.context };
              delete updated[step.outputKey];
              t.context = updated;
            }
          });
        }

        // Try recovery (Phase 11)
        const recovery = await this.recovery.handleFailure({
          taskId: task.id,
          step,
          error: finishedStep.error || 'unknown error',
          result: finishedStep.result,
          taskContext: this.store.get(task.id)?.context,
          signal,
        });

        if (recovery.recovered) {
          if (recovery.alternativeStep) {
            plan.steps.splice(index + 1, 0, recovery.alternativeStep);
            plan.revision += 1;
            this.planning?.adoptSplicedSteps(task.id, [recovery.alternativeStep]);
            this.events.emit({
              name: 'NOTICE',
              taskId: task.id,
              payload: { message: `Recovered with alternative strategy: ${recovery.alternativeStep.description}` },
              timestamp: Date.now(),
            });
            continue;
          }
          if (recovery.modifiedInput) {
            step.input = recovery.modifiedInput;
            step.status = 'pending';
            step.error = undefined;
            const retried = await this.runStepWithRetry(step, taskNow, signal);
            if (retried.status === 'completed' || retried.status === 'uncertain') {
              if (step.outputKey && retried.result?.output !== undefined) {
                const key = step.outputKey;
                const bounded = boundContextValue(retried.result.output);
                this.store.update(task.id, (t) => {
                  t.context = { ...(t.context ?? {}), [key]: bounded };
                });
                this.recovery.getContextManager().markValid(key);
              }
              this.planning?.nodeCompleted(
                task.id,
                step.id,
                retried.result,
                retried.status === 'completed' ? 'completed' : 'uncertain'
              );
              continue;
            }
          }
          // RE_TRY re-runs the step directly; environment-restoring strategies
          // (re-observe / refocus / browser recovery) restore the world and then
          // re-run the same step against the fresh state.
          if (
            recovery.strategy === 'RETRY' ||
            recovery.strategy === 'RE_OBSERVE' ||
            recovery.strategy === 'REFOCUS' ||
            recovery.strategy === 'BROWSER_RECOVERY'
          ) {
            step.status = 'pending';
            step.error = undefined;
            const retried = await this.runStepWithRetry(step, taskNow, signal);
            if (retried.status === 'completed' || retried.status === 'uncertain') {
              if (step.outputKey && retried.result?.output !== undefined) {
                const key = step.outputKey;
                const bounded = boundContextValue(retried.result.output);
                this.store.update(task.id, (t) => {
                  t.context = { ...(t.context ?? {}), [key]: bounded };
                });
                this.recovery.getContextManager().markValid(key);
              }
              this.planning?.nodeCompleted(
                task.id,
                step.id,
                retried.result,
                retried.status === 'completed' ? 'completed' : 'uncertain'
              );
              continue;
            }
          }
        }

        // PHASE 16: bounded hierarchical replanning — Phase 11 recovery had its
        // chance; now the planner may insert a corrective subtree (diagnose →
        // one retry). When planning is wired, this REPLACES the legacy
        // unbounded fallback so the FAIL→REPLAN loop can never run forever
        // (spec §7). Budget exhausted → honest stop below.
        if (this.planning) {
          const replan = this.planning.proposeReplan(task.id, step.id, finishedStep.error || 'unknown error', finishedStep.result?.errorKind);
          if (replan.replanned && replan.correctiveSteps && replan.correctiveSteps.length > 0) {
            plan.steps.splice(index + 1, 0, ...replan.correctiveSteps);
            this.planning.commitReplan(task.id, step.id, replan.correctiveSteps);
            this.events.emit({
              name: 'NOTICE',
              taskId: task.id,
              payload: { message: `Replanning: ${replan.reason}` },
              timestamp: Date.now(),
            });
            continue;
          }
          // Replan refused (budget/duplicate/permission) → fall through to the
          // honest failure below. The legacy fallback must NOT run after a
          // bounded planner has refused — that would defeat the bound.
        } else {
          // Planner alternative hook (legacy fallback, only without Phase 16)
          const alternative = this.planner.proposeAlternative(step, finishedStep.error || 'unknown error');
          if (alternative) {
            plan.steps.splice(index + 1, 0, alternative);
            plan.revision += 1;
            this.events.emit({ name: 'NOTICE', taskId: task.id, payload: { message: `Retrying with alternative strategy: ${alternative.description}` }, timestamp: Date.now() });
            continue;
          }
        }

        this.markRemaining(plan, index + 1, 'skipped');
        this.planning?.finishTask(task.id, 'failed');
        this.store.update(task.id, (t) => {
          t.status = 'failed';
          // Preserve the actual failure (retry attempts overwrite step.error);
          // recovery.reason is evidence text and must not mask the real cause.
          t.error = `Step ${index + 1} failed: ${step.error || finishedStep.error || recovery.reason || 'unknown error'}`;
          t.completedAt = Date.now();
          t.summary = this.buildSummary(t);
        });
        this.events.emit({ name: 'TASK_FAILED', taskId: task.id, payload: { error: finishedStep.error, stepId: step.id }, timestamp: Date.now() });
        return;
      }

      // ---- Objective completion check (Phase 10): when the plan's evidence
      // key has been produced, the objective is achieved — remaining steps
      // are unnecessary and are skipped rather than blindly executed.
      if (plan.evidenceKey) {
        const ctxNow = this.store.get(task.id)!.context ?? {};
        if (resolveContextPath(ctxNow, plan.evidenceKey) !== undefined) {
          this.markRemaining(plan, index + 1, 'skipped');
          this.planning?.finishTask(task.id, 'completed');
          this.store.update(task.id, (t) => {
            t.status = 'completed';
            t.completedAt = Date.now();
            t.summary = this.buildSummary(t);
          });
          this.events.emit({
            name: 'TASK_COMPLETED',
            taskId: task.id,
            payload: { summary: this.store.get(task.id)?.summary, reason: 'objective evidence produced early' },
            timestamp: Date.now(),
          });
          return;
        }
      }
    }

    this.planning?.finishTask(task.id, 'completed');
    this.store.update(task.id, (t) => {
      t.status = 'completed';
      t.completedAt = Date.now();
      t.summary = this.buildSummary(t);
    });
    this.events.emit({ name: 'TASK_COMPLETED', taskId: task.id, payload: { summary: this.store.get(task.id)?.summary }, timestamp: Date.now() });
  }

  /** Resolve a step to a concrete tool: capability selection first, then direct name. */
  private resolveTool(step: PlanStep, taskId: string): { tool: AgentTool; reason: string } | null {
    if (step.capability) {
      const selection = selectToolForCapability(this.registry, step.capability);
      if (selection) {
        this.events.emit({
          name: 'TOOL_SELECTED',
          taskId,
          stepId: step.id,
          payload: {
            capability: selection.capability,
            tool: selection.tool.name,
            reason: selection.reason,
            candidatesConsidered: selection.candidatesConsidered,
          },
          timestamp: Date.now(),
        });
        return { tool: selection.tool, reason: selection.reason };
      }
    }
    const direct = this.registry.get(step.toolName);
    if (direct) return { tool: direct, reason: `direct tool name "${step.toolName}"` };
    return null;
  }

  private async runStepWithRetry(step: PlanStep, task: AgentTask, signal: AbortSignal): Promise<PlanStep> {
    // Phase 13: a learned workflow may require FRESH screen state for this
    // step — observe once before the tool runs (best-effort; the tool's own
    // verification remains authoritative). Never replays stale observations.
    if (step.observation?.requireFresh && this.adaptive) {
      try {
        await this.adaptive.observe(
          {
            trigger: 'learned_workflow_requirement',
            priority: 'HIGH',
            taskId: task.id,
            stepId: step.id,
            region: (step.observation.region as import('./observation/observationTypes').ObservationRegion) ?? 'full_screen',
            requireFresh: true,
            reason: 'reused workflow step requires fresh screen state',
          },
          signal
        );
      } catch {
        // Observation failure must not block the step — verification still gates it.
      }
    }

    const resolved = this.resolveTool(step, task.id);
    if (!resolved) {
      step.status = 'failed';
      step.error = step.capability
        ? `Unknown tool "${step.toolName}" (no tool available for capability "${step.capability}")`
        : `Unknown tool "${step.toolName}"`;
      step.attempts = 1;
      this.events.emit({ name: 'TOOL_FAILED', taskId: task.id, stepId: step.id, payload: { error: step.error }, timestamp: Date.now() });
      return step;
    }

    const tool = resolved.tool;
    // Tool-specific timeout overrides the core default (spec §10).
    const effectiveTimeout = tool.timeoutMs ?? this.stepTimeoutMs;
    // Tool-specific retry policy overrides the core default (spec §11).
    const maxAttempts = tool.retryPolicy?.maxAttempts ?? this.maxAttemptsPerStep;
    const taskMemory: Record<string, unknown> = {};

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) {
        step.status = 'cancelled';
        step.finishedAt = Date.now();
        this.events.emit({ name: 'TOOL_CANCELLED', taskId: task.id, stepId: step.id, payload: { tool: tool.name }, timestamp: Date.now() });
        return step;
      }

      step.attempts = attempt;
      step.startedAt = Date.now();
      step.status = 'running';
      this.events.emit({ name: 'TASK_STEP_STARTED', taskId: task.id, stepId: step.id, payload: { description: step.description, attempt }, timestamp: Date.now() });
      this.events.emit({ name: 'TOOL_INVOKED', taskId: task.id, stepId: step.id, payload: { tool: tool.name, selectedVia: resolved.reason, input: safePreview(step.input) }, timestamp: Date.now() });

      let result: ToolResult | null = null;
      try {
        result = await withTimeoutAndAbort(
          this.registry.execute(tool.name, step.input, {
            taskId: task.id,
            stepId: step.id,
            signal,
            memory: taskMemory,
            userRequest: task.goal.rawInput,
            relevantMemories: task.memoryContext,
            permissions: this.permissions,
            timeoutMs: effectiveTimeout,
          }),
          { timeoutMs: effectiveTimeout, signal }
        );
      } catch (err: any) {
        if (signal.aborted) {
          step.status = 'cancelled';
          step.finishedAt = Date.now();
          this.events.emit({ name: 'TOOL_CANCELLED', taskId: task.id, stepId: step.id, payload: { tool: tool.name }, timestamp: Date.now() });
          return step;
        }
        const isTimeout = err?.message === 'step_timeout';
        result = {
          success: false,
          error: isTimeout ? `Step timed out after ${effectiveTimeout}ms` : String(err?.message || err),
          errorKind: isTimeout ? 'timeout' : 'execution_error',
          retryable: !isTimeout,
        };
      }

      // VERIFY — never assume success just because the command ran (spec §12).
      const verified = this.verifyStep(step, tool, result);

      if (result.success && verified) {
        // Honest uncertainty (Phase 10): the tool dispatched but could not
        // produce full evidence — recorded as 'uncertain', not 'completed'.
        const uncertain = (result.output as any)?.uncertain === true;
        step.status = uncertain ? 'uncertain' : 'completed';
        step.verified = verified && !uncertain;
        result.verified = verified && !uncertain;
        step.result = result;
        step.error = undefined;
        step.finishedAt = Date.now();
        this.events.emit({ name: 'TOOL_VERIFIED', taskId: task.id, stepId: step.id, payload: { tool: tool.name, strategy: step.verification?.type ?? tool.verification?.strategy ?? 'tool_success', uncertain }, timestamp: Date.now() });
        this.events.emit({ name: 'TASK_STEP_COMPLETED', taskId: task.id, stepId: step.id, payload: { result, uncertain, ui: result.ui ?? [] }, timestamp: Date.now() });
        return step;
      }

      const errorText = result.success
        ? `Verification failed after ${tool.name}`
        : result.error || 'Tool failed';
      step.error = errorText;
      step.result = result;
      step.finishedAt = Date.now();

      this.events.emit({ name: 'TOOL_FAILED', taskId: task.id, stepId: step.id, payload: { tool: tool.name, error: errorText, attempt }, timestamp: Date.now() });

      const canRetry = attempt < maxAttempts && this.isRetryable(result) && !signal.aborted;
      if (canRetry) {
        step.status = 'pending';
        this.events.emit({ name: 'TASK_STEP_RETRY', taskId: task.id, stepId: step.id, payload: { nextAttempt: attempt + 1, error: errorText }, timestamp: Date.now() });
        this.events.emit({ name: 'TOOL_RETRIED', taskId: task.id, stepId: step.id, payload: { tool: tool.name, nextAttempt: attempt + 1, error: errorText }, timestamp: Date.now() });
        await abortableSleep(this.retryDelayMs * attempt, signal);
        continue;
      }

      step.status = signal.aborted ? 'cancelled' : 'failed';
      this.events.emit({ name: 'TASK_STEP_FAILED', taskId: task.id, stepId: step.id, payload: { error: errorText }, timestamp: Date.now() });
      return step;
    }

    step.status = 'failed';
    return step;
  }

  /** Retry decision: explicit tool declaration first, error-kind classification second. */
  private isRetryable(result: ToolResult): boolean {
    if (result.retryable !== undefined) return result.retryable;
    switch (result.errorKind) {
      case 'timeout':
      case 'execution_error':
        return true;
      default:
        return false;
    }
  }

  private verifyStep(step: PlanStep, tool: AgentTool, result: ToolResult): boolean {
    const verification: Verification =
      step.verification ??
      (tool.verification?.strategy === 'output_contains' && tool.verification.expectedOutput
        ? { type: 'output_contains', expected: tool.verification.expectedOutput }
        : { type: 'tool_success' });

    switch (verification.type) {
      case 'tool_success':
        return result.success;
      case 'output_contains': {
        if (!result.success) return false;
        const serialized = JSON.stringify(result.output ?? '').toLowerCase();
        return serialized.includes(verification.expected.toLowerCase());
      }
      default:
        return result.success;
    }
  }

  private markRemaining(plan: { steps: PlanStep[] }, fromIndex: number, status: 'cancelled' | 'skipped'): void {
    for (let i = fromIndex; i < plan.steps.length; i++) {
      if (plan.steps[i].status === 'pending' || plan.steps[i].status === 'running') {
        plan.steps[i].status = status;
      }
    }
  }

  /** Honest, tool-grounded summary — never claims unverified success (spec §40). */
  private buildSummary(task: AgentTask): string {
    const steps = task.plan?.steps ?? [];
    const completed = steps.filter((s) => s.status === 'completed' || s.status === 'uncertain').length;
    const uncertain = steps.filter((s) => s.status === 'uncertain').length;
    const failed = steps.filter((s) => s.status === 'failed').length;
    const cancelled = steps.filter((s) => s.status === 'cancelled').length;

    if (task.status === 'cancelled') {
      return `I stopped the task${completed > 0 ? ` after completing ${completed} of ${steps.length} steps` : ' before starting'}.${cancelled > 0 ? '' : ''}`;
    }

    if (steps.length === 0) {
      return task.status === 'failed' ? `I could not plan that task: ${task.error || 'unknown error'}` : 'Task had no steps.';
    }

    const uncertaintyNote = uncertain > 0 ? ` ${uncertain} step(s) completed with uncertain verification.` : '';

    const lines = steps.map((step, i) => {
      const icon =
        step.status === 'completed' ? 'Done'
        : step.status === 'uncertain' ? 'Done (uncertain — evidence incomplete)'
        : step.status === 'failed' ? `Failed — ${step.error || 'unknown error'}`
        : step.status === 'cancelled' ? 'Stopped'
        : step.status === 'skipped' ? 'Skipped'
        : 'Pending';
      let line = `${i + 1}. ${step.description} — ${icon}`;
      // Surface tool findings (e.g. a screen-analysis summary) in the report.
      const outputSummary = (step.result?.output as any)?.summary;
      if ((step.status === 'completed' || step.status === 'uncertain') && typeof outputSummary === 'string' && outputSummary.trim()) {
        line += `\n   → ${outputSummary.length > 220 ? outputSummary.slice(0, 217) + '...' : outputSummary}`;
      }
      return line;
    });

    const header =
      task.status === 'completed'
        ? `All ${steps.length} steps completed.`
        : task.status === 'failed'
        ? `I completed ${completed} of ${steps.length} steps, then stopped because of a failure.`
        : `Task ended in state "${task.status}".`;

    return `${header}${uncertaintyNote}\n${lines.join('\n')}`;
  }
}

function safePreview(input: Record<string, unknown>): Record<string, unknown> {
  const preview: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const serialized = JSON.stringify(value);
    preview[key] = serialized && serialized.length > 120 ? serialized.slice(0, 117) + '...' : value;
  }
  return preview;
}

function withTimeoutAndAbort<T>(promise: Promise<T>, opts: { timeoutMs: number; signal: AbortSignal }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('step_timeout'));
    }, opts.timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      reject(abortError);
    };

    if (opts.signal.aborted) {
      onAbort();
      return;
    }
    opts.signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
