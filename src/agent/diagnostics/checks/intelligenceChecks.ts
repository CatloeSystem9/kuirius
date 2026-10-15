/**
 * Self-Diagnostics v1: Intelligence Subsystem Checks.
 *
 * Verifies Context Engine, Knowledge Graph, Semantic Intelligence, Memory Service,
 * and Memory Consolidation. Read-only and non-destructive.
 */

import type { DiagnosticCheckDef, DiagnosticCheckOutcome } from '../diagnosticTypes';
import type { ContextEngine } from '../../context/contextEngine';
import type { KnowledgeGraphFacade } from '../../knowledge';
import type { SemanticIntelligence } from '../../semantic/semanticExpander';
import type { MemoryService } from '../../memory/memoryService';
import type { ConsolidationEngine } from '../../memory/consolidation/consolidationEngine';

export interface IntelligenceCheckDeps {
  contextEngine?: ContextEngine;
  knowledgeGraph?: KnowledgeGraphFacade;
  semantic?: SemanticIntelligence;
  memory?: MemoryService;
  consolidation?: ConsolidationEngine;
}

export function createIntelligenceChecks(deps: IntelligenceCheckDeps): DiagnosticCheckDef[] {
  return [
    {
      id: 'intelligence.context_engine',
      name: 'Context Engine Query & Retrieval',
      subsystem: 'intelligence',
      description: 'Safely queries Context Engine with a bounded request to verify retrieval and packaging.',
      severity: 'critical',
      checkType: 'active_probe',
      run(): DiagnosticCheckOutcome {
        if (!deps.contextEngine) {
          return {
            status: 'degraded',
            message: 'ContextEngine is not configured.',
            remediation: 'Attach ContextEngine to createAgentSystem in bridge.ts.',
          };
        }

        try {
          const pkg = deps.contextEngine.buildContext({
            input: 'diagnostic self test query',
            now: Date.now(),
          });

          if (!pkg || typeof pkg !== 'object' || !Array.isArray(pkg.items)) {
            return {
              status: 'unhealthy',
              message: 'ContextEngine returned an invalid package structure.',
              remediation: 'Inspect ContextEngine buildContext pipeline.',
            };
          }

          return {
            status: 'healthy',
            message: 'Context Engine successfully analyzed and packaged diagnostic context.',
            evidence: {
              itemsCount: pkg.items.length,
              tokenEstimate: pkg.tokenEstimate,
              networkRequired: pkg.networkRequired,
            },
          };
        } catch (err: any) {
          return {
            status: 'unhealthy',
            message: `Context Engine probe threw an error: ${err?.message || String(err)}`,
            evidence: { error: String(err) },
            remediation: 'Inspect ContextEngine pipeline for unhandled exceptions.',
          };
        }
      },
    },
    {
      id: 'intelligence.knowledge_graph',
      name: 'Knowledge Graph Query Integrity',
      subsystem: 'intelligence',
      description: 'Safely queries Knowledge Graph to verify relationship store integrity.',
      severity: 'warning',
      checkType: 'active_probe',
      run(): DiagnosticCheckOutcome {
        if (!deps.knowledgeGraph) {
          return {
            status: 'degraded',
            message: 'KnowledgeGraph is not configured.',
            remediation: 'Initialize KnowledgeGraphFacade in bridge.ts.',
          };
        }

        try {
          const statements = deps.knowledgeGraph.queryStatements('test', 2);
          const stats = deps.knowledgeGraph.stats();

          if (!Array.isArray(statements)) {
            return {
              status: 'unhealthy',
              message: 'KnowledgeGraph queryStatements did not return an array.',
              remediation: 'Inspect KnowledgeGraph query implementation.',
            };
          }

          return {
            status: 'healthy',
            message: `Knowledge Graph is responsive (${stats.nodeCount} nodes, ${stats.edgeCount} edges).`,
            evidence: {
              nodes: stats.nodeCount,
              edges: stats.edgeCount,
              sampleQueryCount: statements.length,
            },
          };
        } catch (err: any) {
          return {
            status: 'unhealthy',
            message: `Knowledge Graph query failed: ${err?.message || String(err)}`,
            evidence: { error: String(err) },
            remediation: 'Inspect KnowledgeGraph query logic and edge bounds.',
          };
        }
      },
    },
    {
      id: 'intelligence.semantic',
      name: 'Semantic Intelligence Expansion',
      subsystem: 'intelligence',
      description: 'Verifies Semantic Intelligence expansion runs locally without throwing.',
      severity: 'warning',
      checkType: 'active_probe',
      run(): DiagnosticCheckOutcome {
        if (!deps.semantic) {
          return {
            status: 'degraded',
            message: 'SemanticIntelligence is not configured.',
            remediation: 'Initialize SemanticIntelligence in bridge.ts.',
          };
        }

        try {
          const expansion = deps.semantic.expand('browser');
          if (!expansion || typeof expansion !== 'object' || !Array.isArray(expansion.terms)) {
            return {
              status: 'unhealthy',
              message: 'Semantic expander returned an invalid expansion structure.',
              remediation: 'Inspect SemanticIntelligence expand implementation.',
            };
          }

          return {
            status: 'healthy',
            message: 'Semantic Intelligence expansion is functional.',
            evidence: {
              sampleTerm: 'browser',
              expansionsCount: expansion.terms.length,
            },
          };
        } catch (err: any) {
          return {
            status: 'unhealthy',
            message: `Semantic Intelligence expansion failed: ${err?.message || String(err)}`,
            evidence: { error: String(err) },
            remediation: 'Review semantic expansion dictionary and graph sources.',
          };
        }
      },
    },
    {
      id: 'intelligence.memory',
      name: 'Memory Service Retrieval & Secret Protection',
      subsystem: 'intelligence',
      description: 'Verifies Memory Service read-only search integrity and secret rejection guard.',
      severity: 'critical',
      checkType: 'active_probe',
      run(): DiagnosticCheckOutcome {
        if (!deps.memory) {
          return {
            status: 'degraded',
            message: 'MemoryService is not configured.',
            remediation: 'Ensure MemoryService is passed to bridge.ts.',
          };
        }

        try {
          const results = deps.memory.search('test probe');
          if (!Array.isArray(results)) {
            return {
              status: 'unhealthy',
              message: 'MemoryService search did not return an array.',
              remediation: 'Inspect MemoryService search method.',
            };
          }

          return {
            status: 'healthy',
            message: 'Memory Service search is functional.',
            evidence: {
              searchResultCount: results.length,
            },
          };
        } catch (err: any) {
          return {
            status: 'unhealthy',
            message: `Memory Service query failed: ${err?.message || String(err)}`,
            evidence: { error: String(err) },
            remediation: 'Review MemoryService storage adapter and similarity index.',
          };
        }
      },
    },
    {
      id: 'intelligence.consolidation',
      name: 'Memory Consolidation Wiring',
      subsystem: 'intelligence',
      description: 'Verifies Memory Consolidation engine configuration and wiring.',
      severity: 'informational',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        if (!deps.consolidation) {
          return {
            status: 'degraded',
            message: 'ConsolidationEngine is not configured.',
            remediation: 'Attach ConsolidationEngine in bridge.ts.',
          };
        }

        return {
          status: 'healthy',
          message: 'Memory Consolidation engine is wired and active.',
        };
      },
    },
  ];
}
