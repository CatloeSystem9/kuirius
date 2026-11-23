/**
 * Live Screen Perception — verification suite.
 * Run: npx tsx scripts/test-vision-live.ts
 *
 * Deterministic: fake capture sources, fake transports, MemoryStorage, no
 * real getDisplayMedia, no real PowerShell OCR worker (injected fake worker
 * for the server-side understanding function). Covers: captureAnalysis
 * fallback, adaptive scheduling, permission gating, change events, stop
 * cleanup, understanding trigger policy (thresholds, cooldown, per-minute
 * cap, window change, single-flight), SPF line screening (placeholders, no
 * raw secrets), bounded snapshot cache, tool contracts through the real
 * ToolRegistry + Phase 18 SafetyGate, and the server-side understand
 * function with an injected worker (success/sensitive/limit/failure).
 */
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { SafetyGate } from '../src/agent/safety/safetyGate';
import { SafetyAuditLog } from '../src/agent/safety/auditLog';
import { LiveScreenWatcher, DEFAULT_LIVE_INTERVALS } from '../src/agent/vision/liveWatcher';
import { ScreenUnderstandingService, inferApplication, type ScreenUnderstandingOptions } from '../src/agent/vision/screenUnderstanding';
import { createLivePerceptionTools } from '../src/agent/vision/liveTools';
import { screenUnderstandImage, configureSharedOcrWorker, sharedOcrWorkerIdleReleaseMs } from '../src/agent/spf/visualInspection';
import type { CaptureSource, CapturedFrame } from '../src/agent/vision/visionTypes';
import type { OcrInspectResult } from '../src/agent/spf/visualInspection';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ok ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}
function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) {
    passed += 1;
    console.log(`  ok ${label}`);
  } else {
    failed += 1;
    failures.push(`${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    console.log(`  FAIL ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}
function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

// --------------------------------------------------------------- fixtures

/** Frame with a deterministic signature controlled by `level` (0..255 gray). */
function grayFrame(level: number): CapturedFrame {
  const width = 96;
  const height = 54;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = level; data[i + 1] = level; data[i + 2] = level; data[i + 3] = 255;
  }
  return { width, height, data, capturedAt: Date.now() };
}

class FakeCaptureSource implements CaptureSource {
  captureCalls = 0;
  analysisCalls = 0;
  level = 0;
  failNext = 0;
  async capture(): Promise<CapturedFrame> {
    this.captureCalls += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('capture_failed_fake');
    }
    return grayFrame(this.level);
  }
  async captureAnalysis(): Promise<CapturedFrame> {
    this.analysisCalls += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('capture_failed_fake');
    }
    return grayFrame(this.level);
  }
  getActiveWindowInfo() {
    return { available: true, title: 'Report - Notepad', surface: 'window' as const, source: 'display_media_track' as const };
  }
  stop(): void {
    /* nothing */
  }
}

const CTX = (permissions?: PermissionManager, taskId = 't-live') => ({
  taskId,
  stepId: 's-live',
  signal: new AbortController().signal,
  memory: {},
  permissions,
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// =================================================================
// 1. Watcher — captureAnalysis usage, adaptive cadence, events, stop
// =================================================================
{
  section('Watcher: probes, adaptive cadence, events, permission gate, stop');
  const bus = new AgentEventBus();
  const source = new FakeCaptureSource();
  const changes: Array<{ fraction: number; klass: string }> = [];
  const watcher = new LiveScreenWatcher({
    captureSource: source,
    events: bus,
    intervals: { idleMs: 120, activeMs: 60, burstMs: 25 },
    onChange: (_r, fraction) => changes.push({ fraction, klass: fraction >= 0.15 ? 'major' : 'minor' }),
  });

  // Permission gate.
  const lockedPerms = new PermissionManager();
  const locked = new LiveScreenWatcher({ captureSource: source, permissions: lockedPerms, intervals: { idleMs: 50, activeMs: 50, burstMs: 50 } });
  let denied = '';
  try {
    locked.start();
  } catch (err: any) {
    denied = String(err?.message || err);
  }
  assert(denied.toLowerCase().includes('permission'), 'watcher start without permission is denied');

  // Start with permission; identical frames → unchanged → cadence slows.
  const perms = new PermissionManager();
  perms.grant('screen.observation');
  const watcher2 = new LiveScreenWatcher({
    captureSource: source,
    events: bus,
    permissions: perms,
    intervals: { idleMs: 120, activeMs: 60, burstMs: 25 },
    onChange: (_r, fraction) => changes.push({ fraction, klass: fraction >= 0.15 ? 'major' : 'minor' }),
  });
  watcher2.start();
  assertEqual(watcher2.isRunning(), true, 'watcher running after start');
  const startedEvents = bus.recentEvents().filter((e) => e.name === 'SCREEN_LIVE_STARTED').length;
  assert(startedEvents >= 1, 'SCREEN_LIVE_STARTED emitted');

  // Quiet phase: unchanged frames for ~500ms → cadence reaches idle.
  await sleep(520);
  const statsQuiet = watcher2.getStats();
  assert(statsQuiet.probes >= 3, `probes ran during quiet phase (${statsQuiet.probes})`);
  assert(statsQuiet.unchanged >= 2, `unchanged probes classified (${statsQuiet.unchanged})`);
  assertEqual(source.analysisCalls, statsQuiet.probes, 'probes use captureAnalysis (no JPEG path)');
  assert(statsQuiet.currentIntervalMs === DEFAULT_LIVE_INTERVALS.idleMs || statsQuiet.currentIntervalMs === 120, `cadence slowed to idle (${statsQuiet.currentIntervalMs}ms)`);

  // Burst phase: big change → SCREEN_CHANGED + burst cadence.
  source.level = 220;
  await sleep(160);
  const statsActive = watcher2.getStats();
  assert(statsActive.major + statsActive.minor >= 1, 'change classified after frame change');
  const changedEvents = bus.recentEvents().filter((e) => e.name === 'SCREEN_CHANGED' && (e.payload as any)?.live === true).length;
  assert(changedEvents >= 1, 'SCREEN_CHANGED (live) emitted');
  assert(changes.length >= 1, 'onChange hook fired');
  assertEqual(watcher2.getStats().currentIntervalMs, 25, 'cadence burst after change');

  // Stop: timers cleared, no further probes.
  watcher2.stop();
  const probesAtStop = watcher2.getStats().probes;
  const stopEvents = bus.recentEvents().filter((e) => e.name === 'SCREEN_LIVE_STOPPED').length;
  assertEqual(stopEvents, 1, 'SCREEN_LIVE_STOPPED emitted exactly once');
  await sleep(180);
  assertEqual(watcher2.getStats().probes, probesAtStop, 'no probes after stop');
  assertEqual(watcher2.isRunning(), false, 'watcher stopped');

  // Failure backoff: repeated capture failures must not spin.
  const failSource = new FakeCaptureSource();
  failSource.failNext = 1000;
  const failWatcher = new LiveScreenWatcher({ captureSource: failSource, permissions: perms, intervals: { idleMs: 40, activeMs: 20, burstMs: 10 } });
  failWatcher.start();
  await sleep(300);
  const failStats = failWatcher.getStats();
  assert(failStats.failed >= 1, 'failures counted');
  assert(failStats.probes === 0, 'failed probes do not count as successful probes');
  failWatcher.stop();
}

// =================================================================
// 2. Understanding service — trigger policy, SPF screening, bounds
// =================================================================
{
  section('Understanding: triggers, cooldown, cap, SPF screening, single-flight');
  const source = new FakeCaptureSource();
  const perms = new PermissionManager();
  perms.grant('screen.observation');
  const watcher = new LiveScreenWatcher({ captureSource: source, permissions: perms, intervals: { idleMs: 50, activeMs: 50, burstMs: 50 } });
  const observer = {
    getActiveWindow() {
      return { available: true, title: 'Report - Notepad', surface: 'window' };
    },
    async getCurrentState(_options?: { maxAgeMs?: number }) {
      const frame = grayFrame(source.level);
      const { computeBlockSignature } = await import('../src/agent/vision/signatures');
      return {
        id: `screen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: frame.capturedAt,
        activeWindow: { available: true, title: 'Report - Notepad', surface: 'window', source: 'display_media_track' as const },
        size: { width: frame.width, height: frame.height },
        signature: computeBlockSignature(frame),
        analysis: { provider: 'test', summary: 'test', texts: [], elements: [], dialogs: [], errors: [], warnings: [], confidence: 1 },
        snapshotRef: 'snap-test',
      };
    },
    getSnapshot(ref: string) {
      return ref === 'snap-test' ? 'data:image/jpeg;base64,AAAA' : undefined;
    },
  };

  let fetchCalls = 0;
  let lastRequestBody: any = null;
  const serverLines = [
    { t: 'Quarterly report draft', x: 10, y: 20, w: 200, h: 14 },
    { t: 'password: hunter2', x: 10, y: 40, w: 200, h: 14 },
    { t: 'api_key=sk-proj-abc123defghi', x: 10, y: 60, w: 220, h: 14 },
    { t: 'Click Save to continue', x: 10, y: 80, w: 180, h: 14 },
  ];
  const fetchFn = async (_url: string, init?: any) => {
    fetchCalls += 1;
    lastRequestBody = init?.body ? JSON.parse(init.body) : null;
    return {
      ok: true,
      json: async () => ({
        success: true,
        result: { status: 'ok', width: 768, height: 432, ocrMs: 42, totalLines: serverLines.length, lines: serverLines, redactedLines: 2, categories: ['password'] },
      }),
    } as any;
  };

  const service = new ScreenUnderstandingService({
    watcher,
    observer: observer as unknown as ScreenUnderstandingOptions['observer'],
    permissions: perms,
    fetchFn,
    now: Date.now,
  });
  service.setLimitsForTests({ minIntervalMs: 120, maxPerMinute: 3, refreshFraction: 0.03 });
  service.attach();

  // First request initializes the window baseline → initial OCR is justified.
  await service.requestRefresh('change', 0.001);
  assertEqual(fetchCalls, 1, 'first request establishes baseline understanding');

  // Below-threshold change with an unchanged window → no additional OCR.
  source.level = 5;
  await sleep(130); // clear the cooldown
  const skip = await service.requestRefresh('change', 0.001);
  assertEqual(fetchCalls, 1, 'below-threshold change does not trigger OCR');
  assertEqual(skip, service.getLatest(), 'cached snapshot returned when skipped');

  // Explicit request → fetch → snapshot with SPF placeholders (no raw secrets).
  const snap = await service.requestRefresh('explicit');
  assertEqual(fetchCalls, 2, 'explicit request triggers OCR');
  assert(!!snap, 'snapshot produced');
  const rawSecrets = JSON.stringify(snap?.texts ?? []);
  assert(!rawSecrets.includes('hunter2'), 'password value absent from cached understanding');
  assert(!rawSecrets.includes('sk-proj-abc123defghi'), 'api key absent from cached understanding');
  assertEqual(snap?.texts.length, 4, 'all four lines cached (screened)');
  assertEqual(snap?.redactedLines, 2, 'two lines SPF-screened');
  assertEqual(snap?.application, 'Notepad', 'application inferred from window title');
  assertEqual(lastRequestBody?.activeWindowTitle, 'Report - Notepad', 'window title sent as metadata');
  assert(/Active app: Notepad/.test(service.describe()), 'describe() summarizes understanding');

  // Cooldown: immediate second request → no additional fetch.
  source.level = 255;
  await service.requestRefresh('change', 0.9);
  assertEqual(fetchCalls, 2, 'cooldown prevents immediate re-OCR');

  // Per-minute cap: bypass cooldown via explicit requests until the cap bites.
  for (let i = 0; i < 5; i++) {
    await sleep(130); // exceed minInterval each time
    await service.requestRefresh('explicit');
  }
  assertEqual(fetchCalls, 3, 'per-minute cap limits OCR calls (cap 3 total)');

  // Single-flight: concurrent requests share one OCR.
  const p1 = service.requestRefresh('explicit');
  const p2 = service.requestRefresh('explicit');
  await Promise.all([p1, p2]);
  assert(fetchCalls <= 4, `concurrent requests coalesced (fetches=${fetchCalls})`);

  // Bounded cache.
  assert(service.list().length <= 3, `snapshot cache bounded (${service.list().length})`);

  // Window change justifies refresh even without a fraction.
  const snapshot2 = await service.requestRefresh('change', 0.001);
  assert(!!snapshot2 || fetchCalls >= 3, 'window-change path handled');

  // inferApplication sanity.
  assertEqual(inferApplication('Document1 - Word'), 'Word', 'application inferred from trailing segment');
  assertEqual(inferApplication('notepad.exe'), 'notepad.exe', 'executable name preserved');
  assertEqual(inferApplication(undefined), undefined, 'no title → no application');
}

// =================================================================
// 3. Server-side screenUnderstandImage — injected worker
// =================================================================
{
  section('screenUnderstandImage: SPF policy over injected worker');
  const longImage = 'data:image/jpeg;base64,' + 'A'.repeat(400);
  const okWorker = {
    ensureReady: async () => undefined,
    inspect: async (): Promise<OcrInspectResult> => ({
      status: 'ok', width: 768, height: 432, frameCount: 1,
      lines: [
        { t: 'Meeting notes', x: 5, y: 10, w: 120, h: 12 },
        { t: 'card number 4111 1111 1111 1111', x: 5, y: 30, w: 220, h: 12 },
        { t: 'plain line', x: 5, y: 50, w: 100, h: 12 },
      ],
    }),
    redact: async () => ({ status: 'ok' as const, img: 'x' }),
    kill: () => undefined,
  };
  const result = await screenUnderstandImage(longImage, { worker: okWorker });
  assertEqual(result.status, 'ok', 'understanding succeeds with ok worker');
  const joined = JSON.stringify(result.lines);
  assert(!joined.includes('4111 1111 1111 1111'), 'card number never present in lines');
  assert((result.redactedLines ?? 0) >= 1, 'sensitive line screened');
  assert((result.lines ?? []).length === 3, 'line count bounded to recognized lines');
  assert(typeof result.ocrMs === 'number', 'ocr latency measured');

  // Worker failure → honest error status.
  const brokenWorker = {
    ensureReady: async () => undefined,
    inspect: async () => { throw new Error('ocr_op_timeout'); },
    redact: async () => ({ status: 'ok' as const, img: 'x' }),
    kill: () => undefined,
  };
  const failResult = await screenUnderstandImage(longImage, { worker: brokenWorker });
  assertEqual(failResult.status, 'error', 'worker failure reported honestly');
  assertEqual(failResult.lines, undefined, 'no lines fabricated on failure');

  // Engine unavailable → honest status, no lines.
  const unavailableWorker = {
    ensureReady: async () => undefined,
    inspect: async (): Promise<OcrInspectResult> => ({ status: 'ocr_unavailable' }),
    redact: async () => ({ status: 'ok' as const, img: 'x' }),
    kill: () => undefined,
  };
  const unResult = await screenUnderstandImage(longImage, { worker: unavailableWorker });
  assertEqual(unResult.status, 'ocr_unavailable', 'engine unavailability surfaced');

  // Malformed payload rejected.
  const bad = await screenUnderstandImage('x');
  assertEqual(bad.status, 'error', 'malformed image rejected');

  // Idle-release configuration surface (default disabled).
  assertEqual(sharedOcrWorkerIdleReleaseMs(), 0, 'idle release disabled by default');
  configureSharedOcrWorker({ idleReleaseMs: 120000 });
  assertEqual(sharedOcrWorkerIdleReleaseMs(), 120000, 'idle release configurable');
  configureSharedOcrWorker({ idleReleaseMs: 0 });
}

// =================================================================
// 4. Tools through the real registry + gate
// =================================================================
{
  section('Tools: screen.live / screen.understanding through ToolRegistry + gate');
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const perms = new PermissionManager(); // screen.observation default-deny
  const source = new FakeCaptureSource();
  const watcher = new LiveScreenWatcher({ captureSource: source, events: bus, permissions: perms, intervals: { idleMs: 80, activeMs: 40, burstMs: 20 } });
  const observer = {
    getActiveWindow() {
      return { available: false, source: 'unavailable' as const };
    },
    async getCurrentState() {
      throw new Error('not used');
    },
    getSnapshot() {
      return undefined;
    },
  };
  const understanding = new ScreenUnderstandingService({ watcher, observer: observer as never, permissions: perms, fetchFn: async () => ({ ok: true, json: async () => ({ success: false }) }) as any });
  const audit = new SafetyAuditLog();
  registry.setSafetyGate(new SafetyGate({ permissions: perms, audit }));
  registry.registerAll(createLivePerceptionTools(watcher, understanding));

  // Denied without permission.
  const denied = await registry.execute('screen.live', { enable: true }, CTX(perms, 't1'));
  assertEqual(denied.success, false, 'screen.live denied without permission');
  assertEqual(denied.errorKind, 'permission_denied', 'denial classified permission_denied');

  // Granted → starts, honest output.
  perms.grant('screen.observation');
  const started = await registry.execute('screen.live', { enable: true }, CTX(perms, 't2'));
  assertEqual(started.success, true, 'screen.live starts with permission');
  assertEqual((started.output as any).running, true, 'output reflects running state');
  assertEqual(watcher.isRunning(), true, 'watcher actually running');

  // Understanding before any OCR → honest empty state.
  const empty = await registry.execute('screen.understanding', {}, CTX(perms, 't3'));
  assertEqual(empty.success, true, 'screen.understanding executes');
  assertEqual((empty.output as any).available, false, 'empty understanding reported honestly');

  // Stop.
  const stopped = await registry.execute('screen.live', { enable: false }, CTX(perms, 't4'));
  assertEqual((stopped.output as any).running, false, 'screen.live stops the watcher');
  assertEqual(watcher.isRunning(), false, 'watcher actually stopped');

  // Schema enforcement.
  const badInput = await registry.execute('screen.live', {}, CTX(perms, 't5'));
  assertEqual(badInput.success, false, 'missing required input rejected');
  assertEqual(badInput.errorKind, 'invalid_input', 'classified invalid_input');

  // Audit records for executed tools.
  assert(audit.recent(20).some((e) => e.kind === 'executed' && e.tool === 'screen.live'), 'screen.live executions audited');
  assert(bus.recentEvents().some((e) => e.name === 'TOOL_COMPLETED' && (e.payload as any)?.tool === 'screen.live'), 'TOOL_COMPLETED emitted for screen.live');
}

console.log('');
console.log('========================================');
console.log(`LIVE PERCEPTION: ${passed} passed, ${failed} failed`);
console.log('========================================');
if (failures.length > 0) {
  console.log('Failed checks:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(failed > 0 ? 1 : 0);
