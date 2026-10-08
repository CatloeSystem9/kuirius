/**
 * Semantic Intelligence v1 types — bounded, local-first, explainable.
 *
 * Semantic Intelligence EXTENDS the existing Context Engine relevance stack
 * (deterministic first → semantic when useful). It is NOT a second relevance
 * system: every expansion carries an explicit tier + confidence, the built-in
 * vocabulary is small and project-focused, and every limit is explicit so the
 * system stays laptop-friendly (no embeddings, no vectors, no background work).
 */

/** Where a semantic association came from. Ordered by trust. */
export type SemanticTier =
  | 'exact' // same normalized term (never inferred — the engine's baseline)
  | 'graph' // derived from an existing verified Knowledge Graph relationship
  | 'alias' // built-in bounded project vocabulary
  | 'learned' // confirmed association from an explicit trusted source
  | 'model'; // optional bounded model-router fallback (off by default)

/** Base confidence per tier. Exact matches bypass this layer entirely. */
export const SEMANTIC_TIER_CONFIDENCE: Record<SemanticTier, number> = {
  exact: 1,
  graph: 0.7,
  alias: 0.6,
  learned: 0.5,
  model: 0.45,
};

/** One semantic expansion: a related term found for a query seed. */
export interface SemanticExpansion {
  /** The query term this expansion was derived from. */
  seed: string;
  /** The related term that should also be considered relevant. */
  term: string;
  tier: SemanticTier;
  /** 0..1 — capped per tier; low-confidence expansions can never outrank direct matches. */
  confidence: number;
  /** Explainability: why this association exists (debugging/tests/observability). */
  reason: string;
}

/** Explicit limits — every collection is bounded by design. */
export interface SemanticLimits {
  /** Query seed terms (concepts) considered per request. */
  maxSeedTerms: number;
  /** Total expansions returned per request. */
  maxExpansions: number;
  /** Seeds forwarded to graph traversal. */
  maxGraphSeeds: number;
  /** Graph neighborhood depth (clamped by the graph's own maxTraversalDepth). */
  maxGraphDepth: number;
  /** Neighbors accepted per graph seed. */
  maxGraphNeighborsPerSeed: number;
  /** Minimum stored-edge confidence for a graph expansion to be trusted. */
  minGraphEdgeConfidence: number;
  /** Learned vocabulary bounds. */
  maxLearnedEntries: number;
  maxLearnedTermsPerConcept: number;
  /** Associations below this confidence are never learned. */
  minLearnedConfidence: number;
  /** Expansion-result cache TTL (served through the existing SessionCache). */
  cacheTtlMs: number;
}

export const DEFAULT_SEMANTIC_LIMITS: SemanticLimits = {
  maxSeedTerms: 6,
  maxExpansions: 8,
  maxGraphSeeds: 3,
  maxGraphDepth: 1,
  maxGraphNeighborsPerSeed: 3,
  minGraphEdgeConfidence: 0.5,
  maxLearnedEntries: 64,
  maxLearnedTermsPerConcept: 8,
  minLearnedConfidence: 0.7,
  cacheTtlMs: 5 * 60_000,
};

/**
 * Ceiling for the semantic contribution to relevance: a semantic overlap of 1
 * counts at most as SEMANTIC_OVERLAP_CAP of a full token overlap, so an exact
 * keyword match always outranks any purely semantic match. Deterministic
 * ranking remains the foundation.
 */
export const SEMANTIC_OVERLAP_CAP = 0.6;

/** Graph-derived expansion handed over by a SemanticGraphSource. */
export interface GraphExpansion {
  seed: string;
  related: Array<{ label: string; relationship: string; confidence: number }>;
}

/**
 * Minimal graph surface the expander consumes. Implemented as an adapter over
 * the existing Knowledge Graph facade — the graph is never dumped, only
 * depth-bounded neighborhoods around nodes that actually match the seeds.
 */
export interface SemanticGraphSource {
  relatedForTerms(terms: string[], limit: number): GraphExpansion[];
  /** Cheap deterministic signature of graph state → cache-key invalidation. */
  signature(): string;
}

/**
 * Optional, bounded model fallback for genuinely hard semantic cases. Must be
 * synchronous, failure-tolerant (return undefined on any problem) and is only
 * consulted when local layers produced nothing for a qualifying intent. The
 * system is fully network-independent when this is absent (the default).
 */
export interface SemanticModelHook {
  related(terms: string[]): Array<{ term: string; related: string[] }> | undefined;
}

export interface SemanticExpandOptions {
  input?: string;
  intent?: string;
  /** Existing SessionCache to reuse (no third cache type is created). */
  cache?: import('../context/contextCache').SessionCache;
  now?: number;
}

/** Persisted learned-vocabulary entry (only confirmed associations). */
export interface LearnedTerm {
  term: string;
  confidence: number;
  source: string;
  updatedAt: number;
}

export interface LearnedEntry {
  concept: string;
  terms: LearnedTerm[];
  updatedAt: number;
}

/** Storage key for the learned vocabulary (versioned). */
export const SEMANTIC_VOCAB_STORAGE_KEY = 'krisha_semantic_vocab_v1';
export const SEMANTIC_VOCAB_SCHEMA_VERSION = 1;

/** Trusted sources allowed to feed the learned vocabulary — nothing else. */
export const TRUSTED_LEARN_SOURCES = new Set(['user_decision', 'task_result', 'memory_confirmed']);
