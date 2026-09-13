/**
 * Memory layer types (Phase 2).
 * Lightweight structured records — no heavyweight database.
 */

export type MemoryCategory =
  | 'short_term'
  | 'long_term'
  | 'preference'
  | 'episodic'
  | 'workflow'
  | 'correction'
  | 'semantic';

export type MemorySource =
  | 'user_manual'       // typed into the Memory UI
  | 'user_correction'   // "don't do X, always do Y"
  | 'conversation_extract' // server /api/memory/extract (LLM or heuristic)
  | 'agent_task'        // episodic record of a completed agent task
  | 'workflow_learning' // derived from repeated task patterns
  | 'legacy_migrated'   // imported from the v1 string[] store
  | 'system_seed';      // DEFAULT_MEMORIES seeds

export interface WorkflowMetadata {
  steps: string[];
  tools: string[];
  trigger?: string;
  successCount?: number;
  lastSuccessfulAt?: number;
  notes?: string;
}

export interface MemoryRecord {
  id: string;
  category: MemoryCategory;
  content: string;
  createdAt: number;
  updatedAt: number;
  importance: number;   // 0..1 — how much this should influence behavior
  confidence: number;   // 0..1 — how sure we are it is accurate/current
  source: MemorySource;
  tags?: string[];
  usageCount: number;
  lastUsedAt?: number;
  valid: boolean;       // false = invalidated or superseded (hidden from UI)
  supersededBy?: string;
  metadata?: Record<string, unknown> & Partial<WorkflowMetadata>;
}

/** Serialized store envelope with lightweight schema versioning. */
export interface MemoryStoreSchema {
  schemaVersion: number;
  records: MemoryRecord[];
}

export const MEMORY_SCHEMA_VERSION = 2;
export const MEMORY_STORAGE_KEY = 'krisha_agent_memory_v2';
export const LEGACY_MEMORY_KEY = 'krisha_memories_v1';

/** Hard cap: keep memory lightweight on a laptop. */
export const MAX_MEMORY_RECORDS = 400;
export const MAX_DISPLAY_MEMORIES = 200;

export interface MemoryConflict {
  id: string;
  recordA: string; // memory id
  recordB: string; // memory id
  subject: string; // what the conflict is about, human-readable
  description: string;
  resolved: boolean;
  createdAt: number;
}

export const CATEGORY_IMPORTANCE: Record<MemoryCategory, number> = {
  short_term: 0.3,
  long_term: 0.6,
  preference: 0.8,
  episodic: 0.45,
  workflow: 0.6,
  correction: 0.85,
  semantic: 0.5,
};

export const SOURCE_CONFIDENCE: Record<MemorySource, number> = {
  user_manual: 0.9,
  user_correction: 0.85,
  conversation_extract: 0.65,
  agent_task: 0.7,
  workflow_learning: 0.6,
  legacy_migrated: 0.7,
  system_seed: 0.75,
};
