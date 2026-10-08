/**
 * Memory Consolidation v1 types — bounded, event-driven, deterministic.
 *
 * Consolidation EXTENDS the existing Memory System (MemoryService.remember()
 * remains the only write path for memories — with its worth-assessment, secret
 * rejection, duplicate merging and conflict resolution) and the existing
 * Knowledge Graph (stable ids make graph writes idempotent). The engine only
 * DECIDES what deserves to persist, and observes existing events. No polling,
 * no background work, no second retrieval pipeline.
 */

/** Where a consolidation candidate came from. */
export type ConsolidationSource = 'user_message' | 'task_result';

/** What kind of durable information the candidate represents. */
export type ConsolidationKind = 'preference' | 'decision' | 'project_fact';

/** Observability outcome (spec §17). */
export type ConsolidationAction = 'created' | 'updated' | 'merged' | 'superseded' | 'rejected' | 'ignored';

export type ConsolidationSurface = 'memory' | 'graph' | 'memory+graph';

/** One deterministic classification result. */
export interface ConsolidationClassification {
  kind: ConsolidationKind;
  /** 0..1 starting confidence — before any recurrence bump. */
  confidence: number;
  /** Explainable reason, e.g. 'explicit_preference'. */
  reason: string;
}

/** A structured entity→relation→entity fact (graph-routable). */
export interface StructuredRelation {
  subject: string;
  relation: 'prefers' | 'uses' | 'part_of' | 'depends_on';
  object: string;
}

/** One consolidation outcome record (debugging/tests/observability). */
export interface ConsolidationResult {
  action: ConsolidationAction;
  /** Always present — even for rejections (explainability). */
  reason: string;
  kind?: ConsolidationKind;
  source?: ConsolidationSource;
  confidence?: number;
  surface?: ConsolidationSurface;
  relatedMemoryId?: string;
  replacedMemoryId?: string;
  recurrence?: number;
  /** Intelligence Loop v1 — the task/interaction this outcome belongs to. */
  taskId?: string;
  at: number;
}

/** Explicit limits — laptop-first, all bounded. */
export interface ConsolidationLimits {
  /** Candidates processed per consolidate() input (fact + structured relation). */
  maxCandidatesPerInput: number;
  /** Candidates processed per attached event. */
  maxCandidatesPerEvent: GraphOpsBudget['ops'] | number;
  /** Candidate content cap (chars) — matches the memory system's own limit. */
  maxContentChars: number;
  /** Bounded dedup scan window (most recent valid durable memories). */
  maxScanMemories: number;
  /** Below this confidence a candidate is NOT persisted (recurrence may promote). */
  minConfidence: number;
  /** Structured graph writes require at least this confidence. */
  structuredMinConfidence: number;
  /** Confidence added per repeated consistent sighting (capped). */
  recurrenceBump: number;
  /** Maximum confidence recurrence can reach. */
  maxRecurrenceConfidence: number;
  /** Pending (below-threshold) sightings ledger bound. */
  maxLedgerEntries: number;
  /** Jaccard/containment similarity that counts as a duplicate (memory parity). */
  duplicateThreshold: number;
  /** Similarity + semantic-term co-occurrence that counts as "related exists". */
  semanticRelatedThreshold: number;
  /** Graph node/edge operations per event. */
  maxGraphOpsPerEvent: number;
  /** Words allowed in a structured relation's object phrase. */
  maxObjectWords: number;
  /** Bounded recent-results buffer for observability. */
  maxRecentResults: number;
}

type GraphOpsBudget = { ops: number };

export const DEFAULT_CONSOLIDATION_LIMITS: ConsolidationLimits = {
  maxCandidatesPerInput: 2,
  maxCandidatesPerEvent: 4,
  maxContentChars: 400,
  maxScanMemories: 60,
  minConfidence: 0.7,
  structuredMinConfidence: 0.75,
  recurrenceBump: 0.05,
  maxRecurrenceConfidence: 0.9,
  maxLedgerEntries: 128,
  duplicateThreshold: 0.62,
  semanticRelatedThreshold: 0.35,
  maxGraphOpsPerEvent: 6,
  maxObjectWords: 8,
  maxRecentResults: 32,
};

/** Confidence tiers (spec §7) — deterministic and explainable. */
export const CONSOLIDATION_CONFIDENCE = {
  explicitUserStatement: 0.85,
  explicitUserFact: 0.8,
  taskConfirmedOutcome: 0.75,
  inferredFromTask: 0.55,
} as const;

/** Kind → memory importance (aligned with CATEGORY_IMPORTANCE semantics). */
export const KIND_IMPORTANCE: Record<ConsolidationKind, number> = {
  preference: 0.8,
  decision: 0.75,
  project_fact: 0.6,
};

/** Pending-sightings ledger entry (persisted, bounded, corruption-tolerant). */
export interface LedgerEntry {
  key: string;
  content: string;
  kind: ConsolidationKind;
  source: ConsolidationSource;
  reason: string;
  baseConfidence: number;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface LedgerSchema {
  schemaVersion: number;
  entries: LedgerEntry[];
}

export const CONSOLIDATION_LEDGER_STORAGE_KEY = 'krisha_consolidation_ledger_v1';
export const CONSOLIDATION_LEDGER_SCHEMA_VERSION = 1;
