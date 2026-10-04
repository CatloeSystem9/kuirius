/**
 * Deep Research Intelligence (additional capability — outside the numbered
 * roadmap) — research tools (Phase 3 contract).
 *
 * Thin AgentTool wrappers over the ResearchService. Every concrete research
 * capability is a first-class registry tool so the Agent Core, Permission
 * Manager, event bus, recovery and learning all see exactly what happens.
 * The `research.run` orchestrator drives the full bounded loop through the
 * individual tools below — it never bypasses the registry.
 *
 * Permission model: network-touching tools (search / read_source / run) are
 * gated by the existing 'browser.interaction' domain (granted by default,
 * revocable); local analysis tools need no permission — they read only the
 * task's own dossier.
 */
import type { AgentTool } from '../types';
import type { ResearchService } from './researchService';

export function createResearchTools(service: ResearchService): AgentTool[] {
  return [
    {
      name: 'research.plan',
      description: 'Decompose a research goal into bounded sub-questions and initial search queries (deterministic, no network).',
      category: 'web',
      riskLevel: 'safe',
      cost: 'cheap',
      reliability: 0.95,
      capabilities: ['research.plan'],
      permissions: [],
      inputSchema: { required: ['goal'], types: { goal: 'string' } },
      verification: { strategy: 'self_reported', description: 'The plan is derived deterministically; sub-questions and queries are returned.' },
      timeoutMs: 5_000,
      async execute(input, ctx): Promise<any> {
        const plan = service.plan(ctx.taskId, String(input.goal ?? ctx.userRequest ?? ''));
        return {
          success: plan.subQuestions.length > 0,
          error: plan.subQuestions.length === 0 ? 'Could not derive a research question from the goal' : undefined,
          output: {
            summary: `Research plan: ${plan.subQuestions.length} sub-question(s), ${plan.queries.length} initial query(ies).`,
            question: plan.question,
            subQuestions: plan.subQuestions,
            queries: plan.queries,
          },
        };
      },
    },
    {
      name: 'research.search',
      description: 'Run one web search for the research task and record the results (deduplicated, bounded).',
      category: 'web',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.8,
      capabilities: ['research.search', 'web.research'],
      permissions: ['browser.interaction'],
      inputSchema: { required: ['query'], types: { query: 'string' } },
      verification: { strategy: 'self_reported', description: 'Hits are real backend results; failures are reported honestly per query.' },
      timeoutMs: 30_000,
      async execute(input, ctx): Promise<any> {
        const r = await service.search(ctx.taskId, String(input.query ?? ''), ctx.signal);
        return r.ok
          ? { success: true, output: { summary: `Search "${String(input.query).slice(0, 60)}" → ${r.hits} new result(s).`, hits: r.hits } }
          : { success: false, error: r.error ?? 'search failed', errorKind: 'execution_error', retryable: true };
      },
    },
    {
      name: 'research.read_source',
      description: 'Inspect one web source: fetch it through the local server, extract bounded readable text and quality signals.',
      category: 'web',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.8,
      capabilities: ['research.read_source'],
      permissions: ['browser.interaction'],
      inputSchema: { required: ['url'], types: { url: 'string' } },
      verification: { strategy: 'self_reported', description: 'Source records carry the fetched text excerpt; failed fetches are disclosed.' },
      timeoutMs: 30_000,
      async execute(input, ctx): Promise<any> {
        const r = await service.readSource(ctx.taskId, String(input.url ?? ''), ctx.signal);
        if (!r.ok) {
          return { success: false, error: r.error ?? 'fetch failed', errorKind: 'not_found', retryable: true };
        }
        const dossier = service.dossierFor(ctx.taskId);
        const source = dossier?.sources.find((s) => s.id === r.sourceId);
        return {
          success: true,
          output: {
            summary: `Inspected ${source?.domain ?? 'source'} (${source?.tier ?? 'unknown'} tier, quality ${source?.quality ?? '?'}).`,
            sourceId: r.sourceId,
            domain: source?.domain,
            tier: source?.tier,
            quality: source?.quality,
          },
        };
      },
    },
    {
      name: 'research.extract_evidence',
      description: 'Extract relevant verbatim evidence quotes for the research sub-questions from inspected sources.',
      category: 'web',
      riskLevel: 'safe',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['research.extract_evidence'],
      permissions: [],
      inputSchema: { optional: ['sourceId'], types: { sourceId: 'string' } },
      verification: { strategy: 'self_reported', description: 'Quotes are verbatim sentences with relevance scores — never paraphrased.' },
      timeoutMs: 10_000,
      async execute(input, ctx): Promise<any> {
        const r = service.extractEvidence(ctx.taskId, input.sourceId ? String(input.sourceId) : undefined);
        const dossier = service.dossierFor(ctx.taskId);
        if (!dossier) {
          return { success: false, error: 'no active research dossier for this task — use research.plan first', errorKind: 'invalid_input', retryable: false };
        }
        return {
          success: true,
          output: { summary: `Extracted ${r.added} new evidence quote(s); ${r.total} total.`, added: r.added, total: r.total },
        };
      },
    },
    {
      name: 'research.analyze',
      description: 'Analyze the collected research evidence: cross-source conflicts, per-sub-question verdicts, and coverage gaps.',
      category: 'web',
      riskLevel: 'safe',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['research.analyze'],
      permissions: [],
      inputSchema: {},
      verification: { strategy: 'self_reported', description: 'Verdicts distinguish supported / single-source / conflicting / unverified evidence.' },
      timeoutMs: 10_000,
      async execute(_input, ctx): Promise<any> {
        const dossier = service.dossierFor(ctx.taskId);
        if (!dossier) {
          return { success: false, error: 'no active research dossier for this task — use research.plan first', errorKind: 'invalid_input', retryable: false };
        }
        const r = service.analyze(ctx.taskId);
        return {
          success: true,
          output: {
            summary: `Analysis: ${r.conflicts} conflict(s), ${r.gaps.length} gap(s).`,
            conflicts: r.conflicts,
            gaps: r.gaps,
            verdicts: r.verdicts,
          },
        };
      },
    },
    {
      name: 'research.synthesize',
      description: 'Synthesize the structured research report: findings with citations, conflicts, open questions, limitations, confidence.',
      category: 'web',
      riskLevel: 'safe',
      cost: 'cheap',
      reliability: 0.95,
      capabilities: ['research.synthesize'],
      permissions: [],
      inputSchema: {},
      verification: { strategy: 'self_reported', description: 'Every factual statement cites inspected sources; confidence reflects support counts.' },
      timeoutMs: 10_000,
      async execute(_input, ctx): Promise<any> {
        const r = service.synthesize(ctx.taskId);
        if (r.error || !r.report) {
          return { success: false, error: r.error ?? 'synthesis failed', errorKind: 'invalid_input', retryable: false };
        }
        return {
          success: true,
          output: {
            summary: r.summary,
            report: r.report,
            confidence: r.report.confidence,
          },
        };
      },
    },
    {
      name: 'research.run',
      description: 'Run a complete bounded deep-research task: plan sub-questions, search the web across rounds, inspect and cross-check sources, and produce a cited report. Requires the full research goal.',
      category: 'web',
      riskLevel: 'low',
      cost: 'moderate',
      reliability: 0.75,
      capabilities: ['research.run', 'research.autonomous'],
      permissions: ['browser.interaction'],
      inputSchema: { required: ['goal'], types: { goal: 'string' } },
      verification: {
        strategy: 'state_check',
        description: 'The report is built only from inspected sources with per-finding verdicts; low evidence yields an honest low-confidence report.',
      },
      timeoutMs: 150_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, ctx): Promise<any> {
        const goal = String(input.goal ?? ctx.userRequest ?? '').trim();
        if (!goal) {
          return { success: false, error: 'research.run requires a goal (input.goal or the original user request)', errorKind: 'invalid_input', retryable: false };
        }
        try {
          const report = await service.runResearch(ctx.taskId, goal, ctx.signal, ctx.userRequest);
          const summary = service.synthesize(ctx.taskId).summary ?? '';
          return {
            success: true,
            output: {
              summary,
              report,
              confidence: report.confidence,
              sources: report.citations.length,
            },
          };
        } catch (err: any) {
          if (ctx.signal.aborted || err?.name === 'AbortError') {
            return { success: false, error: 'Research cancelled', errorKind: 'cancelled', retryable: false };
          }
          return { success: false, error: String(err?.message || err), errorKind: 'execution_error', retryable: false };
        }
      },
    },
  ];
}
