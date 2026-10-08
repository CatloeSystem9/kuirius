/**
 * Context Engine types (Context Engine v1) — local-first, cache-first,
 * network-last context selection for the existing Agent Core.
 *
 * Design constraints:
 *  - ZERO new dependencies; reuses the existing StorageAdapter convention
 *    (taskState.ts) and MemoryService recall for retrieval.
 *  - Deterministic scoring/budgeting (no model calls, no embeddings).
 *  - Bounded: every collection has an explicit cap; the persistent cache has
 *    TTL + size limits + corruption handling; the session cache never
 *    survives a restart.
 *  - Extensible: ContextSource/ContextItem leave room for future systems
 *    (knowledge graph, learned skills, project awareness) without schema
 *    changes.
 */

/** Information priority tiers used by the budget manager. */
export type ContextPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

/** Where a context item came from. Extensible for future sources. */
export type ContextSource =
  | 'user' // current instruction / explicit user importance
  | 'constraints' // safety + permission constraints (always P0)
  | 'task_state' // active task goal/state/plan
  | 'tool_state' // recent structured tool results for this task
  | 'memory' // persistent MemoryService records
  | 'conversation' // recent chat turns
  | 'project_files' // locally indexed project files (future use)
  | 'environment' // app/browser/environment state (future use)
  | 'cached_knowledge' // previously retrieved/cached external info
  | 'knowledge_graph'; // Knowledge Graph v1 relational statements

/** How fresh external information must be for this request. */
export type NetworkNeed = 'none' | 'optional' | 'required';

export type ContextIntent =
  | 'chitchat'
  | 'question'
  | 'research'
  | 'diagnose'
  | 'create_or_modify'
  | 'device_task'
  | 'memory_query';

/** What the analyzer decided the request actually requires. */
export interface ContextRequirements {
  intent: ContextIntent;
  /** Keywords/terms that define relevance for this request. */
  keywords: string[];
  needsMemory: boolean;
  needsTaskState: boolean;
  needsConversation: boolean;
  needsToolState: boolean;
  needsEnvironment: boolean;
  needsProjectFiles: boolean;
  networkNeed: NetworkNeed;
  networkReason: string;
  /** Whether stale cached data is acceptable (vs fresh retrieval required). */
  staleTolerant: boolean;
  complexity: 'simple' | 'moderate' | 'complex';
}

/** The user request plus the surrounding state the caller already holds. */
export interface ContextRequest {
  input: string;
  taskId?: string;
  /** Recent conversation turns (most recent last). Already available to callers. */
  conversation?: Array<{ role: 'user' | 'model'; content: string; timestamp?: number }>;
  /** Explicit constraint lines that must never be dropped (P0). */
  constraints?: string[];
  now?: number;
}

/** A single candidate piece of context. */
export interface ContextItem {
  id: string;
  source: ContextSource;
  content: string;
  priority: ContextPriority;
  timestamp: number;
  /** Approximate size in characters (≈ tokens/4 for budgeting). */
  chars: number;
  /** Explicit user/system importance 0..1 when known. */
  importance?: number;
  /** Set when the underlying data is past its freshness window. */
  stale?: boolean;
  /** Cache key when the item came from the cache layers. */
  cacheKey?: string;
  /** Semantic Intelligence v1: why this item matched (explainability/debug). */
  matchReason?: string;
  metadata?: Record<string, unknown>;
}

/** Deterministic relevance score for one item. */
export interface ContextScore {
  /** 0..1 — higher is more relevant. */
  total: number;
  overlap: number;
  recency: number;
  sourceWeight: number;
  importance: number;
  stalenessPenalty: number;
  /**
   * Semantic Intelligence v1: the best semantic expansion confidence that hit
   * this item (0 when none). Already capped inside `overlap` — see
   * relevanceEngine — so exact matches always outrank semantic ones.
   */
  semanticOverlap?: number;
  /** Explainability: why this item was considered relevant (debug/tests). */
  matchReason?: string;
}

export interface ContextBudgetConfig {
  /** Hard cap on total rendered context characters. */
  maxChars: number;
  /** Per-priority character caps. */
  priorityCaps: Record<ContextPriority, number>;
  /** Priorities that may be word-truncated to fit (P0/P1 are never truncated). */
  truncatable: ContextPriority[];
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
  maxChars: 4000,
  priorityCaps: { P0: 1500, P1: 1800, P2: 1000, P3: 500, P4: 0 },
  truncatable: ['P2', 'P3'],
};

export interface BudgetOutcome {
  kept: ContextItem[];
  dropped: ContextItem[];
  charsUsed: number;
  truncatedItems: number;
}

/** The structured package the engine produces for one request. */
export interface ContextPackage {
  request: string;
  currentGoal?: string;
  activeTaskId?: string;
  requirements: ContextRequirements;
  relevantMemories: string[];
  relevantConversation: string[];
  relevantFiles: string[];
  relevantToolState: string[];
  environmentState: string[];
  cachedKnowledge: string[];
  /** Knowledge Graph v1 relational statements (when the provider is wired). */
  knowledgeGraph?: string[];
  constraints: string[];
  metadata: {
    generatedAt: number;
    networkRequired: boolean;
    networkReason: string;
    staleTolerant: boolean;
    candidatesConsidered: number;
    itemsKept: number;
    itemsDropped: number;
    charsUsed: number;
    budgetCap: number;
    staleCount: number;
    /** Sources that were skipped because the analyzer did not require them. */
    skippedSources: ContextSource[];
  };
}

/** Persistent + session cache entry (two-type cache system). */
export interface CacheEntry<V = unknown> {
  key: string;
  value: V;
  createdAt: number;
  updatedAt: number;
  /** Absolute expiry; 0 = no expiry (still size-managed). */
  expiresAt: number;
  source: string;
  /** Observed chars of the JSON value — used for size accounting. */
  sizeChars: number;
  hits: number;
  tags?: string[];
}

export interface CacheGetResult<V = unknown> {
  hit: boolean;
  value?: V;
  entry?: CacheEntry<V>;
  /** True when served past its TTL under explicit stale tolerance. */
  stale?: boolean;
}

export interface CacheStats {
  session: { size: number; hits: number; misses: number; evictions: number };
  persistent: { size: number; chars: number; hits: number; misses: number; evictions: number; expired: number };
}

export interface ContextEngineOptions {
  /** Existing memory service (Phase 2) — reused, never duplicated. */
  memory?: { recall(query: string, options?: { limit?: number }): Array<{ content: string; createdAt?: number; updatedAt?: number; importance?: number; category?: string }> };
  /** Existing task store — targeted active-task retrieval. */
  taskStore?: { get(id: string): { goal?: { description?: string }; status?: string; memoryContext?: string[]; context?: Record<string, unknown> } | undefined };
  /** Storage adapter for the PERSISTENT cache (localStorage in the browser, file on the server). */
  cacheStorage?: import('../taskState').StorageAdapter;
  /**
   * Knowledge Graph v1 provider — targeted relational statements for this
   * request. Optional and failure-isolated; never replaces memory retrieval.
   */
  knowledge?: { query(input: string, limit?: number): string[] };
  /**
   * Semantic Intelligence v1 — lightweight LOCAL expansion layered UNDER the
   * deterministic relevance stack. Optional; when absent the engine creates a
   * minimal default instance (built-in vocabulary only, fully offline).
   */
  semantic?: import('../semantic/semanticExpander').SemanticIntelligence;
  now?: () => number;
  budget?: Partial<ContextBudgetConfig>;
  cache?: Partial<ContextCacheLimits>;
}

export interface ContextCacheLimits {
  sessionMaxEntries: number;
  sessionTtlMs: number;
  persistentMaxEntries: number;
  persistentMaxTotalChars: number;
  persistentDefaultTtlMs: number;
  /** Expired entries may still be served (marked stale) up to this multiple of their TTL. */
  staleOverstayFactor: number;
}

export const DEFAULT_CACHE_LIMITS: ContextCacheLimits = {
  sessionMaxEntries: 64,
  sessionTtlMs: 10 * 60_000,
  persistentMaxEntries: 128,
  persistentMaxTotalChars: 400_000,
  persistentDefaultTtlMs: 24 * 60 * 60_000,
  staleOverstayFactor: 2,
};

/** Storage key for the persistent cache (versioned). */
export const CONTEXT_CACHE_STORAGE_KEY = 'krisha_context_cache_v1';
export const CONTEXT_CACHE_SCHEMA_VERSION = 1;
