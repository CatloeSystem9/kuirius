/**
 * Context Retriever (Context Engine v1) — TARGETED retrieval (spec §5).
 *
 * Only retrieves what the analyzer required. Reuses the existing MemoryService
 * recall and the TaskStore — never duplicates them. Cached knowledge comes
 * from the two-type cache (session → persistent). File/environment providers
 * are optional injection points (future project-awareness), kept off unless
 * required by the analysis.
 */
import type { ContextItem, ContextPriority, ContextRequest, ContextRequirements } from './contextTypes';
import type { SessionCache, PersistentCache } from './contextCache';
import { cacheKey } from './contextCache';
import type { SemanticExpansion } from '../semantic/semanticTypes';
import { normalizeTerm } from '../semantic/semanticExpander';

const MAX_MEMORY_ITEMS = 5;
const MAX_CONVERSATION_TURNS = 6;
const MAX_TOOL_STATE_ITEMS = 4;
const MAX_CACHED_KNOWLEDGE = 3;
const MAX_ITEM_CHARS = 800;

/** Priorities by source — local/authoritative before ambient. */
const SOURCE_PRIORITY: Record<ContextItem['source'], ContextPriority> = {
  user: 'P0',
  constraints: 'P0',
  task_state: 'P0',
  tool_state: 'P1',
  memory: 'P1',
  project_files: 'P1',
  knowledge_graph: 'P1',
  cached_knowledge: 'P2',
  conversation: 'P2',
  environment: 'P3',
};

function toItem(
  source: ContextItem['source'],
  content: string,
  timestamp: number,
  extra: Partial<ContextItem> = {}
): ContextItem {
  const trimmed = String(content ?? '').trim().slice(0, MAX_ITEM_CHARS);
  return {
    id: extra.id ?? `${source}_${timestamp}_${Math.random().toString(36).slice(2, 6)}`,
    source,
    content: trimmed,
    priority: extra.priority ?? SOURCE_PRIORITY[source],
    timestamp,
    chars: trimmed.length,
    ...extra,
  };
}

export interface RetrieveDeps {
  memory?: ContextEngineMemory;
  getTask?: ContextEngineTaskGetter;
  sessionCache: SessionCache;
  persistentCache: PersistentCache;
  /** Knowledge Graph v1 provider — targeted relational statements (optional). */
  knowledge?: { query(input: string, limit?: number): string[] };
  /**
   * Semantic Intelligence v1 — bounded expansions for this request (optional).
   * Used ONLY to widen the memory recall query and the cache keyword scan;
   * scoring still happens in the RelevanceEngine.
   */
  expansions?: SemanticExpansion[];
  now: number;
}

export interface ContextEngineMemory {
  recall(query: string, options?: { limit?: number }): Array<{
    content: string;
    createdAt?: number;
    updatedAt?: number;
    importance?: number;
    category?: string;
  }>;
}

export type ContextEngineTaskGetter = (id: string) =>
  | { goal?: { description?: string }; status?: string; memoryContext?: string[]; context?: Record<string, unknown> }
  | undefined;

/** Retrieve candidates per the requirements. Each source is independent and failure-isolated. */
export function retrieveCandidates(request: ContextRequest, requirements: ContextRequirements, deps: RetrieveDeps): ContextItem[] {
  const items: ContextItem[] = [];
  const now = deps.now;
  const expansions = deps.expansions ?? [];

  // P0: the current instruction itself (always a candidate, never dropped by relevance).
  items.push(toItem('user', request.input, now, { id: 'user_current', importance: 1 }));

  // P0: explicit constraints (safety/permission lines the caller pinned).
  for (const c of request.constraints ?? []) {
    items.push(toItem('constraints', c, now, { id: `constraint_${items.length}` }));
  }

  // Task state (P0) + tool state (P1) from the existing TaskStore.
  if ((requirements.needsTaskState || requirements.needsToolState) && request.taskId && deps.getTask) {
    try {
      const task = deps.getTask(request.taskId);
      if (task) {
        if (task.goal?.description) {
          items.push(toItem('task_state', `Active task: ${task.goal.description}`, now, { id: 'task_goal' }));
        }
        if (requirements.needsToolState && task.context) {
          let count = 0;
          for (const [key, value] of Object.entries(task.context)) {
            if (count >= MAX_TOOL_STATE_ITEMS) break;
            // Skip volatile/heavy entries (screenshots/images are never context).
            if (/screen|screenshot|image|audio/i.test(key)) continue;
            const text = typeof value === 'string' ? value : JSON.stringify(value);
            if (!text) continue;
            items.push(toItem('tool_state', `${key}: ${text}`, now, { id: `tool_${key}` }));
            count++;
          }
        }
      }
    } catch {
      // task retrieval must never break context building
    }
  }

  // Persistent memory (P1) — existing MemoryService recall, targeted. With
  // semantic expansions the recall query carries the related terms so
  // memory written with different vocabulary is still reachable.
  if (requirements.needsMemory && deps.memory) {
    try {
      const recalled = deps.memory.recall(buildSemanticQuery(request.input, expansions), { limit: MAX_MEMORY_ITEMS });
      for (const r of recalled) {
        if (!r?.content) continue;
        items.push(
          toItem('memory', r.content, r.updatedAt ?? r.createdAt ?? now, {
            importance: r.importance,
            metadata: { category: r.category },
          })
        );
      }
    } catch {
      // memory failure → continue with whatever valid context remains
    }
  }

  // Recent conversation (P2) — already-held turns, no re-retrieval.
  if (requirements.needsConversation && request.conversation?.length) {
    for (const turn of request.conversation.slice(-MAX_CONVERSATION_TURNS)) {
      if (!turn?.content) continue;
      items.push(toItem('conversation', `${turn.role}: ${turn.content}`, turn.timestamp ?? now));
    }
  }

  // Cached knowledge (P2, stale-tolerant per analyzer) — deterministic
  // session key for the exact query, then a bounded persistent-cache scan
  // (semantically widened when expansions exist).
  if (requirements.keywords.length > 0) {
    try {
      const exact = cacheKey('knowledge', request.input);
      const exactHit = deps.sessionCache.get(exact);
      const hits: Array<{ entry: import('./contextTypes').CacheEntry; stale: boolean }> = [];
      if (exactHit.hit && exactHit.entry) hits.push({ entry: exactHit.entry, stale: false });
      hits.push(...deps.persistentCache.findByKeywords(expandedCacheKeywords(requirements.keywords, expansions), MAX_CACHED_KNOWLEDGE));
      const seen = new Set<string>();
      for (const hit of hits.slice(0, MAX_CACHED_KNOWLEDGE)) {
        if (seen.has(hit.entry.key)) continue;
        seen.add(hit.entry.key);
        items.push(
          toItem('cached_knowledge', summarizeCacheValue(hit.entry.value), hit.entry.updatedAt, {
            stale: hit.stale,
            cacheKey: hit.entry.key,
            metadata: { source: hit.entry.source },
          })
        );
      }
    } catch {
      // cache failure → fall through to network metadata honestly
    }
  }

  // Knowledge graph (P1, Knowledge Graph v1) — targeted relational context
  // from the injected provider. Bounded local Map lookups; a graph failure
  // never breaks retrieval; chitchat never triggers it.
  if (deps.knowledge && requirements.intent !== 'chitchat') {
    try {
      const statements = deps.knowledge.query(request.input, 3);
      for (const statement of statements.slice(0, 3)) {
        if (!statement) continue;
        items.push(toItem('knowledge_graph', statement, now, { id: `kg_${items.length}`, importance: 0.75 }));
      }
    } catch {
      // graph failure → continue with whatever valid context remains
    }
  }

  return items;
}

/** Compact, bounded text for a cached value (never dumps raw payloads). */
export function summarizeCacheValue(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return String(text).replace(/\s+/g, ' ').trim().slice(0, 400);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Semantic Intelligence v1 — bounded query widening
// ---------------------------------------------------------------------------

const MAX_SEMANTIC_QUERY_CHARS = 600;
const MAX_CACHE_KEYWORDS = 16;

/**
 * The recall query: the user input plus expansion terms (bounded). The
 * MemoryService's own deterministic token matching does the rest — semantic
 * intelligence only widens what it can see, it never replaces ranking.
 */
export function buildSemanticQuery(input: string, expansions: SemanticExpansion[] | undefined): string {
  const base = String(input ?? '');
  if (!expansions || expansions.length === 0) return base;
  const terms: string[] = [];
  for (const e of expansions) {
    const term = normalizeTerm(e?.term ?? '');
    if (term && !terms.includes(term)) terms.push(term);
    if (terms.length >= 8) break;
  }
  if (terms.length === 0) return base;
  return `${base} ${terms.join(' ')}`.slice(0, MAX_SEMANTIC_QUERY_CHARS);
}

/** Cache scan keywords: original keywords + single-word expansion terms, bounded + deduped. */
export function expandedCacheKeywords(keywords: string[], expansions: SemanticExpansion[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of Array.isArray(keywords) ? keywords : []) {
    if (typeof k === 'string' && k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  if (expansions) {
    for (const e of expansions) {
      if (out.length >= MAX_CACHE_KEYWORDS) break;
      const term = normalizeTerm(e?.term ?? '');
      if (term && !term.includes(' ') && !seen.has(term)) {
        seen.add(term);
        out.push(term);
      }
    }
  }
  return out.slice(0, MAX_CACHE_KEYWORDS);
}

export { toItem, cacheKey };
