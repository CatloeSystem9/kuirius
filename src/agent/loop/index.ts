/**
 * Intelligence Loop v1 — public API.
 *
 * This is NOT a new intelligence subsystem: it is the thin coordination layer
 * that connects the EXISTING systems into one closed loop —
 * Context Engine (understand/context), Agent Core (plan/execute/verify),
 * Recovery (failure handling), Consolidation (learning) — plus bounded
 * cycle observability. All limits and rules of the underlying systems remain
 * authoritative.
 */
export {
  CycleTraceStore,
  MAX_CYCLE_TRACES,
  MAX_TRACE_STAGES,
  MAX_TRACE_DETAIL_CHARS,
} from './cycleTrace';
export type { CycleStage, CycleStageRecord, CycleTrace } from './cycleTrace';
