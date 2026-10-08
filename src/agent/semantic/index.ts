/**
 * Semantic Intelligence v1 — public API.
 *
 * Krisha's Context Engine consumes this module through the SemanticIntelligence
 * facade injected into ContextEngineOptions. Everything here EXTENDS the
 * existing stack: the Knowledge Graph adapter reuses the graph's own bounded
 * query layer, expansion caching reuses the Context Engine's SessionCache,
 * and the scorer plugs into the existing RelevanceEngine.
 *
 * Local-first: with no model hook (the default) the whole layer runs offline.
 */
export {
  SemanticIntelligence,
  LearnedVocabulary,
  findAliasExpansions,
  normalizeTerm,
} from './semanticExpander';
export type { SemanticIntelligenceOptions, SemanticExpandResult } from './semanticExpander';
export { semanticOverlapFor } from './semanticScorer';
export type { SemanticHit } from './semanticScorer';
export {
  DEFAULT_SEMANTIC_LIMITS,
  SEMANTIC_TIER_CONFIDENCE,
  SEMANTIC_OVERLAP_CAP,
  SEMANTIC_VOCAB_STORAGE_KEY,
  SEMANTIC_VOCAB_SCHEMA_VERSION,
  TRUSTED_LEARN_SOURCES,
} from './semanticTypes';
export type {
  SemanticExpansion,
  SemanticTier,
  SemanticLimits,
  SemanticGraphSource,
  SemanticModelHook,
  SemanticExpandOptions,
  GraphExpansion,
  LearnedEntry,
  LearnedTerm,
} from './semanticTypes';

import type { SemanticGraphSource } from './semanticTypes';
import { queryGraphExpansions } from '../knowledge/knowledgeQuery';
import type { KnowledgeGraphFacade } from '../knowledge/index';

/**
 * Adapter: expose the existing Knowledge Graph facade as a SemanticGraphSource.
 * Traversal stays bounded inside the graph's own query layer (depth-1
 * neighborhoods around nodes that actually match the seeds, result-capped);
 * only real stored relationships with adequate confidence are returned.
 */
export function semanticGraphSource(facade: KnowledgeGraphFacade): SemanticGraphSource {
  return {
    relatedForTerms(terms: string[], limit: number) {
      try {
        return queryGraphExpansions(facade.graph, terms, facade.graph.limits, limit);
      } catch {
        return [];
      }
    },
    signature(): string {
      try {
        const stats = facade.graph.stats();
        return `${stats.nodes}:${stats.edges}`;
      } catch {
        return 'graph';
      }
    },
  };
}
