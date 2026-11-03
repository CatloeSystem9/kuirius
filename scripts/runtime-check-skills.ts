/**
 * Learned Skills v1 — runtime verification (production wiring).
 * Usage: npx tsx scripts/runtime-check-skills.ts
 * Exits non-zero on any failure.
 *
 * Wires the control plane EXACTLY as bridge.ts does — ToolRegistry with the
 * Phase 18 SafetyGate attached, PermissionManager, SafetyAuditLog,
 * ScopedPermissionManager, EmergencyStop, MemoryService, KnowledgeGraphFacade,
 * SemanticIntelligence, LearningService (Phase 12), SkillEngine (Learned
 * Skills v1) and the SkillAwarePlanner(WorkflowAwarePlanner(HeuristicPlanner))
 * chain — then drives a natural-language task through the real planner and
 * verifies the full learn → gate → restart → reuse → safety cycle:
 *
 *   1. "list the files in documents then read the file documents\summary.txt"
 *      classifies through the real HeuristicPlanner into named tools, executes
 *      through the gated registry, completes with an honest 'pass'.
 *   2. The verified run is learned into a validated skill (provenance,
 *      preconditions, expected outcome).
 *   3. A second identical run reinforces it to the reuse floor; a third run
 *      is planned FROM the skill (skillFrom marker) and every step still
 *      passes the SafetyGate with decision metadata attached.
 *   4. A restarted engine over the same storage restores the skill intact.
 *   5. Emergency stop blocks side-effecting execution until resume; the gate
 *      denial is audited; revoked permissions deny the management tools; no
 *      secrets reach the audit trail.
 */
import {
  SkillEngine,
  SkillAwarePlanner,
  isReusableSkill,
  SKILL_MIN_RELIABILITY,
} from '../src/agent/skills';
import { LearningService, WorkflowAwarePlanner } from '../src/agent/learning';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { HeuristicPlanner } from '../src/agent/planner';
import { PermissionManager } from '../src/agent/permissions';
import { MemoryService } from '../src/agent/memory/memoryService';
import { SemanticIntelligence, semanticGraphSource } from '../src/agent/semantic';
import { KnowledgeGraphFacade } from '../src/agent/knowledge';
import { EmergencyStop, SafetyAuditLog, SafetyGate, ScopedPermissionManager } from '../src/agent/safety';
import { createSkillTools } from '../src/agent/skills';
import type { AgentTool } from '../src/agent/types';
import { ok } from '../src/agent/types';

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
  assert(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

const GOAL = 'list the files in documents then read the file documents\\summary.txt';
const FAKE_SECRET = 'sk-runtimechecksecret12345';

function namedTool(name: string, capability: string, permissions: AgentTool['permissions'], riskLevel: AgentTool['riskLevel'], output: unknown): AgentTool {
  return {
    name,
    description: `${name} (runtime check mock)`,
    category: 'filesystem',
    riskLevel,
    capabilities: [capability],
    permissions,
    verification: { strategy: 'self_reported', description: 'mock returns success' },
    async execute() {
      return ok({ output });
    },
  };
}

async function main() {
  // ---- Production wiring (same order as bridge.ts) -------------------------
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const store = new TaskStore(new MemoryStorage());
  const storage = new MemoryStorage();
  const permissions = new PermissionManager();

  const safetyAudit = new SafetyAuditLog();
  const scopedPermissions = new ScopedPermissionManager();
  const emergencyStop = new EmergencyStop(safetyAudit);
  const safetyGate = new SafetyGate({ permissions, scoped: scopedPermissions, emergencyStop, audit: safetyAudit });
  registry.setSafetyGate(safetyGate);

  const memory = new MemoryService(storage);
  const knowledgeGraph = new KnowledgeGraphFacade({ storage });
  const semantic = new SemanticIntelligence({ graphSource: semanticGraphSource(knowledgeGraph) });
  const learning = new LearningService({ registry, events: bus, memory, storage, taskResolver: (id) => store.get(id) });
  const skills = new SkillEngine({
    registry,
    events: bus,
    storage,
    semantic,
    knowledgeGraph,
    memory,
    permissions,
    taskResolver: (id) => store.get(id),
  });
  const planner = new SkillAwarePlanner(new WorkflowAwarePlanner(new HeuristicPlanner(), learning), skills);
  const core = new AgentCore({ registry, events: bus, store, permissions, planner });
  emergencyStop.onActivate(() => {
    try {
      core.cancelAll();
    } catch {
      /* best-effort */
    }
    scopedPermissions.revokeAllTemporary();
  });

  // Real tool NAMES the HeuristicPlanner produces for the goal above.
  registry.register(namedTool('filesystem.list', 'filesystem.list', ['filesystem.read'], 'low', { entries: ['summary.txt'] }));
  registry.register(namedTool('filesystem.read', 'filesystem.read', ['filesystem.read'], 'low', { content: 'summary contents' }));
  // Side-effecting probe tool for the emergency-stop check.
  registry.register(namedTool('filesystem.create', 'filesystem.create', ['filesystem.write'], 'medium', { created: true }));
  registry.registerAll(createSkillTools({ skills }));

  learning.attach();
  skills.attach();

  const ctx = (over: Partial<Parameters<ToolRegistry['execute']>[2]> = {}) => ({
    taskId: 'runtime',
    stepId: 's',
    signal: new AbortController().signal,
    memory: {},
    permissions,
    ...over,
  });

  // ---- 1. Verified natural-language run is learned into a skill ------------
  const task1 = await core.submit(GOAL);
  assertEqual(task1.status, 'completed', 'natural-language task completed through planner + gate');
  assertEqual(task1.verification?.outcome, 'pass', 'goal-level verification passed');
  assertEqual(learning.list().length, 1, 'Phase 12 workflow learned alongside');
  assertEqual(skills.list().length, 1, 'exactly one skill learned');
  const skill = skills.list()[0];
  assertEqual(skill.validation.status, 'validated', 'skill validated');
  assertEqual(skill.steps[0].toolName, 'filesystem.list', 'skill step 1 from the real plan');
  assertEqual(skill.steps[1].toolName, 'filesystem.read', 'skill step 2 from the real plan');
  assertEqual(skill.reliability, 0.55, 'fresh skill below the reuse floor');
  const firstUses = bus.recentEvents().filter((e) => e.name === 'TOOL_COMPLETED').length;
  assert(firstUses >= 2, 'steps executed through the gated registry');
  const gated = await registry.execute('filesystem.list', { path: 'documents' }, ctx());
  assert(gated.success === true && !!gated.metadata?.safety, 'gate attaches safety decision metadata to results');

  // ---- 2. Reinforcement to the floor, then skill-driven reuse --------------
  const task2 = await core.submit(GOAL);
  assert(!task2.plan?.skillFrom, 'second run planned normally (below reuse floor)');
  assertEqual(skills.list()[0].reliability, 0.64, 'reinforcement reached the reuse floor');
  assert(isReusableSkill(skills.list()[0]), 'skill now autonomously reusable');

  const reusedEventsBefore = bus.recentEvents().filter((e) => e.name === 'SKILL_REUSED').length;
  const task3 = await core.submit(GOAL);
  assert(!!task3.plan?.skillFrom, 'third run planned FROM the learned skill');
  assertEqual(bus.recentEvents().filter((e) => e.name === 'SKILL_REUSED').length, reusedEventsBefore + 1, 'SKILL_REUSED emitted');
  assertEqual(task3.status, 'completed', 'skill-driven task completed through the normal lifecycle');
  assertEqual(skills.list()[0].reliability, 0.712, 'verified reuse raised reliability (EWMA)');
  const reuseGated = await registry.execute('skill.search', { query: GOAL }, ctx());
  assert(reuseGated.success === true && !!reuseGated.metadata?.safety, 'skill discovery tools are gate-evaluated too');

  // ---- 3. Restart: the skill survives with full fidelity -------------------
  const restarted = new SkillEngine({
    registry,
    events: new AgentEventBus(),
    storage,
    semantic,
    knowledgeGraph,
    memory,
    permissions,
  });
  const restored = restarted.get(skill.id);
  assert(!!restored, 'skill restored after restart');
  assertEqual(restored!.reliability, 0.712, 'reliability survived the restart');
  assertEqual(restored!.version, skill.version, 'version survived the restart');

  // ---- 4. Safety: emergency stop, permissions, audit redaction -------------
  permissions.grant('filesystem.write');
  const allowedSideEffect = await registry.execute('filesystem.create', { path: 'x.txt', type: 'file' }, ctx());
  assertEqual(allowedSideEffect.success, true, 'granted side effect executes while the stop is inactive');

  emergencyStop.activate('runtime check');
  assert(emergencyStop.isActive(), 'emergency stop active');
  const blocked = await registry.execute('filesystem.create', { path: 'x.txt', type: 'file' }, ctx());
  assertEqual(blocked.success, false, 'emergency stop blocks side-effecting execution');
  assertEqual(blocked.errorKind, 'permission_denied', 'stop denial is a permission decision');
  assert(!!blocked.metadata?.safety, 'stop denial carries the safety evaluation');
  // A skill-driven task during the stop: read-only work continues by design
  // (Phase 18) — honestly executed through the gate, never silently bypassed.
  const stoppedTask = await core.submit(GOAL);
  assertEqual(stoppedTask.status, 'completed', 'read-only skill work continues during the stop, still gate-evaluated');
  emergencyStop.deactivate();
  assert(!emergencyStop.isActive(), 'emergency stop released');

  // Revoked permission denies the management tools through the gate (the gate
  // is authoritative and evaluates the shared PermissionManager). The
  // secret-looking value rides an ALLOWED input key — the audit must never
  // retain it.
  permissions.revoke('memory.access');
  const denied = await registry.execute('skill.forget', { id: FAKE_SECRET }, ctx());
  assertEqual(denied.success, false, 'revoked permission denies skill.forget through the gate');
  assertEqual(denied.errorKind, 'permission_denied', 'denial classified as permission_denied');
  permissions.grant('memory.access');

  const auditJson = JSON.stringify(safetyAudit.recent(60));
  assert(!auditJson.includes(FAKE_SECRET), 'audit trail contains no secret values');
  assert(safetyAudit.count() > 0, 'audit trail recorded the safety decisions');
  assert(skills.forget(skill.id), 'learned data can be forgotten explicitly');

  // ---- 5. Resource posture --------------------------------------------------
  const started = Date.now();
  for (let i = 0; i < 50; i++) skills.match(GOAL);
  const elapsed = Date.now() - started;
  assert(elapsed < 1000, `50 matches over the store stay cheap (${elapsed}ms)`);
  const stats = skills.stats();
  assert(stats.skills <= 30, 'skill store bounded');

  // ---- Summary ---------------------------------------------------------------
  console.log('');
  console.log(`Learned Skills v1 runtime verification: ${passed} checks passed, ${failed} failed`);
  if (failed > 0) {
    console.log('FAILURES:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('RUNTIME CHECK (LEARNED SKILLS V1): PASS');
}

main().catch((err) => {
  console.error('runtime check crashed:', err);
  process.exit(1);
});
