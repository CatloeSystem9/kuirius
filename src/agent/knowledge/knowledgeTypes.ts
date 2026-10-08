/**
 * Knowledge Graph v1 types — local-first, bounded, deterministic.
 *
 * The graph stores RELATIONSHIPS between Krisha entities, complementing (never
 * replacing) the Memory System: memory keeps information, the graph keeps how
 * information is connected. Zero dependencies; persistence rides the existing
 * StorageAdapter convention; deterministic stable ids via the routing hashKey.
 */

/** Entity ontology v1 — intentionally small. */
export type EntityType =
  | 'person'
  | 'project'
  | 'task'
  | 'goal'
  | 'memory'
  | 'file'
  | 'component'
  | 'tool'
  | 'decision'
  | 'result'
  | 'resource';

export const ENTITY_TYPES: readonly EntityType[] = [
  'person', 'project', 'task', 'goal', 'memory', 'file',
  'component', 'tool', 'decision', 'result', 'resource',
];

/**
 * Relationship ontology v1: the 14 baseline relations plus `prefers` and
 * `applies_to`, which the spec's own examples rely on. Adding future
 * relationship types is a one-line union change — no architectural impact.
 */
export type RelationshipType =
  | 'owns'
  | 'belongs_to'
  | 'part_of'
  | 'depends_on'
  | 'related_to'
  | 'uses'
  | 'produces'
  | 'created_by'
  | 'modified_by'
  | 'supports'
  | 'blocks'
  | 'derived_from'
  | 'replaces'
  | 'supersedes'
  | 'prefers'
  | 'applies_to';

export const RELATIONSHIP_TYPES: readonly RelationshipType[] = [
  'owns', 'belongs_to', 'part_of', 'depends_on', 'related_to', 'uses',
  'produces', 'created_by', 'modified_by', 'supports', 'blocks',
  'derived_from', 'replaces', 'supersedes', 'prefers', 'applies_to',
];

/** A graph node. Small by design — references existing info, never copies it. */
export interface KnowledgeNode {
  id: string;
  type: EntityType;
  label: string;
  properties?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** A directed, typed relationship between two nodes. */
export interface KnowledgeEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relationship: RelationshipType;
  /** 0..1 — explicit user decisions are highest; derived patterns lower. */
  confidence?: number;
  /** Where this relationship came from (e.g. 'user_decision', 'task_result'). */
  source?: string;
  createdAt: number;
  updatedAt: number;
}

/** Bounded graph limits (laptop-friendly defaults). */
export interface KnowledgeGraphLimits {
  maxNodes: number;
  maxEdges: number;
  maxPropertiesPerNode: number;
  maxPropertyValueChars: number;
  maxLabelChars: number;
  /** Default traversal depth for path/neighborhood queries. */
  maxTraversalDepth: number;
  /** Default cap for query result sets. */
  maxQueryResults: number;
  /** Nodes/edges indexed per event by the extraction indexer (bounded). */
  maxExtractionsPerEvent: number;
}

export const DEFAULT_KNOWLEDGE_LIMITS: KnowledgeGraphLimits = {
  maxNodes: 500,
  maxEdges: 1500,
  maxPropertiesPerNode: 8,
  maxPropertyValueChars: 300,
  maxLabelChars: 200,
  maxTraversalDepth: 3,
  maxQueryResults: 10,
  maxExtractionsPerEvent: 8,
};

/** Structured graph result the Context Engine consumes (spec §16). */
export interface KnowledgeContext {
  nodes: KnowledgeNode[];
  relationships: KnowledgeEdge[];
  relevanceScore: number;
  source: 'knowledge-graph';
}

export interface KnowledgeGraphOptions {
  storage?: import('../taskState').StorageAdapter;
  limits?: Partial<KnowledgeGraphLimits>;
  now?: () => number;
}

export interface KnowledgeStats {
  nodes: number;
  edges: number;
  byType: Record<string, number>;
  evictedNodes: number;
  evictedEdges: number;
  corruptedEntriesDropped: number;
}

/** Storage key for the persisted graph (versioned). */
export const KNOWLEDGE_GRAPH_STORAGE_KEY = 'krisha_knowledge_graph_v1';
export const KNOWLEDGE_GRAPH_SCHEMA_VERSION = 1;

/** One compact statement rendered for the Context Engine, e.g.
 *  `Context Engine —depends_on→ Memory System`. */
export const MAX_STATEMENT_CHARS = 200;
