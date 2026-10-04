/**
 * Deep Research Intelligence (additional capability — outside the numbered
 * roadmap) — research planning.
 *
 * Deterministic, domain-agnostic decomposition of a research goal into
 * bounded sub-questions and initial search queries. Pure functions, no I/O:
 * the same goal always produces the same plan, and every plan respects
 * ResearchLimits (maxSubQuestions / maxQueriesPerRound).
 */
import type { QuestionAspect, SubQuestion } from './researchTypes';
import { queryNorm } from './researchTypes';

/** Small English stopword list for term extraction (domain-agnostic). */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'about',
  'into', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'can',
  'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must', 'have', 'has', 'had', 'it', 'its',
  'this', 'that', 'these', 'those', 'there', 'their', 'them', 'they', 'we', 'our', 'you', 'your', 'i',
  'me', 'my', 'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'tell', 'get',
  'out', 'up', 'some', 'any', 'more', 'most', 'than', 'then', 'so', 'such', 'between', 'whether', 'vs',
  'vs.', 'versus', 'difference', 'differences', 'compare', 'info', 'information', 'research', 'please',
]);

/** Content tokens of a phrase — query/overlap vocabulary (bounded). */
export function contentTokens(text: string, max = 14): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .slice(0, max);
}

/** Strip the research-request phrasing, leaving the core question/topic. */
export function normalizeGoal(rawInput: string): string {
  let q = rawInput.trim().replace(/\?+$/, '').trim();
  q = q.replace(/^(?:hey|hi|hello|ok|okay|krisha)[,\s]+/i, '');
  q = q.replace(/^please\s+/i, '');
  q = q.replace(/^(?:can\s+you|could\s+you|would\s+you)\s+/i, '');
  q = q.replace(
    // "compare" is intentionally KEPT: decomposeGoal uses it to detect
    // comparison goals and split them into per-side + difference questions.
    /^(?:do\s+(?:some\s+)?research(?:\s+(?:about|on|into))?\s*(?:about|on|into)?\s*|research(?:\s+(?:about|on|into))?\s+(?:about|on|into)?\s*|investigate\s+|dig\s+into\s+|look\s+into\s+|find\s+out\s+(?:about|whether|if|what|why|how|when|which|who)?\s*|gather\s+(?:some\s+)?(?:info|information)\s+(?:about|on|regarding)\s+)/i,
    ''
  ).trim();
  return q.length >= 3 ? q : rawInput.trim();
}

/** Detect what kind of answer a question asks for. */
export function detectAspect(text: string): QuestionAspect {
  const t = text.toLowerCase();
  if (/\b(vs\.?|versus)\b|\bdifference[s]?\s+between\b|\bcompare\b|\bbetter\b.*\bor\b/.test(t)) return 'comparison';
  if (/^why\b|\bwhy\s+(?:is|are|do|does|did)\b|\breason[s]?\b|\bcause[ds]?\b/.test(t)) return 'cause';
  if (/\bhow\s+(?:do|does|did|to)\b|\bwork[s]?\s*\?|\bprocess\b|\bsteps?\b|\bmechanism\b/.test(t)) return 'process';
  if (/^when\b|\bwhen\s+(?:was|were|did|is)\b|\bhistory\b|\borigins?\b|\bfounded\b|\binvented\b|\breleased?\b/.test(t)) return 'time';
  if (/\bhow\s+(?:many|much)\b|\bhow\s+long\b|\bpopulation\b|\bcost\b|\bprice\b|\bsize\b|\bspeed\b/.test(t)) return 'quantity';
  if (/^what\s+(?:is|are|was|were)\b|\bdefine\b|\bdefinition\s+of\b|\bmeaning\s+of\b|\bwho\s+(?:is|was|are)\b|\bwhere\s+is\b/.test(t)) return 'definition';
  return 'general';
}

const COMPARISON_SPLIT_RE =
  /\b(?:compare\s+(?:the\s+)?)?(.+?)\s+(?:vs\.?|versus|and)\s+(.+?)(?:\s*[-—:]?\s*(?:differences?|comparison|which\s+is\s+better[^?]*))?$/i;
const DIFFERENCE_BETWEEN_RE = /\b(?:differences?|comparison)\s+(?:between\s+)?(.+?)\s+and\s+(.+)$/i;

let sqCounter = 0;
function sq(text: string, aspect: QuestionAspect): SubQuestion {
  sqCounter += 1;
  return { id: `sq_${sqCounter}`, text, aspect };
}
/** Test/normalization hook: reset the deterministic id counter. */
export function resetResearchPlannerIds(): void {
  sqCounter = 0;
}

/**
 * Decompose a normalized goal into bounded sub-questions.
 * Comparison goals split into per-side + difference questions; broad topics
 * get aspect-driven questions; specific questions pass through as-is.
 */
export function decomposeGoal(goal: string, maxSubQuestions = 5): SubQuestion[] {
  const question = goal.trim();
  if (!question) return [];

  // Comparison: "compare X and Y" / "X vs Y" / "difference between X and Y".
  const diff = question.match(DIFFERENCE_BETWEEN_RE);
  const comp = diff ? null : question.match(COMPARISON_SPLIT_RE);
  if ((comp && /\bvs\.?\b|\bversus\b|\bcompare\b/i.test(question)) || diff) {
    const a = (diff ? diff[1] : comp![1]).trim().replace(/^(?:between\s+)?/i, '');
    const b = (diff ? diff[2] : comp![2]).trim();
    if (a.length >= 2 && b.length >= 2) {
      return [
        sq(`What is ${a}?`, 'definition'),
        sq(`What is ${b}?`, 'definition'),
        sq(`What are the key differences between ${a} and ${b}?`, 'comparison'),
      ].slice(0, maxSubQuestions);
    }
  }

  // Explicit multi-part question: split on "?" boundaries / " and " between questions.
  const parts = question
    .split(/\?|,/)
    .map((p) => p.trim())
    .filter((p) => contentTokens(p).length >= 2);
  if (parts.length >= 2) {
    return parts.slice(0, maxSubQuestions).map((p) => sq(p, detectAspect(p)));
  }

  // Broad topic (few content tokens): aspect-driven expansion.
  const tokens = contentTokens(question);
  const aspect = detectAspect(question);
  if (tokens.length <= 4 && aspect === 'general') {
    const topic = tokens.join(' ');
    return [
      sq(`What is ${topic}?`, 'definition'),
      sq(`How does ${topic} work?`, 'process'),
      sq(`What are the key facts and current developments about ${topic}?`, 'general'),
    ].slice(0, maxSubQuestions);
  }

  // Specific question passes through unchanged.
  return [sq(question, aspect)];
}

/**
 * Initial search queries for the sub-questions — content terms only,
 * deduplicated, bounded. The first round never exceeds maxQueries.
 */
export function planQueries(subQuestions: SubQuestion[], maxQueries = 3): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const sub of subQuestions) {
    if (queries.length >= maxQueries) break;
    const terms = contentTokens(sub.text, 10);
    if (terms.length < 2) continue;
    const query = terms.join(' ');
    const norm = queryNorm(query);
    if (seen.has(norm)) continue;
    seen.add(norm);
    queries.push(query);
  }
  // Degenerate case: too few terms — fall back to the raw question text.
  if (queries.length === 0 && subQuestions.length > 0) {
    const fallback = subQuestions[0].text.trim();
    if (fallback) queries.push(fallback.slice(0, 120));
  }
  return queries;
}
