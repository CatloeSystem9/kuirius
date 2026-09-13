/**
 * Phase 7 verification suite — Computer-Use Agent orchestration under Node
 * with mocked backends and synthetic screens.
 * Usage: npx tsx scripts/test-computeruse-phase7.ts
 */
import { ComputerUseAgent } from '../src/agent/computerUse/computerUseAgent';
import { buildIntents, isComputerUseRequest, isComputerActionClause } from '../src/agent/computerUse/heuristicDecider';
import { createComputerUseTools } from '../src/agent/computerUse/computerUseTools';
import { ComputerControlService } from '../src/agent/computer/computerControl';
import { FakeMouseBackend } from '../src/agent/computer/fakeMouse';
import { KeyboardControlService } from '../src/agent/computer/keyboardControl';
import { FakeKeyboardBackend } from '../src/agent/computer/fakeKeyboard';
import { ScreenObserver } from '../src/agent/vision/screenObserver';
import { FakeCaptureSource, solidFrame } from '../src/agent/vision/fakeCapture';
import { PermissionManager } from '../src/agent/permissions';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { AgentCore } from '../src/agent/agentCore';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { HeuristicPlanner, extractGoal } from '../src/agent/planner';
import type { VisionAnalysis, VisionProvider } from '../src/agent/vision/visionTypes';
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
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  assert(equal, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

interface Harness {
  agent: ComputerUseAgent;
  mouse: ComputerControlService;
  keyboard: KeyboardControlService;
  mouseBackend: FakeMouseBackend;
  keyboardBackend: FakeKeyboardBackend;
  observer: ScreenObserver;
  source: FakeCaptureSource;
  permissions: PermissionManager;
  events: AgentEventBus;
  analysis: { current: Partial<VisionAnalysis> };
  windowTitle: string;
}

function makeHarness(opts: Partial<{ grantAll: boolean }> = {}): Harness {
  const permissions = new PermissionManager();
  if (opts.grantAll !== false) {
    permissions.grant('screen.observation');
    permissions.grant('mouse.control');
    permissions.grant('keyboard.control');
  }
  const analysis = { current: {} as Partial<VisionAnalysis> };
  const provider: VisionProvider = {
    name: 'scripted',
    available: () => true,
    analyze: async () => ({
      provider: 'scripted', summary: 'Scripted analysis', texts: [], elements: [],
      dialogs: [], errors: [], warnings: [], confidence: 0.8, ...analysis.current,
    }),
  };
  const windowTitle = 'Test Window — Editor';
  const source = new FakeCaptureSource(
    [solidFrame(), solidFrame(), solidFrame(), solidFrame(), solidFrame(), solidFrame(), solidFrame(), solidFrame(), solidFrame(), solidFrame()],
    { available: true, title: windowTitle, surface: 'window', source: 'display_media_track' }
  );
  const events = new AgentEventBus();
  const observer = new ScreenObserver({ captureSource: source, events, permissions, providers: [provider], captureTimeoutMs: 2000 });
  const mouseBackend = new FakeMouseBackend();
  const keyboardBackend = new FakeKeyboardBackend();
  const mouse = new ComputerControlService({ backend: mouseBackend, observer, events, permissions });
  const keyboard = new KeyboardControlService({ backend: keyboardBackend, observer, events, permissions });
  const agent = new ComputerUseAgent({ observer, mouse, keyboard, events, stateStaleMs: 30, waitTimeoutMs: 500 });
  return { agent, mouse, keyboard, mouseBackend, keyboardBackend, observer, source, permissions, events, analysis, windowTitle };
}

function withSaveButton(h: Harness, confidence = 0.9): void {
  h.analysis.current = {
    elements: [{ type: 'button', text: 'Save', bounds: { x: 0.5, y: 0.5, width: 0.2, height: 0.1 }, confidence, actionable: true }],
    texts: [{ text: 'Save', kind: 'button_label', bounds: { x: 0.5, y: 0.5, width: 0.2, height: 0.1 }, confidence }],
  };
}

// ---------------------------------------------------------------- architecture
{
  console.log('Architecture: init, registry contract, permissions, events');
  const h = makeHarness();
  const registry = new ToolRegistry();
  registry.registerAll(createComputerUseTools(h.agent));

  const entry = registry.describe('computer.use')!;
  assertEqual(entry.permissions.sort(), ['keyboard.control', 'mouse.control', 'screen.observation'], 'all three permission domains required');
  assertEqual(entry.retryPolicy?.maxAttempts, 1, 'orchestrator runs once per step (own recovery)');
  assert(entry.timeoutMs! >= 60_000, 'generous tool timeout for multi-action runs');
  assertEqual(entry.verification?.strategy, 'state_check', 'screen-state verification strategy');
  assertEqual(registry.findByCapability('computer.autonomous').length, 1, 'capability discoverable');

  // Permission enforcement: missing one domain blocks the whole orchestrator.
  const h2 = makeHarness({ grantAll: false });
  h2.permissions.grant('screen.observation'); // mouse+keyboard still denied
  const registry2 = new ToolRegistry();
  registry2.registerAll(createComputerUseTools(h2.agent));
  const denied = await registry2.execute('computer.use', { goal: 'click the Save button then type hello' }, {
    taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions: h2.permissions,
  });
  assertEqual(denied.success, false, 'orchestrator blocked without all permissions');
  assertEqual(denied.errorKind, 'permission_denied' as const, 'permission_denied classification');
  assertEqual(h2.mouseBackend.actions.length, 0, 'no OS interaction without permissions');
}

// ---------------------------------------------------------------- planning
{
  console.log('Planning: intent building, routing');
  const goal = 'click the Save button then type "hello" then press enter';
  const intents = buildIntents(goal);
  assertEqual(intents.map((i) => i.kind), ['click', 'type', 'press_key'], 'ordered intents from goal');
  assert(isComputerActionClause('click the Save button'), 'click clause recognized');
  assert(!isComputerActionClause('open youtube'), 'web clause excluded');
  assertEqual(isComputerUseRequest('click the Save button then type "hello"'), true, 'compound desktop task detected');
  assertEqual(isComputerUseRequest('click the Save button'), false, 'single action stays a plain tool step');
  assertEqual(isComputerUseRequest('open youtube then click the Save button'), false, 'mixed web+desktop stays static');

  const planner = new HeuristicPlanner();
  const plan = planner.makePlan(extractGoal('click the Save button then type "hello" then press enter then tell me the result'));
  assertEqual(plan.steps.map((s) => s.toolName), ['computer.use', 'chat.report'], 'compound task routed to orchestrator + report');
}

// ---------------------------------------------------------------- execution + verification
{
  console.log('Execution: sequential mouse+keyboard with verification');
  const h = makeHarness();
  withSaveButton(h);
  h.source.frames = [solidFrame(192, 108, 40), solidFrame(192, 108, 200), solidFrame(192, 108, 200)];

  const result = await h.agent.run('click the Save button then type "hello krisha" then press enter');
  assertEqual(result.status, 'completed' as const, 'multi-action task completed');
  assertEqual(result.actions.map((a) => a.intent.kind), ['click', 'type', 'press_key'], 'action sequence');
  assert(result.actions[0].verified === true, 'click verified via screen change');
  assertEqual(h.keyboardBackend.typedText, 'hello krisha', 'text typed once');
  assert(h.mouseBackend.actions.some((a) => a.action === 'click'), 'mouse click executed');
  assert(h.mouseBackend.actions.some((a) => a.action === 'click' && a.detail === 'left'), 'left click detail');
  assert(result.summary.includes('Computer task completed'), 'honest completion header');
}

// ---------------------------------------------------------------- stale-screen protection
{
  console.log('Observation: freshness, staleness, bounded captures');
  const h = makeHarness(); // stateStaleMs 30ms
  withSaveButton(h);
  const before = h.source.captures;
  await h.agent.run('click the Save button then click the Save button');
  const captures = h.source.captures - before;
  // Two clicks with targeting + verification each: staleness forces fresh
  // captures (no blind reuse across actions), but bounded per action.
  assert(captures >= 4, `multiple observations across actions (${captures})`);
  assert(captures <= 14, `captures bounded, not continuous (${captures})`);
  assert(h.observer.listStates().length <= 8, 'observer state history bounded');
}

// ---------------------------------------------------------------- focus handling
{
  console.log('Execution: focus change detection');
  const h = makeHarness();
  withSaveButton(h);
  const result = await h.agent.run('click the Save button then type "hello"');
  assertEqual(result.actions.filter((a) => a.status === 'completed').length, 2, 'both actions completed');
  // No focus change in a stable environment:
  assertEqual(result.focusChanges.length, 0, 'no spurious focus changes');

  // Simulate focus loss between actions: window title changes.
  const h2 = makeHarness();
  withSaveButton(h2);
  let call = 0;
  const titles = ['Test Window — Editor', 'Test Window — Editor', 'Test Window — Editor', 'Other App — Window'];
  const origAnalyze = Object.getOwnPropertyDescriptor(h2.observer, 'getCurrentState');
  void origAnalyze;
  // Patch capture to flip the window title after the third capture.
  const origCapture = h2.source.capture.bind(h2.source);
  (h2.source as any).capture = async () => {
    const frame = await origCapture();
    call++;
    if (call >= 3) h2.source.windowInfo = { available: true, title: titles[3], surface: 'window', source: 'display_media_track' };
    return frame;
  };
  const result2 = await h2.agent.run('click the Save button then type "hello"');
  assertEqual(result2.focusChanges.length, 1, 'focus change detected and recorded');
  assertEqual(result2.focusChanges[0].from, 'Test Window — Editor', 'focus change: from');
  assertEqual(result2.focusChanges[0].to, 'Other App — Window', 'focus change: to');
  assert(result2.summary.includes('Focus changed'), 'summary reports focus change');
}

// ---------------------------------------------------------------- recovery
{
  console.log('Recovery: target disappearance, scroll alternative, retry limits, safe stop');
  // The target disappears from the screen BEFORE the vision-dependent click:
  // click fails → recovery re-observes + scrolls → still missing → honest
  // failure and a safe stop (remaining action skipped).
  const h = makeHarness();
  withSaveButton(h);
  let captureCount = 0;
  const origCapture = h.source.capture.bind(h.source);
  (h.source as any).capture = async () => {
    const frame = await origCapture();
    captureCount++;
    if (captureCount >= 2) h.analysis.current = { elements: [], texts: [] }; // target vanished
    return frame;
  };
  const events: string[] = [];
  h.events.on('COMPUTER_RECOVERY_STARTED', () => events.push('recovery'));
  const result = await h.agent.run('type "hello" then click the Save button then press enter');
  assertEqual(result.status, 'failed' as const, 'run stops honestly when the target is gone');
  assertEqual(result.actions[0].status, 'completed' as const, 'vision-independent action still completed');
  assertEqual(result.actions[1].status, 'failed' as const, 'failing click recorded');
  assertEqual(result.actions[1].intent.kind, 'click' as const, 'the failed action is the click');
  assert(result.actions[1].recoveries !== undefined && result.actions[1].recoveries! >= 1, 'recovery attempts made');
  assertEqual(result.actions[2].status, 'skipped' as const, 'remaining action safely skipped');
  assert(events.includes('recovery'), 'COMPUTER_RECOVERY_STARTED emitted');

  // Retry limits: maxRecoveriesPerAction = 0 → single attempt, immediate stop.
  const h2 = makeHarness();
  withSaveButton(h2);
  let c2 = 0;
  const origCapture2 = h2.source.capture.bind(h2.source);
  (h2.source as any).capture = async () => {
    const frame = await origCapture2();
    c2++;
    if (c2 >= 2) h2.analysis.current = { elements: [], texts: [] };
    return frame;
  };
  const agent2 = new ComputerUseAgent({
    observer: h2.observer, mouse: h2.mouse, keyboard: h2.keyboard, events: h2.events,
    stateStaleMs: 30, waitTimeoutMs: 200, maxRecoveriesPerAction: 0,
  });
  const result2 = await agent2.run('type "hello" then click the Save button then press enter');
  assertEqual(result2.actions[1].recoveries, 0, 'no recovery when limit is zero');
  assertEqual(result2.status, 'failed' as const, 'fails fast with zero recovery budget');
  assertEqual(result2.actions[2].status, 'skipped' as const, 'safe termination: rest skipped');
}

// ---------------------------------------------------------------- timeout / transient failure
{
  console.log('Execution: transient failure recovered by the loop');
  const h = makeHarness();
  withSaveButton(h);
  h.mouseBackend.transientFailures = 1; // first mouse call fails, then recovers
  const result = await h.agent.run('click the Save button');
  assertEqual(result.status, 'completed' as const, 'transient failure recovered within the action');
  assert(result.actions[0].status === 'completed', 'action completed after in-service retry');
}

// ---------------------------------------------------------------- cancellation
{
  console.log('Cancellation');
  const h = makeHarness();
  withSaveButton(h);
  const controller = new AbortController();
  controller.abort();
  const result = await h.agent.run('click the Save button then type "hello"', controller.signal);
  assertEqual(result.status, 'cancelled' as const, 'pre-aborted run reports cancelled');
  assertEqual(result.actions.filter((a) => a.status === 'skipped').length, 2, 'all actions skipped');

  // Mid-run cancellation via the tool contract signal.
  const registry = new ToolRegistry();
  registry.registerAll(createComputerUseTools(h.agent));
  const midController = new AbortController();
  h.keyboardBackend.hangMs = 400;
  setTimeout(() => midController.abort(), 60);
  const pending = registry.execute('computer.use', { goal: 'click the Save button then type "hello"' }, {
    taskId: 't', stepId: 's', signal: midController.signal, memory: {}, permissions: h.permissions,
  });
  const midResult = await pending;
  assertEqual(midResult.success, false, 'cancelled run fails honestly through the tool');
  assertEqual(midResult.errorKind, 'cancelled' as const, 'cancelled classification');
}

// ---------------------------------------------------------------- completion detection
{
  console.log('Completion detection: honest evidence');
  const h = makeHarness();
  withSaveButton(h);
  // Static screen: click executes but produces no visible change.
  const result = await h.agent.run('click the Save button');
  assertEqual(result.status, 'completed' as const, 'task completes when all actions executed');
  assertEqual(result.actions[0].verified, false, 'verification honestly reports no visible change');
  assert(result.summary.includes('no visible change detected'), 'summary admits the lack of evidence');

  // Verified path: screen changes after the click.
  const h2 = makeHarness();
  withSaveButton(h2);
  h2.source.frames = [solidFrame(192, 108, 40), solidFrame(192, 108, 200), solidFrame(192, 108, 200)];
  const result2 = await h2.agent.run('click the Save button');
  assertEqual(result2.actions[0].verified, true, 'click verified when screen changed');
  assert(result2.summary.includes('verified'), 'summary reports verification evidence');
}

// ---------------------------------------------------------------- events
{
  console.log('Event integration');
  const h = makeHarness();
  withSaveButton(h);
  const names: string[] = [];
  for (const n of ['COMPUTER_USE_STARTED', 'COMPUTER_OBSERVED', 'COMPUTER_ACTION_PLANNED', 'COMPUTER_ACTION_STARTED', 'COMPUTER_ACTION_COMPLETED', 'COMPUTER_USE_COMPLETED'] as const) {
    h.events.on(n, () => names.push(n));
  }
  await h.agent.run('click the Save button then type "hello"');
  for (const expected of ['COMPUTER_USE_STARTED', 'COMPUTER_OBSERVED', 'COMPUTER_ACTION_PLANNED', 'COMPUTER_ACTION_STARTED', 'COMPUTER_ACTION_COMPLETED', 'COMPUTER_USE_COMPLETED']) {
    assert(names.includes(expected), `event emitted: ${expected}`);
  }
}

// ---------------------------------------------------------------- agent core integration
{
  console.log('Agent Core integration (compound task through the core)');
  const h = makeHarness();
  withSaveButton(h);
  const registry = new ToolRegistry();
  registry.registerAll(createComputerUseTools(h.agent));
  registry.register({ name: 'chat.report', description: '', category: 'communication', riskLevel: 'low' as const, execute: async () => ok() });
  const core = new AgentCore({ registry, events: new AgentEventBus(), store: new TaskStore(new MemoryStorage()), permissions: h.permissions });

  const task = await core.submit('click the Save button then type "hello krisha" then press enter then tell me the result');
  assertEqual(task.status, 'completed' as const, 'compound task completes through the Agent Core');
  assertEqual(task.plan!.steps[0].result!.toolId, 'computer.use', 'orchestrator resolved via capability');
  assert(task.summary!.includes('Computer task completed'), 'core report carries orchestrator summary');
  assert(h.keyboardBackend.typedText.includes('hello krisha'), 'keyboard work actually performed');
  assert(task.memoryContext === undefined || Array.isArray(task.memoryContext), 'task state intact');
}

// ---------------------------------------------------------------- performance
{
  console.log('Performance: no unnecessary repeated captures');
  const h = makeHarness();
  withSaveButton(h);
  const before = h.source.captures;
  await h.agent.run('click the Save button then type "hello"');
  const captures = h.source.captures - before;
  // 2 actions: each needs targeting + verification + settle; bounded ceiling.
  assert(captures <= 12, `capture count bounded (${captures})`);
  assert(h.observer.snapshotCount() <= 3, 'snapshot cache bounded');
}

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log('PHASE 7 TESTS: ALL GREEN');
