/**
 * Error Recovery Types (Phase 11 — Error Recovery).
 *
 * Provides a structured 14-part failure taxonomy, 8 recovery strategies,
 * explicit recovery state machine, and audit structures for deterministic,
 * bounded recovery on Windows.
 */
import type { PlanStep, ToolResult } from '../types';

/** Structured failure classification taxonomy (Phase 11 spec §2). */
export type FailureType =
  | 'TRANSIENT'
  | 'TIMEOUT'
  | 'STALE_STATE'
  | 'TARGET_NOT_FOUND'
  | 'FOCUS_LOST'
  | 'NAVIGATION_CHANGED'
  | 'PERMISSION_DENIED'
  | 'INVALID_INPUT'
  | 'TOOL_FAILURE'
  | 'VERIFICATION_FAILURE'
  | 'DEPENDENCY_FAILURE'
  | 'CONTEXT_FAILURE'
  | 'UNSAFE_OPERATION'
  | 'UNKNOWN';

/** Bounded recovery strategies (Phase 11 spec §3). */
export type RecoveryStrategy =
  | 'RETRY'
  | 'RE_OBSERVE'
  | 'REFOCUS'
  | 'RE_RESOLVE_TARGET'
  | 'BROWSER_RECOVERY'
  | 'ALTERNATIVE_TOOL'
  | 'ROLLBACK'
  | 'SAFE_STOP';

/** Structured recovery state machine (Phase 11 spec §5). */
export type RecoveryState =
  | 'NORMAL'
  | 'RECOVERING'
  | 'RECOVERED'
  | 'FAILED'
  | 'ABORTED';

/** Context item validity indicator (Phase 11 spec §8). */
export type ContextValidity = 'VALID' | 'INVALID' | 'UNKNOWN';

/** Structured record of each recovery attempt. */
export interface RecoveryAttempt {
  failureType: FailureType;
  sourceTool: string;
  taskId: string;
  stepId: string;
  originalAction: string;
  relevantState?: Record<string, unknown>;
  attemptNumber: number;
  recoveryStrategy: RecoveryStrategy;
  recoveryResult: 'succeeded' | 'failed' | 'aborted';
  verificationResult?: boolean;
  timestamp: number;
  safeToContinue: boolean;
  details?: string;
}

/** Configurable budget limits for recovery. */
export interface RecoveryPolicyOptions {
  maxAttemptsPerStep?: number;
  maxAttemptsPerTask?: number;
  maxRepeatedIdenticalFailures?: number;
  recoveryTimeoutMs?: number;
  maxAlternativeStrategies?: number;
}

/** Decision returned by the recovery policy. */
export interface RecoveryDecision {
  strategy: RecoveryStrategy;
  reason: string;
  failureType: FailureType;
  alternativeStep?: PlanStep;
  modifiedInput?: Record<string, unknown>;
  requiresReObservation?: boolean;
  safeStop: boolean;
}

/** Context information passed into recovery evaluation. */
export interface RecoveryEvaluationContext {
  taskId: string;
  step: PlanStep;
  error: string;
  result?: ToolResult;
  taskContext?: Record<string, unknown>;
  stepAttemptCount: number;
  taskRecoveryCount: number;
  history: RecoveryAttempt[];
  signal?: AbortSignal;
}
