/**
 * Error Classifier (Phase 11 — Error Recovery).
 *
 * Deterministically maps raw runtime errors, tool results, and step context
 * into the 14-part failure taxonomy without logging sensitive credentials.
 */
import type { FailureType } from './recoveryTypes';
import type { PlanStep, ToolResult } from '../types';

export interface ClassificationInput {
  error: string;
  result?: ToolResult;
  step?: PlanStep;
}

/** Classify a failure into one of the 14 structured failure types. */
export function classifyFailure(input: ClassificationInput): FailureType {
  const err = (input.error || '').toLowerCase();
  const errorKind = input.result?.errorKind;

  // 1. Permission Denied
  if (
    errorKind === 'permission_denied' ||
    err.includes('permission_denied') ||
    err.includes('permission denied') ||
    err.includes('not permitted') ||
    err.includes('unauthorized') ||
    err.includes('eacces')
  ) {
    return 'PERMISSION_DENIED';
  }

  // 2. Unsafe Operation
  if (
    err.includes('unsafe') ||
    err.includes('destructive') ||
    err.includes('high_risk') ||
    err.includes('prohibited operation') ||
    err.includes('security boundary')
  ) {
    return 'UNSAFE_OPERATION';
  }

  // 3. Timeout
  if (
    errorKind === 'timeout' ||
    err.includes('step_timeout') ||
    err.includes('timed out') ||
    err.includes('timeout after') ||
    err.includes('operation timed out')
  ) {
    return 'TIMEOUT';
  }

  // 4. Focus Lost / Window changed
  if (
    err.includes('focus') ||
    err.includes('active window') ||
    err.includes('foreground') ||
    err.includes('wrong window') ||
    err.includes('window changed') ||
    err.includes('unrecognized foreground')
  ) {
    return 'FOCUS_LOST';
  }

  // 5. Stale State
  if (
    err.includes('stale') ||
    err.includes('disappeared') ||
    err.includes('element moved') ||
    err.includes('state changed') ||
    err.includes('signature mismatch')
  ) {
    return 'STALE_STATE';
  }

  // 6. Navigation Changed
  if (
    err.includes('navigation changed') ||
    err.includes('navigated unexpectedly') ||
    err.includes('wrong page') ||
    err.includes('unexpected redirect') ||
    err.includes('url mismatch')
  ) {
    return 'NAVIGATION_CHANGED';
  }

  // 7. Target Not Found
  if (
    err.includes('not found') ||
    err.includes('target not found') ||
    err.includes('missing element') ||
    err.includes('no match') ||
    err.includes('element not found') ||
    err.includes('enoent') ||
    err.includes('no such file')
  ) {
    return 'TARGET_NOT_FOUND';
  }

  // 8. Invalid Input / Validation Failure
  if (
    errorKind === 'invalid_input' ||
    err.includes('invalid input') ||
    err.includes('invalid argument') ||
    err.includes('validation error') ||
    err.includes('bad parameter') ||
    err.includes('out of range')
  ) {
    return 'INVALID_INPUT';
  }

  // 9. Dependency Failure
  if (
    err.includes('unmet dependencies') ||
    err.includes('dependency failed') ||
    err.includes('unmet dependency')
  ) {
    return 'DEPENDENCY_FAILURE';
  }

  // 10. Context Failure
  if (
    err.includes('context reference') ||
    err.includes('$context') ||
    err.includes('context lacks') ||
    err.includes('context key missing') ||
    err.includes('unresolved context')
  ) {
    return 'CONTEXT_FAILURE';
  }

  // 11. Verification Failure
  if (
    (input.result && input.result.success && input.result.verified === false) ||
    err.includes('verification failed') ||
    err.includes('verification mismatch') ||
    err.includes('expected output not present') ||
    err.includes('unverified')
  ) {
    return 'VERIFICATION_FAILURE';
  }

  // 12. Transient Network / System Issues
  if (
    err.includes('econnrefused') ||
    err.includes('econnreset') ||
    err.includes('epipe') ||
    err.includes('etimedout') ||
    err.includes('network error') ||
    err.includes('transient') ||
    err.includes('connection lost')
  ) {
    return 'TRANSIENT';
  }

  // 13. Tool Internal Failure
  if (
    errorKind === 'execution_error' ||
    err.includes('tool failed') ||
    err.includes('backend failed') ||
    err.includes('exception thrown')
  ) {
    return 'TOOL_FAILURE';
  }

  return 'UNKNOWN';
}
