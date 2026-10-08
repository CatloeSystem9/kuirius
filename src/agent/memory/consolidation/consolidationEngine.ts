/**
 * Consolidation Engine (v1) — Intelligent Memory Consolidation.
 *
 * Hierarchy (spec): interaction → Context Engine → Semantic Intelligence →
 * Memory + Knowledge Graph → consolidation decision → persist ONLY if useful.
 *
 * Event-driven ONLY (USER_MESSAGE / TASK_COMPLETED — both pre-existing bus
 * events; the same pattern as the Knowledge Indexer). No polling, no timers,
 * no full-memory scans: dedup compares against a bounded window of recent
 * durable memories, and graph writes are idempotent (stable ids).
 *
 * Safety invariants:
 *  - MemoryService.remember() stays the ONLY memory write path (worth
 *    assessment, secret rejection, duplicate merge and conflict resolution
 *    remain authoritative — the engine never bypasses them),
 *  - speculation/chitchat/temporary/secrets never consolidate,
 *  - below-threshold candidates require recurrence (bounded ledger) before
 *    promotion — never a guess turned into permanent knowledge,
 *  - graph conflicts: only explicit user statements may add a `supersedes`
 *    edge; weaker/derived candidates never override existing structure,
 *  - uncertain → DO NOT CONSOLIDATE (false negatives are preferred).
 */
import type { AgentEvent, AgentEventBus } from '../../events';
import type { StorageAdapter } from '../../taskState';
import type { MemoryService, RememberOutcome } from '../memoryService';
import { extractPreferenceTriples, isContradictory } from '../memoryService';
import type { MemoryRecord } from '../memoryTypes';
import { similarity, tokenize } from '../similarity';
import type { KnowledgeGraph } from '../../knowledge/knowledgeGraph';
import type { SemanticIntelligence } from '../../semantic/semanticExpander';
import { normalizeTerm } from '../../semantic/semanticExpander';
import {
  classifyCandidate,
  candidateKey,
  entityTypeForSubject,
  extractStructuredRelation,
  isDurableCorrection,
  sanitizeCandidate,
} from './consolidationRules';
import type {
  ConsolidationClassification,
  ConsolidationLimits,
  ConsolidationResult,
  ConsolidationSource,
  LedgerEntry,
  StructuredRelation,
} from './consolidationTypes';
import { CONSOLIDATION_LEDGER_SCHEMA_VERSION, CONSOLIDATION_LEDGER_STORAGE_KEY, DEFAULT_CONSOLIDATION_LIMITS, KIND_IMPORTANCE } from './consolidationTypes';

/** Memory categories the engine reads during bounded dedup scans. */
const SCAN_CATEGORIES = new Set(['preference', 'long_term', 'correction', 'workflow', 'semantic']);

/** Memory categories the engine will merge INTO (never episodic/short_term). */
const MERGEABLE_CATEGORIES = new Set(['preference', 'long_term', 'correction', 'semantic']);

function kindCategory(kind: ConsolidationClassification['kind']): MemoryRecord['category'] {
  return kind === 'preference' ? 'preference' : 'long_term';
}

export interface ConsolidationEngineDeps {
  /** Existing Memory Service — the authoritative memory write path. */
  memory: MemoryService;
  /** Existing Knowledge Graph core (KnowledgeGraphFacade.graph). Optional. */
  knowledge?: KnowledgeGraph;
  /** Existing Semantic Intelligence v1 — related-memory detection only. */
  semantic?: SemanticIntelligence;
  /** Storage for the bounded recurrence ledger (StorageAdapter convention). */
  storage?: StorageAdapter;
  /** Existing TaskStore accessor for TASK_COMPLETED extraction. */
  getTask?: (id: string) => {
    goal?: { description?: string };
    summary?: string;
    /** Intelligence Loop v1 — goal-level verification gates learning. */
    verification?: { outcome?: 'pass' | 'uncertain' | 'fail' };
  } | undefined;
  now?: () => number;
  limits?: Partial<ConsolidationLimits>;
}

export class ConsolidationEngine {
  readonly limits: ConsolidationLimits;
  private readonly memory: MemoryService;
  private readonly knowledge?: KnowledgeGraph;
  private readonly semantic?: SemanticIntelligence;
  private readonly storage?: StorageAdapter;
  private readonly getTask?: ConsolidationEngineDeps['getTask'];
  private readonly now: () => number;
  private readonly ledger = new Map<string, LedgerEntry>();
  private ledgerLoaded = false;
  private readonly recent: ConsolidationResult[] = [];
  private counters = { processed: 0, created: 0, updated: 0, superseded: 0, rejected: 0, ignored: 0 };

  constructor(deps: ConsolidationEngineDeps) {
    this.memory = deps.memory;
    this.knowledge = deps.knowledge;
    this.semantic = deps.semantic;
    this.storage = deps.storage;
    this.getTask = deps.getTask;
    this.now = deps.now ?? Date.now;
    this.limits = { ...DEFAULT_CONSOLIDATION_LIMITS, ...deps.limits };
  }

  // ------------------------------------------------------------------ events

  /** Event-driven attachment (no polling). Returns a detach function. */
  attach(bus: AgentEventBus): () => void {
    const offs: Array<() => void> = [];
    offs.push(
      bus.on('USER_MESSAGE', (event: AgentEvent) => {
        try {
          const input = String((event.payload as { input?: string } | undefined)?.input ?? '');
          if (input) {
            for (const result of this.consolidate(input, 'user_message')) {
              if (event.taskId) result.taskId = event.taskId;
            }
          }
        } catch {
          // consolidation must never break task execution
        }
      })
    );
    offs.push(
      bus.on('TASK_COMPLETED', (event: AgentEvent) => {
        try {
          const taskId = event.taskId ?? '';
          if (!taskId) return;
          // Idempotency (Intelligence Loop v1): a repeated completion event
          // for the same task never triggers duplicate consolidation work.
          if (this.processedTasks.has(taskId)) {
            this.record({ action: 'ignored', reason: 'duplicate_task_completion', source: 'task_result', confidence: 0, taskId });
            return;
          }
          this.rememberTaskId(taskId);
          const task = this.getTask?.(taskId);
          if (!task) return;
          // Verification gate (Intelligence Loop v1): unverified results are
          // never promoted to durable knowledge — DO NOT learn from uncertainty.
          if (task.verification?.outcome === 'uncertain') {
            this.record({ action: 'ignored', reason: 'unverified_result', source: 'task_result', confidence: 0, taskId });
            return;
          }
          for (const result of this.consolidateTaskCompletion(task)) {
            result.taskId = taskId;
          }
        } catch {
          // ignore
        }
      })
    );
    return () => offs.forEach((off) => off());
  }

  /** Bounded processed-task registry (FIFO eviction, deterministic ids). */
  private readonly processedTasks = new Set<string>();

  private rememberTaskId(taskId: string): void {
    if (this.processedTasks.has(taskId)) return;
    while (this.processedTasks.size >= 128) {
      const oldest = this.processedTasks.values().next().value as string | undefined;
      if (!oldest) break;
      this.processedTasks.delete(oldest);
    }
    this.processedTasks.add(taskId);
  }

  // ---------------------------------------------------------------- public API

  /**
   * Consolidate one piece of interaction content. Bounded: at most
   * maxCandidatesPerInput outcomes (the fact + its structured relation).
   * Never throws — every failure becomes a safe 'rejected' result.
   */
  consolidate(input: string, source: ConsolidationSource): ConsolidationResult[] {
    const results: ConsolidationResult[] = [];
    try {
      const text = sanitizeCandidate(input, this.limits.maxContentChars);
      if (!text) {
        return [this.record({ action: 'rejected', reason: 'empty_or_malformed_input', source, confidence: 0 })];
      }
      const classification = classifyCandidate(text, source);
      if (!classification) {
        return [this.record({ action: 'ignored', reason: 'no_durable_signal', source, confidence: 0 })];
      }

      // 1. Memory surface (authoritative fact record / update / conflict).
      const memoryResult = this.consolidateFact(text, classification, source);
      results.push(memoryResult);

      // 2. Structured relation → graph surface (idempotent, bounded). Only
      // accompanies NEW or CHANGED facts — a recurrence update means the
      // fact is already represented, so no redundant graph structure.
      const structured = extractStructuredRelation(text);
      if (structured && (memoryResult.action === 'created' || memoryResult.action === 'superseded')) {
        const budget = { ops: Math.min(this.limits.maxGraphOpsPerEvent, 4) };
        const graphResult = this.consolidateStructured(structured, classification, source, budget);
        results.push(graphResult);
      }
      return results.slice(0, this.limits.maxCandidatesPerInput);
    } catch {
      return [this.record({ action: 'rejected', reason: 'consolidation_failed_safely', source, confidence: 0 })];
    }
  }

  /**
   * Consolidate durable knowledge from a completed task (tool-confirmed
   * outcome). Only the honest summary is a candidate — goals/requests are
   * never facts. Bounded to one input per event.
   */
  consolidateTaskCompletion(task: { goal?: { description?: string }; summary?: string }): ConsolidationResult[] {
    try {
      const summary = sanitizeCandidate(task?.summary, this.limits.maxContentChars);
      if (!summary) return [];
      return this.consolidate(summary, 'task_result');
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------- internals

  /** Memory surface: conflict → dedup → recurrence gate → remember(). */
  private consolidateFact(text: string, classification: ConsolidationClassification, source: ConsolidationSource): ConsolidationResult {
    const now = this.now();
    const key = candidateKey(text);

    // ---- bounded window scan (recent durable records only)
    const window = this.scanWindow();

    // ---- conflict pre-check: never merge contradictory stances as
    // "recurrence"; weak/ambiguous contradictions are rejected outright
    // ("if uncertain: DO NOT CONSOLIDATE"). An explicit durable user
    // correction is the only contradiction allowed through — the user
    // deliberately changed their mind, and the existing MemoryService
    // conflict resolution (supersede / keep-both) stays authoritative.
    const conflict = this.detectConflict(text, window);
    const durableCorrection = isDurableCorrection(text);
    if (conflict && !durableCorrection) {
      return this.record({ action: 'rejected', reason: 'conflicts_with_existing_fact', kind: classification.kind, source, confidence: classification.confidence, replacedMemoryId: conflict.id });
    }
    if (conflict && durableCorrection) {
      // The user deliberately changed their mind: skip dedup (a correction
      // shares its topic's token core with the old fact by definition) and
      // let the existing MemoryService conflict resolution decide
      // (supersede / keep-both — never a silent overwrite).
      const outcome = this.remember(text, classification, source, { confidence: classification.confidence, recurrence: 1 });
      return this.mapRememberOutcome(outcome, classification, source, 'memory');
    }

    // ---- bounded duplicate scan (equivalent fact → UPDATE, never duplicate)
    const existing = this.findExisting(text, classification, window);

    if (existing) {
      // Equivalent fact already exists → UPDATE, never duplicate (spec §13).
      const recurrence = (Number(existing.record.metadata?.recurrence) || 1) + 1;
      const confidence = Math.min(
        this.limits.maxRecurrenceConfidence,
        Math.max(classification.confidence, existing.record.confidence) + this.limits.recurrenceBump
      );
      // Enrich the stored wording when the new sighting is more informative.
      if (text.length > existing.record.content.length) {
        this.memory.update(existing.record.id, text);
      }
      this.memory.confirmRecurrence(existing.record.id, this.limits.recurrenceBump, this.limits.maxRecurrenceConfidence, now);
      return this.record({ action: 'updated', reason: `${existing.via}_match_recurrence`, kind: classification.kind, source, confidence, surface: 'memory', relatedMemoryId: existing.record.id, recurrence });
    }

    // ---- semantic near-duplicate guard (Semantic Intelligence v1):
    // related-but-not-equivalent statements are NOT persisted as new copies.
    const related = this.findSemanticRelated(text, window);
    if (related) {
      return this.record({ action: 'ignored', reason: 'semantically_related_memory_exists', kind: classification.kind, source, confidence: classification.confidence, relatedMemoryId: related.id });
    }

    // ---- confidence gate with bounded recurrence ledger
    let confidence = classification.confidence;
    if (confidence < this.limits.minConfidence) {
      const promoted = this.trackRecurrence(key, text, classification, source, now);
      if (!promoted) {
        const entry = this.ledger.get(key);
        return this.record({ action: 'ignored', reason: 'awaiting_recurrence', kind: classification.kind, source, confidence: entry ? classification.confidence + (entry.count - 1) * this.limits.recurrenceBump : classification.confidence, recurrence: entry?.count });
      }
      confidence = promoted;
    } else {
      this.ledger.delete(key); // direct-path promotion clears any pending sightings
    }

    // ---- create via the existing MemoryService (conflict resolution included)
    const outcome = this.remember(text, classification, source, { confidence, recurrence: 1 });
    return this.mapRememberOutcome(outcome, classification, source, 'memory');
  }

  /** Graph surface: idempotent structured writes + bounded conflict handling. */
  private consolidateStructured(
    rel: StructuredRelation,
    classification: ConsolidationClassification,
    source: ConsolidationSource,
    budget: { ops: number }
  ): ConsolidationResult {
    if (!this.knowledge) {
      return this.record({ action: 'ignored', reason: 'graph_unavailable', kind: classification.kind, source, confidence: classification.confidence, surface: 'graph' });
    }
    if (classification.confidence < this.limits.structuredMinConfidence) {
      return this.record({ action: 'ignored', reason: 'below_structured_threshold', kind: classification.kind, source, confidence: classification.confidence, surface: 'graph' });
    }
    if (budget.ops < 2) {
      return this.record({ action: 'ignored', reason: 'graph_ops_budget_exhausted', kind: classification.kind, source, confidence: classification.confidence, surface: 'graph' });
    }
    try {
      const subject = this.knowledge.upsertNode({ type: entityTypeForSubject(rel.subject), label: rel.subject });
      const object = this.knowledge.upsertNode({ type: 'resource', label: rel.object });
      budget.ops -= 2;
      if (!subject || !object) {
        return this.record({ action: 'rejected', reason: 'invalid_graph_entities', kind: classification.kind, source, confidence: classification.confidence, surface: 'graph' });
      }
      if (this.knowledge.hasEdge(subject.id, rel.relation, object.id)) {
        // Same triple already present → refresh confidence, no new structure.
        this.knowledge.upsertEdge({ sourceId: subject.id, targetId: object.id, relationship: rel.relation, confidence: classification.confidence, source: 'consolidation' });
        return this.record({ action: 'updated', reason: 'graph_triple_already_present', kind: classification.kind, source, confidence: classification.confidence, surface: 'graph' });
      }
      // Conflict: same subject+relation toward a DIFFERENT object.
      const neighbors = this.knowledge.getRelatedNodes(subject.id, rel.relation, this.limits.maxScanMemories);
      const conflicting = neighbors.find((n) => n.id !== object.id);
      if (conflicting) {
        // Only explicit user statements may supersede existing structure;
        // derived/task candidates never override (no invented resolution).
        if (source !== 'user_message') {
          return this.record({ action: 'ignored', reason: 'graph_conflict_unresolved', kind: classification.kind, source, confidence: classification.confidence, surface: 'graph' });
        }
        if (budget.ops < 2) {
          return this.record({ action: 'ignored', reason: 'graph_ops_budget_exhausted', kind: classification.kind, source, confidence: classification.confidence, surface: 'graph' });
        }
        this.knowledge.upsertEdge({ sourceId: subject.id, targetId: object.id, relationship: rel.relation, confidence: classification.confidence, source: 'consolidation' });
        this.knowledge.upsertEdge({ sourceId: object.id, targetId: conflicting.id, relationship: 'supersedes', confidence: classification.confidence, source: 'consolidation' });
        budget.ops -= 2;
        return this.record({ action: 'superseded', reason: 'graph_supersedes_existing_relation', kind: classification.kind, source, confidence: classification.confidence, surface: 'graph' });
      }
      this.knowledge.upsertEdge({ sourceId: subject.id, targetId: object.id, relationship: rel.relation, confidence: classification.confidence, source: 'consolidation' });
      budget.ops -= 1;
      return this.record({ action: 'created', reason: 'graph_relationship_recorded', kind: classification.kind, source, confidence: classification.confidence, surface: 'graph' });
    } catch {
      return this.record({ action: 'rejected', reason: 'graph_write_failed_safely', kind: classification.kind, source, confidence: classification.confidence, surface: 'graph' });
    }
  }

  /** Remember through the EXISTING service — its rules stay authoritative. */
  private remember(
    text: string,
    classification: ConsolidationClassification,
    source: ConsolidationSource,
    extra: { confidence: number; recurrence: number; lastConfirmedAt?: number }
  ): RememberOutcome {
    // Durable corrections get the stronger, already-supported memory source.
    const memorySource = isDurableCorrection(text) ? 'user_correction' : source === 'task_result' ? 'agent_task' : 'conversation_extract';
    return this.memory.remember(text, {
      category: kindCategory(classification.kind),
      source: memorySource,
      importance: KIND_IMPORTANCE[classification.kind],
      confidence: extra.confidence,
      tags: ['consolidated'],
      metadata: {
        consolidated: true,
        consolidationReason: classification.reason,
        recurrence: extra.recurrence,
        ...(extra.lastConfirmedAt ? { lastConfirmedAt: extra.lastConfirmedAt } : {}),
      },
    });
  }

  private mapRememberOutcome(outcome: RememberOutcome, classification: ConsolidationClassification, source: ConsolidationSource, surface: 'memory' | 'graph'): ConsolidationResult {
    switch (outcome.action) {
      case 'created':
        return this.record({ action: 'created', reason: classification.reason, kind: classification.kind, source, confidence: outcome.record.confidence, surface });
      case 'merged':
        return this.record({ action: 'merged', reason: 'merged_into_existing_memory', kind: classification.kind, source, confidence: outcome.record.confidence, surface, relatedMemoryId: outcome.record.id, replacedMemoryId: outcome.duplicateOf });
      case 'superseded':
        return this.record({ action: 'superseded', reason: 'stronger_fact_superseded_weaker', kind: classification.kind, source, confidence: outcome.record.confidence, surface, relatedMemoryId: outcome.record.id, replacedMemoryId: outcome.replaced });
      case 'rejected':
        return this.record({ action: 'rejected', reason: `memory_rejected_${outcome.reason.replace(/\s+/g, '_')}`, kind: classification.kind, source, confidence: classification.confidence, surface });
    }
  }

  /** Bounded window: most recent valid durable memories (never a full scan). */
  private scanWindow(): MemoryRecord[] {
    const out: MemoryRecord[] = [];
    const records = this.memory.records;
    for (let i = records.length - 1; i >= 0 && out.length < this.limits.maxScanMemories; i--) {
      const r = records[i];
      if (r.valid && SCAN_CATEGORIES.has(r.category)) out.push(r);
    }
    return out;
  }

  /** Contradiction pre-check over the bounded window (existing triple logic). */
  private detectConflict(text: string, window: MemoryRecord[]): MemoryRecord | null {
    const newTriples = extractPreferenceTriples(text);
    if (newTriples.length === 0) return null;
    for (const record of window) {
      if (!MERGEABLE_CATEGORIES.has(record.category)) continue;
      for (const existingTriple of extractPreferenceTriples(record.content)) {
        for (const nt of newTriples) {
          if (isContradictory(nt, existingTriple)) return record;
        }
      }
    }
    return null;
  }

  /** Exact/normalized/containment duplicate detection (bounded, deterministic). */
  private findExisting(
    text: string,
    classification: ConsolidationClassification,
    window: MemoryRecord[]
  ): { record: MemoryRecord; via: 'exact' | 'normalized' | 'contained' } | null {
    const target = normalizeTextLocal(text);
    let best: MemoryRecord | undefined;
    let bestScore = 0;
    for (const record of window) {
      if (!MERGEABLE_CATEGORIES.has(record.category) && record.category !== kindCategory(classification.kind)) continue;
      // Cross-kind guard: a preference never merges into a workflow record.
      if (record.category !== kindCategory(classification.kind) && !(record.category === 'long_term' || record.category === 'semantic')) continue;
      let score = similarity(text, record.content);
      // Containment: token-subset paraphrases ("User prefers X." vs
      // "I prefer X tools.") share a meaningful token core — treat as the
      // same fact. Requires ≥3 shared tokens so short fragments never merge.
      // Tokens are punctuation-stripped (similarity's tokenizer keeps periods).
      const strip = (tokens: string[]) => new Set(tokens.map((t) => t.replace(/[^a-z0-9]+/g, '')).filter(Boolean));
      const a = strip(tokenize(text));
      const b = strip(tokenize(record.content));
      if (a.size > 0 && b.size > 0) {
        let inter = 0;
        for (const t of a) if (b.has(t)) inter++;
        const minSize = Math.min(a.size, b.size);
        if (inter >= 3 && minSize > 0) score = Math.max(score, inter / minSize);
      }
      if (score > bestScore) {
        bestScore = score;
        best = record;
      }
    }
    if (best && bestScore >= this.limits.duplicateThreshold) {
      const via = normalizeTextLocal(best.content) === target ? 'exact' : 'normalized';
      return { record: best, via };
    }
    return null;
  }

  /**
   * Semantic near-duplicate detection (Semantic Intelligence v1): an expansion
   * term present in an existing record + moderate similarity → related. Used
   * ONLY to avoid creating near-duplicates — never to invent equivalence.
   * Deterministic given bounded expansions.
   */
  private findSemanticRelated(text: string, window: MemoryRecord[]): MemoryRecord | null {
    if (!this.semantic) return null;
    const keywords = tokenize(text).filter((t) => t.length > 2).slice(0, 6);
    if (keywords.length === 0) return null;
    const expansions = this.semantic.expand(keywords);
    if (expansions.length === 0) return null;
    const terms = expansions.map((e) => normalizeTerm(e.term)).filter(Boolean);
    if (terms.length === 0) return null;
    for (const record of window) {
      if (!MERGEABLE_CATEGORIES.has(record.category)) continue;
      if (similarity(text, record.content) < this.limits.semanticRelatedThreshold) continue;
      const content = normalizeTextLocal(record.content);
      if (terms.some((t) => content.includes(t))) return record;
    }
    return null;
  }

  // ---------------------------------------------------------------- ledger

  /** Track below-threshold sightings; returns promoted confidence when due. */
  private trackRecurrence(key: string, text: string, classification: ConsolidationClassification, source: ConsolidationSource, now: number): number | null {
    this.ensureLedgerLoaded();
    const entry = this.ledger.get(key);
    const count = (entry?.count ?? 0) + 1;
    const confidence = Math.min(
      this.limits.maxRecurrenceConfidence,
      classification.confidence + (count - 1) * this.limits.recurrenceBump
    );
    if (confidence >= this.limits.minConfidence) {
      this.ledger.delete(key);
      this.persistLedger();
      return confidence;
    }
    const next: LedgerEntry = entry ?? {
      key,
      content: text,
      kind: classification.kind,
      source,
      reason: classification.reason,
      baseConfidence: classification.confidence,
      count: 0,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    next.count = count;
    next.lastSeenAt = now;
    this.ledger.set(key, next);
    this.pruneLedger();
    this.persistLedger();
    return null;
  }

  private ensureLedgerLoaded(): void {
    if (this.ledgerLoaded) return;
    this.ledgerLoaded = true;
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(CONSOLIDATION_LEDGER_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { schemaVersion?: number; entries?: LedgerEntry[] } | null;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return;
      if ((parsed.schemaVersion ?? 0) > CONSOLIDATION_LEDGER_SCHEMA_VERSION) return;
      for (const e of parsed.entries) {
        if (e && typeof e.key === 'string' && typeof e.content === 'string' && typeof e.count === 'number') {
          this.ledger.set(e.key, e);
        }
      }
    } catch {
      this.ledger.clear(); // corrupted persistence → clean slate, never throws
    }
  }

  private pruneLedger(): void {
    while (this.ledger.size > this.limits.maxLedgerEntries) {
      let victim: string | undefined;
      let oldest = Infinity;
      for (const [key, e] of this.ledger) {
        const t = e.lastSeenAt || e.firstSeenAt;
        if (t < oldest) {
          oldest = t;
          victim = key;
        }
      }
      if (!victim) break;
      this.ledger.delete(victim);
    }
  }

  private persistLedger(): void {
    if (!this.storage) return;
    try {
      const schema = { schemaVersion: CONSOLIDATION_LEDGER_SCHEMA_VERSION, entries: [...this.ledger.values()] };
      this.storage.setItem(CONSOLIDATION_LEDGER_STORAGE_KEY, JSON.stringify(schema));
    } catch {
      // storage failure — in-memory state stays authoritative
    }
  }

  // ---------------------------------------------------------------- observability

  private record(result: Omit<ConsolidationResult, 'at'>): ConsolidationResult {
    const full: ConsolidationResult = { ...result, at: this.now() };
    this.counters.processed++;
    if (full.action === 'created') this.counters.created++;
    else if (full.action === 'updated' || full.action === 'merged') this.counters.updated++;
    else if (full.action === 'superseded') this.counters.superseded++;
    else if (full.action === 'rejected') this.counters.rejected++;
    else this.counters.ignored++;
    this.recent.push(full);
    if (this.recent.length > this.limits.maxRecentResults) this.recent.shift();
    return full;
  }

  /** Last consolidation outcomes (bounded) — debugging/tests/observability. */
  recentResults(): ConsolidationResult[] {
    return [...this.recent];
  }

  stats(): { processed: number; created: number; updated: number; superseded: number; rejected: number; ignored: number; ledgerSize: number } {
    return { ...this.counters, ledgerSize: this.ledger.size };
  }

  /** Drop pending recurrence sightings (tests / explicit reset). */
  clearLedger(): void {
    this.ledger.clear();
    if (this.storage) {
      try {
        this.storage.removeItem(CONSOLIDATION_LEDGER_STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }
}

/** Local import-free alias (similarity's normalizeText, already dependency-free). */
function normalizeTextLocal(text: string): string {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
