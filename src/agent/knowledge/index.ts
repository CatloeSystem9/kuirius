/**
 * Knowledge Graph v1 — public API.
 *
 * Krisha interacts with the graph ONLY through this surface. The facade
 * combines the bounded graph core, deterministic event-driven indexer and
 * query layer; persistence rides the existing StorageAdapter convention and
 * the graph itself never needs network access (local-first).
 *
 * Integration with the Context Engine is additive: a `knowledge` provider
 * (queryKnowledgeStatements) is injected into ContextEngineOptions and the
 * graph's statements flow through the existing relevance + budget pipeline —
 * memory, tools and all other sources remain untouched.
 */
export { KnowledgeGraph } from './knowledgeGraph';
export type { CreateEdgeInput, CreateNodeInput, RelatedEntry } from './knowledgeGraph';
export { KnowledgeIndexer } from './knowledgeIndexer';
export type { KnowledgeIndexerDeps } from './knowledgeIndexer';
export {
  queryKnowledgeContext,
  queryKnowledgeStatements,
  selectRelevantNodes,
  renderEdgeStatement,
  queryGraphExpansions,
} from './knowledgeQuery';
export { KnowledgeStore } from './knowledgeStore';
export {
  ENTITY_TYPES,
  RELATIONSHIP_TYPES,
  DEFAULT_KNOWLEDGE_LIMITS,
  KNOWLEDGE_GRAPH_STORAGE_KEY,
  KNOWLEDGE_GRAPH_SCHEMA_VERSION,
  MAX_STATEMENT_CHARS,
} from './knowledgeTypes';
export type {
  EntityType,
  RelationshipType,
  KnowledgeNode,
  KnowledgeEdge,
  KnowledgeContext,
  KnowledgeGraphLimits,
  KnowledgeGraphOptions,
  KnowledgeStats,
} from './knowledgeTypes';
export {
  isValidId,
  isEntityType,
  isRelationshipType,
  validateNode,
  validateEdge,
  clampLabel,
} from './knowledgeValidator';

import type { AgentEventBus } from '../events';
import { KnowledgeGraph as Graph } from './knowledgeGraph';
import { KnowledgeIndexer, type KnowledgeIndexerDeps } from './knowledgeIndexer';
import { queryKnowledgeStatements } from './knowledgeQuery';
import type { KnowledgeGraphOptions } from './knowledgeTypes';

/**
 * Facade: one KnowledgeGraph instance owns its indexer and query layer.
 * Constructing it performs NO I/O — the graph lazy-loads from storage on
 * first use, so startup stays free.
 */
export class KnowledgeGraphFacade {
  readonly graph: Graph;
  readonly indexer: KnowledgeIndexer;

  constructor(options: KnowledgeGraphOptions = {}) {
    this.graph = new Graph(options);
    this.indexer = new KnowledgeIndexer(this.graph);
  }

  /** Event-driven extraction attachment (no polling). */
  attach(bus: AgentEventBus, deps: KnowledgeIndexerDeps = {}): () => void {
    const indexer = new KnowledgeIndexer(this.graph, deps);
    return indexer.attach(bus);
  }

  /** Statements for the Context Engine retriever (bounded, deterministic). */
  queryStatements(input: string, limit?: number): string[] {
    return queryKnowledgeStatements(this.graph, input, limit ? { ...this.graph.limits, maxQueryResults: Math.min(limit, this.graph.limits.maxQueryResults) } : this.graph.limits);
  }

  stats(): ReturnType<Graph['stats']> {
    return this.graph.stats();
  }

  clear(): void {
    this.graph.clear();
  }
}
