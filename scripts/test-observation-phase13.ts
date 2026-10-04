/**
 * Phase 13 verification suite â€” Adaptive Screen Observation.
 * Usage: npx tsx scripts/test-observation-phase13.ts
 * Exits non-zero on any failure.
 */
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { MemoryStorage, TaskStore } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { PermissionManager } from '../src/agent/permissions';
import { ScreenObserver } from '../src/agent/vision/screenObserver';
import { FakeCaptureSource, HangingCaptureSource, solidFrame, splitFrame, makeFrame } from '../src/agent/vision/fakeCapture';
import { cropFrame, translateAnalysis } from '../src/agent/vision/regionCrop';
import { AdaptiveObserver } from '../src/agent/observation/adaptiveObserver';
import { classifyChange, decide, suggestRegion } from '../src/agent/observation/observationDecider';
import { resolvePolicy, MODE_MAX_AGE_MS } from '../src/agent/observation/observationPolicy';
import { ObservationBudgetTracker } from '../src/agent/observation/observationBudget';
import type { ObservationDecisionInput, ObservationRegion } from '../src/agent/observation/observationTypes';
import { ComputerUseAgent } from '../src/agent/computerUse/computerUseAgent';
import { ComputerControlService } from '../src/agent/computer/computerControl';
import { FakeMouseBackend } from '../src/agent/computer/fakeMouse';
import { KeyboardControlService } from '../src/agent/computer/keyboardControl';
import { FakeKeyboardBackend } from '../src/agent/computer/fakeKeyboard';
import { BrowserAgent } from '../src/agent/browser/browserAgent';
import type { BrowserBackend } from '../src/agent/browser/browserTypes';
import type { AgentTool } from '../src/agent/types';
import { ok } from '../src/agent/types';
import type { Planner } from '../src/agent/planner';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  âœ— ${label}`);
  }
}
function assertEqual<T>(actual: T, expected: T, label: string) {
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  assert(equal, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

/** Mutable test clock for deterministic staleness/budget behavior.
 * Based on Date.now() so frame timestamps (real) stay comparable. */
function makeClock() {
  const state = { now: Date.now() };
  return {
    now: () => state.now,
    advance: (ms: number) => {
      state.now += ms;
    },
  };
}

function makeObserver(frames = [solidFrame()], clock = makeClock(), permissions?: PermissionManager) {
  const captureSource = new FakeCaptureSource(frames);
  const screenObserver = new ScreenObserver({ captureSource, permissions });
  const adaptive = new AdaptiveObserver({ screenObserver, now: clock.now });
  return { captureSource, screenObserver, adaptive, clock };
}

// ------------------------------------------------------------- policy engine
{
  console.log('Policy engine');
  const base = {
    taskActive: true,
    changeStreak: 0,
    quietStreak: 0,
    verificationStatus: 'none' as const,
    lastActionKind: 'none' as const,
    justActed: false,
  };
  assertEqual(resolvePolicy({ ...base, taskActive: false }).mode, 'idle', 'idle mode when no task');
  assertEqual(resolvePolicy(base).mode, 'active_task', 'active_task by default');
  assertEqual(resolvePolicy({ ...base, verificationStatus: 'inconclusive' }).mode, 'uncertain', 'uncertain â†’ observe sooner');
  assertEqual(resolvePolicy({ ...base, changeStreak: 3 }).mode, 'rapid_change', 'rapid change streak â†’ tighter loop');
  assertEqual(resolvePolicy({ ...base, justActed: true }).mode, 'after_action', 'just acted â†’ after_action');
  assertEqual(resolvePolicy({ ...base, quietStreak: 3 }).mode, 'settled', 'stable UI â†’ settled');
  assertEqual(MODE_MAX_AGE_MS.rapid_change < MODE_MAX_AGE_MS.active_task, true, 'rapid change window tighter than active task');
  assertEqual(MODE_MAX_AGE_MS.settled > MODE_MAX_AGE_MS.active_task, true, 'settled window looser than active task');
  // Determinism: same context â†’ same policy
  const a = resolvePolicy(base);
  const b = resolvePolicy(base);
  assertEqual(a, b, 'policy is deterministic');
}

// ---------------------------------------------------------- decision engine
{
  console.log('Decision engine â€” deterministic rules');
  const clock = makeClock();
  const policy = resolvePolicy({
    taskActive: true, changeStreak: 0, quietStreak: 0, verificationStatus: 'none', lastActionKind: 'none', justActed: false,
  });
  const mk = (over: Partial<ObservationDecisionInput>): ObservationDecisionInput => ({
    now: clock.now(),
    trigger: 'task_step',
    priority: 'NORMAL',
    policy,
    lastObservation: null,
    change: null,
    lastAction: null,
    task: { active: true },
    verification: { status: 'none' },
    recovery: { active: false },
    budget: { allowed: true, used: 0, remaining: 10, windowUsed: 0, consecutive: 0, unchangedStreak: 0, retries: 0 },
    ...over,
  });

  assertEqual(decide(mk({})).action, 'OBSERVE_NOW', 'no prior observation â†’ observe');
  assertEqual(
    decide(mk({ workflow: { reused: true, requireFresh: true }, lastObservation: { stateId: 's1', timestamp: clock.now() } })).action,
    'OBSERVE_NOW',
    'learned workflow requireFresh â†’ observe even when cache fresh'
  );
  assertEqual(
    decide(mk({ recovery: { active: true }, lastObservation: { stateId: 's1', timestamp: clock.now() } })).action,
    'OBSERVE_NOW',
    'recovery â†’ re-observe'
  );
  assertEqual(
    decide(mk({ verification: { status: 'failed' }, lastObservation: { stateId: 's1', timestamp: clock.now() } })).action,
    'OBSERVE_NOW',
    'failed verification â†’ re-observe'
  );
  assertEqual(
    decide(mk({ lastObservation: { stateId: 's1', timestamp: clock.now() - 100 } })).action,
    'REUSE_VALID_STATE',
    'fresh cache, no change info â†’ reuse'
  );
  clock.advance(MODE_MAX_AGE_MS.active_task + 1);
  assertEqual(
    decide(mk({ lastObservation: { stateId: 's1', timestamp: clock.now() - MODE_MAX_AGE_MS.active_task - 1 } })).action,
    'OBSERVE_NOW',
    'stale cache â†’ observe'
  );
  assertEqual(
    decide(mk({ changedFraction: 0.5, lastObservation: { stateId: 's1', timestamp: clock.now() } })).action,
    'OBSERVE_REGION',
    'major change with fresh cache â†’ focused region re-observation'
  );
  assertEqual(
    decide(mk({ changedFraction: 0.0, lastObservation: { stateId: 's1', timestamp: clock.now() } })).action,
    'REUSE_VALID_STATE',
    'no change â†’ reuse'
  );
  assertEqual(
    decide(mk({ changedFraction: 0.005, lastObservation: { stateId: 's1', timestamp: clock.now() } })).action,
    'DELAY_OBSERVATION',
    'minor change â†’ delay'
  );
  assertEqual(
    decide(mk({ task: { active: true, stepToolName: 'files.scan' }, lastObservation: { stateId: 's1', timestamp: clock.now() } })).action,
    'REUSE_VALID_STATE',
    'filesystem step prefers filesystem verification'
  );
  assertEqual(
    decide(mk({ trigger: 'after_mouse_action', lastObservation: { stateId: 's1', timestamp: clock.now() } })).action,
    'OBSERVE_AFTER_ACTION',
    'post-action with fresh cache â†’ observe after action'
  );
  assertEqual(
    decide(mk({ task: { active: false }, lastObservation: { stateId: 's1', timestamp: clock.now() } })).action,
    'STOP_OBSERVATION',
    'idle â†’ stop observation'
  );
  assertEqual(
    decide(mk({ budget: { allowed: false, reason: 'task_limit', used: 24, remaining: 0, windowUsed: 0, consecutive: 0, unchangedStreak: 0, retries: 0 } })).action,
    'STOP_OBSERVATION',
    'exhausted budget â†’ stop (never loops)'
  );
  // Determinism
  const input = mk({ lastObservation: { stateId: 's1', timestamp: 123 } });
  assertEqual(decide(input), decide(input), 'same input â†’ identical decision');
  // Region suggestion
  assertEqual(suggestRegion(mk({ trigger: 'browser_navigation' })), 'browser_content' as ObservationRegion, 'browser navigation â†’ browser_content region');
  assertEqual(suggestRegion(mk({ verification: { status: 'failed' } })), 'verification_region' as ObservationRegion, 'failed verification â†’ verification_region');
  // Change classification
  assertEqual(classifyChange(0), 'none', '0 fraction â†’ none');
  assertEqual(classifyChange(0.01), 'minor', 'small fraction â†’ minor');
  assertEqual(classifyChange(0.1), 'relevant', 'medium fraction â†’ relevant');
  assertEqual(classifyChange(0.9), 'major', 'large fraction â†’ major');
  assertEqual(classifyChange(undefined), 'unknown', 'missing fraction â†’ unknown');
}

// ------------------------------------------------------------- region crop
{
  console.log('Region-aware capture helpers');
  const frame = splitFrame(192, 108, 30, 200);
  const bounds = { x: 0, y: 0, width: 0.5, height: 1 };
  const cropped = cropFrame(frame, bounds);
  assertEqual(cropped.width, 96, 'crop narrows the frame');
  assertEqual(cropped.height, 108, 'crop keeps height');
  assertEqual(cropped.dataUrl, undefined, 'cropped frames carry no image copy (privacy)');
  const analysis = {
    provider: 'test', summary: 'x',
    texts: [{ text: 'hello', confidence: 0.9, bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } }],
    elements: [], dialogs: [], errors: [], warnings: [], confidence: 1,
  } as any;
  const translated = translateAnalysis(analysis, bounds);
  const tb = translated.texts[0].bounds!;
  assert(Math.abs(tb.x - 0.05) < 1e-9 && Math.abs(tb.width - 0.15) < 1e-9, 'analysis bounds translated back to full-screen space');
}

// ------------------------------------------------------ adaptive observer core
{
  console.log('AdaptiveObserver â€” active task / reuse / stale');
  const clock = makeClock();
  const { captureSource, screenObserver, adaptive } = makeObserver([solidFrame()], clock);
  adaptive.beginTask('task-1');

  const r1 = await adaptive.observe({ trigger: 'task_step', priority: 'NORMAL', taskId: 'task-1' });
  assertEqual(r1.status, 'observed', 'first observation captures');
  assertEqual(r1.decision.action, 'OBSERVE_NOW', 'first decision is OBSERVE_NOW');
  const capturesAfterFirst = captureSource.captures;

  const r2 = await adaptive.observe({ trigger: 'task_step', priority: 'NORMAL', taskId: 'task-1' });
  assertEqual(r2.status, 'reused', 'unchanged fresh screen â†’ reuse');
  assertEqual(r2.reusedFromCache, true, 'reused flag set');
  assertEqual(captureSource.captures, capturesAfterFirst, 'no new capture on reuse');

  clock.advance(MODE_MAX_AGE_MS.active_task + 250);
  const r3 = await adaptive.observe({ trigger: 'task_step', priority: 'NORMAL', taskId: 'task-1' });
  assertEqual(r3.status, 'observed', 'stale state â†’ fresh capture');
  assert(captureSource.captures > capturesAfterFirst, 'stale state triggered a real capture');
}

{
  console.log('AdaptiveObserver â€” idle behavior');
  const clock = makeClock();
  const { captureSource, adaptive } = makeObserver([solidFrame()], clock);
  const r = await adaptive.observe({ trigger: 'task_step', priority: 'NORMAL' });
  assertEqual(r.status, 'stopped', 'no active task â†’ no observation');
  assertEqual(captureSource.captures, 0, 'idle produced zero captures');

  // Idle stays quiet over time (no polling loop).
  await new Promise((res) => setTimeout(res, 120));
  assertEqual(captureSource.captures, 0, 'no background captures while idle');
}

{
  console.log('AdaptiveObserver â€” post-action observation');
  const clock = makeClock();
  const { captureSource, adaptive } = makeObserver([solidFrame()], clock);
  adaptive.beginTask('task-2');
  await adaptive.observe({ trigger: 'task_step', priority: 'NORMAL', taskId: 'task-2' });
  const captures = captureSource.captures;

  const after = await adaptive.observe({ trigger: 'after_mouse_action', priority: 'HIGH', taskId: 'task-2' });
  assertEqual(after.status, 'reused', 'fresh post-action state reused (cheap)');
  assertEqual(captureSource.captures, captures, 'no capture when state is fresh');

  clock.advance(MODE_MAX_AGE_MS.active_task + 250);
  const after2 = await adaptive.observe({ trigger: 'after_mouse_action', priority: 'HIGH', taskId: 'task-2' });
  assertEqual(after2.status, 'observed', 'stale post-action state â†’ fresh capture');
}

{
  console.log('AdaptiveObserver â€” change awareness');
  const clock = makeClock();
  const frames = [solidFrame(192, 108, 40), splitFrame(192, 108, 30, 200)];
  const { captureSource, screenObserver, adaptive } = makeObserver(frames, clock);
  adaptive.beginTask('task-3');
  await adaptive.observe({ trigger: 'task_step', priority: 'NORMAL', taskId: 'task-3' });

  // Simulate consecutive meaningful changes â†’ rapid_change policy
  adaptive.notifyChange('relevant');
  adaptive.notifyChange('relevant');
  adaptive.notifyChange('relevant');
  const diag = adaptive.getDiagnostics();
  assertEqual(diag.mode, 'rapid_change', 'change streak escalates to rapid_change mode');

  const r = await adaptive.observe({ trigger: 'screen_change', priority: 'NORMAL', taskId: 'task-3' });
  assertEqual(r.status, 'observed', 'meaningful change â†’ fresh capture');
  assert(captureSource.captures >= 2, 'capture really happened after change');
  void screenObserver;
}

{
  console.log('AdaptiveObserver â€” event-driven triggers');
  const clock = makeClock();
  const bus = new AgentEventBus();
  const { captureSource, screenObserver, adaptive } = makeObserver([solidFrame()], clock);
  adaptive.attach(bus);
  adaptive.beginTask('task-4');

  // SCREEN_CHANGED alone must NOT capture (no reflex captures / no polling).
  bus.emit({ name: 'SCREEN_CHANGED', payload: {}, timestamp: Date.now() });
  assertEqual(captureSource.captures, 0, 'SCREEN_CHANGED event alone captures nothing');

  // Mouse action completion records a trigger consumed by the next observe().
  bus.emit({ name: 'MOUSE_CLICK_COMPLETED', payload: {}, timestamp: Date.now() });
  const r = await adaptive.observe({ trigger: 'explicit_request', priority: 'NORMAL', taskId: 'task-4' });
  assertEqual(r.decision.action, 'OBSERVE_NOW', 'pending post-action trigger forces observation');
  assertEqual(r.decision.region, 'target_control', 'mouse action â†’ target_control region');
  assert(captureSource.captures >= 1, 'trigger-driven capture happened');

  // Task completion stops observation and purges visual data (privacy).
  const screenWithDataUrl = new ScreenObserver({ captureSource: new FakeCaptureSource([solidFrame(192, 108, 40, 'data:image/png;base64,AAAA')]) });
  const adaptive2 = new AdaptiveObserver({ screenObserver: screenWithDataUrl, now: clock.now });
  adaptive2.attach(bus);
  adaptive2.beginTask('task-5');
  await adaptive2.observe({ trigger: 'explicit_request', priority: 'HIGH', taskId: 'task-5', requireFresh: true });
  assert(screenWithDataUrl.snapshotCount() > 0, 'snapshot cached during task (in-memory only)');
  bus.emit({ name: 'TASK_COMPLETED', taskId: 'task-5', timestamp: Date.now() });
  assertEqual(screenWithDataUrl.snapshotCount(), 0, 'task completion purges snapshot cache');
  const stopped = await adaptive2.observe({ trigger: 'explicit_request', priority: 'CRITICAL', taskId: 'task-5', requireFresh: true });
  assertEqual(stopped.status, 'stopped', 'observation stopped after task completion');
  void screenObserver;
}

{
  console.log('AdaptiveObserver â€” budgets');
  const clock = makeClock();
  const { captureSource, screenObserver, adaptive } = makeObserver([solidFrame()], clock);
  const bounded = new AdaptiveObserver({
    screenObserver,
    now: clock.now,
    budget: { maxPerTask: 2, maxPerWindow: 100, maxConsecutive: 100, maxUnchanged: 100 },
  });
  bounded.beginTask('b-task');
  await bounded.observe({ trigger: 'explicit_request', priority: 'HIGH', taskId: 'b-task', requireFresh: true });
  await bounded.observe({ trigger: 'explicit_request', priority: 'HIGH', taskId: 'b-task', requireFresh: true });
  const exhausted = await bounded.observe({ trigger: 'explicit_request', priority: 'HIGH', taskId: 'b-task', requireFresh: true });
  assertEqual(exhausted.status, 'stopped', 'task budget exhausted â†’ structured stop');
  assert(exhausted.decision.reason.includes('budget'), 'budget reason surfaced for telemetry');
  assertEqual(captureSource.captures, 2, 'budget prevented further captures');
  assertEqual(bounded.budgetStatus().allowed, false, 'budget status reports not-allowed');

  // Window rate limiting â†’ short DELAY with retryAfterMs
  const rate = new AdaptiveObserver({
    screenObserver: new ScreenObserver({ captureSource: new FakeCaptureSource([solidFrame()]) }),
    now: clock.now,
    budget: { maxPerTask: 100, windowMs: 1200, maxPerWindow: 2, maxConsecutive: 100, maxUnchanged: 100 },
  });
  rate.beginTask('r-task');
  await rate.observe({ trigger: 'explicit_request', priority: 'HIGH', taskId: 'r-task', requireFresh: true });
  await rate.observe({ trigger: 'explicit_request', priority: 'HIGH', taskId: 'r-task', requireFresh: true });
  clock.advance(300);
  const delayed = await rate.observe({ trigger: 'explicit_request', priority: 'HIGH', taskId: 'r-task', requireFresh: true });
  assertEqual(delayed.status, 'delayed', 'window limit â†’ bounded delay (reduce frequency, no loop)');
  assert((delayed.decision.delayMs ?? 0) > 0, 'delay carries retryAfterMs');

  // Tracker unit behavior
  const tracker = new ObservationBudgetTracker({ maxUnchanged: 2 });
  tracker.resetTask('t');
  tracker.recordUnchanged('t');
  tracker.recordUnchanged('t');
  assertEqual(tracker.check('t', Date.now()).allowed, false, 'unchanged-screen cap blocks further captures');
  tracker.recordChanged('t');
  assertEqual(tracker.check('t', Date.now()).allowed, true, 'meaningful change resets unchanged cap');
}

{
  console.log('AdaptiveObserver â€” recovery + verification integration');
  const clock = makeClock();
  const { captureSource, adaptive } = makeObserver([solidFrame()], clock);
  adaptive.beginTask('task-6');
  await adaptive.observe({ trigger: 'task_step', priority: 'NORMAL', taskId: 'task-6' });
  const captures = captureSource.captures;

  adaptive.notifyRecovery(true);
  const r = await adaptive.observe({ trigger: 'task_step', priority: 'NORMAL', taskId: 'task-6' });
  assertEqual(r.status, 'observed', 'recovery forces fresh observation despite fresh cache');
  assert(captureSource.captures > captures, 'recovery captured');
  const r2 = await adaptive.observe({ trigger: 'task_step', priority: 'NORMAL', taskId: 'task-6' });
  assertEqual(r2.status, 'reused', 'successful capture clears recovery state (no forced re-observation forever)');

  adaptive.notifyVerification('failed');
  const r3 = await adaptive.observe({ trigger: 'task_step', priority: 'NORMAL', taskId: 'task-6' });
  assertEqual(r3.status, 'observed', 'failed verification â†’ re-observe');
}

{
  console.log('AdaptiveObserver â€” cancellation, timeout, permission failure');
  const clock = makeClock();

  // Cancellation
  const cancelledEnv = makeObserver([solidFrame()], clock);
  cancelledEnv.adaptive.beginTask('task-7');
  const controller = new AbortController();
  controller.abort();
  const cancelled = await cancelledEnv.adaptive.observe(
    { trigger: 'explicit_request', priority: 'HIGH', taskId: 'task-7', requireFresh: true },
    controller.signal
  );
  assertEqual(cancelled.status, 'cancelled', 'pre-aborted signal â†’ structured cancellation');

  // Timeout with bounded retries (no infinite loop)
  const hanging = new HangingCaptureSource();
  const hangingScreen = new ScreenObserver({ captureSource: hanging });
  const hangingAdaptive = new AdaptiveObserver({ screenObserver: hangingScreen, now: clock.now });
  hangingAdaptive.beginTask('task-8');
  const failed = await hangingAdaptive.observe({ trigger: 'explicit_request', priority: 'HIGH', taskId: 'task-8', requireFresh: true, timeoutMs: 40 });
  assertEqual(failed.status, 'failed', 'hanging capture â†’ structured failure');
  assertEqual(failed.error?.kind, 'timeout', 'timeout failure kind surfaced');
  assertEqual(hangingAdaptive.budgetStatus().allowed, true, 'retry budget still allows later observations');

  // Permission denied is a structured failure, not a crash
  const permissions = new PermissionManager(); // screen.observation default-deny
  const deniedEnv = makeObserver([solidFrame()], clock, permissions);
  deniedEnv.adaptive.beginTask('task-9');
  const denied = await deniedEnv.adaptive.observe({ trigger: 'explicit_request', priority: 'HIGH', taskId: 'task-9', requireFresh: true });
  assertEqual(denied.status, 'failed', 'permission denied â†’ structured failure');
  assertEqual(denied.error?.kind, 'permission_denied', 'permission failure kind surfaced');
}

{
  console.log('AdaptiveObserver â€” learned workflow integration');
  const clock = makeClock();
  const { captureSource, adaptive } = makeObserver([solidFrame()], clock);
  adaptive.beginTask('task-10');
  await adaptive.observe({ trigger: 'task_step', priority: 'NORMAL', taskId: 'task-10' });
  const captures = captureSource.captures;

  // Reused workflow requires fresh state â†’ capture even though cache is fresh.
  const r = await adaptive.observe({ trigger: 'learned_workflow_requirement', priority: 'HIGH', taskId: 'task-10', requireFresh: true });
  assertEqual(r.status, 'observed', 'workflow freshness requirement honored');
  assert(captureSource.captures > captures, 'fresh capture performed for workflow step');
}

{
  console.log('Agent Core integration â€” workflow requireFresh step');
  const clock = makeClock();
  const { captureSource, adaptive } = makeObserver([solidFrame()], clock);
  const bus = new AgentEventBus();
  adaptive.attach(bus);

  const executed: string[] = [];
  const registry = new ToolRegistry();
  const fakeTool: AgentTool = {
    name: 'screen.describe',
    description: 'test screen tool',
    category: 'test',
    riskLevel: 'low',
    execute: async () => {
      executed.push('ran');
      return ok({ output: { summary: 'done' } });
    },
  };
  registry.register(fakeTool);

  const stubPlanner: Planner = {
    makePlan: (goal) => ({
      goal,
      createdAt: Date.now(),
      revision: 1,
      steps: [
        {
          id: 's1',
          description: 'describe screen (workflow reuse)',
          toolName: 'screen.describe',
          input: {},
          verification: { type: 'tool_success' },
          observation: { requireFresh: true, region: 'full_screen' },
          status: 'pending',
          attempts: 0,
        },
      ],
    }),
    proposeAlternative: () => null,
  };

  const core = new AgentCore({
    registry,
    events: bus,
    store: new TaskStore(new MemoryStorage()),
    planner: stubPlanner,
  });
  core.setAdaptiveObserver(adaptive);

  const task = await core.submit('describe my screen now');
  assertEqual(task.status, 'completed', 'task completed with adaptive observation in the loop');
  assertEqual(executed, ['ran'], 'tool executed once');
  assert(captureSource.captures >= 1, 'adaptive observation captured before the workflow step ran');
}

{
  console.log('Computer-Use integration â€” adaptive OBSERVE step');
  const clock = makeClock();
  const frames = [solidFrame(), solidFrame(), solidFrame(), solidFrame(), solidFrame(), solidFrame()];
  const captureSource = new FakeCaptureSource(frames);
  const screenObserver = new ScreenObserver({ captureSource });
  const adaptive = new AdaptiveObserver({ screenObserver, now: clock.now });
  const bus = new AgentEventBus();
  adaptive.attach(bus);
  adaptive.beginTask('cu-task');

  const mouseBackend = new FakeMouseBackend();
  const mouse = new ComputerControlService({ backend: mouseBackend });
  const keyboard = new KeyboardControlService({ backend: new FakeKeyboardBackend() });
  const agent = new ComputerUseAgent({ observer: screenObserver, adaptive, mouse, keyboard, events: bus });

  const result = await agent.run('move the cursor to 100, 120 then move the cursor to 40, 50');
  assertEqual(result.status, 'completed', 'CU run completed through the adaptive OBSERVE step');
  assert(result.observations >= 1, 'at least one observation used');
  assert(captureSource.captures >= 1, 'adaptive layer actually captured for CU');
  const observed = bus.recentEvents().filter((e) => e.name === 'COMPUTER_OBSERVED');
  assert(observed.some((e) => (e.payload as any)?.adaptive !== undefined), 'CU observations flowed through the adaptive layer');
}

{
  console.log('Browser integration â€” observation only when useful');
  const clock = makeClock();
  const { captureSource, adaptive } = makeObserver([solidFrame()], clock);
  adaptive.beginTask('browser-task');

  const page = {
    url: 'https://example.com/',
    title: 'Example',
    ready: 'complete' as const,
    links: [], buttons: [], fields: [], headings: ['Example Domain'],
  };
  const backend: BrowserBackend = {
    async getState() {
      return { success: true, state: page, tabs: [] };
    },
    async navigate(url: string) {
      page.url = url;
      return { success: true, url };
    },
    goBack: async () => ({ success: true }),
    goForward: async () => ({ success: true }),
    refresh: async () => ({ success: true }),
    clickText: async () => ({ success: true }),
    typeIntoField: async () => ({ success: true }),
    scrollBy: async () => ({ success: true }),
    listTabs: async () => ({ success: true, tabs: [] }),
  };
  let observationRequests = 0;
  const browserAgent = new BrowserAgent({
    backend,
    adaptiveObservation: {
      observe: async (trigger) => {
        observationRequests++;
        await adaptive.observe({ trigger: trigger === 'browser_navigation' ? 'browser_navigation' : 'screen_change', priority: 'NORMAL' });
      },
    },
  });
  await browserAgent.navigate('https://example.com/');
  assertEqual(observationRequests, 1, 'exactly one observation request after navigation');
  assert(captureSource.captures >= 1, 'navigation triggered a screen observation');

  // Browser-native state sufficient â†’ NO additional observation requested by state reads.
  const before = observationRequests;
  await browserAgent.getState();
  await browserAgent.getState();
  assertEqual(observationRequests, before, 'CDP state reads do not trigger observations');
}

{
  console.log('Privacy + no-polling guarantees');
  const clock = makeClock();
  const dataUrlFrame = solidFrame(192, 108, 40, 'data:image/png;base64,AAAA');
  const { captureSource, adaptive } = makeObserver([dataUrlFrame], clock);
  adaptive.beginTask('task-privacy');
  const r = await adaptive.observe({ trigger: 'explicit_request', priority: 'HIGH', taskId: 'task-privacy', requireFresh: true });
  const serialized = JSON.stringify({ status: r.status, decision: r.decision, budget: r.budget, error: r.error });
  assert(!serialized.includes('data:image'), 'observation result metadata carries no image data');
  assert(!serialized.includes('AAAA'), 'no base64 payload in observation metadata');
  adaptive.endTask('task-privacy');
  await new Promise((res) => setTimeout(res, 120));
  const capturesAtRest = captureSource.captures;
  await new Promise((res) => setTimeout(res, 80));
  assertEqual(captureSource.captures, capturesAtRest, 'no background captures after task end (no polling loop)');
}

{
  console.log('Make-frame sanity (used by region tests)');
  const f = makeFrame(4, 2, () => [10, 20, 30]);
  assertEqual(f.data.length, 4 * 2 * 4, 'frame buffer sized correctly');
}

console.log(`\nPhase 13 results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('PHASE 13 TESTS: ALL GREEN');
