/**
 * Proactive intelligence (Phase 15) — public surface.
 */
export * from './proactiveTypes';
export { SignalDetector, shortHash } from './proactiveSignals';
export { ProactiveContext, opportunityDedupKey } from './proactiveContext';
export { evaluatePolicy, type PolicyGateResult } from './proactivePolicy';
export { decide, minimumLevelFor, type DecideInput } from './proactiveDecider';
export { ProactiveScheduler, type ScheduledCheck } from './proactiveScheduler';
export {
  executeConfirmed,
  verifyAction,
  verifySuggestionPresented,
  type ActionExecutionResult,
  type ExecutionContextSource,
  type VerifierDeps,
  type VerificationOutcome,
} from './proactiveActions';
export { ProactiveService, type ProactiveServiceOptions, type SuggestionPresentation } from './proactiveService';
