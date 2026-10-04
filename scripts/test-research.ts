/**
 * Deep Research Intelligence verification suite (additional Krisha capability,
 * outside the numbered roadmap — NOT roadmap Phase 16, which is Advanced
 * Planning; this suite exercises only the research capability on top of it).
 * Usage: npx tsx scripts/test-research.ts
 *
 * Deterministic: scripted in-memory backends (no network, no real timers),
 * fixed limits, injected clocks. Exits non-zero on any failure.
 * Covers: goal decomposition, source quality, evidence extraction, claim
 * verification (support/conflict/uncertainty), gap detection + follow-ups,
 * source comparison, synthesis/citations, the bounded research loop
 * (rounds, budgets, cancellation, honest failure), every registered tool
 * (schema, permissions, events, dossier isolation), planner integration,
 * Agent Core end-to-end execution through the official Phase 16 (Advanced
 * Planning) planning layer,
 * the Phase 14 multimodal hook, backend error mapping, and bounded resources.
 */
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { PlanEngine } from '../src/agent/planning';
import {
  ResearchService,
  createResearchTools,
  FakeResearchBackend,
  HttpResearchBackend,
  setResearchBackendBaseUrl,
  normalizeGoal,
  decomposeGoal,
  detectAspect,
  planQueries,
  resetResearchPlannerIds,
  resetSourceIds,
  resetEvidenceIds,
  domainOfUrl,
  registrableDomain,
  tierForDomain,
  qualityScore,
  makeSourceRecord,
  splitSentences,
  scoreRelevance,
  extractEvidenceFromSource,
  mergeEvidence,
  detectConflicts,
  assessAll,
  detectGaps,
  followUpQueries,
  compareSources,
  rankSources,
  buildReport,
  renderReport,
  contentTokens,
} from '../src/agent/research';
import { classifyResearchIntent, classifyStep, isResearchIntent, isResearchRequest, HeuristicPlanner, extractGoal } from '../src/agent/planner';
import type { ResearchDossier, ResearchLimits, SearchHit, SourceRecord, SubQuestion, Evidence } from '../src/agent/research';
import { DEFAULT_RESEARCH_LIMITS, queryNorm, clampText } from '../src/agent/research';
import { MultimodalContext } from '../src/agent/multimodal/multimodalContext';
import type { AgentTool } from '../src/agent/types';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const ok = actual === expected;
  if (ok) passed++;
  else {
    failed++;
    failures.push(`${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    console.error(`  ✗ ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

// ---------------------------------------------------------------- corpus

function hit(title: string, url: string, snippet = ''): SearchHit {
  return { title, url, snippet };
}

function photosynthesisBackend(): FakeResearchBackend {
  const backend = new FakeResearchBackend();
  backend.pages.set('https://en.wikipedia.org/wiki/Photosynthesis', {
    title: 'Photosynthesis - Wikipedia',
    text: [
      'Photosynthesis is the process used by plants, algae and some bacteria to convert sunlight into chemical energy.',
      'During photosynthesis, chlorophyll inside chloroplasts absorbs light and converts it through a series of reactions.',
      'The work of converting carbon dioxide and water into sugars happens in two stages.',
      'Photosynthesis produces oxygen as a byproduct and sustains most life on Earth.',
    ].join(' '),
  });
  backend.pages.set('https://www.britannica.com/science/photosynthesis', {
    title: 'Photosynthesis | Britannica',
    text: [
      'Photosynthesis is the process by which green plants transform light energy into chemical energy.',
      'Photosynthesis work begins when chlorophyll absorbs light energy inside the plant.',
      'Photosynthesis is vital for life on Earth because it supplies oxygen and energy.',
    ].join(' '),
  });
  backend.pages.set('https://www.khanacademy.org/science/biology/photosynthesis', {
    title: 'Photosynthesis | Khan Academy',
    text: [
      'How does photosynthesis work?',
      'Light reactions capture energy inside the chloroplast.',
      'The Calvin cycle then fixes carbon dioxide into sugars.',
      'This work proceeds inside the thylakoid membranes of the chloroplast.',
      'The process of photosynthesis converts light into usable chemical fuel.',
    ].join(' '),
  });
  backend.pages.set('https://www.nature.com/articles/photosynthesis-2026', {
    title: 'New developments in photosynthesis research — Nature',
    text: [
      'Current developments in photosynthesis research include artificial leaves and improved quantum efficiency.',
      'Key facts about recent photosynthesis studies show higher crop yields.',
      'Photosynthesis research continues to advance crop science.',
    ].join(' '),
  });
  backend.pages.set('https://www.sciencedaily.com/releases/photosynthesis-breakthrough', {
    title: 'Photosynthesis breakthrough reported — ScienceDaily',
    text: [
      'Key facts from the new photosynthesis study point to faster energy transfer.',
      'Current developments in photosynthesis research may improve harvests worldwide.',
      'The study is the latest photosynthesis development this year.',
    ].join(' '),
  });
  backend.pages.set('https://www.quantamagazine.org/photosynthesis-explained-20260101', {
    title: 'Photosynthesis, explained — Quanta Magazine',
    text: [
      'An overview of photosynthesis: key facts, current developments, and open questions.',
      'Photosynthesis research has accelerated in the last decade.',
    ].join(' '),
  });
  return backend;
}

function photosynthesisLimits(): Partial<ResearchLimits> {
  return {
    maxRounds: 3,
    maxSearches: 8,
    maxQueriesPerRound: 3,
    maxSources: 10,
    maxHitsKept: 4,
    maxEvidencePerSource: 3,
    maxEvidencePerSubQuestion: 6,
  };
}

// =================================================================
// 1. Research planning (deterministic decomposition)
// =================================================================
{
  console.log('Research planner — normalization, decomposition, aspects, queries');
  resetResearchPlannerIds();

  assertEqual(normalizeGoal('research quantum computing'), 'quantum computing', 'normalizeGoal strips "research"');
  assertEqual(normalizeGoal('find out whether honey never spoils'), 'honey never spoils', 'normalizeGoal strips "find out whether"');
  assertEqual(normalizeGoal('investigate dark matter'), 'dark matter', 'normalizeGoal strips "investigate"');
  assertEqual(normalizeGoal('compare Redis and Memcached'), 'compare Redis and Memcached', 'normalizeGoal KEEPS "compare" for decomposition');
  assertEqual(normalizeGoal('krisha, please look into rust ownership'), 'rust ownership', 'normalizeGoal strips pleasantries + "look into"');

  const comp = decomposeGoal('compare Redis and Memcached', 5);
  assertEqual(comp.length, 3, 'comparison goal splits into per-side + difference questions');
  assert(comp.some((s) => s.aspect === 'comparison'), 'comparison question detected');
  assert(comp[0].text.includes('Redis') && comp[1].text.includes('Memcached'), 'both sides present');

  const broad = decomposeGoal('photosynthesis', 5);
  assertEqual(broad.length, 3, 'broad topic expands into aspect questions');
  assertEqual(broad[0].aspect, 'definition', 'broad topic: definition aspect first');
  assertEqual(broad[1].aspect, 'process', 'broad topic: process aspect second');

  const specific = decomposeGoal('What is the tallest mountain on Earth', 5);
  assertEqual(specific.length, 1, 'specific question passes through unchanged');
  assertEqual(specific[0].aspect, 'definition', 'specific what-is question classified as definition');

  assertEqual(detectAspect('Why is the sky blue'), 'cause', 'why-question → cause');
  assertEqual(detectAspect('When did the Roman empire fall'), 'time', 'when-question → time');
  assertEqual(detectAspect('How many elements are there'), 'quantity', 'how-many → quantity');

  const queries = planQueries(broad, 3);
  assert(queries.length >= 1 && queries.length <= 3, 'planned queries bounded');
  assert(queries.every((q) => q.length > 0), 'planned queries non-empty');
  const norms = queries.map(queryNorm);
  assertEqual(new Set(norms).size, norms.length, 'planned queries deduplicated');
}

// =================================================================
// 2. Source inspection (tiers, quality, sentences)
// =================================================================
{
  console.log('Source inspector — domains, tiers, quality, sentence splitting');
  resetSourceIds();

  assertEqual(domainOfUrl('https://en.wikipedia.org/wiki/X'), 'en.wikipedia.org', 'domainOfUrl strips scheme/path');
  assertEqual(registrableDomain('https://en.wikipedia.org/wiki/X'), 'wikipedia.org', 'registrableDomain folds subdomains');
  assertEqual(registrableDomain('https://www.bbc.co.uk/news'), 'bbc.co.uk', 'registrableDomain handles two-level TLDs');

  assertEqual(tierForDomain('wikipedia.org'), 'reference', 'wikipedia → reference tier');
  assertEqual(tierForDomain('nasa.gov'), 'educational', '.gov → educational tier');
  assertEqual(tierForDomain('docs.python.org'), 'docs', 'docs.* → docs tier');
  assertEqual(tierForDomain('reuters.com'), 'news', 'reuters → news tier');
  assertEqual(tierForDomain('reddit.com'), 'social', 'reddit → social tier');
  assertEqual(tierForDomain('random-shop.example.com'), 'general', 'unknown .com → general tier');

  assert(qualityScore('reference', 5_000) > qualityScore('social', 5_000), 'reference quality above social quality');
  assert(qualityScore('general', 100) < qualityScore('general', 5_000), 'thin content scores below substantial content');

  const sentences = splitSentences(
    'Photosynthesis is the process used by plants to convert sunlight into energy. During photosynthesis chlorophyll absorbs light! Short. ' +
      'A third sentence explains how the work happens inside chloroplasts and produces oxygen for the planet.'
  );
  assertEqual(sentences.length, 3, 'sentence splitting keeps well-formed sentences only');

  const source = makeSourceRecord(
    hit('Photosynthesis - Wikipedia', 'https://en.wikipedia.org/wiki/Photosynthesis'),
    { url: 'https://en.wikipedia.org/wiki/Photosynthesis', title: 'Photosynthesis - Wikipedia', text: 'x'.repeat(9_000) },
    4_000,
    1_000
  );
  assertEqual(source.id, 'src_1', 'source id sequence');
  assertEqual(source.textExcerpt.length, 4_000, 'excerpt bounded to excerptMaxChars');
  assertEqual(source.textLength, 9_000, 'original length recorded');
  assertEqual(source.tier, 'reference', 'record tier derived from domain');
}

// =================================================================
// 3. Evidence extraction (relevance, verbatim quotes, dedupe)
// =================================================================
{
  console.log('Evidence extractor — relevance ranking, quote bounding, dedupe');
  resetEvidenceIds();
  const source = makeSourceRecord(
    hit('Photosynthesis', 'https://en.wikipedia.org/wiki/Photosynthesis'),
    {
      url: 'https://en.wikipedia.org/wiki/Photosynthesis',
      title: 'Photosynthesis',
      text:
        'Photosynthesis is the process used by plants to convert sunlight into chemical energy. ' +
        'The Amazon river carries a huge volume of water across South America every single day of the year. ' +
        'During photosynthesis chlorophyll absorbs light and converts it into chemical energy inside chloroplasts. ' +
        'Photosynthesis produces the oxygen that animals breathe.',
    },
    4_000,
    1_000
  );
  const sub: SubQuestion = { id: 'sq_1', text: 'What is photosynthesis?', aspect: 'definition' };
  const evidence = extractEvidenceFromSource(source, sub, { maxPerSource: 4, quoteMaxChars: 320 });

  assert(evidence.length >= 2, 'relevant sentences extracted');
  assert(evidence.every((e) => e.relevance >= 0.3), 'weak sentences filtered out');
  assert(!evidence.some((e) => e.quote.toLowerCase().includes('amazon')), 'irrelevant sentence never quoted');
  assert(evidence.every((e) => e.quote.length <= 320), 'quotes bounded');
  assert(evidence[0].relevance >= (evidence[1]?.relevance ?? 0), 'extracted in descending relevance');
  assert(evidence[0].quote.includes('Photosynthesis'), 'top quote is verbatim source text');

  const dupSource = makeSourceRecord(
    hit('Copy', 'https://mirror.wikipedia.org/wiki/Photosynthesis'),
    { url: 'https://mirror.wikipedia.org/wiki/Photosynthesis', title: 'Copy', text: 'Photosynthesis is the process used by plants to convert sunlight into chemical energy.' },
    4_000,
    1_000
  );
  const dupEvidence = extractEvidenceFromSource(dupSource, sub, {});
  const { merged, added } = mergeEvidence(evidence, dupEvidence, 8);
  assertEqual(added.length, 0, 'near-identical quote from another source not re-added');
  assertEqual(merged.length, evidence.length, 'merge preserves existing evidence');

  // Per-sub-question cap — every quote lexically distinct
  resetEvidenceIds();
  const topics = [
    'chlorophyll absorbs light inside the chloroplast',
    'the Calvin cycle fixes carbon dioxide into sugars',
    'light reactions occur in the thylakoid membranes',
    'oxygen is released as a reaction byproduct',
    'stomata control gas exchange in leaves',
    'glucose stores the harvested chemical energy',
    'water molecules are split during photolysis',
    'carotenoids protect cells from excess light',
    'electron transport drives ATP synthesis',
    'rubisco catalyzes the carbon fixation step',
  ];
  const many: Evidence[] = topics.map((topic, i) => ({
    id: `ev_x${i}`,
    subQuestionId: 'sq_1',
    sourceId: `src_${i}`,
    quote: `Distinct fact ${i}: ${topic}.`,
    relevance: 0.5,
  }));
  const capped = mergeEvidence([], many, 6).merged;
  assertEqual(capped.length, 6, 'per-sub-question evidence cap enforced');
}

// =================================================================
// 4. Claim verification (support, conflicts, independence)
// =================================================================
{
  console.log('Claim verifier — support counting, numeric + negation conflicts');
  const sq: SubQuestion = { id: 'sq_1', text: 'How tall is the Eiffel tower?', aspect: 'quantity' };
  const sources: SourceRecord[] = [
    { id: 'src_1', url: 'https://www.sitea.com/tower', domain: 'sitea.com', title: 'A', tier: 'general', quality: 0.5, fetchedAt: 1, textExcerpt: '', textLength: 0 },
    { id: 'src_2', url: 'https://www.siteb.com/tower', domain: 'siteb.com', title: 'B', tier: 'news', quality: 0.7, fetchedAt: 1, textExcerpt: '', textLength: 0 },
    { id: 'src_3', url: 'https://mirror.sitea.com/tower', domain: 'mirror.sitea.com', title: 'M', tier: 'general', quality: 0.5, fetchedAt: 1, textExcerpt: '', textLength: 0 },
  ];
  const agree: Evidence[] = [
    { id: 'ev_1', subQuestionId: 'sq_1', sourceId: 'src_1', quote: 'The tower is 330 meters tall including its antennas.', relevance: 0.8 },
    { id: 'ev_2', subQuestionId: 'sq_1', sourceId: 'src_2', quote: 'The tower is 330 meters tall including the antennas on top.', relevance: 0.8 },
  ];
  const noConflict = detectConflicts([sq], agree, sources, 6);
  assertEqual(noConflict.length, 0, 'same value from different sources is not a conflict');
  const assessments = assessAll([sq], agree, sources, noConflict);
  assertEqual(assessments[0].verdict, 'supported', 'two independent domains → supported');

  const mirror: Evidence[] = [
    agree[0],
    { id: 'ev_3', subQuestionId: 'sq_1', sourceId: 'src_3', quote: 'The tower is 330 meters tall including its antennas.', relevance: 0.8 },
  ];
  assertEqual(assessAll([sq], mirror, sources, [])[0].verdict, 'single_source', 'same registrable domain does NOT count as independent support');

  const disagree: Evidence[] = [
    { id: 'ev_4', subQuestionId: 'sq_1', sourceId: 'src_1', quote: 'The tower is 330 meters tall including its antennas.', relevance: 0.8 },
    { id: 'ev_5', subQuestionId: 'sq_1', sourceId: 'src_2', quote: 'The tower is 300 meters tall, excluding the antennas.', relevance: 0.8 },
  ];
  const conflicts = detectConflicts([sq], disagree, sources, 6);
  assertEqual(conflicts.length, 1, 'different values → single numeric conflict');
  assertEqual(conflicts[0]?.reason, 'numeric_disagreement', 'conflict reason numeric');
  assertEqual(assessAll([sq], disagree, sources, conflicts)[0].verdict, 'conflicting', 'conflicting evidence labeled conflicting');

  const negSq: SubQuestion = { id: 'sq_2', text: 'Does vitamin C cure scurvy?', aspect: 'general' };
  const neg: Evidence[] = [
    { id: 'ev_6', subQuestionId: 'sq_2', sourceId: 'src_1', quote: 'Vitamin C cures scurvy quickly and reliably.', relevance: 0.8 },
    { id: 'ev_7', subQuestionId: 'sq_2', sourceId: 'src_2', quote: 'Vitamin C does not cure scurvy according to modern trials.', relevance: 0.8 },
  ];
  const negConflicts = detectConflicts([negSq], neg, sources, 6);
  assertEqual(negConflicts.length, 1, 'assertion vs denial → negation conflict');
  assertEqual(negConflicts[0]?.reason, 'negation_disagreement', 'conflict reason negation');

  const unrelated: Evidence[] = [
    { id: 'ev_8', subQuestionId: 'sq_1', sourceId: 'src_1', quote: 'The tower is 330 meters tall including its antennas.', relevance: 0.8 },
    { id: 'ev_9', subQuestionId: 'sq_1', sourceId: 'src_2', quote: 'Paris attracts millions of visitors every summer season.', relevance: 0.8 },
  ];
  assertEqual(detectConflicts([sq], unrelated, sources, 6).length, 0, 'low-overlap quotes are not conflicts');
}

// =================================================================
// 5. Gap detection + follow-up queries
// =================================================================
{
  console.log('Gap detector — uncovered, thin, missing aspect, conflict, follow-ups');
  const subqs: SubQuestion[] = [
    { id: 'sq_1', text: 'What is solar power?', aspect: 'definition' },
    { id: 'sq_2', text: 'How much does solar power cost?', aspect: 'quantity' },
    { id: 'sq_3', text: 'Why is solar power popular?', aspect: 'cause' },
    { id: 'sq_4', text: 'Is solar power better than wind power?', aspect: 'comparison' },
  ];
  const evidence: Evidence[] = [
    { id: 'ev_1', subQuestionId: 'sq_1', sourceId: 'src_1', quote: 'Solar power is the conversion of sunlight into electricity.', relevance: 0.9 },
    { id: 'ev_2', subQuestionId: 'sq_1', sourceId: 'src_2', quote: 'Solar power refers to electricity generated from sunlight.', relevance: 0.9 },
    { id: 'ev_3', subQuestionId: 'sq_2', sourceId: 'src_1', quote: 'Solar power is the conversion of sunlight into electricity.', relevance: 0.9 },
    { id: 'ev_4', subQuestionId: 'sq_2', sourceId: 'src_2', quote: 'Solar power refers to electricity generated from sunlight.', relevance: 0.9 },
    { id: 'ev_5', subQuestionId: 'sq_3', sourceId: 'src_1', quote: 'Solar power is the conversion of sunlight into electricity.', relevance: 0.9 },
    { id: 'ev_6', subQuestionId: 'sq_3', sourceId: 'src_2', quote: 'Solar power is the conversion of sunlight into electricity.', relevance: 0.9 },
  ];
  const domains = new Map<string, number>([
    ['sq_1', 2],
    ['sq_2', 2],
    ['sq_3', 2],
    ['sq_4', 0],
  ]);
  const gaps = detectGaps({ subQuestions: subqs, evidence, distinctDomainsBySubQuestion: domains, conflictingSubQuestionIds: new Set(['sq_3']) });
  assertEqual(gaps.length, 3, 'one gap per sub-question with a real coverage problem');
  assert(gaps.some((g) => g.subQuestionId === 'sq_4' && g.kind === 'uncovered'), 'no evidence → uncovered gap');
  assert(gaps.some((g) => g.subQuestionId === 'sq_2' && g.kind === 'missing_aspect'), 'quantity aspect unaddressed → missing_aspect');
  assert(gaps.some((g) => g.subQuestionId === 'sq_3' && g.kind === 'unresolved_conflict'), 'conflict → unresolved_conflict gap');
  assert(!gaps.some((g) => g.subQuestionId === 'sq_1'), 'covered definition question has no gap');

  // Thin coverage: single domain with a follow-up query distinct from the base query
  const thinDomains = new Map<string, number>([
    ['sq_1', 1],
    ['sq_2', 2],
    ['sq_3', 2],
    ['sq_4', 2],
  ]);
  const thinGaps = detectGaps({ subQuestions: subqs, evidence, distinctDomainsBySubQuestion: thinDomains, conflictingSubQuestionIds: new Set() });
  const thin = thinGaps.find((g) => g.subQuestionId === 'sq_1');
  assert(thin?.kind === 'thin', 'one domain → thin gap');
  const used = new Set([queryNorm('what is solar power')]);
  const followUps = followUpQueries(thinGaps, used, 3);
  assertEqual(followUps.length, 3, 'follow-up queries bounded by budget');
  assert(!followUps.some((q) => queryNorm(q) === [...used][0]), 'already-searched query not re-suggested');
}

// =================================================================
// 6. Source comparison + ranking
// =================================================================
{
  console.log('Source comparator — pairwise relation, ranking, independence');
  const sq: SubQuestion = { id: 'sq_1', text: 'What is solar power?', aspect: 'definition' };
  const sources: SourceRecord[] = [
    { id: 'src_1', url: 'https://a.com/x', domain: 'a.com', title: 'A', tier: 'reference', quality: 0.9, fetchedAt: 1, textExcerpt: '', textLength: 0 },
    { id: 'src_2', url: 'https://b.com/x', domain: 'b.com', title: 'B', tier: 'news', quality: 0.7, fetchedAt: 1, textExcerpt: '', textLength: 0 },
    { id: 'src_3', url: 'https://en.m.a.com/x', domain: 'en.m.a.com', title: 'C', tier: 'general', quality: 0.5, fetchedAt: 1, textExcerpt: '', textLength: 0 },
  ];
  const evidence: Evidence[] = [
    { id: 'ev_1', subQuestionId: 'sq_1', sourceId: 'src_1', quote: 'Solar power converts sunlight into electricity for homes.', relevance: 0.9 },
    { id: 'ev_2', subQuestionId: 'sq_1', sourceId: 'src_2', quote: 'Solar power converts sunlight into electricity for homes.', relevance: 0.9 },
    { id: 'ev_3', subQuestionId: 'sq_1', sourceId: 'src_3', quote: 'Solar power is a way to harvest energy using panels.', relevance: 0.6 },
  ];
  const comparisons = compareSources([sq], sources, evidence, [], 12);
  assertEqual(comparisons.length, 3, 'pairwise comparisons for 3 sources');
  assert(comparisons.some((c) => c.relation === 'agree'), 'high-overlap pair marked agree');
  const ranking = rankSources(sources, evidence);
  assertEqual(ranking[0].sourceId, 'src_1', 'highest quality × evidence ranks first');
  assert(ranking.filter((r) => r.independent).length === 2, 'first source per registrable domain marked independent');
  assert(ranking.some((r) => !r.independent), 'mirror source marked non-independent');
}

// =================================================================
// 7. Synthesis (report structure, citations, honesty, rendering)
// =================================================================
{
  console.log('Synthesizer — citations, confidence, open questions, bounded render');
  resetSourceIds();
  resetEvidenceIds();
  resetResearchPlannerIds();
  const dossier: ResearchDossier = {
    taskId: 't-synth',
    question: 'What is solar power?',
    subQuestions: [
      { id: 'sq_1', text: 'What is solar power?', aspect: 'definition' },
      { id: 'sq_2', text: 'How much does solar power cost?', aspect: 'quantity' },
    ],
    queries: [
      { text: 'solar power', norm: 'solar power', round: 1, status: 'done' },
      { text: 'solar power cost', norm: 'cost power solar', round: 1, status: 'failed' },
    ],
    hits: [],
    sources: [
      { id: 'src_1', url: 'https://a.com/x', domain: 'a.com', title: 'Solar Energy Explained', tier: 'reference', quality: 0.9, fetchedAt: 1, textExcerpt: '', textLength: 5_000 },
      { id: 'src_2', url: 'https://b.com/x', domain: 'b.com', title: 'Solar News', tier: 'news', quality: 0.7, fetchedAt: 1, textExcerpt: '', textLength: 3_000 },
    ],
    evidence: [
      { id: 'ev_1', subQuestionId: 'sq_1', sourceId: 'src_1', quote: 'Solar power is the conversion of sunlight into electricity.', relevance: 0.9 },
      { id: 'ev_2', subQuestionId: 'sq_1', sourceId: 'src_2', quote: 'Solar power refers to electricity generated from sunlight.', relevance: 0.85 },
    ],
    assessments: [],
    conflicts: [],
    gaps: [{ subQuestionId: 'sq_2', kind: 'uncovered', detail: 'no evidence', suggestedQuery: 'cost' }],
    citations: [],
    roundsUsed: 1,
    searchesUsed: 2,
    failures: ['search "solar power cost" failed: quota'],
    startedAt: 1,
  };
  dossier.assessments = assessAll(dossier.subQuestions, dossier.evidence, dossier.sources, []);

  const report = buildReport(dossier);
  assertEqual(report.citations.length, 2, 'one citation per inspected source');
  assertEqual(report.citations[0].id, 1, 'citations numbered from 1');
  assertEqual(report.confidence, 'medium', 'one supported + one open question → medium confidence');
  assertEqual(report.openQuestions.length, 1, 'unverified sub-question becomes open question');
  assert(report.limitations.some((l) => l.includes('search "solar power cost" failed')), 'backend failures disclosed in limitations');
  assert(report.limitations.some((l) => l.toLowerCase().includes('expert')), 'honest expert-verification disclaimer present');
  assertEqual(report.stats.searches, 2, 'report stats reflect searches');
  assertEqual(report.stats.failedSearches, 1, 'failed searches counted');
  const supportedFinding = report.findings.find((f) => f.verdict === 'supported');
  assert(supportedFinding !== undefined, 'supported finding present');
  assert(supportedFinding!.statements.every((s) => s.citationIds.length === 1 && s.kind === 'fact'), 'factual statements carry citations');
  const rendered = renderReport(report, DEFAULT_RESEARCH_LIMITS.reportMaxChars);
  assert(rendered.includes('[1]') && rendered.includes('[2]'), 'rendered report uses [n] citations');
  assert(rendered.includes('Sources:'), 'rendered report lists sources');
  assert(rendered.includes('Could not answer:'), 'rendered report discloses open questions');
  assert(rendered.length <= DEFAULT_RESEARCH_LIMITS.reportMaxChars, 'rendered report bounded');

  // Single-source uncertainty must be labeled, never presented as settled fact.
  const singleDossier: ResearchDossier = { ...dossier, sources: [dossier.sources[0]], evidence: [dossier.evidence[0]], failures: [], gaps: [] };
  singleDossier.assessments = assessAll(singleDossier.subQuestions, singleDossier.evidence, singleDossier.sources, []);
  const singleReport = buildReport(singleDossier);
  assertEqual(singleReport.findings[0].verdict, 'single_source', 'one source → single_source verdict');
  assert(singleReport.findings[0].statements.some((s) => s.kind === 'inference' && s.text.toLowerCase().includes('uncertain')), 'single-source statement labeled uncertain');
  assertEqual(singleReport.confidence, 'medium', 'single source → medium ceiling');

  // All-unverified must be honest low confidence.
  const emptyDossier: ResearchDossier = { ...singleDossier, sources: [], evidence: [] };
  emptyDossier.assessments = assessAll(emptyDossier.subQuestions, emptyDossier.evidence, emptyDossier.sources, []);
  const emptyReport = buildReport(emptyDossier);
  assertEqual(emptyReport.confidence, 'low', 'no evidence → low confidence');
  assert(emptyReport.answerSummary.toLowerCase().includes('could not'), 'no-evidence summary is honest');
}

// =================================================================
// 8. Tools through the registry (schema, permissions, events)
// =================================================================
{
  console.log('Research tools — schema validation, permission gating, events');
  resetSourceIds();
  resetEvidenceIds();
  resetResearchPlannerIds();
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  const backend = photosynthesisBackend();
  const service = new ResearchService({ backend, registry, events: bus, permissions, limits: photosynthesisLimits(), now: () => 1_000 });
  registry.registerAll(createResearchTools(service));

  const ctx = (taskId: string) => ({ taskId, stepId: 's1', signal: new AbortController().signal, memory: {}, permissions });

  // Schema validation
  const invalid = await registry.execute('research.search', {}, ctx('tool-task'));
  assert(!invalid.success && invalid.errorKind === 'invalid_input', 'research.search without query → invalid_input');

  // Dossier-less analysis tools refuse honestly
  const noDossier = await registry.execute('research.analyze', {}, ctx('no-plan'));
  assert(!noDossier.success && String(noDossier.error).includes('no active research dossier'), 'analyze without plan → honest refusal');
  const noDossier2 = await registry.execute('research.synthesize', {}, ctx('no-plan2'));
  assert(!noDossier2.success && String(noDossier2.error).includes('no active research dossier'), 'synthesize without plan → honest refusal');

  // Permission gating
  permissions.revoke('browser.interaction');
  const denied = await registry.execute('research.search', { query: 'photosynthesis' }, ctx('tool-task'));
  assert(!denied.success && denied.errorKind === 'permission_denied', 'revoked browser.interaction → permission_denied for search');
  const deniedRun = await registry.execute('research.run', { goal: 'research photosynthesis' }, ctx('tool-task'));
  assert(!deniedRun.success && deniedRun.errorKind === 'permission_denied', 'research.run gated by browser.interaction');
  permissions.grant('browser.interaction');

  // Manual pipeline through the registry
  const planResult = await registry.execute('research.plan', { goal: 'research photosynthesis' }, ctx('tool-task'));
  assert(planResult.success, 'research.plan succeeds');
  const planned = planResult.output as { queries: string[]; subQuestions: SubQuestion[] };
  assertEqual(planned.subQuestions.length, 3, 'plan creates 3 sub-questions for a broad topic');

  backend.defaultSearch = [
    hit('Photosynthesis - Wikipedia', 'https://en.wikipedia.org/wiki/Photosynthesis'),
    hit('Photosynthesis | Britannica', 'https://www.britannica.com/science/photosynthesis'),
  ];
  const searchResult = await registry.execute('research.search', { query: planned.queries[0] }, ctx('tool-task'));
  assert(searchResult.success, 'research.search succeeds');
  const readResult = await registry.execute('research.read_source', { url: 'https://en.wikipedia.org/wiki/Photosynthesis' }, ctx('tool-task'));
  assert(readResult.success, 'research.read_source succeeds');
  const extractResult = await registry.execute('research.extract_evidence', {}, ctx('tool-task'));
  assert(extractResult.success, 'research.extract_evidence succeeds');
  const analyzeResult = await registry.execute('research.analyze', {}, ctx('tool-task'));
  assert(analyzeResult.success, 'research.analyze succeeds');
  const synthResult = await registry.execute('research.synthesize', {}, ctx('tool-task'));
  assert(synthResult.success, 'research.synthesize succeeds');
  assert(String((synthResult.output as any).summary).includes('Summary ('), 'synthesize output.summary is the rendered report');

  const names = bus.recentEvents().map((e) => e.name);
  assert(names.includes('TOOL_STARTED') && names.includes('TOOL_COMPLETED'), 'tool executions emit TOOL_* events');
  assert(names.includes('RESEARCH_PLAN_CREATED') && names.includes('RESEARCH_SEARCH_COMPLETED'), 'research pipeline emits RESEARCH_* events');
  assert(names.includes('RESEARCH_SOURCE_INSPECTED'), 'source inspection emits RESEARCH_SOURCE_INSPECTED');

  // Query dedupe: same query twice → backend not re-hit, no new searches
  const before = backend.searchCalls;
  await registry.execute('research.search', { query: planned.queries[0] }, ctx('tool-task'));
  assertEqual(backend.searchCalls, before, 'duplicate query never re-hits the backend');
  const dossier = service.dossierFor('tool-task');
  assert(dossier !== undefined && dossier.queries.filter((q) => q.status === 'done').length === 1, 'duplicate query marked done once');
}

// =================================================================
// 9. Bounded research loop (rounds, budgets, failures, cancel)
// =================================================================
{
  console.log('Research loop — multi-round coverage, budgets, honest failures');
  resetSourceIds();
  resetEvidenceIds();
  resetResearchPlannerIds();

  // --- Scenario A: two rounds until full coverage ---
  {
    const bus = new AgentEventBus();
    const registry = new ToolRegistry(bus);
    const backend = photosynthesisBackend();
    backend.searchResults.set('key facts current developments photosynthesis', {
      hits: [hit('New developments in photosynthesis research — Nature', 'https://www.nature.com/articles/photosynthesis-2026')],
    });
    backend.searchResults.set('key facts current developments photosynthesis overview', {
      hits: [
        hit('Photosynthesis breakthrough reported — ScienceDaily', 'https://www.sciencedaily.com/releases/photosynthesis-breakthrough'),
        hit('Photosynthesis, explained — Quanta Magazine', 'https://www.quantamagazine.org/photosynthesis-explained-20260101'),
      ],
    });
    backend.defaultSearch = [
      hit('Photosynthesis - Wikipedia', 'https://en.wikipedia.org/wiki/Photosynthesis'),
      hit('Photosynthesis | Britannica', 'https://www.britannica.com/science/photosynthesis'),
      hit('Photosynthesis | Khan Academy', 'https://www.khanacademy.org/science/biology/photosynthesis'),
    ];
    const service = new ResearchService({ backend, registry, events: bus, limits: photosynthesisLimits(), now: () => 1_000 });
    registry.registerAll(createResearchTools(service));

    const report = await service.runResearch('task-a', 'research photosynthesis', new AbortController().signal);
    assertEqual(report.stats.rounds, 2, 'second round runs for the thin sub-question');
    assertEqual(report.stats.searches, 3, 'three searches across two rounds');
    assertEqual(report.stats.sourcesInspected, 6, 'all scripted sources inspected');
    assertEqual(report.confidence, 'high', 'full coverage → high confidence');
    assert(report.findings.every((f) => f.verdict === 'supported'), 'every finding supported by independent domains');
    assertEqual(report.openQuestions.length, 0, 'no open questions remain');
    const roundEvents = bus.recentEvents().filter((e) => e.name === 'RESEARCH_ROUND_COMPLETED');
    assertEqual(roundEvents.length, 2, 'RESEARCH_ROUND_COMPLETED emitted per round');
    assert(bus.recentEvents().some((e) => e.name === 'RESEARCH_FOLLOWUP_QUEUED'), 'follow-up queued for round 2');
    assert(bus.recentEvents().some((e) => e.name === 'RESEARCH_COMPLETED'), 'RESEARCH_COMPLETED emitted');
    assert(!bus.recentEvents().some((e) => e.name === 'RESEARCH_INSUFFICIENT_EVIDENCE'), 'no insufficient-evidence signal on full coverage');
  }

  // --- Scenario B: hard budget (searches, rounds) — sources stay available ---
  {
    const bus = new AgentEventBus();
    const registry = new ToolRegistry(bus);
    const backend = photosynthesisBackend();
    backend.defaultSearch = [
      hit('W', 'https://en.wikipedia.org/wiki/Photosynthesis'),
      hit('B', 'https://www.britannica.com/science/photosynthesis'),
      hit('K', 'https://www.khanacademy.org/science/biology/photosynthesis'),
      hit('N', 'https://www.nature.com/articles/photosynthesis-2026'),
    ];
    const service = new ResearchService({
      backend,
      registry,
      events: bus,
      limits: { maxQueriesPerRound: 1, maxRounds: 3, maxSources: 5, maxSearches: 2 },
      now: () => 1_000,
    });
    registry.registerAll(createResearchTools(service));
    const report = await service.runResearch('task-b', 'research photosynthesis', new AbortController().signal);
    assert(report.stats.searches <= 2, 'search budget respected');
    assertEqual(report.stats.rounds, 2, 'second round runs, third blocked by exhausted search budget');
    assertEqual(report.stats.sourcesInspected, 4, 'sources inspected within budget');
    assert(report.confidence !== 'high', 'truncated research does not claim high confidence');
  }

  // --- Scenario C: every search fails → honest low-confidence report ---
  {
    const bus = new AgentEventBus();
    const registry = new ToolRegistry(bus);
    const backend = new FakeResearchBackend();
    backend.failNextSearches = 99;
    const service = new ResearchService({ backend, registry, events: bus, limits: { maxRounds: 2 }, now: () => 1_000 });
    registry.registerAll(createResearchTools(service));
    const report = await service.runResearch('task-c', 'research photosynthesis', new AbortController().signal);
    assertEqual(report.confidence, 'low', 'all searches failing → low confidence');
    assertEqual(report.citations.length, 0, 'no sources → no citations');
    assert(report.answerSummary.toLowerCase().includes('could not'), 'summary states honest inability');
    assert(bus.recentEvents().some((e) => e.name === 'RESEARCH_INSUFFICIENT_EVIDENCE'), 'RESEARCH_INSUFFICIENT_EVIDENCE emitted');
    assert(report.limitations.some((l) => l.includes('failed')), 'search failures disclosed');
  }

  // --- Scenario D: fetch failures are skipped and disclosed ---
  {
    const bus = new AgentEventBus();
    const registry = new ToolRegistry(bus);
    const backend = photosynthesisBackend();
    backend.failFetchContaining = ['britannica'];
    backend.defaultSearch = [
      hit('W', 'https://en.wikipedia.org/wiki/Photosynthesis'),
      hit('B', 'https://www.britannica.com/science/photosynthesis'),
    ];
    const service = new ResearchService({ backend, registry, events: bus, limits: photosynthesisLimits(), now: () => 1_000 });
    registry.registerAll(createResearchTools(service));
    const report = await service.runResearch('task-d', 'research photosynthesis', new AbortController().signal);
    assertEqual(report.stats.sourcesInspected, 1, 'failed fetch skipped');
    assert(report.limitations.some((l) => l.includes('fetch failed')), 'failed fetch disclosed in limitations');
    assert(report.stats.evidenceCount > 0, 'evidence still gathered from healthy sources');
  }

  // --- Scenario E: conflicting sources surface as conflicts, not averages ---
  {
    const bus = new AgentEventBus();
    const registry = new ToolRegistry(bus);
    const backend = new FakeResearchBackend();
    backend.pages.set('https://www.towerfacts.com/eiffel', {
      title: 'Eiffel Tower Facts',
      text: 'The Eiffel tower is 330 meters tall including its antennas. The Eiffel tower is a famous landmark in Paris. Work on the Eiffel tower finished in 1889.',
    });
    backend.pages.set('https://www.parisguide.info/eiffel-height', {
      title: 'Paris Guide: Eiffel Tower',
      text: 'The Eiffel tower is 300 meters tall, excluding the antennas. The Eiffel tower is an iron lattice tower in Paris. Its construction work was completed in 1889.',
    });
    backend.defaultSearch = [
      hit('Tower Facts', 'https://www.towerfacts.com/eiffel'),
      hit('Paris Guide', 'https://www.parisguide.info/eiffel-height'),
    ];
    const service = new ResearchService({ backend, registry, events: bus, limits: photosynthesisLimits(), now: () => 1_000 });
    registry.registerAll(createResearchTools(service));
    const report = await service.runResearch('task-e', 'research the eiffel tower', new AbortController().signal);
    assert(report.conflicts.length >= 1, 'numeric conflict detected through the full loop');
    assertEqual(report.conflicts[0]?.reason, 'numeric_disagreement', 'conflict reason recorded');
    const conflicting = report.findings.find((f) => f.verdict === 'conflicting');
    assert(conflicting !== undefined, 'conflicting finding present');
    const rendered = renderReport(report, DEFAULT_RESEARCH_LIMITS.reportMaxChars);
    assert(rendered.includes('330') && rendered.includes('300'), 'both sides of the conflict reported');
  }

  // --- Scenario F: pre-cancelled run throws AbortError honestly ---
  {
    const registry = new ToolRegistry();
    const service = new ResearchService({ backend: photosynthesisBackend(), registry, limits: photosynthesisLimits(), now: () => 1_000 });
    registry.registerAll(createResearchTools(service));
    const controller = new AbortController();
    controller.abort();
    let cancelled = false;
    try {
      await service.runResearch('task-f', 'research photosynthesis', controller.signal);
    } catch (err: any) {
      cancelled = err?.name === 'AbortError';
    }
    assert(cancelled, 'cancelled run throws AbortError');
  }

  // --- Dossier pruning: bounded store ---
  {
    const registry = new ToolRegistry();
    const service = new ResearchService({ backend: photosynthesisBackend(), registry, limits: { maxDossiers: 2 }, now: () => 1_000 });
    registry.registerAll(createResearchTools(service));
    const ctx = (id: string) => ({ taskId: id, stepId: 's', signal: new AbortController().signal, memory: {} });
    await registry.execute('research.plan', { goal: 'research photosynthesis' }, ctx('t1'));
    await registry.execute('research.plan', { goal: 'research photosynthesis' }, ctx('t2'));
    await registry.execute('research.plan', { goal: 'research photosynthesis' }, ctx('t3'));
    assertEqual(service.dossierFor('t1'), undefined, 'oldest dossier evicted beyond maxDossiers');
    assert(service.dossierFor('t3') !== undefined, 'newest dossier retained');
  }
}

// =================================================================
// 10. Planner integration (conservative research intents)
// =================================================================
{
  console.log('Planner integration — research intents, non-hijack guarantees');
  assertEqual(classifyResearchIntent('research quantum computing')?.toolName, 'research.run', 'research X → research.run');
  assertEqual(classifyResearchIntent('compare Redis and Memcached')?.toolName, 'research.run', 'compare X and Y → research.run');
  assertEqual(classifyResearchIntent('look into rust ownership')?.toolName, 'research.run', 'look into X → research.run');
  assertEqual(classifyResearchIntent('find out whether honey spoils')?.toolName, 'research.run', 'find out whether X → research.run');
  assertEqual(classifyResearchIntent('what is quantum computing'), null, 'plain question stays chat');
  assertEqual(classifyResearchIntent('search python tutorial on google'), null, 'web search stays web');
  assertEqual(classifyResearchIntent('find resume.pdf'), null, 'file target stays filesystem');
  assertEqual(classifyResearchIntent('compare apples'), null, 'bare "compare" without comparative structure stays chat');
  assertEqual(classifyResearchIntent('research'), null, 'bare verb too short');
  assertEqual(classifyStep('research photosynthesis')?.toolName, 'research.run', 'classifyStep routes research clauses');
  assert(isResearchIntent('research photosynthesis'), 'single-clause research intent for delegation');
  assert(!isResearchIntent('hello krisha'), 'ordinary chat not hijacked');

  assert(isResearchRequest('research photosynthesis and tell me what you find'), 'research + report clause → one research task');
  assert(!isResearchRequest('research photosynthesis then open youtube'), 'mixed research + browser request not swallowed');

  const planner = new HeuristicPlanner();
  const plan1 = planner.makePlan(extractGoal('research photosynthesis'));
  assertEqual(plan1.steps.length, 1, 'single research request → single research.run step');
  assertEqual(plan1.steps[0].toolName, 'research.run', 'plan uses research.run');

  const plan2 = planner.makePlan(extractGoal('research photosynthesis and tell me what you find'));
  assertEqual(plan2.steps[0].toolName, 'research.run', 'research + report plan starts with research.run');
  assertEqual(plan2.steps[plan2.steps.length - 1].toolName, 'chat.report', 'report clause remains the terminal step');

  const plan3 = planner.makePlan(extractGoal('research photosynthesis then open youtube'));
  assert(plan3.steps.some((s) => s.toolName === 'research.run'), 'mixed request keeps research.run for the research clause');
  assert(plan3.steps.some((s) => s.toolName === 'web.open_website'), 'mixed request keeps web step');
}

// =================================================================
// 11. Agent Core end-to-end (through the official Phase 16 planning layer)
// =================================================================
{
  console.log('Agent Core end-to-end — research task completes with cited report');
  resetSourceIds();
  resetEvidenceIds();
  resetResearchPlannerIds();
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  const backend = photosynthesisBackend();
  backend.searchResults.set('key facts current developments photosynthesis', {
    hits: [hit('New developments in photosynthesis research — Nature', 'https://www.nature.com/articles/photosynthesis-2026')],
  });
  backend.searchResults.set('key facts current developments photosynthesis overview', {
    hits: [
      hit('Photosynthesis breakthrough reported — ScienceDaily', 'https://www.sciencedaily.com/releases/photosynthesis-breakthrough'),
      hit('Photosynthesis, explained — Quanta Magazine', 'https://www.quantamagazine.org/photosynthesis-explained-20260101'),
    ],
  });
  backend.defaultSearch = [
    hit('Photosynthesis - Wikipedia', 'https://en.wikipedia.org/wiki/Photosynthesis'),
    hit('Photosynthesis | Britannica', 'https://www.britannica.com/science/photosynthesis'),
    hit('Photosynthesis | Khan Academy', 'https://www.khanacademy.org/science/biology/photosynthesis'),
  ];
  const service = new ResearchService({ backend, registry, events: bus, permissions, limits: photosynthesisLimits(), now: () => 1_000 });
  registry.registerAll(createResearchTools(service));
  // chat.report + system.note come from the production tool set; register
  // faithful Node-side equivalents (same contract) for the headless core.
  const chatReport: AgentTool = {
    name: 'chat.report',
    description: 'Terminal step: report the task result to the user.',
    category: 'communication',
    riskLevel: 'safe',
    cost: 'free',
    reliability: 1,
    capabilities: ['communication.report'],
    permissions: [],
    inputSchema: { optional: ['topic'], types: { topic: 'string' } },
    verification: { strategy: 'self_reported' },
    timeoutMs: 5_000,
    execute: async (input) => ({ success: true, output: { acknowledged: true, topic: input.topic ?? '' } }),
  };
  registry.registerAll([chatReport]);

  const planning = new PlanEngine({ registry, events: bus, permissions });
  const core = new AgentCore({ registry, events: bus, store: new TaskStore(new MemoryStorage()), permissions, planning });
  const task = await core.submit('research photosynthesis and tell me what you find');

  assertEqual(task.status, 'completed', 'research task completes end-to-end');
  assert(task.plan?.steps[0].toolName === 'research.run', 'plan scheduled research.run');
  const report = (task.plan?.steps[0].result?.output as any)?.report;
  assert(report !== undefined, 'step output carries the structured report');
  assertEqual(report.confidence, 'high', 'end-to-end report has high confidence');
  assert(report.citations.length >= 3, 'end-to-end report cites multiple sources');
  assert(String(task.summary).includes('Summary (high confidence)'), 'task summary carries the research synthesis');
  const eventNames = bus.recentEvents().map((e) => e.name);
  assert(eventNames.includes('TASK_COMPLETED'), 'TASK_COMPLETED emitted');
  assert(eventNames.includes('RESEARCH_ROUND_COMPLETED'), 'research rounds observable on the shared bus');
  assert(eventNames.includes('PLAN_CREATED'), 'hierarchical planning layer tracked the task');
}

// =================================================================
// 12. Phase 14 multimodal hook + official Phase 16 (Advanced Planning)
//     planning-layer compatibility
// =================================================================
{
  console.log('Subsystem integration — multimodal evidence, planning compatibility');
  resetSourceIds();
  resetEvidenceIds();
  resetResearchPlannerIds();
  const registry = new ToolRegistry();
  const backend = photosynthesisBackend();
  backend.defaultSearch = [
    hit('W', 'https://en.wikipedia.org/wiki/Photosynthesis'),
    hit('B', 'https://www.britannica.com/science/photosynthesis'),
  ];
  const multimodalContext = new MultimodalContext();
  const service = new ResearchService({
    backend,
    registry,
    limits: { maxQueriesPerRound: 1, maxRounds: 1 },
    now: () => 1_000,
    multimodal: {
      addText: (text, source) => multimodalContext.addInput({ type: 'text', text, source }),
    },
  });
  registry.registerAll(createResearchTools(service));
  await service.runResearch('mm-task', 'research photosynthesis', new AbortController().signal);
  assertEqual(multimodalContext.byType('text').length, 1, 'research report becomes bounded multimodal text evidence');
  assertEqual((multimodalContext.byType('text')[0] as any).source, 'phase16.research', 'multimodal evidence sourced phase16.research');

  // The research.run step must survive hierarchical plan validation.
  const bus = new AgentEventBus();
  const permissions = new PermissionManager();
  const engine = new PlanEngine({ registry, events: bus, permissions });
  const planner = new HeuristicPlanner();
  const plan = planner.makePlan(extractGoal('research photosynthesis'));
  const attached = engine.attachPlan('plan-compat', plan.goal.description, plan.steps);
  assert(attached.ok, 'research.run plan passes official Phase 16 (Advanced Planning) hierarchical validation');
}

// =================================================================
// 13. HttpResearchBackend (error mapping, endpoint contract)
// =================================================================
{
  console.log('HTTP backend — endpoint paths, error mapping');
  setResearchBackendBaseUrl('http://localhost:3000');
  const calls: { url: string; body?: any }[] = [];
  const okFetch = (async (url: string, init?: any) => {
    calls.push({ url, body: JSON.parse(init?.body ?? '{}') });
    if (url.endsWith('/search')) {
      return { ok: true, status: 200, json: async () => ({ success: true, results: [{ title: 'T', url: 'https://x.com/a', snippet: 's' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, url: 'https://x.com/a', title: 'T', text: 'page text' }) };
  }) as any;
  const backend = new HttpResearchBackend(okFetch);
  const searchResult = await backend.search('test query');
  assertEqual(searchResult.hits.length, 1, 'search results mapped');
  assertEqual(calls[0].url, 'http://localhost:3000/api/research/search', 'search endpoint path');
  assertEqual(calls[0].body.query, 'test query', 'search payload carries the query');
  const fetchResult = await backend.fetchPage('https://x.com/a');
  assertEqual(fetchResult.title, 'T', 'fetch result mapped');
  assertEqual(calls[1].url, 'http://localhost:3000/api/research/fetch', 'fetch endpoint path');

  const errFetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as any;
  const errBackend = new HttpResearchBackend(errFetch);
  const failedSearch = await errBackend.search('q');
  assert(failedSearch.hits.length === 0 && String(failedSearch.error).includes('503'), 'HTTP error mapped to honest failure');
  const failedFetch = await errBackend.fetchPage('https://x.com/a');
  assert(failedFetch.text === '' && String(failedFetch.error).includes('503'), 'fetch error mapped to honest failure');
}

// =================================================================
// 14. Bounded resources + no-polling guarantees
// =================================================================
{
  console.log('Resource guarantees — bounded context, no polling, honest clamps');
  assertEqual(clampText('hello      world', 11), 'hello world', 'clampText collapses whitespace');
  assert(clampText('a'.repeat(100), 10).length === 10, 'clampText bounds length');

  // A full research run must complete without wall-clock stalls (fake backends
  // resolve immediately — the loop never sleeps, polls, or retries on timers).
  const started = Date.now();
  resetSourceIds();
  resetEvidenceIds();
  resetResearchPlannerIds();
  const registry = new ToolRegistry();
  const service = new ResearchService({ backend: photosynthesisBackend(), registry, limits: photosynthesisLimits(), now: () => 1_000 });
  registry.registerAll(createResearchTools(service));
  await service.runResearch('perf-task', 'research photosynthesis', new AbortController().signal);
  const elapsed = Date.now() - started;
  assert(elapsed < 2_000, `research loop resolves promptly without timers (${elapsed}ms)`);

  const dossier = service.dossierFor('perf-task')!;
  const perSubQ = dossier.subQuestions.map((sq) => dossier.evidence.filter((e) => e.subQuestionId === sq.id).length);
  assert(perSubQ.every((n) => n <= 6), 'per-sub-question evidence cap respected');
  assert(dossier.evidence.every((e) => e.quote.length <= DEFAULT_RESEARCH_LIMITS.quoteMaxChars), 'all quotes bounded');
  assert(dossier.sources.length <= DEFAULT_RESEARCH_LIMITS.maxSources, 'source cap respected');
  assert(dossier.searchesUsed <= DEFAULT_RESEARCH_LIMITS.maxSearches, 'search cap respected');

  // Report injected into the registry path carries the citation count.
  const synthesis = service.synthesize('perf-task');
  assert(synthesis.report!.citations.length === dossier.sources.length, 'citation count equals inspected sources');
}

console.log(`\nDeep Research results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('DEEP RESEARCH TESTS: ALL GREEN');
