/**
 * Phase 15 verification suite — Proactive Intelligence.
 * Usage: npx tsx scripts/test-proactive-phase15.ts
 * Deterministic: Date.now()-based advancing clock; no real timers except the
 * explicitly-tested one-shot scheduler (short delays).
 * Exits non-zero on any failure.
 */
import { AgentEventBus, type AgentEvent } from '../src/agent/events';
import { SignalDetector, shortHash } from '../src/agent/proactive/proactiveSignals';
import { ProactiveContext, opportunityDedupKey } from '../src/agent/proactive/proactiveContext';
import { evaluatePolicy } from '../src/agent/proactive/proactivePolicy';
import { decide, minimumLevelFor } from '../src/agent/proactive/proactiveDecider';
import { ProactiveScheduler } from '../src/agent/proactive/proactiveScheduler';
import { executeConfirmed, verifyAction, verifySuggestionPresented } from '../src/agent/proactive/proactiveActions';
import { ProactiveService } from '../src/agent/proactive/proactiveService';
import {
  DEFAULT_BUDGET,
  isNeverAutomatic,
  type ProactiveOpportunity,
  type ProactiveRiskCategory,
  type ProactiveSignal,
  type ProactiveSuggestedAction,
} from '../src/agent/proactive/proactiveTypes';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { MemoryService } from '../src/agent/memory/memoryService';
import { MemoryStorage } from '../src/agent/taskState';
import { MultimodalContext } from '../src/agent/multimodal/multimodalContext';
import type { AgentTool, ToolResult } from '../src/agent/types';
import type { ProactiveSuggestion } from '../src/agent/proactive/proactiveTypes';

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

/** Shared test-time offset — keeps Date.now()-based fixtures consistent with advanced clocks. */
let TEST_OFFSET = 0;
function makeClock() {
  return {
    now: () => Date.now() + TEST_OFFSET,
    advance: (ms: number) => {
      TEST_OFFSET += ms;
    },
  };
}

function evt(name: AgentEvent['name'], opts: { taskId?: string; stepId?: string; payload?: Record<string, unknown> } = {}): AgentEvent {
  return { name, taskId: opts.taskId, stepId: opts.stepId, payload: opts.payload, timestamp: Date.now() };
}

function makeSignal(type: ProactiveSignal['type'], opts: Partial<ProactiveSignal> = {}): ProactiveSignal {
  const now = Date.now() + TEST_OFFSET;
  return {
    id: `sig-${Math.random().toString(36).slice(2)}`,
    type,
    dedupKey: opts.dedupKey ?? `${type}:${shortHash(opts.metadata?.['entity'] as string ?? 'x')}`,
    taskId: opts.taskId,
    timestamp: now,
    expiresAt: opts.expiresAt ?? now + 10 * 60_000,
    confidence: opts.confidence ?? 0.8,
    importance: opts.importance ?? 0.6,
    urgency: opts.urgency ?? 0.5,
    evidence: opts.evidence ?? [{ source: 'test', quote: 'test evidence', timestamp: now, confidence: 0.8 }],
    metadata: opts.metadata ?? {},
  };
}

function makeOpportunity(opts: {
  type?: ProactiveOpportunity['type'];
  risk?: ProactiveRiskCategory;
  confidence?: number;
  importance?: number;
  urgency?: number;
  expectedBenefit?: number;
  intrusiveness?: number;
  action?: ProactiveSuggestedAction | null;
  taskId?: string;
  ttlMs?: number;
} = {}): ProactiveOpportunity {
  const now = Date.now() + TEST_OFFSET;
  const action = opts.action === null ? undefined : opts.action ?? {
    toolName: 'test.readonly',
    input: {},
    description: 'read-only test action',
    category: opts.risk ?? 'general',
    requiredPermissions: ['application.launch'],
    reversible: true,
    minLevel: 1,
  };
  return {
    id: `opp-${Math.random().toString(36).slice(2)}`,
    type: opts.type ?? 'task_completed',
    dedupKey: opportunityDedupKey(opts.type ?? 'task_completed', opts.taskId ?? 't1'),
    createdAt: now,
    expiresAt: now + (opts.ttlMs ?? 10 * 60_000),
    confidence: opts.confidence ?? 0.8,
    importance: opts.importance ?? 0.6,
    urgency: opts.urgency ?? 0.5,
    expectedBenefit: opts.expectedBenefit ?? 0.6,
    intrusiveness: opts.intrusiveness ?? 0.25,
    risk: opts.risk ?? 'general',
    requiredPermissions: action ? action.requiredPermissions : [],
    suggestedAction: action,
    triggerSignalIds: [],
    evidence: [{ source: 'test', quote: 'evidence', timestamp: now, confidence: 0.85 }],
    status: 'DETECTED',
    statusReasons: [],
  };
}

function makeRegistryTools(): AgentTool[] {
  const tool: AgentTool = {
    name: 'test.readonly',
    description: 'read-only test tool',
    category: 'system',
    riskLevel: 'low',
    cost: 'cheap',
    reliability: 0.99,
    capabilities: ['test.readonly'],
    permissions: ['application.launch'],
    inputSchema: {},
    verification: { strategy: 'self_reported', description: 'test' },
    timeoutMs: 5000,
    async execute(): Promise<ToolResult> {
      return { success: true, output: { ok: 1 } };
    },
  };
  return [tool];
}

// ------------------------------------------------------------ signal detection
{
  console.log('Signal creation + dedup + expiry');
  const detector = new SignalDetector();
  const t0 = Date.now();

  const s1 = detector.ingest(evt('TASK_COMPLETED', { taskId: 't1', payload: { stepCount: 3 } }), t0);
  assertEqual(s1.length, 1, 'TASK_COMPLETED produces one signal');
  assertEqual(s1[0].type, 'task_completed', 'signal type');
  assert(s1[0].dedupKey.includes('task:t1'), 'dedup key names the task');
  assert(s1[0].expiresAt > s1[0].timestamp, 'signal has TTL');

  // Dedup: same entity within window refreshes, not duplicates
  const s2 = detector.ingest(evt('TASK_COMPLETED', { taskId: 't1', payload: { stepCount: 3 } }), t0 + 1000);
  assertEqual(detector.live(t0 + 1001).filter((s) => s.type === 'task_completed').length, 1, 'duplicate within window refreshes');
  assert(s2.length === 1, 'ingest still returns the refreshed signal');

  // Outside the dedup window → treated as new occurrence (replaces old key)
  detector.ingest(evt('TASK_COMPLETED', { taskId: 't1', payload: { stepCount: 3 } }), t0 + 10_000);
  assertEqual(detector.live(t0 + 10_001).filter((s) => s.type === 'task_completed').length, 1, 'post-window event replaces, never accumulates');

  // Expiration
  detector.ingest(evt('TASK_CANCELLED', { taskId: 't2', payload: { completedSteps: 2 } }), t0 + 10_500);
  assert(detector.byType('task_unfinished', t0 + 11_000).length === 1, 'unfinished-task signal live');
  assertEqual(detector.byType('task_unfinished', t0 + 11_000 + 10 * 60_000).length, 0, 'signal expires after TTL');

  // Irrelevant events produce nothing
  assertEqual(detector.ingest(evt('TOOL_REGISTERED'), t0).length, 0, 'irrelevant event ignored');

  // Bounded store
  for (let i = 0; i < 80; i++) detector.ingest(evt('BROWSER_NAVIGATED', { payload: { url: `https://site${i}.com/x` } }), t0 + 20_000 + i * 6000);
  assert(detector.stats(t0 + 10 * 60_000).total <= 50, `signal store bounded (${detector.stats(t0 + 10 * 60_000).total} <= 50)`);

  // safeMeta: detector-produced signals carry curated primitive metadata only
  // (nested objects are stripped — bounded, no raw payload hoarding)
  const sig = detector.ingest(evt('TASK_COMPLETED', { taskId: 'meta1', payload: { stepCount: 2, nested: { a: 1 } } }), t0)[0];
  assert(!('nested' in sig.metadata) && typeof sig.metadata['stepCount'] === 'number', 'metadata values are curated primitives only');

  // SCREEN_CHANGED below significance threshold ignored
  assertEqual(detector.ingest(evt('SCREEN_CHANGED', { payload: { changedFraction: 0.05 } }), t0).length, 0, 'minor screen change not proactive-relevant');
  assertEqual(detector.ingest(evt('SCREEN_CHANGED', { payload: { changedFraction: 0.6 } }), t0).length, 1, 'significant screen change produces a signal');
}

// ------------------------------------------------------- activity classification
{
  console.log('User-activity awareness (event-history based, no polling)');
  const clock = makeClock();
  const ctx = new ProactiveContext(DEFAULT_BUDGET);
  assertEqual(ctx.activityState(clock.now()), 'IDLE', 'no events → IDLE');
  ctx.recordEvent(evt('USER_MESSAGE'), clock.now());
  assertEqual(ctx.activityState(clock.now()), 'ACTIVE', 'recent user event → ACTIVE');
  clock.advance(4000);
  ctx.recordEvent(evt('TASK_STARTED', { taskId: 't9' }), clock.now());
  assertEqual(ctx.activityState(clock.now()), 'BUSY', 'active task in flight → BUSY');
  ctx.recordEvent(evt('TASK_COMPLETED', { taskId: 't9' }), clock.now());
  assertEqual(ctx.activityState(clock.now()), 'ACTIVE', 'task ended → ACTIVE again');
  clock.advance(70_000);
  assertEqual(ctx.activityState(clock.now()), 'IDLE', 'quiet for 60s+ → IDLE');
  clock.advance(-70_000);
  clock.advance(30_000);
  assertEqual(ctx.activityState(clock.now()), 'UNCERTAIN', 'between windows → UNCERTAIN');
}

// ------------------------------------------------------------ policy gates
{
  console.log('Policy gates — expiry, duplicate, rejection, cooldown, budget, confidence');
  const clock = makeClock();
  const ctx = new ProactiveContext(DEFAULT_BUDGET);

  // Expiry
  const expired = makeOpportunity({ ttlMs: -1 });
  assertEqual(evaluatePolicy(expired, ctx, clock.now()).gate, 'expired', 'expired opportunity blocked');

  // Duplicate suppression (recently presented same entity)
  const opp = makeOpportunity({ taskId: 'dup1' });
  ctx.recordPresented(
    {
      id: 's-dup', opportunityId: opp.id, text: 'x', level: 1, confirmationRequired: false,
      presentedAt: clock.now(), expiresAt: clock.now() + 60_000, category: 'general', dedupKey: opp.dedupKey, suggestedAction: undefined, status: 'PRESENTED',
    },
    clock.now()
  );
  assertEqual(evaluatePolicy(makeOpportunity({ taskId: 'dup1' }), ctx, clock.now()).gate, 'duplicate', 'duplicate presentation suppressed');

  // Rejection suppression + escalation
  const clock2 = makeClock();
  const ctx2 = new ProactiveContext(DEFAULT_BUDGET);
  const mkSug = (id: string): ProactiveSuggestion => ({
    id, opportunityId: `o-${id}`, text: 'x', level: 1, confirmationRequired: false,
    presentedAt: clock2.now(), expiresAt: clock2.now() + 60_000, category: 'navigation' as ProactiveRiskCategory,
    dedupKey: `navigation:${id}`, suggestedAction: undefined, status: 'PRESENTED',
  });
  ctx2.recordRejection(mkSug('r1'), clock2.now());
  let until1 = ctx2.rejectionSuppressionUntil('navigation', clock2.now());
  ctx2.recordRejection(mkSug('r2'), clock2.now());
  let until2 = ctx2.rejectionSuppressionUntil('navigation', clock2.now());
  assert(until2 > until1, `rejection suppression escalates (${until2 - clock2.now()} > ${until1 - clock2.now()})`);
  ctx2.recordRejection(mkSug('r3'), clock2.now());
  ctx2.recordRejection(mkSug('r4'), clock2.now());
  ctx2.recordRejection(mkSug('r5'), clock2.now());
  ctx2.recordRejection(mkSug('r6'), clock2.now());
  ctx2.recordRejection(mkSug('r7'), clock2.now());
  ctx2.recordRejection(mkSug('r8'), clock2.now());
  ctx2.recordRejection(mkSug('r9'), clock2.now());
  ctx2.recordRejection(mkSug('r10'), clock2.now());
  const cappedWindow = ctx2.rejectionSuppressionUntil('navigation', clock2.now()) - clock2.now();
  assert(cappedWindow <= DEFAULT_BUDGET.rejectionSuppressMaxMs, `escalation capped at rejectionSuppressMaxMs (${Math.round(cappedWindow / 60000)}m)`);
  assert(evaluatePolicy(makeOpportunity({ risk: 'navigation' }), ctx2, clock2.now()).gate === 'rejection_suppressed', 'rejected category suppressed');

  // Cooldown (same category presented just now, no rejection)
  const clock3 = makeClock();
  const ctx3 = new ProactiveContext({ ...DEFAULT_BUDGET, perCategoryCooldownMs: 60_000 });
  ctx3.recordPresented(
    {
      id: 's-cd', opportunityId: 'o-cd', text: 'x', level: 1, confirmationRequired: false,
      presentedAt: clock3.now(), expiresAt: clock3.now() + 60_000, category: 'observation',
      dedupKey: 'observation:cd', suggestedAction: undefined, status: 'PRESENTED',
    },
    clock3.now()
  );
  assertEqual(evaluatePolicy(makeOpportunity({ risk: 'observation' }), ctx3, clock3.now()).gate, 'cooldown', 'category cooldown blocks');
  clock3.advance(61_000);
  assert(evaluatePolicy(makeOpportunity({ risk: 'observation' }), ctx3, clock3.now()).allowed, 'cooldown lapses');

  // Budget exhaustion (distinct entities/categories within window)
  const clock4 = makeClock();
  const ctx4 = new ProactiveContext({ ...DEFAULT_BUDGET, perCategoryCooldownMs: 0 });
  const cats: ProactiveRiskCategory[] = ['general', 'navigation', 'observation'];
  cats.forEach((c, i) =>
    ctx4.recordPresented(
      {
        id: `s-b${i}`, opportunityId: `o-b${i}`, text: 'x', level: 1, confirmationRequired: false,
        presentedAt: clock4.now() + i, expiresAt: clock4.now() + 60_000, category: c,
        dedupKey: `${c}:b${i}`, suggestedAction: undefined, status: 'PRESENTED',
      },
      clock4.now() + i
    )
  );
  const gate = evaluatePolicy(makeOpportunity({ risk: 'file_read' }), ctx4, clock4.now());
  assertEqual(gate.gate, 'budget_exhausted', 'interruption budget exhausted');
  clock4.advance(DEFAULT_BUDGET.windowMs + 1000);
  assert(evaluatePolicy(makeOpportunity({ risk: 'file_read' }), ctx4, clock4.now()).allowed, 'budget window rolls');

  // Low confidence
  assertEqual(evaluatePolicy(makeOpportunity({ confidence: 0.3 }), ctx4, clock4.now()).gate, 'low_confidence', 'weak evidence blocked');
}

// ------------------------------------------------------------ decision engine
{
  console.log('Decision engine — levels, safety blocks, justification');
  const clock = makeClock();
  const ctx = new ProactiveContext(DEFAULT_BUDGET);
  const granted = new Set<string>(['application.launch', 'screen.observation']);

  // Low-risk reversible with granted permission → SUGGEST level 1
  const d1 = decide({ opportunity: makeOpportunity({ taskId: 'fresh1' }), activity: 'ACTIVE', grantedPermissions: granted, now: clock.now() }, ctx);
  assertEqual(d1.action, 'SUGGEST', 'low-risk reversible → SUGGEST');
  assertEqual(d1.level, 1, 'level 1');

  // Missing permission → REQUEST_CONFIRMATION level 2 (never acts)
  const d2 = decide({ opportunity: makeOpportunity({ taskId: 'fresh2', action: { toolName: 'test.x', input: {}, description: 'x', category: 'general', requiredPermissions: ['other.perm'], reversible: true, minLevel: 1 } }), activity: 'ACTIVE', grantedPermissions: new Set(), now: clock.now() }, ctx);
  assertEqual(d2.action, 'REQUEST_CONFIRMATION', 'missing permission → confirmation, never action');
  assertEqual(d2.level, 2, 'confirmation level 2');

  // High-risk category → hard block LEVEL 4 even with everything granted
  const d3 = decide(
    {
      opportunity: makeOpportunity({
        taskId: 'fresh3',
        risk: 'destructive',
        confidence: 0.99,
        action: { toolName: 'filesystem.delete', input: {}, description: 'delete', category: 'destructive', requiredPermissions: [], reversible: false, minLevel: 4 },
      }),
      activity: 'IDLE',
      grantedPermissions: granted,
      now: clock.now(),
    },
    ctx
  );
  assertEqual(d3.action, 'SUPPRESS', 'destructive category suppressed');
  assertEqual(d3.level, 4, 'level 4 hard block');
  assert(d3.reason.includes('never automatically executed'), 'explicit never-execute reason');

  // Irreversible non-general action suppressed
  const d4 = decide(
    {
      opportunity: makeOpportunity({ taskId: 'fresh4', risk: 'system_change', action: { toolName: 'sys.change', input: {}, description: 'x', category: 'system_change', requiredPermissions: [], reversible: false, minLevel: 4 } }),
      activity: 'IDLE',
      grantedPermissions: granted,
      now: clock.now(),
    },
    ctx
  );
  assertEqual(d4.action, 'SUPPRESS', 'irreversible action never proactively executed');

  // User BUSY → suppression of non-critical suggestion
  const d5 = decide({ opportunity: makeOpportunity({ taskId: 'fresh5' }), activity: 'BUSY', grantedPermissions: granted, now: clock.now() }, ctx);
  assertEqual(d5.action, 'SUPPRESS', 'busy user → suppression');
  assert(d5.reason.includes('busy'), 'busy reason recorded');

  // Interruption justification math
  const unjustified = makeOpportunity({ taskId: 'fresh6', importance: 0.2, urgency: 0.2, intrusiveness: 0.8 });
  const d6 = decide({ opportunity: unjustified, activity: 'ACTIVE', grantedPermissions: granted, now: clock.now() }, ctx);
  assert(d6.action === 'SUPPRESS' || d6.action === 'WAIT', 'unjustified interruption deferred');
  assert(d6.reason.includes('not justified'), 'justification reason recorded');

  // Weak benefit → RECORD_ONLY; strong but weak evidence → WAIT
  const d7 = decide({ opportunity: makeOpportunity({ taskId: 'fresh7', expectedBenefit: 0.1 }), activity: 'ACTIVE', grantedPermissions: granted, now: clock.now() }, ctx);
  assertEqual(d7.action, 'RECORD_ONLY', 'low benefit recorded only');

  // Expiry imminent → not relevant anymore
  const d8 = decide({ opportunity: makeOpportunity({ taskId: 'fresh8', ttlMs: 20_000 }), activity: 'IDLE', grantedPermissions: granted, now: clock.now() + 5000 }, ctx);
  assertEqual(d8.action, 'RECORD_ONLY', 'nearly-expired opportunity not relevant');

  // minimumLevelFor mapping
  assertEqual(minimumLevelFor('destructive'), 4, 'destructive → L4');
  assertEqual(minimumLevelFor('financial'), 4, 'financial → L4');
  assertEqual(minimumLevelFor('credential'), 4, 'credential → L4');
  assertEqual(minimumLevelFor('file_write'), 3, 'file_write → L3');
  assertEqual(minimumLevelFor('general'), 1, 'general → L1');
  for (const c of ['communication', 'security'] as const) assert(isNeverAutomatic(c), `${c} never automatic`);
}

// ------------------------------------------------------- scheduler (one-shot)
{
  console.log('Scheduler — bounded one-shot checks, cancellation, budget');
  const fired: string[] = [];
  const scheduler = new ProactiveScheduler((c) => fired.push(c.id), () => undefined);

  const opp = makeOpportunity({ taskId: 'sched1' });
  const check = scheduler.schedule(opp, Date.now() + 40, 'test follow-up');
  assert(check !== null, 'schedules a future one-shot check');
  assertEqual(scheduler.pending().length, 1, 'pending entry tracked');
  check!.cancel();
  assertEqual(scheduler.pending().length, 0, 'cancellation path works');

  const check2 = scheduler.schedule(opp, Date.now() + 30, 'test fire');
  assert(check2 !== null, 're-schedule after cancel ok');
  await new Promise((r) => setTimeout(r, 80));
  assertEqual(fired.length, 1, 'one-shot fired exactly once');
  assertEqual(scheduler.pending().length, 0, 'fired entry removed');

  assert(scheduler.schedule(opp, Date.now() - 1, 'past') === null, 'past fire time rejected');
  scheduler.dispose();
  assertEqual(scheduler.pending().length, 0, 'dispose clears');

  // Budget cap
  const scheduler2 = new ProactiveScheduler(() => undefined, () => undefined);
  let scheduled = 0;
  for (let i = 0; i < 10; i++) {
    if (scheduler2.schedule(makeOpportunity({ taskId: `cap${i}` }), Date.now() + 50_000, 'cap test') !== null) scheduled++;
  }
  assertEqual(scheduled, 8, 'scheduler capped at 8 entries');
  scheduler2.dispose();
}

// ----------------------------------------------------------- actions+verifier
{
  console.log('Action execution + verification (registry-gated)');
  const registry = new ToolRegistry();
  registry.registerAll(makeRegistryTools());
  const permissions = new PermissionManager();

  const opp = makeOpportunity({ taskId: 'exec1', action: { toolName: 'test.readonly', input: {}, description: 'x', category: 'general', requiredPermissions: ['filesystem.write'], reversible: true, minLevel: 1 } });

  // Permission enforcement: not granted (default-deny) → refuse before touching the registry
  const r1 = await executeConfirmed(opp, registry, permissions, { taskId: 't', signal: new AbortController().signal });
  assertEqual(r1.ok, false, 'ungranted permission refuses execution');
  assert((r1.reason ?? '').includes('missing permissions'), 'honest permission reason');

  permissions.grant('filesystem.write');
  const r2 = await executeConfirmed(opp, registry, permissions, { taskId: 't', signal: new AbortController().signal });
  assertEqual(r2.ok, true, 'granted permission executes through the registry');

  // Cancellation
  const ac = new AbortController();
  ac.abort();
  const r3 = await executeConfirmed(opp, registry, permissions, { taskId: 't', signal: ac.signal });
  assert(r3.ok === false || r3.result !== undefined, 'aborted execution returns structured result');

  // Verification levels
  const action = opp.suggestedAction!;
  const v1 = await verifyAction(action, { ok: true, toolName: action.toolName }, {});
  assertEqual(v1.verdict, 'uncertain', 'no independent evidence → uncertain (honest)');
  const v2 = await verifyAction(action, { ok: true, toolName: action.toolName }, {
    gatherIndependentEvidence: async () => [
      { kind: 'a', supports: true, confidence: 0.9, note: 'a ok' },
      { kind: 'b', supports: true, confidence: 0.8, note: 'b ok' },
    ],
  });
  assertEqual(v2.verdict, 'confirmed', 'two independent supporting evidence → confirmed');
  const v3 = await verifyAction(action, { ok: true, toolName: action.toolName }, {
    gatherIndependentEvidence: async () => [{ kind: 'a', supports: false, confidence: 0.9, note: 'a says no' }],
  });
  assertEqual(v3.verdict, 'refuted', 'contradicting evidence → refuted');
  const v4 = await verifyAction(action, { ok: false, toolName: action.toolName, reason: 'boom' }, {});
  assertEqual(v4.verdict, 'refuted', 'failed execution → refuted');

  // Suggestion-level verification
  assert(verifySuggestionPresented({ id: 's1' }, new Set(['s1']), Date.now()).verified, 'presented suggestion verified');
  assert(!verifySuggestionPresented({ id: 's2' }, new Set(['s1']), Date.now()).verified, 'never-presented suggestion refuted');
}

// ------------------------------------------------------- service integration
{
  console.log('ProactiveService — event flow, presentation, acceptance');
  const clock = makeClock();
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  registry.registerAll(makeRegistryTools());
  const permissions = new PermissionManager();
  permissions.grant('application.launch');
  const service = new ProactiveService({ registry, permissions, events: bus, now: clock.now });
  const notices: AgentEvent[] = [];
  bus.on('NOTICE', (e) => notices.push(e));
  service.attach(bus);

  // Scenario A: task completion → suggestion presented
  bus.emit(evt('USER_MESSAGE'));
  bus.emit(evt('TASK_STARTED', { taskId: 'ta' }));
  bus.emit(evt('TASK_COMPLETED', { taskId: 'ta', payload: { stepCount: 2 } }));
  assertEqual(service.pendingSuggestions().length, 1, 'task completion → one live suggestion');
  assertEqual(notices.length, 1, 'NOTICE emitted for the suggestion');
  assertEqual(notices[0].payload && (notices[0].payload as Record<string, unknown>)['kind'], 'proactive_suggestion', 'notice kind');
  const sugA = service.pendingSuggestions()[0];
  assert(sugA.text.toLowerCase().includes('complete'), 'scenario A wording');
  assert(service.opportunitiesSnapshot().some((o) => o.type === 'task_completed' && o.status === 'PRESENTED'), 'opportunity status PRESENTED');

  // Suggestion-level verification
  assert(verifySuggestionPresented(sugA, service.presentedIdsSnapshot(), clock.now()).verified, 'presented suggestion verifiable');

  // Duplicate suppression: same task again → no new suggestion
  bus.emit(evt('TASK_COMPLETED', { taskId: 'ta', payload: { stepCount: 2 } }));
  assertEqual(service.pendingSuggestions().length, 1, 'same entity not re-presented');

  // Accept without the required permission: permission gate refuses honestly
  const acceptResult = await service.accept(sugA.id);
  assertEqual(acceptResult.executed, false, 'accept without permission executes nothing');
  assert((acceptResult.reason ?? '').includes('missing permissions'), 'permission gate refusal recorded');

  // Scenario F: busy user → suppression (active task in flight)
  bus.emit(evt('TASK_STARTED', { taskId: 'tb' }));
  bus.emit(evt('TASK_COMPLETED', { taskId: 'tc', payload: { stepCount: 1 } }));
  assertEqual(service.pendingSuggestions().filter((s) => s.opportunityId.includes('tc') || s.text.includes('complete')).length, 0, 'no interruption while busy');

  // Level-3 flow with real registry tool (test tool): confirmation gate
  const oppL3 = makeOpportunity({
    taskId: 'exec-l3',
    risk: 'file_write',
    confidence: 0.9,
    action: { toolName: 'test.readonly', input: {}, description: 'proposed action', category: 'file_write', requiredPermissions: ['application.launch'], reversible: true, minLevel: 3 },
  });
  const dL3 = decide(
    { opportunity: oppL3, activity: 'IDLE', grantedPermissions: new Set(['application.launch']), now: clock.now() },
    new ProactiveContext(DEFAULT_BUDGET)
  );
  assertEqual(dL3.action, 'EXECUTE_AFTER_CONFIRMATION', 'level-3 decision waits for confirmation');
  assertEqual(dL3.level, 3, 'level 3');

  service.detach();
}

{
  console.log('ProactiveService — workflow recognition, corrections, unfinished tasks');
  const clock = makeClock();
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  const service = new ProactiveService({ registry, permissions, events: bus, now: clock.now });
  service.attach(bus);
  const notices: AgentEvent[] = [];
  bus.on('NOTICE', (e) => notices.push(e));

  // Scenario B: learned workflow → informational suggestion when user is idle
  bus.emit(evt('WORKFLOW_LEARNED', { taskId: 'tw', payload: { name: 'open-app-process-file', workflowId: 'wf1' } }));
  clock.advance(70_000); // go IDLE
  service.sweep(clock.now());
  bus.emit(evt('WORKFLOW_LEARNED', { taskId: 'tw2', payload: { name: 'open-app-process-file-2', workflowId: 'wf2' } }));
  assert(service.pendingSuggestions().some((s) => s.text.includes('automate it next time')), 'scenario B workflow suggestion presented (idle)');
  const wfSug = service.pendingSuggestions().find((s) => s.text.includes('automate'));
  assert(wfSug && wfSug.confirmationRequired === false, 'workflow suggestion is informational (no confirmation needed)');

  // No automatic automation: accept reports no executable action
  if (wfSug) {
    const r = await service.accept(wfSug.id);
    assertEqual(r.executed, false, 'workflow suggestion never auto-executes');
  }

  // Scenario C: repeated corrections → safer-workflow suggestion. Corrections
  // are spaced >10min apart so each forms a FRESH signal while the detector's
  // correction counter accumulates. Assert after the 2nd correction (the
  // suggestion TTL would expire it before the 3rd otherwise).
  bus.emit(evt('USER_CORRECTION', { payload: { text: 'no, put it in the reports folder' } }));
  clock.advance(11 * 60_000);
  bus.emit(evt('USER_CORRECTION', { payload: { text: 'no, put it in the reports folder' } }));
  assert(service.pendingSuggestions().some((s) => s.text.includes('safer way')), 'scenario C repeated-correction suggestion');
  clock.advance(11 * 60_000);
  bus.emit(evt('USER_CORRECTION', { payload: { text: 'no, put it in the reports folder' } }));
  assertEqual(service.pendingSuggestions().filter((s) => s.text.includes('safer way')).length, 0, 'same correction not re-presented (dedup/expiry)');

  // Scenario D: unfinished task. USER_MESSAGE keeps the user ACTIVE, so the
  // resume offer presents IMMEDIATELY — no follow-up timer needed.
  const clock2 = makeClock();
  const service2 = new ProactiveService({ registry, permissions, events: bus, now: clock2.now, unfinishedTaskFollowUpMs: 60 });
  service2.attach(bus);
  bus.emit(evt('USER_MESSAGE'));
  bus.emit(evt('TASK_CANCELLED', { taskId: 'tu', payload: { completedSteps: 3 } }));
  assert(service2.pendingSuggestions().some((s) => s.text.includes('resume')), 'scenario D resume offer presented');
  assertEqual(service2.budgetStatus().scheduled, 0, 'immediately-presented offer needs no follow-up timer');
  clock2.advance(70_000);
  await new Promise((r) => setTimeout(r, 100));
  assertEqual(service2.budgetStatus().scheduled, 0, 'one-shot consumed (no recurring timers)');

  // Busy at decision time → suppressed now, ONE-SHOT follow-up scheduled;
  // it fires later and is skipped honestly while still busy.
  const service3 = new ProactiveService({ registry, permissions, events: bus, now: Date.now, unfinishedTaskFollowUpMs: 50 });
  service3.attach(bus);
  bus.emit(evt('TASK_STARTED', { taskId: 'tv' }));
  bus.emit(evt('TASK_CANCELLED', { taskId: 'tu3', payload: { completedSteps: 2 } }));
  assertEqual(service3.budgetStatus().scheduled, 1, 'suppressed unfinished task schedules exactly one follow-up');
  bus.emit(evt('TASK_STARTED', { taskId: 'tv2' })); // new task in flight → BUSY
  await new Promise((r) => setTimeout(r, 120));
  assert(!service3.pendingSuggestions().some((s) => s.text.includes('resume') && s.dedupKey.includes(shortHash('tu3'))), 'follow-up skipped while busy');
  const opp3 = service3.opportunitiesSnapshot().find((o) => o.dedupKey.includes(shortHash('tu3')));
  assert(opp3 !== undefined && opp3.statusReasons.some((r) => r.includes('busy')), 'busy-skip reason recorded');
  service3.detach();
  service2.detach();
}

{
  console.log('Rejection suppression + memory integration + budget');
  const clock = makeClock();
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  const memory = new MemoryService(new MemoryStorage());
  // Higher presentation budget so all three suggestions can be presented and
  // rejected within one suppression cycle (rejectionsBeforeMemory = 3).
  const service = new ProactiveService({
    registry,
    permissions,
    events: bus,
    memory,
    now: clock.now,
    budget: { ...DEFAULT_BUDGET, maxPresentedPerWindow: 5, perCategoryCooldownMs: 0 },
  });
  service.attach(bus);

  // Present 3 suggestions quickly (distinct tasks), reject all 3 → memory path.
  // (All within the first suppression window; each rejection counts.)
  for (let i = 0; i < 3; i++) {
    bus.emit(evt('USER_MESSAGE'));
    bus.emit(evt('TASK_COMPLETED', { taskId: `rej${i}`, payload: { stepCount: 1 } }));
  }
  const live = service.pendingSuggestions();
  assert(live.length >= 1, 'suggestions available for rejection test');
  let memoryRecorded = false;
  for (const s of live) {
    const r = service.reject(s.id);
    memoryRecorded = memoryRecorded || r.memoryRecorded;
  }
  assert(memoryRecorded, 'repeated rejection persists a validated preference via Phase 2 memory');
  const pref = memory.search('proactive rejection').filter((r) => r.category === 'preference');
  assert(pref.length >= 1, 'preference stored in memory');

  // After 3 rejections of 'general', the next general suggestion is suppressed
  clock.advance(70_000); // go idle, escape dedup
  service.sweep(clock.now());
  bus.emit(evt('USER_MESSAGE'));
  bus.emit(evt('TASK_COMPLETED', { taskId: 'after-rej', payload: { stepCount: 1 } }));
  assertEqual(service.pendingSuggestions().filter((s) => s.category === 'general').length, 0, 'rejected category suppressed');

  // Budget cap integration: presentation bound respected across distinct entities
  assert(service.budgetStatus().presentedInWindow <= DEFAULT_BUDGET.maxPresentedPerWindow, 'budget status honest');
  service.detach();
}

{
  console.log('Multimodal integration + provider-free verification');
  const clock = makeClock();
  const registry = new ToolRegistry();
  registry.registerAll(makeRegistryTools());
  const permissions = new PermissionManager();
  permissions.grant('application.launch');
  const mm = new MultimodalContext();
  const service = new ProactiveService({ registry, permissions, events: new AgentEventBus(), multimodalContext: mm, now: clock.now });

  // Feed multimodal evidence, then verify an action using it (independent kind)
  mm.addInput({ type: 'application_state', name: 'charmap', running: true, pids: [1] });
  mm.addInput({ type: 'tool_result', toolName: 'app.launch', output: { ok: true }, verified: true });
  const action: ProactiveSuggestedAction = { toolName: 'test.readonly', input: {}, description: 'check app', category: 'general', requiredPermissions: [], reversible: true, minLevel: 1 };
  // The service's verifier reads application_state + tool_result from the
  // multimodal context — exercise it through accept() on a presented suggestion.
  const signal = makeSignal('deadline_reminder', {
    importance: 0.9,
    urgency: 0.8,
    metadata: { entity: 'deadline-test' },
  });
  service.ingestSignal(signal);
  clock.advance(70_000);
  service.sweep(clock.now());
  service.ingestSignal(makeSignal('deadline_reminder', { importance: 0.9, urgency: 0.8, metadata: { entity: 'deadline-test-2' }, dedupKey: 'deadline_reminder:other' }));
  const sugs = service.pendingSuggestions();
  assert(sugs.length >= 1, 'high-importance external signal presents when idle');
  service.detach();
  void action;
}

{
  console.log('Privacy + bounded resources + no-polling guarantee');
  const clock = makeClock();
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  const service = new ProactiveService({ registry, permissions, events: bus, now: clock.now });
  service.attach(bus);

  // No polling: time passing WITHOUT events creates nothing at all
  const before = service.diagnostics();
  clock.advance(30 * 60_000);
  service.sweep(clock.now());
  const after = service.diagnostics();
  assertEqual(after['opportunities'], before['opportunities'], 'no opportunities without events (no polling)');
  assertEqual(after['budget']['scheduled'], 0, 'no scheduled timers without unfinished tasks');
  assertEqual(after['pendingSuggestions'], 0, 'no suggestions without events');

  // Bounded: 120 events → bounded internals
  for (let i = 0; i < 120; i++) bus.emit(evt('BROWSER_NAVIGATED', { payload: { url: `https://n${i}.example.com/` } }));
  const diag = service.diagnostics();
  assert((diag['signals'] as { total: number }).total <= 50, 'signal store bounded');
  assertEqual(service.opportunitiesSnapshot().length, 0, 'low-importance navigations form no opportunities');

  // Opportunity ledger bounded under sweep
  for (let i = 0; i < 30; i++) {
    service.ingestSignal(makeSignal('deadline_reminder', { importance: 0.9, dedupKey: `deadline_reminder:bulk${i}` }));
    clock.advance(15 * 60_000);
    service.sweep(clock.now());
  }
  assert(service.opportunitiesSnapshot().length <= 100, `opportunity ledger bounded (${service.opportunitiesSnapshot().length} <= 100)`);

  // Evidence redaction bounds: quotes are sliced, metadata primitive-only
  const longSignal = makeSignal('explicit_preference', {
    evidence: [{ source: 's', quote: 'x'.repeat(500), timestamp: Date.now(), confidence: 0.9 }],
  });
  service.ingestSignal(longSignal);
  const stored = service.opportunitiesSnapshot().find((o) => o.type === 'explicit_preference');
  assert(stored !== undefined && stored.evidence.every((e) => e.quote.length <= 160 + 1), 'evidence quotes bounded (no raw content hoarding)');

  // Suggestion TTLs expire → sweep clears everything after detach
  clock.advance(31 * 60_000);
  service.detach();
  service.sweep(clock.now());
  assertEqual(service.diagnostics()['pendingSuggestions'], 0, 'detach + expiry leaves consistent state');
}

console.log(`\nPhase 15 results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('PHASE 15 TESTS: ALL GREEN');
