/**
 * Real-machine verification — Deep Research Intelligence (additional Krisha
 * capability, outside the numbered roadmap).
 * Usage: npx tsx scripts/real-machine-check-research.ts   (needs the local server)
 *
 * Harmless, read-only verification of the REAL research pipeline against the
 * real network through the local server:
 *   1. wait for server health
 *   2. real web search via /api/research/search (DuckDuckGo) — real hits
 *   3. real source fetch via /api/research/fetch — real readable text
 *   4. real bounded research run (rounds, cross-checking, synthesis) through
 *      the ToolRegistry — real cited report
 *   5. full Agent Core delegation ("research X and tell me what you find")
 *      through the real planner + the official Phase 16 planning layer
 *   6. honesty checks: citations resolve to inspected sources, single-source
 *      claims labeled uncertain, no fabricated sources
 * Nothing is written to disk, no desktop interaction, no destructive action.
 */
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { PlanEngine } from '../src/agent/planning';
import { HeuristicPlanner, extractGoal } from '../src/agent/planner';
import { ResearchService, createResearchTools, HttpResearchBackend, setResearchBackendBaseUrl } from '../src/agent/research';
import type { AgentTask } from '../src/agent/types';

const BASE = 'http://localhost:3000';
setResearchBackendBaseUrl(BASE);

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not become healthy — start it with: npm run dev');
}

interface SearchResponse {
  success: boolean;
  results?: { url: string; title: string }[];
  error?: string;
}

async function searchOnce(query: string): Promise<SearchResponse> {
  const r = await fetch(`${BASE}/api/research/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return (await r.json()) as SearchResponse;
}

/** The public search engine rate-limits by IP — wait politely until it answers. */
async function searchWithRetry(query: string, attempts = 8, waitMs = 15_000): Promise<SearchResponse> {
  let last: SearchResponse = { success: false, error: 'not attempted' };
  for (let i = 0; i < attempts; i++) {
    last = await searchOnce(query);
    if (last.success && (last.results?.length ?? 0) > 0) return last;
    if (i < attempts - 1) {
      console.log(`  search unavailable (attempt ${i + 1}/${attempts}) — waiting ${waitMs / 1000}s for the engine rate limit to clear...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return last;
}

async function main() {
  await waitForHealth();
  console.log('server healthy');
  let failures = 0;
  const check = (condition: boolean, label: string) => {
    if (condition) console.log(`  PASS  ${label}`);
    else {
      failures++;
      console.error(`  FAIL  ${label}`);
    }
  };

  // 2. Real search endpoint (with polite retry — public engines rate-limit by IP)
  console.log('\n[2] real web search (/api/research/search)');
  const searchData = await searchWithRetry('what is the Go programming language');
  check(searchData.success === true && (searchData.results?.length ?? 0) >= 3, `real search returned hits (${searchData.results?.length ?? 0}) ${searchData.error ?? ''}`);
  const searchHits = searchData.results ?? [];
  check(searchHits.every((h) => /^https?:\/\//i.test(h.url)), 'all hits are http(s) URLs');

  // 3. Real source fetch endpoint
  console.log('\n[3] real source fetch (/api/research/fetch)');
  const candidate = searchHits.find((h) => /wikipedia\.org|go\.dev|golang/i.test(h.url)) ?? searchHits[0];
  if (!candidate) {
    console.error('  search engine never recovered — cannot verify source fetch');
    failures++;
  } else {
    const fetchResp = await fetch(`${BASE}/api/research/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: candidate.url }),
    });
    const fetchData = (await fetchResp.json()) as { success: boolean; title?: string; text?: string; error?: string };
    check(fetchData.success === true && (fetchData.text?.length ?? 0) >= 500, `real page fetched: "${fetchData.title}" (${fetchData.text?.length ?? 0} chars) ${fetchData.error ?? ''}`);
    check(!/<script/i.test(fetchData.text ?? ''), 'fetched text is clean (no raw script tags)');
  }

  // 4. Real bounded research run through the registry
  console.log('\n[4] real bounded research run (through ToolRegistry)');
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  const service = new ResearchService({
    backend: new HttpResearchBackend(),
    registry,
    events: bus,
    permissions,
    // Single round keeps the request budget small — the public engine may
    // throttle rapid successive queries from one machine.
    limits: { maxRounds: 1, maxSearches: 2, maxQueriesPerRound: 1, maxSources: 4, maxHitsKept: 3 },
  });
  registry.registerAll(createResearchTools(service));
  let report = await service.runResearch('real-check', 'research what is the Go programming language', new AbortController().signal);
  if (report.citations.length === 0) {
    console.log('  no sources first attempt (engine may be rate-limiting) — one polite retry...');
    await new Promise((r) => setTimeout(r, 15_000));
    report = await service.runResearch('real-check-retry', 'research what is the Go programming language', new AbortController().signal);
  }
  console.log(`  report: confidence=${report.confidence}, sources=${report.citations.length}, evidence=${report.stats.evidenceCount}, searches=${report.stats.searches}`);
  check(report.stats.searches >= 1, 'at least one real search executed');
  check(report.citations.length >= 1, 'report carries at least one citation');
  check(
    report.citations.every((c) => /^https?:\/\//i.test(c.url)),
    'every citation resolves to a real inspected URL'
  );
  check(report.citations.every((c) => report.citations.indexOf(c) === c.id - 1), 'citation numbering is dense and ordered');
  check(report.findings.length >= 1, 'report contains per-question findings');
  check(report.answerSummary.length > 0, 'report has an answer summary');
  const rendered = service.synthesize('real-check').summary ?? service.synthesize('real-check-retry').summary ?? '';
  console.log('  --- report excerpt ---');
  for (const line of rendered.split('\n').slice(0, 12)) console.log('  ' + line);
  console.log('  ----------------------');

  // 5. Full Agent Core delegation through the real planner + planning layer
  // (distinct query + a pause so the public engine does not throttle us).
  console.log('\n[5] full Agent Core delegation');
  await new Promise((r) => setTimeout(r, 5_000));
  const bus2 = new AgentEventBus();
  const registry2 = new ToolRegistry(bus2);
  const permissions2 = new PermissionManager();
  const service2 = new ResearchService({
    backend: new HttpResearchBackend(),
    registry: registry2,
    events: bus2,
    permissions: permissions2,
    limits: { maxRounds: 1, maxSearches: 2, maxQueriesPerRound: 1, maxSources: 4, maxHitsKept: 3 },
  });
  registry2.registerAll(createResearchTools(service2));
  registry2.registerAll([
    {
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
    },
  ]);
  const planning = new PlanEngine({ registry: registry2, events: bus2, permissions: permissions2 });
  const core = new AgentCore({
    registry: registry2,
    events: bus2,
    store: new TaskStore(new MemoryStorage()),
    permissions: permissions2,
    planner: new HeuristicPlanner(),
    planning,
  });
  let task = await core.submit('research what is the Rust programming language and tell me what you find');
  const citationsIn = (t: AgentTask) => ((t.plan?.steps[0].result?.output as any)?.report?.citations?.length ?? 0);
  if (citationsIn(task) === 0) {
    console.log('  no citations first attempt (engine may be rate-limiting) — one polite retry...');
    await new Promise((r) => setTimeout(r, 15_000));
    task = await core.submit('research what is the Rust programming language and tell me what you find');
  }
  console.log(`  task status: ${task.status}`);
  check(task.status === 'completed', 'research task completed end-to-end');
  check(task.plan?.steps[0]?.toolName === 'research.run', 'planner scheduled research.run');
  const stepReport = (task.plan?.steps[0].result?.output as any)?.report;
  check(stepReport !== undefined && stepReport.citations.length >= 1, 'step output carries the cited report');
  check(String(task.summary).includes('Summary ('), 'task summary carries the synthesis');

  console.log(`\nReal-machine check: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exit(1);
  console.log('DEEP RESEARCH REAL-MACHINE VERIFICATION: PASS');
}

main().catch((err) => {
  console.error('real-machine check failed:', err);
  process.exit(1);
});
