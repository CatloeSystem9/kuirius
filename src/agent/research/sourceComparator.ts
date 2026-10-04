/**
 * Deep Research Intelligence (additional capability — outside the numbered
 * roadmap) — source comparison.
 *
 * Compares inspected sources against each other on shared sub-questions:
 * where they agree, where they diverge, and how they rank by quality ×
 * evidence yield. Used by the synthesizer to prefer independent, higher
 * quality sources and by the report to disclose the comparison honestly.
 */
import type { Evidence, SourceConflict, SourceRecord, SubQuestion } from './researchTypes';
import { termOverlap } from './claimVerifier';
import { registrableDomain } from './sourceInspector';

export interface SourcePairComparison {
  subQuestionId: string;
  sourceA: string;
  sourceB: string;
  /** 'agree' | 'disagree' | 'partial' — deterministic thresholds. */
  relation: 'agree' | 'disagree' | 'partial';
  overlapScore: number;
}

/** Pairwise source relation per sub-question (bounded output). */
export function compareSources(
  subQuestions: SubQuestion[],
  sources: SourceRecord[],
  evidence: Evidence[],
  conflicts: SourceConflict[],
  maxComparisons = 12
): SourcePairComparison[] {
  const out: SourcePairComparison[] = [];
  for (const sub of subQuestions) {
    const items = evidence.filter((e) => e.subQuestionId === sub.id);
    const bySource = new Map<string, Evidence[]>();
    for (const ev of items) {
      const list = bySource.get(ev.sourceId) ?? [];
      list.push(ev);
      bySource.set(ev.sourceId, list);
    }
    const sourceIds = [...bySource.keys()];
    for (let i = 0; i < sourceIds.length; i++) {
      for (let j = i + 1; j < sourceIds.length; j++) {
        if (out.length >= maxComparisons) return out;
        const a = sourceIds[i];
        const b = sourceIds[j];
        const quotesA = (bySource.get(a) ?? []).map((e) => e.quote);
        const quotesB = (bySource.get(b) ?? []).map((e) => e.quote);
        let best = 0;
        for (const qa of quotesA.slice(0, 3)) {
          for (const qb of quotesB.slice(0, 3)) {
            best = Math.max(best, termOverlap(qa, qb));
          }
        }
        const conflicted = conflicts.some(
          (c) =>
            c.subQuestionId === sub.id &&
            ((c.a.sourceId === a && c.b.sourceId === b) || (c.a.sourceId === b && c.b.sourceId === a))
        );
        const relation: SourcePairComparison['relation'] = conflicted
          ? 'disagree'
          : best >= 0.45
            ? 'agree'
            : best >= 0.25
              ? 'partial'
              : 'partial';
        out.push({ subQuestionId: sub.id, sourceA: a, sourceB: b, relation, overlapScore: Math.round(best * 100) / 100 });
      }
    }
  }
  return out;
}

export interface SourceRanking {
  sourceId: string;
  score: number;
  evidenceCount: number;
  independent: boolean;
}

/**
 * Rank sources: quality × evidence yield; `independent` marks the first
 * source per registrable domain (mirrors on the same site don't add support).
 */
export function rankSources(sources: SourceRecord[], evidence: Evidence[]): SourceRanking[] {
  const seenDomains = new Set<string>();
  const counts = new Map<string, number>();
  for (const ev of evidence) counts.set(ev.sourceId, (counts.get(ev.sourceId) ?? 0) + 1);
  const maxCount = Math.max(1, ...counts.values());

  return sources
    .map((s) => {
      const domain = registrableDomain(s.url);
      const independent = !seenDomains.has(domain);
      seenDomains.add(domain);
      const evidenceCount = counts.get(s.id) ?? 0;
      const score = Math.round(s.quality * (0.5 + 0.5 * (evidenceCount / maxCount)) * 100) / 100;
      return { sourceId: s.id, score, evidenceCount, independent };
    })
    .sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId));
}
