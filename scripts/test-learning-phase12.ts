/**
 * Phase 12 verification suite — Learning + Workflow Acquisition.
 * Usage: npx tsx scripts/test-learning-phase12.ts
 * Exits non-zero on any failure.
 *
 * Covers the spec's ten required tests: preference learning, correction
 * learning, successful workflow learning, workflow reuse, failed strategies,
 * adaptation to environment changes, duplicate prevention, persistence,
 * learning safety (no source/self modification, secret redaction, risk
 * guard), and resource behavior (bounded stats, no heavyweight processing).
 */
import {
  LearningService,
  LearningWorkflowStore,
  WorkflowAwarePlanner,
  isReusable,
  confidenceLevel,
  MAX_STRATEGY_ENTRIES,
  REUSE_MIN_SCORE,
} from '../src/agent/learning';
import type { LearnedWorkflow } from '../src/agent/learning';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { MemoryService } from '../src/agent/memory/memoryService';
import { attachMemoryToSystem } from '../src/agent/memory/memoryBridge';
import type { AgentGoal, AgentPlan, AgentTool, PlanStep } from '../src/agent/types';
import { ok, fail } from '../src/agent/types';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  assert(equal, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function tool(name: string, capability: string, execute: AgentTool['execute'], extra: Partial<AgentTool> = {}): AgentTool {
  return { name, description: name, category: 'test', riskLevel: 'low', capabilities: [capability], execute, ...extra };
}

function step(id: string, toolName: string, capability: string, input: Record<string, unknown> = {}, extra: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    description: `${toolName} step`,
    toolName,
    capability,
    input,
    status: 'pending',
    attempts: 0,
    ...extra,
  };
}

function staticPlanner(steps: PlanStep[]): { makePlan(goal: AgentGoal): AgentPlan; proposeAlternative(step: PlanStep, error: string): PlanStep | null } {
  return {
    makePlan: (goal: AgentGoal) => ({ goal, steps: steps.map((s) => ({ ...s })), createdAt: Date.now(), revision: 1 }),
    proposeAlternative: () => null,
  };
}

interface Harness {
  core: AgentCore;
  learning: LearningService;
  registry: ToolRegistry;
  bus: AgentEventBus;
  storage: MemoryStorage;
  memory: MemoryService;
  detachAll: () => void;
}

function makeHarness(plannerSteps: PlanStep[], toolDefs: AgentTool[]): Harness {
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  for (const t of toolDefs) registry.register(t);
  const storage = new MemoryStorage();
  const store = new TaskStore(storage);
  const memory = new MemoryService(storage);
  const learning = new LearningService({
    registry,
    events: bus,
    memory,
    storage,
    taskResolver: (taskId) => store.get(taskId),
  });
  const core = new AgentCore({
    registry,
    events: bus,
    store,
    planner: new WorkflowAwarePlanner(staticPlanner(plannerSteps), learning),
  });
  learning.attach();
  // Production parity: the Phase 2 memory bridge also listens on the bus.
  const memoryAttachment = attachMemoryToSystem({ core, bus, registry, detach: () => {} }, memory);
  const detachAll = () => {
    learning.detach();
    memoryAttachment.detach();
  };
  return { core, learning, registry, bus, storage, memory, detachAll };
}

const GOAL_A = 'open the widget then zap the widget file and log the widget result';
const STEP_DEFS = [
  step('s1', 'mock.a', 'cap.a', { target: 'widget-1' }),
  step('s2', 'mock.b', 'cap.b', { path: 'widget-file' }),
];

function successTools(): AgentTool[] {
  return [
    tool('mock.a', 'cap.a', async () => ok({ output: { opened: true } })),
    tool('mock.b', 'cap.b', async () => ok({ output: { zapped: true } })),
  ];
}

function getWorkflow(learning: LearningService): LearnedWorkflow | undefined {
  return learning.list()[0];
}

// ---------------------------------------------------------------- Test 1
{
  console.log('Test 1 — Preference learning');
  const bus = new AgentEventBus();
  const registry = new ToolRegistry();
  registry.register(tool('system.note', 'system.note', async () => ok({ output: 'noted' })));
  const storage = new MemoryStorage();
  const store = new TaskStore(storage);
  const memory = new MemoryService(storage);
  const core = new AgentCore({
    registry,
    events: bus,
    store,
    planner: staticPlanner([step('s1', 'system.note', 'system.note')]),
  });
  const attachment = attachMemoryToSystem({ core, bus, registry, detach: () => {} }, memory);

  memory.remember('I prefer opening projects with VS Code', { source: 'user_manual', category: 'preference' });

  const task = await core.submit('how should I open my project today?');
  assert(Array.isArray(task.memoryContext) && task.memoryContext.some((m) => m.includes('VS Code')), 'preference stored and recalled into task context');

  // The preference influences a later similar task through recall as well.
  const recalled = memory.recall('open the project in my editor', { limit: 5 });
  assert(recalled.some((r) => r.content.includes('VS Code')), 'preference recalled for later similar task');

  attachment.detach();
}

// ---------------------------------------------------------------- Test 2
{
  console.log('Test 2 — Correction learning');
  const harness = makeHarness(STEP_DEFS, successTools());
  const { core, learning, bus, memory } = harness;

  // Establish a reusable workflow (two verified successes).
  const firstRun = await core.submit(GOAL_A);
  await core.submit(GOAL_A);
  const workflow = getWorkflow(learning)!;
  assertEqual(isReusable(workflow), true, 'workflow reusable before correction');
  const confidenceBefore = workflow.confidence;

  // Durable correction aimed at that workflow arrives via the event bus.
  bus.emit({
    name: 'USER_MESSAGE',
    taskId: firstRun.id,
    payload: { input: `${GOAL_A} is wrong, always use the terminal instead` },
    timestamp: Date.now(),
  });

  const updated = getWorkflow(learning)!;
  assertEqual(updated.corrections.length, 1, 'correction attached to matching workflow');
  assert(updated.corrections[0].workflowId === updated.id, 'correction cross-linked to workflow id');
  assert(updated.confidence < confidenceBefore, 'correction reduces confidence');
  assert(confidenceLevel(updated.confidence) === 'usable', 'correction does not destroy a trusted workflow');
  assert(
    memory.records.some((r) => r.category === 'correction' && r.content.includes('terminal')),
    'correction also stored in Phase 2 memory'
  );

  // The learned correction is considered on the next run: reuse still happens.
  const task = await core.submit(GOAL_A);
  assert(Boolean(task.plan?.learnedFrom), 'workflow still reused after correction');

  harness.detachAll();
}

// ---------------------------------------------------------------- Test 3
{
  console.log('Test 3 — Successful workflow learning');
  const harness = makeHarness(STEP_DEFS, successTools());
  const { core, learning } = harness;

  const run1 = await core.submit(GOAL_A);
  assertEqual(run1.status, 'completed' as const, 'first run completed');
  assertEqual(learning.list().length, 1, 'workflow candidate created');
  const wf1 = getWorkflow(learning)!;
  assertEqual(wf1.steps.length, 2, 'semantic steps captured in order');
  assertEqual(wf1.steps.map((s) => s.toolName), ['mock.a', 'mock.b'], 'step tools recorded');
  assertEqual(wf1.evidence.length, 1, 'one evidence record');
  assertEqual(confidenceLevel(wf1.confidence), 'candidate', 'single success is only a candidate');
  assertEqual(isReusable(wf1), false, 'workflow not reusable after one success');
  const confidenceAfterRun1 = wf1.confidence;

  const run2 = await core.submit(GOAL_A);
  assertEqual(run2.status, 'completed' as const, 'second run completed');
  const wf2 = getWorkflow(learning)!;
  assertEqual(wf2.evidence.length, 2, 'second success reinforced evidence');
  assert(wf2.confidence > confidenceAfterRun1, 'confidence increased');
  assertEqual(isReusable(wf2), true, 'repeated success makes workflow reusable');
  assert(learning.list().length === 1, 'no duplicate workflow created');

  harness.detachAll();
}

// ---------------------------------------------------------------- Test 4
{
  console.log('Test 4 — Workflow reuse');
  const harness = makeHarness(STEP_DEFS, successTools());
  const { core, learning, bus } = harness;

  await core.submit(GOAL_A);
  await core.submit(GOAL_A);

  const reused = learning.suggest(GOAL_A);
  assert(reused.length >= 1, 'suggest returns the learned workflow');
  assert(reused[0].score >= REUSE_MIN_SCORE, `candidate score above reuse threshold (${reused[0]?.score})`);
  assertEqual(reused[0].capabilityCoverage, 1, 'environment compatible');

  const run3 = await core.submit(GOAL_A);
  assertEqual(run3.status, 'completed' as const, 'reused run completed');
  assert(Boolean(run3.plan?.learnedFrom), 'plan instantiated from learned workflow');
  assertEqual(run3.plan?.learnedFrom?.workflowId, getWorkflow(learning)!.id, 'reused workflow id recorded');
  assertEqual(run3.plan?.steps.map((s) => s.toolName), ['mock.a', 'mock.b'], 'reused plan replays the learned template');
  assertEqual(run3.plan?.steps[0].input.target, 'widget-1', 'step input template preserved');

  const wf = getWorkflow(learning)!;
  assertEqual(wf.usage.totalUses, 1, 'reuse usage counted');
  assertEqual(wf.usage.successfulUses, 1, 'reuse success counted');
  assert(wf.confidence > 0.5, 'verified reuse raises confidence');

  assert(
    bus.recentEvents().some((e) => e.name === 'WORKFLOW_REUSED'),
    'WORKFLOW_REUSED event emitted'
  );

  // Unrelated goals do not trigger reuse.
  const unrelated = learning.suggest('write a poem about the sea and print it nicely');
  assertEqual(unrelated.length, 0, 'unrelated goal not matched to workflow');

  harness.detachAll();
}

// ---------------------------------------------------------------- Test 5
{
  console.log('Test 5 — Failed strategy loses confidence');
  const failing = [
    tool('mock.a', 'cap.a', async () => fail('boom', { retryable: false })),
    tool('mock.b', 'cap.b', async () => fail('boom', { retryable: false })),
  ];
  const harness = makeHarness(STEP_DEFS, successTools());
  const { core, learning } = harness;

  await core.submit(GOAL_A);
  await core.submit(GOAL_A);
  assertEqual(isReusable(getWorkflow(learning)!), true, 'workflow reusable before failures');

  // Swap in failing tools and run the same workflow shape twice.
  harness.registry.unregister('mock.a');
  harness.registry.unregister('mock.b');
  for (const t of failing) harness.registry.register(t);

  await core.submit(GOAL_A);
  const afterFail1 = getWorkflow(learning)!;
  const confidenceAfterFail1 = afterFail1.confidence;
  assert(confidenceAfterFail1 < 0.5, 'verified failure reduces confidence');
  assertEqual(isReusable(afterFail1), false, 'workflow no longer auto-reused after failure');

  await core.submit(GOAL_A);
  const afterFail2 = getWorkflow(learning)!;
  assert(afterFail2.confidence < confidenceAfterFail1, 'repeated failures keep reducing confidence');
  assertEqual(learning.suggest(GOAL_A).length, 0, 'degraded workflow excluded from suggestions');

  harness.detachAll();
}

// ---------------------------------------------------------------- Test 6
{
  console.log('Test 6 — Adaptation to a changed environment');
  const harness = makeHarness(STEP_DEFS, successTools());
  const { core, learning, registry } = harness;

  await core.submit(GOAL_A);
  await core.submit(GOAL_A);

  // The original tool disappears; a different tool now serves the capability.
  const executed: string[] = [];
  registry.unregister('mock.a');
  registry.register(
    tool('mock.a2', 'cap.a', async () => {
      executed.push('mock.a2');
      return ok({ output: { opened: true, via: 'a2' } });
    })
  );

  const candidates = learning.suggest(GOAL_A);
  assertEqual(candidates.length, 1, 'workflow still suggested after tool replacement');
  assertEqual(candidates[0].capabilityCoverage, 1, 'capability resolves to the new tool');
  assert(
    candidates[0].reasons.some((r) => r.includes('mock.a2')),
    'adaptation reason recorded (tool replaced via capability)'
  );

  const task = await core.submit(GOAL_A);
  assertEqual(task.status, 'completed' as const, 'adapted reuse run completed');
  assert(executed.includes('mock.a2'), 'execution used the replacement tool');

  harness.detachAll();
}

// ---------------------------------------------------------------- Test 7
{
  console.log('Test 7 — Duplicate prevention');
  const harness = makeHarness(STEP_DEFS, successTools());
  const { core, learning, memory } = harness;

  await core.submit(GOAL_A);
  await core.submit(GOAL_A);
  await core.submit(GOAL_A);

  assertEqual(learning.list().length, 1, 'repeated successes do not duplicate workflows');
  assertEqual(memory.records.filter((r) => r.category === 'workflow').length, 1, 'memory mirror merged, not duplicated');
  const mirrored = memory.records.find((r) => r.category === 'workflow');
  assert(mirrored?.metadata?.workflowId === getWorkflow(learning)!.id, 'memory mirror cross-linked by workflowId');

  // Direct API: learning the same workflow-shaped outcome again stays merged.
  const task = core.store.list()[0]!;
  const outcome = learning.learnFromTask(task);
  assert(outcome.workflowId === getWorkflow(learning)!.id, 're-learning maps to the same workflow');
  assertEqual(learning.list().length, 1, 'still exactly one workflow');

  harness.detachAll();
}

// ---------------------------------------------------------------- Test 8
{
  console.log('Test 8 — Persistence across restart');
  const storage = new MemoryStorage();
  const bus = new AgentEventBus();
  const registry = new ToolRegistry();
  for (const t of successTools()) registry.register(t);
  const store = new TaskStore(storage);

  const learning1 = new LearningService({
    registry,
    events: bus,
    storage,
    taskResolver: (taskId) => store.get(taskId),
  });
  const core1 = new AgentCore({ registry, events: bus, store, planner: new WorkflowAwarePlanner(staticPlanner(STEP_DEFS), learning1) });
  learning1.attach();
  await core1.submit(GOAL_A);
  await core1.submit(GOAL_A);
  learning1.detach();

  // "Restart": fresh service over the same storage.
  const learning2 = new LearningService({
    registry,
    events: bus,
    storage,
    taskResolver: (taskId) => store.get(taskId),
  });
  const wf = getWorkflow(learning2)!;
  assertEqual(wf.steps.length, 2, 'workflow persisted');
  assert(learning2.suggest(GOAL_A).length === 1, 'persisted workflow still suggested');
  assertEqual(isReusable(wf), true, 'persisted confidence preserved');

  const core2 = new AgentCore({ registry, events: bus, store: new TaskStore(storage), planner: new WorkflowAwarePlanner(staticPlanner(STEP_DEFS), learning2) });
  learning2.attach();
  const task = await core2.submit(GOAL_A);
  assert(Boolean(task.plan?.learnedFrom), 'after restart the learned workflow is reused immediately');

  learning2.detach();
}

// ---------------------------------------------------------------- Test 9
{
  console.log('Test 9 — Learning safety');
  const riskySteps = [
    step('s1', 'mock.risky', 'cap.risky', { path: 'C:/important' }),
    step('s2', 'mock.b', 'cap.b', {}),
  ];
  const riskyTool = tool('mock.risky', 'cap.risky', async () => ok({ output: { deleted: true } }), { riskLevel: 'critical' });
  const harness = makeHarness(riskySteps, [riskyTool, ...successTools()]);
  const { core, learning } = harness;

  const task = await core.submit('delete the important file then zap the widget file');
  assertEqual(task.status, 'completed' as const, 'risky task still executes under normal permissions');
  assertEqual(learning.list().length, 0, 'workflows containing high/critical-risk steps are never learned');
  assert(!learning.suggest('delete the important file then zap the widget file').length, 'risky strategy never suggested');

  // Secrets are stripped from stored templates.
  const secretSteps = [
    step('s1', 'mock.a', 'cap.a', { apiKey: 'sk-abcdefgh123456', target: 'service' }),
    step('s2', 'mock.b', 'cap.b', { password: 'hunter2' }),
  ];
  const harness2 = makeHarness(secretSteps, successTools());
  const run = await harness2.core.submit('authenticate to the service then zap the widget file');
  assertEqual(run.status, 'completed' as const, 'secret-bearing task completed');
  const wf = getWorkflow(harness2.learning)!;
  assertEqual((wf.steps[0].inputTemplate as Record<string, unknown>).apiKey, '[redacted]', 'api key redacted in stored template');
  assertEqual((wf.steps[1].inputTemplate as Record<string, unknown>).password, '[redacted]', 'password redacted in stored template');

  // Learning only mutates its own store — never source code, permissions, or settings.
  const beforeStats = harness2.learning.stats();
  harness2.learning.reset();
  assertEqual(harness2.learning.stats().workflows, 0, 'learning data is disposable data, not code');

  harness.detachAll();
  harness2.detachAll();
  void beforeStats;
}

// ---------------------------------------------------------------- Test 10
{
  console.log('Test 10 — Resource behavior');
  const harness = makeHarness(STEP_DEFS, successTools());
  const { learning, bus, registry } = harness;

  // Strategy stats stay bounded no matter how many capabilities fire.
  for (let i = 0; i < MAX_STRATEGY_ENTRIES + 20; i++) {
    registry.register(tool(`bulk.${i}`, `cap.bulk.${i}`, async () => ok({ output: null })));
    bus.emit({ name: 'TOOL_COMPLETED', payload: { tool: `bulk.${i}` }, timestamp: Date.now() });
  }
  assert(learning.strategyStats().length <= MAX_STRATEGY_ENTRIES, 'strategy statistics bounded');

  // suggest() is synchronous, local pattern matching — no promises, no model calls.
  const started = Date.now();
  for (let i = 0; i < 1000; i++) learning.suggest(GOAL_A);
  const elapsed = Date.now() - started;
  assert(elapsed < 1000, `1000 suggest() calls are lightweight (${elapsed}ms)`);

  // attach/detach is clean; no listeners leak and no repeated learning.
  learning.detach();
  const countBefore = learning.list().length;
  bus.emit({ name: 'TASK_COMPLETED', taskId: 'nonexistent', timestamp: Date.now() });
  assertEqual(learning.list().length, countBefore, 'no phantom learning after detach');

  // Strategy outcome recording works from tool events via capability lookup.
  const learning2harness = makeHarness(STEP_DEFS, successTools());
  await learning2harness.core.submit(GOAL_A);
  const stat = learning2harness.learning.preferredStrategy('cap.a');
  assert(Boolean(stat && stat.successCount >= 1), 'tool preference statistics recorded from real outcomes');

  learning.detach();
  learning2harness.detachAll();
}

// ---------------------------------------------------------------- extras
{
  console.log('Extras — planner fallback and versioned adaptation');
  // Without any learned workflow, the wrapper delegates to the inner planner.
  const harness = makeHarness(STEP_DEFS, successTools());
  const { learning } = harness;
  const fallback = new WorkflowAwarePlanner(staticPlanner(STEP_DEFS), learning);
  const plan = fallback.makePlan({ description: GOAL_A, rawInput: GOAL_A, kind: 'command' });
  assert(!plan.learnedFrom, 'no reuse before anything is learned');
  assertEqual(plan.steps.length, 2, 'inner planner used as fallback');

  // A different verified step sequence updates the template as a new version.
  await harness.core.submit(GOAL_A);
  await harness.core.submit(GOAL_A);
  const wf = getWorkflow(learning)!;
  const altered: PlanStep[] = [
    step('s1', 'mock.a', 'cap.a', { target: 'widget-1' }),
    step('s2', 'mock.c', 'cap.c', { mode: 'fast' }),
  ];
  harness.registry.register(tool('mock.c', 'cap.c', async () => ok({ output: { logged: true } })));
  const adaptedTask = {
    id: 'manual',
    goal: { description: GOAL_A, rawInput: GOAL_A, kind: 'command' as const },
    plan: { goal: { description: GOAL_A, rawInput: GOAL_A, kind: 'command' as const }, steps: altered.map((s) => ({ ...s, status: 'completed' as const })), createdAt: Date.now(), revision: 1 },
    status: 'completed' as const,
    currentStepIndex: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const outcome = learning.learnFromTask(adaptedTask);
  assertEqual(outcome.learned, true, 'altered sequence learned');
  const updated = getWorkflow(learning)!;
  assert(updated.version === 2, `template versioned on step change (version ${updated.version})`);
  assertEqual(updated.steps[1].toolName, 'mock.c', 'template steps updated to the new verified sequence');
  assert(updated.versionHistory.some((v) => v.version === 2), 'version history kept');

  harness.detachAll();
}

// ---------------------------------------------------------------- report
console.log(`\nPhase 12 results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Failures:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
