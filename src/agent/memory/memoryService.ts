/**
 * Memory Service (Phase 2) — the modular memory API used by the Agent Core,
 * the chat flow, and the existing Memory UI (via a compatibility view).
 *
 * remember()  — worth-assessment, secret rejection, duplicate merge, conflict handling
 * recall()    — relevance-ranked retrieval for a task/message context
 * search()    — keyword search
 * update()    — content edits
 * merge()     — combine two records
 * forget()    — remove permanently
 * invalidate()— mark stale/superseded without deleting
 * detectConflicts() — find contradictory preference pairs
 * rankRelevance()   — score records against a query
 */
import type { MemoryCategory, MemoryConflict, MemoryRecord, MemorySource } from './memoryTypes';
import { CATEGORY_IMPORTANCE, SOURCE_CONFIDENCE, MAX_DISPLAY_MEMORIES } from './memoryTypes';
import { MemoryStore } from './memoryStore';
import type { StorageAdapter } from './memoryStore';
import { localStorageAdapter } from '../taskState';
import { similarity, tokenize } from './similarity';

const DUPLICATE_THRESHOLD = 0.62;

export interface RememberOptions {
  category?: MemoryCategory;
  source?: MemorySource;
  importance?: number;
  confidence?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export type RememberOutcome =
  | { action: 'created'; record: MemoryRecord }
  | { action: 'merged'; record: MemoryRecord; duplicateOf: string }
  | { action: 'superseded'; record: MemoryRecord; replaced: string }
  | { action: 'rejected'; reason: string };

export interface RankOptions {
  limit?: number;
  categories?: MemoryCategory[];
  includeInvalid?: boolean;
}

/** Patterns that mark content as a secret — never stored as ordinary memory. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(api[_-]?key|apikey|password|passwd|secret|token|credential)s?\b\s*[:=]/i,
  /\bsk-[a-z0-9]{16,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bbearer\s+[a-z0-9._-]{20,}/i,
  /\bghp_[A-Za-z0-9]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
];

/** Conversational noise that must never become long-term memory. */
const NOISE_PATTERNS: RegExp[] = [
  /^(?:hi|hello|hey|yo|sup|thanks|thank you|ok|okay|cool|nice|great|lol|haha|hmm|good|good morning|good evening|good night|bye|goodbye|yes|no|nope|yeah)[\s!.?]*$/i,
  /^(?:i\s+)?(?:love|like|enjoy)\s+(?:this|that|it|these|those)[\s!.?]*$/i,
  /^\s*$/, // whitespace only
];

/** Durable-fact signals — content matching one of these is worth keeping. */
const WORTHY_PATTERNS: RegExp[] = [
  /\bmy name is\b/i,
  /\bi(?:'m| am)\s+(?:a|an)\s+[a-z]/i,            // I am a ...
  /\bi\s+work\s+(?:as|at|in)\b/i,
  /\bi\s+(?:live|stay)\s+in\b/i,
  /\bi\s+have\s+a\s+(?:dog|cat|pet|puppy|kitten)\b/i,
  /\bmy\s+(?:favorite|favourite)\b/i,
  /\bi\s+(?:prefer|like|love|enjoy|dislike|hate)\b/i,
  /\bprefers?\b/i,                                  // any subject: "User prefers X"
  /\bfavorite\b|\bfavourite\b/i,
  /\bworks?\s+(?:as|at|in)\b/i,                     // "Works as a designer", "works at Acme"
  /\bhas\s+a\s+(?:dog|cat|pet|puppy|kitten)\b/i,
  /\bmy\s+(?:dog|cat|pet|partner|wife|husband|son|daughter|brother|sister|car|bike)\b/i,
  /\ballergic\b/i,
  /\balways\b|\bnever\b|\bfrom now on\b/i,
  /\bwhenever\s+i\b/i,
  /\bmy\s+(?:job|role|birthday|project|degree|university|school|major)\b/i,
  /\bi(?:'m| am)\s+(?:learning|studying|building|working on)\b/i,
];

const CORRECTION_SIGNAL_RE =
  /\b(?:don'?t|do not|stop|never|wrong|not like that|that'?s (?:not|incorrect)|no,? use)\b/i;

const DURABLE_DIRECTIVE_RE =
  /\b(?:always|never|from now on|instead|prefer|use this|the correct way|make sure)\b/i;

/** Subject/relation triples for conflict detection. */
interface PrefTriple {
  relation: 'prefer' | 'avoid' | 'use' | 'neveruse';
  subject: string;
  object: string;
}

const PREF_TRIPLE_PATTERNS: {
  re: RegExp;
  build: (m: RegExpMatchArray) => PrefTriple | null;
}[] = [
  {
    // "preferred editor is vscode" / "user's preferred editor is X"
    re: /preferred\s+([a-z\s]{2,20}?)\s+is\s+([^.,;!?]{2,40})/i,
    build: (m) => ({ relation: 'prefer', subject: normKey(m[1]), object: normKey(m[2]) }),
  },
  {
    // "favorite editor is vscode"
    re: /(?:favorite|favourite)\s+([a-z\s]{2,20}?)\s+is\s+([^.,;!?]{2,40})/i,
    build: (m) => ({ relation: 'prefer', subject: normKey(m[1]), object: normKey(m[2]) }),
  },
  {
    re: /(?:i\s+|user\s+|she\s+|he\s+|they\s+)?(?:prefers?|likes?|loves?|enjoys?)\s+([^.,;!?]{2,40})/i,
    build: (m) => ({ relation: 'prefer', subject: '', object: normKey(m[1]) }),
  },
  {
    re: /(?:i\s+|user\s+|she\s+|he\s+|they\s+)?(?:hates?|dislikes?|avoids?)\s+([^.,;!?]{2,40})/i,
    build: (m) => ({ relation: 'avoid', subject: '', object: normKey(m[1]) }),
  },
  {
    re: /\balways\s+use\s+([^.,;!?]{2,40})/i,
    build: (m) => ({ relation: 'use', subject: '', object: normKey(m[1]) }),
  },
  {
    re: /\bnever\s+use\s+([^.,;!?]{2,40})/i,
    build: (m) => ({ relation: 'neveruse', subject: '', object: normKey(m[1]) }),
  },
];

function normKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractPreferenceTriples(text: string): PrefTriple[] {
  const triples: PrefTriple[] = [];
  for (const { re, build } of PREF_TRIPLE_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const t = build(m);
      if (t && t.object) triples.push(t);
    }
  }
  return triples;
}

/** Decide whether free text is worth persisting, and how. */
export function assessWorth(text: string): { worth: boolean; category: MemoryCategory; reason?: string } {
  const clean = text.trim();

  if (clean.length < 4) return { worth: false, category: 'short_term', reason: 'too short' };
  if (clean.length > 400) return { worth: false, category: 'short_term', reason: 'too long for a memory' };
  if (SECRET_PATTERNS.some((re) => re.test(clean))) return { worth: false, category: 'short_term', reason: 'looks like a secret/credential' };
  if (NOISE_PATTERNS.some((re) => re.test(clean))) return { worth: false, category: 'short_term', reason: 'conversational noise' };

  // Corrections are the strongest durable signal — check before preferences so
  // "That's wrong, always use X" is categorized as a correction.
  if (CORRECTION_SIGNAL_RE.test(clean) && DURABLE_DIRECTIVE_RE.test(clean)) {
    return { worth: true, category: 'correction' };
  }

  // Preferences & corrections are the most durable categories.
  if (extractPreferenceTriples(clean).length > 0) return { worth: true, category: 'preference' };
  if (WORTHY_PATTERNS.some((re) => re.test(clean))) return { worth: true, category: 'long_term' };

  return { worth: false, category: 'short_term', reason: 'no durable-fact signal' };
}

export class MemoryService {
  private store: MemoryStore;
  private conflicts: MemoryConflict[] = [];

  constructor(storage?: StorageAdapter) {
    this.store = new MemoryStore(storage);
  }

  get records(): MemoryRecord[] {
    return this.store.records;
  }

  // ------------------------------------------------------------------ remember

  remember(text: string, options: RememberOptions = {}): RememberOutcome {
    const clean = text.trim();
    if (!clean) return { action: 'rejected', reason: 'empty' };

    // Explicit user input and caller-specified categories are trusted (only
    // secrets are always blocked); free-form extraction runs worth-assessment.
    const explicitCategory = Boolean(options.category);
    if (options.source === 'user_manual' || options.source === 'user_correction' || explicitCategory) {
      if (SECRET_PATTERNS.some((re) => re.test(clean))) {
        return { action: 'rejected', reason: 'looks like a secret/credential' };
      }
    } else {
      const assessment = assessWorth(clean);
      if (!assessment.worth) return { action: 'rejected', reason: assessment.reason };
    }

    const now = Date.now();
    const category = options.category ?? assessWorth(clean).category;
    const source = options.source ?? 'conversation_extract';

    // ---- duplicate detection: merge into the closest existing record
    const validRecords = this.store.records.filter((r) => r.valid);
    let bestMatch: MemoryRecord | null = null;
    let bestScore = 0;
    for (const record of validRecords) {
      const score = similarity(clean, record.content);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = record;
      }
    }
    if (bestMatch && bestScore >= DUPLICATE_THRESHOLD) {
      const merged = this.mergeRecords(bestMatch, clean, category, source, options);
      return { action: 'merged', record: merged, duplicateOf: bestMatch.id };
    }

    // ---- conflict detection: same subject, contradicting stance
    const newTriples = extractPreferenceTriples(clean);
    if (newTriples.length > 0) {
      for (const record of validRecords) {
        const existingTriples = extractPreferenceTriples(record.content);
        for (const nt of newTriples) {
          for (const et of existingTriples) {
            if (isContradictory(nt, et)) {
              return this.resolveConflict(record, clean, category, source, options, nt, et, now);
            }
          }
        }
      }
    }

    const record: MemoryRecord = {
      id: 'mem_' + now + '_' + Math.random().toString(36).slice(2, 8),
      category,
      content: clean,
      createdAt: now,
      updatedAt: now,
      importance: clamp(options.importance ?? CATEGORY_IMPORTANCE[category], 0, 1),
      confidence: clamp(options.confidence ?? SOURCE_CONFIDENCE[source], 0, 1),
      source,
      tags: options.tags,
      usageCount: 0,
      valid: true,
      metadata: options.metadata,
    };
    this.store.records.push(record);
    this.store.persist();
    return { action: 'created', record };
  }

  /** Store several candidate strings; returns per-item outcomes. */
  rememberMany(texts: string[], options: RememberOptions = {}): RememberOutcome[] {
    return texts.map((t) => this.remember(t, options));
  }

  // ------------------------------------------------------- recall / search / rank

  rankRelevance(query: string, records?: MemoryRecord[], options: RankOptions = {}): { record: MemoryRecord; score: number }[] {
    const pool = (records ?? this.store.records).filter((r) => options.includeInvalid || r.valid)
      .filter((r) => !options.categories || options.categories.includes(r.category));

    const queryTokens = new Set(tokenize(query));

    const scored = pool.map((record) => {
      const contentTokens = tokenize(record.content);
      let overlap = 0;
      for (const token of contentTokens) {
        if (queryTokens.has(token)) overlap++;
      }
      const overlapRatio = queryTokens.size === 0 ? 0 : overlap / Math.max(1, Math.min(contentTokens.length, 8));

      const ageDays = (Date.now() - record.updatedAt) / (1000 * 60 * 60 * 24);
      const recency = Math.exp(-Math.log(2) * ageDays / 14); // 14-day half-life

      const score =
        overlapRatio * 0.5 +
        record.importance * 0.25 +
        record.confidence * 0.1 +
        recency * 0.1 +
        Math.min(0.05, record.usageCount * 0.01);

      return { record, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return options.limit ? scored.slice(0, options.limit) : scored;
  }

  /** Relevant memories for a task/message — never the whole database. */
  recall(query: string, options: RankOptions = {}): MemoryRecord[] {
    const limit = options.limit ?? 8;
    const top = this.rankRelevance(query, undefined, {
      ...options,
      limit: limit * 3,
    });

    // Behavior-shaping memories (preferences/corrections) come first, then the
    // rest by score — always capped at the limit.
    const picked: MemoryRecord[] = [];
    const seen = new Set<string>();
    for (const { record } of top) {
      if (picked.length >= limit) break;
      if (record.category === 'preference' || record.category === 'correction') {
        picked.push(record);
        seen.add(record.id);
      }
    }
    for (const { record } of top) {
      if (picked.length >= limit) break;
      if (!seen.has(record.id)) {
        picked.push(record);
        seen.add(record.id);
      }
    }
    for (const record of picked) {
      record.usageCount += 1;
      record.lastUsedAt = Date.now();
    }
    if (picked.length > 0) this.store.persist();
    return picked;
  }

  search(query: string, options: RankOptions = {}): MemoryRecord[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) {
      return this.store.records
        .filter((r) => options.includeInvalid || r.valid)
        .slice(0, options.limit ?? 50);
    }
    const pool = this.store.records.filter((r) => options.includeInvalid || r.valid);
    const matches = pool.filter((r) => {
      const contentTokens = new Set(tokenize(r.content));
      return tokens.some((t) => contentTokens.has(t));
    });
    return this.rankRelevance(query, matches, options).map((x) => x.record);
  }

  // ------------------------------------------------------------- mutations

  get(id: string): MemoryRecord | undefined {
    return this.store.records.find((r) => r.id === id);
  }

  update(id: string, content: string): MemoryRecord | null {
    const record = this.get(id);
    if (!record) return null;
    record.content = content.trim();
    record.updatedAt = Date.now();
    this.store.persist();
    return record;
  }

  /** Merge two records into one (keeping the stronger metadata). */
  merge(idA: string, idB: string, content?: string): MemoryRecord | null {
    const a = this.get(idA);
    const b = this.get(idB);
    if (!a || !b || a.id === b.id) return null;
    a.content = content ?? (a.content.length >= b.content.length ? a.content : b.content);
    a.importance = Math.max(a.importance, b.importance);
    a.confidence = Math.min(0.95, Math.max(a.confidence, b.confidence) + 0.05);
    a.tags = Array.from(new Set([...(a.tags ?? []), ...(b.tags ?? [])]));
    a.updatedAt = Date.now();
    this.forget(b.id);
    this.store.persist();
    return a;
  }

  forget(id: string): boolean {
    const index = this.store.records.findIndex((r) => r.id === id);
    if (index === -1) return false;
    this.store.records.splice(index, 1);
    this.store.persist();
    return true;
  }

  invalidate(id: string, supersededBy?: string): boolean {
    const record = this.get(id);
    if (!record) return false;
    record.valid = false;
    record.supersededBy = supersededBy;
    record.updatedAt = Date.now();
    this.store.persist();
    return true;
  }

  // -------------------------------------------------------------- conflicts

  detectConflicts(): MemoryConflict[] {
    const valid = this.store.records.filter((r) => r.valid);
    const found: MemoryConflict[] = [];
    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        const ta = extractPreferenceTriples(valid[i].content);
        const tb = extractPreferenceTriples(valid[j].content);
        for (const x of ta) {
          for (const y of tb) {
            if (isContradictory(x, y)) {
              found.push({
                id: 'conflict_' + valid[i].id + '_' + valid[j].id,
                recordA: valid[i].id,
                recordB: valid[j].id,
                subject: x.subject || y.subject || x.object || 'unspecified preference',
                description: `"${valid[i].content}" vs "${valid[j].content}"`,
                resolved: false,
                createdAt: Date.now(),
              });
            }
          }
        }
      }
    }
    this.conflicts = found;
    return found;
  }

  getConflicts(): MemoryConflict[] {
    return [...this.conflicts];
  }

  // -------------------------------------------------------------- UI bridge

  /** Strings for the existing MemoryModal (valid records, newest first). */
  displayMemories(): string[] {
    return this.store.displayStrings();
  }

  /** Resolve the record behind display position `index` (index-based UI). */
  resolveDisplayIndex(index: number): MemoryRecord | null {
    const ordered = this.store.records
      .filter((r) => r.valid)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_DISPLAY_MEMORIES);
    return ordered[index] ?? null;
  }

  // -------------------------------------------------------------- maintenance

  stats(): { total: number; valid: number; byCategory: Record<string, number> } {
    const byCategory: Record<string, number> = {};
    let valid = 0;
    for (const r of this.store.records) {
      byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
      if (r.valid) valid++;
    }
    return { total: this.store.records.length, valid, byCategory };
  }

  reset(): void {
    this.store.resetToSeed();
    this.conflicts = [];
  }

  // -------------------------------------------------------------- internals

  private mergeRecords(existing: MemoryRecord, newContent: string, _category: MemoryCategory, source: MemorySource, options: RememberOptions): MemoryRecord {
    // Prefer the longer/richer content; keep the newer wording when sources are equal length.
    existing.content = newContent.length > existing.content.length ? newContent : existing.content;
    existing.importance = Math.max(existing.importance, options.importance ?? 0);
    existing.confidence = Math.min(0.95, Math.max(existing.confidence, options.confidence ?? SOURCE_CONFIDENCE[source]) + 0.05);
    if (options.tags?.length) {
      existing.tags = Array.from(new Set([...(existing.tags ?? []), ...options.tags]));
    }
    if (options.metadata) {
      existing.metadata = { ...(existing.metadata ?? {}), ...options.metadata };
    }
    existing.usageCount += 1;
    existing.updatedAt = Date.now();
    this.store.persist();
    return existing;
  }

  private resolveConflict(
    older: MemoryRecord,
    newContent: string,
    category: MemoryCategory,
    source: MemorySource,
    options: RememberOptions,
    newTriple: PrefTriple,
    oldTriple: PrefTriple,
    now: number
  ): RememberOutcome {
    const newerStrength = (options.importance ?? CATEGORY_IMPORTANCE[category]) + (options.confidence ?? SOURCE_CONFIDENCE[source]);
    const olderStrength = older.importance + older.confidence;
    const newerIsAuthoritative = source === 'user_manual' || source === 'user_correction';

    if (newerIsAuthoritative || newerStrength > olderStrength + 0.1) {
      // The newer statement wins; supersede the old fact instead of keeping both.
      const record: MemoryRecord = {
        id: 'mem_' + now + '_' + Math.random().toString(36).slice(2, 8),
        category,
        content: newContent,
        createdAt: now,
        updatedAt: now,
        importance: clamp(options.importance ?? Math.max(CATEGORY_IMPORTANCE[category], older.importance), 0, 1),
        confidence: clamp(options.confidence ?? Math.min(0.95, SOURCE_CONFIDENCE[source] + 0.05), 0, 1),
        source,
        tags: options.tags,
        usageCount: 0,
        valid: true,
        metadata: {
          ...(options.metadata ?? {}),
          replaces: older.id,
          subject: newTriple.subject || oldTriple.subject,
        },
      };
      this.invalidate(older.id, record.id);
      this.store.records.push(record);
      this.store.persist();
      return { action: 'superseded', record, replaced: older.id };
    }

    // Low-confidence contradiction: keep both, record the conflict, do not
    // silently pick a winner.
    const record: MemoryRecord = {
      id: 'mem_' + now + '_' + Math.random().toString(36).slice(2, 8),
      category,
      content: newContent,
      createdAt: now,
      updatedAt: now,
      importance: clamp(options.importance ?? CATEGORY_IMPORTANCE[category], 0, 1),
      confidence: clamp((options.confidence ?? SOURCE_CONFIDENCE[source]) * 0.8, 0, 1),
      source,
      tags: options.tags,
      usageCount: 0,
      valid: true,
      metadata: { conflicted: true, conflictSubject: newTriple.subject || oldTriple.subject },
    };
    older.confidence = older.confidence * 0.8;
    older.metadata = { ...(older.metadata ?? {}), conflicted: true, conflictSubject: newTriple.subject || oldTriple.subject };
    this.store.records.push(record);
    this.conflicts.push({
      id: 'conflict_' + older.id + '_' + record.id,
      recordA: older.id,
      recordB: record.id,
      subject: newTriple.subject || oldTriple.subject || newTriple.object,
      description: `"${older.content}" vs "${newContent}"`,
      resolved: false,
      createdAt: now,
    });
    this.store.persist();
    return { action: 'created', record };
  }
}

function isContradictory(a: PrefTriple, b: PrefTriple): boolean {
  // Opposite polarity over the same object: "prefer X" vs "avoid X".
  const oppositePolarity =
    (a.relation === 'prefer' && b.relation === 'avoid') ||
    (a.relation === 'avoid' && b.relation === 'prefer') ||
    (a.relation === 'use' && b.relation === 'neveruse') ||
    (a.relation === 'neveruse' && b.relation === 'use');

  if (oppositePolarity && a.object === b.object) return true;

  // Same subject + same polarity but different objects:
  // "preferred editor is vscode" vs "preferred editor is sublime".
  if (a.relation === b.relation && a.subject && a.subject === b.subject && a.object !== b.object) {
    // Only when the objects are genuinely different (not paraphrases).
    return similarity(a.object, b.object) < 0.5;
  }
  return false;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Correction detector used by the agent bridge (learning from corrections). */
export function detectCorrection(text: string): { isCorrection: boolean; durable: boolean } {
  const isCorrection = CORRECTION_SIGNAL_RE.test(text);
  const durable = isCorrection && (DURABLE_DIRECTIVE_RE.test(text) || text.trim().length > 40);
  return { isCorrection, durable };
}

// ---------------------------------------------------------------- singleton

let singleton: MemoryService | null = null;

/** Browser singleton (lazy, localStorage-backed). Tests construct their own instances. */
export function getMemoryService(): MemoryService {
  if (!singleton) {
    singleton = new MemoryService(localStorageAdapter);
  }
  return singleton;
}
