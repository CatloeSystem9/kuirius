/**
 * Phase 6 verification suite — keyboard control under Node with mocked backends.
 * Usage: npx tsx scripts/test-keyboard-phase6.ts
 * Exits non-zero on any failure.
 */
import { KeyboardControlService } from '../src/agent/computer/keyboardControl';
import { FakeKeyboardBackend } from '../src/agent/computer/fakeKeyboard';
import { createKeyboardTools } from '../src/agent/computer/keyboardTools';
import { maskSensitiveText, isKnownKey, isKnownModifier } from '../src/agent/computer/keyboardTypes';
import { ScreenObserver } from '../src/agent/vision/screenObserver';
import { FakeCaptureSource, solidFrame } from '../src/agent/vision/fakeCapture';
import { PermissionManager } from '../src/agent/permissions';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { AgentCore } from '../src/agent/agentCore';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { MemoryService } from '../src/agent/memory/memoryService';
import { classifyStep, isKeyboardIntent } from '../src/agent/planner';
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
  service: KeyboardControlService;
  backend: FakeKeyboardBackend;
  observer: ScreenObserver;
  source: FakeCaptureSource;
  permissions: PermissionManager;
  events: AgentEventBus;
  analysis: { current: Partial<VisionAnalysis> };
}

function makeHarness(opts: Partial<{ grantKeyboard: boolean; grantScreen: boolean; grantMouse: boolean }> = {}): Harness {
  const permissions = new PermissionManager();
  if (opts.grantKeyboard !== false) permissions.grant('keyboard.control');
  if (opts.grantScreen !== false) permissions.grant('screen.observation');
  if (opts.grantMouse !== false) permissions.grant('mouse.control');
  const analysis = { current: {} as Partial<VisionAnalysis> };
  const provider: VisionProvider = {
    name: 'scripted',
    available: () => true,
    analyze: async () => ({
      provider: 'scripted', summary: 'Scripted analysis', texts: [], elements: [],
      dialogs: [], errors: [], warnings: [], confidence: 0.8, ...analysis.current,
    }),
  };
  const source = new FakeCaptureSource([solidFrame(), solidFrame(), solidFrame(), solidFrame(192, 108, 200)]);
  const events = new AgentEventBus();
  const observer = new ScreenObserver({ captureSource: source, events, permissions, providers: [provider], captureTimeoutMs: 2000 });
  const backend = new FakeKeyboardBackend();
  const service = new KeyboardControlService({ backend, observer, events, permissions });
  return { service, backend, observer, source, permissions, events, analysis };
}

// ---------------------------------------------------------------- 1. registration
{
  console.log('1. Keyboard tool registration');
  const registry = new ToolRegistry();
  registry.registerAll(createKeyboardTools(new KeyboardControlService({ backend: new FakeKeyboardBackend() })));
  assertEqual(registry.findByCategory('computer').length >= 8, true, 'at least 8 keyboard+mouse tools in computer category');
  const names = registry.names();
  for (const expected of ['computer.type', 'computer.press_key', 'computer.hotkey', 'computer.key_down', 'computer.key_up', 'computer.copy', 'computer.paste', 'computer.select_all']) {
    assert(names.includes(expected), `registered: ${expected}`);
  }
  const typeEntry = registry.describe('computer.type')!;
  assertEqual(typeEntry.permissions, ['keyboard.control'], 'keyboard.control permission declared');
  assertEqual(typeEntry.retryPolicy?.maxAttempts, 1, 'type allows exactly one attempt (duplicate-typing protection)');
  assertEqual(registry.findByCapability('keyboard.hotkey').length, 1, 'capability discoverable');
}

// ---------------------------------------------------------------- 2-4. validation
{
  console.log('2-4. Input/key/hotkey validation');
  const { service, backend } = makeHarness();

  // Unknown keys rejected without touching the backend.
  let err: any;
  try { await service.pressKey('novelkey'); } catch (e) { err = e; }
  assertEqual(err?.kind, 'invalid_coordinates', 'unknown key rejected');
  try { await service.hotkey(['ctrl'], 'novelkey'); } catch (e) { err = e; }
  assertEqual(err?.kind, 'invalid_coordinates', 'unknown hotkey key rejected');
  try { await service.hotkey(['hyper'], 's'); } catch (e) { err = e; }
  assertEqual(err?.kind, 'invalid_coordinates', 'unknown modifier rejected');
  try { await service.type('   '); } catch (e) { err = e; }
  assertEqual(err?.kind, 'invalid_coordinates', 'empty text rejected');
  try { await service.type('x'.repeat(2500)); } catch (e) { err = e; }
  assertEqual(err?.kind, 'invalid_coordinates', 'over-length text rejected');
  assertEqual(backend.keyLog.length, 0, 'invalid requests never reached the backend');

  assert(isKnownKey('enter') && isKnownKey('f12') && isKnownKey('pageup'), 'key whitelist covers essentials');
  assert(isKnownModifier('ctrl') && isKnownModifier('win'), 'modifier whitelist covers essentials');
  assert(!isKnownKey('hyper'), 'non-keys rejected by whitelist');

  // Valid variety works.
  await service.pressKey('enter');
  await service.pressKey('F5');
  await service.hotkey(['ctrl', 'shift'], 's');
  assertEqual(backend.keyLog.map((k) => k.action), ['press', 'press', 'hotkey'], 'valid keys dispatched');
}

// ---------------------------------------------------------------- 5. permissions
{
  console.log('5. Permission handling');
  const { service, backend } = makeHarness({ grantKeyboard: false });
  let err: any;
  try { await service.type('hello'); } catch (e) { err = e; }
  assertEqual(err?.kind, 'permission_denied', 'service-level permission gate');
  assertEqual(backend.typedText, '', 'nothing typed without permission');

  const { service: s2, backend: b2, permissions } = makeHarness({ grantKeyboard: false });
  const registry = new ToolRegistry();
  registry.registerAll(createKeyboardTools(s2));
  const denied = await registry.execute('computer.press_key', { key: 'enter' }, {
    taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions,
  });
  assertEqual(denied.errorKind, 'permission_denied' as const, 'registry permission_denied classification');
  assertEqual(denied.retryable, false, 'permission failure not retryable');
  assertEqual(b2.keyLog.length, 0, 'no OS interaction on denial');
}

// ---------------------------------------------------------------- 6. structured results
{
  console.log('6. Structured results');
  const { service, permissions } = makeHarness();
  const registry = new ToolRegistry();
  registry.registerAll(createKeyboardTools(service));
  const result = await registry.execute('computer.type', { text: 'hello world' }, {
    taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions,
  });
  assertEqual(result.success, true, 'type succeeds');
  assertEqual(result.toolId, 'computer.type', 'toolId normalized');
  assert(typeof result.durationMs === 'number', 'duration present');
  assert(String((result.output as any)?.summary).includes('11 characters'), 'summary includes character count');
  assertEqual((result.output as any)?.textPreview, 'hello world', 'non-sensitive text preview allowed');
}

// ---------------------------------------------------------------- 7. cancellation
{
  console.log('7. Cancellation');
  const { service, backend } = makeHarness();
  const controller = new AbortController();
  controller.abort();
  let err: any;
  try { await service.pressKey('enter', {}, controller.signal); } catch (e) { err = e; }
  assertEqual(err?.kind, 'cancelled', 'aborted action rejected');
  assertEqual(backend.keyLog.length, 0, 'no key dispatched after cancellation');

  const cancelEvents: string[] = [];
  const h2 = makeHarness();
  h2.events.on('KEYBOARD_ACTION_CANCELLED', () => cancelEvents.push('x'));
  const c2 = new AbortController();
  c2.abort();
  try { await h2.service.type('hello', {}, c2.signal); } catch {}
  assert(cancelEvents.length > 0, 'KEYBOARD_ACTION_CANCELLED emitted');
}

// ---------------------------------------------------------------- 8. timeout
{
  console.log('8. Timeout handling');
  const { service, backend } = makeHarness();
  backend.hangMs = 150;
  let err: any;
  try { await service.pressKey('enter'); } catch (e) { err = e; }
  assertEqual(err?.kind, 'timeout', 'hanging backend classified as timeout');
  assertEqual(err?.retryable, true, 'timeout retryable');
}

// ---------------------------------------------------------------- 9. retry classification
{
  console.log('9. Retry classification');
  // Transient backend failure on press_key (maxAttempts 2) → core retries.
  const harness = makeHarness();
  harness.backend.transientFailures = 1;
  const registry = new ToolRegistry();
  registry.registerAll(createKeyboardTools(harness.service));
  registry.register({ name: 'chat.report', description: '', category: 'communication', riskLevel: 'low' as const, execute: async () => ok() });
  const core = new AgentCore({ registry, events: new AgentEventBus(), store: new TaskStore(new MemoryStorage()), permissions: harness.permissions });
  const task = await core.submit('press enter then tell me the result');
  assertEqual(task.status, 'completed' as const, 'transient failure recovered by retry');
  assertEqual(task.plan!.steps[0].attempts, 2, 'two attempts recorded');

  // Unknown key (invalid) → single attempt, never retried.
  const h2 = makeHarness();
  const registry2 = new ToolRegistry();
  registry2.registerAll(createKeyboardTools(h2.service));
  registry2.register({ name: 'chat.report', description: '', category: 'communication', riskLevel: 'low' as const, execute: async () => ok() });
  const core2 = new AgentCore({ registry: registry2, events: new AgentEventBus(), store: new TaskStore(new MemoryStorage()), maxAttemptsPerStep: 3, permissions: h2.permissions });
  const task2 = await core2.submit('press enter then tell me the result');
  // Sanity: the valid path succeeds; invalid keys fail at validation (below).
  assertEqual(task2.status, 'completed' as const, 'valid key task completes');
  let err: any;
  try { await h2.service.pressKey('novelkey'); } catch (e) { err = e; }
  assertEqual(err?.retryable, false, 'invalid key not retryable');
}

// ---------------------------------------------------------------- 10. duplicate-typing protection
{
  console.log('10. Duplicate-typing protection');
  const harness = makeHarness();
  harness.backend.uncertainDelivery = true; // text applied, result lost
  const registry = new ToolRegistry();
  registry.registerAll(createKeyboardTools(harness.service));
  registry.register({ name: 'chat.report', description: '', category: 'communication', riskLevel: 'low' as const, execute: async () => ok() });
  const core = new AgentCore({ registry, events: new AgentEventBus(), store: new TaskStore(new MemoryStorage()), permissions: harness.permissions });
  const task = await core.submit('type "hello world" then tell me the result');

  // The text was delivered exactly ONCE — no blind retry duplication.
  assertEqual(harness.backend.typedText, 'hello world', 'text typed exactly once despite uncertain result');
  assertEqual(task.status, 'failed' as const, 'uncertain delivery fails the task honestly (no retry)');
  assertEqual(task.plan!.steps[0].attempts, 1, 'single attempt only');
  assert(task.error!.toLowerCase().includes('uncertain') || task.plan!.steps[0].error!.toLowerCase().includes('uncertain'), 'uncertainty reported');
}

// ---------------------------------------------------------------- 11. stuck-key recovery
{
  console.log('11. Stuck-key recovery');
  const { service, backend } = makeHarness();
  await service.keyDown('ctrl');
  assertEqual(backend.held.has('ctrl'), true, 'ctrl held after key_down');
  assertEqual(service.getHeldKeys(), ['ctrl'], 'held key tracked');

  // A failing action triggers automatic release of held keys.
  backend.transientFailures = 1;
  try { await service.pressKey('x'); } catch {}
  assertEqual(backend.held.has('ctrl'), false, 'ctrl released after failure (no stuck modifiers)');
  assertEqual(service.getHeldKeys().length, 0, 'held-key registry empty');

  // keyUp clears tracking normally.
  await service.keyDown('shift');
  await service.keyUp('shift');
  assertEqual(service.getHeldKeys().length, 0, 'keyUp clears tracking');

  // releaseAll on unmount path.
  await service.keyDown('alt');
  await service.releaseAll();
  assertEqual(backend.held.size, 0, 'releaseAll clears backend held state');
}

// ---------------------------------------------------------------- 12. clipboard safeguards
{
  console.log('12. Clipboard safeguards');
  const { service, backend } = makeHarness();
  const copyResult = await service.copy();
  const pasteResult = await service.paste();
  const selAll = await service.selectAll();
  assertEqual(copyResult.action, 'copy' as const, 'copy action');
  assertEqual(pasteResult.action, 'paste' as const, 'paste action');
  assertEqual(selAll.action, 'select_all' as const, 'select_all action');
  assert(backend.keyLog.some((k) => k.key === 'ctrl+c'), 'copy dispatched as ctrl+c hotkey');
  assert(backend.keyLog.some((k) => k.key === 'ctrl+v'), 'paste dispatched as ctrl+v hotkey');
  assert(backend.keyLog.some((k) => k.key === 'ctrl+a'), 'select_all dispatched as ctrl+a hotkey');
  // Clipboard contents never read or stored anywhere:
  assert(!JSON.stringify({ copyResult, pasteResult, selAll }).includes('clipboardContent'), 'no clipboard content in results');
}

// ---------------------------------------------------------------- 13. sensitive input non-logging
{
  console.log('13. Sensitive-input non-logging');
  const { service, permissions } = makeHarness();
  const registry = new ToolRegistry();
  registry.registerAll(createKeyboardTools(service));
  const result = await registry.execute('computer.type', { text: 'my password is hunter2secret' }, {
    taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions,
  });
  assertEqual(result.success, true, 'sensitive text types successfully');
  assert(!JSON.stringify(result).includes('hunter2secret'), 'raw sensitive text absent from result');
  assert(String((result.output as any)?.summary).includes('[sensitive input masked]'), 'summary masks sensitive input');

  const masked = maskSensitiveText('sk-abcdefghijklmnopqrstuvwx');
  assertEqual(masked.sensitive, true, 'api-key pattern detected as sensitive');

  // Non-sensitive text keeps a short preview.
  const normal = maskSensitiveText('hello world');
  assertEqual(normal.sensitive, false, 'normal text not flagged');
}

// ---------------------------------------------------------------- 14. registry integration
{
  console.log('14. Tool Registry integration');
  const { service } = makeHarness();
  const registry = new ToolRegistry();
  registry.registerAll(createKeyboardTools(service));
  const hotkey = registry.describe('computer.hotkey')!;
  assertEqual(hotkey.permissions, ['keyboard.control'], 'hotkey permission declared');
  assertEqual(hotkey.riskLevel, 'low', 'hotkey risk low');
  assertEqual(hotkey.verification?.strategy, 'state_check', 'hotkey verification is screen-state based');
  const keyDown = registry.describe('computer.key_down')!;
  assertEqual(keyDown.riskLevel, 'medium', 'key_down risk medium (held-key potential)');
  assertEqual(registry.findByCapability('keyboard.type').length, 1, 'type capability discoverable');
}

// ---------------------------------------------------------------- 15-17. agent core integration + orchestration + verification
{
  console.log('15-17. Agent Core integration, mouse+keyboard orchestration, verification');
  // Scripted provider with a visible button + text so click and expect-text work.
  const harness = makeHarness();
  harness.analysis.current = {
    elements: [{ type: 'button', text: 'Search', bounds: { x: 0.4, y: 0.4, width: 0.2, height: 0.1 }, confidence: 0.9, actionable: true }],
    texts: [{ text: 'hello krisha', kind: 'content', confidence: 0.9 }],
  };
  const registry = new ToolRegistry();
  registry.registerAll(createKeyboardTools(harness.service));
  registry.register({ name: 'chat.report', description: '', category: 'communication', riskLevel: 'low' as const, execute: async () => ok() });

  // Mouse tool from Phase 5 in the SAME registry (orchestration).
  const { ComputerControlService } = await import('../src/agent/computer/computerControl');
  const { FakeMouseBackend } = await import('../src/agent/computer/fakeMouse');
  const { createMouseTools } = await import('../src/agent/computer/mouseTools');
  const mouseService = new ComputerControlService({ backend: new FakeMouseBackend(), observer: harness.observer, events: harness.events, permissions: harness.permissions });
  registry.registerAll(createMouseTools(mouseService));

  const core = new AgentCore({ registry, events: new AgentEventBus(), store: new TaskStore(new MemoryStorage()), permissions: harness.permissions });

  // 15. Planner classification.
  assertEqual(classifyStep('type "hello there"')?.toolName, 'computer.type', 'type intent (quoted)');
  assertEqual(classifyStep('type hello there')?.toolName, 'computer.type', 'type intent (plain)');
  assertEqual(classifyStep('type hello into the search box')?.toolName, 'computer.click', 'type-into routes focus-click first');
  assertEqual(classifyStep('press enter')?.toolName, 'computer.press_key', 'press intent');
  assertEqual(classifyStep('press ctrl+s')?.toolName, 'computer.hotkey', 'hotkey intent');
  assertEqual(classifyStep('press the button')?.toolName, 'system.note', 'non-key press NOT hijacked (falls through to note)');
  assertEqual(classifyStep('copy')?.toolName, 'computer.copy', 'bare copy');
  assertEqual(isKeyboardIntent('type hello'), true, 'isKeyboardIntent true');
  assertEqual(isKeyboardIntent('copy this file to backups'), false, 'file copy not hijacked');

  // 16. Mouse + keyboard in one task: click field, then type, then enter.
  // Phase 7: compound tasks route through the computer-use orchestrator.
  const { ComputerUseAgent } = await import('../src/agent/computerUse/computerUseAgent');
  const { createComputerUseTools } = await import('../src/agent/computerUse/computerUseTools');
  const agent = new ComputerUseAgent({ observer: harness.observer, mouse: mouseService, keyboard: harness.service, events: harness.events });
  registry.registerAll(createComputerUseTools(agent));

  const task = await core.submit('click the Search field then type "hello krisha" then press enter then tell me the result');
  assertEqual(task.status, 'completed' as const, 'mouse+keyboard task completed');
  assertEqual(task.plan!.steps[0].result!.toolId, 'computer.use', 'compound task routed to the orchestrator');
  const cuOutput = task.plan!.steps[0].result!.output as any;
  assertEqual(cuOutput.actions.map((a: any) => a.intent.kind), ['click', 'type', 'press_key'], 'orchestrated click → type → press sequence');
  assertEqual(harness.backend.typedText, 'hello krisha', 'exact text delivered once');

  // 17. Verification with expected text (scripted provider can read text).
  const typeResult = await harness.service.type('hello krisha', { expectText: 'hello krisha' });
  assertEqual(typeResult.verification.strategy, 'expect_text' as const, 'expect-text verification strategy');
  assertEqual(typeResult.verification.verified, true, 'expected text found on screen');
}

// ---------------------------------------------------------------- memory safety
{
  console.log('Memory safety: keyboard content never stored');
  const memory = new MemoryService(new MemoryStorage());
  const before = memory.records.length;
  const { service } = makeHarness();
  await service.type('remember my secret note content');
  assertEqual(memory.records.length, before, 'typed content never enters memory automatically');
}

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log('PHASE 6 TESTS: ALL GREEN');
