/**
 * Context Engine v1 — public surface.
 *
 * Local-first, cache-first, network-last context selection for the existing
 * Agent Core. Deterministic, dependency-free, bounded; integrates with the
 * existing MemoryService (Phase 2), TaskStore (Phase 1) and StorageAdapter
 * convention. Extensible for future knowledge-graph / learned-skill sources
 * without schema changes.
 */
export type {
  ContextPriority,
  ContextSource,
  NetworkNeed,
  ContextIntent,
  ContextRequirements,
  ContextRequest,
  ContextItem,
  ContextScore,
  ContextBudgetConfig,
  BudgetOutcome,
  ContextPackage,
  CacheEntry,
  CacheGetResult,
  CacheStats,
  ContextEngineOptions,
  ContextCacheLimits,
} from './contextTypes';
export type { StorageAdapter } from '../taskState';
export {
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_CACHE_LIMITS,
  CONTEXT_CACHE_STORAGE_KEY,
  CONTEXT_CACHE_SCHEMA_VERSION,
} from './contextTypes';
export { analyzeContext, extractKeywords, tokenize } from './contextAnalyzer';
export { scoreItem, rankItems, type RankedItem } from './relevanceEngine';
export { packWithinBudget } from './contextBudget';
export {
  buildPackage,
  renderPackageText,
} from './contextBuilder';
export {
  SessionCache,
  PersistentCache,
  cacheKey,
} from './contextCache';
export {
  retrieveCandidates,
  summarizeCacheValue,
  buildSemanticQuery,
  expandedCacheKeywords,
  toItem,
  type RetrieveDeps,
  type ContextEngineMemory,
  type ContextEngineTaskGetter,
} from './contextRetriever';
export { ContextEngine } from './contextEngine';
// Semantic Intelligence v1 — re-exported here so consumers (bridge, tests)
// can reach the whole extension through the existing Context Engine surface.
export {
  SemanticIntelligence,
  LearnedVocabulary,
  findAliasExpansions,
  normalizeTerm,
  semanticOverlapFor,
  semanticGraphSource,
  DEFAULT_SEMANTIC_LIMITS,
  SEMANTIC_TIER_CONFIDENCE,
  SEMANTIC_OVERLAP_CAP,
  SEMANTIC_VOCAB_STORAGE_KEY,
  SEMANTIC_VOCAB_SCHEMA_VERSION,
  TRUSTED_LEARN_SOURCES,
  type SemanticExpansion,
  type SemanticTier,
  type SemanticLimits,
  type SemanticGraphSource,
  type SemanticModelHook,
  type SemanticExpandOptions,
  type SemanticExpandResult,
  type GraphExpansion as SemanticGraphExpansion,
  type LearnedEntry,
  type LearnedTerm,
  type SemanticHit,
  type SemanticIntelligenceOptions,
} from '../semantic';
