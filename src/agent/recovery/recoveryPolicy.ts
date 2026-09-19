/**
 * Recovery Policy (Phase 11 — Error Recovery).
 *
 * Enforces recovery budgets, determines recoverable vs. unrecoverable failures,
 * and guarantees idempotency/duplicate-action protection so side-effecting
 * actions are never blindly repeated.
 */
import type {
  FailureType,
  RecoveryDecision,
  RecoveryEvaluationContext,
  RecoveryPolicyOptions,
  RecoveryStrategy,
} from './recoveryTypes';

const DEFAULT_MAX_ATTEMPTS_PER_STEP = 2;
const DEFAULT_MAX_ATTEMPTS_PER_TASK = 6;
const DEFAULT_MAX_REPEATED_IDENTICAL = 2;
const DEFAULT_RECOVERY_TIMEOUT_MS = 15000;

/** Actions that modify external state — must never be blindly retried without re-observation. */
const SIDE_EFFECTING_CAPABILITIES = new Set([
  'computer.click',
  'computer.double_click',
  'computer.right_click',
  'computer.drag',
  'keyboard.type',
  'keyboard.press_key',
  'keyboard.hotkey',
  'keyboard.paste',
  'browser.click',
  'browser.type',
  'filesystem.create',
  'filesystem.rename',
  'filesystem.copy',
  'filesystem.move',
  'filesystem.delete',
  'application.launch',
  'application.close',
]);

export class RecoveryPolicy {
  private maxAttemptsPerStep: number;
  private maxAttemptsPerTask: number;
  private maxRepeatedIdentical: number;
  private recoveryTimeoutMs: number;

  constructor(options: RecoveryPolicyOptions = {}) {
    this.maxAttemptsPerStep = options.maxAttemptsPerStep ?? DEFAULT_MAX_ATTEMPTS_PER_STEP;
    this.maxAttemptsPerTask = options.maxAttemptsPerTask ?? DEFAULT_MAX_ATTEMPTS_PER_TASK;
    this.maxRepeatedIdentical = options.maxRepeatedIdenticalFailures ?? DEFAULT_MAX_REPEATED_IDENTICAL;
    this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS;
  }

  /** Decide the appropriate recovery action for a classified failure. */
  evaluate(failureType: FailureType, context: RecoveryEvaluationContext): RecoveryDecision {
    // 1. Budget guards
    if (context.stepAttemptCount >= this.maxAttemptsPerStep) {
      return {
        strategy: 'SAFE_STOP',
        failureType,
        reason: `Recovery attempt budget exceeded for step (${context.stepAttemptCount}/${this.maxAttemptsPerStep})`,
        safeStop: true,
      };
    }

    if (context.taskRecoveryCount >= this.maxAttemptsPerTask) {
      return {
        strategy: 'SAFE_STOP',
        failureType,
        reason: `Global task recovery budget exceeded (${context.taskRecoveryCount}/${this.maxAttemptsPerTask})`,
        safeStop: true,
      };
    }

    const identicalCount = context.history.filter(
      (h) => h.stepId === context.step.id && h.failureType === failureType
    ).length;
    if (identicalCount >= this.maxRepeatedIdentical) {
      return {
        strategy: 'SAFE_STOP',
        failureType,
        reason: `Repeated identical failure limit reached for ${failureType} (${identicalCount} occurrences)`,
        safeStop: true,
      };
    }

    // 2. Non-recoverable failures -> immediate SAFE_STOP
    if (failureType === 'PERMISSION_DENIED') {
      return {
        strategy: 'SAFE_STOP',
        failureType,
        reason: 'Permission boundary cannot be bypassed during recovery',
        safeStop: true,
      };
    }

    if (failureType === 'UNSAFE_OPERATION') {
      return {
        strategy: 'SAFE_STOP',
        failureType,
        reason: 'Unsafe or prohibited operation requested — halting for safety',
        safeStop: true,
      };
    }

    if (failureType === 'INVALID_INPUT') {
      return {
        strategy: 'SAFE_STOP',
        failureType,
        reason: `Invalid input or validation failure cannot be automatically fixed: ${context.error}`,
        safeStop: true,
      };
    }

    if (failureType === 'DEPENDENCY_FAILURE') {
      return {
        strategy: 'SAFE_STOP',
        failureType,
        reason: 'Prerequisite step did not succeed — downstream step cannot proceed',
        safeStop: true,
      };
    }

    if (failureType === 'CONTEXT_FAILURE') {
      return {
        strategy: 'SAFE_STOP',
        failureType,
        reason: 'Required context value is missing or invalid — halting to prevent cascading error',
        safeStop: true,
      };
    }

    // 3. Stale state & Focus issues
    if (failureType === 'FOCUS_LOST') {
      return {
        strategy: 'REFOCUS',
        failureType,
        reason: 'Target application lost foreground focus — restoring focus before re-observation',
        requiresReObservation: true,
        safeStop: false,
      };
    }

    if (failureType === 'STALE_STATE') {
      return {
        strategy: 'RE_OBSERVE',
        failureType,
        reason: 'Environment/screen state is stale — re-observing fresh state before acting',
        requiresReObservation: true,
        safeStop: false,
      };
    }

    if (failureType === 'NAVIGATION_CHANGED') {
      return {
        strategy: 'BROWSER_RECOVERY',
        failureType,
        reason: 'Browser navigation changed unexpectedly — inspecting page state and recovering URL',
        requiresReObservation: true,
        safeStop: false,
      };
    }

    if (failureType === 'TARGET_NOT_FOUND') {
      return {
        strategy: 'RE_RESOLVE_TARGET',
        failureType,
        reason: 'Target element or path not found — re-observing environment to re-resolve target',
        requiresReObservation: true,
        safeStop: false,
      };
    }

    // 4. Idempotency guard for Timeouts and Verification Failures
    const capability = context.step.capability || context.step.toolName;
    const isSideEffecting = SIDE_EFFECTING_CAPABILITIES.has(capability);

    if (failureType === 'TIMEOUT') {
      if (isSideEffecting) {
        // May have dispatched or partially succeeded — do not blind retry!
        return {
          strategy: 'RE_OBSERVE',
          failureType,
          reason: `Timed out during side-effecting action "${capability}" — re-observing to check if effect occurred`,
          requiresReObservation: true,
          safeStop: false,
        };
      }
      return {
        strategy: 'RETRY',
        failureType,
        reason: `Read-only action timed out — safe to retry with timeout budget`,
        safeStop: false,
      };
    }

    if (failureType === 'VERIFICATION_FAILURE') {
      if (isSideEffecting) {
        return {
          strategy: 'RE_OBSERVE',
          failureType,
          reason: `Verification failed after side-effecting action "${capability}" — re-observing state before any retry`,
          requiresReObservation: true,
          safeStop: false,
        };
      }
      return {
        strategy: 'RETRY',
        failureType,
        reason: 'Verification failed for read-only action — retrying',
        safeStop: false,
      };
    }

    if (failureType === 'TRANSIENT') {
      return {
        strategy: 'RETRY',
        failureType,
        reason: 'Transient network or system error — safely retrying',
        safeStop: false,
      };
    }

    // 5. Tool Failure / Unknown
    return {
      strategy: 'SAFE_STOP',
      failureType,
      reason: `Unrecoverable tool failure: ${context.error}`,
      safeStop: true,
    };
  }

  getTimeoutMs(): number {
    return this.recoveryTimeoutMs;
  }
}
