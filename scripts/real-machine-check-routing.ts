/**
 * Real-machine verification — official Phase 17: Model Routing + Performance.
 * Usage: npx tsx scripts/real-machine-check-routing.ts   (needs the local server)
 *
 * Lightweight and provider-friendly (max TWO real chat calls):
 *   1. model registry loads from the repo's configured models
 *   2. router decisions: simple task → light path, complex task → strong path
 *   3. escalation + fallback (decision-only, no provider calls)
 *   4. real /api/chat route metadata: simple task uses the lightweight route
 *   5. real /api/chat complex task routes to the strong path
 *   6. /api/health exposes the passive performance snapshot; counters do NOT
 *      grow on their own (no background telemetry/polling)
 *   7. Phase 16 planning stays functional on the real machine (read-only task)
 *   8. Deep Research stays functional (plan step, no network spam)
 */
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { PlanEngine } from '../src/agent/planning';
import {
  createDefaultModelRegistry,
  ModelRouter,
  createRoutingTools,
  getPerformanceTelemetry,
  CachedClassifier,
  type RouteDecision,
} from '../src/agent/routing';
import { FilesystemService, ApplicationService } from '../src/agent/system/systemServices';
import { HttpFsBackend, HttpAppBackend, setSystemBackendBaseUrl } from '../src/agent/system/httpSystem';
import { createSystemTools } from '../src/agent/system/systemTools';
import { ResearchService } from '../src/agent/research';
import type { PlanStep } from '../src/agent/types';

const BASE = 'http://localhost:3000';
setSystemBackendBaseUrl(BASE);

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

  // 1. Registry loads.
  console.log('\n[1] model registry');
  const registry = createDefaultModelRegistry();
  check(registry.count() >= 4, `registry loaded with ${registry.count()} configured model profiles`);
  check(registry.byTier('light').length >= 1 && registry.byTier('strong').length >= 1, 'light and strong tiers populated');

  // 2+3. Router decisions (no provider calls).
  console.log('\n[2+3] routing decisions, escalation, fallback');
  const router = new ModelRouter(registry, getPerformanceTelemetry());
  const simple: RouteDecision = router.route({ text: 'hi' });
  check(simple.tier === 'light' && simple.model === 'gemini-3.1-flash-lite', `simple task → lightweight path (${simple.model})`);
  const complex: RouteDecision = router.route({
    text: 'research why the scheduler fails, analyze the algorithm trade-offs, and design a step-by-step fix',
  });
  check(complex.tier === 'strong' && complex.model === 'gemini-3.8-flash', `complex task → strong path (${complex.model})`);
  check(simple.orderedModels.length === registry.count(), 'waterfall keeps every configured model behind the route');
  const esc = router.escalate(simple, 'verification inadequate');
  check(esc !== null && esc.tier === 'balanced', 'escalation moves up one tier (bounded)');
  const fb = router.fallbackFrom('gemini-3.8-flash', 'rate_limit', { markFailedTtlMs: 5_000 });
  check(fb !== null && fb.model !== 'gemini-3.8-flash', `fallback skips the failed model (${fb?.model})`);
  registry.clearUnavailable();

  // 4+5. Real chat routing (TWO calls total — no provider spam).
  console.log('\n[4+5] real /api/chat routing');
  const chat = async (message: string) => {
    const r = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, messages: [{ role: 'user', content: message }] }),
    });
    return (await r.json()) as { reply?: string; route?: { complexity: string; tier: string; preferred: string; used?: string; orderedModels?: string[] } };
  };
  const simpleChat = await chat('hi');
  check(simpleChat.reply !== undefined, 'simple chat answered (model or in-character local fallback)');
  check(simpleChat.route?.complexity === 'TRIVIAL' && simpleChat.route?.tier === 'light', `simple task routed lightweight (complexity ${simpleChat.route?.complexity}, tier ${simpleChat.route?.tier})`);
  const complexChat = await chat(
    'Research why distributed schedulers fail, analyze the trade-offs of their algorithms, and design a step-by-step remediation plan with verification.'
  );
  check(complexChat.route?.complexity === 'COMPLEX' || complexChat.route?.complexity === 'HIGH_COMPLEXITY', `complex task classified ${complexChat.route?.complexity}`);
  check(complexChat.route?.preferred === 'gemini-3.8-flash', 'complex task routed to the strong path');
  check((complexChat.route?.orderedModels?.length ?? 0) === 4, 'full fallback waterfall preserved behind the route');

  // 6. Health perf snapshot + no background growth.
  console.log('\n[6] telemetry — passive, no polling');
  const health1 = (await (await fetch(`${BASE}/api/health`)).json()) as { status: string; perf?: { counters: { routes: number } } };
  check(health1.status === 'ok' && health1.perf?.counters !== undefined, 'health exposes the performance snapshot');
  const routesAfterChats = health1.perf!.counters.routes;
  await new Promise((r) => setTimeout(r, 1_200));
  const health2 = (await (await fetch(`${BASE}/api/health`)).json()) as { perf?: { counters: { routes: number } } };
  check(health2.perf!.counters.routes === routesAfterChats, 'counters do NOT grow on their own (no background telemetry/polling)');

  // 7. Phase 16 planning functional on the real machine (read-only).
  console.log('\n[7] Phase 16 planning still functional');
  const bus = new AgentEventBus();
  const registry2 = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  const fs = new FilesystemService({ fs: new HttpFsBackend(), events: bus });
  const apps = new ApplicationService({ fs: new HttpFsBackend(), apps: new HttpAppBackend(), events: bus });
  registry2.registerAll(createSystemTools(fs, apps));
  const planning = new PlanEngine({ registry: registry2, events: bus, permissions });
  const core = new AgentCore({ registry: registry2, events: bus, store: new TaskStore(new MemoryStorage()), permissions, planning, stepTimeoutMs: 30_000, maxAttemptsPerStep: 1 });
  const steps: PlanStep[] = [
    { id: 'p1', description: 'List the working directory', toolName: 'filesystem.list', capability: 'filesystem.list', input: { path: '.' }, status: 'pending', attempts: 0 },
  ];
  Object.defineProperty(core, 'planner', {
    value: { makePlan: () => ({ goal: { description: 'list files', rawInput: 'list files', kind: 'command' as const }, steps, createdAt: Date.now(), revision: 1 }), proposeAlternative: () => null },
    configurable: true,
  });
  const task = await core.submit('list files');
  check(task.status === 'completed' && bus.recentEvents().some((e) => e.name === 'PLAN_COMPLETED'), 'planned real task completed with PLAN_COMPLETED');

  // 8. Deep Research functional (plan only — no network spam).
  console.log('\n[8] Deep Research still functional');
  const researchRegistry = new ToolRegistry(new AgentEventBus());
  const research = new ResearchService({
    backend: { search: async () => ({ hits: [] }), fetchPage: async (url) => ({ url, title: '', text: '', error: 'unused' }) },
    registry: researchRegistry,
    limits: { maxRounds: 1, maxSearches: 1 },
  });
  researchRegistry.registerAll(createRoutingTools(router, new CachedClassifier(), getPerformanceTelemetry()));
  // Import the research tools lazily to avoid a circular import in this script.
  const { createResearchTools } = await import('../src/agent/research');
  researchRegistry.registerAll(createResearchTools(research));
  const plan = research.plan('rm-check', 'research photosynthesis');
  check(plan.subQuestions.length >= 1 && plan.queries.length >= 1, `research planning intact (${plan.subQuestions.length} sub-questions)`);
  check(researchRegistry.get('model.route') !== undefined && researchRegistry.get('research.run') !== undefined, 'routing and research tools coexist in one registry');

  console.log(`\nReal-machine check: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exit(1);
  console.log('PHASE 17 (MODEL ROUTING + PERFORMANCE) REAL-MACHINE VERIFICATION: PASS');
}

main().catch((err) => {
  console.error('real-machine check failed:', err);
  process.exit(1);
});
