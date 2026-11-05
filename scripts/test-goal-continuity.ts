/**
 * Goal Continuity v1 test suite.
 *
 * Covers: goal creation (explicit vs soft vs hypothetical), deduplication,
 * lifecycle transitions (valid + invalid), completion, pausing/resuming,
 * multiple simultaneous goals + cap eviction, persistence and restart
 * recovery, corrupted storage, resumption briefings, project association,
 * deleted/forgotten projects, memory integration, graph mirror integrity
 * (including a >10-edge prune case), task milestone tracking, cancellation,
 * permission and safety boundaries, and skill hints.
 *
 * Usage: npx tsx scripts/test-goal-continuity.ts
 * Exits non-zero on any failure.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

import { AgentEventBus, MemoryStorage, PermissionManager, ToolRegistry } from '../src/agent';
import { GoalEngine, GOALS_SCHEMA_VERSION, GOALS_STORAGE_KEY, isConfirmationStatement, isGenericSubject, isSameGoalStatement, detectGoalIntent } from '../src/agent/goals';
import type { GoalRecord } from '../src/agent/goals';
import { KnowledgeGraphFacade } from '../src/agent/knowledge';
import { MemoryService } from '../src/agent/memory';
import { NodeProjectFs } from '../src/agent/projects/projectFsNode';
import { ProjectEngine } from '../src/agent/projects';
import { createGoalTools } from '../src/agent/goals/goalTools';
import { EmergencyStop, SafetyAuditLog, SafetyGate } from '../src/agent/safety';
import { SkillEngine } from '../src/agent/skills';
import type { StorageAdapter } from '../src/agent';

// ------------------------------------------------------------------ harness

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
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  assert(equal, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function events(bus: AgentEventBus, name: string): number {
  return bus.recentEvents().filter((e) => e.name === name).length;
}

/** File-backed storage adapter over one JSON object (restart simulation). */
class JsonFileStorage implements StorageAdapter {
  private map = new Map<string, string>();
  constructor(private readonly filePath: string) {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
    } catch {
      // first use / corrupt file → clean start
    }
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
    this.flush();
  }
  removeItem(key: string): void {
    this.map.delete(key);
    this.flush();
  }
  private flush(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.map)));
    } catch {
      // non-fatal
    }
  }
}

const TOOL_CTX = (permissions?: PermissionManager) => ({
  taskId: 't-goal',
  stepId: 's-goal',
  signal: new AbortController().signal,
  memory: {},
  permissions: permissions ?? new PermissionManager(),
});

interface EngineParts {
  engine: GoalEngine;
  bus: AgentEventBus;
  storage: StorageAdapter;
  memory?: MemoryService;
  knowledge?: KnowledgeGraphFacade;
  projects?: ProjectEngine;
}

interface EnginePartsInput {
  storage?: StorageAdapter;
  bus?: AgentEventBus;
  memory?: MemoryService;
  knowledge?: KnowledgeGraphFacade;
  /** When set, a real ProjectEngine is wired (the dir itself may not exist). */
  fixtureDir?: string;
  skills?: SkillEngine;
  getTask?: (id: string) => { goal?: { description?: string } } | undefined;
  now?: () => number;
}

function makeEngine(parts: EnginePartsInput = {}): EngineParts {
  const bus = parts.bus ?? new AgentEventBus();
  const storage = parts.storage ?? new MemoryStorage();
  let projects: ProjectEngine | undefined;
  if (parts.fixtureDir !== undefined) {
    projects = new ProjectEngine({ fs: new NodeProjectFs(), storage: new MemoryStorage(), knowledgeGraph: parts.knowledge, memory: parts.memory, events: bus });
  }
  const engine = new GoalEngine({
    storage,
    events: bus,
    memory: parts.memory,
    knowledge: parts.knowledge,
    projects,
    skills: parts.skills,
    getTask: parts.getTask,
    now: parts.now,
  });
  // Production wiring attaches the engine to the shared bus (bridge.ts does
  // the same); tests need it for event-driven behaviour.
  engine.attach(bus);
  return { engine, bus, storage, memory: parts.memory, knowledge: parts.knowledge, projects };
}

async function main() {
  const tempRoot = mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'krisha-goals-'));
  try {
    await runTests(tempRoot);
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  }
}

async function runTests(tempRoot: string) {
  // =========================================================================
  console.log('Test 1 — Deterministic intent detection (no goals from questions/hypotheticals)');
  {
    assertEqual(detectGoalIntent("What's the weather today?"), null, 'question creates nothing');
    assertEqual(detectGoalIntent('What if we built a rocket?'), null, 'what-if creates nothing');
    assertEqual(detectGoalIntent('Maybe we should build a shed'), null, 'maybe/should creates nothing');
    assertEqual(detectGoalIntent('hi'), null, 'short chatter creates nothing');

    const create = detectGoalIntent("Let's build this application");
    assert(!!create && create.kind === 'create', "let's build → create intent");
    assert(!!create && create.subject === 'this application', 'create subject extracted');
    assert(!!create && create.verb === 'build', 'create verb captured');
    assert(!!create && create.explicit === true, 'explicit commitment');

    const soft = detectGoalIntent("I'm thinking of building a log parser");
    assert(!!soft && soft.kind === 'create' && soft.explicit === false, 'soft interest is not an explicit commitment');
    assert(!!soft && soft.subject.toLowerCase().includes('parser'), 'soft subject extracted');

    const complete = detectGoalIntent('We have completed the integration');
    assert(!!complete && complete.kind === 'complete', 'completion statement detected');
    assert(!!complete && complete.subject === 'the integration', 'completion subject extracted');

    const pause = detectGoalIntent('Pause this objective for now.');
    assert(!!pause && pause.kind === 'pause' && pause.subject === 'objective', 'pause statement detected, filler stripped');

    const resume = detectGoalIntent('Continue working on the project.');
    assert(!!resume && resume.kind === 'resume' && resume.subject === 'the project', 'resume statement detected');

    const abandon = detectGoalIntent("Let's drop that goal");
    assert(!!abandon && abandon.kind === 'abandon', 'abandon statement detected');

    assertEqual(isGenericSubject('this objective'), true, 'generic subject recognized');
    assertEqual(isGenericSubject('the integration'), false, 'content subject not generic');
    assertEqual(isConfirmationStatement('yes'), true, 'bare yes is a confirmation');
    assertEqual(isConfirmationStatement('yes, continue working on the app'), false, 'compound statement is not a bare confirmation');

    assertEqual(isSameGoalStatement('this application', 'Build this application'), true, 'subset restatement is the same goal');
    assertEqual(isSameGoalStatement('the dashboard', 'Build the dashboard'), true, 'subset restatement with different verb is the same goal');
    assertEqual(isSameGoalStatement('the payment module', 'Build the billing module'), false, 'different modules are different goals');
  }

  // =========================================================================
  console.log('Test 2 — Creation from explicit statements; chatter ignored');
  {
    const { engine, bus } = makeEngine();
    const before = engine.stats().total;

    const obs = engine.observeMessage("Let's build this application");
    assert(obs.matched === true && obs.intent === 'create', 'explicit statement creates a goal');
    assertEqual(obs.status, 'active', 'explicit statement creates an ACTIVE goal');
    assertEqual(engine.get(obs.goalId!)?.description, 'Build this application', 'goal description includes the verb');
    assert(!!obs.goalId && obs.goalId.startsWith('goal_'), 'stable goal id format');
    assertEqual((engine.get(obs.goalId!)?.originMessage ?? '').slice(0, 24), "Let's build this applica", 'bounded provenance snippet stored');
    assertEqual(engine.stats().total, before + 1, 'exactly one goal created');
    assert(events(bus, 'GOAL_STATUS_UPDATED') === 1, 'GOAL_STATUS_UPDATED emitted on creation');

    const chatter = engine.observeMessage("what's the weather like in Paris today?");
    assertEqual(chatter.matched, false, 'ordinary question changes nothing');
    assertEqual(engine.stats().total, before + 1, 'no goal from chatter');

    const restatement = engine.observeMessage("Let's build this application now");
    assertEqual(restatement.goalId, obs.goalId, 'restatement targets the SAME goal (dedup)');
    assertEqual(engine.stats().total, before + 1, 'restatement does not duplicate the goal');
  }

  // =========================================================================
  console.log('Test 3 — Soft interest → PROPOSED + explicit confirmation flow');
  {
    const { engine, bus } = makeEngine();
    const obs = engine.observeMessage("I'm thinking of building a log parser");
    assertEqual(obs.status, 'proposed', 'soft interest creates only a PROPOSED goal');
    assertEqual(obs.needsConfirmation, true, 'proposed goal awaits confirmation');
    assertEqual(events(bus, 'GOAL_STATUS_UPDATED'), 1, 'proposal event emitted');

    // Unrelated chatter must NOT confirm it.
    const noise = engine.observeMessage('cool, tell me more about dogs');
    assertEqual(noise.matched, false, 'unrelated chatter does not confirm');
    assertEqual(engine.get(obs.goalId!)?.status, 'proposed', 'goal stays proposed without confirmation');

    const confirm = engine.observeMessage('yes');
    assert(confirm.matched === true && confirm.intent === 'confirm', 'explicit confirmation recognized');
    assertEqual(engine.get(obs.goalId!)?.status, 'active', 'confirmed goal becomes ACTIVE');
    assert(events(bus, 'GOAL_STATUS_UPDATED') >= 2, 'activation event emitted');

    const strayYes = engine.observeMessage('yes');
    assertEqual(strayYes.matched, false, 'stray yes after confirmation changes nothing');
  }

  // =========================================================================
  console.log('Test 4 — Completion, pause, resume, abandon from explicit statements');
  {
    const { engine, bus } = makeEngine();
    const integration = engine.observeMessage("Let's build the integration");
    assertEqual(engine.get(integration.goalId!)?.status, 'active', 'integration goal active');

    const done = engine.observeMessage('We have completed the integration');
    assert(done.matched === true && done.intent === 'complete', 'completion statement matched');
    assertEqual(engine.get(integration.goalId!)?.status, 'completed', 'goal completed by user statement');
    assert(events(bus, 'GOAL_MILESTONE_RECORDED') === 1, 'completion milestone recorded');
    const milestones = engine.get(integration.goalId!)?.milestones ?? [];
    assert(milestones.some((m) => m.text === 'Marked completed by user'), 'completion milestone text recorded');

    // Terminal goals never resurrect: a similar statement creates a NEW goal.
    const again = engine.observeMessage("Let's build the integration");
    assert(again.goalId !== integration.goalId, 'terminal goals are never silently resumed — a new engagement is a new goal');
    engine.transition(again.goalId!, 'abandoned', 'test cleanup — keep exactly one open goal for the generic statements below');

    const dash = engine.observeMessage("Let's build the dashboard");
    const paused = engine.observeMessage('Pause this objective for now.');
    assert(paused.matched === true && paused.intent === 'pause', 'pause statement matched');
    assertEqual(engine.get(dash.goalId!)?.status, 'paused', 'goal paused');

    const resumed = engine.observeMessage('Continue working on the project.');
    assert(resumed.matched === true && resumed.intent === 'resume', 'resume statement matched');
    assertEqual(engine.get(dash.goalId!)?.status, 'active', 'goal resumed');

    const dropped = engine.observeMessage("Let's drop that goal");
    assert(dropped.matched === true && dropped.intent === 'abandon', 'abandon statement matched');
    assertEqual(engine.get(dash.goalId!)?.status, 'abandoned', 'goal abandoned');
  }

  // =========================================================================
  console.log('Test 5 — Lifecycle transitions: invalid ones are rejected, never guessed');
  {
    const { engine } = makeEngine();
    const goal = engine.observeMessage("Let's build the search feature");
    const id = goal.goalId!;
    assertEqual(engine.transition(id, 'paused'), id ? engine.get(id) : null, 'active → paused is valid');

    const invalid = engine.transition(id, 'proposed');
    assertEqual(invalid, null, 'paused → proposed is invalid and rejected');
    assertEqual(engine.get(id)?.status, 'paused', 'invalid transition left state unchanged');

    assertEqual(engine.transition('goal_missing', 'active'), null, 'unknown goal id rejected safely');

    const completed = engine.transition(id, 'completed', 'test');
    assert(!!completed, 'paused → completed is valid');
    assertEqual(engine.transition(id, 'active'), null, 'completed is terminal — no transitions out');

    // Ambiguity: two open goals, generic reference must NOT guess.
    const a = engine.create('Write the user guide', { explicit: true });
    const b = engine.create('Translate the user guide', { explicit: true });
    assert(!!a && !!b, 'two open goals prepared');
    const ambiguous = engine.observeMessage('pause this objective for now');
    assert(ambiguous.matched === true && ambiguous.needsConfirmation === true, 'ambiguous generic statement flagged');
    assertEqual(a?.status, 'active', 'ambiguous statement changed nothing (goal A)');
    assertEqual(b?.status, 'active', 'ambiguous statement changed nothing (goal B)');
  }

  // =========================================================================
  console.log('Test 6 — Multiple simultaneous goals, bounded store, deterministic eviction');
  {
    const { engine } = makeEngine();
    const g1 = engine.create('Build the dashboard', { explicit: true });
    const g2 = engine.create('Migrate the database', { explicit: true });
    const g3 = engine.create('Write the documentation', { explicit: true });
    assert(!!g1 && !!g2 && !!g3, 'three independent goals coexist');
    assert(g1!.id !== g2!.id && g2!.id !== g3!.id, 'unique stable ids');

    engine.transition(g2!.id, 'paused', 'test');
    assertEqual(engine.get(g1!.id)?.status, 'active', 'independent state (g1)');
    assertEqual(engine.get(g2!.id)?.status, 'paused', 'independent state (g2)');

    const stats = engine.stats();
    assertEqual(stats.active, 2, 'stats: two active');
    assertEqual(stats.paused, 1, 'stats: one paused');

    // Cap + eviction: completed goals go first, open work is never evicted.
    engine.transition(g3!.id, 'completed', 'test');
    const fillerWords = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu', 'amber', 'basil', 'cedar', 'dune'];
    for (const word of fillerWords) engine.create(`Filler objective ${word}`, { explicit: false });
    const after = engine.store.records;
    assert(after.length <= 24, `store capped at 24 (got ${after.length})`);
    assert(after.some((g) => g.id === g1!.id), 'active goal survived eviction');
    assert(after.some((g) => g.id === g2!.id), 'paused goal survived eviction');
    assert(!after.some((g) => g.id === g3!.id), 'completed goal evicted first');
    assert(after.filter((g) => g.status === 'active' || g.status === 'paused').length === 2, 'open work is never evicted');
  }

  // =========================================================================
  console.log('Test 7 — Persistence across restarts; nothing auto-runs');
  {
    const storageFile = nodePath.join(tempRoot, 'goals-restart.json');
    const storage = new JsonFileStorage(storageFile);
    const first = makeEngine({ storage });
    const created = first.engine.observeMessage("Let's build the exporter");
    const proposed = first.engine.observeMessage("I'm thinking of building a scheduler");
    assertEqual(first.engine.get(created.goalId!)?.status, 'active', 'pre-restart: active goal');
    assertEqual(first.engine.get(proposed.goalId!)?.status, 'proposed', 'pre-restart: proposed goal');
    const createdId = created.goalId!;
    const createdAt = first.engine.get(createdId)?.createdAt;

    const second = makeEngine({ storage });
    const restored = second.engine.get(createdId);
    assert(!!restored, 'goal restored after restart');
    assertEqual(restored?.status, 'active', 'status restored exactly');
    assertEqual(restored?.createdAt, createdAt, 'timestamps restored (stable id, stable record)');
    assertEqual(second.engine.get(proposed.goalId!)?.status, 'proposed', 'proposed goal stays proposed after restart — nothing auto-runs');

    // Milestones persist too.
    second.engine.recordMilestone(createdId, 'Exporter core works', 'task-9');
    const third = makeEngine({ storage });
    const restoredMilestones = third.engine.get(createdId)?.milestones ?? [];
    assert(restoredMilestones.some((m) => m.text === 'Exporter core works' && m.sourceTaskId === 'task-9'), 'milestones persist across restart');
  }

  // =========================================================================
  console.log('Test 8 — Corrupted / unsupported storage recovered safely');
  {
    // Corrupt JSON → clean start, engine stays usable, next write is valid.
    const corruptStorage = new MemoryStorage();
    corruptStorage.setItem(GOALS_STORAGE_KEY, '{this is not json{{{');
    const corruptEngine = makeEngine({ storage: corruptStorage });
    assertEqual(corruptEngine.engine.stats().total, 0, 'corrupt JSON → clean start');
    const recovered = corruptEngine.engine.create('Build the repair tool', { explicit: true });
    assert(!!recovered, 'engine usable after corruption');
    const raw = JSON.parse(corruptStorage.getItem(GOALS_STORAGE_KEY)!);
    assertEqual(raw.schemaVersion, GOALS_SCHEMA_VERSION, 'storage rewritten with current schema version');

    // Future schema → do not destroy, start clean for this version.
    const futureStorage = new MemoryStorage();
    futureStorage.setItem(GOALS_STORAGE_KEY, JSON.stringify({ schemaVersion: GOALS_SCHEMA_VERSION + 7, goals: [{ id: 'goal_future', description: 'From the future' }] }));
    const futureEngine = makeEngine({ storage: futureStorage });
    assertEqual(futureEngine.engine.stats().total, 0, 'future schema → clean start, never guessed');

    // Bare array + invalid records → per-record repair (repair-don't-drop).
    const repairStorage = new MemoryStorage();
    repairStorage.setItem(
      GOALS_STORAGE_KEY,
      JSON.stringify([
        { id: 'goal_abc', description: 'Build a thing', status: 'totally-bogus', createdAt: 123, updatedAt: 456, milestones: [{ text: 'first step', at: 5 }], progress: { completed: ['a'], remaining: [], blockers: [] }, projectRefs: [], blockedByGoalIds: [] },
        { description: 'no id' },
        'garbage-entry',
      ])
    );
    const repairEngine = makeEngine({ storage: repairStorage });
    assertEqual(repairEngine.engine.stats().total, 1, 'valid record repaired, junk dropped');
    const repaired = repairEngine.engine.list()[0];
    assertEqual(repaired.status, 'proposed', 'invalid status repaired to a safe default');
    assertEqual(repaired.milestones.length, 1, 'milestones preserved through repair');
  }

  // =========================================================================
  console.log('Test 9 — Resumption briefings: relevant only, rate-limited, never executing');
  {
    let fakeNow = 1_000_000;
    const { engine, bus } = makeEngine({ now: () => fakeNow });
    const dash = engine.create('Build the dashboard', { explicit: true });
    const migrate = engine.create('Migrate the database', { explicit: true });
    engine.addProgressItem(dash!.id, 'completed', 'Chart components render');
    engine.addProgressItem(dash!.id, 'remaining', 'Wire the live data source');
    engine.addProgressItem(migrate!.id, 'blockers', 'Waiting for the staging database credentials location from the user');
    engine.transition(migrate!.id, 'paused', 'test');

    const briefings = engine.resumptionBriefing('dashboard');
    assertEqual(briefings.length, 1, 'only the relevant goal is briefed');
    assertEqual(briefings[0]?.goalId, dash!.id, 'correct goal briefed');
    const lines = briefings[0]?.lines.join('\n') ?? '';
    assert(lines.includes('status: active'), 'briefing includes status');
    assert(lines.includes('Chart components render'), 'briefing includes completed work');
    assert(lines.includes('Wire the live data source'), 'briefing includes remaining work');
    assert(events(bus, 'GOAL_RESUMPTION_BRIEFED') === 1, 'briefing event emitted');

    // Unrelated message → no briefing (no interruptions).
    assertEqual(engine.resumptionBriefing('weather in paris').length, 0, 'unrelated input briefs nothing');

    // Rate limit: same goal briefed again within the cooldown emits nothing new.
    fakeNow += 60_000;
    engine.resumptionBriefing('dashboard');
    assertEqual(events(bus, 'GOAL_RESUMPTION_BRIEFED'), 1, 'repeated briefing rate-limited');
    fakeNow += 11 * 60_000;
    engine.resumptionBriefing('dashboard');
    assertEqual(events(bus, 'GOAL_RESUMPTION_BRIEFED'), 2, 'briefing allowed again after cooldown');

    // Paused goal briefing mentions blockers.
    const pausedBriefing = engine.resumptionBriefing('migrate the database');
    const pausedLines = pausedBriefing.map((b) => b.lines.join('\n')).join('\n');
    assert(pausedLines.includes('status: paused'), 'paused goal briefed with status');
    assert(pausedLines.includes('Waiting for the staging database'), 'briefing includes blockers');

    // Empty input → most recently active goals, still bounded.
    const all = engine.resumptionBriefing('');
    assert(all.length >= 1 && all.length <= 3, 'empty input briefs bounded recents');
  }

  // =========================================================================
  console.log('Test 10 — Project association: approved roots only');
  {
    const fixtureDir = nodePath.join(tempRoot, 'goal-fixture-suite');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(nodePath.join(fixtureDir, 'package.json'), JSON.stringify({ name: 'goal-fixture-suite', version: '1.0.0', dependencies: { react: '^18.0.0' } }));
    writeFileSync(nodePath.join(fixtureDir, 'README.md'), '# goal-fixture-suite\nA fixture project for goal association tests.');

    const parts = makeEngine({ fixtureDir });
    const indexed = await parts.projects!.approveRoot(fixtureDir);
    assert(indexed.ok === true, 'fixture project approved');
    await parts.projects!.index(fixtureDir);

    const goal = parts.engine.create('Ship the goal-fixture-suite installer', { explicit: true });
    assert(!!goal, 'goal created');
    assertEqual(parts.engine.associateProject(goal!.id, fixtureDir), true, 'approved root associated');
    const ref = parts.engine.get(goal!.id)?.projectRefs[0];
    assert(!!ref && ref.name === 'goal-fixture-suite', 'project ref carries the project name');
    assert(!!ref && ref.projectId.length > 0, 'project ref carries the stable project id');

    assertEqual(parts.engine.associateProject(goal!.id, nodePath.join(tempRoot, 'not-approved')), false, 'unapproved root refused');
    assertEqual(parts.engine.get(goal!.id)?.projectRefs.length, 1, 'no phantom association recorded');

    // Auto-association from the statement itself.
    const auto = parts.engine.observeMessage("Let's build goal-fixture-suite for real");
    const autoRefs = parts.engine.get(auto.goalId!)?.projectRefs ?? [];
    assertEqual(autoRefs.length, 1, 'statement naming the project auto-associates (approved roots only)');
    assertEqual(autoRefs[0]?.name, 'goal-fixture-suite', 'auto-associated with the right project');

    // Briefing surfaces the project.
    const briefing = parts.engine.resumptionBriefing('goal-fixture-suite');
    assert((briefing[0]?.lines ?? []).some((l) => l.includes('Project: goal-fixture-suite')), 'briefing mentions the associated project');
  }

  // =========================================================================
  console.log('Test 11 — Forgotten/deleted project: stale references cleared');
  {
    const fixtureDir = nodePath.join(tempRoot, 'forget-fixture');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(nodePath.join(fixtureDir, 'package.json'), JSON.stringify({ name: 'forget-fixture' }));

    const parts = makeEngine({ fixtureDir });
    await parts.projects!.approveRoot(fixtureDir);
    await parts.projects!.index(fixtureDir);
    const goal = parts.engine.create('Ship the forget-fixture release', { explicit: true });
    parts.engine.associateProject(goal!.id, fixtureDir);
    assertEqual(parts.engine.get(goal!.id)?.projectRefs.length, 1, 'pre-condition: associated');

    parts.projects!.forget(fixtureDir); // emits PROJECT_STATUS_UPDATED {forgotten:true}
    assertEqual(parts.engine.get(goal!.id)?.projectRefs.length, 0, 'forgotten project reference stripped by the event');
    assert(!!parts.engine.get(goal!.id), 'the goal itself survives — only the stale reference is removed');

    // Lazy validation on a restart whose ProjectEngine no longer knows the root.
    const storageFile = nodePath.join(tempRoot, 'goals-stale-ref.json');
    const storage = new JsonFileStorage(storageFile);
    const first = makeEngine({ storage, fixtureDir });
    await first.projects!.approveRoot(fixtureDir);
    await first.projects!.index(fixtureDir);
    const g = first.engine.create('Work on the forget-fixture docs', { explicit: true });
    first.engine.associateProject(g!.id, fixtureDir);
    // Fresh engine over the same goals storage, wired to a FRESH ProjectEngine
    // that has never approved anything → the old root is unknown now.
    const second = makeEngine({ storage, fixtureDir: nodePath.join(tempRoot, 'never-approved-fixture') });
    const briefings = second.engine.resumptionBriefing('forget-fixture docs');
    assertEqual(second.engine.get(g!.id)?.projectRefs.length, 0, 'stale reference dropped lazily on briefing');
    assert(briefings.length === 1 && !briefings[0].lines.some((l) => l.startsWith('Project:')), 'briefing no longer cites the stale project');
  }

  // =========================================================================
  console.log('Test 12 — Memory integration: marker-owned mirrors, released on forget');
  {
    const storage = new MemoryStorage();
    const memory = new MemoryService(storage);
    const { engine } = makeEngine({ storage, memory });

    const unrelated = memory.remember('User prefers dark mode', { category: 'preference', source: 'user_manual', importance: 0.9, confidence: 0.9 });
    const unrelatedId = unrelated.action === 'created' ? unrelated.record.id : '';
    assert(!!unrelatedId, 'unrelated user memory stored');

    const pay = engine.create('Build the payment module', { explicit: true });
    const billing = engine.create('Build the billing module', { explicit: true });
    const mirrors = memory.records.filter((r) => (r.metadata as { goalId?: string } | undefined)?.goalId);
    assertEqual(mirrors.length, 2, 'one compact mirror per goal (id markers prevent cross-goal merges)');
    const payMirror = mirrors.find((r) => (r.metadata as { goalId?: string }).goalId === pay!.id);
    assert(!!payMirror && payMirror.content.startsWith('[goal '), 'mirror content carries the unique goal marker');

    engine.transition(pay!.id, 'paused', 'test');
    const updatedMirror = memory.records.find((r) => (r.metadata as { goalId?: string } | undefined)?.goalId === pay!.id);
    assert(!!updatedMirror && updatedMirror.content.includes('paused'), 'mirror content refreshed on status change');

    assertEqual(engine.forget(pay!.id), true, 'goal forgotten');
    assertEqual(memory.records.filter((r) => (r.metadata as { goalId?: string } | undefined)?.goalId === pay!.id).length, 0, 'mirror released through MemoryService.forget');
    assert(!!memory.get(unrelatedId), 'unrelated user memory untouched by goal forgetting');
    assert(memory.records.some((r) => (r.metadata as { goalId?: string } | undefined)?.goalId === billing!.id), 'other goal mirrors untouched');

    // Briefing rides the existing memory recall path (the mirror is recallable).
    const recalled = memory.recall('billing module', { limit: 8 });
    assert(recalled.some((r) => r.content.includes('billing')), 'goal mirrors surface through normal memory recall');
  }

  // =========================================================================
  console.log('Test 13 — Graph mirror integrity: snapshot-based prune, >10-edge proof');
  {
    const graphStorage = new MemoryStorage();
    const knowledge = new KnowledgeGraphFacade({ storage: graphStorage });
    const fixtureDir = nodePath.join(tempRoot, 'graph-fixture');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(nodePath.join(fixtureDir, 'package.json'), JSON.stringify({ name: 'graph-fixture' }));

    const parts = makeEngine({ fixtureDir, knowledge });
    await parts.projects!.approveRoot(fixtureDir);
    await parts.projects!.index(fixtureDir); // ProjectEngine mirrors the project node

    const goalIds: string[] = [];
    const goal = parts.engine.create('Ship the graph-fixture release', { explicit: true });
    goalIds.push(goal!.id);
    parts.engine.associateProject(goal!.id, fixtureDir);
    const goalNodes = knowledge.graph.getNodesByType('goal', 64).filter((n) => n.properties?.goalId === goal!.id);
    assertEqual(goalNodes.length, 1, 'one goal node mirrored');
    const edges = knowledge.graph.getAllEdges(knowledge.graph.limits.maxEdges).filter((e) => e.source === 'goal_continuity');
    assertEqual(edges.length, 2, 'owns + related_to edges mirrored');

    // Description refinement ("Build the dashboard" → "Build this dashboard")
    // changes the node label — the stale-labeled node must be pruned.
    const dash = parts.engine.observeMessage("Let's build the dashboard");
    goalIds.push(dash.goalId!);
    assertEqual(knowledge.graph.getNodesByType('goal', 64).filter((n) => n.properties?.goalId === dash.goalId).length, 1, 'dashboard node mirrored');
    parts.engine.observeMessage('I want to build this dashboard'); // same goal, longer description
    const dashAfter = parts.engine.get(dash.goalId!)!;
    assertEqual(dashAfter.description, 'Build this dashboard', 'restatement refined the description');
    const dashNodesAfter = knowledge.graph.getNodesByType('goal', 64).filter((n) => n.properties?.goalId === dash.goalId);
    assertEqual(dashNodesAfter.length, 1, 'refinement pruned the stale-labeled node — exactly one remains');

    // >10-edge proof: 12 goals associated with the same project (relation
    // queries cap at maxQueryResults=10 — only a complete-snapshot prune can
    // clean these up). Genuinely distinct objectives: token-similar
    // statements would (correctly) dedup into one goal.
    const moduleObjectives = [
      'Plan the alpha migration',
      'Write the bravo guide',
      'Test the charlie suite',
      'Ship the delta service',
      'Fix the echo bug',
      'Design the foxtrot schema',
      'Audit the golf security',
      'Refactor the hotel pipeline',
      'Deploy the india release',
      'Cache the kilo queries',
      'Log the lima events',
      'Document the mike API',
    ];
    for (const objective of moduleObjectives) {
      const g = parts.engine.create(objective, { explicit: true });
      if (g && parts.engine.associateProject(g.id, fixtureDir)) goalIds.push(g.id);
    }
    assertEqual(goalIds.length, 14, '14 goals total prepared');
    const continuityEdgesBefore = knowledge.graph.getAllEdges(knowledge.graph.limits.maxEdges).filter((e) => e.source === 'goal_continuity');
    assert(continuityEdgesBefore.length > 10, `pre-condition: more than 10 goal_continuity edges (${continuityEdgesBefore.length})`);
    for (const id of goalIds) parts.engine.forget(id);
    const continuityEdgesAfter = knowledge.graph.getAllEdges(knowledge.graph.limits.maxEdges).filter((e) => e.source === 'goal_continuity');
    assertEqual(continuityEdgesAfter.length, 0, 'snapshot-based prune removed ALL goal_continuity edges (cap-blind prune would leak)');
    assertEqual(knowledge.graph.getNodesByType('goal', 64).length, 0, 'no stale goal nodes remain');
    const projectNode = knowledge.graph.getNodesByType('project', 64)[0];
    assert(!!projectNode, 'the PROJECT node (owned by ProjectEngine) was never deleted');
  }

  // =========================================================================
  console.log('Test 14 — Task milestone tracking: completion feeds goals, cancellation changes nothing');
  {
    const storage = new MemoryStorage();
    const bus = new AgentEventBus();
    const tasks = new Map<string, { goal?: { description?: string } }>();
    const { engine } = makeEngine({ storage, bus, getTask: (id) => tasks.get(id) });
    engine.attach(bus);

    const dash = engine.create('Build the dashboard', { explicit: true });
    const beforeActivity = engine.get(dash!.id)!.lastActivityAt;

    tasks.set('t1', { goal: { description: 'Build the dashboard' } });
    bus.emit({ name: 'TASK_COMPLETED', taskId: 't1', payload: {}, timestamp: Date.now() });
    const milestones = engine.get(dash!.id)!.milestones;
    assert(milestones.some((m) => m.sourceTaskId === 't1' && m.outcome === 'progress'), 'task completion recorded as goal milestone');
    assert(engine.get(dash!.id)!.status === 'active', 'task completion NEVER auto-completes the goal');
    assert(engine.get(dash!.id)!.lastActivityAt >= beforeActivity, 'activity timestamp bumped');

    const unrelatedBefore = engine.get(dash!.id)!.milestones.length;
    tasks.set('t2', { goal: { description: 'Renew the parking permit' } });
    bus.emit({ name: 'TASK_COMPLETED', taskId: 't2', payload: {}, timestamp: Date.now() });
    assertEqual(engine.get(dash!.id)!.milestones.length, unrelatedBefore, 'unrelated task completion records nothing');

    tasks.set('t3', { goal: { description: 'Build the dashboard' } });
    bus.emit({ name: 'TASK_CANCELLED', taskId: 't3', payload: {}, timestamp: Date.now() });
    assertEqual(engine.get(dash!.id)!.milestones.length, unrelatedBefore, 'cancellation records NOTHING (emergency-stop semantics preserved)');
    assertEqual(engine.get(dash!.id)!.status, 'active', 'cancellation changes no goal state');

    tasks.set('t4', { goal: { description: 'Build the dashboard' } });
    bus.emit({ name: 'TASK_FAILED', taskId: 't4', payload: {}, timestamp: Date.now() });
    assertEqual(engine.get(dash!.id)!.milestones.length, unrelatedBefore, 'failure adds no milestone');
    assert(engine.get(dash!.id)!.status === 'active', 'failure does not change goal status');

    const forgotten = engine.forget(dash!.id);
    assertEqual(forgotten, true, 'goal with milestones forgettable');
  }

  // =========================================================================
  console.log('Test 15 — Permission boundaries: goal tools require memory.access');
  {
    const storage = new MemoryStorage();
    const bus = new AgentEventBus();
    const { engine } = makeEngine({ storage, bus });
    const registry = new ToolRegistry(bus);
    registry.registerAll(createGoalTools({ goals: engine }));

    const denied = await registry.execute('goal.list', {}, TOOL_CTX((() => {
      const p = new PermissionManager();
      p.revoke('memory.access');
      return p;
    })()));
    assertEqual(denied.success, false, 'goal.list denied without memory.access');
    assertEqual(denied.errorKind, 'permission_denied', 'denial is a structured permission failure');

    const allowed = await registry.execute('goal.list', {}, TOOL_CTX());
    assertEqual(allowed.success, true, 'goal.list allowed with the default grant');

    const created = await registry.execute('goal.create', { description: 'Write the user guide' }, TOOL_CTX());
    assertEqual(created.success, true, 'goal.create allowed');
    const goalId = (created.output as { goal: GoalRecord }).goal.id;

    const badTransition = await registry.execute('goal.update', { goalId, status: 'proposed' }, TOOL_CTX());
    assertEqual(badTransition.success, false, 'invalid lifecycle transition rejected through the tool');

    const progress = await registry.execute('goal.update', { goalId, addCompleted: 'Guide outline done' }, TOOL_CTX());
    assertEqual(progress.success, true, 'progress update allowed');
    assert((engine.get(goalId)?.progress.completed ?? []).includes('Guide outline done'), 'progress item persisted');

    const forgotten = await registry.execute('goal.forget', { goalId }, TOOL_CTX());
    assertEqual(forgotten.success, true, 'goal.forget allowed through the gate');
    assertEqual(engine.get(goalId), undefined, 'goal removed from the store');
  }

  // =========================================================================
  console.log('Test 16 — Emergency stop: mutations blocked, read-only goals intact');
  {
    const storage = new MemoryStorage();
    const bus = new AgentEventBus();
    const { engine } = makeEngine({ storage, bus });
    const registry = new ToolRegistry(bus);
    const permissions = new PermissionManager();
    const emergencyStop = new EmergencyStop();
    const audit = new SafetyAuditLog();
    registry.setSafetyGate(new SafetyGate({ permissions, emergencyStop, audit }));
    registry.registerAll(createGoalTools({ goals: engine }));

    const preExisting = engine.create('Build the importer', { explicit: true });

    emergencyStop.activate('exercise');
    const blocked = await registry.execute('goal.create', { description: 'Build the smuggler' }, TOOL_CTX(permissions));
    assertEqual(blocked.success, false, 'goal.create blocked during emergency stop');
    assertEqual(blocked.errorKind, 'permission_denied', 'stop denial is a structured permission failure');
    const readable = await registry.execute('goal.list', {}, TOOL_CTX(permissions));
    assertEqual(readable.success, true, 'read-only goal inspection still works during emergency stop');
    assertEqual(engine.get(preExisting!.id)?.status, 'active', 'emergency stop does not mutate goal state');
    emergencyStop.deactivate();

    const afterStop = await registry.execute('goal.create', { description: 'Build the exporter' }, TOOL_CTX(permissions));
    assertEqual(afterStop.success, true, 'mutation works again after deactivation');
  }

  // =========================================================================
  console.log('Test 17 — Minimal wiring + skill hints stay verified-only');
  {
    // Engine with NO optional integrations still works.
    const bare = new GoalEngine({ storage: new MemoryStorage() });
    const obs = bare.observeMessage("Let's build the thing-a-ma-jig");
    assertEqual(obs.status, 'active', 'bare engine creates goals');
    assertEqual(bare.resumptionBriefing('thing-a-ma-jig').length, 1, 'bare engine briefs');
    assertEqual(bare.forget(obs.goalId!), true, 'bare engine forgets');

    // Skill hints: present only for verified reusable skills, never executed.
    const skillsBus = new AgentEventBus();
    const skills = new SkillEngine({ registry: new ToolRegistry(skillsBus), events: skillsBus, storage: new MemoryStorage() });
    const { engine } = makeEngine({ skills });
    engine.create('Build the dashboard', { explicit: true });
    const briefing = engine.resumptionBriefing('dashboard');
    const joined = briefing.map((b) => b.lines.join('\n')).join('\n');
    assert(!joined.includes('verified learned skill'), 'no skill hint when no verified skill exists');
    assert(briefing.length >= 1, 'briefing unaffected by the empty skill engine');
  }

  // =========================================================================
  console.log(`\n=== Goal Continuity v1: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Suite crashed:', err);
  process.exit(1);
});
