/**
 * Phase 18 verification suite — Safety + Permission Hardening.
 * Usage: npx tsx scripts/test-safety-phase18.ts
 *
 * Deterministic: fake clocks, injected managers, fake tools, no network, no
 * real UI. Covers permissions (safe/confirm/deny/expired/revoked/scoped),
 * risk classification (destructive/irreversible/local-external/bulk/force/
 * fail-closed), agent/planner/plan-engine/retry/replan/proactive/browser/
 * filesystem/application safety, emergency stop (cancellation, temporary
 * revocation, recovery), bounded redacted audit, and Phase 16/17/Deep
 * Research compatibility.
 */
import {
  classifyRisk,
  SafetyAuditLog,
  SafetyGate,
  ScopedPermissionManager,
  EmergencyStop,
  createSafetyTools,
} from '../src/agent/safety';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { PlanEngine } from '../src/agent/planning';
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
    inputSchema: opts.inputSchema,
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
    condition: opts.condition,
  };
}

interface Harness {
  bus: AgentEventBus;
  registry: ToolRegistry;
  permissions: PermissionManager;
  scoped: ScopedPermissionManager;
  audit: SafetyAuditLog;
  emergencyStop: EmergencyStop;
  gate: SafetyGate;
  core: AgentCore;
  engine: PlanEngine;
}

function makeHarness(opts: { requireConfirmationForHighRisk?: boolean } = {}): Harness {
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  const scoped = new ScopedPermissionManager(now);
  const audit = new SafetyAuditLog();
  const emergencyStop = new EmergencyStop(audit);
  const gate = new SafetyGate({
    permissions,
    scoped,
    emergencyStop,
    audit,
    requireConfirmationForHighRisk: opts.requireConfirmationForHighRisk === true,
    now,
  });
  registry.setSafetyGate(gate);
  // Bridge contract: emergency stop cancels tasks + revokes temporary grants.
  emergencyStop.onActivate(() => {
    try {
      core.cancelAll();
    } catch {
      // best-effort — the gate still blocks side effects
    }
    scoped.revokeAllTemporary();
  });
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
  return { bus, registry, permissions, scoped, audit, emergencyStop, gate, core, engine };
}

const ctx = (h: Harness, taskId = 't1') => ({
  taskId,
  stepId: 's1',
  signal: new AbortController().signal,
  memory: {},
  permissions: h.permissions,
});

// =================================================================
// 1. Risk classification — deterministic table
// =================================================================
{
  console.log('Risk classification — destructive, reversible, local/external, bulk, force, fail-closed');
  assertEqual(classifyRisk('filesystem.delete', 'high', {}).klass, 'high_risk', 'delete → high_risk (irreversible)');
  assertEqual(classifyRisk('application.close', 'high', { force: true }).klass, 'high_risk', 'force close → high_risk');
  assertEqual(classifyRisk('filesystem.create', 'medium', {}).klass, 'confirm', 'create → confirm (write, reversible)');
  assertEqual(classifyRisk('filesystem.list', 'low', {}).klass, 'safe', 'list → safe (read-only)');
  assertEqual(classifyRisk('filesystem.read', 'low', {}).klass, 'safe', 'read → safe');
  assertEqual(classifyRisk('browser.navigate', 'low', {}).klass, 'confirm', 'browser navigation → confirm (external)');
  assertEqual(classifyRisk('web.open_website', 'low', {}).klass, 'confirm', 'web open → confirm (external side effect)');
  assertEqual(classifyRisk('model.route', 'safe', {}).klass, 'safe', 'routing decision → safe (local)');
  assertEqual(classifyRisk('application.close', 'medium', { force: true }).klass, 'high_risk', 'force flag escalates medium → high_risk');
  assertEqual(
    classifyRisk('filesystem.delete', 'high', { paths: Array.from({ length: 8 }, (_, i) => `f${i}.txt`) }).klass,
    'high_risk',
    'bulk targets → high_risk'
  );
  assert(classifyRisk('filesystem.delete', 'high', {}).factors.some((f) => f.includes('irreversible')), 'factors name the reason');

  // Determinism: same inputs → same classification.
  const a = classifyRisk('filesystem.move', 'medium', { overwrite: true });
  const b = classifyRisk('filesystem.move', 'medium', { overwrite: true });
  assertEqual(a.klass, b.klass, 'classification deterministic');

  // Fail-closed: unknown risk declaration never classifies safe.
  assertEqual(classifyRisk('mystery.tool', undefined, {}).klass, 'high_risk', 'unknown declaration → fail closed');
}

// =================================================================
// 2. Permission decisions — safe/confirm/deny/expired/revoked/scoped
// =================================================================
{
  console.log('Permission decisions — through the central gate');
  const h = makeHarness();
  h.registry.register(makeTool('filesystem.read', { permissions: ['filesystem.read'] }));
  h.registry.register(makeTool('filesystem.create', { permissions: ['filesystem.write'], riskLevel: 'medium' }));
  h.registry.register(makeTool('filesystem.delete', { permissions: ['filesystem.write'], riskLevel: 'high' }));
  h.registry.register(makeTool('mystery.tool', { permissions: ['not.a.real.permission' as never] }));

  // Session grant (existing architecture): allowed, audited.
  h.permissions.grant('filesystem.read');
  h.permissions.grant('filesystem.write');
  const read = await h.registry.execute('filesystem.read', { path: '.' }, ctx(h));
  assert(read.success, 'safe action allowed within session grant');
  assertEqual((read.metadata?.safety as any)?.decision, 'allow', 'structured ALLOW decision');
  assertEqual((read.metadata?.safety as any)?.klass, 'safe', 'read classified safe');

  const create = await h.registry.execute('filesystem.create', { path: 'x.txt' }, ctx(h));
  assert(create.success, 'write allowed within session grant (no behavior change)');
  assertEqual((create.metadata?.safety as any)?.klass, 'confirm', 'write classified confirm');

  const del = await h.registry.execute('filesystem.delete', { path: 'x.txt' }, ctx(h));
  assert(del.success, 'high-risk allowed within session grant (default mode preserves legitimate flows)');
  assertEqual((del.metadata?.safety as any)?.klass, 'high_risk', 'delete classified high_risk + audited');

  // Deny: base layer (authoritative) lacks the grant — a fresh harness whose
  // PermissionManager has no filesystem.write.
  const hDenied = makeHarness();
  hDenied.registry.register(makeTool('filesystem.create', { permissions: ['filesystem.write'], riskLevel: 'medium' }));
  const denied = await hDenied.registry.execute('filesystem.create', { path: 'x' }, ctx(hDenied));
  assert(!denied.success && denied.errorKind === 'permission_denied', 'ungranted action denied (authoritative base layer)');
  assertEqual((denied.metadata?.safety as any)?.decision, 'deny', 'structured DENY decision');

  // Fail closed: unknown permission id is a defect, never an implicit allow.
  const mystery = await h.registry.execute('mystery.tool', {}, ctx(h));
  assert(!mystery.success && String(mystery.error).includes('unknown permission'), 'unknown permission id → fail closed');

  // High-risk confirmation mode (optional policy, spec §3).
  const strict = makeHarness({ requireConfirmationForHighRisk: true });
  strict.permissions.grant('filesystem.write');
  strict.registry.register(makeTool('filesystem.delete', { permissions: ['filesystem.write'], riskLevel: 'high' }));
  const needsConfirm = await strict.registry.execute('filesystem.delete', { path: 'x' }, ctx(strict));
  assert(!needsConfirm.success && (needsConfirm.metadata?.safety as any)?.decision === 'require_confirmation', 'high-risk requires confirmation in strict mode');
  strict.scoped.grant({ permission: 'safety.high_risk_ack', scope: { kind: 'session' }, reason: 'user acknowledged high-risk operations' });
  const confirmed = await strict.registry.execute('filesystem.delete', { path: 'x' }, ctx(strict));
  assert(confirmed.success, 'explicit high-risk authorization satisfies confirmation');
}

// =================================================================
// 3. Scoped grants — once / task / duration / revoked
// =================================================================
{
  console.log('Scoped grants — one-shot, task-bound, expiring, revocable');
  const h = makeHarness();
  // Base layer leaves filesystem.write DENIED by default; only scoped grants
  // can satisfy it (spec §5: scoped grants work, session grants are not faked).
  h.registry.register(makeTool('filesystem.create', { permissions: ['filesystem.write'], riskLevel: 'medium' }));

  // One-shot: first use allowed, second use denied.
  h.scoped.grant({ permission: 'filesystem.write', scope: { kind: 'once' }, reason: 'user approved this single write' });
  const first = await h.registry.execute('filesystem.create', { path: 'one.txt' }, ctx(h, 'task-a'));
  assert(first.success, 'one-shot grant allows exactly one action');
  const second = await h.registry.execute('filesystem.create', { path: 'two.txt' }, ctx(h, 'task-a'));
  assert(!second.success && (second.metadata?.safety as any)?.decision === 'deny', 'second action after one-shot grant denied (no silent reuse)');

  // Task-bound: applies only to the granted task.
  h.scoped.grant({ permission: 'filesystem.write', scope: { kind: 'task', taskId: 'task-7' }, reason: 'per-task approval' });
  const inTask = await h.registry.execute('filesystem.create', { path: 't7.txt' }, ctx(h, 'task-7'));
  assert(inTask.success, 'task-scoped grant allows the granted task');
  const otherTask = await h.registry.execute('filesystem.create', { path: 'other.txt' }, ctx(h, 'task-8'));
  assert(!otherTask.success, 'task-scoped grant does NOT leak to other tasks');

  // Duration: expiring authorization is rejected, never silently reused.
  h.scoped.grant({ permission: 'filesystem.write', scope: { kind: 'duration', expiresAt: now() + 1_000 }, reason: 'short-lived approval' });
  const withinWindow = await h.registry.execute('filesystem.create', { path: 'w.txt' }, ctx(h, 'task-9'));
  assert(withinWindow.success, 'duration grant valid before expiry');
  tick(1_500);
  const afterExpiry = await h.registry.execute('filesystem.create', { path: 'w2.txt' }, ctx(h, 'task-9'));
  assert(!afterExpiry.success && (afterExpiry.metadata?.safety as any)?.decision === 'deny', 'expired grant rejected (EXPIRED → request again)');

  // Revocation: immediate, even with a valid grant + session base.
  h.permissions.grant('filesystem.write');
  h.scoped.grant({ permission: 'filesystem.write', scope: { kind: 'session' }, reason: 'session approval' });
  const beforeRevoke = await h.registry.execute('filesystem.create', { path: 'ok.txt' }, ctx(h, 'task-10'));
  assert(beforeRevoke.success, 'valid grant works before revocation');
  h.scoped.revoke('filesystem.write');
  const afterRevoke = await h.registry.execute('filesystem.create', { path: 'nope.txt' }, ctx(h, 'task-10'));
  assert(!afterRevoke.success && (afterRevoke.metadata?.safety as any)?.decision === 'revoked', 'revoked permission immediately denied (structured REVOKED decision)');
  assert(h.scoped.count() === 0, 'no stale grant objects remain after revocation');
}

// =================================================================
// 4. Agent Core / planner / plan engine / retry / replan safety
// =================================================================
{
  console.log('Agent integration — core, planner, plan engine, retry, replan');
  const h = makeHarness();
  h.registry.register(makeTool('computer.click', { permissions: ['mouse.control'], riskLevel: 'low', execute: async () => { throw new Error('should never execute'); } }));
  // mouse.control is default-deny → planner produces the step, the gate refuses.
  const steps = [makeStep('s1', 'computer.click', { capability: 'computer.click' })];
  Object.defineProperty(h.core, 'planner', {
    value: { makePlan: () => ({ goal: { description: 'g', rawInput: 'g', kind: 'command' as const }, steps, createdAt: now(), revision: 1 }), proposeAlternative: () => null },
    configurable: true,
  });
  const deniedTask = await h.core.submit('click the button');
  tick(1);
  assert(deniedTask.status === 'failed', 'planner intent does NOT execute without permission (planning creates intent, safety decides)');
  assert((deniedTask.error ?? '').toLowerCase().includes('permission') || (deniedTask.error ?? '').includes('Safety gate'), 'denial reason surfaced');
  assertEqual(deniedTask.plan?.steps[0].attempts, 1, 'retries do NOT re-attempt a safety denial (bounded, no bypass)');

  // Replanning must not route around the denial.
  const replan = h.engine.proposeReplan(deniedTask.id, deniedTask.plan!.steps[0].id, 'Safety gate: deny — missing permission', 'permission_denied');
  assert(!replan.replanned && replan.refusedBecause === 'not_replannable', 'replanning never routes around a permission denial');

  // With a task-scoped grant, the plan's write executes for that task only
  // (deterministic tool-level check of task scoping).
  const h2 = makeHarness();
  h2.registry.register(makeTool('filesystem.create', { permissions: ['filesystem.write'], riskLevel: 'medium' }));
  h2.scoped.grant({ permission: 'filesystem.write', scope: { kind: 'task', taskId: 'task-7' }, reason: 'per-task approval' });
  const inScope = await h2.registry.execute('filesystem.create', { path: 't7.txt' }, ctx(h2, 'task-7'));
  assert(inScope.success, 'task grant covers its own task');
  const outOfScope = await h2.registry.execute('filesystem.create', { path: 'other.txt' }, ctx(h2, 'task-8'));
  assert(!outOfScope.success, 'task grant does not cover another task');

  // Planner-produced plans still cannot exceed the (now scoped) boundary:
  const planSteps = [makeStep('w1', 'filesystem.create', { input: { path: 'planned.txt' } })];
  Object.defineProperty(h2.core, 'planner', {
    value: { makePlan: () => ({ goal: { description: 'g', rawInput: 'g', kind: 'command' as const }, steps: planSteps, createdAt: now(), revision: 1 }), proposeAlternative: () => null },
    configurable: true,
  });
  const plannedDenied = await h2.core.submit('write the file');
  tick(1);
  assert(plannedDenied.status === 'failed', 'planner intent outside any grant does not execute (planning creates intent, safety decides)');
}

// =================================================================
// 5. Emergency stop — cancellation, side-effect block, recovery
// =================================================================
{
  console.log('Emergency stop — cancel tasks, block side effects, stay recoverable');
  const h = makeHarness();
  let release: () => void = () => {};
  const gatePromise = new Promise<void>((r) => { release = r; });
  let sideEffects = 0;
  h.permissions.grant('filesystem.write');
  h.registry.register(makeTool('filesystem.create', {
    permissions: ['filesystem.write'],
    riskLevel: 'medium',
    // Well-behaved tool: honors the abort signal BEFORE its side effect.
    execute: async (_input, toolCtx) => {
      await gatePromise;
      if (toolCtx.signal.aborted) return { success: false, error: 'cancelled before side effect', errorKind: 'cancelled' as const };
      sideEffects++;
      return { success: true, output: {} };
    },
  }));
  h.registry.register(makeTool('filesystem.read', { permissions: ['filesystem.read'], execute: async () => ({ success: true, output: { ok: true } }) }));
  h.permissions.grant('filesystem.read');

  const steps = [
    makeStep('s1', 'filesystem.create', { input: { path: 'stuck.txt' } }),
    makeStep('s2', 'filesystem.create', { input: { path: 'after.txt' } }),
  ];
  Object.defineProperty(h.core, 'planner', {
    value: { makePlan: () => ({ goal: { description: 'g', rawInput: 'g', kind: 'command' as const }, steps, createdAt: now(), revision: 1 }), proposeAlternative: () => null },
    configurable: true,
  });
  const running = h.core.submit('long write task');
  await new Promise<void>((r) => {
    const check = () => ((h.core as unknown as { store: { list: () => { id: string; status: string }[] } }).store.list().some((t) => t.status === 'running' && (t as any).plan) ? r() : setTimeout(check, 5));
    check();
  });

  // EMERGENCY STOP — the harness hook cancels the running task + revokes
  // temporary grants (mirroring the bridge wiring).
  h.emergencyStop.activate('operator halt');
  release();
  const stoppedTask = await running;
  tick(1);
  assert(stoppedTask.status === 'cancelled', `active task cancelled by emergency stop (got ${stoppedTask.status})`);
  assertEqual(sideEffects, 0, 'the in-flight side effect never completed (signal honored)');

  // New side-effecting actions are blocked; read-only work continues.
  const blocked = await h.registry.execute('filesystem.create', { path: 'blocked.txt' }, ctx(h, 'post-stop'));
  assert(!blocked.success && (blocked.metadata?.safety as any)?.decision === 'deny', 'side-effecting action blocked during emergency stop');
  const readable = await h.registry.execute('filesystem.read', { path: '.' }, ctx(h, 'post-stop'));
  assert(readable.success, 'read-only work continues during emergency stop (operator visibility)');

  // Recovery: resume → normal permission-checked operation.
  h.emergencyStop.deactivate();
  const resumed = await h.registry.execute('filesystem.create', { path: 'resumed.txt' }, ctx(h, 'post-stop'));
  assert(resumed.success, `system fully recoverable after resume (error: ${resumed.error ?? 'none'})`);
  assert(h.audit.recent(50).some((e) => e.kind === 'emergency_stop' && e.reason?.includes('operator halt')), 'emergency stop audited with reason');
}

// =================================================================
// 6. Audit log — bounded, redacted
// =================================================================
{
  console.log('Audit log — bounded ring, redaction, no secret leakage');
  const audit = new SafetyAuditLog();
  for (let i = 0; i < 300; i++) {
    audit.append({
      kind: i % 2 === 0 ? 'executed' : 'blocked',
      tool: `tool${i}`,
      decision: i % 2 === 0 ? 'allow' : 'deny',
      klass: 'safe',
      permission: 'filesystem.read',
      reason: `attempt with password: hunter${i} and api_key=SK_supersecret${i}`,
      inputKeys: ['path', 'token'],
      taskId: `t${i}`,
    });
  }
  assertEqual(audit.count(), 200, 'audit ring bounded at 200 entries');
  const recent = audit.recent(5);
  assert(recent.every((e) => !/hunter|SK_supersecret/.test(e.reason ?? '')), 'secrets redacted from audit reasons');
  assert(recent.every((e) => !JSON.stringify(e).includes('hunter')), 'no secret material anywhere in entries');
  assert(recent.every((e) => !e.inputKeys?.some((k) => /hunter|secret/.test(k))), 'input keys stored, never values');
}

// =================================================================
// 7. Safety tools — status, emergency stop, audit; NO self-grant
// =================================================================
{
  console.log('Safety tools — visibility + control, never self-authorization');
  const h = makeHarness();
  h.registry.registerAll(createSafetyTools({ gate: h.gate, scoped: h.scoped, audit: h.audit, emergencyStop: h.emergencyStop }));
  const c = ctx(h, 'safety-tools');
  const status = await h.registry.execute('safety.status', {}, c);
  assert(status.success && (status.output as any).emergencyStop.active === false, 'safety.status readable through the registry');
  const stop = await h.registry.execute('safety.emergency_stop', { activate: true, reason: 'tool-invoked halt' }, c);
  assert(stop.success && (stop.output as any).active === true, 'emergency stop operable through the registry');
  const blockedDuring = await h.registry.execute('safety.emergency_stop', { activate: false }, c);
  assert(blockedDuring.success, 'resume operable (stop is itself audited, not blocked)');
  const auditRead = await h.registry.execute('safety.audit', { limit: 10 }, c);
  assert(auditRead.success && (auditRead.output as any).entries.length >= 2, 'audit readable through the registry');
  // NO tool in the registry can grant permissions.
  const toolNames = h.registry.names();
  assert(!toolNames.some((n) => /grant|authorize/i.test(n)), 'no self-grant tool exists (agent cannot widen its own permissions)');
  h.emergencyStop.deactivate();
}

// =================================================================
// 8. Compatibility — Phase 16 planning, Phase 17 routing, Deep Research
// =================================================================
{
  console.log('Compatibility — Phase 16, Phase 17, Deep Research under the gate');
  const h = makeHarness();
  // Phase 17: routing decisions execute (safe class) with the gate active.
  const routeTool: AgentTool = {
    name: 'model.route',
    description: 'route',
    category: 'system',
    riskLevel: 'safe',
    capabilities: ['model.route'],
    permissions: [],
    timeoutMs: 1_000,
    execute: async () => ({ success: true, output: { model: 'gemini-3.1-flash-lite' } }),
  } as unknown as AgentTool;
  h.registry.register(routeTool);
  const routed = await h.registry.execute('model.route', { task: 'hi' }, ctx(h));
  assert(routed.success, 'Phase 17 routing unaffected by the safety gate');

  // Phase 16: plan validation + execution semantics unchanged; the gate adds
  // an execution-time layer (blocked nodes for missing permissions still work).
  h.registry.register(makeTool('computer.click', { permissions: ['mouse.control'] }));
  const steps = [makeStep('s1', 'computer.click', { capability: 'computer.click' })];
  const attached = h.engine.attachPlan('t-p16', 'g', steps);
  assert(attached.ok && (attached.validation?.blockedNodeIds.length ?? 0) === 1, 'Phase 16 permission-blocked nodes still reported');

  // Deep Research: research tools run within their grants (browser.interaction
  // granted by default) — the gate classifies them confirm and allows.
  const searchTool: AgentTool = {
    name: 'research.search',
    description: 'search',
    category: 'web',
    riskLevel: 'low',
    capabilities: ['research.search'],
    permissions: ['browser.interaction'],
    timeoutMs: 1_000,
    execute: async () => ({ success: true, output: { hits: 1 } }),
  } as unknown as AgentTool;
  h.registry.register(searchTool);
  const searched = await h.registry.execute('research.search', { query: 'x' }, ctx(h));
  assert(searched.success, 'Deep Research tool executes within its grant (gate transparent)');

  // Model routing safety: fallback/escalation decisions carry no execution
  // surface and cannot alter permissions (Phase 17 is decision-only).
  const routerProbe = (routed.output as any).model;
  assert(typeof routerProbe === 'string' && h.permissions.isGranted('mouse.control') === false, 'routing decisions grant nothing');
}

// =================================================================
// 9. No-gate registries — legacy behavior byte-identical
// =================================================================
{
  console.log('Backwards compatibility — registries without a gate unchanged');
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  registry.register(makeTool('filesystem.create', { permissions: ['filesystem.write'], riskLevel: 'medium' }));
  const denied = await registry.execute('filesystem.create', { path: 'x' }, { taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions });
  assert(!denied.success && denied.errorKind === 'permission_denied' && denied.metadata?.safety === undefined, 'no-gate registry: legacy denial, no safety metadata');
  permissions.grant('filesystem.write');
  const allowed = await registry.execute('filesystem.create', { path: 'x' }, { taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions });
  assert(allowed.success && allowed.metadata?.safety === undefined, 'no-gate registry: legacy allow path unchanged');
}

console.log(`\nPhase 18 results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('PHASE 18 TESTS: ALL GREEN');
