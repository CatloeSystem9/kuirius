/**
 * Context Engine (Context Engine v1) — the facade.
 *
 * Pipeline (spec §12):
 *   analyze → retrieve (targeted) → rank → budget → build → ContextPackage
 *
 * LOCAL-FIRST → CACHE-FIRST → NETWORK-LAST is expressed concretely:
 *  - retrieval prefers task state, memory and conversation already in hand,
 *  - cached knowledge is consulted BEFORE the network and served (marked
 *    stale) whenever the request tolerates staleness,
 *  - the package carries networkRequired/networkReason metadata so callers
 *    can minimize — never block — legitimate network use.
 *
 * Event-driven only: attach(bus) reacts to USER_MESSAGE / TASK_COMPLETED.
 * No polling, no background processes, all state bounded. Every stage is
 * failure-isolated — the engine degrades to "no context" rather than ever
 * breaking the agent (spec §16).
 */
import type { AgentEvent, AgentEventBus } from '../events';
import type { ContextEngineOptions, ContextPackage, ContextRequest, ContextCacheLimits, ContextBudgetConfig } from './contextTypes';
import { CONTEXT_CACHE_STORAGE_KEY, DEFAULT_CACHE_LIMITS, DEFAULT_CONTEXT_BUDGET } from './contextTypes';
import { analyzeContext } from './contextAnalyzer';
import { retrieveCandidates, type ContextEngineTaskGetter } from './contextRetriever';
import { rankItems } from './relevanceEngine';
import { packWithinBudget } from './contextBudget';
import { buildPackage } from './contextBuilder';
import { PersistentCache, SessionCache, cacheKey } from './contextCache';
import { SemanticIntelligence } from '../semantic/semanticExpander';

const MAX_TASK_PACKAGES = 8;
const MIN_CACHEABLE_RESULT_CHARS = 40;
const MAX_CACHEABLE_RESULT_CHARS = 4000;

export class ContextEngine {
  readonly sessionCache: SessionCache;
  readonly persistentCache: PersistentCache;
  readonly budget: ContextBudgetConfig;
  private readonly memory?: ContextEngineOptions['memory'];
  private readonly knowledge?: NonNullable<ContextEngineOptions['knowledge']>;
  /** Semantic Intelligence v1 — injected or a minimal default (offline, bounded). */
  readonly semantic: SemanticIntelligence;
  private readonly getTask?: ContextEngineTaskGetter;
  private readonly now: () => number;
  private lastPackages = new Map<string, ContextPackage>();

  constructor(options: ContextEngineOptions = {}) {
    const limits: Partial<ContextCacheLimits> = { ...options.cache };
    this.memory = options.memory;
    this.knowledge = options.knowledge;
    this.semantic = options.semantic ?? new SemanticIntelligence({ now: options.now ?? Date.now });
    this.getTask = options.taskStore
      ? (id) => options.taskStore!.get(id) as ReturnType<ContextEngineTaskGetter>
      : undefined;
    this.now = options.now ?? Date.now;
    this.budget = { ...DEFAULT_CONTEXT_BUDGET, ...options.budget };
    this.sessionCache = new SessionCache(limits, this.now);
    this.persistentCache = new PersistentCache(options.cacheStorage, limits, this.now);
  }

  /**
   * Full pipeline for one request. Never throws; on any internal failure the
   * caller gets a minimal honest package (requirements-only).
   */
  buildContext(request: ContextRequest): ContextPackage {
    const now = request.now ?? this.now();
    try {
      const requirements = analyzeContext(request);
      // Semantic Intelligence v1: bounded local expansion AFTER the cheap
      // deterministic analysis, BEFORE retrieval/scoring. Cached through the
      // existing session cache; a failure here degrades to zero expansions.
      const expansions = this.semantic.expand(requirements.keywords, {
        input: request.input,
        intent: requirements.intent,
        cache: this.sessionCache,
        now,
      });
      const candidates = retrieveCandidates(request, requirements, {
        memory: this.memory as never,
        getTask: this.getTask,
        sessionCache: this.sessionCache,
        persistentCache: this.persistentCache,
        knowledge: this.knowledge,
        expansions,
        now,
      });
      const ranked = rankItems(candidates, requirements, now, expansions);
      const outcome = packWithinBudget(ranked, this.budget);
      const skipped = this.skippedSources(requirements);
      const pkg = buildPackage(request, requirements, outcome, { skippedSources: skipped, now });
      pkg.metadata.budgetCap = this.budget.maxChars;
      if (request.taskId) {
        this.lastPackages.set(request.taskId, pkg);
        while (this.lastPackages.size > MAX_TASK_PACKAGES) {
          this.lastPackages.delete(this.lastPackages.keys().next().value as string);
        }
      }
      return pkg;
    } catch {
      // Graceful degradation (spec §16): an empty-but-honest package.
      const requirements = analyzeContext(request);
      return {
        request: request.input,
        requirements,
        relevantMemories: [],
        relevantConversation: [],
        relevantFiles: [],
        relevantToolState: [],
        environmentState: [],
        cachedKnowledge: [],
        constraints: request.constraints ?? [],
        metadata: {
          generatedAt: now,
          networkRequired: requirements.networkNeed === 'required',
          networkReason: requirements.networkReason,
          staleTolerant: requirements.staleTolerant,
          candidatesConsidered: 0,
          itemsKept: 0,
          itemsDropped: 0,
          charsUsed: 0,
          budgetCap: this.budget.maxChars,
          staleCount: 0,
          skippedSources: [],
        },
      };
    }
  }

  /** The most recent package built for a task (bounded map, diagnostics/future use). */
  getTaskContext(taskId: string): ContextPackage | undefined {
    return this.lastPackages.get(taskId);
  }

  /**
   * Cache-first lookup for external information (network-last enforcement).
   * Callers use this BEFORE making a network request; `stale` results are
   * clearly marked and only served when the request tolerates staleness.
   */
  lookupKnowledge(identifier: string, opts: { allowStale?: boolean } = {}): { hit: boolean; value?: unknown; stale?: boolean } {
    const key = cacheKey('knowledge', identifier);
    const session = this.sessionCache.get(key);
    if (session.hit) return { hit: true, value: session.value };
    const persistent = this.persistentCache.get(key, opts);
    if (persistent.hit) return { hit: true, value: persistent.value, stale: persistent.stale };
    return { hit: false };
  }

  /** Store reusable external information (persistent — survives restarts). */
  cacheKnowledge(identifier: string, value: unknown, opts: { ttlMs?: number; source?: string } = {}): void {
    try {
      const key = cacheKey('knowledge', identifier);
      const text = JSON.stringify(value ?? null);
      if (!text || text.length < MIN_CACHEABLE_RESULT_CHARS || text.length > MAX_CACHEABLE_RESULT_CHARS) return;
      this.persistentCache.set(key, value, { source: opts.source ?? 'context_engine', ttlMs: opts.ttlMs });
    } catch {
      // caching must never break the caller
    }
  }

  /** Session-scoped temporary value (never persisted). */
  cacheSession(identifier: string, value: unknown, opts: { ttlMs?: number } = {}): void {
    try {
      this.sessionCache.set(cacheKey('session', identifier), value, { ttlMs: opts.ttlMs, source: 'context_engine' });
    } catch {
      // ignore
    }
  }

  lookupSession(identifier: string): { hit: boolean; value?: unknown } {
    const r = this.sessionCache.get(cacheKey('session', identifier));
    return { hit: r.hit, value: r.value };
  }

  /**
   * Post-result caching (spec §13) — decide whether a completed task's output
   * is worth persisting. NOT everything is cached: reusable, reasonably
   * stable, bounded results only; volatile artifacts (screenshots/images/
   * audio) are never persisted.
   */
  afterTaskCompleted(taskId: string, task: { goal?: { description?: string }; summary?: string; context?: Record<string, unknown> }): void {
    try {
      if (task.summary && task.summary.length >= MIN_CACHEABLE_RESULT_CHARS) {
        this.cacheSession(`task_summary_${taskId}`, task.summary.slice(0, 600), { ttlMs: DEFAULT_CACHE_LIMITS.sessionTtlMs });
      }
      if (task.context) {
        for (const [key, value] of Object.entries(task.context)) {
          if (/screen|screenshot|image|audio|blob/i.test(key)) continue; // volatile → never cached
          const text = JSON.stringify(value ?? null);
          if (!text || text.length < MIN_CACHEABLE_RESULT_CHARS || text.length > MAX_CACHEABLE_RESULT_CHARS) continue;
          // Structured step outputs are reusable knowledge keyed by the goal.
          const identifier = `${task.goal?.description ?? 'task'}|${key}`;
          this.cacheKnowledge(identifier, value, { ttlMs: 7 * 24 * 60 * 60_000, source: 'task_result' });
        }
      }
    } catch {
      // post-result caching is best-effort
    }
  }

  /** Event-driven attachment (no polling): context per USER_MESSAGE, caching per TASK_COMPLETED. */
  attach(bus: AgentEventBus): () => void {
    const offs: Array<() => void> = [];
    offs.push(
      bus.on('USER_MESSAGE', (event: AgentEvent) => {
        try {
          const input = String((event.payload as { input?: string } | undefined)?.input ?? '');
          if (!input || !event.taskId) return;
          this.buildContext({ input, taskId: event.taskId, now: Date.now() });
        } catch {
          // never break task execution
        }
      })
    );
    offs.push(
      bus.on('TASK_COMPLETED', (event: AgentEvent) => {
        try {
          if (!event.taskId) return;
          const task = this.getTask?.(event.taskId);
          if (task) this.afterTaskCompleted(event.taskId, task as never);
        } catch {
          // ignore
        }
      })
    );
    return () => offs.forEach((off) => off());
  }

  stats(): { session: ReturnType<SessionCache['stats']>; persistent: ReturnType<PersistentCache['stats']>; packages: number } {
    return {
      session: this.sessionCache.stats(),
      persistent: this.persistentCache.stats(),
      packages: this.lastPackages.size,
    };
  }

  /** Invalidate cached knowledge (e.g. when the user knows data changed). */
  invalidateKnowledge(identifier?: string): number {
    return identifier ? this.persistentCache.invalidate(cacheKey('knowledge', identifier)) : this.persistentCache.invalidate('knowledge:');
  }

  clearCaches(): void {
    this.sessionCache.clear();
    this.persistentCache.clear();
    this.lastPackages.clear();
  }

  get storageKey(): string {
    return CONTEXT_CACHE_STORAGE_KEY;
  }

  private skippedSources(requirements: ReturnType<typeof analyzeContext>): ContextPackage['metadata']['skippedSources'] {
    const skipped: ContextPackage['metadata']['skippedSources'] = [];
    if (!requirements.needsMemory) skipped.push('memory');
    if (!requirements.needsTaskState) skipped.push('task_state');
    if (!requirements.needsConversation) skipped.push('conversation');
    if (!requirements.needsToolState) skipped.push('tool_state');
    if (!requirements.needsEnvironment) skipped.push('environment');
    if (!requirements.needsProjectFiles) skipped.push('project_files');
    return skipped;
  }
}
