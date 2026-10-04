/**
 * Deep Research Intelligence (additional capability — outside the numbered
 * roadmap) — research service.
 *
 * The bounded iterative research loop:
 *   PLAN → (SEARCH → SELECT → INSPECT → EXTRACT → ANALYZE → gaps? → next round)*
 *        → SYNTHESIZE → report with citations
 *
 * Architecture rules:
 *  - Every concrete capability is a registered Phase 3 tool; the loop executes
 *    THROUGH the ToolRegistry (validation, permission gating, events, honest
 *    results) — never around it. The Agent Core remains the single executor:
 *    a task's plan schedules the `research.run` tool, which drives this loop.
 *  - No polling, no timers, no background work: the loop advances only on
 *    awaited backend responses and checks the AbortSignal between steps.
 *  - Hard bounds everywhere (rounds, searches, sources, evidence, report size)
 *    plus a wall-clock budget; exhausted budgets end in honest reports.
 */
import type { AgentEventBus } from '../events';
import type { ToolRegistry } from '../toolRegistry';
import type { PermissionManager } from '../permissions';
import type { ResearchDossier, ResearchGap, ResearchLimits, ResearchReport, ResearchWebBackend } from './researchTypes';
import { DEFAULT_RESEARCH_LIMITS, clampText, queryNorm } from './researchTypes';
import { decomposeGoal, normalizeGoal, planQueries } from './researchPlanner';
import { makeSourceRecord, registrableDomain } from './sourceInspector';
import { extractEvidenceFromSource, mergeEvidence } from './evidenceExtractor';
import { assessAll, detectConflicts } from './claimVerifier';
import { detectGaps, followUpQueries } from './gapDetector';
import { buildReport, renderReport } from './synthesizer';

export interface ResearchServiceOptions {
  backend: ResearchWebBackend;
  registry: ToolRegistry;
  events?: AgentEventBus;
  permissions?: PermissionManager;
  limits?: Partial<ResearchLimits>;
  now?: () => number;
  /** Phase 14 hook: research round results become bounded text evidence. */
  multimodal?: { addText(text: string, source: string): void };
}

const RESEARCH_TOOL = 'research.run';
const SEARCH_TOOL = 'research.search';
const READ_TOOL = 'research.read_source';
const EXTRACT_TOOL = 'research.extract_evidence';
const ANALYZE_TOOL = 'research.analyze';
const SYNTHESIZE_TOOL = 'research.synthesize';

export class ResearchService {
  readonly limits: ResearchLimits;
  private readonly backend: ResearchWebBackend;
  private readonly registry: ToolRegistry;
  private readonly events?: AgentEventBus;
  private readonly permissions?: PermissionManager;
  private readonly now: () => number;
  private readonly multimodal?: { addText(text: string, source: string): void };
  private dossiers = new Map<string, ResearchDossier>();

  constructor(options: ResearchServiceOptions) {
    this.backend = options.backend;
    this.registry = options.registry;
    this.events = options.events;
    this.permissions = options.permissions;
    this.now = options.now ?? Date.now;
    this.multimodal = options.multimodal;
    this.limits = { ...DEFAULT_RESEARCH_LIMITS, ...(options.limits ?? {}) };
  }

  // ------------------------------------------------------------- diagnostics

  dossierFor(taskId: string): Readonly<ResearchDossier> | undefined {
    return this.dossiers.get(taskId);
  }

  /** Bounded dossier store: finished dossiers are evicted first, oldest next. */
  private pruneDossiers(): void {
    if (this.dossiers.size <= this.limits.maxDossiers) return;
    const entries = [...this.dossiers.entries()];
    entries.sort((a, b) => {
      const fa = a[1].finishedAt ?? Number.MAX_SAFE_INTEGER;
      const fb = b[1].finishedAt ?? Number.MAX_SAFE_INTEGER;
      if (fa !== fb) return fa - fb;
      return a[1].startedAt - b[1].startedAt;
    });
    while (entries.length > this.limits.maxDossiers) {
      const oldest = entries.shift();
      if (oldest) this.dossiers.delete(oldest[0]);
    }
  }

  endTask(taskId: string): void {
    const dossier = this.dossiers.get(taskId);
    if (dossier && !dossier.finishedAt) dossier.finishedAt = this.now();
  }

  /** Task-lifecycle cleanup on the shared bus (no polling — event driven). */
  attach(bus: AgentEventBus): () => void {
    const offCompleted = bus.on('TASK_COMPLETED', (e) => this.endTask(e.taskId ?? ''));
    const offFailed = bus.on('TASK_FAILED', (e) => this.endTask(e.taskId ?? ''));
    const offCancelled = bus.on('TASK_CANCELLED', (e) => this.endTask(e.taskId ?? ''));
    return () => {
      offCompleted();
      offFailed();
      offCancelled();
    };
  }

  private emit(name: string, taskId: string, payload: Record<string, unknown>): void {
    this.events?.emit({ name: name as never, taskId, payload, timestamp: this.now() });
  }

  private toolContext(taskId: string, signal: AbortSignal, userRequest?: string) {
    return {
      taskId,
      stepId: 'research',
      signal,
      memory: {} as Record<string, unknown>,
      userRequest,
      permissions: this.permissions,
    };
  }

  private async exec(
    tool: string,
    taskId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    userRequest?: string
  ) {
    const result = await this.registry.execute(tool, input, this.toolContext(taskId, signal, userRequest));
    if (signal.aborted) {
      return { ok: false as const, cancelled: true as const, result };
    }
    return { ok: result.success, cancelled: false as const, result };
  }

  // ------------------------------------------------------------ tool surfaces

  /** research.plan — decompose the goal (deterministic, no network). */
  plan(taskId: string, goal: string): { question: string; subQuestions: ResearchDossier['subQuestions']; queries: string[] } {
    const question = normalizeGoal(goal);
    const subQuestions = decomposeGoal(question, this.limits.maxSubQuestions);
    const queries = planQueries(subQuestions, this.limits.maxQueriesPerRound);

    let dossier = this.dossiers.get(taskId);
    if (!dossier || dossier.finishedAt) {
      dossier = {
        taskId,
        question,
        subQuestions,
        queries: [],
        hits: [],
        sources: [],
        evidence: [],
        assessments: [],
        conflicts: [],
        gaps: [],
        citations: [],
        roundsUsed: 0,
        searchesUsed: 0,
        failures: [],
        startedAt: this.now(),
      };
      this.dossiers.set(taskId, dossier);
      this.pruneDossiers();
    }
    const used = new Set(dossier.queries.map((q) => q.norm));
    for (const query of queries) {
      const norm = queryNorm(query);
      if (used.has(norm)) continue;
      used.add(norm);
      dossier.queries.push({ text: query, norm, round: 0, status: 'pending' });
    }
    this.emit('RESEARCH_PLAN_CREATED', taskId, {
      question,
      subQuestions: subQuestions.map((s) => ({ id: s.id, text: s.text, aspect: s.aspect })),
      queries,
    });
    return { question, subQuestions, queries };
  }

  /** research.search — one web search via the backend, recorded in the dossier. */
  async search(taskId: string, query: string, signal: AbortSignal): Promise<{ ok: boolean; hits: number; error?: string }> {
    const dossier = this.dossiers.get(taskId);
    if (!dossier) return { ok: false, hits: 0, error: 'no active research dossier for this task — use research.plan first' };
    const planned = dossier.queries.find((q) => q.norm === queryNorm(query)) ??
      (() => {
        const entry = { text: query, norm: queryNorm(query), round: dossier.roundsUsed, status: 'pending' as const };
        dossier.queries.push(entry);
        return entry;
      })();
    if (dossier.searchesUsed >= this.limits.maxSearches) {
      planned.status = 'skipped';
      return { ok: false, hits: 0, error: 'search budget exhausted' };
    }
    if (planned.status === 'done') {
      return { ok: true, hits: 0 };
    }
    planned.status = 'done';
    dossier.searchesUsed++;

    const started = this.now();
    const response = await this.backend.search(query, signal);
    if (signal.aborted) return { ok: false, hits: 0, error: 'cancelled' };
    if (response.error && response.hits.length === 0) {
      planned.status = 'failed';
      dossier.failures.push(clampText(`search "${clampText(query, 60)}" failed: ${response.error}`, 120));
      this.emit('RESEARCH_SEARCH_COMPLETED', taskId, { query, hits: 0, failed: true, error: response.error });
      return { ok: false, hits: 0, error: response.error };
    }

    const fresh = response.hits.filter(
      (h) =>
        /^https?:\/\//i.test(h.url) &&
        !dossier.hits.some((existing) => existing.url === h.url)
    );
    dossier.hits.push(...fresh);
    this.emit('RESEARCH_SEARCH_COMPLETED', taskId, {
      query,
      hits: fresh.length,
      failed: false,
      durationMs: this.now() - started,
    });
    return { ok: true, hits: fresh.length };
  }

  /** research.read_source — inspect one URL, store the bounded source record. */
  async readSource(
    taskId: string,
    url: string,
    signal: AbortSignal
  ): Promise<{ ok: boolean; sourceId?: string; error?: string }> {
    const dossier = this.dossiers.get(taskId);
    if (!dossier) return { ok: false, error: 'no active research dossier for this task — use research.plan first' };
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http(s) sources can be inspected' };
    if (dossier.sources.some((s) => s.url === url)) {
      return { ok: true, sourceId: dossier.sources.find((s) => s.url === url)!.id };
    }
    if (dossier.sources.length >= this.limits.maxSources) {
      return { ok: false, error: 'source budget exhausted' };
    }
    const started = this.now();
    const page = await this.backend.fetchPage(url, signal);
    if (signal.aborted) return { ok: false, error: 'cancelled' };
    if (page.error || !page.text) {
      dossier.failures.push(clampText(`fetch failed: ${clampText(url, 80)} — ${page.error ?? 'empty page'}`, 120));
      this.emit('RESEARCH_SOURCE_INSPECTED', taskId, { url, failed: true, error: page.error ?? 'empty page' });
      return { ok: false, error: page.error ?? 'empty page' };
    }
    const hit = dossier.hits.find((h) => h.url === url) ?? { title: page.title, url, snippet: '' };
    const source = makeSourceRecord(hit, { url: page.url || url, title: page.title || hit.title, text: page.text }, this.limits.excerptMaxChars, this.now());
    dossier.sources.push(source);
    this.emit('RESEARCH_SOURCE_INSPECTED', taskId, {
      url: source.url,
      sourceId: source.id,
      domain: source.domain,
      tier: source.tier,
      quality: source.quality,
      failed: false,
      durationMs: this.now() - started,
    });
    return { ok: true, sourceId: source.id };
  }

  /** research.extract_evidence — evidence for the sub-questions from one source
   *  (or all sources when no sourceId is given). */
  extractEvidence(
    taskId: string,
    sourceId?: string
  ): { added: number; total: number } {
    const dossier = this.dossiers.get(taskId);
    if (!dossier) return { added: 0, total: 0 };
    const targets = sourceId ? dossier.sources.filter((s) => s.id === sourceId) : dossier.sources;
    let added = 0;
    for (const source of targets) {
      for (const sub of dossier.subQuestions) {
        const extracted = extractEvidenceFromSource(source, sub, {
          maxPerSource: this.limits.maxEvidencePerSource,
          quoteMaxChars: this.limits.quoteMaxChars,
        });
        const { merged, added: newItems } = mergeEvidence(dossier.evidence, extracted, this.limits.maxEvidencePerSubQuestion);
        dossier.evidence = merged;
        added += newItems.length;
      }
    }
    if (added > 0) {
      this.emit('RESEARCH_EVIDENCE_EXTRACTED', taskId, { added, total: dossier.evidence.length, sourceId: sourceId ?? 'all' });
    }
    return { added, total: dossier.evidence.length };
  }

  /** research.analyze — conflicts + verdicts + gaps for the current evidence. */
  analyze(taskId: string): { conflicts: number; gaps: ResearchGap[]; verdicts: Record<string, string> } {
    const dossier = this.dossiers.get(taskId);
    if (!dossier) return { conflicts: 0, gaps: [], verdicts: {} };

    dossier.conflicts = detectConflicts(dossier.subQuestions, dossier.evidence, dossier.sources, this.limits.maxConflicts);
    dossier.assessments = assessAll(dossier.subQuestions, dossier.evidence, dossier.sources, dossier.conflicts);
    const domainsBySub = new Map<string, number>();
    for (const sub of dossier.subQuestions) {
      const domains = new Set(
        dossier.evidence
          .filter((e) => e.subQuestionId === sub.id)
          .map((e) => registrableDomain(dossier.sources.find((s) => s.id === e.sourceId)?.url ?? ''))
          .filter(Boolean)
      );
      domainsBySub.set(sub.id, domains.size);
    }
    dossier.gaps = detectGaps({
      subQuestions: dossier.subQuestions,
      evidence: dossier.evidence,
      distinctDomainsBySubQuestion: domainsBySub,
      conflictingSubQuestionIds: new Set(dossier.conflicts.map((c) => c.subQuestionId)),
    });

    const verdicts: Record<string, string> = {};
    for (const a of dossier.assessments) verdicts[a.subQuestionId] = a.verdict;
    this.emit('RESEARCH_ANALYSIS_COMPLETED', taskId, {
      conflicts: dossier.conflicts.length,
      gaps: dossier.gaps.length,
      verdicts,
    });
    return { conflicts: dossier.conflicts.length, gaps: dossier.gaps, verdicts };
  }

  /** research.synthesize — final structured report (local, deterministic). */
  synthesize(taskId: string): { report?: ResearchReport; summary?: string; error?: string } {
    const dossier = this.dossiers.get(taskId);
    if (!dossier) return { error: 'no active research dossier for this task — use research.plan first' };
    if (dossier.assessments.length === 0) this.analyze(taskId);
    const report = buildReport(dossier);
    report.generatedAt = this.now();
    dossier.report = report;
    dossier.citations = report.citations;
    dossier.finishedAt = dossier.finishedAt ?? this.now();
    const summary = renderReport(report, this.limits.reportMaxChars);
    this.emit(
      confidenceIsLow(report) ? 'RESEARCH_INSUFFICIENT_EVIDENCE' : 'RESEARCH_COMPLETED',
      taskId,
      { confidence: report.confidence, sources: report.citations.length, openQuestions: report.openQuestions.length }
    );
    this.multimodal?.addText(clampText(summary, 2_000), 'phase16.research');
    return { report, summary };
  }

  // -------------------------------------------------------------- main loop

  /**
   * Full bounded research run for one task. Round 1 searches the planned
   * queries; later rounds chase detected gaps with fresh follow-up queries
   * until coverage is reached or a budget ends the run honestly.
   */
  async runResearch(taskId: string, goal: string, signal: AbortSignal, userRequest?: string): Promise<ResearchReport> {
    const deadline = this.now() + this.limits.maxDurationMs;
    this.emit('RESEARCH_STARTED', taskId, { goal: clampText(goal, 160) });

    this.plan(taskId, goal);
    const dossier = this.dossiers.get(taskId)!;
    dossier.roundsUsed = 0;

    for (let round = 1; round <= this.limits.maxRounds; round++) {
      if (signal.aborted || this.now() >= deadline) break;

      let queriesForRound: string[];
      if (round === 1) {
        queriesForRound = dossier.queries.filter((q) => q.status === 'pending').map((q) => q.text);
      } else {
        const used = new Set(dossier.queries.map((q) => q.norm));
        const gaps = dossier.gaps.length > 0
          ? dossier.gaps
          : (() => {
              this.analyze(taskId);
              return this.dossiers.get(taskId)!.gaps;
            })();
        queriesForRound = followUpQueries(gaps, used, this.limits.maxQueriesPerRound);
        for (const q of queriesForRound) {
          dossier.queries.push({ text: q, norm: queryNorm(q), round, status: 'pending' });
        }
        if (queriesForRound.length > 0) {
          this.emit('RESEARCH_FOLLOWUP_QUEUED', taskId, { round, queries: queriesForRound });
        }
      }
      if (queriesForRound.length === 0) break;

      dossier.roundsUsed = round;
      let inspectedThisRound = 0;

      for (const query of queriesForRound) {
        if (signal.aborted || this.now() >= deadline) break;
        if (dossier.searchesUsed >= this.limits.maxSearches) break;
        if (dossier.sources.length >= this.limits.maxSources) break;

        const searchResult = await this.exec(SEARCH_TOOL, taskId, { query }, signal, userRequest);
        if (searchResult.cancelled) break;
        if (!searchResult.ok) continue;

        // Candidate selection: un-inspected URLs, domain-diversified, bounded.
        const inspected = new Set(dossier.sources.map((s) => s.url));
        const domainsThisRun = new Map<string, number>();
        for (const s of dossier.sources) {
          const d = registrableDomain(s.url);
          domainsThisRun.set(d, (domainsThisRun.get(d) ?? 0) + 1);
        }
        const candidates = dossier.hits
          .filter((h) => !inspected.has(h.url))
          .filter((h) => (domainsThisRun.get(registrableDomain(h.url)) ?? 0) < 2)
          .slice(0, this.limits.maxHitsKept);

        for (const hit of candidates) {
          if (signal.aborted || this.now() >= deadline) break;
          if (dossier.sources.length >= this.limits.maxSources) break;
          const read = await this.exec(READ_TOOL, taskId, { url: hit.url }, signal, userRequest);
          if (read.cancelled) break;
          if (!read.ok) continue;
          inspectedThisRound++;

          await this.exec(EXTRACT_TOOL, taskId, { sourceId: read.result.output && (read.result.output as any).sourceId }, signal, userRequest);
        }
      }

      const analysis = await this.exec(ANALYZE_TOOL, taskId, {}, signal, userRequest);
      if (analysis.cancelled) break;

      const gapsAfter = (analysis.result.output as { gaps?: ResearchGap[] } | undefined)?.gaps ?? [];
      const blockingGaps = gapsAfter.filter((g) => g.kind !== 'missing_aspect').length;
      this.emit('RESEARCH_ROUND_COMPLETED', taskId, {
        round,
        sources: dossier.sources.length,
        evidence: dossier.evidence.length,
        openGaps: gapsAfter.length,
      });
      // Round 2+ runs only when real coverage gaps remain (never for a missing
      // aspect alone — that is disclosed honestly instead of chased forever).
      if (blockingGaps === 0) break;
      if (dossier.searchesUsed >= this.limits.maxSearches || dossier.sources.length >= this.limits.maxSources) break;
    }

    const synthesis = await this.exec(SYNTHESIZE_TOOL, taskId, {}, signal, userRequest);
    if (signal.aborted || synthesis.cancelled) {
      this.emit('RESEARCH_FAILED', taskId, { reason: 'cancelled' });
      throw new DOMException('Research cancelled', 'AbortError');
    }
    const output = (synthesis.result.output ?? {}) as { report?: ResearchReport; summary?: string };
    if (!output.report) {
      this.emit('RESEARCH_FAILED', taskId, { reason: synthesis.result.error ?? 'synthesis failed' });
      throw new Error(output.summary ?? synthesis.result.error ?? 'Research synthesis failed');
    }
    return output.report;
  }
}

function confidenceIsLow(report: ResearchReport): boolean {
  return report.confidence === 'low';
}
