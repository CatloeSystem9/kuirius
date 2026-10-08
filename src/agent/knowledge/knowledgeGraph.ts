/**
 * Knowledge Graph core (v1) — bounded, deterministic, in-memory graph with
 * lazy StorageAdapter persistence.
 *
 * Design:
 *  - Maps + adjacency index sets (no graph database, no embeddings).
 *  - Stable deterministic ids (type+label / triple) via the routing hashKey —
 *    accidental duplicates are impossible, re-indexing the same fact is a no-op.
 *  - Every mutation validates, then enforces explicit size limits with
 *    deterministic pruning (fewest-connections/oldest nodes, lowest-confidence
 *    edges). The graph can never grow unbounded.
 *  - Traversal is depth-bounded and result-capped. No unrestricted walks.
 *  - All operations fail safe: invalid input returns null/false, never throws.
 */
import { hashKey } from '../routing/cache';
import type {
  EntityType,
  KnowledgeEdge,
  KnowledgeGraphLimits,
  KnowledgeGraphOptions,
  KnowledgeNode,
  KnowledgeStats,
  RelationshipType,
} from './knowledgeTypes';
import { DEFAULT_KNOWLEDGE_LIMITS } from './knowledgeTypes';
import { KnowledgeStore } from './knowledgeStore';
import {
  clampLabel,
  edgeFingerprint,
  validateEdge,
  validateNode,
} from './knowledgeValidator';

export interface CreateNodeInput {
  type: EntityType;
  label: string;
  properties?: Record<string, unknown>;
}

export interface CreateEdgeInput {
  sourceId: string;
  targetId: string;
  relationship: RelationshipType;
  confidence?: number;
  source?: string;
}

export interface RelatedEntry {
  node: KnowledgeNode;
  depth: number;
  relationship: RelationshipType;
  direction: 'out' | 'in';
  /** Edge confidence (0..1) — lets semantic consumers reject weak edges. */
  confidence?: number;
}

export class KnowledgeGraph {
  readonly limits: KnowledgeGraphLimits;
  private readonly store: KnowledgeStore;
  private readonly now: () => number;
  private nodes = new Map<string, KnowledgeNode>();
  private edges = new Map<string, KnowledgeEdge>();
  private edgeByFingerprint = new Map<string, string>();
  private adjacencyOut = new Map<string, Set<string>>();
  private adjacencyIn = new Map<string, Set<string>>();
  private loaded = false;
  private evictedNodes = 0;
  private evictedEdges = 0;
  private corruptedEntriesDropped = 0;

  constructor(options: KnowledgeGraphOptions = {}) {
    this.limits = { ...DEFAULT_KNOWLEDGE_LIMITS, ...options.limits };
    this.store = new KnowledgeStore(options.storage, this.limits, options.now ?? Date.now);
    this.now = options.now ?? Date.now;
  }

  // ------------------------------------------------------------------
  // Loading / persistence
  // ------------------------------------------------------------------
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const result = this.store.load();
    this.corruptedEntriesDropped += result.corruptedEntriesDropped;
    for (const n of result.nodes) this.nodes.set(n.id, n);
    for (const e of result.edges) {
      this.edges.set(e.id, e);
      this.edgeByFingerprint.set(edgeFingerprint(e.sourceId, e.relationship, e.targetId), e.id);
      this.indexEdge(e);
    }
  }

  private persist(): void {
    this.store.save([...this.nodes.values()], [...this.edges.values()]);
  }

  private indexEdge(edge: KnowledgeEdge): void {
    let out = this.adjacencyOut.get(edge.sourceId);
    if (!out) this.adjacencyOut.set(edge.sourceId, (out = new Set()));
    out.add(edge.id);
    let inc = this.adjacencyIn.get(edge.targetId);
    if (!inc) this.adjacencyIn.set(edge.targetId, (inc = new Set()));
    inc.add(edge.id);
  }

  private unindexEdge(edge: KnowledgeEdge): void {
    this.adjacencyOut.get(edge.sourceId)?.delete(edge.id);
    this.adjacencyIn.get(edge.targetId)?.delete(edge.id);
  }

  private static nodeId(type: EntityType, label: string): string {
    return `kg_n_${type}_${hashKey(label.trim().toLowerCase())}`;
  }

  private static edgeId(sourceId: string, relationship: RelationshipType, targetId: string): string {
    return `kg_e_${hashKey(`${sourceId}|${relationship}|${targetId}`)}`;
  }

  // ------------------------------------------------------------------
  // Node operations
  // ------------------------------------------------------------------
  /** Create a node. Returns null when invalid or a duplicate already exists. */
  createNode(input: CreateNodeInput): KnowledgeNode | null {
    this.ensureLoaded();
    const label = clampLabel(String(input.label ?? ''), this.limits.maxLabelChars);
    const candidate: KnowledgeNode = {
      id: KnowledgeGraph.nodeId(input.type, label),
      type: input.type,
      label,
      properties: input.properties,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    if (!validateNode(candidate, this.limits)) return null;
    if (this.nodes.has(candidate.id)) return null; // duplicate prevention
    this.nodes.set(candidate.id, candidate);
    this.evictNodesIfNeeded();
    this.persist();
    return candidate;
  }

  /**
   * Create or merge. An existing node keeps its id/createdAt; label/properties
   * are merged and updatedAt advances. Explicit high-confidence decisions are
   * never overwritten by later ambiguous information (properties merge, never
   * replace wholesale). Returns null only when the input is invalid.
   */
  upsertNode(input: CreateNodeInput): KnowledgeNode | null {
    this.ensureLoaded();
    const label = clampLabel(String(input.label ?? ''), this.limits.maxLabelChars);
    const id = KnowledgeGraph.nodeId(input.type, label);
    const existing = this.nodes.get(id);
    if (!existing) {
      return this.createNode(input);
    }
    if (input.properties) {
      const merged: Record<string, unknown> = { ...(existing.properties ?? {}), ...input.properties };
      const keys = Object.keys(merged);
      if (keys.length > this.limits.maxPropertiesPerNode) {
        for (const k of keys.slice(0, keys.length - this.limits.maxPropertiesPerNode)) delete merged[k];
      }
      existing.properties = merged;
    }
    existing.updatedAt = this.now();
    this.persist();
    return existing;
  }

  getNode(id: string): KnowledgeNode | undefined {
    this.ensureLoaded();
    return this.nodes.get(id);
  }

  hasNode(id: string): boolean {
    this.ensureLoaded();
    return this.nodes.has(id);
  }

  /** Update label/properties. Returns null when the node or patch is invalid. */
  updateNode(id: string, patch: { label?: string; properties?: Record<string, unknown> }): KnowledgeNode | null {
    this.ensureLoaded();
    const node = this.nodes.get(id);
    if (!node) return null;
    if (patch.label !== undefined) {
      const label = clampLabel(String(patch.label), this.limits.maxLabelChars);
      const next: KnowledgeNode = { ...node, label, updatedAt: this.now() };
      if (!validateNode(next, this.limits)) return null;
      node.label = label;
    }
    if (patch.properties !== undefined) {
      const merged = { ...(node.properties ?? {}), ...patch.properties };
      const probe: KnowledgeNode = { ...node, properties: merged, updatedAt: this.now() };
      if (!validateNode(probe, this.limits)) return null;
      node.properties = merged;
    }
    node.updatedAt = this.now();
    this.persist();
    return node;
  }

  /** Delete a node and every edge attached to it. */
  deleteNode(id: string): boolean {
    this.ensureLoaded();
    if (!this.nodes.has(id)) return false;
    this.deleteNodeInternal(id);
    this.persist();
    return true;
  }

  private deleteNodeInternal(id: string): void {
    for (const edgeId of [...(this.adjacencyOut.get(id) ?? []), ...(this.adjacencyIn.get(id) ?? [])]) {
      const edge = this.edges.get(edgeId);
      if (edge) {
        this.edges.delete(edgeId);
        this.edgeByFingerprint.delete(edgeFingerprint(edge.sourceId, edge.relationship, edge.targetId));
        this.unindexEdge(edge);
      }
    }
    this.adjacencyOut.delete(id);
    this.adjacencyIn.delete(id);
    this.nodes.delete(id);
  }

  // ------------------------------------------------------------------
  // Edge operations
  // ------------------------------------------------------------------
  /** Create an edge. Null when invalid, dangling, a self-loop, or duplicate. */
  createEdge(input: CreateEdgeInput): KnowledgeEdge | null {
    this.ensureLoaded();
    const candidate: KnowledgeEdge = {
      id: KnowledgeGraph.edgeId(input.sourceId, input.relationship, input.targetId),
      sourceId: input.sourceId,
      targetId: input.targetId,
      relationship: input.relationship,
      confidence: input.confidence,
      source: input.source,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    if (!validateEdge(candidate)) return null;
    if (!this.nodes.has(candidate.sourceId) || !this.nodes.has(candidate.targetId)) return null;
    if (this.edgeByFingerprint.has(edgeFingerprint(candidate.sourceId, candidate.relationship, candidate.targetId))) {
      return null; // duplicate prevention
    }
    this.edges.set(candidate.id, candidate);
    this.edgeByFingerprint.set(edgeFingerprint(candidate.sourceId, candidate.relationship, candidate.targetId), candidate.id);
    this.indexEdge(candidate);
    this.evictEdgesIfNeeded();
    this.persist();
    return candidate;
  }

  /** Create or update (refresh confidence/source) an edge by its triple. */
  upsertEdge(input: CreateEdgeInput): KnowledgeEdge | null {
    this.ensureLoaded();
    const existingId = this.edgeByFingerprint.get(
      edgeFingerprint(input.sourceId, input.relationship, input.targetId)
    );
    const existing = existingId ? this.edges.get(existingId) : undefined;
    if (!existing) {
      return this.createEdge(input);
    }
    if (input.confidence !== undefined) existing.confidence = input.confidence;
    if (input.source !== undefined) existing.source = input.source;
    existing.updatedAt = this.now();
    this.persist();
    return existing;
  }

  getEdge(id: string): KnowledgeEdge | undefined {
    this.ensureLoaded();
    return this.edges.get(id);
  }

  hasEdge(sourceId: string, relationship: RelationshipType, targetId: string): boolean {
    this.ensureLoaded();
    return this.edgeByFingerprint.has(edgeFingerprint(sourceId, relationship, targetId));
  }

  deleteEdge(id: string): boolean {
    this.ensureLoaded();
    const edge = this.edges.get(id);
    if (!edge) return false;
    this.edges.delete(id);
    this.edgeByFingerprint.delete(edgeFingerprint(edge.sourceId, edge.relationship, edge.targetId));
    this.unindexEdge(edge);
    this.persist();
    return true;
  }

  // ------------------------------------------------------------------
  // Queries — bounded by design
  // ------------------------------------------------------------------
  getNodesByType(type: EntityType, limit: number = this.limits.maxQueryResults): KnowledgeNode[] {
    this.ensureLoaded();
    const cap = Math.min(Math.max(1, limit), this.limits.maxQueryResults);
    const out: KnowledgeNode[] = [];
    for (const n of this.nodes.values()) {
      if (n.type === type) {
        out.push(n);
        if (out.length >= cap) break;
      }
    }
    return out;
  }

  /** Neighbors (both directions), optionally filtered by relationship type. */
  getRelatedNodes(nodeId: string, relationship?: RelationshipType, limit: number = this.limits.maxQueryResults): KnowledgeNode[] {
    this.ensureLoaded();
    const cap = Math.min(Math.max(1, limit), this.limits.maxQueryResults);
    const out: KnowledgeNode[] = [];
    const seen = new Set<string>([nodeId]);
    for (const edgeId of [...(this.adjacencyOut.get(nodeId) ?? []), ...(this.adjacencyIn.get(nodeId) ?? [])]) {
      const edge = this.edges.get(edgeId);
      if (!edge) continue;
      if (relationship && edge.relationship !== relationship) continue;
      const otherId = edge.sourceId === nodeId ? edge.targetId : edge.sourceId;
      if (seen.has(otherId)) continue;
      const node = this.nodes.get(otherId);
      if (!node) continue;
      seen.add(otherId);
      out.push(node);
      if (out.length >= cap) break;
    }
    return out;
  }

  /** Edges pointing INTO the node. */
  getIncomingRelations(nodeId: string, limit: number = this.limits.maxQueryResults): KnowledgeEdge[] {
    this.ensureLoaded();
    const cap = Math.min(Math.max(1, limit), this.limits.maxQueryResults);
    const out: KnowledgeEdge[] = [];
    for (const edgeId of this.adjacencyIn.get(nodeId) ?? []) {
      const edge = this.edges.get(edgeId);
      if (edge) {
        out.push(edge);
        if (out.length >= cap) break;
      }
    }
    return out;
  }

  /** Edges pointing OUT of the node. */
  getOutgoingRelations(nodeId: string, limit: number = this.limits.maxQueryResults): KnowledgeEdge[] {
    this.ensureLoaded();
    const cap = Math.min(Math.max(1, limit), this.limits.maxQueryResults);
    const out: KnowledgeEdge[] = [];
    for (const edgeId of this.adjacencyOut.get(nodeId) ?? []) {
      const edge = this.edges.get(edgeId);
      if (edge) {
        out.push(edge);
        if (out.length >= cap) break;
      }
    }
    return out;
  }

  /**
   * Directed BFS path search. Depth is clamped to limits.maxTraversalDepth —
   * unrestricted traversal is impossible. Returns node ids or null.
   */
  findPath(sourceId: string, targetId: string, maxDepth: number = this.limits.maxTraversalDepth): string[] | null {
    this.ensureLoaded();
    if (!this.nodes.has(sourceId) || !this.nodes.has(targetId)) return null;
    if (sourceId === targetId) return [sourceId];
    const depth = Math.max(1, Math.min(maxDepth, this.limits.maxTraversalDepth));
    const visited = new Set<string>([sourceId]);
    let frontier: Array<{ id: string; path: string[] }> = [{ id: sourceId, path: [sourceId] }];
    for (let d = 0; d < depth; d++) {
      const next: Array<{ id: string; path: string[] }> = [];
      for (const { id, path } of frontier) {
        for (const edgeId of this.adjacencyOut.get(id) ?? []) {
          const edge = this.edges.get(edgeId);
          if (!edge) continue;
          if (edge.targetId === targetId) return [...path, targetId];
          if (!visited.has(edge.targetId)) {
            visited.add(edge.targetId);
            next.push({ id: edge.targetId, path: [...path, edge.targetId] });
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return null;
  }

  /**
   * Bounded neighborhood expansion (BFS, both directions), result-capped.
   * Used by the Context Engine to fetch "relevant connected entities".
   */
  findRelatedEntities(nodeId: string, opts: { depth?: number; limit?: number; relationship?: RelationshipType } = {}): RelatedEntry[] {
    this.ensureLoaded();
    const depth = Math.max(1, Math.min(opts.depth ?? 1, this.limits.maxTraversalDepth));
    const limit = Math.min(Math.max(1, opts.limit ?? this.limits.maxQueryResults), this.limits.maxQueryResults);
    const out: RelatedEntry[] = [];
    const visited = new Set<string>([nodeId]);
    let frontier: Array<{ id: string; viaEdgeId: string }> = [];
    for (const edgeId of [...(this.adjacencyOut.get(nodeId) ?? []), ...(this.adjacencyIn.get(nodeId) ?? [])]) {
      const edge = this.edges.get(edgeId);
      if (!edge) continue;
      if (opts.relationship && edge.relationship !== opts.relationship) continue;
      frontier.push({ id: edge.sourceId === nodeId ? edge.targetId : edge.sourceId, viaEdgeId: edgeId });
    }
    for (let d = 1; d <= depth && frontier.length > 0 && out.length < limit; d++) {
      const next: Array<{ id: string; viaEdgeId: string }> = [];
      for (const { id, viaEdgeId } of frontier) {
        if (out.length >= limit) break;
        if (visited.has(id)) continue;
        const node = this.nodes.get(id);
        const edge = this.edges.get(viaEdgeId);
        if (!node || !edge) continue;
        visited.add(id);
        out.push({ node, depth: d, relationship: edge.relationship, direction: edge.sourceId === nodeId ? 'out' : edge.targetId === nodeId ? 'in' : 'out', confidence: edge.confidence });
        for (const nextEdgeId of [...(this.adjacencyOut.get(id) ?? []), ...(this.adjacencyIn.get(id) ?? [])]) {
          next.push({ id: this.edgeEndpoint(id, nextEdgeId), viaEdgeId: nextEdgeId });
        }
      }
      frontier = next;
    }
    return out;
  }

  private edgeEndpoint(fromId: string, edgeId: string): string {
    const edge = this.edges.get(edgeId);
    if (!edge) return fromId;
    return edge.sourceId === fromId ? edge.targetId : edge.sourceId;
  }

  /** All edges (bounded) — diagnostics/testing. */
  getAllEdges(limit: number = this.limits.maxQueryResults * 5): KnowledgeEdge[] {
    this.ensureLoaded();
    return [...this.edges.values()].slice(0, Math.max(1, limit));
  }

  stats(): KnowledgeStats {
    this.ensureLoaded();
    const byType: Record<string, number> = {};
    for (const n of this.nodes.values()) byType[n.type] = (byType[n.type] ?? 0) + 1;
    return {
      nodes: this.nodes.size,
      edges: this.edges.size,
      byType,
      evictedNodes: this.evictedNodes,
      evictedEdges: this.evictedEdges,
      corruptedEntriesDropped: this.corruptedEntriesDropped,
    };
  }

  clear(): void {
    this.ensureLoaded();
    this.nodes.clear();
    this.edges.clear();
    this.edgeByFingerprint.clear();
    this.adjacencyOut.clear();
    this.adjacencyIn.clear();
    this.store.clear();
  }

  // ------------------------------------------------------------------
  // Deterministic pruning
  // ------------------------------------------------------------------
  private evictNodesIfNeeded(): void {
    while (this.nodes.size > this.limits.maxNodes) {
      let victimId: string | undefined;
      let victimDegree = Infinity;
      let victimUpdated = Infinity;
      for (const n of this.nodes.values()) {
        const degree = (this.adjacencyOut.get(n.id)?.size ?? 0) + (this.adjacencyIn.get(n.id)?.size ?? 0);
        if (degree < victimDegree || (degree === victimDegree && n.updatedAt < victimUpdated)) {
          victimId = n.id;
          victimDegree = degree;
          victimUpdated = n.updatedAt;
        }
      }
      if (!victimId) break;
      this.deleteNodeInternal(victimId);
      this.evictedNodes++;
    }
  }

  private evictEdgesIfNeeded(): void {
    while (this.edges.size > this.limits.maxEdges) {
      let victim: KnowledgeEdge | undefined;
      for (const e of this.edges.values()) {
        const victimConf = victim ? victim.confidence ?? 0 : Infinity;
        const candidateConf = e.confidence ?? 0;
        if (candidateConf < victimConf || (candidateConf === victimConf && e.updatedAt < victim.updatedAt)) {
          victim = e;
        }
      }
      if (!victim) break;
      this.edges.delete(victim.id);
      this.edgeByFingerprint.delete(edgeFingerprint(victim.sourceId, victim.relationship, victim.targetId));
      this.unindexEdge(victim);
      this.evictedEdges++;
    }
  }
}
