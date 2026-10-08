/**
 * Semantic Expander (Semantic Intelligence v1) — lightweight LOCAL semantic
 * expansion behind the existing relevance stack.
 *
 * Layers (cheapest first, all deterministic):
 *   1. built-in alias vocabulary  — small, project-focused, hardcoded bounds
 *   2. learned vocabulary         — ONLY confirmed associations from trusted
 *                                   sources (user decisions, task results);
 *                                   persisted via the StorageAdapter
 *                                   convention, corruption-tolerant, bounded
 *   3. Knowledge Graph expansion  — depth-bounded neighborhoods around nodes
 *                                   that actually match the seeds, injected
 *                                   via SemanticGraphSource (adapter over the
 *                                   existing graph facade)
 *   4. optional model hook        — only when everything above produced
 *                                   nothing AND the intent qualifies; wrapped
 *                                   in try/catch, network-independent by default
 *
 * Expansion results are cached through the EXISTING SessionCache (no third
 * cache type) under deterministic keys that include a graph/learned-state
 * signature, so stale semantic information invalidates itself.
 */
import { hashKey } from '../routing/cache';
import type {
  GraphExpansion,
  LearnedEntry,
  LearnedTerm,
  SemanticExpandOptions,
  SemanticExpansion,
  SemanticGraphSource,
  SemanticLimits,
  SemanticModelHook,
} from './semanticTypes';
import { DEFAULT_SEMANTIC_LIMITS, SEMANTIC_TIER_CONFIDENCE, SEMANTIC_VOCAB_SCHEMA_VERSION, SEMANTIC_VOCAB_STORAGE_KEY, TRUSTED_LEARN_SOURCES } from './semanticTypes';

// ---------------------------------------------------------------------------
// Normalization — shared, dependency-free
// ---------------------------------------------------------------------------

/** Normalize a term: lowercase, strip punctuation, fold simple plurals. */
export function normalizeTerm(term: string): string {
  return String(term ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
    .filter(Boolean)
    .join(' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Built-in vocabulary — intentionally SMALL and project-focused
// (no unbounded synonym dictionaries; extension = editing this table)
// ---------------------------------------------------------------------------

interface AliasGroup {
  concept: string;
  terms: string[];
}

const ALIAS_GROUPS: readonly AliasGroup[] = [
  { concept: 'network', terms: ['internet', 'online', 'web access', 'connectivity', 'api request', 'network usage'] },
  { concept: 'cache', terms: ['cached', 'cache-first', 'persistent cache', 'research caching'] },
  { concept: 'local-first', terms: ['offline', 'on-device', 'local operation', 'local'] },
  { concept: 'context', terms: ['context engine', 'context package', 'context builder'] },
  { concept: 'memory', terms: ['recall', 'remember', 'memory system'] },
  { concept: 'knowledge graph', terms: ['graph', 'relationship', 'entities'] },
  { concept: 'relevance', terms: ['relevant', 'ranking', 'scoring'] },
  { concept: 'performance', terms: ['latency', 'speed', 'efficiency'] },
  { concept: 'privacy', terms: ['private', 'confidential', 'secrets'] },
  { concept: 'test', terms: ['tests', 'testing', 'verification', 'regression'] },
];

const NORMALIZED_GROUPS: Array<{ concept: string; normalizedTerms: string[]; expansions: string[] }> = ALIAS_GROUPS.map((g) => {
  const normalizedTerms = g.terms.map(normalizeTerm);
  const expansions = [...new Set([normalizeTerm(g.concept), ...normalizedTerms])].filter(Boolean);
  return { concept: g.concept, normalizedTerms, expansions };
});

/** Built-in alias expansions for the given seeds (deterministic, bounded). */
export function findAliasExpansions(keywords: string[], maxSeeds: number, maxExpansions: number): SemanticExpansion[] {
  const seeds = uniqueSeeds(keywords).slice(0, Math.max(0, maxSeeds));
  const out: SemanticExpansion[] = [];
  for (const seed of seeds) {
    for (const group of NORMALIZED_GROUPS) {
      const seedHitsGroup = seed === group.concept || group.normalizedTerms.includes(seed);
      if (!seedHitsGroup) continue;
      for (const term of group.expansions) {
        if (term === seed) continue;
        if (out.length >= maxExpansions) return out;
        out.push({
          seed,
          term,
          tier: 'alias',
          confidence: SEMANTIC_TIER_CONFIDENCE.alias,
          reason: `matched project alias: ${seed} → ${term}`,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Learned vocabulary — confirmed associations only, persisted, bounded
// ---------------------------------------------------------------------------

interface LearnedSchema {
  schemaVersion: number;
  entries: LearnedEntry[];
}

export class LearnedVocabulary {
  private entries = new Map<string, LearnedEntry>();
  private loaded = false;
  private readonly limits: SemanticLimits;
  private readonly now: () => number;
  private readonly storage?: import('../taskState').StorageAdapter;

  constructor(
    storage?: import('../taskState').StorageAdapter,
    limits: SemanticLimits = DEFAULT_SEMANTIC_LIMITS,
    now: () => number = Date.now
  ) {
    this.storage = storage;
    this.limits = limits;
    this.now = now;
  }

  /** Load once; corrupted or future-schema storage → clean start. Never throws. */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(SEMANTIC_VOCAB_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as LearnedSchema | null;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return;
      if ((parsed.schemaVersion ?? 0) > SEMANTIC_VOCAB_SCHEMA_VERSION) return;
      for (const e of parsed.entries) {
        if (!e || typeof e.concept !== 'string' || !Array.isArray(e.terms)) continue;
        const concept = normalizeTerm(e.concept);
        if (!concept) continue;
        const terms = (e.terms as LearnedTerm[])
          .filter((t) => t && typeof t.term === 'string' && typeof t.confidence === 'number')
          .slice(0, this.limits.maxLearnedTermsPerConcept);
        if (terms.length > 0) this.entries.set(concept, { concept, terms, updatedAt: e.updatedAt ?? 0 });
      }
    } catch {
      this.entries.clear(); // corrupted storage → clean slate
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      const schema: LearnedSchema = { schemaVersion: SEMANTIC_VOCAB_SCHEMA_VERSION, entries: [...this.entries.values()] };
      this.storage.setItem(SEMANTIC_VOCAB_STORAGE_KEY, JSON.stringify(schema));
    } catch {
      // storage failure — in-memory state stays authoritative
    }
  }

  /**
   * Confirm an association. Guards: trusted source only, minimum confidence,
   * concept ≠ term, both must normalize to something. Bounded by limits with
   * deterministic pruning (lowest-confidence, then oldest).
   */
  confirm(concept: string, terms: string[], source: string, confidence: number): boolean {
    this.ensureLoaded();
    const normalizedConcept = normalizeTerm(concept);
    const conf = Number(confidence);
    if (!normalizedConcept || !Array.isArray(terms) || terms.length === 0) return false;
    if (!TRUSTED_LEARN_SOURCES.has(source)) return false; // no uncontrolled learning
    if (!Number.isFinite(conf) || conf < this.limits.minLearnedConfidence) return false;
    const entry = this.entries.get(normalizedConcept) ?? { concept: normalizedConcept, terms: [], updatedAt: this.now() };
    let changed = false;
    for (const rawTerm of terms) {
      const term = normalizeTerm(rawTerm);
      if (!term || term === normalizedConcept) continue;
      if (entry.terms.some((t) => t.term === term)) continue;
      entry.terms.push({ term, confidence: Math.min(1, conf), source, updatedAt: this.now() });
      changed = true;
    }
    if (!changed) return false;
    while (entry.terms.length > this.limits.maxLearnedTermsPerConcept) {
      entry.terms.sort((a, b) => a.confidence - b.confidence || a.updatedAt - b.updatedAt);
      entry.terms.shift();
    }
    entry.updatedAt = this.now();
    this.entries.set(normalizedConcept, entry);
    while (this.entries.size > this.limits.maxLearnedEntries) {
      let victim: string | undefined;
      let victimScore = Infinity;
      for (const [key, e] of this.entries) {
        const score = e.updatedAt;
        if (score < victimScore) {
          victimScore = score;
          victim = key;
        }
      }
      if (!victim) break;
      this.entries.delete(victim);
    }
    this.persist();
    return true;
  }

  /** Learned expansions for the given seeds (deterministic, bounded). */
  expansionsFor(keywords: string[], maxSeeds: number, maxExpansions: number): SemanticExpansion[] {
    this.ensureLoaded();
    const seeds = uniqueSeeds(keywords).slice(0, Math.max(0, maxSeeds));
    const out: SemanticExpansion[] = [];
    for (const seed of seeds) {
      const entry = this.entries.get(seed);
      if (!entry) continue;
      for (const t of entry.terms) {
        if (out.length >= maxExpansions) return out;
        out.push({
          seed,
          term: t.term,
          tier: 'learned',
          confidence: Math.min(SEMANTIC_TIER_CONFIDENCE.alias, Math.max(0, t.confidence)),
          reason: `confirmed association (${t.source}): ${seed} → ${t.term}`,
        });
      }
    }
    return out;
  }

  get size(): number {
    this.ensureLoaded();
    return this.entries.size;
  }

  entry(concept: string): LearnedEntry | undefined {
    this.ensureLoaded();
    return this.entries.get(normalizeTerm(concept));
  }

  clear(): void {
    this.entries.clear();
    if (this.storage) {
      try {
        this.storage.removeItem(SEMANTIC_VOCAB_STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }
}

// ---------------------------------------------------------------------------
// SemanticIntelligence — the facade the Context Engine consumes
// ---------------------------------------------------------------------------

/** Intents where the optional model hook may be consulted (bounded set). */
const MODEL_HOOK_INTENTS = new Set(['question', 'diagnose', 'research']);

export interface SemanticIntelligenceOptions {
  limits?: Partial<SemanticLimits>;
  graphSource?: SemanticGraphSource;
  modelHook?: SemanticModelHook;
  vocabularyStorage?: import('../taskState').StorageAdapter;
  now?: () => number;
}

export interface SemanticExpandResult {
  expansions: SemanticExpansion[];
  cached: boolean;
}

export class SemanticIntelligence {
  readonly limits: SemanticLimits;
  private readonly graphSource?: SemanticGraphSource;
  private readonly modelHook?: SemanticModelHook;
  private readonly learned: LearnedVocabulary;
  private readonly now: () => number;
  private learnedVersion = 0;

  constructor(options: SemanticIntelligenceOptions = {}) {
    this.limits = { ...DEFAULT_SEMANTIC_LIMITS, ...options.limits };
    this.graphSource = options.graphSource;
    this.modelHook = options.modelHook;
    this.now = options.now ?? Date.now;
    this.learned = new LearnedVocabulary(options.vocabularyStorage, this.limits, this.now);
  }

  /** Deterministic state signature included in every expansion cache key. */
  private stateSignature(): string {
    let graphSig = 'nograph';
    if (this.graphSource) {
      try {
        graphSig = this.graphSource.signature() || 'graph';
      } catch {
        graphSig = 'graph';
      }
    }
    return `${graphSig}:${this.learnedVersion}`;
  }

  /**
   * Expand query keywords into bounded related terms. Never throws; empty or
   * malformed input yields an empty expansion set (pure baseline behavior).
   * Results are served from the EXISTING session cache when available.
   */
  expand(keywords: string[], opts: SemanticExpandOptions = {}): SemanticExpansion[] {
    try {
      return this.expandInner(keywords, opts).expansions;
    } catch {
      return []; // semantic layer must never break retrieval
    }
  }

  /** Like expand(), but reports whether the result came from the cache. */
  expandDetailed(keywords: string[], opts: SemanticExpandOptions = {}): SemanticExpandResult {
    try {
      return this.expandInner(keywords, opts);
    } catch {
      return { expansions: [], cached: false };
    }
  }

  private expandInner(keywords: string[], opts: SemanticExpandOptions): SemanticExpandResult {
    const seeds = uniqueSeeds(keywords).slice(0, this.limits.maxSeedTerms);
    if (seeds.length === 0) return { expansions: [], cached: false };

    const cache = opts.cache;
    const cacheKey = `semantic:exp:${hashKey(`${seeds.join('|')}|${this.stateSignature()}`)}`;
    if (cache) {
      try {
        const hit = cache.get(cacheKey);
        if (hit.hit && Array.isArray(hit.value)) {
          return { expansions: hit.value as SemanticExpansion[], cached: true };
        }
      } catch {
        // cache failure → expand fresh
      }
    }

    const collected: SemanticExpansion[] = [];

    // 1. Built-in alias vocabulary (cheapest, always local).
    collected.push(...findAliasExpansions(seeds, this.limits.maxSeedTerms, this.limits.maxExpansions));

    // 2. Confirmed learned associations.
    collected.push(...this.learned.expansionsFor(seeds, this.limits.maxSeedTerms, this.limits.maxExpansions));

    // 3. Knowledge Graph neighborhoods — only over real stored relationships.
    if (this.graphSource) {
      try {
        const graphExpansions = this.graphSource.relatedForTerms(seeds, this.limits.maxGraphSeeds);
        for (const ge of graphExpansions ?? []) {
          if (!ge || typeof ge.seed !== 'string') continue;
          for (const rel of ge.related ?? []) {
            if (!rel || typeof rel.label !== 'string') continue;
            const term = normalizeTerm(rel.label);
            if (!term) continue;
            if (rel.confidence < this.limits.minGraphEdgeConfidence) continue; // no weak/hallucinated edges
            if (collected.length >= this.limits.maxExpansions) break;
            collected.push({
              seed: ge.seed,
              term,
              tier: 'graph',
              confidence: Math.min(SEMANTIC_TIER_CONFIDENCE.graph, Math.max(0, rel.confidence)),
              reason: `related through Knowledge Graph relationship: ${rel.relationship}`,
            });
          }
        }
      } catch {
        // graph failure → continue with local layers only
      }
    }

    // 4. Optional bounded model fallback — ONLY when local layers found
    // nothing and the intent genuinely benefits. Failure-safe by contract.
    if (collected.length === 0 && this.modelHook && MODEL_HOOK_INTENTS.has(String(opts.intent ?? ''))) {
      try {
        const related = this.modelHook.related(seeds);
        for (const r of related ?? []) {
          if (!r || typeof r.term !== 'string' || !Array.isArray(r.related)) continue;
          for (const rawTerm of r.related) {
            const term = normalizeTerm(rawTerm);
            if (!term) continue;
            if (collected.length >= this.limits.maxExpansions) break;
            collected.push({
              seed: normalizeTerm(r.term) || seeds[0],
              term,
              tier: 'model',
              confidence: SEMANTIC_TIER_CONFIDENCE.model,
              reason: 'model-router suggestion (optional fallback)',
            });
          }
        }
      } catch {
        // unavailable model → silently stay local
      }
    }

    // Dedup (seed+term), keep the highest-confidence copy of each pair,
    // deterministic order: confidence desc, then seed, then term.
    const byPair = new Map<string, SemanticExpansion>();
    for (const e of collected) {
      if (!e || typeof e.term !== 'string' || typeof e.seed !== 'string') continue;
      if (!e.term || !Number.isFinite(e.confidence) || e.confidence <= 0) continue;
      const key = `${e.seed}→${e.term}`;
      const existing = byPair.get(key);
      if (!existing || e.confidence > existing.confidence) byPair.set(key, e);
    }
    const expansions = [...byPair.values()]
      .sort((a, b) => b.confidence - a.confidence || a.seed.localeCompare(b.seed) || a.term.localeCompare(b.term))
      .slice(0, this.limits.maxExpansions);

    if (cache && expansions.length > 0) {
      try {
        cache.set(cacheKey, expansions, { ttlMs: this.limits.cacheTtlMs, source: 'semantic' });
      } catch {
        // caching is best-effort
      }
    }
    return { expansions, cached: false };
  }

  /**
   * Learn a confirmed association from a TRUSTED source (explicit user
   * decision, verified task result, user-confirmed memory). Arbitrary
   * conversational learning is intentionally impossible: untrusted sources
   * and low-confidence claims are rejected, and bounds are enforced.
   */
  confirmAssociation(concept: string, terms: string[], source: string, confidence: number): boolean {
    try {
      const ok = this.learned.confirm(concept, terms, source, confidence);
      if (ok) this.learnedVersion++; // invalidates cached expansions deterministically
      return ok;
    } catch {
      return false;
    }
  }

  learnedStats(): { entries: number } {
    return { entries: this.learned.size };
  }

  clearLearned(): void {
    this.learned.clear();
    this.learnedVersion++;
  }

  get vocabulary(): LearnedVocabulary {
    return this.learned;
  }
}

/** Dedup + sanitize seed keywords. */
function uniqueSeeds(keywords: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of Array.isArray(keywords) ? keywords : []) {
    if (typeof k !== 'string') continue;
    const normalized = normalizeTerm(k);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
