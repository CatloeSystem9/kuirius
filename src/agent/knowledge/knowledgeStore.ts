/**
 * Knowledge Graph store (v1) — persistence over the existing StorageAdapter
 * convention (localStorage in the browser, JSON file on the server).
 *
 * Corruption-safe by construction:
 *  - invalid JSON / future schema → clean start (nothing to salvage),
 *  - partially malformed payloads → VALID entries are salvaged, only the
 *    malformed ones are dropped (valid graph data is never silently destroyed),
 *  - storage write failures are non-fatal (in-memory state stays authoritative).
 *
 * Bounded + deterministic: saving is a synchronous pass on mutation (graphs
 * are small); no timers, no background work.
 */
import type { KnowledgeEdge, KnowledgeGraphLimits, KnowledgeNode } from './knowledgeTypes';
import { KNOWLEDGE_GRAPH_SCHEMA_VERSION, KNOWLEDGE_GRAPH_STORAGE_KEY } from './knowledgeTypes';
import { validateEdge, validateNode } from './knowledgeValidator';

interface GraphSchema {
  schemaVersion: number;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
}

export interface GraphLoadResult {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  corruptedEntriesDropped: number;
}

export class KnowledgeStore {
  private readonly storage?: import('../taskState').StorageAdapter;
  private readonly limits: KnowledgeGraphLimits;
  private readonly now: () => number;

  constructor(
    storage?: import('../taskState').StorageAdapter,
    limits?: KnowledgeGraphLimits,
    now: () => number = Date.now
  ) {
    this.storage = storage;
    this.limits = limits;
    this.now = now;
  }

  /** Load + validate persisted graph. Never throws. */
  load(): GraphLoadResult {
    const empty: GraphLoadResult = { nodes: [], edges: [], corruptedEntriesDropped: 0 };
    if (!this.storage) return empty;
    try {
      const raw = this.storage.getItem(KNOWLEDGE_GRAPH_STORAGE_KEY);
      if (!raw) return empty;
      const parsed = JSON.parse(raw) as GraphSchema | null;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
        return empty; // corrupt → clean start (nothing salvageable)
      }
      if ((parsed.schemaVersion ?? 0) > KNOWLEDGE_GRAPH_SCHEMA_VERSION) {
        return empty; // future schema → clean start, never guess
      }
      const limits = this.limits;
      const nodes: KnowledgeNode[] = [];
      const edges: KnowledgeEdge[] = [];
      let dropped = 0;
      const seenNodes = new Set<string>();
      for (const n of parsed.nodes) {
        if (validateNode(n, limits) && !seenNodes.has(n.id)) {
          seenNodes.add(n.id);
          nodes.push(n);
        } else {
          dropped++;
        }
      }
      const seenEdges = new Set<string>();
      for (const e of parsed.edges) {
        if (
          validateEdge(e) &&
          seenNodes.has(e.sourceId) && // dangling edges are not loadable
          seenNodes.has(e.targetId) &&
          !seenEdges.has(e.id)
        ) {
          seenEdges.add(e.id);
          edges.push(e);
        } else {
          dropped++;
        }
      }
      return { nodes, edges, corruptedEntriesDropped: dropped };
    } catch {
      return empty;
    }
  }

  /** Persist the full graph. Never throws; failures leave memory authoritative. */
  save(nodes: KnowledgeNode[], edges: KnowledgeEdge[]): void {
    if (!this.storage) return;
    try {
      const schema: GraphSchema = {
        schemaVersion: KNOWLEDGE_GRAPH_SCHEMA_VERSION,
        nodes: nodes.slice(0, this.limits.maxNodes),
        edges: edges.slice(0, this.limits.maxEdges),
      };
      this.storage.setItem(KNOWLEDGE_GRAPH_STORAGE_KEY, JSON.stringify(schema));
    } catch {
      // storage failure is non-fatal for agent operation
    }
  }

  /** Remove the persisted graph (used by clear()). */
  clear(): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(KNOWLEDGE_GRAPH_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}
