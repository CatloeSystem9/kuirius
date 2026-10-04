/**
 * Deep Research Intelligence (additional capability — outside the numbered
 * roadmap) — gap detection + follow-up queries.
 *
 * After each research round: which sub-questions are unanswered, which have
 * only thin (single-source) support, which aspect of a question the evidence
 * never addresses, and which conflicts remain unresolved. Every gap carries a
 * concrete follow-up query so the next round is targeted, not redundant.
 */
import type { Evidence, ResearchGap, SubQuestion } from './researchTypes';
import { queryNorm } from './researchTypes';
import { contentTokens } from './researchPlanner';

const ASPECT_EVIDENCE_RE: Record<string, RegExp> = {
  cause: /\bbecause\b|\bdue to\b|\bcaused\b|\bresults? in\b|\bleads? to\b|\bso that\b|\bin order to\b|\breason\b/i,
  process: /\bstep\b|\bfirst\b|\bthen\b|\bprocess\b|\bworks? by\b|\bmethod\b|\bprocedure\b|\bvia\b|\bthrough\b|\bconsists of\b/i,
  time: /\b(1[89]\d{2}|20\d{2})\b|\byear\b|\bmonth\b|\bcentury\b|\bdate\b|\bfounded\b|\bestablished\b|\bbegan\b|\bhistory\b/i,
  quantity: /\d/,
  comparison: /\bwhereas\b|\bcompared\b|\bthan\b|\bhowever\b|\bwhile\b|\bunlike\b|\bversus\b|\bdifference\b|\bin contrast\b/i,
  definition: /\s(?:is|are)\s|\brefers to\b|\bmeans\b|\bdefined as\b|\bknown as\b/i,
  general: /./,
};

/** Does the evidence address the aspect the question asks about? */
export function aspectSatisfied(aspect: string, evidence: Evidence[]): boolean {
  if (evidence.length === 0) return false;
  const re = ASPECT_EVIDENCE_RE[aspect] ?? ASPECT_EVIDENCE_RE.general;
  return evidence.some((e) => re.test(e.quote));
}

export interface GapInput {
  subQuestions: SubQuestion[];
  evidence: Evidence[];
  distinctDomainsBySubQuestion: Map<string, number>;
  conflictingSubQuestionIds: Set<string>;
}

/** Detect bounded gaps for the current dossier state. */
export function detectGaps(input: GapInput, maxGaps = 8): ResearchGap[] {
  const gaps: ResearchGap[] = [];
  for (const sub of input.subQuestions) {
    if (gaps.length >= maxGaps) break;
    const items = input.evidence.filter((e) => e.subQuestionId === sub.id);
    const domains = input.distinctDomainsBySubQuestion.get(sub.id) ?? 0;

    if (input.conflictingSubQuestionIds.has(sub.id)) {
      gaps.push({
        subQuestionId: sub.id,
        kind: 'unresolved_conflict',
        detail: 'Sources disagree — needs an independent tie-breaker source',
        suggestedQuery: `${contentTokens(sub.text, 8).join(' ')} explained`.trim(),
      });
      continue;
    }
    if (items.length === 0) {
      gaps.push({
        subQuestionId: sub.id,
        kind: 'uncovered',
        detail: 'No relevant evidence found for this sub-question yet',
        suggestedQuery: contentTokens(sub.text, 10).join(' ') || sub.text.slice(0, 100),
      });
      continue;
    }
    if (domains < 2) {
      gaps.push({
        subQuestionId: sub.id,
        kind: 'thin',
        detail: 'Only one source — independent confirmation still missing',
        suggestedQuery: `${contentTokens(sub.text, 8).join(' ')} overview`.trim(),
      });
      continue;
    }
    if (!aspectSatisfied(sub.aspect, items)) {
      gaps.push({
        subQuestionId: sub.id,
        kind: 'missing_aspect',
        detail: `Evidence found but does not address the "${sub.aspect}" aspect of the question`,
        suggestedQuery: `${contentTokens(sub.text, 8).join(' ')} ${aspectQueryWord(sub.aspect)}`.trim(),
      });
    }
  }
  return gaps;
}

function aspectQueryWord(aspect: string): string {
  switch (aspect) {
    case 'cause': return 'reasons';
    case 'process': return 'how it works';
    case 'time': return 'history timeline';
    case 'quantity': return 'statistics numbers';
    case 'comparison': return 'comparison differences';
    case 'definition': return 'definition';
    default: return 'facts';
  }
}

/** Follow-up queries for the next round: deduped against everything already
 *  searched, bounded by the round budget. */
export function followUpQueries(
  gaps: ResearchGap[],
  usedQueryNorms: Set<string>,
  budget: number
): string[] {
  const out: string[] = [];
  for (const gap of gaps) {
    if (out.length >= budget) break;
    const candidate = gap.suggestedQuery.trim();
    if (!candidate) continue;
    const norm = queryNorm(candidate);
    if (!norm || usedQueryNorms.has(norm)) continue;
    usedQueryNorms.add(norm);
    out.push(candidate);
  }
  return out;
}
