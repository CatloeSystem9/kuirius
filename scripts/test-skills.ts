/**
 * Learned Skills v1 verification suite.
 * Usage: npx tsx scripts/test-skills.ts
 * Exits non-zero on any failure.
 *
 * Covers the spec's required tests: successful workflow extraction, failed /
 * incomplete / cancelled workflow rejection, skill validation, duplicate
 * detection, persistent storage and retrieval, semantic matching, skill
 * execution through the normal core, missing prerequisites, permission
 * enforcement, sensitive-information filtering, version updates, reliability
 * tracking (single-failure smoothing, decay, disable), persistence across
 * restarts, and integration with Phase 12 learning, the Knowledge Graph,
 * Memory, and Self-Diagnostics.
 */
import {
  SkillEngine,
  SkillAwarePlanner,
  SkillStore,
  createSkillTools,
  validateSkill,
  applySkillOutcome,
  isReusableSkill,
  SKILL_MIN_RELIABILITY,
} from '../src/agent/skills';
import type { LearnedSkill } from '../src/agent/skills';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import type { StorageAdapter } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { MemoryService } from '../src/agent/memory/memoryService';
import { PermissionManager } from '../src/agent/permissions';
import { SemanticIntelligence } from '../src/agent/semantic';
import { KnowledgeGraphFacade } from '../src/agent/knowledge';
import { LearningService, WorkflowAwarePlanner } from '../src/agent/learning';
import { createIntelligenceChecks } from '../src/agent/diagnostics/checks/intelligenceChecks';
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

const GOAL = 'backup the documents folder and verify the backup result';
const STEPS = [step('s1', 'mock.a', 'cap.a', { target: 'documents' }), step('s2', 'mock.b', 'cap.b', { path: 'backup' })];

function successTools(): AgentTool[] {
  return [
    tool('mock.a', 'cap.a', async () => ok({ output: { backed: true } })),
    tool('mock.b', 'cap.b', async () => ok({ output: { verified: true } })),
  ];
}

interface Harness {
  core: AgentCore;
  skills: SkillEngine;
  registry: ToolRegistry;
  bus: AgentEventBus;
  storage: MemoryStorage;
  memory: MemoryService;
  permissions: PermissionManager;
  semantic: SemanticIntelligence;
  knowledgeGraph: KnowledgeGraphFacade;
  detachAll: () => void;
}

function makeHarness(
  plannerSteps: PlanStep[],
  toolDefs: AgentTool[],
  extra: { withLearning?: boolean; semantic?: boolean; knowledgeGraph?: boolean; memory?: boolean; permissions?: boolean } = {}
): Harness {
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  for (const t of toolDefs) registry.register(t);
  const storage = new MemoryStorage();
  const store = new TaskStore(storage);
  const memory = new MemoryService(storage);
  const permissions = new PermissionManager();
  const semantic = new SemanticIntelligence({});
  const knowledgeGraph = new KnowledgeGraphFacade({ storage });
  const skills = new SkillEngine({
    registry,
    events: bus,
    storage,
    semantic: extra.semantic === false ? undefined : semantic,
    knowledgeGraph: extra.knowledgeGraph === false ? undefined : knowledgeGraph,
    memory: extra.memory === false ? undefined : memory,
    permissions: extra.permissions === false ? undefined : permissions,
    taskResolver: (taskId) => store.get(taskId),
  });
  let planner = staticPlanner(plannerSteps) as import('../src/agent/planner').Planner;
  if (extra.withLearning) {
    const learning = new LearningService({ registry, events: bus, memory, storage, taskResolver: (taskId) => store.get(taskId) });
    planner = new WorkflowAwarePlanner(planner, learning);
    learning.attach();
  }
  const core = new AgentCore({ registry, events: bus, store, permissions, planner: new SkillAwarePlanner(planner, skills) });
  skills.attach();
  return { core, skills, registry, bus, storage, memory, permissions, semantic, knowledgeGraph, detachAll: () => skills.detach() };
}

function events(bus: AgentEventBus, name: string): number {
  return bus.recentEvents().filter((e) => e.name === name).length;
}

// ---------------------------------------------------------------- Test 1
{
  console.log('Test 1 — Successful workflow extraction');
  const h = makeHarness(STEPS, successTools());
  const task = await h.core.submit(GOAL);
  assertEqual(task.status, 'completed', 'task completed');
  assertEqual(h.skills.list().length, 1, 'exactly one skill learned');
  const skill = h.skills.list()[0];
  assert(!!skill.id && skill.id.startsWith('skill_'), 'skill has a unique id');
  assert(!!skill.name && !!skill.description && !!skill.purpose, 'skill has name, description and purpose');
  assertEqual(skill.steps.length, 2, 'skill captured two ordered steps');
  assertEqual(skill.steps[0].toolName, 'mock.a', 'step order preserved (step 1)');
  assertEqual(skill.steps[1].toolName, 'mock.b', 'step order preserved (step 2)');
  assertEqual(skill.validation.status, 'validated', 'skill validated');
  assert(skill.provenance.sourceTaskId === task.id, 'provenance records the source task');
  assert(skill.provenance.verificationReason.length > 0, 'provenance records the verification reason');
  assert(skill.trigger.goalPattern.length > 0 && skill.trigger.keywords.length > 0, 'trigger pattern + keywords captured');
  assert(Array.isArray(skill.preconditions) && skill.preconditions.length >= 2, 'tool-availability preconditions derived');
  assert(skill.expectedOutcome.length > 0, 'expected outcome recorded');
  assertEqual(skill.version, 1, 'initial version 1');
  assert(!skill.sensitive, 'low-risk skill is not flagged sensitive');
  assert(events(h.bus, 'SKILL_LEARNED') === 1, 'SKILL_LEARNED emitted exactly once');
  assert(h.knowledgeGraph.stats().nodes >= 3, 'knowledge graph indexed skill + tool nodes');
  assert(h.knowledgeGraph.stats().edges >= 2, 'knowledge graph indexed uses edges');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 2
{
  console.log('Test 2 — Failed workflow rejection');
  const failing = [
    tool('mock.a', 'cap.a', async () => ok({ output: { backed: true } })),
    tool('mock.b', 'cap.b', async () => fail('disk exploded', { errorKind: 'execution_error' })),
  ];
  const h = makeHarness(STEPS, failing);
  const task = await h.core.submit(GOAL);
  assertEqual(task.status, 'failed', 'task failed');
  assertEqual(h.skills.list().length, 0, 'no skill created from a failed task');
  assertEqual(events(h.bus, 'SKILL_LEARNED'), 0, 'no SKILL_LEARNED on failure');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 3
{
  console.log('Test 3 — Uncertain (unverified) result rejection');
  const uncertain = [
    tool('mock.a', 'cap.a', async () => ok({ output: { backed: true } })),
    tool('mock.b', 'cap.b', async () => ok({ output: { verified: true, uncertain: true } })),
  ];
  const h = makeHarness(STEPS, uncertain);
  const task = await h.core.submit(GOAL);
  assertEqual(task.status, 'uncertain', 'task landed in the honest uncertain state');
  assertEqual(h.skills.list().length, 0, 'no skill created from an unverified result');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 4
{
  console.log('Test 4 — Timeout failure rejection');
  const slow = [
    tool('mock.a', 'cap.a', async () => ok({ output: { backed: true } })),
    tool('mock.b', 'cap.b', async () => {
      await new Promise((r) => setTimeout(r, 120));
      return ok({ output: { verified: true } });
    }, { timeoutMs: 15 }),
  ];
  const h = makeHarness(STEPS, slow);
  const task = await h.core.submit(GOAL);
  assertEqual(task.status, 'failed', 'timed-out task failed');
  assertEqual(h.skills.list().length, 0, 'no skill created from a timed-out task');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 5
{
  console.log('Test 5 — Cancellation rejection');
  const h = makeHarness(STEPS, successTools());
  const { taskId, promise } = h.core.startTask(GOAL);
  h.core.cancel(taskId);
  const task = await promise;
  assertEqual(task.status, 'cancelled', 'task cancelled');
  assertEqual(h.skills.list().length, 0, 'no skill created from a cancelled task');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 6
{
  console.log('Test 6 — No skills from arbitrary user messages');
  const h = makeHarness(STEPS, successTools());
  h.bus.emit({ name: 'USER_MESSAGE', payload: { input: 'please always back up my documents folder first' }, timestamp: Date.now() });
  h.bus.emit({ name: 'USER_MESSAGE', payload: { input: GOAL }, timestamp: Date.now() });
  assertEqual(h.skills.list().length, 0, 'user messages never create skills');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 7
{
  console.log('Test 7 — Deterministic validation (unit)');
  const registry = new ToolRegistry();
  registry.register(tool('mock.a', 'cap.a', async () => ok({})));
  registry.register(tool('mock.high', 'cap.high', async () => ok({}), { riskLevel: 'high' }));
  const mk = (steps: PlanStep[]) =>
    steps.map((s, i) => ({ order: i + 1, toolName: s.toolName, capability: s.capability, inputTemplate: s.input }));

  const oneStep = validateSkill({ goalPattern: 'x', expectedOutcome: 'y', steps: mk([STEPS[0]]) }, registry);
  assertEqual(oneStep.status, 'rejected', 'single-step candidate rejected');
  assert(oneStep.errors.length > 0, 'rejection carries reasons');

  const highRisk = validateSkill(
    { goalPattern: 'x', expectedOutcome: 'y', steps: mk([STEPS[0], step('s2', 'mock.high', 'cap.high')]) },
    registry
  );
  assertEqual(highRisk.status, 'rejected', 'high-risk candidate rejected');
  assert(highRisk.errors.some((e) => e.includes('high/critical-risk')), 'high-risk reason recorded');

  const secret = validateSkill(
    {
      goalPattern: 'x',
      expectedOutcome: 'y',
      steps: [
        { order: 1, toolName: 'mock.a', inputTemplate: { apiKey: 'sk-abcdefghijklmnop' } },
        { order: 2, toolName: 'mock.a', inputTemplate: { path: 'b' } },
      ],
    },
    registry
  );
  assertEqual(secret.status, 'rejected', 'secret-bearing template rejected by validation');

  const missingOutcome = validateSkill({ goalPattern: 'x', expectedOutcome: '', steps: mk(STEPS) }, registry);
  assertEqual(missingOutcome.status, 'rejected', 'missing expected outcome rejected');

  const unknownTool = validateSkill({ goalPattern: 'x', expectedOutcome: 'y', steps: mk([STEPS[0], step('s2', 'ghost.tool', 'cap.z')]) }, registry);
  assertEqual(unknownTool.status, 'rejected', 'unavailable tool rejected');
}

// ---------------------------------------------------------------- Test 8
{
  console.log('Test 8 — High/critical-risk workflow never learned (core-driven)');
  const risky = [
    tool('mock.a', 'cap.a', async () => ok({ output: { backed: true } })),
    tool('mock.wipe', 'cap.wipe', async () => ok({ output: { wiped: true } }), { riskLevel: 'critical' }),
  ];
  const h = makeHarness([STEPS[0], step('s2', 'mock.wipe', 'cap.wipe')], risky);
  const task = await h.core.submit(GOAL);
  assertEqual(task.status, 'completed', 'the task itself still completed normally');
  assertEqual(h.skills.list().length, 0, 'no skill learned from a critical-risk workflow');
  assert(events(h.bus, 'SKILL_REJECTED') === 1, 'SKILL_REJECTED emitted for transparency');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 9
{
  console.log('Test 9 — Sensitive information filtering');
  const secretSteps = [
    step('s1', 'mock.a', 'cap.a', { target: 'documents' }),
    step('s2', 'mock.b', 'cap.b', { apiKey: 'sk-abcdefghijklmnop', path: 'backup' }),
  ];
  const h = makeHarness(secretSteps, successTools());
  await h.core.submit(GOAL);
  assertEqual(h.skills.list().length, 1, 'skill learned despite secret in step input');
  const stored = JSON.stringify(h.skills.list()[0].steps);
  assert(!stored.includes('sk-abcdefghijklmnop'), 'secret value absent from the stored skill');
  assert(stored.includes('[redacted]'), 'secret replaced with a redaction marker');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 10
{
  console.log('Test 10 — Duplicate detection (reinforce, never duplicate)');
  const h = makeHarness(STEPS, successTools());
  await h.core.submit(GOAL);
  await h.core.submit(GOAL);
  assertEqual(h.skills.list().length, 1, 'still exactly one skill after an identical success');
  const skill = h.skills.list()[0];
  assertEqual(skill.stats.reinforcements, 1, 'reinforcement recorded');
  assertEqual(skill.version, 1, 'identical sequence does not bump the version');
  assert(events(h.bus, 'SKILL_REINFORCED') === 1, 'SKILL_REINFORCED emitted');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 11
{
  console.log('Test 11 — Version update from a verified improvement');
  const h = makeHarness(STEPS, successTools());
  await h.core.submit(GOAL);
  const skills = h.skills;
  const improvedSteps = [
    { order: 1, toolName: 'mock.a', capability: 'cap.a', inputTemplate: { target: 'documents' } },
    { order: 2, toolName: 'mock.c', capability: 'cap.c', inputTemplate: { path: 'backup' } },
  ];
  // Before the improved tool exists, the validator honestly rejects it.
  const early = validateSkill({ goalPattern: skills.list()[0].trigger.goalPattern, expectedOutcome: 'verified', steps: improvedSteps }, h.registry);
  assertEqual(early.status, 'rejected', 'v2 candidate rejected while mock.c is unregistered');
  // Register the improved tool and observe a second VERIFIED run with the new sequence.
  h.registry.register(tool('mock.c', 'cap.c', async () => ok({ output: { verified: true } })));
  const outcome = skills.observeTask({
    id: 'task_v2',
    goal: { description: GOAL, rawInput: GOAL, kind: 'command' },
    plan: {
      goal: { description: GOAL, rawInput: GOAL, kind: 'command' },
      steps: [
        { ...step('s1', 'mock.a', 'cap.a'), status: 'completed', attempts: 1, verified: true },
        { ...step('s2', 'mock.c', 'cap.c'), status: 'completed', attempts: 1, verified: true },
      ],
      createdAt: Date.now(),
      revision: 1,
    },
    status: 'completed',
    currentStepIndex: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    verification: { outcome: 'pass', expected: GOAL, actual: 'verified', reason: 'all steps verified', checkedAt: Date.now() },
  } as import('../src/agent/types').AgentTask);
  assertEqual(outcome.learned, true, 'verified improvement accepted');
  const skill = skills.list()[0];
  assertEqual(skill.version, 2, 'skill version bumped from the verified improvement');
  assertEqual(skill.versionHistory.length, 1, 'version history preserved');
  assertEqual(skill.steps[1].toolName, 'mock.c', 'skill adapted to the improved sequence');
  assert(events(h.bus, 'SKILL_UPDATED') >= 1, 'SKILL_UPDATED emitted');
  assertEqual(skills.list().length, 1, 'still exactly one skill (no conflicting duplicate)');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 12
{
  console.log('Test 12 — Skill execution through the normal core');
  const h = makeHarness(STEPS, successTools());
  const t1 = await h.core.submit(GOAL);
  assertEqual(h.skills.list()[0].reliability, 0.55, 'fresh skill starts below the reuse floor');
  const t2 = await h.core.submit(GOAL);
  assert(!t2.plan?.skillFrom, 'second run still planned normally (skill not yet reusable)');
  assertEqual(h.skills.list()[0].reliability, 0.64, 'reinforcement raised reliability to the reuse floor');
  assert(isReusableSkill(h.skills.list()[0]), 'skill is now autonomously reusable');
  const t3 = await h.core.submit(GOAL);
  assert(!!t3.plan?.skillFrom, 'third run reused the learned skill');
  assertEqual(t3.plan?.skillFrom?.skillId, h.skills.list()[0].id, 'reuse marker references the skill');
  assertEqual(t3.status, 'completed', 'skill-driven task completed');
  assert(events(h.bus, 'SKILL_REUSED') === 1, 'SKILL_REUSED emitted');
  assertEqual(h.skills.list()[0].reliability, 0.712, 'verified reuse raised reliability (EWMA)');
  assertEqual(h.skills.list()[0].stats.totalUses, 2, 'usage counted (reinforce + reuse)');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 13
{
  console.log('Test 13 — Missing prerequisites block reuse');
  const h = makeHarness(STEPS, successTools());
  await h.core.submit(GOAL);
  await h.core.submit(GOAL);
  assert(isReusableSkill(h.skills.list()[0]), 'skill reusable before the environment change');
  h.registry.unregister('mock.b');
  const matches = h.skills.match(GOAL);
  assert(matches.length === 1 && matches[0].blockers.length > 0, 'match reports explicit environment blockers');
  assert(matches[0].environmentCoverage < 1, 'environment coverage below 1');
  assertEqual(h.skills.planFromSkill({ description: GOAL, rawInput: GOAL, kind: 'command' }), null, 'planFromSkill refuses to instantiate');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 14
{
  console.log('Test 14 — Permission enforcement + sensitive flagging');
  const writingTools = [
    tool('mock.a', 'cap.a', async () => ok({ output: { backed: true } })),
    tool('mock.b', 'cap.b', async () => ok({ output: { verified: true } }), { permissions: ['filesystem.write'] }),
  ];
  const h = makeHarness(STEPS, writingTools);
  // The original run needs the write permission granted (core + engine share
  // one manager); the skill is learned and flagged sensitive.
  h.permissions.grant('filesystem.write');
  await h.core.submit(GOAL);
  assertEqual(h.skills.list().length, 1, 'skill learned while the permission was granted');
  const skill = h.skills.list()[0];
  assert(skill.sensitive, 'skill touching filesystem.write is flagged sensitive');
  assert(skill.requiredPermissions.includes('filesystem.write'), 'required permissions captured');
  // Revoke: the permission precondition must now block reuse.
  h.permissions.revoke('filesystem.write');
  const matches = h.skills.match(GOAL);
  assert(matches[0].blockers.some((b) => b.includes('filesystem.write')), 'default-denied permission blocks reuse');
  assertEqual(h.skills.planFromSkill({ description: GOAL, rawInput: GOAL, kind: 'command' }), null, 'no instantiation while the permission is denied');
  h.permissions.grant('filesystem.write');
  const after = h.skills.match(GOAL);
  assert(!after[0].blockers.some((b) => b.includes('filesystem.write')), 'granting the permission clears that blocker');
  assert(after[0].blockers.some((b) => b.includes('reliability')), 'reliability floor still applies independently');

  // Permission enforcement on the management tools through the registry.
  h.registry.registerAll(createSkillTools({ skills: h.skills }));
  const denied = new PermissionManager();
  denied.revoke('memory.access');
  const result = await h.registry.execute('skill.forget', { id: skill.id }, {
    taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions: denied,
  });
  assertEqual(result.success, false, 'skill.forget denied without the memory.access grant');
  const allowed = await h.registry.execute('skill.list', {}, {
    taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions: new PermissionManager(),
  });
  assertEqual(allowed.success, true, 'skill.list works with the default memory.access grant');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 15
{
  console.log('Test 15 — Semantic matching (bounded, explainable)');
  const h = makeHarness(
    [step('s1', 'mock.a', 'cap.a'), step('s2', 'mock.b', 'cap.b')],
    successTools()
  );
  const learned = h.skills.observeTask({
    id: 'task_manual',
    goal: { description: GOAL, rawInput: 'check internet connectivity status', kind: 'command' },
    plan: {
      goal: { description: 'x', rawInput: 'check internet connectivity status', kind: 'command' },
      steps: [
        { ...step('s1', 'mock.a', 'cap.a'), status: 'completed', attempts: 1, verified: true },
        { ...step('s2', 'mock.b', 'cap.b'), status: 'completed', attempts: 1, verified: true },
      ],
      createdAt: Date.now(),
      revision: 1,
    },
    status: 'completed',
    currentStepIndex: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    verification: { outcome: 'pass', expected: 'connectivity checked', actual: 'connectivity ok', reason: 'all steps verified', checkedAt: Date.now() },
  } as import('../src/agent/types').AgentTask);
  assert(learned.learned === true, 'manual verified task produced a skill');

  const matches = h.skills.match('check online status');
  assert(matches.length >= 1, 'alias vocabulary bridged the wording gap');
  const m = matches[0];
  assert(m.goalSimilarity >= 0.4 && m.goalSimilarity < 0.55, `weak direct similarity (${m.goalSimilarity})`);
  assert(m.semanticOverlap >= 0.5, `semantic overlap supplied the bridge (${m.semanticOverlap})`);
  assert(m.reasons.some((r) => r.startsWith('semantic:')), 'semantic reason is explainable');
  assert(m.blockers.some((b) => b.includes('reliability')), 'reliability floor surfaced for a fresh skill');
  assertEqual(h.skills.planFromSkill({ description: 'x', rawInput: 'check online status', kind: 'command' }), null, 'weak match is not auto-executed');
  assertEqual(h.skills.match('completely unrelated quantum bananas').length, 0, 'unrelated goal matches nothing');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 16
{
  console.log('Test 16 — Reliability tracking (smoothing, decay, dedupe, disable)');
  assertEqual(applySkillOutcome(1.0, 'verified_failure'), 0.8, 'a single failure never collapses a proven skill (EWMA)');
  assert(applySkillOutcome(1.0, 'verified_failure') >= SKILL_MIN_RELIABILITY, 'single-failure skill stays reusable');

  const h = makeHarness(STEPS, successTools());
  await h.core.submit(GOAL);
  const skill = h.skills.list()[0];
  const id = skill.id;
  // Distinct task ids: two verified failures decay the skill below the floor.
  h.skills.recordOutcome(id, 'verified_failure', 'task_f1');
  h.skills.recordOutcome(id, 'verified_failure', 'task_f2');
  const decayed = h.skills.get(id)!;
  assert(decayed.reliability < SKILL_MIN_RELIABILITY, 'repeated verified failures drop reliability below the floor');
  assert(!isReusableSkill(decayed), 'decayed skill is no longer auto-reused');
  assert(decayed.status === 'active', 'decayed skill is not yet disabled');
  assertEqual(decayed.stats.consecutiveFailures, 2, 'consecutive failures tracked');
  // Duplicate recording prevention: the same task id records once.
  const before = decayed.stats.totalUses;
  assertEqual(h.skills.recordOutcome(id, 'verified_success', 'task_f2'), false, 'duplicate task outcome refused');
  assertEqual(h.skills.get(id)!.stats.totalUses, before, 'stats unchanged after duplicate refusal');
  // Continued verified failures eventually disable the skill (bounded self-limitation).
  for (let i = 3; i <= 8; i++) h.skills.recordOutcome(id, 'verified_failure', `task_f${i}`);
  const disabled = h.skills.get(id)!;
  assertEqual(disabled.status, 'disabled', 'a chronically failing skill is disabled');
  const audit = h.skills.auditStale();
  assert(audit.disabled >= 1, 'audit reports the disabled skill');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 17
{
  console.log('Test 17 — Persistence across restarts');
  const h = makeHarness(STEPS, successTools());
  await h.core.submit(GOAL);
  await h.core.submit(GOAL);
  const original = h.skills.list()[0];
  const reopened = new SkillEngine({
    registry: h.registry,
    events: new AgentEventBus(),
    storage: h.storage,
    taskResolver: () => undefined,
  });
  assertEqual(reopened.list().length, 1, 'skill store reloads after restart');
  const restored = reopened.get(original.id)!;
  assertEqual(restored.reliability, original.reliability, 'reliability preserved across restarts');
  assertEqual(restored.version, original.version, 'version preserved across restarts');
  assertEqual(restored.provenance.sourceTaskId, original.provenance.sourceTaskId, 'provenance preserved across restarts');
  assert(restored.stats.reinforcements === original.stats.reinforcements, 'stats preserved across restarts');

  const store = new SkillStore(h.storage);
  assertEqual(store.skills.length, 1, 'SkillStore reads the same bounded envelope');
  // Corrupted state fails clean, not corrupt.
  h.storage.setItem('krisha_skills_v1', '{corrupted json!!');
  const resilient = new SkillStore(h.storage);
  assertEqual(resilient.skills.length, 0, 'corrupted state starts clean');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 18
{
  console.log('Test 18 — Integration: Phase 12 coexistence, memory mirror, diagnostics');
  const h = makeHarness(STEPS, successTools(), { withLearning: true });
  await h.core.submit(GOAL);
  assertEqual(h.skills.list().length, 1, 'skill layer learned');
  await h.core.submit(GOAL);
  await h.core.submit(GOAL); // skill-driven task
  assert(h.skills.list()[0].stats.lastOutcome === 'verified_success', 'skill outcome recorded');
  // Learning list is not part of the harness return; verify via a fresh reader.
  const learningReader = new LearningService({
    registry: h.registry,
    events: new AgentEventBus(),
    memory: h.memory,
    storage: h.storage,
    taskResolver: () => undefined,
  });
  assertEqual(learningReader.list().length, 1, 'exactly one Phase 12 workflow (skill-driven task not duplicated)');

  const memoryStats = h.memory.stats();
  assert(memoryStats.total >= 1, 'skill mirrored into the existing memory service');
  const mirrored = h.storage.getItem('krisha_memory_v1') ?? '';
  assert(!mirrored.includes('sk-'), 'memory mirror carries no raw values beyond compact metadata');

  const checks = createIntelligenceChecks({ skills: h.skills });
  const check = checks.find((c) => c.id === 'intelligence.learned_skills');
  assert(!!check, 'diagnostics check registered for learned skills');
  const outcome = check!.run();
  assertEqual(outcome.status, 'healthy', 'learned-skills diagnostic check healthy');
  const missingCheck = createIntelligenceChecks({}).find((c) => c.id === 'intelligence.learned_skills')!.run();
  assertEqual(missingCheck.status, 'degraded', 'missing skill engine degrades honestly');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 19
{
  console.log('Test 19 — Discovery tools through the registry');
  const h = makeHarness(STEPS, successTools());
  await h.core.submit(GOAL);
  h.registry.registerAll(createSkillTools({ skills: h.skills }));
  const ctx = { taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions: new PermissionManager() };

  const search = await h.registry.execute('skill.search', { query: GOAL }, ctx);
  assertEqual(search.success, true, 'skill.search executes');
  const matches = (search.output as { matches: Array<{ reusableNow: boolean; blockers: string[] }> }).matches;
  assert(matches.length >= 1, 'search finds the learned skill for its own goal');
  assert(matches[0].blockers.some((b) => b.includes('reuse floor')), 'search explains the reliability blocker transparently');

  const badSearch = await h.registry.execute('skill.search', {}, ctx);
  assertEqual(badSearch.success, false, 'skill.search without a query fails closed');

  const stats = await h.registry.execute('skill.stats', {}, ctx);
  assertEqual(stats.success, true, 'skill.stats executes');
  assert((stats.output as { skills: number }).skills === 1, 'stats report the skill count');

  const list = await h.registry.execute('skill.list', {}, ctx);
  assertEqual(list.success, true, 'skill.list executes');
  assertEqual((list.output as { count: number }).count, 1, 'list reports one skill');

  const disable = await h.registry.execute('skill.disable', { id: h.skills.list()[0].id }, ctx);
  assertEqual(disable.success, true, 'skill.disable executes with permission');
  assertEqual(h.skills.list()[0].status, 'disabled', 'disabled skill is marked');
  const matchesAfterDisable = h.skills.match(GOAL);
  assertEqual(matchesAfterDisable.length, 0, 'disabled skills never match');
  const forget = await h.registry.execute('skill.forget', { id: h.skills.list()[0].id }, ctx);
  assertEqual(forget.success, true, 'skill.forget executes with permission');
  assertEqual(h.skills.list().length, 0, 'forgotten skill removed');
  h.detachAll();
}

// ---------------------------------------------------------------- Test 20
{
  console.log('Test 20 — Bounded store + chat goals never reuse skills');
  const h = makeHarness(STEPS, successTools());
  const skillEngine = h.skills;
  // Fill the store past its cap and confirm the bound holds. Goals use
  // pairwise-disjoint tokens so each observation is a genuinely new skill
  // (not a reinforcement of a similar one).
  const base = Date.now();
  for (let i = 0; i < 35; i++) {
    const goalText = `skill bulk item w${i}a w${i}b w${i}c`;
    const outcome = skillEngine.observeTask({
      id: `task_bulk_${i}`,
      goal: { description: goalText, rawInput: goalText, kind: 'command' },
      plan: {
        goal: { description: goalText, rawInput: goalText, kind: 'command' },
        steps: [
          { ...step('s1', 'mock.a', 'cap.a'), status: 'completed', attempts: 1 },
          { ...step('s2', 'mock.b', 'cap.b'), status: 'completed', attempts: 1 },
        ],
        createdAt: base + i,
        revision: 1,
      },
      status: 'completed',
      currentStepIndex: 2,
      createdAt: base + i,
      updatedAt: base + i,
      verification: { outcome: 'pass', expected: 'x', actual: 'x', reason: 'verified', checkedAt: base + i },
    } as import('../src/agent/types').AgentTask);
    if (!outcome.learned) throw new Error(`bulk skill ${i} unexpectedly rejected: ${outcome.reason}`);
  }
  assert(skillEngine.list().length <= 30, `store stays bounded (${skillEngine.list().length} skills)`);

  // Chat goals are never satisfied from skills — normal planning handles chat.
  const chatGoal: AgentGoal = { description: 'what is the backup result?', rawInput: 'what is the backup result?', kind: 'chat' };
  assertEqual(skillEngine.planFromSkill(chatGoal), null, 'chat goals never instantiate skills');
  h.detachAll();
}

// ---------------------------------------------------------------- Summary
console.log('');
console.log(`Learned Skills v1: ${passed} assertions passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILED:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('LEARNED SKILLS V1 TESTS: ALL GREEN');
