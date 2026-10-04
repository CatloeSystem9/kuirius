/**
 * Task complexity classification (Phase 17) — deterministic, local-first.
 *
 * Pure regex/counter heuristics over the task text: NO model call, no I/O.
 * Produces the tier that drives model routing (smallest capable model first)
 * and complexity-proportional timeout guidance. Every factor is bounded so
 * classification cost is O(text) with tiny constants.
 */
export type TaskComplexity = 'TRIVIAL' | 'SIMPLE' | 'MODERATE' | 'COMPLEX' | 'HIGH_COMPLEXITY';

export interface ClassificationFactors {
  lengthChars: number;
  wordCount: number;
  clauseCount: number;
  imperativeVerbs: number;
  visionSignals: number;
  browserSignals: number;
  computerSignals: number;
  researchSignals: number;
  reasoningSignals: number;
  verificationSignals: number;
  ambiguitySignals: number;
  contextChars: number;
}

export interface Classification {
  tier: TaskComplexity;
  score: number;
  factors: ClassificationFactors;
}

const IMPERATIVE_VERB_RE =
  /\b(open|launch|start|run|go|visit|search|find|look|scan|check|inspect|type|write|create|play|watch|listen|download|compare|organize|close|set|turn|show|get|make|fix|read|browse|tell|report|summarize|list|locate|remember|note|click|scroll|drag|move|press|copy|paste|select|delete|rename|focus)\b/gi;

const SIGNALS = {
  vision: /\b(screen|screenshot|look at|visible on|what am i|read (?:the|my) screen|camera|analyze (?:the )?(?:screen|image))\b/gi,
  browser: /\b(browser|website|web page|web site|https?:\/\/|url|tab|navigate to|search (?:on |in )?(?:google|youtube|wikipedia|the web))\b/gi,
  computer: /\b(click|double.?click|keyboard|mouse|cursor|hotkey|press|type into|scroll|window|application|app launcher)\b/gi,
  research: /\b(research|investigate|find out|dig into|look into|deep dive|cross.?check|sources?)\b/gi,
  reasoning: /\b(why|explain|analyze|reason|prove|derive|strategy|architect|trade.?offs?|pros? and cons?|algorithm|refactor|implement|design|plan|step[- ]by[- ]step)\b/gi,
  verification: /\b(verify|make sure|confirm|check that|ensure|validate)\b/gi,
  ambiguity: /\b(either|not sure|maybe|i think|perhaps)\b/gi,
} as const;

const GREETING_RE =
  /^(hi|hello|hey|yo|good\s+(?:morning|afternoon|evening|night)|thanks?|thank you|thank u|ok(?:ay)?|cool|nice|great|bye|goodbye|gn|gm|namaste)[\s!.,~]*$/i;

const COMPOUND_SPLIT_RE = /;|\n|\b(?:and then|then|after that|afterwards)\b|\band\s+(?=(?:open|launch|start|run|search|find|check|click|type|play|read|create|delete|compare|research|report|tell|show|list))/gi;

/** Complexity-proportional timeout guidance (feeds recovery/fallback budgets). */
export function recommendedTimeoutMs(tier: TaskComplexity): number {
  switch (tier) {
    case 'TRIVIAL': return 8_000;
    case 'SIMPLE': return 15_000;
    case 'MODERATE': return 30_000;
    case 'COMPLEX': return 60_000;
    case 'HIGH_COMPLEXITY': return 120_000;
  }
}

function countMatches(text: string, re: RegExp): number {
  const matches = text.match(re);
  return Math.min(matches ? matches.length : 0, 8);
}

/**
 * Classify one task. Pure and deterministic: the same text (+ context size)
 * always yields the same tier, so routing decisions are reproducible and
 * safely cacheable.
 */
export function classifyTask(input: { text: string; contextChars?: number }): Classification {
  const text = String(input.text ?? '');
  const trimmed = text.trim();
  const contextChars = Math.max(0, Math.floor(input.contextChars ?? 0));

  const factors: ClassificationFactors = {
    lengthChars: Math.min(trimmed.length, 4_000),
    wordCount: trimmed ? Math.min(trimmed.split(/\s+/).length, 400) : 0,
    clauseCount: 0,
    imperativeVerbs: 0,
    visionSignals: countMatches(text, SIGNALS.vision),
    browserSignals: countMatches(text, SIGNALS.browser),
    computerSignals: countMatches(text, SIGNALS.computer),
    researchSignals: countMatches(text, SIGNALS.research),
    reasoningSignals: countMatches(text, SIGNALS.reasoning),
    verificationSignals: countMatches(text, SIGNALS.verification),
    ambiguitySignals: countMatches(text, SIGNALS.ambiguity),
    contextChars,
  };

  const clauses = trimmed.split(COMPOUND_SPLIT_RE).map((c) => c.trim()).filter((c) => c.length > 1);
  factors.clauseCount = Math.min(clauses.length, 8);
  const verbMatches = trimmed.match(IMPERATIVE_VERB_RE);
  factors.imperativeVerbs = Math.min(verbMatches ? verbMatches.length : 0, 10);

  // Pure greetings/acknowledgements are always trivial — never spend a strong
  // model (or a long timeout) on "hi".
  const wordCount = factors.wordCount;
  if (wordCount <= 3 && GREETING_RE.test(trimmed)) {
    return { tier: 'TRIVIAL', score: 0, factors };
  }
  if (wordCount === 0) {
    return { tier: 'TRIVIAL', score: 0, factors };
  }

  let score = 0;
  score += Math.min(18, factors.lengthChars / 30);
  score += Math.min(12, wordCount / 6);
  score += Math.min(12, Math.max(0, factors.clauseCount - 1) * 4);
  score += Math.min(12, factors.imperativeVerbs * 4);
  score += factors.visionSignals * 9;
  score += factors.browserSignals * 6;
  score += factors.computerSignals * 5;
  score += factors.researchSignals * 9;
  score += Math.min(15, factors.reasoningSignals * 5);
  score += factors.verificationSignals * 4;
  score += factors.ambiguitySignals * 3;
  score += Math.min(15, contextChars / 4_000);

  const tier: TaskComplexity =
    score < 4 ? 'TRIVIAL'
    : score < 12 ? 'SIMPLE'
    : score < 30 ? 'MODERATE'
    : score < 55 ? 'COMPLEX'
    : 'HIGH_COMPLEXITY';

  return { tier, score: Math.round(score * 100) / 100, factors };
}

/** Cheap deterministic key for caching classifications (bounded length). */
export function classificationKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 400);
}
