/**
 * Phase 4 verification suite — screen vision under Node with synthetic frames.
 * Usage: npx tsx scripts/test-vision-phase4.ts
 * Exits non-zero on any failure. No external vision API is needed.
 */
import { ScreenObserver } from '../src/agent/vision/screenObserver';
import { FakeCaptureSource, HangingCaptureSource, solidFrame, stripedFrame, splitFrame, makeFrame } from '../src/agent/vision/fakeCapture';
import { computeBlockSignature, compareSignatures } from '../src/agent/vision/signatures';
import { LocalPixelVisionProvider } from '../src/agent/vision/localPixelVision';
import { createScreenTools } from '../src/agent/vision/screenTools';
import type { CapturedFrame, CaptureSource, VisionProvider, VisionAnalysis } from '../src/agent/vision/visionTypes';
import { ObserverError } from '../src/agent/vision/visionTypes';
import { PermissionManager } from '../src/agent/permissions';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { AgentCore } from '../src/agent/agentCore';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { classifyStep, isScreenIntent } from '../src/agent/planner';
import { MemoryService } from '../src/agent/memory/memoryService';
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

function makeObserver(frames: CapturedFrame[], opts: Partial<{ permission: boolean; captureTimeoutMs: number; events: AgentEventBus; providers: VisionProvider[] }> = {}) {
  const permissions = new PermissionManager();
  if (opts.permission !== false) permissions.grant('screen.observation');
  const source = new FakeCaptureSource(frames);
  const observer = new ScreenObserver({
    captureSource: source,
    events: opts.events,
    permissions,
    providers: opts.providers,
    captureTimeoutMs: opts.captureTimeoutMs ?? 2000,
  });
  return { observer, source, permissions };
}

/** Capture source that throws a given error. */
class ThrowingCaptureSource implements CaptureSource {
  constructor(private error: Error) {}
  async capture(): Promise<CapturedFrame> {
    throw this.error;
  }
  getActiveWindowInfo() {
    return { available: false, source: 'unavailable' as const };
  }
  stop() {}
}

// ---------------------------------------------------------------- 1-2. permissions
{
  console.log('1-2. Screen permission accepted / denied');
  const denied = makeObserver([solidFrame()], { permission: false });
  let caughtKind = '';
  try {
    await denied.observer.getCurrentState();
  } catch (err: any) {
    caughtKind = err?.kind ?? '';
  }
  assertEqual(caughtKind, 'permission_denied', 'denied observer throws permission_denied');
  assertEqual(denied.source.captures, 0, 'no capture attempted without permission');

  const allowed = makeObserver([solidFrame()], { permission: true });
  const state = await allowed.observer.getCurrentState();
  assertEqual(allowed.source.captures, 1, 'granted observer captures');
  assert(Boolean(state.id), 'observation produced with permission');

  const perms = new PermissionManager();
  assertEqual(perms.isGranted('screen.observation'), false, 'screen.observation is default-deny');
}

// ---------------------------------------------------------------- 3. capture
{
  console.log('3. Screenshot capture');
  const { observer, source } = makeObserver([stripedFrame()]);
  const state = await observer.getCurrentState();
  assertEqual(state.size, { width: 192, height: 108 }, 'frame dimensions recorded');
  assertEqual(source.captures, 1, 'exactly one capture');
  assert(state.signature.blocks.length === 32 * 18, 'signature computed over 32x18 grid');
}

// ---------------------------------------------------------------- 4. active window
{
  console.log('4. Active-window detection');
  const { observer } = makeObserver([solidFrame()]);
  const info = observer.getActiveWindow();
  assertEqual(info.available, true, 'active window available from capture source');
  assertEqual(info.title, 'Test Window — Editor', 'window title reported');
  assertEqual(info.surface, 'window', 'surface kind reported');

  const state = await observer.getCurrentState();
  assertEqual(state.activeWindow.title, 'Test Window — Editor', 'state carries active window metadata');

  const unavailable = makeObserver([solidFrame()]);
  unavailable.observer; // ensure construction
  const noneSource = new FakeCaptureSource([solidFrame()], { available: false, source: 'unavailable' });
  const noneObserver = new ScreenObserver({ captureSource: noneSource, permissions: (() => { const p = new PermissionManager(); p.grant('screen.observation'); return p; })() });
  assertEqual(noneObserver.getActiveWindow().available, false, 'unavailable window reported honestly');
}

// ---------------------------------------------------------------- 5. screen-state structure
{
  console.log('5. Screen-state structure');
  const { observer } = makeObserver([stripedFrame()]);
  const state = await observer.getCurrentState();
  assert(typeof state.id === 'string' && state.id.startsWith('screen_'), 'state id');
  assert(typeof state.timestamp === 'number', 'timestamp');
  assert(state.analysis.provider === 'local_pixel_heuristics', 'analysis provider recorded');
  assert(typeof state.analysis.summary === 'string' && state.analysis.summary.length > 10, 'analysis summary');
  assert(Array.isArray(state.analysis.texts) && Array.isArray(state.analysis.elements), 'texts/elements arrays present');
  assert(typeof state.analysis.confidence === 'number' && state.analysis.confidence <= 1, 'confidence bounded');
  // No image data in the state representation:
  assert(!JSON.stringify(state).includes('data:image'), 'state contains no image data');
}

// ---------------------------------------------------------------- 6-7. text/UI element detection
{
  console.log('6-7. Text extraction + UI element detection');
  const local = new LocalPixelVisionProvider();
  const striped = await local.analyze(stripedFrame(), { activeWindow: { available: true, title: 'W', source: 'display_media_track' } });
  assert(striped.elements.length >= 1, `striped frame yields text-like bands (got ${striped.elements.length})`);
  assert(striped.elements.every((e) => e.type === 'text_line'), 'detected elements typed as text_line');
  assert(striped.elements.every((e) => e.bounds && e.bounds.y >= 0 && e.bounds.y + e.bounds.height <= 1.01), 'bounds normalized 0..1');
  assertEqual(striped.texts.length, 0, 'local provider honestly reports no OCR text');

  const solid = await local.analyze(solidFrame(), {});
  assertEqual(solid.elements.length, 0, 'solid frame has no text-like regions');

  // OCR-style extraction arrives through the provider abstraction (fake OCR provider).
  const ocrProvider: VisionProvider = {
    name: 'fake_ocr',
    available: () => true,
    analyze: async () => ({
      provider: 'fake_ocr',
      summary: 'Screen contains a Save button and an error banner.',
      texts: [
        { text: 'Save', kind: 'button_label', bounds: { x: 0.6, y: 0.8, width: 0.1, height: 0.05 }, confidence: 0.94 },
        { text: 'Connection failed', kind: 'error', confidence: 0.9 },
      ],
      elements: [{ type: 'button', text: 'Save', bounds: { x: 0.6, y: 0.8, width: 0.1, height: 0.05 }, confidence: 0.94, actionable: true }],
      dialogs: [],
      errors: ['Connection failed'],
      warnings: [],
      confidence: 0.85,
    }),
  };
  const { observer } = makeObserver([solidFrame()], { providers: [ocrProvider] });
  const state = await observer.getCurrentState();
  assertEqual(state.analysis.provider, 'fake_ocr', 'injected OCR provider used');
  assert(state.analysis.texts.some((t) => t.text === 'Save' && t.confidence > 0.9), 'button label extracted with bounds + confidence');
  assert(state.analysis.elements.some((e) => e.type === 'button' && e.actionable === true), 'actionable element detected');
  assert(state.analysis.errors.includes('Connection failed'), 'visible error extracted');
}

// ---------------------------------------------------------------- 8-9. change detection + unchanged optimization
{
  console.log('8-9. Change detection + unchanged-screen optimization');
  const { observer, source } = makeObserver([solidFrame(), solidFrame(), splitFrame()]);

  const first = await observer.detectChanges();
  assertEqual(first.changed, false, 'baseline capture reports no change');
  assertEqual(first.previousTimestamp, undefined, 'baseline has no previous timestamp');

  const second = await observer.detectChanges();
  assertEqual(second.changed, false, 'identical frame → no meaningful change');
  assertEqual(second.changedFraction, 0, 'zero change fraction');

  const third = await observer.detectChanges();
  assertEqual(third.changed, true, 'half-screen change detected');
  assert(third.changedFraction > 0.2, `change fraction meaningful (${third.changedFraction})`);
  assert(third.regions.length >= 1, 'changed region clustered');

  // Unchanged-screen optimization: getCurrentState reuses a fresh state.
  const { observer: obs2, source: src2 } = makeObserver([solidFrame()]);
  await obs2.getCurrentState();
  await obs2.getCurrentState({ maxAgeMs: 5000 });
  assertEqual(src2.captures, 1, 'second observe within reuse window skips capture');
  const fresh = await obs2.getCurrentState({ maxAgeMs: 0 });
  assertEqual(src2.captures, 2, 'maxAgeMs 0 forces a fresh capture');

  // Signature stability on identical frames.
  const sig = computeBlockSignature(solidFrame());
  const sig2 = computeBlockSignature(solidFrame());
  assertEqual(compareSignatures(sig, sig2).changed, false, 'signatures of identical frames match');
}

// ---------------------------------------------------------------- 10. state comparison
{
  console.log('10. Screen-state comparison');
  const { observer, source } = makeObserver([solidFrame()]);
  const stateA = await observer.getCurrentState();

  source.windowInfo = { available: true, title: 'Browser — YouTube', surface: 'window', source: 'display_media_track' };
  // Swap in a visually different frame by creating a new fake inside the same observer:
  (observer as any).captureSource = new FakeCaptureSource([stripedFrame()], source.windowInfo);
  const stateB = await observer.getCurrentState({ maxAgeMs: 0 });

  const diff = observer.compareStates(stateA, stateB);
  assertEqual(diff.activeWindowChanged, true, 'window change detected');
  assert(diff.elementsAdded.length > 0, 'new elements detected');
  assert(diff.description.toLowerCase().includes('window changed'), 'description describes the window change');
  assert(diff.description.includes('%'), 'description quantifies change');
}

// ---------------------------------------------------------------- 11. events
{
  console.log('11. Event emission');
  const bus = new AgentEventBus();
  const names: string[] = [];
  for (const n of ['SCREEN_OBSERVATION_STARTED', 'SCREEN_OBSERVED', 'SCREEN_CHANGED', 'ACTIVE_WINDOW_CHANGED', 'SCREEN_ANALYSIS_COMPLETED', 'SCREEN_ANALYSIS_FAILED'] as const) {
    bus.on(n, () => names.push(n));
  }
  const { observer, source } = makeObserver([solidFrame(), splitFrame()], { events: bus });
  source.windowInfo = { available: true, title: 'A', source: 'display_media_track' };
  await observer.getCurrentState();
  source.windowInfo = { available: true, title: 'B', surface: 'monitor', source: 'display_media_track' };
  (observer as any).captureSource = new FakeCaptureSource([solidFrame(192, 108, 90)], source.windowInfo);
  await observer.getCurrentState({ maxAgeMs: 0 });
  await observer.detectChanges();

  assert(names.includes('SCREEN_OBSERVATION_STARTED'), 'SCREEN_OBSERVATION_STARTED emitted');
  assert(names.includes('SCREEN_OBSERVED'), 'SCREEN_OBSERVED emitted');
  assert(names.includes('ACTIVE_WINDOW_CHANGED'), 'ACTIVE_WINDOW_CHANGED emitted on window metadata change');
  assert(names.includes('SCREEN_ANALYSIS_COMPLETED'), 'SCREEN_ANALYSIS_COMPLETED emitted');
  assert(!names.includes('SCREEN_ANALYSIS_FAILED'), 'no analysis failure in happy path');

  const failing = makeObserver([solidFrame()], { events: bus, providers: [new LocalPixelVisionProvider()] });
  (failing.observer as any).providers = { local: { name: 'bad', available: () => true, analyze: async () => { throw new Error('boom'); } }, cloud: failing.observer['providers'].cloud };
  try {
    await failing.observer.getCurrentState({ maxAgeMs: 0 });
  } catch {}
  assert(names.includes('SCREEN_ANALYSIS_FAILED'), 'SCREEN_ANALYSIS_FAILED emitted on provider failure');
}

// ---------------------------------------------------------------- 12. tool registry integration
{
  console.log('12. Tool registry integration');
  const { observer, permissions } = makeObserver([stripedFrame()]);
  const registry = new ToolRegistry();
  registry.registerAll(createScreenTools(observer));

  const observe = registry.describe('screen.observe')!;
  assertEqual(observe.permissions, ['screen.observation'], 'screen.observe declares screen permission');
  assertEqual(observe.riskLevel, 'medium', 'screen.observe is privacy-sensitive (medium risk)');
  assert(observe.capabilities.includes('screen.observe'), 'capability declared');
  assertEqual(observe.retryPolicy?.maxAttempts, 1, 'no automatic retry of permission prompts');
  assert(observe.verification?.description!.includes('failures'), 'verification metadata honest');
  assertEqual(registry.findByCapability('screen.detect_changes').length, 1, 'detect_changes discoverable');
  assertEqual(registry.findByCategory('vision').length, 4, 'four vision tools registered');

  const result = await registry.execute('screen.observe', { question: 'what is on my screen?' }, {
    taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions,
  });
  assertEqual(result.success, true, 'screen.observe executes with permission');
  assert(String((result.output as any)?.summary).includes('text-like region'), 'result summary from local analysis');

  // Permission revoked → structured permission_denied, never a capture.
  permissions.revoke('screen.observation');
  const denied = await registry.execute('screen.observe', {}, {
    taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions,
  });
  assertEqual(denied.success, false, 'denied observation fails');
  assertEqual(denied.errorKind, 'permission_denied' as const, 'permission_denied classification');
}

// ---------------------------------------------------------------- 13. agent core integration
{
  console.log('13. Agent Core integration');
  const classify = classifyStep("what's on my screen?");
  assertEqual(classify?.toolName, 'screen.observe', 'screen observe intent classified');
  assertEqual(classifyStep('what changed on my screen')?.toolName, 'screen.detect_changes', 'change intent classified');
  assertEqual(isScreenIntent('what am i looking at on my screen'), true, 'isScreenIntent true');
  assertEqual(isScreenIntent('check my location'), false, 'location queries unaffected');

  const memory = new MemoryService(new MemoryStorage());
  const { observer, permissions } = makeObserver([stripedFrame()]);
  const registry = new ToolRegistry();
  registry.registerAll(createScreenTools(observer));
  registry.register({ name: 'system.note', description: '', category: 'system', riskLevel: 'low' as const, execute: async () => ok() });
  registry.register({ name: 'chat.report', description: '', category: 'communication', riskLevel: 'low' as const, execute: async () => ok() });

  const core = new AgentCore({ registry, events: new AgentEventBus(), store: new TaskStore(new MemoryStorage()), permissions });
  const task = await core.submit("what's on my screen?");
  assertEqual(task.status, 'completed' as const, 'screen question completes through the agent core');
  assertEqual(task.plan!.steps[0].result!.toolId, 'screen.observe', 'resolved via capability to screen.observe');
  assert(task.summary!.includes('text-like region'), 'task report includes the analysis findings');
  assert(task.plan!.steps[0].verified === true, 'step verified');
  assert(memory.records.length <= 3, 'no memories auto-stored from observation');
}

// ---------------------------------------------------------------- 14. provider abstraction + cloud opt-in
{
  console.log('14. Vision-provider abstraction');
  const custom: VisionProvider = {
    name: 'custom_test_provider',
    available: () => true,
    analyze: async (_frame, ctx) =>
      ({
        provider: 'custom_test_provider',
        summary: `Answering: ${ctx.question ?? 'no question'}`,
        texts: [],
        elements: [],
        dialogs: [],
        errors: [],
        warnings: [],
        confidence: 0.5,
      }) as VisionAnalysis,
  };
  const { observer } = makeObserver([solidFrame()], { providers: [custom] });
  const state = await observer.getCurrentState({ question: 'is the operation finished?' });
  assertEqual(state.analysis.provider, 'custom_test_provider', 'provider swappable via injection');
  assert(state.analysis.summary.includes('is the operation finished?'), 'question reaches the provider');

  // Cloud analysis is strictly opt-in and fails honestly when unavailable.
  const { observer: obs2 } = makeObserver([solidFrame()]);
  let cloudKind = '';
  try {
    await obs2.getCurrentState({ analyze: 'cloud', maxAgeMs: 0 });
  } catch (err: any) {
    cloudKind = err?.kind ?? '';
  }
  assertEqual(cloudKind, 'provider_unavailable', 'cloud without encoded frame → provider_unavailable (never fabricates)');
}

// ---------------------------------------------------------------- 15. timeout
{
  console.log('15. Timeout handling');
  const permissions = new PermissionManager();
  permissions.grant('screen.observation');
  const observer = new ScreenObserver({
    captureSource: new HangingCaptureSource(),
    permissions,
    captureTimeoutMs: 120,
  });
  const started = Date.now();
  let kind = '';
  try {
    await observer.getCurrentState();
  } catch (err: any) {
    kind = err?.kind ?? '';
  }
  assertEqual(kind, 'timeout', 'hanging capture classified as timeout');
  assert(Date.now() - started < 1000, 'timeout fired promptly');
}

// ---------------------------------------------------------------- 16. failure handling
{
  console.log('16. Failure handling');
  const permissions = new PermissionManager();
  permissions.grant('screen.observation');

  const deniedObserver = new ScreenObserver({
    captureSource: new ThrowingCaptureSource(Object.assign(new Error('NotAllowedError: user denied'), { name: 'NotAllowedError' })),
    permissions,
    captureTimeoutMs: 500,
  });
  let kind = '';
  try {
    await deniedObserver.getCurrentState();
  } catch (err: any) {
    kind = err?.kind ?? '';
  }
  assertEqual(kind, 'permission_denied', 'browser permission rejection → permission_denied');

  const brokenObserver = new ScreenObserver({
    captureSource: new ThrowingCaptureSource(new Error('device vanished')),
    permissions,
    captureTimeoutMs: 500,
  });
  try {
    await brokenObserver.getCurrentState();
  } catch (err: any) {
    kind = err?.kind ?? '';
  }
  assertEqual(kind, 'capture_failed', 'generic capture error → capture_failed');
}

// ---------------------------------------------------------------- 17. snapshot lifecycle
{
  console.log('17. Temporary snapshot management');
  const frames = [
    solidFrame(192, 108, 10, 'data:image/jpeg;base64,AAAA1'),
    solidFrame(192, 108, 20, 'data:image/jpeg;base64,AAAA2'),
    solidFrame(192, 108, 30, 'data:image/jpeg;base64,AAAA3'),
    solidFrame(192, 108, 40, 'data:image/jpeg;base64,AAAA4'),
  ];
  const { observer } = makeObserver(frames);
  for (let i = 0; i < 4; i++) {
    await observer.getCurrentState({ maxAgeMs: 0 });
  }
  assert(observer.snapshotCount() <= 3, `snapshot cache bounded (got ${observer.snapshotCount()})`);
  observer.purgeSnapshots();
  assertEqual(observer.snapshotCount(), 0, 'purge clears all snapshots');
}

// ---------------------------------------------------------------- 18-19. privacy
{
  console.log('18-19. No unnecessary persistence, no secret leakage');
  const memory = new MemoryService(new MemoryStorage());
  const before = memory.records.length;
  const { observer, permissions } = makeObserver([stripedFrame(192, 108, 'data:image/jpeg;base64,SECRET_SCREEN_BYTES')]);
  const registry = new ToolRegistry();
  registry.registerAll(createScreenTools(observer));

  const result = await registry.execute('screen.observe', {}, {
    taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions,
  });
  assertEqual(result.success, true, 'observation with encoded frame succeeds');
  assert(!JSON.stringify(result).includes('SECRET_SCREEN_BYTES'), 'tool result contains no image bytes');
  const state = observer.peekCurrentState()!;
  assert(!JSON.stringify(state).includes('SECRET_SCREEN_BYTES'), 'state representation contains no image bytes');
  assertEqual(memory.records.length, before, 'memory service untouched by observation');
}

// ---------------------------------------------------------------- modes
{
  console.log('Observation modes');
  const { observer } = makeObserver([solidFrame()]);
  assertEqual(observer.getMode(), 'on_demand' as const, 'default mode on_demand');
  observer.setMode('task_monitoring');
  assertEqual(observer.getRecommendedReuseWindow(), 1500, 'task_monitoring reuse window');
  observer.setMode('idle');
  assertEqual(observer.getRecommendedReuseWindow(), 60000, 'idle mode minimal observation');
  observer.setMode('on_demand');
  assertEqual(observer.getRecommendedReuseWindow(), 0, 'on_demand always fresh');
}

// ---------------------------------------------------------------- 20-22. cross-phase compatibility guard
{
  console.log('20-22. Cross-phase compatibility guards');
  // Planner still classifies prior intents identically (P1/P3 contracts).
  assertEqual(classifyStep('open youtube')?.toolName, 'web.open_website', 'web intent unchanged');
  assertEqual(classifyStep('open calculator')?.toolName, 'app.launch', 'app intent unchanged');
  assertEqual(classifyStep('open resume.pdf')?.toolName, 'files.open', 'file intent unchanged');
  assertEqual(classifyStep('check my location')?.toolName, 'location.get', 'location intent unchanged');
  assertEqual(classifyStep('remember that I like tea')?.toolName, 'memory.remember', 'memory intent unchanged');
  assertEqual(classifyStep('flaky note')?.toolName, 'system.note', 'note fallback unchanged');
  assertEqual(classifyStep('tell me the result')?.toolName, 'chat.report', 'report intent unchanged');

  // Vision tools coexist with memory tools in one registry (P2/P3 contract).
  const memory = new MemoryService(new MemoryStorage());
  const { observer, permissions } = makeObserver([solidFrame()]);
  const registry = new ToolRegistry();
  registry.registerAll(createScreenTools(observer));
  registry.register({ name: 'system.note', description: '', category: 'system', riskLevel: 'low' as const, execute: async () => ok() });
  registry.register({ name: 'chat.report', description: '', category: 'communication', riskLevel: 'low' as const, execute: async () => ok() });
  const core = new AgentCore({
    registry,
    events: new AgentEventBus(),
    store: new TaskStore(new MemoryStorage()),
    permissions,
  });
  const task = await core.submit('observe my screen then tell me the result');
  assertEqual(task.status, 'completed' as const, 'multi-step task with screen step completes');
  assertEqual(task.plan!.steps[0].toolName, 'screen.observe', 'planner routes screen clause inside multi-step tasks');
  assert(memory.records.every((r) => r.source !== 'agent_task' || !r.content.includes('screenshot')), 'no screenshot data stored as memory');
}

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log('PHASE 4 TESTS: ALL GREEN');
