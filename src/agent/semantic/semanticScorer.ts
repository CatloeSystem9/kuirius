/**
 * Semantic Scorer (Semantic Intelligence v1) — the bridge between semantic
 * expansions and the existing deterministic RelevanceEngine.
 *
 * Contract:
 *  - an item hits an expansion when its tokens (or its normalized text, for
 *    multi-word phrases) contain the expansion term,
 *  - only the BEST matching expansion counts — weak associations never sum
 *    up into a strong one,
 *  - the caller (RelevanceEngine) caps the semantic contribution via
 *    SEMANTIC_OVERLAP_CAP so exact keyword matches always win,
 *  - every hit carries an explainable matchReason.
 */
import type { SemanticExpansion } from './semanticTypes';
import { normalizeTerm } from './semanticExpander';

export interface SemanticHit {
  /** Best expansion confidence found for this item (0 when none). */
  overlap: number;
  /** Explainability for the best hit (debugging/tests/observability). */
  reason?: string;
}

/**
 * Compute the semantic overlap of one item against the request's expansions.
 * `itemTokens` are the item's tokens (existing analyzer tokenizer); the item
 * content is also normalized (plural-folded) so multi-word phrases compare
 * robustly. Deterministic.
 */
export function semanticOverlapFor(itemTokens: Set<string>, itemContent: string, expansions: SemanticExpansion[] | undefined): SemanticHit {
  if (!expansions || expansions.length === 0) return { overlap: 0 };
  const foldedContent = normalizeTerm(String(itemContent ?? '').slice(0, 800));
  let best = 0;
  let bestReason: string | undefined;
  for (const exp of expansions) {
    if (!exp || typeof exp.term !== 'string' || !exp.term) continue;
    if (!Number.isFinite(exp.confidence) || exp.confidence <= 0 || exp.confidence <= best) continue;
    const phraseWords = exp.term.split(' ').filter(Boolean);
    let hit: boolean;
    if (phraseWords.length === 1) {
      hit = itemTokens.has(exp.term) || foldedContent.split(' ').includes(exp.term);
    } else {
      hit = foldedContent.includes(exp.term);
    }
    if (hit) {
      best = exp.confidence;
      bestReason = exp.reason;
    }
  }
  return { overlap: best, reason: bestReason };
}
