/**
 * Proactive Conversations (Step 4) test suite.
 *
 * Covers the 16 verification scenarios: initiation after the configured
 * threshold, no initiation before it, one attempt per inactivity period,
 * [SILENT] decisions, cancellation on user interaction (incl. abort of
 * in-flight generation), disabled/quiet-hours/minimum-interval enforcement,
 * immediate stop, no interruption of active conversations, delivery-time
 * failure handling, sleep/wake staleness, server-loss cancellation, hidden-
 * window throttled delivery, duplicate/stale prevention, resource discipline
 * (0-or-1 timers, one AI call per period max), and watchdog bridging.
 *
 * Usage: npx tsx scripts/test-proactive-conversations.ts
 * Exits non-zero on any failure.
 */
import { ConversationInactivityTracker } from '../src/utils/conversationInactivity';
import {
  ProactiveConversationService,
  isQuietHour,
  proactiveSettingsFromCompanion,
  resetProactiveConversationForTests,
  type ProactiveMessage,
  type ProactiveSettings,
} from '../src/utils/proactiveConversation';

// ------------------------------------------------------------------ harness

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(label);
    console.error(`  âœ— ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

class FakeClock {
  // Deterministic local-time base: today at 14:00 local (afternoon â€” outside
  // the default 23â€“08 quiet window).
  value: number;
  constructor() {
    const d = new Date();
    d.setHours(14, 0, 0, 0);
    this.value = d.getTime();
  }
  setLocalHour(hour: number): void {
    const d = new Date(this.value);
    d.setHours(hour, 0, 0, 0);
    this.value = d.getTime();
  }
}

class FakeScheduler {
  private slots: Array<{ fn: () => void; at: number }> = [];
  constructor(private clock: FakeClock) {}
  schedule(fn: () => void, delayMs: number): () => void {
    this.slots.push({ fn, at: this.clock.value + delayMs });
    return () => {
      this.slots = this.slots.filter((s) => s.fn !== fn);
    };
  }
  fireDue(): number {
    const due = this.slots.filter((s) => s.at <= this.clock.value);
    this.slots = this.slots.filter((s) => s.at > this.clock.value);
    for (const s of due) s.fn();
    return due.length;
  }
  get pendingCount(): number {
    return this.slots.length;
  }
}

interface Harness {
  clock: FakeClock;
  scheduler: FakeScheduler;
  tracker: ConversationInactivityTracker;
  service: ProactiveConversationService;
  generated: Array<{ inactivityMinutes: number; signal: AbortSignal }>;
  generateControl: { resolve: ((r: { silent: boolean; message?: ProactiveMessage } | 'abort_error') => void) | null };
  delivered: ProactiveMessage[];
  deliverFail: { fail: boolean };
  speaking: { value: boolean };
  settings: ProactiveSettings;
  flush: () => Promise<void>;
  /** Advance-free: run every due timer (repeat while cascading) + flush microtasks. */
  settle: () => Promise<void>;
  advanceSettle: (ms: number) => Promise<void>;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function makeHarness(overrides?: Partial<ProactiveSettings>): Harness {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const tracker = new ConversationInactivityTracker({
    now: () => clock.value,
    scheduleFn: (fn, delayMs) => scheduler.schedule(fn, delayMs),
  });
  const settings: ProactiveSettings = {
    enabled: true,
    inactivityMinutes: 30,
    minIntervalHours: 3,
    quietHoursEnabled: false,
    quietStartHour: 23,
    quietEndHour: 8,
    ...overrides,
  };
  const generated: Array<{ inactivityMinutes: number; signal: AbortSignal }> = [];
  const delivered: ProactiveMessage[] = [];
  const deliverFail = { fail: false };
  const speaking = { value: false };
  const generateControl: { resolve: ((r: { silent: boolean; message?: ProactiveMessage } | 'abort_error') => void) | null } = { resolve: null };

  const service = new ProactiveConversationService({
    tracker,
    getSettings: () => settings,
    isVoiceEnabled: () => true,
    isSpeaking: () => speaking.value,
    serverAvailable: () => true,
    generate: async ({ inactivityMinutes, signal }) => {
      generated.push({ inactivityMinutes, signal });
      // Controlled generation: the test resolves it explicitly.
      return new Promise((resolve, reject) => {
        generateControl.resolve = (r) => {
          if (r === 'abort_error') reject(new DOMException('aborted', 'AbortError'));
          else resolve(r);
        };
        signal.addEventListener('abort', () => {
          if (generateControl.resolve) {
            const r = generateControl.resolve;
            generateControl.resolve = null;
            r('abort_error');
          }
        });
      });
    },
    deliver: (message) => {
      if (deliverFail.fail) throw new Error('audio device gone');
      delivered.push(message);
    },
    now: () => clock.value,
    scheduleFn: (fn, delayMs) => scheduler.schedule(fn, delayMs),
  });
  service.attach();

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) {
      if (scheduler.fireDue() === 0) break;
      await flush();
    }
    await flush();
  };

  return {
    clock,
    scheduler,
    tracker,
    service,
    generated,
    generateControl,
    delivered,
    deliverFail,
    speaking,
    settings,
    flush,
    settle,
    advanceSettle: async (ms: number) => {
      clock.value += ms;
      await settle();
    },
  };
}

const TEST_MESSAGE: ProactiveMessage = {
  text: 'You worked so hard today â€” I kept thinking about it.',
  expression: 'gentle_smile',
  emotionData: { expression: 'gentle_smile', intensity: 0.8, gesture: 'subtle_nod', blushLevel: 0.3 },
};

// --------------------------------- 1. initiation after the threshold

console.log('\n1. Proactive initiation after the configured threshold');
{
  const h = makeHarness();
  h.tracker.notifyActivity('text_message');
  await h.advanceSettle(30 * 60_000);
  assertEqual(h.generated.length, 1, 'generation starts exactly once at the threshold');
  if (h.generateControl.resolve) h.generateControl.resolve!({ silent: false, message: TEST_MESSAGE });
  await h.flush();
  assertEqual(h.delivered.length, 1, 'message delivered after generation');
  assertEqual(h.delivered[0].text, TEST_MESSAGE.text, 'delivered text is the generated message');
  assert(h.service.getDiagnostics().lastProactiveAt > 0, 'lastProactiveAt recorded');
  h.service.detach();
  resetProactiveConversationForTests();
}

// --------------------------------- 2. no initiation before the threshold

console.log('\n2. No initiation before the threshold');
{
  const h = makeHarness();
  h.tracker.notifyActivity('text_message');
  await h.advanceSettle(29 * 60_000); // 1 minute BEFORE the threshold
  assertEqual(h.generated.length, 0, 'no AI call before the configured threshold');
  assertEqual(h.scheduler.pendingCount, 1, 'threshold timer still armed (remaining time)');
  h.service.detach();
  resetProactiveConversationForTests();
}

// --------------------------------- 3. no repeated messages in one period

console.log('\n3. No repeated messages during one inactivity period');
{
  const h = makeHarness();
  h.tracker.notifyActivity('text_message');
  await h.advanceSettle(30 * 60_000);
  if (h.generateControl.resolve) h.generateControl.resolve!({ silent: false, message: TEST_MESSAGE });
  await h.flush();
  assertEqual(h.delivered.length, 1, 'first proactive message delivered');
  // Hours more of the SAME inactivity period: no further attempts.
  await h.advanceSettle(4 * 3600_000);
  assertEqual(h.generated.length, 1, 'generation NOT repeated in the same period');
  assertEqual(h.delivered.length, 1, 'no duplicate delivery');
  // A new period (activity â†’ silence again) re-arms.
  h.tracker.notifyActivity('wake_word');
  await h.advanceSettle(30 * 60_000);
  assertEqual(h.generated.length, 2, 'a NEW inactivity period re-arms initiation');
  if (h.generateControl.resolve) h.generateControl.resolve!({ silent: false, message: TEST_MESSAGE });
  await h.flush();
  assertEqual(h.delivered.length, 2, 'second period delivers');
  h.service.detach();
  resetProactiveConversationForTests();
}

// --------------------------------- 4. silence when nothing worthwhile

console.log('\n4. Generation decides [SILENT] â†’ Krix stays silent');
{
  const h = makeHarness();
  h.tracker.notifyActivity('text_message');
  await h.advanceSettle(30 * 60_000);
  if (h.generateControl.resolve) h.generateControl.resolve!({ silent: true });
  await h.flush();
  assertEqual(h.delivered.length, 0, 'nothing delivered on a [SILENT] decision');
  const d = h.service.getDiagnostics();
  assertEqual(d.silentDecisions, 1, 'silent decision recorded');
  assertEqual(d.periodConsumed, true, 'period consumed (no retry within the same period)');
  await h.advanceSettle(3 * 3600_000);
  assertEqual(h.generated.length, 1, 'no further generation in the same period');
  h.service.detach();
  resetProactiveConversationForTests();
}

// --------------------------------- 5. cancellation on user interaction

console.log('\n5. Cancellation when the user begins interacting');
{
  // a) in-flight generation aborted
  const h = makeHarness();
  h.tracker.notifyActivity('text_message');
  await h.advanceSettle(30 * 60_000);
  assertEqual(h.service.getDiagnostics().phase, 'generating', 'precondition: generating');
  h.tracker.notifyActivity('wake_word'); // user starts interacting
  await h.flush();
  assertEqual(h.generated[0].signal.aborted, true, 'in-flight generation aborted via the AbortSignal');
  assert(h.service.getDiagnostics().cancellations >= 1, 'cancellation recorded');
  if (h.generateControl.resolve) h.generateControl.resolve!({ silent: false, message: TEST_MESSAGE }); // late resolution
  await h.flush();
  assertEqual(h.delivered.length, 0, 'late generation result is discarded (never spoken)');
  // b) armed (not yet fired) period cancelled by activity
  const h2 = makeHarness({ inactivityMinutes: 45 });
  h2.tracker.notifyActivity('text_message');
  await h2.advanceSettle(30 * 60_000); // tracker went inactive; service armed for the remaining 15 min
  assertEqual(h2.service.getDiagnostics().pendingTimer, true, 'service threshold timer pending');
  h2.tracker.notifyActivity('transcribed_speech'); // user interacts
  await h2.flush();
  assertEqual(h2.service.getDiagnostics().pendingTimer, false, 'armed timer cancelled immediately on user activity');
  assertEqual(h2.service.getDiagnostics().periodConsumed, true, 'cancelled period consumed');
  // A FRESH period after the interaction may arm again — but only after a
  // FULL new sustained silence (the cancellation did not carry over).
  await h2.advanceSettle(30 * 60_000); // 30 min of the new silence — below 45
  assertEqual(h2.generated.length, 0, 'fresh period still respects its own threshold after cancellation');
  await h2.advanceSettle(15 * 60_000); // full 45 min of new silence reached
  assertEqual(h2.generated.length, 1, 'fresh period generates exactly once after full silence');
  h.service.detach();
  h2.service.detach();
  resetProactiveConversationForTests();
}

// --------------------------------- 6. disabled â†’ silent

console.log('\n6. No initiation when proactive conversations are disabled');
{
  const h = makeHarness({ enabled: false });
  h.tracker.notifyActivity('text_message');
  await h.advanceSettle(30 * 60_000);
  assertEqual(h.generated.length, 0, 'disabled â‡’ no generation');
  assertEqual(h.delivered.length, 0, 'disabled â‡’ no delivery');
  // Toggling OFF mid-generation stops everything immediately.
  const h2 = makeHarness();
  h2.tracker.notifyActivity('text_message');
  await h2.advanceSettle(30 * 60_000);
  (h2.settings as ProactiveSettings).enabled = false;
  h2.service.onSettingsChanged();
  if (h2.generateControl.resolve) h2.generateControl.resolve!({ silent: false, message: TEST_MESSAGE });
  await h2.flush();
  assertEqual(h2.delivered.length, 0, 'disable during generation cancels delivery');
  h.service.detach();
  h2.service.detach();
  resetProactiveConversationForTests();
}

// --------------------------------- 7. quiet hours enforcement

console.log('\n7. Quiet-hours enforcement');
{
  assertEqual(isQuietHour(23, 23, 8), true, 'quiet start hour is quiet');
  assertEqual(isQuietHour(3, 23, 8), true, 'overnight middle is quiet');
  assertEqual(isQuietHour(7, 23, 8), true, 'hour before end is quiet');
  assertEqual(isQuietHour(8, 23, 8), false, 'end hour is NOT quiet');
  assertEqual(isQuietHour(14, 23, 8), false, 'daytime is NOT quiet');
  assertEqual(isQuietHour(12, 12, 12), false, 'degenerate window (start==end) is never quiet');

  const h = makeHarness({ quietHoursEnabled: true, quietStartHour: 23, quietEndHour: 8 });
  h.tracker.notifyActivity('text_message');
  h.clock.setLocalHour(23); // threshold fires inside the quiet window
  await h.advanceSettle(30 * 60_000);
  assertEqual(h.generated.length, 0, 'no generation during quiet hours');
  assertEqual(h.service.getDiagnostics().periodConsumed, true, 'quiet-hours period consumed (no retry until real activity)');
  // Outside quiet hours it proceeds normally.
  const h2 = makeHarness({ quietHoursEnabled: true, quietStartHour: 23, quietEndHour: 8 });
  h2.tracker.notifyActivity('text_message');
  h2.clock.setLocalHour(14);
  await h2.advanceSettle(30 * 60_000);
  if (h2.generateControl.resolve) h2.generateControl.resolve!({ silent: false, message: TEST_MESSAGE });
  await h2.flush();
  assertEqual(h2.delivered.length, 1, 'outside quiet hours the message is delivered');
  h.service.detach();
  h2.service.detach();
  resetProactiveConversationForTests();
}

// --------------------------------- 8. minimum-interval enforcement

console.log('\n8. Minimum-interval enforcement');
{
  const h = makeHarness({ minIntervalHours: 3 });
  h.tracker.notifyActivity('text_message');
  await h.advanceSettle(30 * 60_000);
  if (h.generateControl.resolve) h.generateControl.resolve!({ silent: false, message: TEST_MESSAGE });
  await h.flush();
  assertEqual(h.delivered.length, 1, 'first proactive delivered');
  // New period begins ~1 hour after the proactive message â€” BELOW the 3 h interval.
  h.tracker.notifyActivity('wake_word');
  await h.advanceSettle(30 * 60_000); // â‰ˆ1 h since last proactive
  assertEqual(h.generated.length, 1, 'generation attempt happens (attempt counter)');
  assertEqual(h.delivered.length, 1, 'minimum interval suppresses delivery (period consumed silently)');
  assertEqual(h.service.getDiagnostics().periodConsumed, true, 'interval-blocked period consumed without delivery');
  // A period beginning AFTER the interval elapses proceeds.
  h.tracker.notifyActivity('wake_word');
  await h.advanceSettle(3 * 3600_000 + 30 * 60_000);
  if (h.generateControl.resolve) h.generateControl.resolve!({ silent: false, message: TEST_MESSAGE });
  await h.flush();
  assertEqual(h.delivered.length, 2, 'after the interval a new period delivers');
  h.service.detach();
  resetProactiveConversationForTests();
}

// --------------------------------- 9. immediate stop

console.log('\n9. Immediate stop behavior');
{
  const h = makeHarness();
  h.tracker.notifyActivity('text_message');
  await h.advanceSettle(30 * 60_000);
  assertEqual(h.service.getDiagnostics().phase, 'generating', 'precondition: generating');
  h.service.stopNow();
  await h.flush();
  assertEqual(h.generated[0].signal.aborted, true, 'stopNow aborts in-flight generation');
  assertEqual(h.scheduler.pendingCount, 0, 'stopNow clears pending timers');
  assertEqual(h.service.getDiagnostics().periodConsumed, true, 'stopNow consumes the period');
  if (h.generateControl.resolve) h.generateControl.resolve!({ silent: false, message: TEST_MESSAGE });
  await h.flush();
  assertEqual(h.delivered.length, 0, 'nothing delivered after stopNow');
  h.service.detach();
  resetProactiveConversationForTests();
}

// --------------------------------- 10. never interrupt an active conversation

console.log('\n10. No interruption of active conversations');
{
  const h = makeHarness();
  h.tracker.notifyActivity('text_message');
  assertEqual(h.tracker.getDiagnostics().state, 'active_conversation', 'precondition: active conversation');
  await h.advanceSettle(10 * 60_000);
  assertEqual(h.generated.length, 0, 'nothing fires while the conversation is active');
  assertEqual(h.service.getDiagnostics().phase, 'monitoring', 'service stays in monitoring');
  // Krix currently speaking â‡’ never eligible.
  const h2 = makeHarness();
  h2.speaking.value = true;
  h2.tracker.notifyActivity('text_message');
  await h2.advanceSettle(30 * 60_000);
  assertEqual(h2.generated.length, 0, 'no initiation while Krix is speaking');
  h.service.detach();
  h2.service.detach();
  resetProactiveConversationForTests();
}

// --------------------------------- 11. delivery failure (audio device)

console.log('\n11. Audio-device failure at delivery');
{
  const h = makeHarness();
  h.deliverFail.fail = true; // Step 2 device-failure simulation
  h.tracker.notifyActivity('text_message');
  await h.advanceSettle(30 * 60_000);
  if (h.generateControl.resolve) h.generateControl.resolve!({ silent: false, message: TEST_MESSAGE });
  await h.flush();
  assertEqual(h.delivered.length, 0, 'failed delivery is not recorded as spoken');
  const d = h.service.getDiagnostics();
  assertEqual(d.periodConsumed, true, 'failed delivery consumes the period (no tight retry loop)');
  assertEqual(d.phase, 'monitoring', 'service recovers to monitoring without crashing');
  // Service remains healthy for a later period. The failed delivery counts
  // toward the anti-spam interval (measured from the attempt), so the next
  // attempt waits the full interval — across a fresh inactivity period.
  h.deliverFail.fail = false;
  h.tracker.notifyActivity('wake_word');
  await h.advanceSettle(30 * 60_000);
  assertEqual(h.delivered.length, 0, 'within the minimum interval the retry stays silent (no spam loop)');
  await h.advanceSettle(3 * 3600_000); // interval elapses; period was already consumed
  h.tracker.notifyActivity('wake_word'); // fresh period AFTER the interval
  await h.advanceSettle(30 * 60_000);
  if (h.generateControl.resolve) h.generateControl.resolve!({ silent: false, message: TEST_MESSAGE });
  await h.flush();
  assertEqual(h.delivered.length, 1, 'a later period delivers normally after recovery');
  h.service.detach();
  resetProactiveConversationForTests();
}

// --------------------------------- 12. sleep/wake behavior

console.log('\n12. Sleep/wake behavior (stale drop + honest time)');
{
  const h = makeHarness();
  h.tracker.notifyActivity('text_message');
  await h.advanceSettle(20 * 60_000); // 20 minutes of real inactivity
  h.tracker.markSuspensionStart(); // system suspends
  h.clock.value += 8 * 3600_000; // laptop asleep for 8 hours
  h.service.notifyWatchdogEvent({ kind: 'system_resumed', detection: 'timer_drift', suspendedForMs: 8 * 3600_000 });
  h.tracker.markSuspensionEnd(8 * 3600_000);
  await h.flush();
  assertEqual(h.tracker.getDiagnostics().inactivityMs, 20 * 60_000, 'tracker duration excludes sleep (Step 3)');
  // Sleep time does NOT count toward the threshold: after waking, only
  // REAL additional inactivity brings the total to 30 sustained minutes.
  await h.advanceSettle(5 * 60_000); // 25 min real inactivity â€” below threshold
  assertEqual(h.generated.length, 0, '8 hours of sleep do not trigger a proactive message');
  await h.advanceSettle(5 * 60_000); // 30 min REAL sustained inactivity reached
  if (h.generateControl.resolve) h.generateControl.resolve!({ silent: false, message: TEST_MESSAGE });
  await h.flush();
  assertEqual(h.delivered.length, 1, 'after REAL sustained inactivity Krix may speak once');
  // A pending proactive is DROPPED as stale when sleep happens mid-generation.
  const h2 = makeHarness();
  h2.tracker.notifyActivity('text_message');
  await h2.advanceSettle(30 * 60_000);
  h2.service.notifyWatchdogEvent({ kind: 'system_resumed', detection: 'lifecycle_resume', suspendedForMs: 3600_000 });
  if (h2.generateControl.resolve) h2.generateControl.resolve!({ silent: false, message: TEST_MESSAGE });
  await h2.flush();
  assertEqual(h2.delivered.length, 0, 'stale pending message after wake is never spoken');
  h.service.detach();
  h2.service.detach();
  resetProactiveConversationForTests();
}

// --------------------------------- 13. minimized / hidden-window operation

console.log('\n13. Minimized and hidden-window behavior');
{
  const h = makeHarness();
  h.tracker.notifyActivity('text_message');
  // Hidden-tab throttling delays the timer past its deadline.
  await h.advanceSettle(30 * 60_000 + 65_000);
  assertEqual(h.generated.length, 1, 'throttled (late) timer still initiates while hidden');
  if (h.generateControl.resolve) h.generateControl.resolve!({ silent: false, message: TEST_MESSAGE });
  await h.flush();
  assertEqual(h.delivered.length, 1, 'delivery completes with the lazy-accurate duration');
  h.service.detach();
  resetProactiveConversationForTests();
}

// --------------------------------- 14. no duplicate / stale playback

console.log('\n14. No duplicate playback or stale queued messages');
{
  const h = makeHarness();
  h.tracker.notifyActivity('text_message');
  await h.advanceSettle(30 * 60_000);
  // Server dies while generating â†’ cancelled + period consumed.
  h.service.notifyWatchdogEvent({ kind: 'server_lost', consecutiveFailures: 1 });
  if (h.generateControl.resolve) h.generateControl.resolve!({ silent: false, message: TEST_MESSAGE });
  await h.flush();
  assertEqual(h.delivered.length, 0, 'server loss cancels the in-flight generation result');
  assertEqual(h.service.getDiagnostics().periodConsumed, true, 'period consumed on server loss');
  // Server returns; the SAME period still does not double-fire.
  h.service.notifyWatchdogEvent({ kind: 'server_restored', downtimeMs: 5000 });
  await h.advanceSettle(2 * 3600_000);
  assertEqual(h.generated.length, 1, 'no re-generation within the consumed period');
  assertEqual(h.delivered.length, 0, 'no stale queued message after reconnection');
  h.service.detach();
  resetProactiveConversationForTests();
}

// --------------------------------- 15. CPU / memory / network overhead

console.log('\n15. Resource discipline (timers + one AI call per period)');
{
  const h = makeHarness();
  h.tracker.notifyActivity('text_message');
  assertEqual(h.scheduler.pendingCount, 1, 'exactly ONE timer while a period is armed');
  // Silence: after consumption, zero timers, zero AI calls.
  await h.advanceSettle(30 * 60_000);
  if (h.generateControl.resolve) h.generateControl.resolve!({ silent: true });
  await h.flush();
  assertEqual(h.scheduler.pendingCount, 0, 'zero timers after the period is consumed (no polling loop)');
  assertEqual(h.generated.length, 1, 'at most ONE AI call per inactivity period');
  // Long silence with no activity: still zero timers, zero calls.
  await h.advanceSettle(12 * 3600_000);
  assertEqual(h.generated.length, 1, 'no background AI calls during long silence');
  assertEqual(h.service.getDiagnostics().generationAttempts, 1, 'attempt counter bounded per period');
  h.service.detach();
  assertEqual(h.scheduler.pendingCount, 0, 'detach cancels everything');
  resetProactiveConversationForTests();
}

// --------------------------------- 16. regression bridges + settings mapping

console.log('\n16. Regression bridges (watchdog mapping, settings clamps)');
{
  const h = makeHarness();
  // Non-suspension/non-loss watchdog events are inert.
  h.service.notifyWatchdogEvent({ kind: 'network_offline' });
  h.service.notifyWatchdogEvent({ kind: 'server_ok' });
  h.tracker.notifyActivity('text_message');
  assertEqual(h.scheduler.pendingCount, 1, 'inert watchdog events leave the armed period intact');
  // Settings mapping: clamped, defaults applied for absent keys.
  const mapped = proactiveSettingsFromCompanion({});
  assertEqual(mapped.enabled, true, 'default enabled');
  assertEqual(mapped.inactivityMinutes, 30, 'default threshold');
  assertEqual(mapped.minIntervalHours, 3, 'default interval');
  const clamped = proactiveSettingsFromCompanion({ proactiveInactivityMinutes: 5000, proactiveMinIntervalHours: -2, proactiveQuietHoursStart: 30 });
  assertEqual(clamped.inactivityMinutes, 720, 'threshold clamped to 720');
  assertEqual(clamped.minIntervalHours, 1, 'interval clamped to â‰¥1');
  assertEqual(clamped.quietStartHour, 23, 'quiet start clamped to valid range');
  h.service.detach();
  resetProactiveConversationForTests();
}

// ------------------------------------------------------------------- summary

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILED assertions:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

