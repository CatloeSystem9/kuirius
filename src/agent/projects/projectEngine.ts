/**
 * Project Engine (Project Awareness v1).
 *
 * Orchestrates approval → read-only scanning → bounded persistence →
 * Knowledge Graph / Memory mirroring → change detection. Everything runs ON
 * DEMAND (tool call or explicit refresh) — there is no polling, no timers
 * and no background scanning. Only approved roots are ever touched, only
 * metadata is ever stored, and no graph/memory failure can break indexing.
 */
import type { AgentEventBus } from '../events';
import type { KnowledgeGraphFacade } from '../knowledge/index';
import type { KnowledgeNode } from '../knowledge/knowledgeTypes';
import type { MemoryService } from '../memory/memoryService';
import { hashKey } from '../routing/cache';
import type { StorageAdapter } from '../taskState';
import { localStorageAdapter } from '../taskState';
import type { ProjectFs } from './projectFs';
import { ProjectStore } from './projectStore';
import { detectChanges, scanProject } from './projectScanner';
import type { ProjectChange, ProjectProfile, ProjectStats } from './projectTypes';
import { isStale, normalizeRoot, sameRoot } from './projectTypes';

export interface ProjectEngineOptions {
  fs: ProjectFs;
  storage?: StorageAdapter;
  knowledgeGraph?: KnowledgeGraphFacade;
  memory?: MemoryService;
  events?: AgentEventBus;
}

export interface IndexOutcome {
  ok: boolean;
  reason?: string;
  profile?: ProjectProfile;
}

export class ProjectEngine {
  readonly store: ProjectStore;
  private readonly fs: ProjectFs;
  private readonly knowledgeGraph?: KnowledgeGraphFacade;
  private readonly memory?: MemoryService;
  private readonly events?: AgentEventBus;

  constructor(options: ProjectEngineOptions) {
    this.fs = options.fs;
    this.store = new ProjectStore(options.storage ?? localStorageAdapter);
    this.knowledgeGraph = options.knowledgeGraph;
    this.memory = options.memory;
    this.events = options.events;
  }

  // ------------------------------------------------------------- approval

  /**
   * Approve a directory root for read-only awareness. The root must exist
   * and be listable — approval is always an explicit act, never inferred.
   */
  async approveRoot(root: string): Promise<{ ok: boolean; reason?: string; root?: string }> {
    const normalized = normalizeRoot(root);
    if (!normalized) return { ok: false, reason: 'empty path' };
    const probe = await this.fs.list(normalized);
    if (!probe.ok) return { ok: false, reason: `directory not accessible: ${probe.error ?? 'unknown error'}` };
    const added = this.store.approve(normalized);
    return { ok: true, root: normalized, reason: added ? undefined : 'already approved' };
  }

  revokeRoot(root: string): boolean {
    const removed = this.store.revoke(root);
    this.store.remove(root);
    return removed;
  }

  listApproved(): string[] {
    return [...this.store.approvedRoots];
  }

  // -------------------------------------------------------------- indexing

  /**
   * Index (or refresh) one approved project. Read-only, incremental: content
   * reads happen only for new/changed important files and always-relevant
   * manifests. Unapproved roots are refused — never silently accessed.
   */
  async index(root: string): Promise<IndexOutcome> {
    const normalized = normalizeRoot(root);
    if (!this.store.isApproved(normalized)) {
      return { ok: false, reason: `root not approved: ${normalized}` };
    }
    const probe = await this.fs.list(normalized);
    if (!probe.ok) {
      return { ok: false, reason: `directory not accessible: ${probe.error ?? 'unknown error'}` };
    }

    const previous = this.store.get(normalized);
    const scan = await scanProject(normalized, this.fs, previous ? { importantFiles: previous.importantFiles } : undefined);
    const now = Date.now();
    const profile: ProjectProfile = {
      id: 'proj_' + hashKey(normalized.toLowerCase()),
      root: normalized,
      name: scan.name,
      kind: scan.kind,
      languages: scan.languages,
      frameworks: scan.frameworks,
      dependencies: scan.dependencies,
      entryPoints: scan.entryPoints,
      configFiles: scan.configFiles,
      modules: scan.modules,
      importantFiles: scan.importantFiles,
      dirDigests: scan.dirDigests,
      stats: scan.stats,
      dev: previous?.dev ?? {},
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      lastIndexedAt: now,
    };
    this.store.upsert(profile);
    this.events?.emit({
      name: 'PROJECT_INDEXED',
      payload: { root: profile.root, name: profile.name, kind: profile.kind, filesSeen: profile.stats.filesSeen, secretsExcluded: profile.stats.secretsExcluded },
      timestamp: now,
    });
    this.mirrorToGraph(profile);
    this.mirrorToMemory(profile);
    return { ok: true, profile };
  }

  /**
   * Refresh only when the stored profile is missing or stale — the cheap
   * path for conversational use ("catch up on my project") without waste.
   */
  async refreshIfStale(root: string): Promise<{ indexed: boolean; profile?: ProjectProfile; reason?: string }> {
    const normalized = normalizeRoot(root);
    const existing = this.store.get(normalized);
    if (existing && !isStale(existing)) {
      return { indexed: false, profile: existing, reason: 'profile fresh' };
    }
    const outcome = await this.index(normalized);
    return { indexed: outcome.ok, profile: outcome.profile, reason: outcome.reason };
  }

  // --------------------------------------------------------------- changes

  /** Detect meaningful changes against the stored profile (read-only). */
  async changes(root: string): Promise<{ ok: boolean; reason?: string; change?: ProjectChange }> {
    const normalized = normalizeRoot(root);
    if (!this.store.isApproved(normalized)) return { ok: false, reason: `root not approved: ${normalized}` };
    const stored = this.store.get(normalized);
    if (!stored) return { ok: false, reason: 'project not indexed yet — run project.inspect first' };

    const diff = await detectChanges(normalized, this.fs, stored);
    const change: ProjectChange = {
      root: stored.root,
      name: stored.name,
      changedDirs: diff.changedDirs,
      added: diff.added,
      removed: diff.removed,
      modified: diff.modified,
      unchanged: diff.unchanged && diff.added.length === 0,
      detectedAt: Date.now(),
    };
    this.events?.emit({
      name: 'PROJECT_CHANGES',
      payload: { root: change.root, unchanged: change.unchanged, changedDirs: change.changedDirs.length, added: change.added.length, removed: change.removed.length, modified: change.modified.length },
      timestamp: Date.now(),
    });
    return { ok: true, change };
  }

  // ------------------------------------------------------------ dev status

  /** Get (or update) the development-progress record for a project. */
  async status(
    root: string,
    patch?: { goal?: string; progress?: string; blockers?: string[]; completed?: string[] }
  ): Promise<{ ok: boolean; reason?: string; dev?: ProjectProfile['dev']; name?: string }> {
    const normalized = normalizeRoot(root);
    if (!this.store.isApproved(normalized)) return { ok: false, reason: `root not approved: ${normalized}` };
    const profile = this.store.get(normalized);
    if (!profile) return { ok: false, reason: 'project not indexed yet — run project.inspect first' };

    if (patch) {
      if (patch.goal !== undefined) profile.dev.goal = patch.goal.trim().slice(0, 200) || undefined;
      if (patch.progress !== undefined) profile.dev.progress = patch.progress.trim().slice(0, 400) || undefined;
      if (patch.blockers !== undefined) {
        profile.dev.blockers = patch.blockers.map((b) => String(b).trim().slice(0, 200)).filter(Boolean).slice(0, 10);
        if (profile.dev.blockers.length === 0) delete profile.dev.blockers;
      }
      if (patch.completed !== undefined) {
        profile.dev.completed = patch.completed.map((c) => String(c).trim().slice(0, 200)).filter(Boolean).slice(0, 10);
        if (profile.dev.completed.length === 0) delete profile.dev.completed;
      }
      profile.dev.updatedAt = Date.now();
      profile.updatedAt = Date.now();
      this.store.upsert(profile);
      this.events?.emit({
        name: 'PROJECT_STATUS_UPDATED',
        payload: { root: profile.root, name: profile.name, goal: profile.dev.goal, hasBlockers: (profile.dev.blockers?.length ?? 0) > 0 },
        timestamp: Date.now(),
      });
      this.mirrorToMemory(profile);
    }
    return { ok: true, dev: profile.dev, name: profile.name };
  }

  // ------------------------------------------------------------- retrieval

  profile(root: string): ProjectProfile | undefined {
    const normalized = normalizeRoot(root);
    const direct = this.store.get(normalized);
    if (direct) return direct;
    const match = this.store.projects.find((p) => sameRoot(p.root, normalized));
    return match;
  }

  listProfiles(): ProjectProfile[] {
    return [...this.store.projects];
  }

  stats(): ProjectStats {
    const projects = this.store.projects;
    const kinds: Record<string, number> = {};
    for (const p of projects) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
    return {
      approvedRoots: this.store.approvedRoots.length,
      projects: projects.length,
      stale: projects.filter((p) => isStale(p)).length,
      kinds,
    };
  }

  /** Remove a project's knowledge AND its approval (both halves of consent). */
  forget(root: string): boolean {
    const normalized = normalizeRoot(root);
    const profile = this.profile(normalized);
    const removed = this.store.remove(normalized);
    this.store.revoke(normalized);
    if (removed) {
      this.events?.emit({ name: 'PROJECT_STATUS_UPDATED', payload: { root: normalized, forgotten: true }, timestamp: Date.now() });
      this.removeGraphMirror(profile?.root ?? normalized);
      this.removeMemoryMirror(profile, normalized);
    }
    return removed;
  }

  // -------------------------------------------------------------- mirroring

  /**
   * Knowledge Graph mirror — bounded per project (≤31 nodes, ≤30 edges):
   * the project node, its modules and key files ('part_of'), and its
   * frameworks ('uses'). This is ALSO the retrieval path: the Context Engine
   * already queries graph statements, so project questions surface this
   * knowledge with zero extra retrieval machinery.
   *
   * The mirror is REBUILT on every index: records for files or modules that
   * no longer exist (or for a forgotten project) are pruned, so the graph
   * never claims a removed file is still part of the project.
   */
  private mirrorToGraph(profile: ProjectProfile): void {
    if (!this.knowledgeGraph) return;
    try {
      this.pruneGraphMirror(profile.root, profile);
      const graph = this.knowledgeGraph.graph;
      const projectNode = graph.upsertNode({
        type: 'project',
        label: `Project: ${profile.name}`.slice(0, 80),
        properties: {
          root: profile.root,
          kind: profile.kind,
          languages: profile.languages.slice(0, 3).map((l) => l.language),
          frameworks: profile.frameworks.slice(0, 5),
          goal: profile.dev.goal,
          entryPoints: profile.entryPoints.slice(0, 4),
        },
      });
      if (!projectNode) return;

      for (const module of profile.modules.slice(0, 12)) {
        const node = graph.upsertNode({ type: 'component', label: `${profile.name}/${module.path}`.slice(0, 80), properties: { files: module.files, subdirs: module.subdirs } });
        if (node) graph.upsertEdge({ sourceId: node.id, targetId: projectNode.id, relationship: 'part_of', confidence: 0.7, source: 'project_awareness' });
      }
      for (const file of profile.importantFiles.filter((f) => f.role === 'entry' || f.role === 'manifest').slice(0, 12)) {
        const node = graph.upsertNode({ type: 'file', label: `${profile.name}/${file.path}`.slice(0, 80), properties: { role: file.role } });
        if (node) graph.upsertEdge({ sourceId: node.id, targetId: projectNode.id, relationship: 'part_of', confidence: 0.7, source: 'project_awareness' });
      }
      for (const framework of profile.frameworks.slice(0, 6)) {
        const node = graph.upsertNode({ type: 'tool', label: framework.slice(0, 60) });
        if (node) graph.upsertEdge({ sourceId: projectNode.id, targetId: node.id, relationship: 'uses', confidence: 0.6, source: 'project_awareness' });
      }
    } catch {
      // the graph must never break project indexing
    }
  }

  /**
   * Every project node recorded for this root (a renamed project leaves its
   * old label behind). Bounded lookup — the graph caps nodes, so this scan
   * is cheap and never polls.
   */
  private projectGraphNodes(root: string): KnowledgeNode[] {
    if (!this.knowledgeGraph) return [];
    try {
      const lower = normalizeRoot(root).toLowerCase();
      return this.knowledgeGraph.graph.getNodesByType('project', 64).filter((n) => typeof n.properties?.root === 'string' && normalizeRoot(n.properties.root).toLowerCase() === lower);
    } catch {
      return [];
    }
  }

  /**
   * Remove graph records that no longer match the fresh profile: edges and
   * project-owned nodes for files/modules that disappeared. A child node is
   * deleted only when NO other system references it (any non-
   * project_awareness edge keeps it alive — cross-system integrity first).
   * Called with a null profile when the project is forgotten entirely.
   */
  private pruneGraphMirror(root: string, profile: ProjectProfile | null): void {
    if (!this.knowledgeGraph) return;
    try {
      const graph = this.knowledgeGraph.graph;
      const keepLabels = new Set<string>();
      if (profile) {
        for (const m of profile.modules.slice(0, 12)) keepLabels.add(`${profile.name}/${m.path}`.slice(0, 80));
        for (const f of profile.importantFiles.filter((f) => f.role === 'entry' || f.role === 'manifest').slice(0, 12)) keepLabels.add(`${profile.name}/${f.path}`.slice(0, 80));
      }
      for (const projectNode of this.projectGraphNodes(root)) {
        for (const edge of [...graph.getIncomingRelations(projectNode.id, 64), ...graph.getOutgoingRelations(projectNode.id, 64)]) {
          if (edge.source !== 'project_awareness') continue;
          const otherId = edge.sourceId === projectNode.id ? edge.targetId : edge.sourceId;
          const other = graph.getNode(otherId);
          const otherLabel = other?.label ?? '';
          // Framework 'uses' edges are removed when stale; the shared tool
          // node itself may be referenced by other projects, so it stays.
          const childStays = profile !== null && (keepLabels.has(otherLabel) || edge.relationship === 'uses');
          // Reference check happens BEFORE the edge is removed: the node is
          // only deletable when nothing else will still point at it.
          const deletable = !childStays && !!other && this.nodeHasNoOtherReferences(other.id, edge.id);
          graph.deleteEdge(edge.id);
          if (deletable) graph.deleteNode(other!.id);
        }
        if (profile === null) graph.deleteNode(projectNode.id);
      }
    } catch {
      // pruning must never break indexing or forgetting
    }
  }

  /** True when no edge other than `ignoreEdgeId` still references the node. */
  private nodeHasNoOtherReferences(nodeId: string, ignoreEdgeId?: string): boolean {
    if (!this.knowledgeGraph) return false;
    try {
      const graph = this.knowledgeGraph.graph;
      const edges = [...graph.getIncomingRelations(nodeId, 32), ...graph.getOutgoingRelations(nodeId, 32)].filter((e) => e.id !== ignoreEdgeId);
      return edges.length === 0;
    } catch {
      return false;
    }
  }

  /** Full graph cleanup when a project is forgotten (never throws). */
  private removeGraphMirror(root: string): void {
    this.pruneGraphMirror(root, null);
  }

  /**
   * Release the durable memory records this engine wrote for a forgotten
   * project — through the EXISTING MemoryService.forget API. Only records
   * carrying this engine's own metadata markers (projectId / root) are
   * removed; user memories are never touched. Never throws.
   */
  private removeMemoryMirror(profile: ProjectProfile | undefined, root: string): void {
    if (!this.memory) return;
    try {
      const lower = normalizeRoot(root).toLowerCase();
      for (const record of [...this.memory.records]) {
        const meta = record.metadata as { projectId?: unknown; root?: unknown } | undefined;
        const metaRoot = typeof meta?.root === 'string' ? normalizeRoot(meta.root).toLowerCase() : '';
        if ((profile && meta?.projectId === profile.id) || (metaRoot && metaRoot === lower)) {
          this.memory.forget(record.id);
        }
      }
    } catch {
      // memory must never break forgetting
    }
  }

  /** Compact durable record through the EXISTING MemoryService (merge-safe). */
  private mirrorToMemory(profile: ProjectProfile): void {
    if (!this.memory) return;
    try {
      const goal = profile.dev.goal ? ` — goal: ${profile.dev.goal}` : '';
      const blockers = profile.dev.blockers?.length ? ` — blockers: ${profile.dev.blockers.length}` : '';
      this.memory.remember(`Project ${profile.name} (${profile.kind}) at ${profile.root}${goal}${blockers}`, {
        category: 'semantic',
        source: 'agent_task',
        importance: 0.55,
        confidence: 0.8,
        tags: ['project-awareness', 'project'],
        metadata: { projectId: profile.id, root: profile.root, kind: profile.kind },
      });
    } catch {
      // memory must never break project indexing
    }
  }
}
