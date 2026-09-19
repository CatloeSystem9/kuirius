/**
 * Recovery Tools & Helpers (Phase 11 — Error Recovery).
 *
 * Reusable utility functions for Computer-Use, Browser, and System agents
 * to interact with the recovery subsystem uniformly.
 */
import { classifyFailure } from './recoveryClassifier';
import type { FailureType, RecoveryAttempt, RecoveryStrategy } from './recoveryTypes';
import type { ToolResult } from '../types';

/** Safe record creation without leaking sensitive data. */
export function createRecoveryRecord(opts: {
  failureType: FailureType;
  sourceTool: string;
  taskId: string;
  stepId: string;
  originalAction: string;
  attemptNumber: number;
  recoveryStrategy: RecoveryStrategy;
  recoveryResult: 'succeeded' | 'failed' | 'aborted';
  verificationResult?: boolean;
  safeToContinue: boolean;
  details?: string;
}): RecoveryAttempt {
  return {
    failureType: opts.failureType,
    sourceTool: opts.sourceTool,
    taskId: opts.taskId,
    stepId: opts.stepId,
    originalAction: sanitizeAction(opts.originalAction),
    attemptNumber: opts.attemptNumber,
    recoveryStrategy: opts.recoveryStrategy,
    recoveryResult: opts.recoveryResult,
    verificationResult: opts.verificationResult,
    timestamp: Date.now(),
    safeToContinue: opts.safeToContinue,
    details: opts.details ? sanitizeAction(opts.details) : undefined,
  };
}

/** Sanitize action strings to prevent secrets, passwords, or tokens from appearing in recovery records. */
export function sanitizeAction(text: string): string {
  if (!text) return '';
  return text
    .replace(/(?:password|secret|token|api[_-]?key|bearer)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]')
    .replace(/bearer\s+[a-zA-Z0-9._~+/=-]+/gi, 'bearer [REDACTED]')
    .slice(0, 500);
}

/** Check if an error message represents a recoverable condition. */
export function isRecoverable(error: string, result?: ToolResult): boolean {
  const failureType = classifyFailure({ error, result });
  return (
    failureType !== 'PERMISSION_DENIED' &&
    failureType !== 'UNSAFE_OPERATION' &&
    failureType !== 'INVALID_INPUT' &&
    failureType !== 'DEPENDENCY_FAILURE' &&
    failureType !== 'CONTEXT_FAILURE'
  );
}
