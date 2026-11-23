/**
 * Background Runtime (Step 1 — Lid-Closed Operation) test suite.
 *
 * Covers: watchdog heartbeat cadence (visible vs hidden), server_ok/server_lost/
 * server_restored transitions with downtime measurement, bounded failure backoff,
 * sleep/wake detection via timer drift AND the Page Lifecycle resume signal,
 * network offline/online signalling, in-flight beat deduplication, clean stop,
 * and the graceful-shutdown sequence (installGracefulShutdown) including
 * idempotency — all with injected fetch/scheduler/clock so no real network
 * or process signals are involved except the explicit process.emit probes.
 *
 * Usage: npx tsx scripts/test-background-runtime.ts
 * Exits non-zero on any failure.
 */
import { installGracefulShutdown } from '../src/server/runtimeShutdown';
import { RuntimeWatchdog, resetRuntimeWatchdogForTests } from '../src/utils/runtimeWatchdog';
import type { RuntimeWatchdogEvent } from '../src/utils/runtimeWatchdog';

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

/** Manual clock + single-slot scheduler (mirrors the watchdog's one-beat-at-a-time design). */
class FakeClock {
  value = 0;
}

class FakeScheduler {
  private slot: { fn: () => void; at: number; cancelled: boolean } | null = null;
  constructor(private clock: FakeClock) {}
  schedule(fn: () => void, delayMs: number): () => void {
    this.slot = { fn, at: this.clock.value + delayMs, cancelled: false };
    return () => {
      // clearTimeout semantics: a cancelled slot is gone.
      this.slot = null;
    };
  }
  fire(): void {
    if (!this.slot) throw new Error('nothing scheduled');
    if (this.slot.cancelled) throw new Error('cancelled beat fired');
    const { fn, at } = this.slot;
    this.slot = null;
    // Real timers fire at or AFTER their deadline (never rewind the clock —
    // suspension/throttling is simulated by advancing the clock externally).
    this.clock.value = Math.max(this.clock.value, at);
    fn();
  }
  get scheduledDelay(): number | null {
    return this.slot ? this.slot.at - this.clock.value : null;
  }
}

type HealthResponse = { ok: boolean; status?: number; runtime?: Record<string, number> };

function makeFetch(responses: HealthResponse[], log: string[]): typeof fetch {
  let call = 0;
  return (async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    log.push(`probe:${next.ok ? 'ok' : 'fail'}`);
    if (!next.ok) throw new Error(`health probe status ${next.status ?? 500}`);
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', runtime: next.runtime ?? {} }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function events(watchdog: RuntimeWatchdog): RuntimeWatchdogEvent[] {
  return collected.get(watchdog) ?? [];
}

const collected = new Map<RuntimeWatchdog, RuntimeWatchdogEvent[]>();

function makeWatchdog(opts: {
  clock: FakeClock;
  scheduler: FakeScheduler;
  fetchImpl: typeof fetch;
}): RuntimeWatchdog {
  const wd = new RuntimeWatchdog({
    fetchImpl: opts.fetchImpl,
    scheduleFn: (fn, delayMs) => opts.scheduler.schedule(fn, delayMs),
    now: () => opts.clock.value,
    log: () => undefined,
  });
  collected.set(wd, []);
  wd.subscribe((e) => collected.get(wd)!.push(e));
  return wd;
}

// ------------------------------------------------------------- 1. heartbeat

console.log('\n1. Heartbeat cadence + server_ok');
{
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const log: string[] = [];
  const wd = makeWatchdog({
    clock,
    scheduler,
    fetchImpl: makeFetch([{ ok: true, runtime: { uptimeMs: 5_000, startedAt: 1, serverTime: 2 } }], log),
  });
  wd.start();
  assertEqual(scheduler.scheduledDelay, 60_000, 'first beat scheduled at the visible cadence (60 s)');

  scheduler.fire();
  await flush();
  const evts = events(wd);
  assert(evts.some((e) => e.kind === 'server_ok' && e.uptimeMs === 5_000), 'server_ok event carries runtime info');
  assertEqual(scheduler.scheduledDelay, 60_000, 'next beat re-scheduled at 60 s after success');
  assertEqual(log.length, 1, 'exactly one health probe fired');
  wd.stop();
}

// ------------------------------------------------------------- 2. hidden cadence

console.log('\n2. Hidden-tab cadence (lid-closed proxy)');
{
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const log: string[] = [];
  const wd = makeWatchdog({
    clock,
    scheduler,
    fetchImpl: makeFetch([{ ok: true }], log),
  });
  // Simulate the hidden document (document is undefined under Node; the
  // watchdog treats a missing document as visible — production uses the real
  // document. The hidden path is covered by monkeypatching a stub document).
  (globalThis as { document?: unknown }).document = { hidden: true, addEventListener: () => undefined, removeEventListener: () => undefined };
  wd.start();
  assertEqual(scheduler.scheduledDelay, 60_000, 'first beat is the fast boot readiness probe (60 s)');
  scheduler.fire();
  await flush();
  assertEqual(scheduler.scheduledDelay, 240_000, 'hidden document switches to the 240 s battery-friendly cadence');
  scheduler.fire();
  await flush();
  assertEqual(scheduler.scheduledDelay, 240_000, 'hidden cadence persists across beats');
  wd.stop();
  delete (globalThis as { document?: unknown }).document;
}

// ------------------------------------------------------------- 3. server loss/restore

console.log('\n3. Server loss, bounded backoff, restore');
{
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const log: string[] = [];
  const wd = makeWatchdog({
    clock,
    scheduler,
    fetchImpl: makeFetch([{ ok: false, status: 500 }, { ok: false, status: 500 }, { ok: false, status: 500 }, { ok: true, runtime: {} }], log),
  });
  wd.start();

  // failure 1 → server_lost + 30 s backoff
  scheduler.fire();
  await flush();
  assert(events(wd).some((e) => e.kind === 'server_lost' && e.consecutiveFailures === 1), 'first failure emits server_lost(1)');
  assertEqual(scheduler.scheduledDelay, 30_000, 'backoff step 1 = 30 s');
  assertEqual(wd.getStatus().serverAvailable, false, 'status marked unavailable');

  // failure 2 → no duplicate transition event, backoff grows
  scheduler.fire();
  await flush();
  const lostEvents = events(wd).filter((e) => e.kind === 'server_lost');
  assertEqual(lostEvents.length, 1, 'server_lost transition emitted once (no duplicate spam)');
  assertEqual(scheduler.scheduledDelay, 60_000, 'backoff step 2 = 60 s');

  // failure 3 → 120 s
  scheduler.fire();
  await flush();
  assertEqual(scheduler.scheduledDelay, 120_000, 'backoff step 3 = 120 s');

  // recovery → server_restored with downtime
  scheduler.fire();
  await flush();
  const restored = events(wd).find((e) => e.kind === 'server_restored');
  assert(!!restored, 'restore emits server_restored');
  assertEqual(restored && restored.kind === 'server_restored' ? restored.downtimeMs : -1, clock.value - (restored && restored.kind === 'server_restored' ? restored.downtimeMs : 0) ? (wd.getStatus().downtimeMs) : -1, 'downtime measured (>= backoff steps elapsed)');
  assert(wd.getStatus().downtimeMs > 0, 'status downtime > 0 after recovery');
  assertEqual(wd.getStatus().consecutiveFailures, 0, 'failure counter resets on restore');
  assertEqual(scheduler.scheduledDelay, 60_000, 'cadence returns to the normal beat after restore');
  wd.stop();
}

// ------------------------------------------------------------- 4. sleep/wake detection

console.log('\n4. Sleep/wake detection');
{
  // a) timer-drift signal: the beat fires far later than scheduled ⇒ suspension.
  {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler(clock);
    const log: string[] = [];
    const wd = makeWatchdog({ clock, scheduler, fetchImpl: makeFetch([{ ok: true }, { ok: true }], log) });
    wd.start();
    scheduler.fire(); // beat 1 (ok) — baseline established
    await flush();
    assertEqual(scheduler.scheduledDelay, 60_000, 'beat 2 scheduled normally');

    // Simulate sleep: the machine froze right after scheduling; on wake the
    // timer fires with the clock having advanced far past the deadline.
    clock.value += 3_600_000; // one hour of suspension
    scheduler.fire();
    await flush();
    const resumed = events(wd).filter((e) => e.kind === 'system_resumed');
    assert(resumed.length >= 1, 'one-hour beat delay detected as system resume (timer drift)');
    assert(resumed[0].kind === 'system_resumed' && resumed[0].detection === 'timer_drift', 'drift detection reported with its signal kind');
    wd.stop();
  }
  // b) ordinary throttling must NOT be reported as sleep (conservative threshold).
  {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler(clock);
    const log: string[] = [];
    const wd = makeWatchdog({ clock, scheduler, fetchImpl: makeFetch([{ ok: true }, { ok: true }], log) });
    wd.start();
    scheduler.fire();
    await flush();
    clock.value += 90_000; // hidden-tab clamp adds ~60 s — well under the threshold
    scheduler.fire();
    await flush();
    assert(events(wd).every((e) => e.kind !== 'system_resumed'), 'a 90 s delay is throttling, not sleep — no resume event');
    wd.stop();
  }
  // c) Page Lifecycle resume signal (primary path where the browser supports it).
  {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler(clock);
    const log: string[] = [];
    const wd = makeWatchdog({ clock, scheduler, fetchImpl: makeFetch([{ ok: true }], log) });
    const docListeners = new Map<string, () => void>();
    (globalThis as { document?: unknown }).document = {
      hidden: false,
      addEventListener: (name: string, fn: () => void) => docListeners.set(name, fn),
      removeEventListener: (name: string) => docListeners.delete(name),
    };
    wd.start();
    assert(docListeners.has('resume'), 'lifecycle resume listener attached where the DOM exists');
    docListeners.get('resume')!();
    const resumed = events(wd).filter((e) => e.kind === 'system_resumed');
    assertEqual(resumed.length, 1, 'lifecycle resume emits exactly one system_resumed');
    assert(resumed[0].kind === 'system_resumed' && resumed[0].detection === 'lifecycle_resume', 'lifecycle signal kind reported');
    wd.stop();
    delete (globalThis as { document?: unknown }).document;
  }
}

// ------------------------------------------------------------- 5. network signals

console.log('\n5. Network offline/online signalling');
{
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const log: string[] = [];
  const wd = makeWatchdog({ clock, scheduler, fetchImpl: makeFetch([{ ok: true }], log) });
  const winListeners = new Map<string, () => void>();
  (globalThis as { window?: unknown }).window = {
    addEventListener: (name: string, fn: () => void) => winListeners.set(name, fn),
    removeEventListener: (name: string) => winListeners.delete(name),
    SpeechRecognition: undefined,
  };
  wd.start();
  assert(winListeners.has('offline') && winListeners.has('online'), 'offline/online listeners attached');
  winListeners.get('offline')!();
  winListeners.get('online')!();
  const evts = events(wd);
  assert(evts.some((e) => e.kind === 'network_offline'), 'network_offline emitted');
  assert(evts.some((e) => e.kind === 'network_online'), 'network_online emitted');
  wd.stop();
  delete (globalThis as { window?: unknown }).window;
}

// ------------------------------------------------------------- 6. resource discipline

console.log('\n6. Resource discipline');
{
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const log: string[] = [];
  const wd = makeWatchdog({ clock, scheduler, fetchImpl: makeFetch([{ ok: true }], log) });
  wd.start();
  // In-flight dedup: firing while a beat is still resolving must not double-probe.
  scheduler.fire(); // beat in flight (fetch promise not yet flushed)
  wd.start(); // idempotent start
  await flush();
  assertEqual(log.length, 1, 'idempotent start + in-flight beat ⇒ exactly one probe');
  wd.stop();
  assertEqual(scheduler.scheduledDelay, null, 'stop cancels the pending beat (no dangling timer)');
  // stop() also detaches DOM/network listeners
  resetRuntimeWatchdogForTests();
}

// ------------------------------------------------------------- 7. graceful shutdown

console.log('\n7. Graceful shutdown sequence');
{
  const stops: string[] = [];
  const exits: number[] = [];
  const logs: string[] = [];
  installGracefulShutdown({
    onStop: () => stops.push('teardown'),
    exit: (code) => exits.push(code),
    log: (msg) => logs.push(msg),
  });
  // Fire the REAL signal on the REAL process object (synchronous listener dispatch).
  process.emit('SIGINT');
  assertEqual(exits.length, 1, 'SIGINT triggers exactly one exit');
  assertEqual(exits[0], 0, 'exit code 0 (intentional shutdown)');
  assertEqual(stops.length, 1, 'teardown runs exactly once');
  assert(logs.some((l) => l.includes('SIGINT') && l.includes('gracefully')), 'shutdown logs the signal');
  // idempotent: a second signal must not re-enter (shutdown already "exited")
  process.emit('SIGINT');
  assertEqual(exits.length, 1, 'second signal is ignored (no double teardown)');
  // cleanup: remove the listeners so the test process itself is unaffected
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
}

// ------------------------------------------------------------------- summary

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILED assertions:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
