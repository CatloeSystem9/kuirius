/**
 * Phase 5 verification suite — mouse/cursor control under Node with mocked
 * backends and synthetic screen frames. Usage: npx tsx scripts/test-mouse-phase5.ts
 * Exits non-zero on any failure.
 */
import { ComputerControlService } from '../src/agent/computer/computerControl';
import { FakeMouseBackend } from '../src/agent/computer/fakeMouse';
import { createMouseTools } from '../src/agent/computer/mouseTools';
import { ScreenObserver } from '../src/agent/vision/screenObserver';
import { FakeCaptureSource, solidFrame } from '../src/agent/vision/fakeCapture';
import { PermissionManager } from '../src/agent/permissions';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { AgentCore } from '../src/agent/agentCore';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { classifyStep, isMouseIntent } from '../src/agent/planner';
import type { Bounds, VisionAnalysis, VisionProvider } from '../src/agent/vision/visionTypes';
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

/** Vision provider returning a scripted analysis (element positions mutable between captures). */
function scriptedProvider(state: { current: Partial<VisionAnalysis> }): VisionProvider {
  return {
    name: 'scripted',
    available: () => true,
    analyze: async () => ({
      provider: 'scripted',
      summary: 'Scripted analysis',
      texts: [],
      elements: [],
      dialogs: [],
      errors: [],
      warnings: [],
      confidence: 0.8,
      ...state.current,
    }),
  };
}

interface Harness {
  service: ComputerControlService;
  backend: FakeMouseBackend;
  observer: ScreenObserver;
  source: FakeCaptureSource;
  permissions: PermissionManager;
  events: AgentEventBus;
  analysis: { current: Partial<VisionAnalysis> };
}

function makeHarness(opts: Partial<{ grantScreen: boolean; grantMouse: boolean; maxStaleMs: number }> = {}): Harness {
  const permissions = new PermissionManager();
  if (opts.grantScreen !== false) permissions.grant('screen.observation');
  if (opts.grantMouse !== false) permissions.grant('mouse.control');

  const analysis = { current: { elements: [] } as Partial<VisionAnalysis> };
  const provider = scriptedProvider(analysis);
  const source = new FakeCaptureSource([solidFrame(), solidFrame(), solidFrame(), solidFrame(), solidFrame(), solidFrame()]);
  const events = new AgentEventBus();
  const observer = new ScreenObserver({
    captureSource: source,
    events,
    permissions,
    providers: [provider],
    captureTimeoutMs: 2000,
  });
  const backend = new FakeMouseBackend();
  const service = new ComputerControlService({
    backend,
    observer,
    events,
    permissions,
    maxStaleMs: opts.maxStaleMs ?? 8000,
  });
  return { service, backend, observer, source, permissions, events, analysis };
}

const SAVE_BUTTON: Bounds = { x: 0.5, y: 0.5, width: 0.2, height: 0.1 };

function withSaveButton(analysis: { current: Partial<VisionAnalysis> }, bounds: Bounds = SAVE_BUTTON, confidence = 0.9): void {
  analysis.current = {
    elements: [{ type: 'button', text: 'Save', bounds, confidence, actionable: true }],
    texts: [{ text: 'Save', kind: 'button_label', bounds, confidence }],
  };
}

// ---------------------------------------------------------------- 1. cursor position
{
  console.log('1. Cursor position retrieval');
  const { service, backend } = makeHarness();
  const { position, screenBounds } = await service.getCursorPosition();
  assertEqual(position, { x: 960, y: 540 }, 'fake backend reports position');
  assertEqual(screenBounds.width, 1920, 'screen bounds reported');
  assertEqual(backend.actions.length, 0, 'reading position performs no mutating action');
}

// ---------------------------------------------------------------- 2. coordinate validation
{
  console.log('2. Coordinate validation');
  const { service, backend } = makeHarness();

  let err: any;
  try {
    await service.moveTo({ coordinates: { x: 5000, y: 0 } });
  } catch (e) {
    err = e;
  }
  assertEqual(err?.kind, 'invalid_coordinates', 'out-of-bounds point rejected');

  try {
    await service.moveTo({ coordinates: { x: NaN, y: 0 } });
  } catch (e) {
    err = e;
  }
  assertEqual(err?.kind, 'invalid_coordinates', 'NaN coordinates rejected');

  try {
    await service.moveTo({});
  } catch (e) {
    err = e;
  }
  assertEqual(err?.kind, 'invalid_coordinates', 'no-target request rejected (never click blind)');
  assertEqual(backend.actions.length, 0, 'invalid requests never reach the backend');
}

// ---------------------------------------------------------------- 3. movement
{
  console.log('3. Cursor movement');
  const { service, backend } = makeHarness();
  const result = await service.moveTo({ coordinates: { x: 100, y: 200 } });
  assertEqual(result.final, { x: 100, y: 200 }, 'cursor moved to target');
  assertEqual(result.verification.verified, true, 'movement verified by final position');
  assertEqual(backend.actions[0]?.action, 'move', 'backend move recorded');

  const drifted = makeHarness();
  drifted.backend.moveOffset = { x: 400, y: 300 }; // simulate OS reporting a different final position
  const result2 = await drifted.service.moveTo({ coordinates: { x: 100, y: 200 } });
  assertEqual(result2.verification.verified, false, 'movement not verified when final position differs');
  assert(result2.verification.note!.includes('instead of the intended'), 'honest mismatch note');
}

// ---------------------------------------------------------------- 4-8. click family / scroll / drag
{
  console.log('4-8. Click, double-click, right-click, scroll, drag');
  const { service, backend, analysis } = makeHarness();
  withSaveButton(analysis);

  const click = await service.click('left', { target: { text: 'save' } }, undefined);
  assertEqual(click.action, 'click' as const, 'click action recorded');
  assertEqual(click.target?.source, 'semantic_element', 'semantic targeting used');
  assertEqual(click.intended, { x: 1152, y: 594 }, 'click point = inset center of element bounds mapped to screen');
  assertEqual(backend.actions[0]?.detail, 'left', 'left click executed');
  assert(click.verification.strategy === 'screen_state_change', 'click verification strategy is screen-based');

  const dbl = await service.click('double', { target: { text: 'save' } });
  assertEqual(dbl.action, 'double_click' as const, 'double-click action');

  const right = await service.click('right', { target: { text: 'save' } });
  assertEqual(right.action, 'right_click' as const, 'right-click action');

  const scroll = await service.scroll({ direction: 'down', amount: 5 });
  assertEqual(scroll.action, 'scroll' as const, 'scroll action');
  assert(backend.actions.some((a) => a.action === 'scroll' && a.detail === 'delta:-600'), 'scroll delta = -600 (5 notches down)');

  const drag = await service.drag({ from: { x: 100, y: 100 }, to: { x: 400, y: 300 } });
  assertEqual(drag.action, 'drag' as const, 'drag action');
  assertEqual(drag.final, { x: 400, y: 300 }, 'drag ends at target');
  assert(backend.actions.some((a) => a.action === 'drag'), 'drag executed via backend');
}

// ---------------------------------------------------------------- 9. permission denial
{
  console.log('9. Permission denial');
  const { service, backend } = makeHarness({ grantMouse: false });
  let err: any;
  try {
    await service.moveTo({ coordinates: { x: 10, y: 10 } });
  } catch (e) {
    err = e;
  }
  assertEqual(err?.kind, 'permission_denied', 'service-level permission gate');
  assertEqual(backend.actions.length, 0, 'no OS interaction without permission');

  // Registry-level gate (the standard path).
  const { service: s2, backend: b2, permissions } = makeHarness({ grantMouse: false });
  const registry = new ToolRegistry();
  registry.registerAll(createMouseTools(s2));
  const denied = await registry.execute('computer.click', { coordinates: { x: 5, y: 5 } }, {
    taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions,
  });
  assertEqual(denied.errorKind, 'permission_denied' as const, 'registry permission_denied classification');
  assertEqual(denied.retryable, false, 'permission failures are not retryable');
  assertEqual(b2.actions.length, 0, 'backend untouched on denial');
}

// ---------------------------------------------------------------- 10. malformed coordinates
{
  console.log('10. Malformed coordinates');
  const { service } = makeHarness();
  for (const bad of [{ x: 'a', y: 1 }, { x: 1 }, null]) {
    let err: any;
    try {
      await service.click('left', { coordinates: bad as any });
    } catch (e) {
      err = e;
    }
    assert(err && err.kind === 'invalid_coordinates', `malformed input rejected: ${JSON.stringify(bad)}`);
  }
}

// ---------------------------------------------------------------- 11. target bounds/confidence validation
{
  console.log('11. Target bounds validation');
  const { service, analysis } = makeHarness();
  withSaveButton(analysis, SAVE_BUTTON, 0.3); // below the 0.6 threshold
  let err: any;
  try {
    await service.click('left', { target: { text: 'save' } });
  } catch (e) {
    err = e;
  }
  assertEqual(err?.kind, 'target_unreliable', 'low-confidence target refused');
  assertEqual(err?.retryable, false, 'low-confidence failure is not retryable');

  const h2 = makeHarness();
  h2.analysis.current = { elements: [{ type: 'button', text: 'Bad', bounds: { x: 1.2, y: 0.1, width: 0.2, height: 0.1 }, confidence: 0.9 }] };
  let err2: any;
  try {
    await h2.service.click('left', { target: { text: 'bad' } });
  } catch (e) {
    err2 = e;
  }
  assertEqual(err2?.kind, 'invalid_coordinates', 'bounds outside the capture rejected');
}

// ---------------------------------------------------------------- 12. stale observation handling
{
  console.log('12. Stale observation handling');
  const { service, source, analysis } = makeHarness({ maxStaleMs: 30 });
  // First observation: Save at position A.
  withSaveButton(analysis, { x: 0.1, y: 0.1, width: 0.2, height: 0.1 });
  await service.getCursorPosition(); // warm bounds cache
  const { observer } = { observer: (service as any).observer as ScreenObserver };
  await observer.getCurrentState({ maxAgeMs: 0 });

  // Screen changes: Save moves to position B.
  withSaveButton(analysis, { x: 0.7, y: 0.7, width: 0.2, height: 0.1 });
  await new Promise((r) => setTimeout(r, 60)); // state goes stale

  const capturesBefore = source.captures;
  const result = await service.click('left', { target: { text: 'save' } });
  assert(source.captures > capturesBefore, 'stale state triggered a fresh capture');
  assertEqual(result.target?.reidentified, true, 'target re-identified on fresh observation');
  assertEqual(result.intended, { x: Math.round(0.8 * 1920), y: Math.round(0.75 * 1080) }, 'clicked the NEW position, not the stale one');
}

// ---------------------------------------------------------------- 13. active-window context
{
  console.log('13. Active-window context');
  const { service, analysis } = makeHarness();
  withSaveButton(analysis);
  const result = await service.click('left', { target: { text: 'save' } });
  assert(result.activeWindow !== undefined, 'result carries active-window context');
  assertEqual(result.activeWindow?.title, 'Test Window — Editor', 'active window title from Phase 4 metadata');
}

// ---------------------------------------------------------------- 14. structured results
{
  console.log('14. Structured tool results');
  const { service, analysis, permissions } = makeHarness();
  withSaveButton(analysis);
  const registry = new ToolRegistry();
  registry.registerAll(createMouseTools(service));
  const result = await registry.execute('computer.click', { target: { text: 'save' } }, {
    taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions,
  });
  assertEqual(result.success, true, 'click succeeds');
  assertEqual(result.toolId, 'computer.click', 'toolId normalized');
  assert(typeof result.timestamp === 'number' && typeof result.durationMs === 'number', 'timestamp + duration present');
  assert(typeof (result.output as any)?.summary === 'string', 'human-readable summary present');
  assert((result.output as any)?.verification !== undefined, 'verification evidence embedded');
}

// ---------------------------------------------------------------- 15. events
{
  console.log('15. Event emission');
  const { service, analysis, events, source } = makeHarness();
  withSaveButton(analysis);
  // The click verification capture must see a changed screen for MOUSE_ACTION_VERIFIED.
  source.frames = [solidFrame(192, 108, 40), solidFrame(192, 108, 200)];
  const names: string[] = [];
  for (const n of ['CURSOR_MOVE_STARTED', 'CURSOR_MOVE_COMPLETED', 'MOUSE_CLICK_STARTED', 'MOUSE_CLICK_COMPLETED', 'MOUSE_ACTION_VERIFIED', 'MOUSE_ACTION_FAILED', 'MOUSE_ACTION_CANCELLED'] as const) {
    events.on(n, () => names.push(n));
  }
  await service.moveTo({ coordinates: { x: 100, y: 100 } });
  await service.click('left', { target: { text: 'save' } });
  assert(names.includes('CURSOR_MOVE_STARTED') && names.includes('CURSOR_MOVE_COMPLETED'), 'move events emitted');
  assert(names.includes('MOUSE_CLICK_STARTED') && names.includes('MOUSE_CLICK_COMPLETED'), 'click events emitted');
  assert(names.includes('MOUSE_ACTION_VERIFIED'), 'verified event emitted');

  const cancelEvents: string[] = [];
  events.on('MOUSE_ACTION_CANCELLED', () => cancelEvents.push('cancelled'));
  const controller = new AbortController();
  controller.abort();
  try {
    await service.click('left', { target: { text: 'save' } }, controller.signal);
  } catch {}
  assert(cancelEvents.length > 0, 'cancellation event emitted');
}

// ---------------------------------------------------------------- 16. cancellation
{
  console.log('16. Cancellation');
  const { service, backend, analysis } = makeHarness();
  withSaveButton(analysis);
  const controller = new AbortController();
  controller.abort();
  let err: any;
  try {
    await service.click('left', { target: { text: 'save' } }, controller.signal);
  } catch (e) {
    err = e;
  }
  assertEqual(err?.kind, 'cancelled', 'aborted action rejected before execution');
  assertEqual(backend.actions.length, 0, 'no mouse action after cancellation');
}

// ---------------------------------------------------------------- 17. timeout
{
  console.log('17. Timeout handling');
  const { service, analysis } = makeHarness();
  withSaveButton(analysis);
  (service as any).backend.hangMs = 150;
  let err: any;
  try {
    await service.click('left', { target: { text: 'save' } });
  } catch (e) {
    err = e;
  }
  assertEqual(err?.kind, 'timeout', 'hanging backend classified as timeout');
  assertEqual(err?.retryable, true, 'timeout is retryable');
}

// ---------------------------------------------------------------- 18-19. retryability
{
  console.log('18-19. Retryable and non-retryable failures');
  // Retryable: transient backend failure → core retries (move has maxAttempts 2).
  const harness = makeHarness();
  withSaveButton(harness.analysis);
  harness.backend.transientFailures = 1;
  const registry = new ToolRegistry();
  registry.registerAll(createMouseTools(harness.service));
  registry.register({ name: 'chat.report', description: '', category: 'communication', riskLevel: 'low' as const, execute: async () => ok() });
  const core = new AgentCore({ registry, events: new AgentEventBus(), store: new TaskStore(new MemoryStorage()), permissions: harness.permissions });
  const task = await core.submit('move the cursor to 100, 200 then tell me the result');
  assertEqual(task.status, 'completed' as const, 'transient failure recovered by retry');
  assertEqual(task.plan!.steps[0].attempts, 2, 'two attempts recorded');

  // Non-retryable: low-confidence target → single attempt, honest failure.
  const h2 = makeHarness();
  withSaveButton(h2.analysis, SAVE_BUTTON, 0.3);
  const registry2 = new ToolRegistry();
  registry2.registerAll(createMouseTools(h2.service));
  registry2.register({ name: 'chat.report', description: '', category: 'communication', riskLevel: 'low' as const, execute: async () => ok() });
  const core2 = new AgentCore({ registry: registry2, events: new AgentEventBus(), store: new TaskStore(new MemoryStorage()), maxAttemptsPerStep: 3 });
  const task2 = await core2.submit('click on the save button then tell me the result');
  assertEqual(task2.status, 'failed' as const, 'low-confidence click fails the task honestly');
  assertEqual(task2.plan!.steps[0].attempts, 1, 'non-retryable failure not retried despite core maxAttempts=3');
}

// ---------------------------------------------------------------- 20. screen-based verification
{
  console.log('20. Screen-based verification');
  // Changed screen → verified.
  const changed = makeHarness();
  withSaveButton(changed.analysis);
  changed.source.frames = [solidFrame(192, 108, 40), solidFrame(192, 108, 200)];
  const r1 = await changed.service.click('left', { target: { text: 'save' } });
  assertEqual(r1.verification.verified, true, 'click verified when the screen changed');
  assert(r1.verification.changedFraction !== undefined, 'change fraction reported');

  // Static screen → honestly unverified.
  const staticH = makeHarness();
  withSaveButton(staticH.analysis);
  const r2 = await staticH.service.click('left', { target: { text: 'save' } });
  assertEqual(r2.verification.verified, false, 'click with no visible change reports verified:false');
  assert(r2.verification.note!.includes('no visible effect'), 'honest note about no visible effect');
  assertEqual(r2.action, 'click' as const, 'action still succeeded (executed) with honest evidence');
}

// ---------------------------------------------------------------- 21. agent core integration
{
  console.log('21. Agent Core integration');
  const { service, analysis, permissions, source } = makeHarness();
  withSaveButton(analysis);
  source.frames = [solidFrame(192, 108, 40), solidFrame(192, 108, 40), solidFrame(192, 108, 200)];
  const registry = new ToolRegistry();
  registry.registerAll(createMouseTools(service));
  registry.register({ name: 'chat.report', description: '', category: 'communication', riskLevel: 'low' as const, execute: async () => ok() });

  // Phase 7: compound desktop tasks route through the computer-use orchestrator.
  permissions.grant('keyboard.control');
  const { KeyboardControlService } = await import('../src/agent/computer/keyboardControl');
  const { FakeKeyboardBackend } = await import('../src/agent/computer/fakeKeyboard');
  const { ComputerUseAgent } = await import('../src/agent/computerUse/computerUseAgent');
  const { createComputerUseTools } = await import('../src/agent/computerUse/computerUseTools');
  const keyboardService = new KeyboardControlService({ backend: new FakeKeyboardBackend(), observer: (service as any).observer, events: (service as any).events, permissions });
  const agent = new ComputerUseAgent({ mouse: service, keyboard: keyboardService, observer: (service as any).observer, events: (service as any).events });
  registry.registerAll(createComputerUseTools(agent));

  const core = new AgentCore({ registry, events: new AgentEventBus(), store: new TaskStore(new MemoryStorage()), permissions });
  const task = await core.submit('click the Save button then type "hello krisha" then tell me the result');
  assertEqual(task.status, 'completed' as const, 'compound desktop task completed through computer.use');
  assertEqual(task.plan!.steps[0].result!.toolId, 'computer.use', 'compound task routed to the orchestrator');
  const output = task.plan!.steps[0].result!.output as any;
  assert(output.actions.length === 2 && output.actions.every((a: any) => a.status === 'completed'), 'orchestrator executed click + type');
  assert(task.summary!.includes('Computer task completed'), 'honest completion summary');

  // Planner classification coverage.
  assertEqual(classifyStep('click on the save button')?.toolName, 'computer.click', 'click intent');
  assertEqual(classifyStep('double click the icon')?.toolName, 'computer.double_click', 'double-click intent');
  assertEqual(classifyStep('right click the file')?.toolName, 'computer.right_click', 'right-click intent');
  assertEqual(classifyStep('scroll down 5')?.toolName, 'computer.scroll', 'scroll intent');
  assertEqual(classifyStep('drag the widget to the panel')?.toolName, 'computer.drag', 'drag intent');
  assertEqual(classifyStep('move the cursor to 100, 200')?.toolName, 'computer.move_cursor', 'move intent (coordinates)');
  assertEqual(isMouseIntent('click on save'), true, 'isMouseIntent true');
  assertEqual(isMouseIntent('open youtube'), false, 'open commands not hijacked');
}

// ---------------------------------------------------------------- 22. tool registry integration
{
  console.log('22. Tool Registry integration');
  const { service } = makeHarness();
  const registry = new ToolRegistry();
  registry.registerAll(createMouseTools(service));

  assertEqual(registry.findByCategory('computer').length, 7, 'seven mouse tools registered');
  const click = registry.describe('computer.click')!;
  assertEqual(click.permissions, ['mouse.control'], 'mouse.control permission declared');
  assertEqual(click.riskLevel, 'low', 'click risk low');
  assertEqual(click.retryPolicy?.maxAttempts, 1, 'click never blindly retried');
  assertEqual(click.verification?.strategy, 'state_check', 'click verification is screen-state based');
  const drag = registry.describe('computer.drag')!;
  assertEqual(drag.riskLevel, 'medium', 'drag risk medium');
  assertEqual(registry.findByCapability('computer.right_click').length, 1, 'capability discoverable');
  assertEqual(registry.describe('computer.get_cursor')!.riskLevel, 'safe', 'get_cursor risk safe');
}

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log('PHASE 5 TESTS: ALL GREEN');
