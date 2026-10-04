/**
 * Long-Run Autonomy (Phase 19) — public surface.
 *
 * Persistent, bounded, interruption-safe task sessions over the EXISTING
 * Agent Core: deterministic lifecycle, lightweight checkpoints, validated
 * (never blind) resume, event-driven budgets, resource-efficient adaptive
 * waiting, duplicate-action prevention, and cleanup. Phase 18 safety remains
 * authoritative for every executed or resumed action.
 */
export * from './sessionTypes';
export { TaskSession } from './taskSession';
export { waitUntil } from './waiting';
export type { WaitOptions, WaitResult } from './waiting';
export { LongRunManager } from './longRunManager';
export type { LongRunLimits, SessionDiagnostics, DEFAULT_LONGRUN_LIMITS as LongRunDefaults } from './longRunManager';
export { createLongRunTools } from './longRunTools';
export type { LongRunToolsDeps } from './longRunTools';
