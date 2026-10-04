/**
 * Deep Research Intelligence (additional capability — outside the numbered
 * roadmap) — claim verification.
 *
 * Cross-checks evidence ACROSS sources: counts independent support, detects
 * numeric and negation conflicts, and assigns honest verdicts.
 *   supported     — ≥2 independent (different registrable domains) sources agree
 *   single_source — exactly one source, never presented as settled fact
 *   conflicting   — sources disagree (numbers or negation)
 *   unverified    — no usable evidence
 * Same-domain mirrors do not count as independent support.
 */
import type { ClaimAssessment, Evidence, SourceConflict, SourceRecord, SubQuestion } from './researchTypes';
import { contentTokens } from './researchPlanner';
import { registrableDomain } from './sourceInspector';

/** Light stemming so "cures"/"cure" and "trials"/"trial" overlap. */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function tokenSet(text: string): Set<string> {
  return new Set(contentTokens(text, 60).map(stem));
}

export function termOverlap(a: string, b: string): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / Math.min(setA.size, setB.size);
}

const NEGATION_RE = /\b(?:not|no|never|cannot|can't|won't|doesn't|don't|didn't|isn't|aren't|without|impossible|false|myth)\b/i;

export function isNegated(text: string): boolean {
  return NEGATION_RE.test(text);
}

/** Number+unit tokens ("12 GB", "89%", "2 million") for value agreement checks. */
export function numericValues(text: string): { value: number; unit: string }[] {
  const out: { value: number; unit: string }[] = [];
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(%|percent|km|kilometers|meters|kg|mb|gb|tb|million|billion|years?|mph|kph|°c|°f|dollars?|usd)?/gi)) {
    const value = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    out.push({ value, unit: (m[2] ?? '').toLowerCase().replace('percent', '%') });
  }
  return out;
}

function unitKey(unit: string): string {
  return unit || 'none';
}

/**
 * Detect conflicts among evidence of the same sub-question. Only evidence
 * from different sources is compared (one source cannot contradict itself
 * in this model). Bounded by maxConflicts.
 */
export function detectConflicts(
  subQuestions: SubQuestion[],
  evidence: Evidence[],
  sources: SourceRecord[],
  maxConflicts = 6
): SourceConflict[] {
  const conflicts: SourceConflict[] = [];

  for (const sub of subQuestions) {
    const items = evidence.filter((e) => e.subQuestionId === sub.id);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (conflicts.length >= maxConflicts) return conflicts;
        const a = items[i];
        const b = items[j];
        if (a.sourceId === b.sourceId) continue;
        const overlap = termOverlap(a.quote, b.quote);
        if (overlap < 0.45) continue;

        const numsA = numericValues(a.quote);
        const numsB = numericValues(b.quote);
        for (const na of numsA) {
          const conflicting = numsB.find((nb) => unitKey(nb.unit) === unitKey(na.unit) && nb.value !== na.value);
          if (conflicting) {
            conflicts.push({
              subQuestionId: sub.id,
              reason: 'numeric_disagreement',
              detail: `Sources give different ${na.unit || 'numeric'} values (${na.value} vs ${conflicting.value})`,
              a: { evidenceId: a.id, sourceId: a.sourceId, quote: a.quote },
              b: { evidenceId: b.id, sourceId: b.sourceId, quote: b.quote },
            });
            break;
          }
        }
        if (conflicts.some((c) => c.a.evidenceId === a.id && c.b.evidenceId === b.id)) continue;

        const negA = isNegated(a.quote);
        const negB = isNegated(b.quote);
        if (negA !== negB) {
          conflicts.push({
            subQuestionId: sub.id,
            reason: 'negation_disagreement',
            detail: 'One source asserts what the other denies',
            a: { evidenceId: a.id, sourceId: a.sourceId, quote: a.quote },
            b: { evidenceId: b.id, sourceId: b.sourceId, quote: b.quote },
          });
        }
      }
    }
  }
  return conflicts;
}

/** Verdict for one sub-question from its evidence + detected conflicts.
 *  Independence uses registrable domains: mirrors on the same site
 *  (e.g. en.m.wikipedia.org vs en.wikipedia.org) are one source. */
export function assessSubQuestion(
  sub: SubQuestion,
  evidence: Evidence[],
  sources: SourceRecord[],
  conflicts: SourceConflict[]
): ClaimAssessment {
  const items = evidence.filter((e) => e.subQuestionId === sub.id);
  const sourceIds = [...new Set(items.map((e) => e.sourceId))];
  const domains = new Set(
    sourceIds.map((id) => {
      const source = sources.find((s) => s.id === id);
      return source ? registrableDomain(source.url) || source.domain || id : id;
    })
  );
  const subConflicts = conflicts.filter((c) => c.subQuestionId === sub.id);

  if (subConflicts.length > 0) {
    const involved = new Set<string>();
    for (const c of subConflicts) {
      involved.add(c.a.sourceId);
      involved.add(c.b.sourceId);
    }
    return {
      subQuestionId: sub.id,
      verdict: 'conflicting',
      supportingSourceIds: sourceIds,
      conflictingSourceIds: [...involved],
      evidenceIds: items.map((e) => e.id),
      note: subConflicts[0].detail,
    };
  }

  if (domains.size >= 2) {
    return {
      subQuestionId: sub.id,
      verdict: 'supported',
      supportingSourceIds: sourceIds,
      conflictingSourceIds: [],
      evidenceIds: items.map((e) => e.id),
    };
  }
  if (items.length >= 1) {
    return {
      subQuestionId: sub.id,
      verdict: 'single_source',
      supportingSourceIds: sourceIds,
      conflictingSourceIds: [],
      evidenceIds: items.map((e) => e.id),
      note: 'Only one source — treat as uncertain, not settled fact',
    };
  }
  return {
    subQuestionId: sub.id,
    verdict: 'unverified',
    supportingSourceIds: [],
    conflictingSourceIds: [],
    evidenceIds: [],
    note: 'No relevant evidence found yet',
  };
}

/** Assess every sub-question (bounded by the sub-question list itself). */
export function assessAll(
  subQuestions: SubQuestion[],
  evidence: Evidence[],
  sources: SourceRecord[],
  conflicts: SourceConflict[]
): ClaimAssessment[] {
  return subQuestions.map((sub) => assessSubQuestion(sub, evidence, sources, conflicts));
}
