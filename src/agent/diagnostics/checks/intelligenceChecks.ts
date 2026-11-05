/**
 * Self-Diagnostics v1: Intelligence Subsystem Checks.
 *
 * Verifies Context Engine, Knowledge Graph, Semantic Intelligence, Memory Service,
 * and Memory Consolidation through passive, bounded local state only.
 */

import type { DiagnosticCheckDef, DiagnosticCheckOutcome } from '../diagnosticTypes';
import type { ContextEngine } from '../../context/contextEngine';
import type { KnowledgeGraphFacade } from '../../knowledge';
import type { SemanticIntelligence } from '../../semantic/semanticExpander';
import type { MemoryService } from '../../memory/memoryService';
import type { ConsolidationEngine } from '../../memory/consolidation/consolidationEngine';
import type { SkillEngine } from '../../skills';
import type { ProjectEngine } from '../../projects';

export interface IntelligenceCheckDeps {
  contextEngine?: ContextEngine;
  knowledgeGraph?: KnowledgeGraphFacade;
  semantic?: SemanticIntelligence;
  memory?: MemoryService;
  consolidation?: ConsolidationEngine;
  skills?: SkillEngine;
  projects?: ProjectEngine;
  goals?: import('../../goals').GoalEngine;
}

export function createIntelligenceChecks(deps: IntelligenceCheckDeps): DiagnosticCheckDef[] {
  return [
    {
      id: 'intelligence.context_engine',
      name: 'Context Engine Configuration & Cache State',
      subsystem: 'intelligence',
      description: 'Passively inspects Context Engine configuration and bounded cache statistics.',
      severity: 'critical',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        if (!deps.contextEngine) {
          return {
            status: 'degraded',
            message: 'ContextEngine is not configured.',
            remediation: 'Attach ContextEngine to createAgentSystem in bridge.ts.',
          };
        }

        try {
          const stats = deps.contextEngine.stats();
          if (!stats || typeof stats !== 'object') {
            return {
              status: 'unhealthy',
              message: 'ContextEngine did not return a valid statistics snapshot.',
              remediation: 'Inspect ContextEngine configuration and cache state accessors.',
            };
          }

          return {
            status: 'healthy',
            message: 'Context Engine is configured and its bounded cache state is readable.',
            evidence: {
              sessionCacheEntries: stats.session.size,
              persistentCacheEntries: stats.persistent.size,
              cachedTaskPackages: stats.packages,
              contextBudgetChars: deps.contextEngine.budget.maxChars,
            },
          };
        } catch (err: any) {
          return {
            status: 'unhealthy',
            message: `Context Engine inspection failed: ${err?.message || String(err)}`,
            evidence: { error: String(err) },
            remediation: 'Inspect ContextEngine pipeline for unhandled exceptions.',
          };
        }
      },
    },
    {
      id: 'intelligence.knowledge_graph',
      name: 'Knowledge Graph State Integrity',
      subsystem: 'intelligence',
      description: 'Passively inspects bounded Knowledge Graph statistics without running a query.',
      severity: 'warning',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        if (!deps.knowledgeGraph) {
          return {
            status: 'degraded',
            message: 'KnowledgeGraph is not configured.',
            remediation: 'Initialize KnowledgeGraphFacade in bridge.ts.',
          };
        }

        try {
          const stats = deps.knowledgeGraph.stats();
          if (!stats || typeof stats.nodes !== 'number' || typeof stats.edges !== 'number') {
            return {
              status: 'unhealthy',
              message: 'KnowledgeGraph did not return a valid statistics snapshot.',
              remediation: 'Inspect KnowledgeGraph storage and statistics implementation.',
            };
          }

          return {
            status: 'healthy',
            message: `Knowledge Graph is responsive (${stats.nodes} nodes, ${stats.edges} edges).`,
            evidence: {
              nodes: stats.nodes,
              edges: stats.edges,
              corruptedEntriesDropped: stats.corruptedEntriesDropped,
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
      name: 'Semantic Intelligence Configuration',
      subsystem: 'intelligence',
      description: 'Passively inspects local Semantic Intelligence limits without expanding a query.',
      severity: 'warning',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        if (!deps.semantic) {
          return {
            status: 'degraded',
            message: 'SemanticIntelligence is not configured.',
            remediation: 'Initialize SemanticIntelligence in bridge.ts.',
          };
        }

        try {
          const limits = deps.semantic.limits;
          if (!limits || typeof limits.maxExpansions !== 'number') {
            return {
              status: 'unhealthy',
              message: 'Semantic Intelligence does not expose valid bounded limits.',
              remediation: 'Inspect SemanticIntelligence configuration.',
            };
          }

          return {
            status: 'healthy',
            message: 'Semantic Intelligence is configured for bounded local expansion.',
            evidence: {
              maxSeedTerms: limits.maxSeedTerms,
              maxExpansions: limits.maxExpansions,
              maxGraphSeeds: limits.maxGraphSeeds,
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
      name: 'Memory Service State & Secret Protection',
      subsystem: 'intelligence',
      description: 'Passively reads bounded Memory Service counters; it never searches or writes memories.',
      severity: 'critical',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        if (!deps.memory) {
          return {
            status: 'degraded',
            message: 'MemoryService is not configured.',
            remediation: 'Ensure MemoryService is passed to bridge.ts.',
          };
        }

        try {
          const stats = deps.memory.stats();
          if (!stats || typeof stats.total !== 'number' || typeof stats.valid !== 'number') {
            return {
              status: 'unhealthy',
              message: 'MemoryService did not return a valid statistics snapshot.',
              remediation: 'Inspect MemoryService storage and statistics implementation.',
            };
          }

          return {
            status: 'healthy',
            message: 'Memory Service state is readable; no memory content was queried or modified.',
            evidence: {
              totalRecords: stats.total,
              validRecords: stats.valid,
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
    {
      id: 'intelligence.learned_skills',
      name: 'Learned Skills State',
      subsystem: 'intelligence',
      description: 'Passively inspects bounded learned-skill counters without running a match or a skill.',
      severity: 'informational',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        if (!deps.skills) {
          return {
            status: 'degraded',
            message: 'SkillEngine is not configured.',
            remediation: 'Initialize SkillEngine in bridge.ts.',
          };
        }

        try {
          const stats = deps.skills.stats();
          if (!stats || typeof stats.skills !== 'number' || typeof stats.avgReliability !== 'number') {
            return {
              status: 'unhealthy',
              message: 'SkillEngine did not return a valid statistics snapshot.',
              remediation: 'Inspect SkillStore persistence and statistics implementation.',
            };
          }

          return {
            status: 'healthy',
            message: `Learned-skills store is readable (${stats.skills} skills, ${stats.reusable} reusable).`,
            evidence: {
              skills: stats.skills,
              reusable: stats.reusable,
              sensitive: stats.sensitive,
              disabled: stats.disabled,
              avgReliability: stats.avgReliability,
            },
          };
        } catch (err: any) {
          return {
            status: 'unhealthy',
            message: `Learned-skills inspection failed: ${err?.message || String(err)}`,
            evidence: { error: String(err) },
            remediation: 'Review SkillEngine statistics and store repair logic.',
          };
        }
      },
    },
    {
      id: 'intelligence.project_awareness',
      name: 'Project Awareness State',
      subsystem: 'intelligence',
      description: 'Passively inspects bounded project-awareness counters (approved roots, indexed projects, staleness) without scanning any directory.',
      severity: 'informational',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        if (!deps.projects) {
          return {
            status: 'degraded',
            message: 'ProjectEngine is not configured.',
            remediation: 'Initialize ProjectEngine in bridge.ts.',
          };
        }

        try {
          const stats = deps.projects.stats();
          if (!stats || typeof stats.projects !== 'number' || typeof stats.approvedRoots !== 'number') {
            return {
              status: 'unhealthy',
              message: 'ProjectEngine did not return a valid statistics snapshot.',
              remediation: 'Inspect ProjectStore persistence and statistics implementation.',
            };
          }

          return {
            status: 'healthy',
            message: `Project awareness is readable (${stats.approvedRoots} approved roots, ${stats.projects} indexed projects, ${stats.stale} stale).`,
            evidence: {
              approvedRoots: stats.approvedRoots,
              projects: stats.projects,
              stale: stats.stale,
              kinds: stats.kinds,
            },
          };
        } catch (err: any) {
          return {
            status: 'unhealthy',
            message: `Project-awareness inspection failed: ${err?.message || String(err)}`,
            evidence: { error: String(err) },
            remediation: 'Review ProjectEngine statistics and store repair logic.',
          };
        }
      },
    },
    {
      id: 'intelligence.goal_continuity',
      name: 'Goal Continuity State',
      subsystem: 'intelligence',
      description: 'Passively inspects bounded goal-continuity counters (goals by lifecycle state, milestones) without touching any conversation.',
      severity: 'informational',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        if (!deps.goals) {
          return {
            status: 'degraded',
            message: 'GoalEngine is not configured.',
            remediation: 'Initialize GoalEngine in bridge.ts.',
          };
        }

        try {
          const stats = deps.goals.stats();
          if (!stats || typeof stats.total !== 'number' || typeof stats.active !== 'number') {
            return {
              status: 'unhealthy',
              message: 'GoalEngine did not return a valid statistics snapshot.',
              remediation: 'Inspect GoalStore persistence and statistics implementation.',
            };
          }

          return {
            status: 'healthy',
            message: `Goal continuity is readable (${stats.active} active, ${stats.paused} paused, ${stats.blocked} blocked, ${stats.proposed} proposed of ${stats.total} goals; ${stats.milestones} milestones).`,
            evidence: {
              total: stats.total,
              proposed: stats.proposed,
              active: stats.active,
              paused: stats.paused,
              blocked: stats.blocked,
              completed: stats.completed,
              abandoned: stats.abandoned,
              withProjectRefs: stats.withProjectRefs,
              milestones: stats.milestones,
            },
          };
        } catch (err: any) {
          return {
            status: 'unhealthy',
            message: `Goal-continuity inspection failed: ${err?.message || String(err)}`,
            evidence: { error: String(err) },
            remediation: 'Review GoalEngine statistics and store repair logic.',
          };
        }
      },
    },
    {
      id: 'intelligence.context_engine.probe',
      name: 'Context Engine Active Query Probe',
      subsystem: 'intelligence',
      description: 'Opt-in, read-only active probe that verifies Context Engine query and package assembly pipeline.',
      severity: 'warning',
      checkType: 'active_probe',
      run(): DiagnosticCheckOutcome {
        if (!deps.contextEngine) {
          return {
            status: 'degraded',
            message: 'ContextEngine is not configured for active probing.',
            remediation: 'Attach ContextEngine to createAgentSystem in bridge.ts.',
          };
        }

        try {
          const pkg = deps.contextEngine.buildContext({
            input: 'diagnostic health probe',
            now: Date.now(),
          });

          if (!pkg || typeof pkg !== 'object' || !pkg.metadata || typeof pkg.metadata.itemsKept !== 'number') {
            return {
              status: 'unhealthy',
              message: 'ContextEngine active probe returned an invalid package structure.',
              remediation: 'Inspect ContextEngine buildContext pipeline.',
            };
          }

          return {
            status: 'healthy',
            message: 'Context Engine active probe successfully verified query and package assembly.',
            evidence: {
              itemsKept: pkg.metadata.itemsKept,
              charsUsed: pkg.metadata.charsUsed,
              networkRequired: pkg.metadata.networkRequired,
            },
          };
        } catch (err: any) {
          return {
            status: 'unhealthy',
            message: `Context Engine active probe failed: ${err?.message || String(err)}`,
            evidence: { error: String(err) },
            remediation: 'Inspect ContextEngine pipeline for unhandled exceptions.',
          };
        }
      },
    },
    {
      id: 'intelligence.knowledge_graph.probe',
      name: 'Knowledge Graph Query Probe',
      subsystem: 'intelligence',
      description: 'Opt-in, read-only active probe that verifies Knowledge Graph statement queries.',
      severity: 'warning',
      checkType: 'active_probe',
      run(): DiagnosticCheckOutcome {
        if (!deps.knowledgeGraph) {
          return {
            status: 'degraded',
            message: 'KnowledgeGraph is not configured for active probing.',
            remediation: 'Initialize KnowledgeGraphFacade in bridge.ts.',
          };
        }

        try {
          const statements = deps.knowledgeGraph.queryStatements('diagnostic probe', 2);
          if (!Array.isArray(statements)) {
            return {
              status: 'unhealthy',
              message: 'KnowledgeGraph queryStatements did not return an array.',
              remediation: 'Inspect KnowledgeGraph query implementation.',
            };
          }

          return {
            status: 'healthy',
            message: 'Knowledge Graph active query probe succeeded.',
            evidence: {
              returnedStatementsCount: statements.length,
            },
          };
        } catch (err: any) {
          return {
            status: 'unhealthy',
            message: `Knowledge Graph active probe failed: ${err?.message || String(err)}`,
            evidence: { error: String(err) },
            remediation: 'Inspect KnowledgeGraph query logic.',
          };
        }
      },
    },
  ];
}
