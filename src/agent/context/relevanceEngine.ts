/**
 * Relevance Engine (Context Engine v1) — deterministic, lightweight scoring
 * (spec §6). No embeddings/vector infrastructure; the architecture allows a
 * semantic ranker to be swapped in later behind the same interface.
 *
 * relevance = task/keyword overlap + recency + source importance
 *             + explicit user importance − staleness
 */
import type { ContextItem, ContextRequirements, ContextScore } from './contextTypes';
import { tokenize } from './contextAnalyzer';
import type { SemanticExpansion } from '../semantic/semanticTypes';
import { SEMANTIC_OVERLAP_CAP } from '../semantic/semanticTypes';
import { semanticOverlapFor } from '../semantic/semanticScorer';

/** Base weight per source — local/authoritative sources outrank ambient ones. */
const SOURCE_WEIGHTS: Record<ContextItem['source'], number> = {
  user: 1,
  constraints: 1,
  task_state: 0.9,
  tool_state: 0.85,
  memory: 0.8,
  project_files: 0.8,
  knowledge_graph: 0.75,
  cached_knowledge: 0.7,
  conversation: 0.55,
  environment: 0.5,
};

/** Recency half-life: 24h for knowledge-ish items (conversation decays faster via its own timestamps). */
const RECENCY_HALF_LIFE_MS = 24 * 60 * 60_000;
/** An item older than this is considered stale regardless of TTL. */
const STALE_MS = 7 * 24 * 60 * 60_000;

function recencyScore(timestamp: number, now: number): number {
  const age = Math.max(0, now - timestamp);
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
}

function overlapScore(itemTokens: Set<string>, queryKeywords: string[]): number {
  if (queryKeywords.length === 0) return 0;
  let hits = 0;
  for (const k of queryKeywords) if (itemTokens.has(k)) hits++;
  // Diminishing returns: sqrt scaling keeps a single strong hit meaningful
  // without letting long keyword lists dominate.
  return Math.min(1, hits / Math.sqrt(queryKeywords.length));
}

/**
 * Score one item against the request requirements. Deterministic.
 *
 * Semantic Intelligence v1 (optional `expansions`): when the item carries no
 * (or weak) direct token overlap, related terms found by the bounded local
 * semantic layer contribute a CAPPED overlap (SEMANTIC_OVERLAP_CAP) so an
 * exact keyword match always outranks a purely semantic one. Multiple weak
 * associations never sum up — only the best single expansion counts.
 */
export function scoreItem(
  item: ContextItem,
  requirements: ContextRequirements,
  now: number,
  expansions?: SemanticExpansion[]
): ContextScore {
  const itemTokens = new Set(tokenize(item.content.slice(0, 600)));
  let overlap = overlapScore(itemTokens, requirements.keywords);
  let semanticOverlap = 0;
  let matchReason: string | undefined;
  if (expansions && expansions.length > 0) {
    const hit = semanticOverlapFor(itemTokens, item.content, expansions);
    semanticOverlap = Math.round(hit.overlap * 1000) / 1000;
    const capped = semanticOverlap * SEMANTIC_OVERLAP_CAP;
    if (capped > overlap) {
      overlap = capped;
      matchReason = hit.reason;
    }
  }
  const recency = recencyScore(item.timestamp, now);
  const sourceWeight = SOURCE_WEIGHTS[item.source] ?? 0.5;
  const importance = Math.max(0, Math.min(1, item.importance ?? 0.5));
  const age = now - item.timestamp;
  const stalenessPenalty = item.stale ? 0.35 : age > STALE_MS ? 0.2 : 0;

  // P0 sources (user/constraints) keep a high floor — they must survive budgeting.
  const floor = item.priority === 'P0' ? 0.85 : item.priority === 'P1' ? 0.25 : 0;
  const total = Math.max(
    floor,
    0.5 * overlap + 0.2 * recency + 0.15 * sourceWeight + 0.15 * importance - stalenessPenalty
  );
  return {
    total: Math.round(total * 1000) / 1000,
    overlap: Math.round(overlap * 1000) / 1000,
    recency,
    sourceWeight,
    importance,
    stalenessPenalty,
    semanticOverlap,
    matchReason,
  };
}

/** Normalized duplicate fingerprint (first 140 chars, token-keyed). */
function fingerprint(content: string): string {
  return tokenize(content.slice(0, 200)).slice(0, 16).join('-');
}

export interface RankedItem {
  item: ContextItem;
  score: ContextScore;
}

/**
 * Rank, deduplicate and filter candidates:
 *  - drops irrelevant items (no keyword/semantic overlap AND no P0/P1 source claim),
 *  - deduplicates near-identical content, preferring the newer/scored-higher,
 *  - when both a fresh and a stale copy exist, prefers the fresh one,
 *  - ranks by score descending (stable tie-break: newer first),
 *  - semantically-matched items carry an explainable `matchReason` on the item.
 */
export function rankItems(
  items: ContextItem[],
  requirements: ContextRequirements,
  now: number,
  expansions?: SemanticExpansion[]
): RankedItem[] {
  const scored: RankedItem[] = [];
  const byFingerprint = new Map<string, RankedItem>();

  for (const item of items) {
    const score = scoreItem(item, requirements, now, expansions);
    const isPrioritySource = item.priority === 'P0' || item.priority === 'P1';
    // Relevance gate: ambient sources must show at least some topical fit.
    if (!isPrioritySource && score.overlap === 0 && item.source !== 'constraints' && item.source !== 'user') {
      continue;
    }
    // Explainability: surface why a semantically-matched item was kept.
    const effective: ContextItem =
      score.matchReason && !item.matchReason ? { ...item, matchReason: score.matchReason } : item;
    const fp = fingerprint(effective.content);
    const existing = fp ? byFingerprint.get(fp) : undefined;
    if (existing) {
      // Duplicate detection: keep the better item; prefer fresh over stale.
      const existingStale = existing.item.stale ? 1 : 0;
      const candidateStale = effective.stale ? 1 : 0;
      const better =
        candidateStale !== existingStale
          ? candidateStale < existingStale
          : score.total > existing.score.total ||
            (score.total === existing.score.total && effective.timestamp > existing.item.timestamp);
      if (better) {
        // Replace in BOTH the fingerprint map and the output array so the
        // surviving copy is always the one that was actually preferred.
        const replacement = { item: effective, score };
        byFingerprint.set(fp, replacement);
        const idx = scored.indexOf(existing);
        if (idx >= 0) scored[idx] = replacement;
      }
      continue;
    }
    const ranked = { item: effective, score };
    if (fp) byFingerprint.set(fp, ranked);
    scored.push(ranked);
  }

  return scored.sort(
    (a, b) => b.score.total - a.score.total || b.item.timestamp - a.item.timestamp
  );
}
