/**
 * Deep Research Intelligence (additional capability — outside the numbered
 * roadmap) — public surface.
 *
 * Multi-step, bounded, citation-tracked research built ON the existing
 * architecture: tools register in the ToolRegistry, the Agent Core schedules
 * `research.run` through the planner, every capability executes through the
 * registry contract, and synthesis follows honest-evidence rules.
 */
export * from './researchTypes';
export { HttpResearchBackend, FakeResearchBackend, setResearchBackendBaseUrl } from './researchBackends';
export {
  normalizeGoal,
  decomposeGoal,
  detectAspect,
  planQueries,
  contentTokens,
  resetResearchPlannerIds,
} from './researchPlanner';
export {
  domainOfUrl,
  registrableDomain,
  tierForDomain,
  qualityScore,
  makeSourceRecord,
  splitSentences,
  extractYears,
  resetSourceIds,
} from './sourceInspector';
export {
  scoreRelevance,
  extractEvidenceFromSource,
  mergeEvidence,
  resetEvidenceIds,
} from './evidenceExtractor';
export {
  assessSubQuestion,
  assessAll,
  detectConflicts,
  termOverlap,
  isNegated,
  numericValues,
} from './claimVerifier';
export { detectGaps, followUpQueries, aspectSatisfied } from './gapDetector';
export { compareSources, rankSources } from './sourceComparator';
export type { SourcePairComparison, SourceRanking } from './sourceComparator';
export { buildReport, renderReport } from './synthesizer';
export { ResearchService } from './researchService';
export type { ResearchServiceOptions } from './researchService';
export { createResearchTools } from './researchTools';
