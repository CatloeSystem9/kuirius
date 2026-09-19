/**
 * Recovery Manager (Phase 11 — Error Recovery).
 *
 * Central coordinator for failure detection, classification, strategy evaluation,
 * execution, post-recovery verification, and context safety.
 */
import { classifyFailure } from './recoveryClassifier';
import { RecoveryPolicy } from './recoveryPolicy';
import { RecoveryStrategyExecutor } from './recoveryStrategies';
import { RecoveryContextManager } from './recoveryContext';
import { createRecoveryRecord } from './recoveryTools';
import type {
  FailureType,
  RecoveryAttempt,
  RecoveryDecision,
  RecoveryEvaluationContext,
  RecoveryPolicyOptions,
  RecoveryState,
  RecoveryStrategy,
} from './recoveryTypes';
import type { PlanStep, ToolResult } from '../types';
import type { ToolRegistry } from '../toolRegistry';
import type { AgentEventBus } from '../events';
import type { PermissionManager } from '../permissions';

export interface RecoveryManagerOptions extends RecoveryPolicyOptions {
  registry?: ToolRegistry;
  events?: AgentEventBus;
  permissions?: PermissionManager;
}

export interface RecoveryResult {
  recovered: boolean;
  state: RecoveryState;
  strategy?: RecoveryStrategy;
  failureType?: FailureType;
  alternativeStep?: PlanStep;
  modifiedInput?: Record<string, unknown>;
  safeStop?: boolean;
  reason?: string;
  error?: string;
}

export class RecoveryManager {
  private state: RecoveryState = 'NORMAL';
  private policy: RecoveryPolicy;
  private executor: RecoveryStrategyExecutor;
  private contextManager: RecoveryContextManager;
  private history: RecoveryAttempt[] = [];
  private stepAttempts = new Map<string, number>();
  private taskRecoveryCounts = new Map<string, number>();

  private registry?: ToolRegistry;
  private events?: AgentEventBus;
  private permissions?: PermissionManager;

  constructor(options: RecoveryManagerOptions = {}) {
    this.policy = new RecoveryPolicy(options);
    this.executor = new RecoveryStrategyExecutor();
    this.contextManager = new RecoveryContextManager();
    this.registry = options.registry;
    this.events = options.events;
    this.permissions = options.permissions;
  }

  getState(): RecoveryState {
    return this.state;
  }

  getContextManager(): RecoveryContextManager {
    return this.contextManager;
  }

  getHistory(): RecoveryAttempt[] {
    return [...this.history];
  }

  setRegistry(registry: ToolRegistry): void {
    this.registry = registry;
  }

  setEvents(events: AgentEventBus): void {
    this.events = events;
  }

  setPermissions(permissions: PermissionManager): void {
    this.permissions = permissions;
  }

  /** Reset task-specific recovery tracking. */
  resetTask(taskId: string): void {
    this.taskRecoveryCounts.delete(taskId);
    for (const k of Array.from(this.stepAttempts.keys())) {
      if (k.startsWith(`${taskId}:`)) {
        this.stepAttempts.delete(k);
      }
    }
    this.state = 'NORMAL';
  }

  /**
   * Primary entry point when a step execution fails.
   * Classifies failure, evaluates recovery policy, executes strategy, and verifies.
   */
  async handleFailure(params: {
    taskId: string;
    step: PlanStep;
    error: string;
    result?: ToolResult;
    taskContext?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<RecoveryResult> {
    const { taskId, step, error, result, taskContext, signal } = params;

    // Check cancellation immediately
    if (signal?.aborted) {
      this.state = 'ABORTED';
      this.events?.emit({
        name: 'RECOVERY_ABORTED',
        taskId,
        stepId: step.id,
        payload: { reason: 'Cancellation signal triggered' },
        timestamp: Date.now(),
      });
      return { recovered: false, state: 'ABORTED', error: 'Recovery aborted by cancellation signal' };
    }

    this.state = 'RECOVERING';
    const stepKey = `${taskId}:${step.id}`;
    const stepAttemptCount = (this.stepAttempts.get(stepKey) ?? 0) + 1;
    this.stepAttempts.set(stepKey, stepAttemptCount);

    const taskCount = (this.taskRecoveryCounts.get(taskId) ?? 0) + 1;
    this.taskRecoveryCounts.set(taskId, taskCount);

    // 1. Emit RECOVERY_STARTED
    this.events?.emit({
      name: 'RECOVERY_STARTED',
      taskId,
      stepId: step.id,
      payload: { error, attemptNumber: stepAttemptCount, tool: step.toolName },
      timestamp: Date.now(),
    });

    // 2. Classify failure
    const failureType = classifyFailure({ error, result, step });
    this.events?.emit({
      name: 'RECOVERY_CLASSIFIED',
      taskId,
      stepId: step.id,
      payload: { failureType, error },
      timestamp: Date.now(),
    });

    // 3. Evaluate Policy
    const evalContext: RecoveryEvaluationContext = {
      taskId,
      step,
      error,
      result,
      taskContext,
      stepAttemptCount,
      taskRecoveryCount: taskCount,
      history: this.history,
      signal,
    };

    const decision: RecoveryDecision = this.policy.evaluate(failureType, evalContext);

    this.events?.emit({
      name: 'RECOVERY_STRATEGY_SELECTED',
      taskId,
      stepId: step.id,
      payload: {
        strategy: decision.strategy,
        reason: decision.reason,
        safeStop: decision.safeStop,
      },
      timestamp: Date.now(),
    });

    // 4. Safe Stop Handling
    if (decision.safeStop || decision.strategy === 'SAFE_STOP') {
      this.state = 'FAILED';
      this.contextManager.invalidateOutput(taskContext ?? {}, step.outputKey);

      this.events?.emit({
        name: 'SAFE_STOP_TRIGGERED',
        taskId,
        stepId: step.id,
        payload: { reason: decision.reason, failureType },
        timestamp: Date.now(),
      });

      const attempt = createRecoveryRecord({
        failureType,
        sourceTool: step.toolName,
        taskId,
        stepId: step.id,
        originalAction: step.description,
        attemptNumber: stepAttemptCount,
        recoveryStrategy: 'SAFE_STOP',
        recoveryResult: 'failed',
        verificationResult: false,
        safeToContinue: false,
        details: decision.reason,
      });
      this.history.push(attempt);

      return {
        recovered: false,
        state: 'FAILED',
        strategy: 'SAFE_STOP',
        failureType,
        safeStop: true,
        reason: decision.reason,
        error: decision.reason,
      };
    }

    // 5. Execute Strategy
    this.events?.emit({
      name: 'RECOVERY_ATTEMPTED',
      taskId,
      stepId: step.id,
      payload: { strategy: decision.strategy, attemptNumber: stepAttemptCount },
      timestamp: Date.now(),
    });

    if (decision.requiresReObservation) {
      this.events?.emit({
        name: 'RECOVERY_REOBSERVED',
        taskId,
        stepId: step.id,
        payload: { target: step.input.target || step.toolName },
        timestamp: Date.now(),
      });
    }

    const execResult = await this.executor.execute({
      taskId,
      step,
      decision,
      registry: this.registry,
      events: this.events,
      permissions: this.permissions,
      taskContext,
      signal,
    });

    // 6. Verify Outcome
    this.events?.emit({
      name: 'RECOVERY_VERIFIED',
      taskId,
      stepId: step.id,
      payload: {
        strategy: decision.strategy,
        verified: execResult.verified,
        evidence: execResult.evidence,
      },
      timestamp: Date.now(),
    });

    if (execResult.success && execResult.verified) {
      this.state = 'RECOVERED';
      this.events?.emit({
        name: 'RECOVERY_SUCCEEDED',
        taskId,
        stepId: step.id,
        payload: { strategy: decision.strategy, evidence: execResult.evidence },
        timestamp: Date.now(),
      });

      const attempt = createRecoveryRecord({
        failureType,
        sourceTool: step.toolName,
        taskId,
        stepId: step.id,
        originalAction: step.description,
        attemptNumber: stepAttemptCount,
        recoveryStrategy: decision.strategy,
        recoveryResult: 'succeeded',
        verificationResult: true,
        safeToContinue: true,
        details: execResult.evidence,
      });
      this.history.push(attempt);

      return {
        recovered: true,
        state: 'RECOVERED',
        strategy: decision.strategy,
        failureType,
        alternativeStep: execResult.alternativeStep,
        modifiedInput: execResult.modifiedInput,
        reason: execResult.evidence,
      };
    }

    // Recovery failed
    this.state = 'FAILED';
    this.contextManager.invalidateOutput(taskContext ?? {}, step.outputKey);

    this.events?.emit({
      name: 'RECOVERY_FAILED',
      taskId,
      stepId: step.id,
      payload: {
        strategy: decision.strategy,
        error: execResult.error || 'Recovery action could not be verified',
      },
      timestamp: Date.now(),
    });

    const attempt = createRecoveryRecord({
      failureType,
      sourceTool: step.toolName,
      taskId,
      stepId: step.id,
      originalAction: step.description,
      attemptNumber: stepAttemptCount,
      recoveryStrategy: decision.strategy,
      recoveryResult: 'failed',
      verificationResult: false,
      safeToContinue: false,
      details: execResult.error,
    });
    this.history.push(attempt);

    return {
      recovered: false,
      state: 'FAILED',
      strategy: decision.strategy,
      failureType,
      error: execResult.error || 'Recovery action could not be verified',
      safeStop: true,
    };
  }
}
