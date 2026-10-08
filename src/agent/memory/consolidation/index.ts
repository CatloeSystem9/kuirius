/**
 * Intelligent Memory Consolidation v1 — public API.
 *
 * Event-driven, bounded consolidation of useful interaction/task information
 * into the EXISTING Memory System and Knowledge Graph. The engine decides;
 * MemoryService.remember() and the graph's own validation stay authoritative.
 * No polling, no background work, no new dependencies — fully offline.
 */
export { ConsolidationEngine } from './consolidationEngine';
export type { ConsolidationEngineDeps } from './consolidationEngine';
export {
  classifyCandidate,
  extractStructuredRelation,
  sanitizeCandidate,
  isSpeculative,
  isTemporary,
  isDurableCorrection,
  entityTypeForSubject,
  candidateKey,
} from './consolidationRules';
export {
  DEFAULT_CONSOLIDATION_LIMITS,
  CONSOLIDATION_CONFIDENCE,
  KIND_IMPORTANCE,
  CONSOLIDATION_LEDGER_STORAGE_KEY,
  CONSOLIDATION_LEDGER_SCHEMA_VERSION,
} from './consolidationTypes';
export type {
  ConsolidationSource,
  ConsolidationKind,
  ConsolidationAction,
  ConsolidationSurface,
  ConsolidationResult,
  ConsolidationClassification,
  ConsolidationLimits,
  StructuredRelation,
  LedgerEntry,
} from './consolidationTypes';
