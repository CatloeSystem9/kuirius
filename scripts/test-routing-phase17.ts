/**
 * Phase 17 verification suite — Model Routing + Performance.
 * Usage: npx tsx scripts/test-routing-phase17.ts
 *
 * Deterministic: fake clocks, injected registries, no network, no real
 * models. The router is decision-only, so nothing here can bypass safety.
 */
import {
  classifyTask,
  recommendedTimeoutMs,
  createDefaultModelRegistry,
  tierForModelName,
  ModelRegistry,
  resolveRequirements,
  requirementsForCapability,
  satisfiesRequirements,
  ModelRouter,
  BoundedCache,
  hashKey,
  RequestCoalescer,
  PerformanceTelemetry,
  CachedClassifier,
  createRoutingTools,
  type ModelProfile,
} from '../src/agent/routing';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { PlanEngine } from '../src/agent/planning';
import { createSystemNoteTool } from '../src/agent/system/systemTools';
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
  if (actual === expected) passed++;
  else {
    failed++;
    failures.push(`${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    console.error(`  ✗ ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

let CLOCK = 1_000_000;
const now = () => CLOCK;
const tick = (ms: number) => { CLOCK += ms; };

// =================================================================
// 1. Classification — deterministic, all five tiers
// =================================================================
{
  console.log('Classification — trivial → high complexity, timeout guidance');
  const trivial = classifyTask({ text: 'hi' });
  assertEqual(trivial.tier, 'TRIVIAL', 'greeting → TRIVIAL');
  assertEqual(trivial.score, 0, 'greeting scores zero (never escalates)');

  assertEqual(classifyTask({ text: 'thanks!'}).tier, 'TRIVIAL', 'thanks → TRIVIAL');
  assertEqual(classifyTask({ text: 'open chrome' }).tier, 'SIMPLE', 'single imperative → SIMPLE');
  assertEqual(
    classifyTask({ text: 'open chrome and search for krisha ai on google and summarize the results' }).tier,
    'MODERATE',
    'compound browser task → MODERATE'
  );
  const complex = classifyTask({
    text: 'research the trade-offs of event-driven architectures, analyze why queueing delays happen, ' +
      'and write a step-by-step plan to implement a refactor of the scheduler algorithm',
  });
  assert(complex.tier === 'COMPLEX' || complex.tier === 'HIGH_COMPLEXITY', `research+reasoning → COMPLEX/HIGH (got ${complex.tier})`);
  const high = classifyTask({
    text: 'look at my screen and analyze the visible error dialog, then research why this application crashes, ' +
      'compare the pros and cons of every fix strategy, verify the root cause step by step, then design and implement ' +
      'the refactor across the algorithm and window handling, and make sure to confirm everything works',
    contextChars: 120_000,
  });
  assertEqual(high.tier, 'HIGH_COMPLEXITY', 'multi-domain + verification + large context → HIGH_COMPLEXITY');

  assertEqual(recommendedTimeoutMs('TRIVIAL'), 8_000, 'TRIVIAL timeout 8s');
  assertEqual(recommendedTimeoutMs('HIGH_COMPLEXITY'), 120_000, 'HIGH timeout 120s');
  assert(recommendedTimeoutMs('MODERATE') < recommendedTimeoutMs('COMPLEX'), 'timeouts scale with complexity');

  // Determinism: same input → same output.
  const a = classifyTask({ text: 'research quantum error correction and compare the approaches' });
  const b = classifyTask({ text: 'research quantum error correction and compare the approaches' });
  assertEqual(a.tier, b.tier, 'classification is deterministic');
}

// =================================================================
// 2. Model registry + capability profiles
// =================================================================
{
  console.log('Model registry — profiles from repo config, availability, tiers');
  const registry = createDefaultModelRegistry(now);
  assertEqual(registry.count(), 4, 'registry seeded with the 4 configured chat models');
  assertEqual(tierForModelName('gemini-3.1-flash-lite'), 'light', 'lite → light tier');
  assertEqual(tierForModelName('gemini-3.8-flash'), 'strong', '3.8 → strong tier');
  assertEqual(tierForModelName('gemini-flash-latest'), 'balanced', 'latest → balanced tier');

  const light = registry.byTier('light', now());
  assertEqual(light[0].id, 'gemini-3.1-flash-lite', 'light tier has the lite model first (cheapest)');
  assert(light[0].relativeCost < registry.byTier('strong', now())[0].relativeCost, 'light costs less than strong');
  assert(light[0].capabilities.vision === true, 'configured flash models are vision-capable (repo fact)');

  // Availability marking with TTL expiry.
  registry.markUnavailable('gemini-3.1-flash-lite', 5_000, now());
  assert(!registry.isAvailable('gemini-3.1-flash-lite', now()), 'marked model unavailable');
  assertEqual(registry.byTier('light', now()).length, 0, 'light tier empty while model unavailable');
  tick(6_000);
  assert(registry.isAvailable('gemini-3.1-flash-lite', now()), 'availability TTL expires (never permanent)');

  // Raw registry behavior (no default seeding).
  const raw = new ModelRegistry(now);
  raw.register({ id: 'm1', provider: 'x', tier: 'light', capabilities: { reasoning: true, coding: false, vision: false, toolUse: false, structuredOutput: true, streaming: false }, contextTokens: 32_000, relativeSpeed: 1, relativeCost: 0.1, reliability: 0.8 });
  assertEqual(raw.count(), 1, 'raw registry accepts custom profiles');
  assert(raw.get('m1') !== undefined, 'profile retrievable');
}

// =================================================================
// 3. Requirements — capability map + resolution
// =================================================================
{
  console.log('Requirements — capability map, resolution, satisfaction');
  assertEqual(requirementsForCapability('screen.observe').vision, true, 'screen.* requires vision');
  assertEqual(requirementsForCapability('browser.navigate').toolUse, true, 'browser.* requires tool use');
  assertEqual(requirementsForCapability('browser.search').webReasoning, true, 'browser.* requires web reasoning');
  assertEqual(requirementsForCapability('research.run').deepReasoning, true, 'research.* requires deep reasoning');
  assertEqual(requirementsForCapability('memory.remember').deepReasoning, undefined, 'memory.* needs nothing special');
  assertEqual(Object.keys(requirementsForCapability('unknown.capability')).length, 0, 'unknown capability → no requirements');

  const cls = classifyTask({ text: 'look at my screen' });
  const req = resolveRequirements(cls);
  assertEqual(req.vision, true, 'vision factors → vision requirement');
  assertEqual(req.deepReasoning, undefined, 'pure vision stays light (screen.* capability adds deep reasoning)');

  const profile = { capabilities: { vision: true, toolUse: true, structuredOutput: true, coding: true }, contextTokens: 1_000_000 };
  assert(satisfiesRequirements(profile, { vision: true, toolUse: true }), 'capable profile satisfies requirements');
  assert(!satisfiesRequirements({ ...profile, capabilities: { ...profile.capabilities, vision: false } }, { vision: true }), 'missing vision fails satisfaction');
  assert(!satisfiesRequirements({ ...profile, contextTokens: 8_000 }, { minContextTokens: 32_000 }), 'insufficient context fails satisfaction');
}

// =================================================================
// 4. Routing — smallest capable, floors, vision/tool routing
// =================================================================
{
  console.log('Routing — lightweight selection, complexity floors, requirements');
  const registry = createDefaultModelRegistry(now);
  const telemetry = new PerformanceTelemetry();
  const router = new ModelRouter(registry, telemetry, now);

  const trivialRoute = router.route({ text: 'hi' });
  assertEqual(trivialRoute.model, 'gemini-3.1-flash-lite', 'trivial task → lightest model');
  assertEqual(trivialRoute.orderedModels.length, 4, 'waterfall keeps the WHOLE registry behind the selection');
  assertEqual(trivialRoute.orderedModels[0], 'gemini-3.1-flash-lite', 'selected model first in the waterfall');
  assert(trivialRoute.escalationPath.length === 2, 'escalation path light → balanced → strong');
  assertEqual(trivialRoute.attempts, 0, 'no escalation on first route');
  assertEqual(trivialRoute.recommendedTimeoutMs, 8_000, 'timeout guidance matches complexity');

  const moderateRoute = router.route({ text: 'open chrome and search for krisha ai and summarize the results' });
  assert(moderateRoute.tier === 'balanced' || moderateRoute.tier === 'strong', `compound task escalates the floor (got ${moderateRoute.tier})`);

  const complexRoute = router.route({ text: 'research and analyze the algorithm, then design and implement the refactor step by step' });
  assertEqual(complexRoute.tier, 'strong', 'deep reasoning task → strong tier');
  assertEqual(complexRoute.model, 'gemini-3.8-flash', 'strong tier selects the strongest configured model');

  // Vision routing: pure vision description → smallest vision-capable model;
  // a screen.* capability additionally raises the reasoning floor.
  const visionRoute = router.route({ text: 'what am i looking at' });
  assertEqual(visionRoute.requirements.vision, true, 'vision requirement resolved from factors');
  assertEqual(visionRoute.model, 'gemini-3.1-flash-lite', 'pure vision task uses the smallest vision-capable model');

  const screenRoute = router.route({ text: 'look at my screen', hints: { capability: 'screen.observe' } });
  assertEqual(screenRoute.requirements.deepReasoning, true, 'screen.* capability → deep reasoning');
  assertEqual(screenRoute.tier, 'balanced', 'screen analysis floor → balanced tier');

  // Tool routing: browser capability raises the floor via web reasoning.
  const toolRoute = router.route({ text: 'go', hints: { capability: 'browser.navigate' } });
  assertEqual(toolRoute.requirements.webReasoning, true, 'browser capability → web reasoning');
  assertEqual(toolRoute.tier, 'balanced', 'web reasoning floor → balanced tier');

  // Unavailable light model → router moves up, never routes to nothing.
  registry.markUnavailable('gemini-3.1-flash-lite', 60_000, now());
  const reroute = router.route({ text: 'hi' });
  assert(reroute.model !== 'gemini-3.1-flash-lite', 'unavailable model never selected');
  registry.clearUnavailable();

  assertEqual(telemetry.snapshot().counters.routes, 7, 'routing decisions recorded in telemetry');
}

// =================================================================
// 5. Escalation — bounded, tracked
// =================================================================
{
  console.log('Escalation — light → balanced → strong → bounded stop');
  const registry = createDefaultModelRegistry(now);
  const telemetry = new PerformanceTelemetry();
  const router = new ModelRouter(registry, telemetry, now);

  const first = router.route({ text: 'hey' });
  assertEqual(first.tier, 'light', 'starts light');
  assertEqual(first.attempts, 0, 'successful first route: zero attempts');

  const second = router.escalate(first, 'result inadequate');
  assert(second !== null && second.tier === 'balanced', 'first escalation → balanced');
  assert(second !== null && second.attempts === 1, 'escalation attempt tracked');
  assert(second !== null && second.escalationHistory[0].from === 'gemini-3.1-flash-lite', 'escalation history records origin');

  const third = second !== null ? router.escalate(second, 'still inadequate') : null;
  assert(third !== null && third.tier === 'strong', 'second escalation → strong');
  const fourth = third !== null ? router.escalate(third, 'still inadequate') : null;
  assertEqual(fourth, null, 'escalation bounded at the top — never loops');
  assert(third !== null && third.escalationHistory.length === 2, 'full escalation history kept');
  assertEqual(telemetry.snapshot().counters.escalations, 2, 'escalations recorded in telemetry');
}

// =================================================================
// 6. Fallback — reason-aware, compatible, bounded
// =================================================================
{
  console.log('Fallback — timeout/rate limit/overflow/refusal, exhaustion');
  const registry = createDefaultModelRegistry(now);
  const telemetry = new PerformanceTelemetry();
  const router = new ModelRouter(registry, telemetry, now);

  for (const reason of ['timeout', 'rate_limit', 'unavailable', 'invalid_response', 'malformed_output', 'network', 'refusal', 'unknown'] as const) {
    const fb = router.fallbackFrom('gemini-3.8-flash', reason);
    assert(fb !== null && fb.model !== 'gemini-3.8-flash', `${reason}: fallback picks a DIFFERENT model`);
  }

  // Context overflow prefers the largest context available (here equal), then
  // cost — deterministic and documented.
  const overflow = router.fallbackFrom('gemini-3.1-flash-lite', 'context_overflow');
  assert(overflow !== null && overflow.model !== 'gemini-3.1-flash-lite', 'context overflow falls back');

  // Rate limit with TTL: the failed model becomes unavailable, fallback succeeds.
  const fb = router.fallbackFrom('gemini-3.1-flash-lite', 'rate_limit', { markFailedTtlMs: 10_000 });
  assert(fb !== null && fb.model !== 'gemini-3.1-flash-lite', 'rate-limited model skipped');
  assert(!registry.isAvailable('gemini-3.1-flash-lite', now()), 'failed model marked unavailable for the TTL');
  tick(11_000);
  assert(registry.isAvailable('gemini-3.1-flash-lite', now()), 'model returns after the TTL');

  // Exhaustion: everything unavailable → null (honest), never the same model.
  const raw = new ModelRegistry(now);
  raw.register({ id: 'a', provider: 'x', tier: 'light', capabilities: { reasoning: true, coding: true, vision: true, toolUse: true, structuredOutput: true, streaming: true }, contextTokens: 1_000_000, relativeSpeed: 1, relativeCost: 0.1, reliability: 0.9 });
  raw.register({ id: 'b', provider: 'x', tier: 'balanced', capabilities: { reasoning: true, coding: true, vision: true, toolUse: true, structuredOutput: true, streaming: true }, contextTokens: 1_000_000, relativeSpeed: 0.8, relativeCost: 0.5, reliability: 0.9 });
  const exhaustRouter = new ModelRouter(raw, undefined, now);
  raw.markUnavailable('a', 60_000, now());
  raw.markUnavailable('b', 60_000, now());
  assertEqual(exhaustRouter.fallbackFrom('a', 'timeout'), null, 'fallback exhaustion → honest null');

  // Fallback ladder excludes the failed model and keeps bounded length.
  const ladder = router.fallbackLadder('gemini-3.8-flash');
  assertEqual(ladder.length, 3, 'ladder holds every OTHER configured model');
  assert(!ladder.includes('gemini-3.8-flash'), 'failed model not in its own ladder');
  assertEqual(telemetry.snapshot().counters.fallbacks >= 8, true, 'fallbacks recorded');
}

// =================================================================
// 7. Caching — TTL/LRU, stale protection, stats
// =================================================================
{
  console.log('Caching — hit/miss/expiry/eviction/invalidation');
  const cache = new BoundedCache<string>({ maxEntries: 2, ttlMs: 1_000, now });

  assertEqual(cache.get('k'), undefined, 'miss on empty cache');
  cache.set('k', 'v1');
  assertEqual(cache.get('k'), 'v1', 'hit after set');
  tick(500);
  assertEqual(cache.get('k'), 'v1', 'within TTL → still fresh');
  tick(600);
  assertEqual(cache.get('k'), undefined, 'expired entry NEVER served (stale protection)');
  assertEqual(cache.stats().expired, 1, 'expiry counted');

  cache.set('a', '1');
  tick(1);
  cache.set('b', '2');
  tick(1);
  cache.set('c', '3'); // evicts LRU ('a' was touched most recently... a was set first, then b, then c → evict a)
  assertEqual(cache.get('a'), undefined, 'LRU eviction beyond maxEntries');
  assertEqual(cache.get('b'), '2', 'recent entries survive');
  assertEqual(cache.stats().evictions, 1, 'evictions counted');

  cache.set('b', '2-new');
  assertEqual(cache.get('b'), '2-new', 'invalidation via overwrite');
  cache.delete('b');
  assertEqual(cache.get('b'), undefined, 'invalidation via delete');

  // Hash determinism.
  assertEqual(hashKey('same input'), hashKey('same input'), 'hash deterministic');
  assert(hashKey('a') !== hashKey('b'), 'hash distinguishes inputs');
}

// =================================================================
// 8. Request coalescing — duplicate-call prevention
// =================================================================
{
  console.log('Request coalescing — identical in-flight work shared once');
  const telemetry = new PerformanceTelemetry();
  const coalescer = new RequestCoalescer<string>(telemetry);
  let executions = 0;

  const work = () =>
    coalescer.run('same-key', async () => {
      executions++;
      await new Promise((r) => setTimeout(r, 10));
      return 'result';
    });

  const [r1, r2, r3] = await Promise.all([work(), work(), work()]);
  assertEqual(executions, 1, 'three identical concurrent requests → ONE execution');
  assertEqual(r1, 'result', 'all waiters get the result');
  assertEqual(r2, 'result', 'waiter 2 satisfied');
  assertEqual(r3, 'result', 'waiter 3 satisfied');
  assertEqual(coalescer.stats().coalesced, 2, 'coalesced calls counted');

  // Distinct keys never interfere.
  const [x, y] = await Promise.all([
    coalescer.run('a', async () => 'A'),
    coalescer.run('b', async () => 'B'),
  ]);
  assertEqual(x, 'A', 'independent task A');
  assertEqual(y, 'B', 'independent task B');

  // Error propagation to all waiters; next caller starts fresh.
  const failing = () => coalescer.run('bad', async () => { throw new Error('boom'); });
  const results = await Promise.allSettled([failing(), failing()]);
  assert(results.every((r) => r.status === 'rejected'), 'errors propagate to every waiter');
  const recovered = await coalescer.run('bad', async () => 'fresh');
  assertEqual(recovered, 'fresh', 'next caller runs fresh after failure');
  assertEqual(telemetry.snapshot().counters.coalesced >= 2, true, 'coalescing recorded in telemetry');
}

// =================================================================
// 9. Telemetry — bounded, passive, snapshot shape
// =================================================================
{
  console.log('Telemetry — passive counters, bounded rings, snapshot');
  const telemetry = new PerformanceTelemetry();
  telemetry.recordRoute({ at: now(), tier: 'light', model: 'm', reason: 'r', complexity: 'TRIVIAL' });
  telemetry.recordModelCall({ at: now(), model: 'm', latencyMs: 120, ok: true, via: 'primary' });
  telemetry.recordModelCall({ at: now(), model: 'm2', latencyMs: 480, ok: true, via: 'fallback' });
  telemetry.recordToolDuration('filesystem.list', 30);
  telemetry.recordToolDuration('filesystem.list', 50);
  telemetry.recordTaskDuration(1_500);
  const snap = telemetry.snapshot();
  assertEqual(snap.counters.routes, 1, 'route counter');
  assertEqual(snap.modelCalls.avgLatencyMs, 300, 'avg model latency');
  assertEqual(snap.modelCalls.maxLatencyMs, 480, 'max model latency');
  assertEqual(snap.tasks.avgDurationMs, 1_500, 'avg task duration');
  assert(snap.tools[0].tool === 'filesystem.list', 'tool durations aggregated');

  for (let i = 0; i < 150; i++) telemetry.recordModelCall({ at: now(), model: 'm', latencyMs: 1, ok: true, via: 'primary' });
  assert(telemetry.snapshot().recent.modelCalls.length <= 20, 'recent ring bounded (no unbounded memory)');

  telemetry.reset();
  assertEqual(telemetry.snapshot().counters.routes, 0, 'reset clears counters');
}

// =================================================================
// 10. Cached classifier + routing overhead
// =================================================================
{
  console.log('Classifier cache + routing overhead measurement');
  const telemetry = new PerformanceTelemetry();
  const classifier = new CachedClassifier({ now, telemetry, ttlMs: 10_000 });
  const text = 'research the trade-offs and analyze why the scheduler algorithm behaves this way';
  const first = classifier.classify(text);
  const second = classifier.classify(text);
  assertEqual(first.tier, second.tier, 'cached classification identical');
  assertEqual(second, first, 'cached result is the same object (no recompute)');
  const stats = classifier.stats();
  assert(stats.hits >= 1 && stats.misses >= 1, `cache hit/miss recorded (${stats.hits}H/${stats.misses}M)`);
  tick(11_000);
  const third = classifier.classify(text);
  assertEqual(third.tier, first.tier, 'after TTL the value is recomputed (same answer, fresh entry)');

  // Routing overhead: classification + route must be far below model latency.
  const registry = createDefaultModelRegistry(now);
  const router = new ModelRouter(registry, undefined, now);
  const inputs = Array.from({ length: 100 }, (_, i) => `open the app and check window ${i} then verify the result`);
  const start = Date.now();
  for (const t of inputs) router.route({ text: t });
  const elapsed = Date.now() - start;
  assert(elapsed < 250, `100 classify+route cycles in ${elapsed}ms (routing overhead negligible)`);

  // Classifier memory bound: cache never exceeds maxEntries.
  const tiny = new CachedClassifier({ now, maxEntries: 4, ttlMs: 60_000 });
  for (let i = 0; i < 20; i++) tiny.classify(`unique message number ${i} with some words`);
  assert(tiny.stats().size <= 4, 'classifier cache stays bounded');
}

// =================================================================
// 11. Safety — routing is decision-only, registry enforcement untouched
// =================================================================
{
  console.log('Safety — routing cannot bypass permissions or execute anything');
  const registry = createDefaultModelRegistry(now);
  const router = new ModelRouter(registry, undefined, now);
  const decision = router.route({ text: 'delete all the files and format the disk' });
  // The route decision contains no execution surface at all.
  const keys = Object.keys(decision);
  assert(!keys.some((k) => k.toLowerCase().includes('execute') || k.toLowerCase().includes('run')), 'route decisions carry no execution surface');
  assert(typeof decision.model === 'string' && decision.orderedModels.every((m) => typeof m === 'string'), 'decisions are plain model identifiers');

  // ToolRegistry permission enforcement unaffected by routing tools.
  const bus = new AgentEventBus();
  const toolRegistry = new ToolRegistry(bus);
  const permissions = new PermissionManager(); // screen.observation denied by default
  const telemetry = new PerformanceTelemetry();
  const classifier = new CachedClassifier({ now, telemetry });
  toolRegistry.registerAll(createRoutingTools(router, classifier, telemetry));
  const gatedTool: AgentTool = {
    name: 'screen.observe',
    description: 'gated',
    category: 'vision',
    riskLevel: 'low',
    capabilities: ['screen.observe'],
    permissions: ['screen.observation'],
    timeoutMs: 1_000,
    execute: async () => ({ success: true, output: {} }),
  } as unknown as AgentTool;
  toolRegistry.register(gatedTool);
  const ctx = { taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions };
  const routed = await toolRegistry.execute('model.route', { task: 'open spotify' }, ctx);
  assert(routed.success, 'model.route executes freely (safe/local/free)');
  assert((routed.output as any).model === 'gemini-3.1-flash-lite', 'route decision served through the registry');
  const denied = await toolRegistry.execute('screen.observe', {}, ctx);
  assert(!denied.success && denied.errorKind === 'permission_denied', 'gated tool STILL permission-checked (routing changes nothing)');
  const perfRead = await toolRegistry.execute('perf.metrics', {}, ctx);
  assert(perfRead.success && (perfRead.output as any).counters !== undefined, 'perf.metrics readable through the registry');
}

// =================================================================
// 12. Integration — Agent Core + Phase 16 planning + Deep Research
// =================================================================
{
  console.log('Integration — Agent Core E2E, planning compatibility, research untouched');
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  const telemetry = new PerformanceTelemetry();
  const router = new ModelRouter(createDefaultModelRegistry(now), telemetry, now);
  const classifier = new CachedClassifier({ now, telemetry });
  registry.registerAll(createRoutingTools(router, classifier, telemetry));
  registry.register(createSystemNoteTool());
  // Deep Research stub (normally registered by the bridge) so the research
  // plan passes tool-availability validation here too.
  const researchStub: AgentTool = {
    name: 'research.run',
    description: 'deep research run (test double)',
    category: 'web',
    riskLevel: 'low',
    cost: 'moderate',
    reliability: 0.8,
    capabilities: ['research.run'],
    permissions: [],
    timeoutMs: 1_000,
    execute: async () => ({ success: true, output: {} }),
  } as unknown as AgentTool;
  registry.register(researchStub);
  // The Phase 1 web tool (normally registered by the bridge) so the goal is
  // executable in this headless registry.
  const webOpen: AgentTool = {
    name: 'web.open_website',
    description: 'open a website (test double)',
    category: 'web',
    riskLevel: 'low',
    cost: 'free',
    reliability: 1,
    capabilities: ['browser.open_url'],
    permissions: [],
    timeoutMs: 1_000,
    execute: async () => ({ success: true, output: { acknowledged: true } }),
  } as unknown as AgentTool;
  registry.register(webOpen);

  const engine = new PlanEngine({ registry, events: bus, permissions });
  const core = new AgentCore({ registry, events: bus, store: new TaskStore(new MemoryStorage()), permissions, planning: engine, stepTimeoutMs: 5_000 });
  const task = await core.submit('open spotify');
  assertEqual(task.status, 'completed', 'agent task with routing tools completes');
  assert(bus.recentEvents().some((e) => e.name === 'PLAN_CREATED'), 'Phase 16 planning layer tracked the task');

  // model.route serves real decisions through the registry, and every
  // execution is passively recorded in telemetry.
  const routedThroughCore = await core.submit('open netflix');
  assertEqual(routedThroughCore.status, 'completed', 'second task completes');
  const routedCall = await registry.execute('model.route', { task: 'research why the scheduler algorithm fails, analyze the root cause, and design a fix step by step' }, {
    taskId: 't-route', stepId: 's', signal: new AbortController().signal, memory: {}, permissions,
  });
  assert(routedCall.success && (routedCall.output as any).tier === 'strong', 'routing decision served through the registry during a task');
  assert(telemetry.snapshot().counters.routes >= 1, 'routing telemetry recorded through real execution');

  // Deep Research compatibility: research plans still attach cleanly.
  const researchPlan = {
    goal: { description: 'research photosynthesis', rawInput: 'research photosynthesis', kind: 'command' as const },
    steps: [{ id: 'res1', description: 'Research: photosynthesis', toolName: 'research.run', capability: 'research.run', input: { goal: 'research photosynthesis' }, status: 'pending' as const, attempts: 0 }],
    createdAt: now(),
    revision: 1,
  };
  const attached = engine.attachPlan('t-research-compat', researchPlan.goal.description, researchPlan.steps);
  assert(attached.ok, 'Deep Research plan still passes Phase 16 validation (untouched)');
}

console.log(`\nPhase 17 results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('PHASE 17 TESTS: ALL GREEN');
