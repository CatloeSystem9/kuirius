/**
 * Knowledge Query (v1) — deterministic, bounded lookup of graph context for
 * the Context Engine. Given a user request, it selects the most relevant
 * nodes (token overlap + connectivity), expands a ONE-hop neighborhood for
 * those nodes only, and renders compact `A —relationship→ B` statements plus
 * a structured KnowledgeContext.
 *
 * The graph is never dumped: result sets are capped by the graph limits and
 * every statement is bounded (MAX_STATEMENT_CHARS).
 */
import { tokenize } from '../context/contextAnalyzer';
import type { KnowledgeContext, KnowledgeEdge, KnowledgeGraphLimits, KnowledgeNode, RelationshipType } from './knowledgeTypes';
import { MAX_STATEMENT_CHARS } from './knowledgeTypes';
import type { KnowledgeGraph } from './knowledgeGraph';

function nodeTokens(node: KnowledgeNode): Set<string> {
  const text = `${node.label} ${Object.values(node.properties ?? {})
    .map((v) => (typeof v === 'string' ? v : ''))
    .join(' ')}`;
  return new Set(tokenize(text.slice(0, 400)));
}

interface ScoredNode {
  node: KnowledgeNode;
  score: number;
}

/** Select relevant nodes for the request — deterministic scoring. */
export function selectRelevantNodes(
  graph: KnowledgeGraph,
  input: string,
  limits: KnowledgeGraphLimits
): ScoredNode[] {
  const keywords = tokenize(String(input ?? '').slice(0, 1000));
  if (keywords.length === 0) return [];
  const keywordSet = new Set(keywords);
  const scored: ScoredNode[] = [];
  for (const node of graph.getNodesByType('person', limits.maxQueryResults * 4)) {
    scored.push({ node, score: scoreNode(node, keywordSet) });
  }
  // Scan remaining types through the bounded by-type queries (each capped).
  for (const type of ['project', 'task', 'goal', 'memory', 'file', 'component', 'tool', 'decision', 'result', 'resource'] as const) {
    for (const node of graph.getNodesByType(type, limits.maxQueryResults)) {
      scored.push({ node, score: scoreNode(node, keywordSet) });
    }
  }
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.node.label.localeCompare(b.node.label))
    .slice(0, limits.maxQueryResults);
}

function scoreNode(node: KnowledgeNode, keywords: Set<string>): number {
  const tokens = nodeTokens(node);
  let hits = 0;
  for (const k of keywords) if (tokens.has(k)) hits++;
  if (hits === 0) return 0;
  // Overlap dominates; explicit decisions get a small deterministic boost.
  const explicitBoost = node.type === 'decision' ? 0.1 : 0;
  return Math.min(1, hits / Math.sqrt(keywords.size)) + explicitBoost;
}

/**
 * Build the KnowledgeContext for a request: top relevant nodes + their
 * one-hop relationships (bounded). relevanceScore is the best node score,
 * 0 when nothing matches (the caller then adds no graph context at all).
 */
export function queryKnowledgeContext(graph: KnowledgeGraph, input: string, limits: KnowledgeGraphLimits): KnowledgeContext {
  const relevant = selectRelevantNodes(graph, input, limits);
  if (relevant.length === 0) {
    return { nodes: [], relationships: [], relevanceScore: 0, source: 'knowledge-graph' };
  }
  const nodes: KnowledgeNode[] = [];
  const relationships: KnowledgeEdge[] = [];
  const seenEdges = new Set<string>();
  const seenNodes = new Set<string>();
  for (const { node } of relevant) {
    if (!seenNodes.has(node.id)) {
      seenNodes.add(node.id);
      nodes.push(node);
    }
    if (relationships.length >= limits.maxQueryResults) continue;
    for (const edge of [...graph.getOutgoingRelations(node.id, 3), ...graph.getIncomingRelations(node.id, 3)]) {
      if (seenEdges.has(edge.id)) continue;
      seenEdges.add(edge.id);
      relationships.push(edge);
      if (!seenNodes.has(edge.sourceId)) {
        const sourceNode = graph.getNode(edge.sourceId);
        if (sourceNode) {
          seenNodes.add(edge.sourceId);
          nodes.push(sourceNode);
        }
      }
      if (!seenNodes.has(edge.targetId)) {
        const targetNode = graph.getNode(edge.targetId);
        if (targetNode) {
          seenNodes.add(edge.targetId);
          nodes.push(targetNode);
        }
      }
      if (relationships.length >= limits.maxQueryResults) break;
    }
  }
  return {
    nodes: nodes.slice(0, limits.maxQueryResults * 2),
    relationships: relationships.slice(0, limits.maxQueryResults),
    relevanceScore: Math.min(1, relevant[0].score),
    source: 'knowledge-graph',
  };
}

/** Render one edge as a compact deterministic statement. */
export function renderEdgeStatement(graph: KnowledgeGraph, edge: KnowledgeEdge): string {
  const source = graph.getNode(edge.sourceId)?.label ?? edge.sourceId;
  const target = graph.getNode(edge.targetId)?.label ?? edge.targetId;
  const statement = `${source} -${edge.relationship}-> ${target}`;
  return statement.length > MAX_STATEMENT_CHARS ? statement.slice(0, MAX_STATEMENT_CHARS - 1) + '…' : statement;
}

/**
 * Compact statements for the Context Engine retriever. Empty when nothing
 * matches — the retriever then simply adds no knowledge_graph items.
 */
export function queryKnowledgeStatements(graph: KnowledgeGraph, input: string, limits: KnowledgeGraphLimits): string[] {
  const ctx = queryKnowledgeContext(graph, input, limits);
  if (ctx.relationships.length === 0 && ctx.nodes.length === 0) return [];
  const statements = ctx.relationships.map((e) => renderEdgeStatement(graph, e));
  const covered = new Set(ctx.relationships.flatMap((e) => [e.sourceId, e.targetId]));
  for (const node of ctx.nodes) {
    if (!covered.has(node.id)) {
      statements.push(node.type === 'decision' ? `Decision: ${node.label.replace(/^Decision:\s*/i, '')}` : node.label);
    }
  }
  return statements.slice(0, limits.maxQueryResults);
}

// ---------------------------------------------------------------------------
// Semantic Intelligence v1 — bounded graph-derived term expansion
// ---------------------------------------------------------------------------

export interface GraphRelatedTerm {
  label: string;
  relationship: RelationshipType;
  confidence: number;
}

export interface GraphExpansion {
  seed: string;
  related: GraphRelatedTerm[];
}

/**
 * Semantic expansion source over the EXISTING graph (Semantic Intelligence v1).
 * For each seed term (capped), find the single best-matching node via the
 * deterministic scorer above, then expand its ONE-hop neighborhood — real
 * stored relationships only, confidence-filtered, result-capped. No traversal
 * beyond depth 1, no invented relationships: if no node matches a seed, that
 * seed simply yields nothing.
 */
export function queryGraphExpansions(
  graph: KnowledgeGraph,
  terms: string[],
  limits: KnowledgeGraphLimits,
  maxSeeds = 3,
  maxPerSeed = 3
): GraphExpansion[] {
  const seeds: string[] = [];
  for (const t of Array.isArray(terms) ? terms : []) {
    const seed = String(t ?? '').trim().toLowerCase();
    if (seed && !seeds.includes(seed)) seeds.push(seed);
    if (seeds.length >= Math.max(1, maxSeeds)) break;
  }
  if (seeds.length === 0) return [];
  const out: GraphExpansion[] = [];
  for (const seed of seeds) {
    const best = selectRelevantNodes(graph, seed, limits)[0];
    if (!best) continue;
    const related: GraphRelatedTerm[] = [];
    const seen = new Set<string>([best.node.label.trim().toLowerCase(), seed]);
    for (const entry of graph.findRelatedEntities(best.node.id, { depth: 1, limit: Math.max(1, maxPerSeed) })) {
      if (related.length >= Math.max(1, maxPerSeed)) break;
      const label = String(entry.node.label ?? '').trim();
      if (!label) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      const confidence = Math.max(0, Math.min(1, entry.confidence ?? 0));
      if (confidence < 0.5) continue; // weak/unverified edges are never expanded
      seen.add(key);
      related.push({ label, relationship: entry.relationship, confidence });
    }
    if (related.length > 0) out.push({ seed, related });
  }
  return out;
}
