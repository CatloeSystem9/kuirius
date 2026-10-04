/**
 * Deep Research Intelligence (additional capability — outside the numbered
 * roadmap; NOT roadmap Phase 16) — types.
 *
 * A research task is a bounded dossier: goal → sub-questions → queries →
 * sources → evidence → assessments (supported / conflicting / uncertain /
 * inference) → gaps → follow-up queries → report with citations. Every
 * collection is bounded by ResearchLimits so a research run can never grow
 * unbounded in memory, context, or network use (laptop-optimized).
 *
 * Honesty rules (spec): evidence is quoted from inspected sources with
 * citations; conflicts are never averaged away; single-source statements are
 * labeled uncertain; synthesis beyond the quotes is labeled inference;
 * insufficient evidence produces an honest low-confidence report instead of
 * manufactured certainty.
 */

/** Coarse source-quality tier, derived deterministically from the domain. */
export type SourceTier = 'reference' | 'educational' | 'docs' | 'news' | 'general' | 'social' | 'unknown';

/** One web-search result (never trusted blindly — inspected before use). */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** An inspected source with bounded extracted text and quality signals. */
export interface SourceRecord {
  id: string; // src_N
  url: string;
  domain: string;
  title: string;
  tier: SourceTier;
  /** 0..1 deterministic quality estimate (tier + content signals). */
  quality: number;
  fetchedAt: number;
  /** Bounded readable text used for evidence extraction. */
  textExcerpt: string;
  /** Full fetched-text length before bounding (for diagnostics). */
  textLength: number;
}

/** What kind of answer a sub-question asks for — drives gap detection. */
export type QuestionAspect =
  | 'definition'
  | 'cause'
  | 'process'
  | 'time'
  | 'quantity'
  | 'comparison'
  | 'general';

export interface SubQuestion {
  id: string; // sq_N
  text: string;
  aspect: QuestionAspect;
}

/** A quoted piece of evidence tied to one source and one sub-question. */
export interface Evidence {
  id: string; // ev_N
  subQuestionId: string;
  sourceId: string;
  /** Verbatim sentence from the source (bounded). */
  quote: string;
  /** 0..1 relevance to the sub-question. */
  relevance: number;
}

/** Honest verdict for one sub-question's collected evidence. */
export type ClaimVerdict = 'supported' | 'single_source' | 'conflicting' | 'unverified';

export interface ClaimAssessment {
  subQuestionId: string;
  verdict: ClaimVerdict;
  /** Distinct source ids backing the current best statements. */
  supportingSourceIds: string[];
  /** Sources on the other side of a detected conflict. */
  conflictingSourceIds: string[];
  evidenceIds: string[];
  note?: string;
}

export type ConflictReason = 'numeric_disagreement' | 'negation_disagreement';

export interface SourceConflict {
  subQuestionId: string;
  reason: ConflictReason;
  detail: string;
  a: { evidenceId: string; sourceId: string; quote: string };
  b: { evidenceId: string; sourceId: string; quote: string };
}

export type GapKind = 'uncovered' | 'thin' | 'missing_aspect' | 'unresolved_conflict';

export interface ResearchGap {
  subQuestionId: string;
  kind: GapKind;
  detail: string;
  suggestedQuery: string;
}

export interface Citation {
  /** 1-based citation number used in the rendered report ([n]). */
  id: number;
  sourceId: string;
  title: string;
  url: string;
  domain: string;
  tier: SourceTier;
  quality: number;
}

export type FindingKind = 'fact' | 'inference';

export interface ReportStatement {
  text: string;
  /** Citation numbers backing this statement; empty for inference/uncertain. */
  citationIds: number[];
  kind: FindingKind;
}

export interface ReportFinding {
  subQuestionId: string;
  subQuestion: string;
  verdict: ClaimVerdict;
  statements: ReportStatement[];
}

export interface ResearchReport {
  question: string;
  answerSummary: string;
  confidence: 'high' | 'medium' | 'low';
  findings: ReportFinding[];
  conflicts: SourceConflict[];
  /** Sub-questions (or aspects) the evidence could not answer. */
  openQuestions: string[];
  citations: Citation[];
  limitations: string[];
  stats: {
    rounds: number;
    searches: number;
    failedSearches: number;
    sourcesInspected: number;
    failedFetches: number;
    evidenceCount: number;
  };
  generatedAt: number;
}

/** Hard bounds — no scattered magic numbers, no unbounded research. */
export interface ResearchLimits {
  maxSubQuestions: number;
  maxRounds: number;
  maxSearches: number;
  maxQueriesPerRound: number;
  maxSources: number;
  maxHitsKept: number;
  maxEvidencePerSource: number;
  maxEvidencePerSubQuestion: number;
  maxConflicts: number;
  quoteMaxChars: number;
  excerptMaxChars: number;
  reportMaxChars: number;
  maxDossiers: number;
  searchTimeoutMs: number;
  fetchTimeoutMs: number;
  maxDurationMs: number;
}

export const DEFAULT_RESEARCH_LIMITS: ResearchLimits = {
  maxSubQuestions: 5,
  maxRounds: 3,
  maxSearches: 8,
  maxQueriesPerRound: 3,
  maxSources: 10,
  maxHitsKept: 4,
  maxEvidencePerSource: 4,
  maxEvidencePerSubQuestion: 8,
  maxConflicts: 6,
  quoteMaxChars: 320,
  excerptMaxChars: 4_000,
  reportMaxChars: 6_000,
  maxDossiers: 8,
  searchTimeoutMs: 15_000,
  fetchTimeoutMs: 20_000,
  maxDurationMs: 120_000,
};

/** A planned query and its lifecycle. */
export interface PlannedQuery {
  text: string;
  /** Normalized form used for dedupe (never re-search the same thing). */
  norm: string;
  round: number;
  status: 'pending' | 'done' | 'failed' | 'skipped';
}

/** Per-task research state. Created by research.plan / research.run. */
export interface ResearchDossier {
  taskId: string;
  question: string;
  subQuestions: SubQuestion[];
  queries: PlannedQuery[];
  hits: SearchHit[];
  sources: SourceRecord[];
  evidence: Evidence[];
  assessments: ClaimAssessment[];
  conflicts: SourceConflict[];
  gaps: ResearchGap[];
  citations: Citation[];
  roundsUsed: number;
  searchesUsed: number;
  failures: string[];
  startedAt: number;
  finishedAt?: number;
  report?: ResearchReport;
}

export interface ResearchStats {
  rounds: number;
  searches: number;
  failedSearches: number;
  sourcesInspected: number;
  failedFetches: number;
  evidenceCount: number;
}

/** Pluggable network surface — the only part of research that touches the web.
 *  Real implementation goes through the local server; tests inject fakes. */
export interface ResearchWebBackend {
  search(query: string, signal?: AbortSignal): Promise<{ hits: SearchHit[]; error?: string }>;
  fetchPage(url: string, signal?: AbortSignal): Promise<{ url: string; title: string; text: string; error?: string }>;
}

/** Normalized query key for dedupe: content tokens, sorted, bounded. */
export function queryNorm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .sort()
    .slice(0, 12)
    .join(' ');
}

/** Bounded text clamp that never splits mid-word when avoidable. */
export function clampText(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}
