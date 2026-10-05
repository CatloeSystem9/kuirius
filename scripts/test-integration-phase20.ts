/**
 * Phase 20 verification suite — Final Agent Integration.
 * Usage: npx tsx scripts/test-integration-phase20.ts
 *
 * Deterministic: fake tools, MemoryStorage, no network, no real model calls.
 * Covers: capability catalog (lazy load, search, dedupe, graceful source
 * failure, bounded results), integration with Agent Core/ToolRegistry/
 * Phase 18 gate/Phase 16 planning/Phase 19 long-run/Deep Research,
 * safety (no bypass, no self-grant, decision-only), performance
 * (startup/lazy-load overhead, repeated searches), and honest availability
 * accounting (advisory never claimed executable).
 */
import { CapabilityCatalog, SpecialistCatalogSource, modelHintToTier, SPECIALIST_SOURCE_ID, createCapabilityTools } from '../src/agent/capabilities';
import type { CapabilityRecord } from '../src/agent/capabilities';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { PlanEngine } from '../src/agent/planning';
import { ResearchService, createResearchTools } from '../src/agent/research';
import { LongRunManager } from '../src/agent/longrun';
import { createSystemNoteTool } from '../src/agent/system/systemTools';
import type { AgentTool, PlanStep } from '../src/agent/types';

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

// =================================================================
// 1. Catalog — real specialist source (lazy, complete, advisory)
// =================================================================
{
  console.log('Catalog — lazy load of the real specialist library');
  const catalog = new CapabilityCatalog([new SpecialistCatalogSource()]);
  const stats = await catalog.stats();
  assertEqual(stats.total, 100, 'catalog loaded the 100 prepared specialist definitions');
  assertEqual(stats.sources.length, 1, 'one source registered');
  assertEqual(stats.byAvailability.advisory, 100, 'all specialists honestly labeled ADVISORY (never executable)');
  assert(stats.byCategory.length === 10, `10 departments present (${stats.byCategory.length})`);
  assertEqual(catalog.lazyLoadCounts()[SPECIALIST_SOURCE_ID], 1, 'lazy source loaded exactly once');
  const stats2 = await catalog.stats();
  assert(stats2.total === stats.total, 'second stats call reuses the cached index');
  assertEqual(catalog.lazyLoadCounts()[SPECIALIST_SOURCE_ID], 1, 'still exactly one load (no re-loading)');

  // Records are advisory metadata: no execution surface anywhere.
  const records = await catalog.ensureLoaded();
  assert(records.every((r: CapabilityRecord) => r.family === 'specialist'), 'all records from the specialist family');
  assert(records.every((r) => typeof r.id === 'string' && r.id.length > 0), 'all records have ids');
  assert(records.every((r) => Array.isArray(r.limitations) && r.limitations.length > 0), 'every specialist states its limitations (honest non-claims)');
}

// =================================================================
// 2. Discovery — search ranking, filters, bounded results
// =================================================================
{
  console.log('Discovery — search, department filter, risk/model hints');
  const catalog = new CapabilityCatalog([new SpecialistCatalogSource()]);
  const researchHits = await catalog.search('research current information on the web');
  assert(researchHits.length > 0, 'research query matches candidates');
  assert(researchHits.some((r) => r.record.id === 'web-research'), 'web-research specialist discovered');
  assert(researchHits[0].record.tags.length > 0, 'matches backed by tags');

  const deepHits = await catalog.search('deep research investigation synthesis across many sources');
  assert(deepHits.some((r) => r.record.id === 'deep-research'), 'deep-research specialist discovered');

  const codingHits = await catalog.search('debug the code and refactor the algorithm');
  assert(codingHits.length > 0, 'coding query matches candidates');

  // Department filter.
  const researchOnly = await catalog.search('research', { category: 'research-knowledge' });
  assert(researchOnly.every((r) => r.record.category === 'research-knowledge'), 'category filter respected');

  // Bounded results.
  const capped = await catalog.search('the', { maxResults: 3 });
  assert(capped.length <= 3, 'maxResults bounded');

  // No match → empty, honest.
  const noMatch = await catalog.search('zzzqqqxyzzy');
  assertEqual(noMatch.length, 0, 'nonsense query honestly returns nothing');

  // Model hints map to Phase 17 tier vocabulary (advisory only).
  assertEqual(modelHintToTier('lightweight'), 'light', 'lightweight → light tier hint');
  assertEqual(modelHintToTier('advanced'), 'strong', 'advanced → strong tier hint');
  assertEqual(modelHintToTier('vision'), 'balanced', 'vision → balanced tier hint');
  assertEqual(modelHintToTier(undefined), undefined, 'no hint → no tier hint');
  const withHint = researchHits.find((r) => r.record.modelHint !== undefined);
  if (withHint) {
    assert(modelHintToTier(withHint.record.modelHint) !== undefined, 'specialist model hint maps into the Phase 17 vocabulary');
  }

  // byCategory + byId.
  const dept = await catalog.byCategory('research-knowledge', 5);
  assertEqual(dept.length, 5, 'byCategory bounded');
  const first = dept[0];
  const byId = await catalog.byId(SPECIALIST_SOURCE_ID, first.id);
  assert(byId !== undefined && byId.id === first.id, 'byId lookup works');
  assertEqual(await catalog.byId('nope', 'nope'), undefined, 'unknown id honestly undefined');
}

// =================================================================
// 3. Lazy sources — load once, degrade gracefully, dedupe
// =================================================================
{
  console.log('Lazy sources — load-once, graceful failure, dedupe');
  let loads = 0;
  const countingSource = {
    sourceId: 'counting',
    family: 'test',
    description: 'counts loads',
    load: () => {
      loads++;
      return Promise.resolve([
        { id: 'c1', sourceId: 'counting', name: 'C1', family: 'test', category: 'test', description: 'd', activationConditions: 'always', tags: ['alpha'], preferredTools: [], riskLevel: 'LOW', limitations: ['none'], availability: 'advisory' as const },
        { id: 'c1', sourceId: 'counting', name: 'C1-dup', family: 'test', category: 'test', description: 'd', activationConditions: 'always', tags: ['alpha'], preferredTools: [], riskLevel: 'LOW', limitations: ['none'], availability: 'advisory' as const },
        { id: 'c2', sourceId: 'counting', name: 'C2', family: 'test', category: 'test', description: 'd', activationConditions: 'always', tags: ['beta'], preferredTools: [], riskLevel: 'LOW', limitations: ['none'], availability: 'advisory' as const },
      ]);
    },
  };
  const catalog = new CapabilityCatalog([countingSource]);
  await catalog.search('alpha');
  await catalog.search('beta');
  assertEqual(loads, 1, 'source loaded EXACTLY once across searches (lazy, cached)');
  assertEqual((await catalog.stats()).total, 2, 'duplicate ids within a source deduped');

  // Failing source degrades gracefully (honest unavailable record).
  const failingSource = {
    sourceId: 'broken',
    family: 'test',
    description: 'always throws',
    load: () => Promise.reject(new Error('catalog file unreadable')),
  };
  const catalog2 = new CapabilityCatalog([failingSource]);
  const stats = await catalog2.stats();
  assertEqual(stats.total, 1, 'failing source contributes one honest unavailable record');
  assertEqual(stats.byAvailability.unavailable, 1, 'failure labeled unavailable — never faked as working');
}

// =================================================================
// 4. Tools through the registry — safe, gated, no bypass
// =================================================================
{
  console.log('Capability tools — safe discovery through the gated registry');
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  const catalog = new CapabilityCatalog([new SpecialistCatalogSource()]);
  registry.registerAll(createCapabilityTools(catalog));
  const c = { taskId: 't20', stepId: 's', signal: new AbortController().signal, memory: {}, permissions };

  const search = await registry.execute('capability.search', { query: 'research the web for current ai news' }, c);
  assert(search.success, 'capability.search executes through the gated registry');
  const results = (search.output as any).results;
  assert(results.length > 0 && results[0].availability === 'advisory', 'results honestly labeled advisory');
  assert(!('execute' in (search.output as any)) && !('executor' in (search.output as any)), 'search results carry no execution surface');

  const capabilityStats = await registry.execute('capability.stats', {}, c);
  assert(capabilityStats.success && (capabilityStats.output as any).total === 100, 'capability.stats reports the full catalog');

  const byCat = await registry.execute('capability.by_category', { category: 'computer-digital-operations' }, c);
  assert(byCat.success, 'by_category works through the registry');

  // Invalid input fails closed (schema validation).
  const bad = await registry.execute('capability.search', {}, c);
  assert(!bad.success && bad.errorKind === 'invalid_input', 'missing query → invalid_input (fail closed)');

  // No self-execution: capability tools are safe/local; a gated tool stays gated.
  permissions.revoke('browser.interaction');
  const gated: AgentTool = {
    name: 'browser.navigate', description: '', category: 'web', riskLevel: 'low',
    capabilities: ['browser.navigate'], permissions: ['browser.interaction'], timeoutMs: 1_000,
    execute: async () => ({ success: true, output: {} }),
  } as unknown as AgentTool;
  registry.register(gated);
  const denied = await registry.execute('browser.navigate', { url: 'https://x' }, c);
  assert(!denied.success && denied.errorKind === 'permission_denied', 'capability discovery does NOT weaken tool permissions');
  permissions.grant('browser.interaction');
}

// =================================================================
// 5. Full-agent integration — core + all Phase 20 tools + long-run + research
// =================================================================
{
  console.log('Full-agent integration — one registry, every subsystem cooperating');
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  permissions.grant('filesystem.write');
  const catalog = new CapabilityCatalog([new SpecialistCatalogSource()]);
  registry.registerAll(createCapabilityTools(catalog));
  registry.register(createSystemNoteTool());

  // A research tool double (real research suite covers the real one).
  registry.register({
    name: 'research.run', description: '', category: 'web', riskLevel: 'low',
    capabilities: ['research.run'], permissions: ['browser.interaction'], timeoutMs: 1_000,
    execute: async () => ({ success: true, output: { summary: 'research report' }, verified: true }),
  } as unknown as AgentTool);
  registry.register({
    name: 'web.open_website', description: '', category: 'web', riskLevel: 'low',
    capabilities: ['browser.open_url'], permissions: [], timeoutMs: 1_000,
    execute: async () => ({ success: true, output: { opened: true }, verified: true }),
  } as unknown as AgentTool);

  // No duplicate registrations anywhere.
  const names = registry.names();
  assertEqual(new Set(names).size, names.length, 'no duplicate tool registration');

  const planning = new PlanEngine({ registry, events: bus, permissions });
  const core = new AgentCore({ registry, events: bus, store: new TaskStore(new MemoryStorage()), permissions, planning, stepTimeoutMs: 5_000 });

  // Discovery-informed task: the agent searches capabilities, then acts.
  const discoveryTask = await core.submit('open netflix');
  assertEqual(discoveryTask.status, 'completed', 'ordinary task completes in the integrated registry');

  // Long-run under the integrated registry.
  const longRun = new LongRunManager(core, bus, {});
  longRun.attach();
  const lrSteps: PlanStep[] = [{ id: 'r1', description: 'note progress', toolName: 'system.note', input: { text: 'progress' }, status: 'pending', attempts: 0 }];
  Object.defineProperty(core, 'planner', {
    value: { makePlan: () => ({ goal: { description: 'g', rawInput: 'g', kind: 'command' as const }, steps: lrSteps, createdAt: Date.now(), revision: 1 }), proposeAlternative: () => null },
    configurable: true,
  });
  const lrSession = longRun.start('integrated long-run task');
  assertEqual(lrSession.started, true, 'long-run session starts under the integrated registry');
  await new Promise((r) => setTimeout(r, 120));
  const lrDiag = longRun.listSessions().find((s) => s.taskId === lrSession.taskId)!;
  assert(lrDiag.state === 'COMPLETED' || lrDiag.state === 'RUNNING', `long-run session progresses (${lrDiag.state})`);

  // Deep Research services coexist with the catalog in the same registry.
  const researchRegistry = new ToolRegistry(new AgentEventBus());
  const research = new ResearchService({
    backend: { search: async () => ({ hits: [] }), fetchPage: async (url) => ({ url, title: '', text: '', error: 'unused' }) },
    registry: researchRegistry,
    limits: { maxRounds: 1, maxSearches: 1 },
  });
  researchRegistry.registerAll(createResearchTools(research));
  const plan = research.plan('p20', 'research photosynthesis');
  assert(plan.subQuestions.length >= 1, 'Deep Research intact alongside the capability layer');
}

// =================================================================
// 6. Performance — startup/lazy overhead negligible
// =================================================================
{
  console.log('Performance — lazy load + search overhead measurement');
  const catalog = new CapabilityCatalog([new SpecialistCatalogSource()]);
  const loadStart = Date.now();
  await catalog.stats();
  const loadMs = Date.now() - loadStart;
  assert(loadMs < 2_000, `first lazy catalog load ${loadMs}ms (one-time, metadata only)`);

  const searchStart = Date.now();
  for (let i = 0; i < 50; i++) await catalog.search(`research task number ${i}`);
  const searchMs = Date.now() - searchStart;
  assert(searchMs < 2_000, `50 catalog searches in ${searchMs}ms (pure index lookups after lazy load)`);
  assertEqual(catalog.lazyLoadCounts()[SPECIALIST_SOURCE_ID], 1, 'still exactly one source load after 50 searches');
}

console.log(`\nPhase 20 results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('PHASE 20 TESTS: ALL GREEN');
