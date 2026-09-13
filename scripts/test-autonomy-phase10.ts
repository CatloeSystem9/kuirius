/**
 * Phase 10 verification suite — Multi-Step Autonomy.
 * Usage: npx tsx scripts/test-autonomy-phase10.ts
 */
import { AgentCore } from '../src/agent/agentCore';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { PermissionManager } from '../src/agent/permissions';
import { AgentEventBus } from '../src/agent/events';
import { HeuristicPlanner, extractGoal } from '../src/agent/planner';
import type { Planner } from '../src/agent/planner';
import { evaluateCondition, resolveContextRefs, resolveContextPath, boundContextValue } from '../src/agent/context';
import type { AgentGoal, AgentPlan, AgentTool, PlanStep, Verification } from '../src/agent/types';
import { ok, fail } from '../src/agent/types';

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

function assertEqual<T>(actual: T, expected: T, label: string) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function makeCore(registry: ToolRegistry, opts: Partial<ConstructorParameters<typeof AgentCore>[0]> = {}) {
  return new AgentCore({
    registry,
    events: new AgentEventBus(),
    store: new TaskStore(new MemoryStorage()),
    permissions: new PermissionManager(),
    ...opts,
  });
}

function tool(name: string, execute: AgentTool['execute'], extra: Partial<AgentTool> = {}): AgentTool {
  return { name, description: name, category: 'test', riskLevel: 'low', execute, ...extra };
}

function step(partial: Partial<PlanStep> & { toolName: string }): PlanStep {
  const now = Date.now();
  return {
    id: partial.id ?? `step_${now}_${Math.random().toString(36).slice(2, 6)}`,
    description: partial.description ?? partial.toolName,
    toolName: partial.toolName,
    capability: partial.capability,
    input: partial.input ?? {},
    outputKey: partial.outputKey,
    condition: partial.condition,
    dependsOn: partial.dependsOn,
    verification: partial.verification,
    status: 'pending',
    attempts: 0,
  };
}

/** Local planner that returns a fixed plan — for driving the executor directly. */
class FixedPlanner implements Planner {
  constructor(private plan: AgentPlan) {}
  makePlan(_goal: AgentGoal): AgentPlan {
    return JSON.parse(JSON.stringify(this.plan));
  }
  proposeAlternative(): PlanStep | null {
    return null;
  }
}

function planFor(goal: AgentGoal, steps: PlanStep[], objective?: string, evidenceKey?: string): AgentPlan {
  return { goal, steps, createdAt: Date.now(), revision: 1, objective, evidenceKey };
}

// ---------------------------------------------------------------- context helpers
{
  console.log('Context helpers');
  const ctx = { a: { b: 'hello' }, list: [{ path: 'C:\\x\\y.txt' }], big: 'x'.repeat(5000) };
  assertEqual(resolveContextPath(ctx, 'a.b'), 'hello', 'dotted path resolution');
  assertEqual(resolveContextPath(ctx, 'list.0.path'), 'C:\\x\\y.txt', 'array index resolution');
  assertEqual(resolveContextPath(ctx, 'missing.key'), undefined, 'missing path → undefined');

  assertEqual(evaluateCondition({ kind: 'context_exists', key: 'a.b' }, ctx).run, true, 'context_exists satisfied');
  assertEqual(evaluateCondition({ kind: 'context_missing', key: 'a.b' }, ctx).run, false, 'context_missing unsatisfied when present');
  assertEqual(evaluateCondition({ kind: 'context_equals', key: 'a.b', value: 'hello' }, ctx).run, true, 'context_equals');
  assertEqual(evaluateCondition({ kind: 'context_contains', key: 'a.b', value: 'ell' }, ctx).run, true, 'context_contains');

  const resolved = resolveContextRefs({ path: { $context: 'list.0.path' }, static: 'v' }, ctx);
  assertEqual(resolved as any, { path: 'C:\\x\\y.txt', static: 'v' }, '$context placeholder resolved');

  const bounded = boundContextValue('x'.repeat(5000)) as any;
  assertEqual(bounded.truncated, true, 'oversized context value truncated to preview');
  assertEqual(boundContextValue({ small: 1 }), { small: 1 }, 'small value stored as-is');
}

// ---------------------------------------------------------------- Test 1: basic 3-step task
{
  console.log('Test 1: basic multi-step task');
  const registry = new ToolRegistry();
  const calls: string[] = [];
  registry.register(tool('step.a', async () => { calls.push('a'); return ok({ output: { marker: 'A' } }); }));
  registry.register(tool('step.b', async (input) => { calls.push('b:' + JSON.stringify(input)); return ok({ output: { got: (input as any).marker } }); }));
  registry.register(tool('step.c', async () => { calls.push('c'); return ok({ output: { done: true } }); }));

  const goal = extractGoal('three step task');
  const fixed = new FixedPlanner(planFor(goal, [
    step({ toolName: 'step.a', outputKey: 'out1' }),
    step({ toolName: 'step.b', input: { marker: { $context: 'out1.marker' } }, outputKey: 'out2' }),
    step({ toolName: 'step.c' }),
  ]));
  const core = makeCore(registry, { planner: fixed });
  const task = await core.submit('three step task');
  assertEqual(task.status, 'completed' as const, '3-step task completed');
  assertEqual(calls, ['a', 'b:{"marker":"A"}', 'c'], 'all three steps executed in order with context flow');
  assert(task.context !== undefined && (task.context as any).out2?.got === 'A', 'context chained between steps');
  assert(task.summary!.includes('All 3 steps completed'), 'verified final summary');
}

// ---------------------------------------------------------------- Test 2: longer task with chaining
{
  console.log('Test 2: 6-step task with context chaining');
  const registry = new ToolRegistry();
  const log: string[] = [];
  registry.register(tool('s1', async () => { log.push('1'); return ok({ output: { id: 'item-42' } }); }));
  registry.register(tool('s2', async (i) => { log.push('2:' + (i as any).id); return ok({ output: { detail: 'details-of-' + (i as any).id } }); }));
  registry.register(tool('s3', async (i) => { log.push('3:' + (i as any).detail); return ok({ output: {} }); }));
  registry.register(tool('s4', async () => { log.push('4'); return ok({ output: {} }); }));
  registry.register(tool('s5', async () => { log.push('5'); return ok({ output: {} }); }));
  registry.register(tool('s6', async (i) => { log.push('6:' + (i as any).id); return ok({ output: {} }); }));

  const goal = extractGoal('six step workflow');
  const fixed = new FixedPlanner(planFor(goal, [
    step({ toolName: 's1', outputKey: 'item' }),
    step({ toolName: 's2', input: { id: { $context: 'item.id' } }, outputKey: 'detail' }),
    step({ toolName: 's3', input: { detail: { $context: 'detail.detail' } } }),
    step({ toolName: 's4' }),
    step({ toolName: 's5' }),
    step({ toolName: 's6', input: { id: { $context: 'item.id' } } }),
  ], 'process item-42 through all stages'));
  const core = makeCore(registry, { planner: fixed });
  const task = await core.submit('six step workflow');
  assertEqual(task.status, 'completed' as const, '6-step workflow completed with context intact');
  assert(log.some((l) => l === '2:item-42'), 'step 2 received step 1 output');
  assert(log.some((l) => l === '3:details-of-item-42'), 'step 3 received step 2 output');
  assert(log.some((l) => l === '6:item-42'), 'step 6 still had step 1 context');
}

// ---------------------------------------------------------------- Test 3: cross-tool workflow
{
  console.log('Test 3: cross-tool workflow (filesystem → application → screen → keyboard)');
  const registry = new ToolRegistry();
  const used: string[] = [];
  registry.register(tool('filesystem.search', async () => { used.push('fs'); return ok({ output: { matches: [{ path: 'C:\\t\\project' }] } }); }));
  registry.register(tool('application.launch', async (i) => { used.push('app:' + (i as any).path); return ok({ output: { launched: true } }); }));
  registry.register(tool('screen.observe', async () => { used.push('screen'); return ok({ output: { application: 'explorer' } }); }));
  registry.register(tool('keyboard.type', async () => { used.push('kb'); return ok({ output: { typed: true } }); }));

  const goal = extractGoal('cross tool workflow');
  const fixed = new FixedPlanner(planFor(goal, [
    step({ toolName: 'filesystem.search', description: 'Find the project', input: { query: 'project' }, outputKey: 'found' }),
    step({ toolName: 'application.launch', description: 'Open the project', input: { path: { $context: 'found.matches.0.path' } } }),
    step({ toolName: 'screen.observe', description: 'Observe the result' }),
    step({ toolName: 'keyboard.type', description: 'Interact' }),
  ]));
  const core = makeCore(registry, { planner: fixed });
  const task = await core.submit('cross tool workflow');
  assertEqual(used, ['fs', 'app:C:\\t\\project', 'screen', 'kb'], 'filesystem → application → screen → keyboard chain with context flow');
  assertEqual(task.status, 'completed' as const, 'cross-tool workflow completed');
}

// ---------------------------------------------------------------- Test 4: conditional next step
{
  console.log('Test 4: conditional next step driven by task state');
  const registry = new ToolRegistry();
  const ran: string[] = [];
  registry.register(tool('probe', async () => { ran.push('probe'); return ok({ output: { mode: 'fast' } }); }));
  registry.register(tool('fastPath', async () => { ran.push('fast'); return ok({ output: {} }); }));
  registry.register(tool('slowPath', async () => { ran.push('slow'); return ok({ output: {} }); }));

  const goal = extractGoal('conditional workflow');
  const fixed = new FixedPlanner(planFor(goal, [
    step({ toolName: 'probe', outputKey: 'probeResult' }),
    step({ toolName: 'fastPath', condition: { kind: 'context_equals', key: 'probeResult.mode', value: 'fast' } }),
    step({ toolName: 'slowPath', condition: { kind: 'context_equals', key: 'probeResult.mode', value: 'slow' } }),
  ]));
  const core = makeCore(registry, { planner: fixed });
  const task = await core.submit('conditional workflow');
  assertEqual(ran, ['probe', 'fast'], 'task state selected the fast path; slow path skipped');
  assertEqual(task.plan!.steps[2].status, 'skipped' as const, 'unsatisfied conditional step skipped');
}

// ---------------------------------------------------------------- Test 5: already-completed objective
{
  console.log('Test 5: objective satisfied early → remaining steps skipped');
  const registry = new ToolRegistry();
  const ran: string[] = [];
  registry.register(tool('achieve', async () => { ran.push('achieve'); return ok({ output: { evidence: 'goal-met' } }); }));
  registry.register(tool('extra1', async () => { ran.push('extra1'); return ok(); }));
  registry.register(tool('extra2', async () => { ran.push('extra2'); return ok(); }));

  const goal = extractGoal('early objective');
  const fixed = new FixedPlanner(planFor(goal, [
    step({ toolName: 'achieve', outputKey: 'objectiveEvidence' }),
    step({ toolName: 'extra1' }),
    step({ toolName: 'extra2' }),
  ], 'achieve the goal', 'objectiveEvidence'));
  const core = makeCore(registry, { planner: fixed });
  const task = await core.submit('early objective');
  assertEqual(ran, ['achieve'], 'unnecessary actions did not execute');
  assertEqual(task.status, 'completed' as const, 'task completed with evidence');
  assertEqual(task.plan!.steps[1].status, 'skipped' as const, 'remaining step marked skipped (objective satisfied)');
}

// ---------------------------------------------------------------- Test 6: step failure
{
  console.log('Test 6: step failure recorded accurately');
  const registry = new ToolRegistry();
  registry.register(tool('boom', async () => fail('disk exploded', { retryable: false })));
  registry.register(tool('after', async () => ok()));
  const core = makeCore(registry);
  const task = await core.submit('boom then after');
  assertEqual(task.status, 'failed' as const, 'task failed');
  assert(task.error!.includes('disk exploded'), 'failure reason recorded');
  assertEqual(task.plan!.steps[1].status, 'skipped' as const, 'later step skipped');
  assert(task.summary!.includes('Failed — disk exploded'), 'summary reports the failure honestly');
}

// ---------------------------------------------------------------- Test 7: cancellation
{
  console.log('Test 7: cancellation of an active multi-step task');
  const registry = new ToolRegistry();
  registry.register(tool('quick', async () => ok()));
  registry.register(tool('waiter', async (_i, ctx) => new Promise((resolve) => { ctx.signal.addEventListener('abort', () => resolve(ok())); })));
  registry.register(tool('never', async () => { throw new Error('should not run'); }));
  const core = makeCore(registry);
  const pending = core.submit('quick then waiter then never');
  await new Promise((r) => setTimeout(r, 100));
  const running = core.store.list().find((t) => t.status === 'running');
  core.cancel(running!.id);
  const task = await pending;
  assertEqual(task.status, 'cancelled' as const, 'task cancelled');
  assert(task.plan!.steps[2].status === 'skipped' || task.plan!.steps[2].status === 'cancelled', 'no new step began after cancellation');
  assert(task.status !== 'completed', 'cancelled task not marked completed');
}

// ---------------------------------------------------------------- Test 8: timeout
{
  console.log('Test 8: controlled step timeout, state consistent');
  const registry = new ToolRegistry();
  registry.register(tool('hangs', async () => new Promise(() => { /* never resolves */ })));
  registry.register(tool('after', async () => ok()));
  const core = makeCore(registry, { stepTimeoutMs: 80 });
  const task = await core.submit('hangs then after');
  assertEqual(task.status, 'failed' as const, 'task failed after timeout');
  assert(task.error!.includes('timed out'), 'timeout recorded as the stop reason');
  assertEqual(task.plan!.steps[0].status, 'failed' as const, 'timed-out step failed');
  assertEqual(task.plan!.steps[1].status, 'skipped' as const, 'task state remains consistent');
}

// ---------------------------------------------------------------- Test 9: permission boundary
{
  console.log('Test 9: permission boundary cannot be bypassed');
  const registry = new ToolRegistry();
  let executed = false;
  const privileged = tool('privileged', async () => { executed = true; return ok(); });
  privileged.permissions = ['filesystem.write'];
  privileged.riskLevel = 'high';
  registry.register(privileged);
  const permissions = new PermissionManager(); // filesystem.write NOT granted
  const core = makeCore(registry, { permissions });
  const task = await core.submit('privileged');
  assertEqual(task.status, 'failed' as const, 'task stopped at the permission boundary');
  assertEqual(task.plan!.steps[0].result!.errorKind, 'permission_denied' as const, 'permission_denied classification');
  assertEqual(executed, false, 'privileged operation never executed');
}

// ---------------------------------------------------------------- Test 10: misleading success
{
  console.log('Test 10: misleading success does not claim completion');
  const registry = new ToolRegistry();
  registry.register(tool('liar', async () => ok({ output: { success: true, uncertain: true, note: 'dispatched but unconfirmed' } })));
  const core = makeCore(registry);
  const task = await core.submit('liar');
  assertEqual(task.plan!.steps[0].status, 'uncertain' as const, 'uncertain evidence → step marked uncertain');
  assert(task.summary!.includes('uncertain'), 'summary admits uncertainty');

  // output_contains verification catching a misleading result
  const registry2 = new ToolRegistry();
  registry2.register(tool('fakeDone', async () => ok({ output: { status: 'PENDING' } })));
  const goal = extractGoal('fakeDone');
  const plan = new HeuristicPlanner().makePlan(goal);
  plan.steps[0].verification = { type: 'output_contains', expected: 'COMPLETED' } as Verification;
  const fixed = new FixedPlanner(plan);
  const core2 = makeCore(registry2, { planner: fixed, maxAttemptsPerStep: 1 });
  const task2 = await core2.submit('fakeDone');
  assertEqual(task2.status, 'failed' as const, 'verification mismatch fails the step honestly');
}

// ---------------------------------------------------------------- planner chaining
{
  console.log('Planner chaining: search → read via context');
  const planner = new HeuristicPlanner();
  const plan = planner.makePlan(extractGoal('search the filesystem for krisha-phase10.txt then read krisha-phase10.txt'));
  assertEqual(plan.steps[0].toolName, 'filesystem.search', 'search step first');
  assertEqual(plan.steps[0].outputKey, 'found', 'search output captured into context');
  assertEqual(plan.steps[1].toolName, 'filesystem.read', 'read step second');
  assertEqual((plan.steps[1].input as any).path, { $context: 'found.matches.0.path' }, 'read chained to search result via $context');
}

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log('PHASE 10 TESTS: ALL GREEN');
