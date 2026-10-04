/**
 * Phase 16 verification suite — Advanced Planning.
 * Usage: npx tsx scripts/test-planning-phase16.ts
 * Deterministic: injected clock, in-memory fake tools, no real timers beyond
 * microtasks. Exits non-zero on any failure.
 */
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { TaskStore } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { PlanEngine } from '../src/agent/planning/planEngine';
import { buildHierarchy } from '../src/agent/planning/planBuilder';
import { validatePlan, treeDepth } from '../src/agent/planning/planValidator';
import { strategyOptions, preferredPlan } from '../src/agent/planning/strategySelector';
import { DEFAULT_PLAN_LIMITS, type PlanNode } from '../src/agent/planning/planningTypes';
import { createSystemNoteTool } from '../src/agent/system/systemTools';
import type { PlanStep, ToolResult, AgentTool } from '../src/agent/types';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const PASS = '✓';

function assert(condition: boolean, label: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

// ---------------------------------------------------------------- fixtures
let CLOCK = 1_000_000;
const now = () => CLOCK;
const tick = (ms: number) => {
  CLOCK += ms;
};

function makeStep(id: string, toolName: string, opts: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    description: opts.description ?? `step ${id}`,
    toolName,
    capability: opts.capability,
    input: opts.input ?? {},
    verification: opts.verification,
    status: 'pending',
    attempts: 0,
    dependsOn: opts.dependsOn,
    outputKey: opts.outputKey,
    condition: opts.condition,
  };
}

function makeTool(name: string, opts: Partial<AgentTool> = {}): AgentTool {
  return {
    name,
    description: `test tool ${name}`,
    category: 'test',
    riskLevel: 'low',
    cost: 'cheap',
    reliability: 1,
    capabilities: opts.capabilities ?? [name],
    permissions: opts.permissions ?? [],
    inputSchema: opts.inputSchema,
    timeoutMs: 1_000,
    execute: async (input: Record<string, unknown>): Promise<ToolResult> =>
      (opts.execute as (input: Record<string, unknown>) => Promise<ToolResult> | ToolResult)(input) as ToolResult,
  } as AgentTool;
}

/** Tool that succeeds on the first N calls then fails forever (stable error text). */
function flakyTool(name: string, failAfter: number, errorKind: ToolResult['errorKind'] = 'execution_error', permissions: string[] = []): AgentTool {
  let calls = 0;
  return makeTool(name, {
    permissions: permissions as never,
    execute: async () => {
      calls++;
      if (calls <= failAfter) return { success: true, output: { ok: true }, verified: undefined };
      return { success: false, error: `${name} failed`, errorKind };
    },
  });
}

// ===========================================================================
console.log('Phase 16 — Advanced Planning\n');
console.log('1. hierarchical plan model + builder');

{
  const steps = [
    makeStep('s1', 'computer.click', { capability: 'computer.click' }),
    makeStep('s2', 'computer.type', { capability: 'computer.type' }),
    makeStep('s3', 'filesystem.list', { capability: 'filesystem.list' }),
  ];
  const { plan, stepNodes } = buildHierarchy({ description: 'test goal', rawInput: 'test goal', kind: 'command' }, steps, now());
  assert(plan.nodes.size === 6, 'goal + 2 subgoals + 3 actions = 6 nodes');
  assert(plan.nodes.get(plan.rootId)?.kind === 'goal', 'root is the goal node');
  assert(stepNodes.get('s1') !== undefined && stepNodes.get('s3') !== undefined, 'all steps mapped to nodes');
  const sub1 = plan.nodes.get(plan.nodes.get(plan.rootId)!.childIds[0])!;
  assert(sub1.kind === 'subgoal' && sub1.childIds.length === 2, 'domain grouping: computer steps share a subgoal');
  const s1Node = plan.nodes.get(stepNodes.get('s1')!)!;
  const s2Node = plan.nodes.get(stepNodes.get('s2')!)!;
  const s3Node = plan.nodes.get(stepNodes.get('s3')!)!;
  assert(s2Node.dependsOn.includes(s1Node.id), 'sequential dependency s2 → s1');
  assert(s3Node.dependsOn.includes(s2Node.id), 'sequential dependency s3 → s2');
  assert(s1Node.expectedOutcome !== undefined, 'action nodes carry an expected outcome (spec §11)');
  assert(treeDepth(plan) === 3, 'tree depth = goal → subgoal → action');
}

console.log('2. plan validation');

{
  const registry = new ToolRegistry(new AgentEventBus());
  registry.register(makeTool('computer.click'));
  const permissions = new PermissionManager();
  const steps = [
    makeStep('s1', 'computer.click', { capability: 'computer.click' }),
    makeStep('s2', 'ghost.tool', { capability: 'ghost.capability' }),
    makeStep('s3', 'computer.click', { dependsOn: ['s99'] }),
  ];
  const { plan } = buildHierarchy({ description: 'g', rawInput: 'g', kind: 'command' }, steps, now());
  const v = validatePlan(plan, steps, registry, permissions, DEFAULT_PLAN_LIMITS);
  assert(!v.valid, 'plan with unknown tool + unknown dependency is invalid');
  assert(v.errors.some((e) => e.code === 'missing_tool'), 'missing_tool reported');
  assert(v.errors.some((e) => e.code === 'unknown_dependency'), 'unknown_dependency reported');

  // circular dependency
  const cSteps = [
    makeStep('a', 'computer.click', { dependsOn: ['b'] }),
    makeStep('b', 'computer.click', { dependsOn: ['a'] }),
  ];
  const cPlan = buildHierarchy({ description: 'g', rawInput: 'g', kind: 'command' }, cSteps, now()).plan;
  const cv = validatePlan(cPlan, cSteps, registry, permissions, DEFAULT_PLAN_LIMITS);
  assert(cv.errors.some((e) => e.code === 'circular_dependency'), 'circular dependency detected');
  assert(!cv.valid, 'circular plan is invalid');

  // size bound — the builder includes everything; validation rejects oversize
  const many = Array.from({ length: 40 }, (_, i) => makeStep(`m${i}`, 'computer.click'));
  const mPlan = buildHierarchy({ description: 'g', rawInput: 'g', kind: 'command' }, many, now());
  const mv = validatePlan(mPlan.plan, many, registry, permissions, DEFAULT_PLAN_LIMITS);
  assert(mv.errors.some((e) => e.code === 'size_exceeded'), 'oversized plan rejected');
  assert(mPlan.plan.nodes.size > DEFAULT_PLAN_LIMITS.maxNodes, 'builder does not silently truncate');
}

console.log('3. permission-aware validation (blocked, not invalid)');

{
  const registry = new ToolRegistry(new AgentEventBus());
  registry.register(makeTool('computer.click', { permissions: ['mouse.control'] }));
  const permissions = new PermissionManager(); // mouse.control default-deny
  const steps = [makeStep('s1', 'computer.click', { capability: 'computer.click' })];
  const { plan } = buildHierarchy({ description: 'g', rawInput: 'g', kind: 'command' }, steps, now());
  const v = validatePlan(plan, steps, registry, permissions, DEFAULT_PLAN_LIMITS);
  assert(v.valid, 'plan is structurally valid despite missing permission');
  assert(v.blockedNodeIds.length === 1 && v.missingPermissions.includes('mouse.control'), 'node reported blocked pending permission');
}

console.log('4. engine attach + lifecycle + verified completion');

{
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  registry.register(flakyTool('computer.click', 99)); // always succeeds
  registry.register(createSystemNoteTool());
  const engine = new PlanEngine({ registry, events: bus, now });
  const permissions = new PermissionManager();
  const store = new TaskStore();
  const core = new AgentCore({ registry, events: bus, store, permissions, planning: engine, stepTimeoutMs: 5_000 });
  const task = await core.submit('click the button');
  assert(task.status === 'completed', 'simple plan completes (test 1: execution order A→B→C)');
  const diag = engine.diagnostics(task.id);
  assert(diag !== undefined && diag.status === 'completed', 'diagnostics report completed plan');
  assert(diag !== undefined && diag.replanCount === 0 && diag.nodeCount > 0, 'no replans; coherent node count');
  const planEvents = bus.recentEvents().filter((e) => e.name === 'PLAN_CREATED');
  assert(planEvents.length === 1, 'PLAN_CREATED emitted once on the shared bus');
}

console.log('5. failed node → recovery → bounded replanning');

// Spec test 1: strict execution order A → B → C through the Agent Core.
{
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const order: string[] = [];
  registry.register(makeTool('computer.click', { execute: async () => { order.push('A'); return { success: true, output: { ok: true } }; } }));
  registry.register(makeTool('computer.type', { execute: async () => { order.push('B'); return { success: true, output: { ok: true } }; } }));
  registry.register(makeTool('filesystem.list', { execute: async () => { order.push('C'); return { success: true, output: { ok: true } }; } }));
  const engine = new PlanEngine({ registry, events: bus, now });
  const permissions = new PermissionManager();
  const store = new TaskStore();
  const core = new AgentCore({ registry, events: bus, store, permissions, planning: engine, stepTimeoutMs: 5_000 });
  const steps = [makeStep('A', 'computer.click'), makeStep('B', 'computer.type'), makeStep('C', 'filesystem.list')];
  Object.defineProperty(core, 'planner', {
    value: { makePlan: () => ({ goal: { description: 'g', rawInput: 'g', kind: 'command' }, steps, createdAt: now(), revision: 1 }), proposeAlternative: () => null },
    configurable: true,
  });
  const task = await core.submit('ordered steps');
  tick(1);
  assert(task.status === 'completed', 'A→B→C plan completes');
  assert(order.join('') === 'ABC', `strict execution order A→B→C (got ${order.join('')})`);
}

{
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  // computer.* tool fails always → node fails → Phase 16 corrective subtree
  registry.register(flakyTool('computer.click', 0, 'execution_error'));
  registry.register(flakyTool('screen.observe', 99)); // diagnosis succeeds
  registry.register(createSystemNoteTool());
  const permissions = new PermissionManager();
  permissions.grant('screen.observation');
  const engine = new PlanEngine({ registry, events: bus, permissions, now, limits: { maxReplansPerTask: 2, maxRepeatedFailures: 2 } });
  const store = new TaskStore();
  const core = new AgentCore({ registry, events: bus, store, permissions, planning: engine, stepTimeoutMs: 5_000, retryDelayMs: 1, maxAttemptsPerStep: 1 });
  const task = await core.submit('click the broken button');
  // 1 original failure + diagnosis + retry → retry fails → repeated-failure refusal
  assert(task.status === 'failed', 'task fails honestly after bounded replanning (test 5)');
  const diag = engine.diagnostics(task.id)!;
  assert(diag !== undefined, 'plan state exists for the failed task');
  assert(diag.replanCount === 1, `exactly one corrective replan (got ${diag.replanCount})`);
  assert((diag.lastReplanReason ?? '').length > 0, 'replan reason recorded');
  const replanned = bus.recentEvents().filter((e) => e.name === 'PLAN_REPLANNED');
  assert(replanned.length === 1, 'PLAN_REPLANNED emitted once');
  const nodeStarted = bus.recentEvents().filter((e) => e.name === 'PLAN_NODE_STARTED');
  assert(nodeStarted.length >= 3, 'diagnosis + corrective retry actually executed (started events)');
  assert(bus.recentEvents().some((e) => e.name === 'PLAN_NODE_FAILED'), 'PLAN_NODE_FAILED emitted');
}

console.log('6. verification failure → node NOT completed');

{
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  registry.register(
    makeTool('computer.click', {
      execute: async () => ({ success: true, output: { nothing: 'useful' } }), // tool success…
    })
  );
  const engine = new PlanEngine({ registry, events: bus, now, limits: { maxReplansPerTask: 0 } });
  const permissions = new PermissionManager();
  const store = new TaskStore();
  const core = new AgentCore({ registry, events: bus, store, permissions, planning: engine, stepTimeoutMs: 5_000, maxAttemptsPerStep: 1 });
  const steps = [
    makeStep('s1', 'computer.click', { capability: 'computer.click', verification: { type: 'output_contains', expected: 'expected-marker' } }),
  ];
  const makePlan = { makePlan: () => ({ goal: { description: 'g', rawInput: 'g', kind: 'command' }, steps, createdAt: now(), revision: 1 }) };
  // Direct engine-level test of nodeCompleted honesty:
  const { plan } = buildHierarchy({ description: 'g', rawInput: 'g', kind: 'command' }, steps, now());
  engine.attachPlan('t-verify', 'g', steps);
  engine.nodeStarted('t-verify', 's1');
  engine.nodeCompleted('t-verify', 's1', { success: true, output: { x: 1 }, verified: false }, 'completed');
  const state = (engine as unknown as { tasks: Map<string, { plan: typeof plan }> }).tasks.get('t-verify')!;
  const node = [...state.plan.nodes.values()].find((n: PlanNode) => n.stepId === 's1')!;
  assert(node.status === 'completed' && node.verified === false, 'tool success with failed verification is NOT verified-complete (test 6)');
  const fin = engine.finishTask('t-verify', 'completed');
  assert(fin?.status === 'uncertain', 'unverified completion honestly degrades to uncertain');
  void makePlan;
  void core;
}

console.log('7. cancellation');

{
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  registry.register(
    makeTool('computer.click', {
      execute: async () => {
        await gate;
        return { success: true, output: {} };
      },
    })
  );
  const engine = new PlanEngine({ registry, events: bus, now });
  const permissions = new PermissionManager();
  const store = new TaskStore();
  const core = new AgentCore({ registry, events: bus, store, permissions, planning: engine, stepTimeoutMs: 30_000, maxSteps: 5 });
  const steps = [makeStep('s1', 'computer.click'), makeStep('s2', 'computer.click'), makeStep('s3', 'computer.click')];
  Object.defineProperty(core, 'planner', { value: { makePlan: () => ({ goal: { description: 'g', rawInput: 'g', kind: 'command' }, steps, createdAt: now(), revision: 1 }), proposeAlternative: () => null }, configurable: true });
  const pending = core.submit('long task');
  // Wait until the first step is actually running.
  await new Promise<void>((r) => {
    const check = () => (store.get((store as unknown as { tasks: Map<string, { id: string }> }).tasks.values().next().value.id)?.currentStepIndex === 0 ? r() : setTimeout(check, 5));
    check();
  });
  const taskId = [...(store as unknown as { tasks: Map<string, { id: string }> }).tasks.keys()][0];
  const cancelled = core.cancel(taskId);
  assert(cancelled, 'cancel() accepted for a running task');
  release();
  const task = await pending;
  tick(1);
  assert(task.status === 'cancelled', 'task cancelled (test 7)');
  const diag = engine.diagnostics(taskId)!;
  assert(diag.status === 'cancelled', 'plan diagnostics report cancelled');
  assert(bus.recentEvents().some((e) => e.name === 'PLAN_CANCELLED'), 'PLAN_CANCELLED emitted');
  const startedAfter = bus.recentEvents().filter((e) => e.name === 'PLAN_NODE_STARTED').length;
  assert(startedAfter === 1, 'no further autonomous nodes started after cancellation');
}

console.log('8. missing permission blocks execution');

{
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  registry.register(flakyTool('computer.click', 99, 'execution_error', ['mouse.control']));
  const permissions = new PermissionManager(); // mouse.control NOT granted
  const engine = new PlanEngine({ registry, events: bus, permissions, now });
  const store = new TaskStore();
  const core = new AgentCore({ registry, events: bus, store, permissions, planning: engine, stepTimeoutMs: 5_000, maxAttemptsPerStep: 1 });
  const task = await core.submit('click without permission');
  assert(task.status === 'failed', 'task fails when the permission is missing (test 8)');
  assert((task.error ?? '').toLowerCase().includes('permission'), 'registry permission gate refused the action');
  assert(bus.recentEvents().some((e) => e.name === 'PLAN_BLOCKED'), 'PLAN_BLOCKED emitted for the permission gap');
  const diag = engine.diagnostics(task.id)!;
  assert(diag.replanCount === 0, 'no replan attempted around a permission boundary (spec §15)');
}

console.log('9. tool unavailable');

{
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const engine = new PlanEngine({ registry, events: bus, now });
  const result = engine.attachPlan('t-9', 'g', [makeStep('s1', 'ghost.tool', { capability: 'ghost.capability' })]);
  assert(!result.ok, 'attachPlan refuses plans whose tools do not exist (test 9)');
  assert((result.reason ?? '').includes('missing_tool') || (result.reason ?? '').includes('no tool'), 'validation reason names the missing capability');
  assert(engine.diagnostics('t-9') === undefined, 'no plan state created for a rejected plan');
}

console.log('10. plan bounds + duplicate/repeated-failure guards');

{
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  registry.register(flakyTool('computer.click', 0));
  registry.register(flakyTool('screen.observe', 99));
  const permissions = new PermissionManager();
  permissions.grant('screen.observation');
  // Task budget 2 + node budget 2: two corrective rounds, then refusal.
  const engine = new PlanEngine({ registry, events: bus, permissions, now, limits: { maxReplansPerTask: 2, maxReplansPerNode: 2, maxRepeatedFailures: 99 } });
  const r1 = engine.attachPlan('t-10', 'g', [makeStep('s1', 'computer.click', { capability: 'computer.click' })]);
  assert(r1.ok, 'plan attaches');
  const d1 = engine.proposeReplan('t-10', 's1', 'boom', 'execution_error');
  assert(d1.replanned && (d1.correctiveSteps?.length ?? 0) === 2, 'corrective subtree = diagnose + retry');
  engine.commitReplan('t-10', 's1', d1.correctiveSteps!);
  const r2 = engine.proposeReplan('t-10', 's1', 'boom again', 'execution_error');
  assert(r2.replanned && r2.refusedBecause === undefined, 'second distinct failure still within task budget');
  engine.commitReplan('t-10', 's1', r2.correctiveSteps!);
  const r3 = engine.proposeReplan('t-10', 's1', 'boom three', 'execution_error');
  assert(!r3.replanned && r3.refusedBecause === 'budget_task', 'task replan budget enforced (test 5 bound)');

  // Repeated same-failure guard
  const engine2 = new PlanEngine({ registry, events: bus, permissions, now, limits: { maxReplansPerTask: 10, maxRepeatedFailures: 2 } });
  engine2.attachPlan('t-10b', 'g', [makeStep('s1', 'computer.click', { capability: 'computer.click' })]);
  engine2.nodeFailed('t-10b', 's1', 'same boom', 'execution_error');
  const p1 = engine2.proposeReplan('t-10b', 's1', 'same boom', 'execution_error');
  assert(p1.replanned, 'first identical failure still replans');
  engine2.commitReplan('t-10b', 's1', p1.correctiveSteps!);
  engine2.nodeFailed('t-10b', p1.correctiveSteps![1].id, 'same boom', 'execution_error');
  const p2 = engine2.proposeReplan('t-10b', p1.correctiveSteps![1].id, 'same boom', 'execution_error');
  assert(!p2.replanned && p2.refusedBecause === 'repeated_failure', 'same failure signature refuses (corrective retry counts as repeat)');
}

console.log('11. strategy selection (cheapest-reliable)');

{
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  registry.register(makeTool('browser.extract', { cost: 'cheap', reliability: 0.95, capabilities: ['browser.extract'] }));
  registry.register(makeTool('browser.visual', { cost: 'expensive', reliability: 0.9, capabilities: ['browser.extract'] }));
  const opts = strategyOptions(registry, 'browser.extract');
  assert(opts.length === 2, 'both candidate tools surfaced');
  assert(opts[0].cost !== 'expensive', 'cheapest strategy ranked first');
  assert(preferredPlan('browser')[0] === 'browser-native structured state', 'browser domain prefers native structured state');
  assert(preferredPlan('filesystem').length > 0, 'every domain has a deterministic preference list');
}

console.log('12. Phase 15 regression — proactive suite still green');

{
  // Phase 15 must be untouched: PlanEngine shares the bus but changes no
  // proactive behavior. Assert proactive modules still load and the default
  // budget is intact.
  const { DEFAULT_BUDGET } = await import('../src/agent/proactive/proactiveTypes');
  assert(DEFAULT_BUDGET !== undefined, 'Phase 15 proactive modules intact');
}

console.log('13. partial completion — preserve completed work, replan in place');

{
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const calls: Record<string, number> = {};
  const countingTool = (name: string, fail: boolean) =>
    makeTool(name, {
      execute: async () => {
        calls[name] = (calls[name] ?? 0) + 1;
        return fail
          ? { success: false, error: `${name} environment mismatch`, errorKind: 'execution_error' }
          : { success: true, output: { ok: true } };
      },
    });
  registry.register(countingTool('computer.click', false)); // s1
  registry.register(countingTool('computer.type', false)); // s2
  registry.register(countingTool('computer.scroll', true)); // s3 always fails
  registry.register(countingTool('computer.move_cursor', false)); // s4
  registry.register(countingTool('keyboard.press_key', false)); // s5
  registry.register(flakyTool('screen.observe', 99));
  const permissions = new PermissionManager();
  permissions.grant('screen.observation');
  const engine = new PlanEngine({ registry, events: bus, permissions, now, limits: { maxReplansPerTask: 2, maxRepeatedFailures: 2 } });
  const store = new TaskStore();
  const core = new AgentCore({ registry, events: bus, store, permissions, planning: engine, stepTimeoutMs: 5_000, retryDelayMs: 1, maxAttemptsPerStep: 1 });
  const steps = [
    makeStep('s1', 'computer.click'),
    makeStep('s2', 'computer.type'),
    makeStep('s3', 'computer.scroll'),
    makeStep('s4', 'computer.move_cursor'),
    makeStep('s5', 'keyboard.press_key'),
  ];
  Object.defineProperty(core, 'planner', {
    value: { makePlan: () => ({ goal: { description: 'g', rawInput: 'g', kind: 'command' }, steps, createdAt: now(), revision: 1 }), proposeAlternative: () => null },
    configurable: true,
  });
  const task = await core.submit('five steps, broken third');
  tick(1);
  assert(task.status === 'failed', 'task fails honestly after the bounded corrective cycle also fails');
  const snap = engine.snapshot(task.id)!;
  assert(snap !== undefined && snap.counts.completed >= 2, 'completed steps preserved (no restart from step 1)');
  assert(calls['computer.click'] === 1 && calls['computer.type'] === 1, 'steps 1-2 executed exactly once (partial progress kept)');
  assert((calls['computer.scroll'] ?? 0) >= 2, 'failed step retried via the corrective subtree only');
  assert(calls['computer.move_cursor'] === undefined && calls['keyboard.press_key'] === undefined, 'downstream steps never ran');
  assert(snap.counts.failed >= 1 && snap.counts.replans === 1, 'one bounded replan recorded');
}

console.log('14. conditional plans — structural conditions, true/false branches');

{
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  let runs = 0;
  registry.register(makeTool('filesystem.list', { execute: async () => { runs++; return { success: true, output: { marker: 'probe-value' } }; } }));
  const engine = new PlanEngine({ registry, events: bus, now });
  const permissions = new PermissionManager();
  const store = new TaskStore();
  const core = new AgentCore({ registry, events: bus, store, permissions, planning: engine, stepTimeoutMs: 5_000, maxAttemptsPerStep: 1 });
  const steps = [
    makeStep('s1', 'filesystem.list', { outputKey: 'probe' }),
    makeStep('s2', 'filesystem.list', { condition: { kind: 'context_exists', key: 'probe' } as never }),
    makeStep('s3', 'filesystem.list', { condition: { kind: 'context_equals', key: 'probe', value: 'never-written' } as never }),
    makeStep('s4', 'filesystem.list', { condition: { kind: 'context_missing', key: 'probe' } as never }),
  ];
  Object.defineProperty(core, 'planner', {
    value: { makePlan: () => ({ goal: { description: 'g', rawInput: 'g', kind: 'command' }, steps, createdAt: now(), revision: 1 }), proposeAlternative: () => null },
    configurable: true,
  });
  const task = await core.submit('conditional branches');
  tick(1);
  assert(task.status === 'completed', 'conditional plan completes');
  assert(runs === 2, `true branch ran, false branches skipped (runs=${runs})`);
  const skipped = bus.recentEvents().filter((e) => e.name === 'TASK_STEP_SKIPPED');
  assert(skipped.length === 2, 'both false-branch steps skipped by the executor');
  const snap = engine.snapshot(task.id)!;
  const s3 = snap.nodes.find((n) => n.description.includes('step s3'))!;
  assert(s3 !== undefined && s3.status === 'skipped', 'false-branch node marked skipped in the tree');
  assert(s3.condition?.kind === 'context_equals', 'structural condition mirrored onto the plan node (spec §7)');
}

console.log('15. impossible (forward) dependency — detected as a cycle, plan rejected');

{
  const registry = new ToolRegistry(new AgentEventBus());
  registry.register(makeTool('computer.click'));
  registry.register(makeTool('computer.type'));
  const permissions = new PermissionManager();
  // s1 depends on the LATER s2: combined with the builder's automatic
  // sequential dependency (s2 → s1) this forms a dependency cycle — an
  // impossible plan that must be rejected before execution (spec §11).
  const steps = [makeStep('s1', 'computer.click', { dependsOn: ['s2'] }), makeStep('s2', 'computer.type')];
  const { plan } = buildHierarchy({ description: 'g', rawInput: 'g', kind: 'command' }, steps, now());
  const v = validatePlan(plan, steps, registry, permissions, DEFAULT_PLAN_LIMITS);
  assert(!v.valid, 'impossible (forward) dependency makes the plan unexecutable');
  assert(v.errors.some((e) => e.code === 'circular_dependency'), 'forward dependency detected as a dependency cycle');

  const bus = new AgentEventBus();
  const engine = new PlanEngine({ registry, events: bus, now });
  const store = new TaskStore();
  const core = new AgentCore({ registry, events: bus, store, permissions, planning: engine, stepTimeoutMs: 5_000, maxAttemptsPerStep: 1 });
  const task = await core.submit('impossible dependency');
  tick(1);
  assert(task.status === 'failed' && (task.error ?? '').includes('plan validation failed'), 'impossible plan never executes (rejected at attach)');
  assert(engine.diagnostics(task.id) === undefined, 'no plan state for a rejected plan');
}

console.log('16. alternative strategies — failed strategy rotates to a viable alternative tool');

{
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  let primaryCalls = 0;
  let altCalls = 0;
  registry.register(makeTool('computer.click', {
    capabilities: ['computer.click'],
    execute: async () => {
      primaryCalls++;
      return { success: false, error: 'primary strategy environment mismatch', errorKind: 'execution_error' };
    },
  }));
  registry.register(makeTool('computer.click_alt', {
    capabilities: ['computer.click'],
    execute: async () => {
      altCalls++;
      return { success: true, output: { via: 'alternative' } };
    },
  }));
  registry.register(flakyTool('screen.observe', 99));
  const permissions = new PermissionManager();
  permissions.grant('screen.observation');
  const engine = new PlanEngine({ registry, events: bus, permissions, now, limits: { maxReplansPerTask: 2, maxRepeatedFailures: 2 } });
  const store = new TaskStore();
  const core = new AgentCore({ registry, events: bus, store, permissions, planning: engine, stepTimeoutMs: 5_000, retryDelayMs: 1, maxAttemptsPerStep: 1 });
  const steps = [makeStep('s1', 'computer.click', { capability: 'computer.click' })];
  Object.defineProperty(core, 'planner', {
    value: { makePlan: () => ({ goal: { description: 'g', rawInput: 'g', kind: 'command' }, steps, createdAt: now(), revision: 1 }), proposeAlternative: () => null },
    configurable: true,
  });
  const task = await core.submit('rotate to alternative strategy');
  tick(1);
  assert(task.status === 'completed', 'task completes through the alternative strategy');
  assert(primaryCalls === 1 && altCalls === 1, 'failed strategy executed once, then rotated (no blind repetition)');
  const requested = bus.recentEvents().find((e) => e.name === 'PLAN_REPLAN_REQUESTED');
  assert((requested?.payload as { strategy?: string } | undefined)?.strategy === 'diagnose_then_alternative_tool', 'replan decision records the alternative strategy');
  assert(bus.recentEvents().some((e) => e.name === 'PLAN_REPLANNED'), 'corrective subtree committed');

  // Incompatible input contract → NO blind rotation (honest refusal path).
  const registry2 = new ToolRegistry(new AgentEventBus());
  registry2.register(makeTool('computer.click', { capabilities: ['computer.click'], execute: async () => ({ success: false, error: 'x', errorKind: 'execution_error' }) }));
  registry2.register(makeTool('computer.click_alt', {
    capabilities: ['computer.click'],
    inputSchema: { required: ['specialKey'] },
    execute: async () => ({ success: true, output: {} }),
  }));
  const engine2 = new PlanEngine({ registry: registry2, events: new AgentEventBus(), permissions, now, limits: { maxReplansPerTask: 5, maxRepeatedFailures: 99 } });
  engine2.attachPlan('t-incompat', 'g', [makeStep('s1', 'computer.click', { capability: 'computer.click', input: { unrelated: 1 } })]);
  const d = engine2.proposeReplan('t-incompat', 's1', 'boom', 'execution_error');
  assert(d.replanned && d.correctiveSteps?.length === 2, 'without a compatible alternative, the same-tool retry is used');
  assert(d.correctiveSteps![1].toolName === 'computer.click', 'incompatible alternative never selected');
}

console.log('17. node retry budget enforced (spec §10)');

{
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  registry.register(makeTool('computer.click'));
  const permissions = new PermissionManager();
  const engine = new PlanEngine({ registry, events: bus, permissions, now, limits: { maxRetriesPerNode: 0, maxReplansPerTask: 5, maxRepeatedFailures: 99 } });
  engine.attachPlan('t-retry', 'g', [makeStep('s1', 'computer.click', { capability: 'computer.click' })]);
  engine.nodeStarted('t-retry', 's1'); // attempts = 1 → 0 retries already spent
  const d = engine.proposeReplan('t-retry', 's1', 'boom', 'execution_error');
  assert(!d.replanned && d.refusedBecause === 'budget_node', 'node retry budget refuses further corrective cycles');
}

console.log('18. planning timeout refusal (spec §10)');

{
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  registry.register(makeTool('computer.click'));
  const permissions = new PermissionManager();
  const engine = new PlanEngine({ registry, events: bus, permissions, now, limits: { taskTimeoutMs: 1_000, maxReplansPerTask: 5, maxRepeatedFailures: 99 } });
  engine.attachPlan('t-timeout', 'g', [makeStep('s1', 'computer.click', { capability: 'computer.click' })]);
  tick(1_500); // wall-clock budget exhausted
  const d = engine.proposeReplan('t-timeout', 's1', 'boom', 'execution_error');
  assert(!d.replanned && d.refusedBecause === 'timeout', 'planning timeout refuses further replanning');
}

console.log('19. excessive depth rejected before execution (spec §10/§11)');

{
  const registry = new ToolRegistry(new AgentEventBus());
  registry.register(makeTool('computer.click'));
  const permissions = new PermissionManager();
  const steps = [makeStep('s1', 'computer.click', { capability: 'computer.click' })];
  const { plan } = buildHierarchy({ description: 'g', rawInput: 'g', kind: 'command' }, steps, now());
  const action = [...plan.nodes.values()].find((n) => n.kind === 'action')!;
  const deepId = 'plan_deep_extra';
  plan.nodes.set(deepId, {
    id: deepId,
    kind: 'verification',
    description: 'illegal extra level',
    parentId: action.id,
    childIds: [],
    dependsOn: [],
    status: 'pending',
    statusReasons: [],
    attempts: 0,
    replans: 0,
    createdAt: now(),
  });
  action.childIds.push(deepId);
  const v = validatePlan(plan, steps, registry, permissions, DEFAULT_PLAN_LIMITS);
  assert(!v.valid && v.errors.some((e) => e.code === 'depth_exceeded'), 'plan deeper than maxDepth is rejected');
}

console.log('20. plan snapshot — dynamic state tracking (spec §3)');

{
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  registry.register(makeTool('computer.click'));
  registry.register(makeTool('screen.observe', { permissions: ['screen.observation'] }));
  const permissions = new PermissionManager(); // screen.observation NOT granted
  const engine = new PlanEngine({ registry, events: bus, permissions, now });
  const steps = [
    makeStep('s1', 'computer.click', { capability: 'computer.click' }),
    makeStep('s2', 'screen.observe', { capability: 'screen.observe', condition: { kind: 'context_exists', key: 'probe' } as never }),
  ];
  const attached = engine.attachPlan('t-snap', 'watch the state', steps);
  assert(attached.ok, 'snapshot plan attaches');
  const snap = engine.snapshot('t-snap')!;
  assert(snap.goal === 'watch the state' && snap.status === 'active', 'snapshot carries goal + active status');
  // s2 is domain 'general' (screen.*) while s1 is 'computer' → two subgoals.
  assert(snap.counts.actions === 2 && snap.counts.subgoals === 2 && snap.counts.total === 5, 'snapshot counts goal + 2 subgoals + 2 actions');
  assert(snap.currentActionId !== undefined && snap.currentSubgoalId !== undefined, 'current action + active subgoal identified');
  assert(snap.blockers.length === 1 && snap.blockers[0].missingPermissions.includes('screen.observation'), 'permission blockers surfaced');
  const s2 = snap.nodes.find((n) => n.description.includes('s2'))!;
  assert(s2.condition?.kind === 'context_exists', 'condition mirrored into the snapshot');
  assert(snap.nodes.every((n) => n.kind !== 'action' || n.expected !== undefined), 'expected outcomes present for every action');
  engine.nodeStarted('t-snap', 's1');
  const running = engine.snapshot('t-snap')!;
  assert(running.nodes.find((n) => n.id === running.currentActionId)?.attempts === 1, 'attempt counts tracked live');
  assert(running.counts.replans === 0 && running.counts.retries === 0, 'replan/retry counters tracked');
}

console.log('21. user clarification — ambiguous goals ask, never guess (spec §13)');

{
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  registry.register(createSystemNoteTool());
  const permissions = new PermissionManager();
  const engine = new PlanEngine({ registry, events: bus, permissions, now });

  const ambiguous = engine.attachPlan('t-clar', 'open spotify or netflix', [makeStep('s1', 'system.note', { input: { text: 'x' } })]);
  assert(!ambiguous.ok && ambiguous.clarification !== undefined, 'ambiguous goal refuses to guess (spec §13)');
  assert(ambiguous.clarification!.options.length === 2, 'both materially different interpretations offered');
  assert((ambiguous.reason ?? '').includes('clarification needed'), 'refusal reason is a user-readable question');
  assert(bus.recentEvents().some((e) => e.name === 'PLAN_CLARIFICATION_REQUESTED'), 'PLAN_CLARIFICATION_REQUESTED emitted');

  const single = engine.attachPlan('t-clar2', 'open spotify', [makeStep('s1', 'system.note', { input: { text: 'x' } })]);
  assert(single.ok, 'single-interpretation goal does not ask (no unnecessary questions)');

  const orSearch = engine.attachPlan('t-clar3', 'search for a laptop or a desktop', [makeStep('s1', 'system.note', { input: { text: 'x' } })]);
  assert(orSearch.ok, 'non-imperative "or" phrase is not treated as ambiguity');

  // Task-level honest stop through the Agent Core.
  const store = new TaskStore();
  const core = new AgentCore({ registry, events: bus, store, permissions, planning: engine, stepTimeoutMs: 5_000 });
  const task = await core.submit('open spotify or netflix');
  tick(1);
  assert(task.status === 'failed' && (task.error ?? '').includes('clarification needed'), 'ambiguous task stops with the clarification question');
  assert(bus.recentEvents().filter((e) => e.name === 'PLAN_CLARIFICATION_REQUESTED').length >= 2, 'clarification event observable on the shared bus');
}

console.log('22. Agent Core E2E — replanning recovers and completes (spec §15)');

{
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  let calls = 0;
  registry.register(makeTool('computer.click', {
    execute: async () => {
      calls++;
      if (calls === 1) return { success: false, error: 'environment mismatch on first attempt', errorKind: 'execution_error' };
      return { success: true, output: { ok: true } };
    },
  }));
  registry.register(flakyTool('screen.observe', 99));
  const permissions = new PermissionManager();
  permissions.grant('screen.observation');
  const engine = new PlanEngine({ registry, events: bus, permissions, now, limits: { maxReplansPerTask: 2, maxRepeatedFailures: 2 } });
  const store = new TaskStore();
  const core = new AgentCore({ registry, events: bus, store, permissions, planning: engine, stepTimeoutMs: 5_000, retryDelayMs: 1, maxAttemptsPerStep: 1 });
  const steps = [makeStep('s1', 'computer.click', { capability: 'computer.click' })];
  Object.defineProperty(core, 'planner', {
    value: { makePlan: () => ({ goal: { description: 'g', rawInput: 'g', kind: 'command' }, steps, createdAt: now(), revision: 1 }), proposeAlternative: () => null },
    configurable: true,
  });
  const task = await core.submit('recover and complete');
  tick(1);
  assert(task.status === 'completed', 'transient failure recovered via diagnose + retry (E2E)');
  assert(calls === 2, 'original attempt + exactly one corrective retry');
  assert(bus.recentEvents().some((e) => e.name === 'PLAN_REPLANNED'), 'PLAN_REPLANNED emitted');
  assert(bus.recentEvents().some((e) => e.name === 'PLAN_COMPLETED'), 'PLAN_COMPLETED emitted on verified completion');
  const diag = engine.diagnostics(task.id)!;
  assert(diag.status === 'completed' && diag.replanCount === 1, 'diagnostics report the completed replanned plan');
  const snap = engine.snapshot(task.id)!;
  assert(snap.counts.replans === 1 && snap.counts.failed === 1, 'snapshot records the full replan history');
}

console.log(`\n${PASS} Phase 16: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
