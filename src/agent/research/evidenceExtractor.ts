/**
 * Deep Research Intelligence (additional capability — outside the numbered
 * roadmap) — evidence extraction.
 *
 * Selects the most relevant verbatim sentences from an inspected source for a
 * sub-question, bounds and deduplicates them. Quotes are NEVER paraphrased:
 * citations point at real text so claims stay checkable.
 */
import type { Evidence, SourceRecord, SubQuestion } from './researchTypes';
import { clampText, queryNorm } from './researchTypes';
import { contentTokens } from './researchPlanner';
import { splitSentences } from './sourceInspector';

/** 0..1 relevance of a sentence to a question (token coverage + density). */
export function scoreRelevance(sentence: string, questionTokens: string[]): number {
  if (questionTokens.length === 0) return 0;
  const tokens = contentTokens(sentence, 60);
  if (tokens.length === 0) return 0;
  const tokenSet = new Set(tokens);
  let matched = 0;
  for (const q of questionTokens) {
    if (tokenSet.has(q)) matched++;
  }
  const coverage = matched / questionTokens.length;
  const density = matched / Math.max(4, Math.min(tokens.length, 24));
  return Math.round((coverage * 0.7 + density * 0.3) * 100) / 100;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

function tokenSetOf(text: string): Set<string> {
  return new Set(contentTokens(text, 60));
}

let evCounter = 0;
export function resetEvidenceIds(): void {
  evCounter = 0;
}

export interface ExtractOptions {
  minRelevance?: number;
  maxPerSource?: number;
  quoteMaxChars?: number;
}

/**
 * Extract the top relevant sentences of one source for one sub-question.
 * Near-identical sentences inside the same source are collapsed.
 */
export function extractEvidenceFromSource(
  source: SourceRecord,
  subQuestion: SubQuestion,
  opts: ExtractOptions = {}
): Evidence[] {
  const minRelevance = opts.minRelevance ?? 0.3;
  const maxPerSource = opts.maxPerSource ?? 4;
  const quoteMaxChars = opts.quoteMaxChars ?? 320;
  const questionTokens = contentTokens(subQuestion.text, 12);
  if (questionTokens.length === 0) return [];

  const scored = splitSentences(source.textExcerpt)
    .map((sentence) => ({ sentence, relevance: scoreRelevance(sentence, questionTokens) }))
    .filter((s) => s.relevance >= minRelevance)
    .sort((a, b) => b.relevance - a.relevance);

  const evidence: Evidence[] = [];
  const seen = new Set<string>();
  for (const candidate of scored) {
    if (evidence.length >= maxPerSource) break;
    const set = tokenSetOf(candidate.sentence);
    let duplicate = false;
    for (const norm of seen) {
      if (jaccard(set, new Set(norm.split(' '))) >= 0.75) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;
    seen.add([...set].join(' '));
    evCounter += 1;
    evidence.push({
      id: `ev_${evCounter}`,
      subQuestionId: subQuestion.id,
      sourceId: source.id,
      quote: clampText(candidate.sentence, quoteMaxChars),
      relevance: candidate.relevance,
    });
  }
  return evidence;
}

/** Merge extracted evidence into the dossier's evidence list, respecting the
 *  per-sub-question cap and dropping near-identical repeats. */
export function mergeEvidence(
  existing: Evidence[],
  incoming: Evidence[],
  maxPerSubQuestion: number
): { merged: Evidence[]; added: Evidence[] } {
  const added: Evidence[] = [];
  const result = [...existing];
  for (const ev of incoming) {
    const sameSubQ = result.filter((e) => e.subQuestionId === ev.subQuestionId);
    if (sameSubQ.length >= maxPerSubQuestion) continue;
    const evSet = tokenSetOf(ev.quote);
    let duplicate = false;
    for (const other of sameSubQ) {
      if (queryNorm(other.quote) === queryNorm(ev.quote) || jaccard(evSet, tokenSetOf(other.quote)) >= 0.85) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;
    result.push(ev);
    added.push(ev);
  }
  return { merged: result, added };
}
