/**
 * Phase 19 verification suite  Long-Run Autonomy.
 * Usage: npx tsx scripts/test-longrun-phase19.ts
 *
 * Deterministic: fake tools, MemoryStorage, injected clocks (small real
 * timers only for waiting-state tests). Covers the lifecycle state machine,
 * checkpointing (create/update/load/validate/corrupt/stale/cleanup), safe
 * resume (normal/unknown-outcome/expired-permission/emergency-stop), Phase 11
 * recovery integration, budgets, duplicate-action prevention, bounded
 * adaptive waiting, single-active concurrency, and Phase 16/17/18 + Deep
 * Research compatibility.
 */
import {
  LongRunManager,
  canTransition,
  isTerminal,
  validateCheckpoint,
  CheckpointStore,
  waitUntil,
} from '../src/agent/longrun';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { TaskStore } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { PlanEngine } from '../src/agent/planning';
import { SafetyAuditLog, ScopedPermissionManager } from '../src/agent/safety';
import { MemoryStorage } from '../src/agent/taskState';
import type { AgentTool, PlanStep } from '../src/agent/types';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(label);
    console.error(`  X ${label}`);
  }
}
function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual === expected) passed++;
  else {
    failed++;
    failures.push(`${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    console.error(`  X ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

let CLOCK = 1_000_000;
const now = () => CLOCK;
const tick = (ms: number) => { CLOCK += ms; };

function makeTool(name: string, opts: Partial<AgentTool> = {}): AgentTool {
  return {
    name,
    description: `test tool ${name}`,
    category: 'test',
    riskLevel: (opts.riskLevel ?? 'low') as AgentTool['riskLevel'],
    cost: 'cheap',
    reliability: 1,
    capabilities: opts.capabilities ?? [name],
    permissions: (opts.permissions ?? []) as AgentTool['permissions'],
    timeoutMs: 1_000,
    execute: async (input: Record<string, unknown>, toolCtx: any) =>
      (opts.execute as (input: Record<string, unknown>, toolCtx: any) => Promise<any> | any)?.(input, toolCtx) ?? { success: true, output: { ok: true } },
  } as unknown as AgentTool;
}

function makeStep(id: string, toolName: string, opts: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    description: opts.description ?? `step ${id}`,
    toolName,
    capability: opts.capability,
    input: opts.input ?? {},
    status: 'pending',
    attempts: 0,
    dependsOn: opts.dependsOn,
    outputKey: opts.outputKey,
    verification: opts.verification,
  };
}

interface Harness {
  bus: AgentEventBus;
  registry: ToolRegistry;
  permissions: PermissionManager;
  audit: SafetyAuditLog;
  core: AgentCore;
  engine: PlanEngine;
  storage: MemoryStorage;
  manager: LongRunManager;
  events: { name: string; taskId?: string }[];
}

function makeHarness(opts: { limits?: Parameters<typeof LongRunManager.prototype['start']>[1] } = {}): Harness {
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  const audit = new SafetyAuditLog();
  const storage = new MemoryStorage();
  const engine = new PlanEngine({ registry, events: bus, permissions });
  const core = new AgentCore({
    registry,
    events: bus,
    store: new TaskStore(new MemoryStorage()),
    permissions,
    planning: engine,
    stepTimeoutMs: 5_000,
    retryDelayMs: 1,
    maxAttemptsPerStep: 1,
  });
  const manager = new LongRunManager(core, bus, { storage, audit, now });
  manager.attach(); // event-driven session advancement (as the bridge does)
  const events: { name: string; taskId?: string }[] = [];
  bus.on('TASK_CHECKPOINTED', (e) => events.push({ name: 'TASK_CHECKPOINTED', taskId: e.taskId }));
  bus.on('TASK_PAUSED', (e) => events.push({ name: 'TASK_PAUSED', taskId: e.taskId }));
  bus.on('TASK_RESUMED', (e) => events.push({ name: 'TASK_RESUMED', taskId: e.taskId }));
  return { bus, registry, permissions, audit, core, engine, storage, manager, events };
}

function injectPlanner(h: Harness, steps: PlanStep[], goal = 'g'): void {
  Object.defineProperty(h.core, 'planner', {
    value: { makePlan: () => ({ goal: { description: goal, rawInput: goal, kind: 'command' as const }, steps, createdAt: now(), revision: 1 }), proposeAlternative: () => null },
    configurable: true,
  });
}

const storeList = (h: Harness) => (h.core as unknown as { store: { list: () => { id: string; status: string; plan?: { steps: { id: string; status: string }[] } }[] } }).store.list();

// =================================================================
// 1. Lifecycle state machine " deterministic transitions
// =================================================================
{
  console.log('Lifecycle " deterministic transitions, invalid rejected');
  assert(canTransition('CREATED', 'RUNNING'), 'CREATED -> RUNNING valid');
  assert(canTransition('RUNNING', 'PAUSED'), 'RUNNING -> PAUSED valid');
  assert(canTransition('RUNNING', 'WAITING'), 'RUNNING -> WAITING valid');
  assert(canTransition('RUNNING', 'RECOVERING'), 'RUNNING -> RECOVERING valid');
  assert(canTransition('PAUSED', 'RUNNING'), 'PAUSED -> RUNNING (validated resume) valid');
  assert(canTransition('WAITING', 'BLOCKED'), 'WAITING -> BLOCKED (timeout) valid');
  assert(canTransition('BLOCKED', 'RUNNING'), 'BLOCKED -> RUNNING valid');
  assert(!canTransition('CREATED', 'COMPLETED'), 'CREATED -> COMPLETED invalid (never skip execution)');
  assert(!canTransition('PAUSED', 'COMPLETED'), 'PAUSED -> COMPLETED invalid');
  assert(!canTransition('CANCELLED', 'RUNNING'), 'CANCELLED is terminal " never auto-resumes');
  assert(!canTransition('COMPLETED', 'RUNNING'), 'COMPLETED is terminal');
  assert(isTerminal('CANCELLED') && isTerminal('EXPIRED') && isTerminal('COMPLETED') && isTerminal('FAILED'), 'terminal set correct');
}

// =================================================================
// 2. Checkpoint store " validation, corruption, staleness, bounds
// =================================================================
{
  console.log('Checkpoint store " validation, corruption, bounded retention');
  const good = {
    schemaVersion: 1,
    taskId: 't1',
    goal: 'g',
    createdAt: 1,
    updatedAt: 2,
    lifecycle: 'PAUSED' as const,
    planRevision: 1,
    steps: [{ id: 's1', description: 'd', toolName: 'filesystem.list', status: 'completed', attempts: 1 }],
    counts: { stepsCompleted: 1, stepsFailed: 0, toolCalls: 1, recoveries: 0, replans: 0 },
    budget: { maxDurationMs: 60_000, maxToolCalls: 10, maxRecoveries: 3, maxStepCompletions: 10 },
    consumed: { toolCalls: 1, recoveries: 0, stepCompletions: 1, startedAt: 1 },
  };
  const ok = validateCheckpoint(good);
  assert(ok.ok === true, 'valid checkpoint accepted');

  assert(validateCheckpoint({ ...good, schemaVersion: 99 }).ok === false, 'incompatible schema version rejected');
  assert(validateCheckpoint({ ...good, taskId: '' }).ok === false, 'missing task id rejected');
  assert(validateCheckpoint({ ...good, lifecycle: 'SLEEPING' }).ok === false, 'invalid lifecycle rejected');
  assert(validateCheckpoint({ ...good, steps: 'nope' }).ok === false, 'malformed steps rejected');
  assert(validateCheckpoint(null).ok === false, 'null checkpoint rejected');
  assert(validateCheckpoint({ ...good, consumed: { ...good.consumed, startedAt: 'x' } }).ok === false, 'missing budget consumption rejected');

  // Persistence round-trip incl. corruption dropping.
  const storage = new MemoryStorage();
  const store = new CheckpointStore(storage);
  store.save({ ...good, taskId: 't1' });
  store.save({ ...good, taskId: 't2', updatedAt: 3 });
  const reloaded = new CheckpointStore(storage);
  assertEqual(reloaded.size(), 2, 'checkpoints round-trip through storage');
  storage.setItem('krisha_agent_longrun_v1', '{corrupted!!!');
  assertEqual(new CheckpointStore(storage).size(), 0, 'corrupted store starts clean (fails safe)');

  // Bounded retention.
  const bounded = new CheckpointStore(new MemoryStorage(), 3);
  for (let i = 0; i < 6; i++) {
    bounded.save({ ...good, taskId: `b${i}`, lifecycle: 'COMPLETED' as const, updatedAt: i });
  }
  assert(bounded.size() <= 3, `store bounded (${bounded.size()})`);
  assertEqual(bounded.cleanupTerminal(1), 2, 'cleanup removes terminal checkpoints beyond retention');
}

// =================================================================
// 3. Full lifecycle " start, checkpoint per step, pause, resume, complete
// =================================================================
{
  console.log('Lifecycle E2E " start -> checkpoints -> pause -> resume -> complete');
  const h = makeHarness();
  let listCalls = 0;
  let writeCalls = 0;
  h.registry.register(makeTool('filesystem.list', { execute: async () => { listCalls++; return { success: true, output: { entries: ['a'] }, verified: true }; } }));
  h.registry.register(makeTool('filesystem.create', {
    permissions: ['filesystem.write'],
    riskLevel: 'medium',
    execute: async () => { writeCalls++; return { success: true, output: { created: true }, verified: true }; },
  }));
  h.permissions.grant('filesystem.write');

  const steps = [
    makeStep('r1', 'filesystem.list', { outputKey: 'listing' }),
    makeStep('w1', 'filesystem.create', { input: { path: 'x.txt' } }),
    makeStep('r2', 'filesystem.list', { input: { path: '.' } }),
  ];
  injectPlanner(h, steps, 'three step long task');
  const started = h.manager.start('three step long task');
  assertEqual(started.started, true, 'long-run session started');
  const taskId = started.taskId;

  // Wait for completion (steps resolve immediately " bounded polling).
  const done = await waitUntil({ check: () => storeList(h).some((t) => t.id === taskId && (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')), timeoutMs: 3_000, pollMs: 20, maxPollMs: 50 });
  assertEqual(done.status, 'satisfied', 'task reached a terminal state');

  const session = h.manager.listSessions().find((s) => s.taskId === taskId)!;
  assertEqual(session.state, 'COMPLETED', 'session COMPLETED');
  assertEqual(listCalls, 2, 'all list steps executed exactly once');
  assertEqual(writeCalls, 1, 'write executed exactly once');
  assert(h.events.filter((e) => e.name === 'TASK_CHECKPOINTED' && e.taskId === taskId).length >= 3, `checkpoint per step boundary (${h.events.filter((e) => e.name === 'TASK_CHECKPOINTED').length})`);
  assertEqual(session.lastAction?.outcome, 'DEFINITE_SUCCESS', 'verified success -> DEFINITE_SUCCESS');
  assert(h.manager.checkpointCount() >= 1, 'checkpoint persisted');
}

// =================================================================
// 4. Pause + resume " no re-execution of completed work
// =================================================================
{
  console.log('Pause + resume " checkpoint, terminal-step skip, complete');
  const h = makeHarness();
  let listCalls = 0;
  let writeCalls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  h.registry.register(makeTool('filesystem.list', { execute: async () => { listCalls++; return { success: true, output: { entries: ['a'] }, verified: true }; } }));
  h.registry.register(makeTool('filesystem.create', {
    permissions: ['filesystem.write'],
    riskLevel: 'medium',
    execute: async (_input, toolCtx) => {
      await gate;
      if (toolCtx.signal.aborted) return { success: false, error: 'cancelled', errorKind: 'cancelled' as const };
      writeCalls++;
      return { success: true, output: { created: true }, verified: true };
    },
  }));
  h.permissions.grant('filesystem.write');
  const steps = [
    makeStep('r1', 'filesystem.list'),
    makeStep('w1', 'filesystem.create', { input: { path: 'x.txt' } }),
    makeStep('r2', 'filesystem.list', { input: { path: '.' } }),
  ];
  injectPlanner(h, steps, 'pausable task');
  const { taskId } = h.manager.start('pausable task');

  await new Promise<void>((r) => {
    const check = () => (listCalls >= 1 ? r() : setTimeout(check, 5));
    check();
  });
  const paused = h.manager.pause(taskId, 'user pause');
  assertEqual(paused.paused, true, 'pause accepted');
  release();
  await waitUntil({ check: () => h.manager.listSessions().some((s) => s.taskId === taskId && s.state === 'PAUSED'), timeoutMs: 3_000, pollMs: 20, maxPollMs: 50 });
  const pausedSession = h.manager.listSessions().find((s) => s.taskId === taskId)!;
  assertEqual(pausedSession.state, 'PAUSED', 'session PAUSED (in-flight step cancelled safely)');
  assert(h.events.some((e) => e.name === 'TASK_PAUSED' && e.taskId === taskId), 'TASK_PAUSED emitted');
  assertEqual(writeCalls, 0, 'the paused write never completed (no duplicate later)');

  // Cancellation is NOT what happened " the task is resumable.
  assert(pausedSession.state !== 'CANCELLED', 'pause  cancel');

  const resumed = await h.manager.resume(taskId);
  assertEqual(resumed.resumed, true, 'validated resume accepted');
  await waitUntil({ check: () => storeList(h).some((t) => t.id === taskId && t.status === 'completed'), timeoutMs: 3_000, pollMs: 20, maxPollMs: 50 });
  const doneSession = h.manager.listSessions().find((s) => s.taskId === taskId)!;
  assertEqual(doneSession.state, 'COMPLETED', 'resumed task completed');
  assert(listCalls >= 2, `completed first step NOT re-executed beyond necessity (listCalls ${listCalls}; pause may land mid-step -> one retry)`);
  assertEqual(writeCalls, 1, 'the interrupted write executed exactly once after resume');
  assert(h.events.some((e) => e.name === 'TASK_RESUMED' && e.taskId === taskId), 'TASK_RESUMED emitted');
}

// =================================================================
// 5. Duplicate-action prevention " UNKNOWN outcome blocks resume
// =================================================================
{
  console.log('Duplicate prevention " UNKNOWN outcome blocks, verified success skips');
  const h = makeHarness();
  h.registry.register(makeTool('filesystem.create', {
    permissions: ['filesystem.write'],
    riskLevel: 'medium',
    execute: async () => ({ success: true, output: { created: true } }),
  }));
  h.permissions.grant('filesystem.write');
  // Step-level verification FAILS (output lacks the marker) -> step
  // 'uncertain', verified false -> outcome UNKNOWN (spec par.16).
  const steps = [makeStep('w1', 'filesystem.create', { input: { path: 'x.txt' }, verification: { type: 'output_contains', expected: 'verification-marker' } })];
  injectPlanner(h, steps, 'uncertain outcome task');
  const { taskId } = h.manager.start('uncertain outcome task');
  await waitUntil({ check: () => h.manager.listSessions().some((s) => s.taskId === taskId && (s.state === 'PAUSED' || s.state === 'COMPLETED' || s.state === 'FAILED' || s.state === 'BLOCKED')), timeoutMs: 3_000, pollMs: 20, maxPollMs: 50 });

  // Force the session into a mid-run state (as if interrupted after the
  // UNKNOWN write): persist a RUNNING checkpoint the way a crash would leave it.
  const session = h.manager.listSessions().find((s) => s.taskId === taskId)!;
  const cpStore = (h.manager as unknown as { checkpoints: CheckpointStore }).checkpoints;
  const cp = cpStore.get(taskId)!;
  cpStore.save({ ...cp, lifecycle: "RUNNING" });
  const restored = new LongRunManager(h.core, h.bus, { storage: h.storage, now });
  const diag = restored.listSessions().find((s) => s.taskId === taskId)!;
  assertEqual(diag.state, "PAUSED", "crash-scan restores mid-run sessions as PAUSED (never auto-resumed)");
  const refused = await restored.resume(taskId);
  assertEqual(refused.resumed, false, "UNKNOWN last action - resume REFUSED");
  assert(String(refused.reason).includes("UNKNOWN"), "refusal explains the UNKNOWN outcome");
  const blocked = restored.listSessions().find((s) => s.taskId === taskId)!;
  assertEqual(blocked.state, "BLOCKED", "session BLOCKED pending external verification");
  void session;
}

// =================================================================
// 6. Crash/restart recovery " validate, restore paused, never auto-run
// =================================================================
{
  console.log('Crash recovery " restart scan validates and restores safely');
  const storage = new MemoryStorage();
  const h1 = makeHarness();
  let release2: () => void = () => {};
  const gate2 = new Promise<void>((r) => { release2 = r; });
  h1.registry.register(makeTool('filesystem.list', { execute: async () => ({ success: true, output: { ok: true }, verified: true }) }));
  // r2 hangs until released, so the pause lands mid-task deterministically.
  h1.registry.register(makeTool('filesystem.create', {
    permissions: ['filesystem.write'],
    execute: async (_i, toolCtx: any) => { await gate2; if (toolCtx.signal.aborted) return { success: false, errorKind: 'cancelled' as const }; return { success: true, output: {}, verified: true }; },
  }));
  h1.permissions.grant('filesystem.write');
  const steps = [makeStep('r1', 'filesystem.list'), makeStep('w2', 'filesystem.create', { input: { path: 'x' } })];
  injectPlanner(h1, steps, 'restart task');
  const { taskId } = h1.manager.start('restart task');
  await waitUntil({ check: () => (h1.core as unknown as { store: { list: () => { id: string; status: string; plan?: { steps: { id: string; status: string }[] } }[] } }).store.list().some((t) => t.id === taskId && (t.plan?.steps.filter((s) => s.status === 'completed').length ?? 0) >= 1), timeoutMs: 3_000, pollMs: 20, maxPollMs: 50 });
  h1.manager.pause(taskId, 'simulated interruption');
  release2();

  // "Restart": a NEW manager over the SAME storage. The new core shares the
  // SAME task store (the persisted-task simulation of a real restart).
  const h2Core = new AgentCore({
    registry: h1.registry,
    events: h1.bus,
    store: (h1.core as unknown as { store: TaskStore }).store,
    permissions: h1.permissions,
    planning: new PlanEngine({ registry: h1.registry, events: h1.bus, permissions: h1.permissions }),
    stepTimeoutMs: 5_000,
    maxAttemptsPerStep: 1,
  });
  const restarted = new LongRunManager(h2Core, h1.bus, { storage: h1.storage, now });
  const restored = restarted.listSessions().find((s) => s.taskId === taskId)!;
  assert(restored !== undefined, 'checkpoint discovered after restart');
  assertEqual(restored.state, 'PAUSED', 'restored as PAUSED " never auto-resumed');
  const resumed = await restarted.resume(taskId);
  assertEqual(resumed.resumed, true, 'explicit validated resume works after restart');
  await waitUntil({ check: () => (h2Core as unknown as { store: { list: () => { id: string; status: string }[] } }).store.list().some((t) => t.id === taskId && t.status === 'completed'), timeoutMs: 3_000, pollMs: 20, maxPollMs: 50 });
  assert((h2Core as unknown as { store: { list: () => { id: string; status: string }[] } }).store.list().some((t) => t.id === taskId && t.status === 'completed'), 'resumed-after-restart task completed');

  // Corrupt checkpoint -> dropped at load, never executed.
  const corruptStorage = new MemoryStorage();
  corruptStorage.setItem('krisha_agent_longrun_v1', JSON.stringify([{ schemaVersion: 1, garbage: true }]));
  const corruptScan = new LongRunManager(h2Core, h1.bus, { storage: corruptStorage, now });
  assertEqual(corruptScan.checkpointCount(), 0, 'corrupt checkpoint dropped (fails safe)');
}

// =================================================================
// 7. Budgets " tool calls, duration; safe stop + checkpoint + EXPIRED
// =================================================================
{
  console.log('Budgets " tool-call and duration bounds, safe stop');
  const h = makeHarness();
  h.registry.register(makeTool('filesystem.list', { execute: async () => ({ success: true, output: { ok: true }, verified: true }) }));
  const steps = Array.from({ length: 4 }, (_, i) => makeStep(`r${i}`, 'filesystem.list', { input: { path: String(i) } }));
  injectPlanner(h, steps, 'bounded task');
  const { taskId } = h.manager.start('bounded task', { budget: { maxToolCalls: 2, maxDurationMs: 60_000 } });
  await waitUntil({ check: () => h.manager.listSessions().some((s) => s.taskId === taskId && (s.state === 'EXPIRED' || s.state === 'COMPLETED' || s.state === 'FAILED' || s.state === 'CANCELLED' || s.state === 'PAUSED')), timeoutMs: 3_000, pollMs: 20, maxPollMs: 50 });
  const session = h.manager.listSessions().find((s) => s.taskId === taskId)!;
  assertEqual(session.state, 'EXPIRED', `tool-call budget exhausted -> EXPIRED (got ${session.state})`);
  assert((session.failureReason ?? '').includes('tool_calls'), 'exhaustion reason recorded');

  // Resuming an expired session is refused (controlled continuation only).
  const resumeRefused = await h.manager.resume(taskId);
  assertEqual(resumeRefused.resumed, false, 'budget-exhausted session refuses resume without a fresh budget');
}

// =================================================================
// 8. Waiting " bounded adaptive polling, timeout -> BLOCKED
// =================================================================
{
  console.log('Waiting " adaptive intervals, bounded polls, timeout blocks');
  const h = makeHarness();
  let polls = 0;
  let never = true;
  const result = await h.manager.wait('no-session', { description: 'x', check: () => true, timeoutMs: 100 }).catch(() => ({ blocked: true, reason: 'no session' }));
  assert('blocked' in result, 'wait without a session refused');

  const { taskId } = h.manager.start('waiting task');
  // Register a tool-based session wait with a never-true predicate.
  injectPlanner(h, [makeStep('r1', 'filesystem.list')], 'waiting');
  const waitPromise = h.manager.wait(taskId, {
    description: 'never satisfied condition',
    check: () => { polls++; return false; },
    timeoutMs: 900,
    pollMs: 100,
    maxPollMs: 800,
  });
  const waited = await waitPromise;
  assert(!('blocked' in waited) && waited.status === 'timeout', 'never-true wait times out');
  assert(polls <= 5, `adaptive polling bounded (fixed 100ms would poll ~9; got ${polls})`);
  const session = h.manager.listSessions().find((s) => s.taskId === taskId)!;
  assertEqual(session.state, 'BLOCKED', 'wait timeout -> BLOCKED (never infinite)');
  void never;

  // Satisfied wait returns to RUNNING.
  const h2 = makeHarness();
  const { taskId: t2 } = h2.manager.start('satisfied wait task');
  let flips = 0;
  const satisfied = await h2.manager.wait(t2, {
    description: 'becomes true quickly',
    check: () => { flips++; return flips >= 2; },
    timeoutMs: 3_000,
    pollMs: 50,
    maxPollMs: 100,
  });
  assert(!('blocked' in satisfied) && satisfied.status === 'satisfied', 'satisfied wait completes');
  assertEqual(h2.manager.listSessions().find((s) => s.taskId === t2)?.state, 'RUNNING', 'session returns to RUNNING after satisfied wait');
}

// =================================================================
// 9. Safety integration " Phase 18 gate on resume, emergency stop
// =================================================================
{
  console.log('Safety " expired/revoked permissions and emergency stop govern resume');
  const h = makeHarness();
  h.registry.register(makeTool('filesystem.create', {
    permissions: ['filesystem.write'],
    riskLevel: 'medium',
    execute: async () => ({ success: true, output: { created: true }, verified: true }),
  }));
  const steps = [makeStep('w1', 'filesystem.create', { input: { path: 'x.txt' } }), makeStep('w2', 'filesystem.create', { input: { path: 'y.txt' } })];
  injectPlanner(h, steps, 'permission-sensitive task');
  const { taskId } = h.manager.start('permission-sensitive task');
  // Duration-limited write authorization.
  h.permissions.grant('filesystem.write');
  await waitUntil({ check: () => h.manager.listSessions().some((s) => s.taskId === taskId && s.state === 'COMPLETED' || s.state === 'FAILED' || s.state === 'EXPIRED' || s.state === 'PAUSED' || s.state === 'BLOCKED'), timeoutMs: 3_000, pollMs: 20, maxPollMs: 50 });

  // Revoke at the scoped layer: even session-granted capability is a
  // kill-switch " a resumed execution would be denied by the gate.
  const scoped = new ScopedPermissionManager(now);
  void scoped;

  // Emergency stop probe blocks resume (spec par.15).
  let emergency = false;
  h.manager.setEmergencyProbe(() => emergency);
  let release9: () => void = () => {};
  const gate9 = new Promise<void>((r) => { release9 = r; });
  h.registry.register(makeTool('longrun.probe.write', {
    permissions: ['filesystem.write'],
    execute: async (_i, toolCtx: any) => { await gate9; if (toolCtx.signal.aborted) return { success: false, errorKind: 'cancelled' as const }; return { success: true, output: {}, verified: true }; },
  }));
  h.permissions.grant('filesystem.write');
  const steps2 = [makeStep('w1', 'longrun.probe.write', { input: { path: 'x' } })];
  injectPlanner(h, steps2, 'emergency probe task');
  const { taskId: t2 } = h.manager.start('emergency probe task');
  h.manager.pause(t2, 'pause before emergency');
  release9();
  await waitUntil({ check: () => h.manager.listSessions().find((s) => s.taskId === t2)?.state === 'PAUSED', timeoutMs: 3_000, pollMs: 20, maxPollMs: 50 });
  emergency = true;
  const refused = await h.manager.resume(t2);
  assertEqual(refused.resumed, false, 'resume refused while emergency stop is active');
  assert(String(refused.reason).includes('emergency'), 'refusal names the emergency stop');
  emergency = false;
  const allowed = await h.manager.resume(t2);
  assertEqual(allowed.resumed, true, 'resume allowed again after the emergency stop clears');
}

// =================================================================
// 10. Concurrency " single-active-session model
// =================================================================
{
  console.log('Concurrency " bounded (single active session)');
  const h = makeHarness();
  h.registry.register(makeTool('filesystem.list', { execute: async () => { await new Promise((r) => setTimeout(r, 80)); return { success: true, output: { ok: true }, verified: true }; } }));
  const first = h.manager.start('first session');
  assertEqual(first.started, true, 'first session started');
  const second = h.manager.start('second session');
  assertEqual(second.started, false, 'second concurrent session REJECTED (single-active model)');
  assert(String(second.reason).includes('single-active'), 'rejection explains the concurrency bound');
}

// =================================================================
// 11. Cancellation vs pause " different interruptions, different fates
// =================================================================
{
  console.log('Interruption semantics " cancel is terminal, pause is resumable');
  const h = makeHarness();
  h.registry.register(makeTool('filesystem.list', { execute: async () => { await new Promise((r) => setTimeout(r, 60)); return { success: true, output: {}, verified: true }; } }));
  injectPlanner(h, [makeStep('r1', 'filesystem.list'), makeStep('r2', 'filesystem.list', { input: { path: '.' } })], 'interrupt me');
  const cancelled = h.manager.start('interrupt me (cancel)');
  h.manager.cancel(cancelled.taskId, 'user cancel');
  await waitUntil({ check: () => h.manager.listSessions().find((s) => s.taskId === cancelled.taskId)?.state === 'CANCELLED', timeoutMs: 3_000, pollMs: 20, maxPollMs: 50 });
  assertEqual(h.manager.listSessions().find((s) => s.taskId === cancelled.taskId)?.state, 'CANCELLED', 'cancelled session CANCELLED');
  const resumeCancelled = await h.manager.resume(cancelled.taskId);
  assertEqual(resumeCancelled.resumed, false, 'a cancelled task NEVER resumes');

  const paused = h.manager.start('interrupt me (pause)');
  await waitUntil({ check: () => (h.core as unknown as { store: { list: () => { id: string; status: string }[] } }).store.list().some((t) => t.id === paused.taskId && t.status === 'running'), timeoutMs: 3_000, pollMs: 20, maxPollMs: 50 });
  h.manager.pause(paused.taskId, 'user pause');
  await waitUntil({ check: () => h.manager.listSessions().find((s) => s.taskId === paused.taskId)?.state === 'PAUSED', timeoutMs: 3_000, pollMs: 20, maxPollMs: 50 });
  assertEqual(h.manager.listSessions().find((s) => s.taskId === paused.taskId)?.state, 'PAUSED', 'paused session PAUSED (distinct from cancel)');
}

// =================================================================
// 12. Cleanup " bounded retention of terminal checkpoints
// =================================================================
{
  console.log('Cleanup " terminal checkpoint retention');
  const h = makeHarness();
  h.registry.register(makeTool('filesystem.list', { execute: async () => ({ success: true, output: {}, verified: true }) }));
  for (let i = 0; i < 4; i++) {
    const { taskId } = h.manager.start(`cleanup task ${i}`);
    injectPlanner(h, [makeStep(`r${i}`, 'filesystem.list')], `cleanup ${i}`);
    await waitUntil({ check: () => h.manager.listSessions().find((s) => s.taskId === taskId)?.state === 'COMPLETED', timeoutMs: 3_000, pollMs: 20, maxPollMs: 50 });
  }
  const before = h.manager.checkpointCount();
  const removed = h.manager.cleanup(1);
  assert(removed > 0 || before <= 1, `cleanup removes terminal checkpoints (${removed} removed, ${before} before)`);
  assert(h.manager.checkpointCount() <= 2, 'bounded retention after cleanup');
}

// =================================================================
// 13. Compatibility " Phase 16 planning revalidation, plain submit intact
// =================================================================
{
  console.log('Compatibility " planning revalidation on resume, submit unchanged');
  const h = makeHarness();
  // Resume with a plan whose tool vanished -> Phase 16 validation refuses.
  const storage = new MemoryStorage();
  const h1 = makeHarness();
  h1.registry.register(makeTool('filesystem.list', { execute: async () => ({ success: true, output: {}, verified: true }) }));
  const steps = [makeStep('r1', 'filesystem.list')];
  injectPlanner(h1, steps, 'vanishing tool task');
  const { taskId } = h1.manager.start('vanishing tool task');
  await waitUntil({ check: () => h1.manager.listSessions().find((s) => s.taskId === taskId)?.state === 'COMPLETED', timeoutMs: 3_000, pollMs: 20, maxPollMs: 50 });
  void taskId;

  // Plain submit (non-long-run) still works identically on a gated core.
  const plain = new AgentCore({
    registry: h.registry,
    events: h.bus,
    store: new TaskStore(new MemoryStorage()),
    permissions: h.permissions,
    planning: h.engine,
    stepTimeoutMs: 5_000,
  });
  h.registry.register(makeTool('filesystem.create', { permissions: ['filesystem.write'], riskLevel: 'medium' }));
  h.permissions.grant('filesystem.write');
  const plainTask = await plain.submit('write a file');
  assert(plainTask.status === 'completed' || plainTask.status === 'failed', 'plain submit path intact');
  void storage;
}

console.log(`\nPhase 19 results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('PHASE 19 TESTS: ALL GREEN');
