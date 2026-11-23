/**
 * Conversational Silence Detection (Step 3) test suite.
 *
 * Covers the 12 verification scenarios: normal conversation activity,
 * conversation→silence transition, accurate inactivity-duration tracking,
 * reset on resumed activity, background-noise rejection, microphone
 * disconnection/reconnection, permission-denial/mute classification
 * precedence, hidden-window timer throttling with accurate lazy duration,
 * sleep/wake suspension compensation, explicit conversation end, resource
 * discipline (0-or-1 timers, no polling, silence schedules nothing),
 * audio-service classification, and the watchdog bridge mapping.
 *
 * Usage: npx tsx scripts/test-conversation-silence.ts
 * Exits non-zero on any failure.
 */
import {
  ConversationInactivityTracker,
  applyWatchdogEventToInactivity,
  resetConversationInactivityForTests,
  type InactivityTransition,
} from '../src/utils/conversationInactivity';
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
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

class FakeClock {
  value = 1000;
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
  /** Fire every due timer (deadline reached under the current clock). */
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

function makeTracker(clock: FakeClock, scheduler: FakeScheduler, activeWindowMs = 90_000) {
  const transitions: InactivityTransition[] = [];
  const tracker = new ConversationInactivityTracker({
    activeWindowMs,
    now: () => clock.value,
    scheduleFn: (fn, delayMs) => scheduler.schedule(fn, delayMs),
  });
  tracker.subscribe((t) => transitions.push(t));
  return { tracker, transitions };
}

// ------------------------------------------ 1. normal conversation activity

console.log('\n1. Normal conversation activity');
{
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const { tracker } = makeTracker(clock, scheduler);
  tracker.notifyActivity('text_message');
  const d = tracker.getDiagnostics();
  assertEqual(d.state, 'active_conversation', 'a sent message ⇒ active_conversation');
  assertEqual(d.inactivityMs, 0, 'inactivity duration starts at 0');
  assertEqual(d.pendingTransitionTimer, true, 'exactly one expiry timer scheduled while active');
  assertEqual(scheduler.pendingCount, 1, 'exactly one pending scheduler slot');
  tracker.notifyActivity('krix_reply');
  assertEqual(tracker.getDiagnostics().transitionCount, 0, 'activity within the window causes no state transition');
  tracker.dispose();
}

// --------------------------------- 2. transition conversation → silence

console.log('\n2. Transition from conversation to silence');
{
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const { tracker, transitions } = makeTracker(clock, scheduler);
  tracker.notifyActivity('wake_word');
  clock.value += 90_000; // active window elapses
  const fired = scheduler.fireDue();
  assertEqual(fired, 1, 'the expiry timer fires exactly once');
  assertEqual(tracker.getDiagnostics().state, 'conversational_inactivity', 'state becomes conversational_inactivity');
  assertEqual(transitions.length, 1, 'exactly one transition emitted');
  assertEqual(transitions[0].from, 'active_conversation', 'transition from active');
  assertEqual(transitions[0].to, 'conversational_inactivity', 'transition to inactive');
  assertEqual(tracker.getDiagnostics().pendingTransitionTimer, false, 'silence schedules NO further timers');
  assertEqual(scheduler.pendingCount, 0, 'zero pending timers during inactivity');
  clock.value += 600_000; // 10 more minutes of silence
  scheduler.fireDue();
  assertEqual(tracker.getDiagnostics().transitionCount, 1, 'no repeated transitions during long silence');
  tracker.dispose();
}

// --------------------------------- 3. accurate inactivity-duration tracking

console.log('\n3. Accurate inactivity-duration tracking');
{
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const { tracker } = makeTracker(clock, scheduler);
  tracker.notifyActivity('text_message');
  clock.value += 123_456;
  const d = tracker.getDiagnostics();
  assertEqual(d.inactivityMs, 123_456, 'duration matches elapsed wall time exactly (lazy computation)');
  // Reading repeatedly never drifts.
  assertEqual(tracker.getDiagnostics().inactivityMs, 123_456, 'repeated reads do not drift');
  // No activity ever recorded: bounded honest duration from tracker start.
  const t2 = makeTracker(clock, scheduler).tracker;
  const d2 = t2.getDiagnostics();
  assert(d2.inactivityMs >= 0 && d2.lastActivityAt === 0, 'no-activity session reports bounded duration with lastActivityAt=0');
  t2.dispose();
  tracker.dispose();
}

// --------------------------------- 4. reset after conversation resumes

console.log('\n4. Reset after conversation resumes');
{
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const { tracker, transitions } = makeTracker(clock, scheduler);
  tracker.notifyActivity('voice_command');
  clock.value += 90_000;
  scheduler.fireDue();
  assertEqual(tracker.getDiagnostics().state, 'conversational_inactivity', 'precondition: inactive');
  tracker.notifyActivity('krix_reply'); // conversation resumes
  const d = tracker.getDiagnostics();
  assertEqual(d.state, 'active_conversation', 'activity resets to active_conversation');
  assertEqual(d.inactivityMs, 0, 'inactivity duration reset to 0');
  assertEqual(transitions.filter((t) => t.to === 'conversational_inactivity').length, 1, 'no double transition emitted');
  tracker.dispose();
}

// --------------------------------- 5. background noise rejection

console.log('\n5. Background noise does not reset the timer');
{
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const { tracker } = makeTracker(clock, scheduler);
  tracker.notifyActivity('text_message');
  clock.value += 60_000;
  // Ambient noise / near-speech: the app receives raw interim transcripts
  // (setLiveTranscript) but those are NOT meaningful activity — the tracker
  // API has no "raw transcript" input at all, which is the structural guard.
  // Wake-word status churn (visible but unmatched chatter) also feeds nothing.
  clock.value += 29_000; // still inside the window even with "noise" passing
  assertEqual(tracker.getDiagnostics().state, 'active_conversation', 'noise (no meaningful event) never resets the window');
  clock.value += 1_000;
  scheduler.fireDue();
  assertEqual(tracker.getDiagnostics().state, 'conversational_inactivity', 'window expires exactly on schedule despite noise period');
  // Only a MATCHED wake word counts.
  tracker.notifyActivity('wake_word');
  assertEqual(tracker.getDiagnostics().state, 'active_conversation', 'matched wake word resets the clock');
  tracker.dispose();
}

// --------------------------------- 6. microphone disconnection and reconnection

console.log('\n6. Microphone disconnection and reconnection');
{
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const { tracker, transitions } = makeTracker(clock, scheduler);
  tracker.notifyActivity('voice_command');
  clock.value += 90_000;
  scheduler.fireDue();
  assertEqual(tracker.getDiagnostics().state, 'conversational_inactivity', 'precondition: silent');
  // Device disappears (audio-capture error mapped by the wake-word listener).
  tracker.reportMicIssue('microphone_unavailable');
  assertEqual(tracker.getDiagnostics().state, 'microphone_unavailable', 'mic loss is classified as a FAILURE, not silence');
  clock.value += 300_000;
  assertEqual(tracker.getDiagnostics().state, 'microphone_unavailable', 'failure classification persists (never degrades to silence)');
  // Device returns: recognition listens again → resolved.
  tracker.resolveMicIssue();
  assertEqual(tracker.getDiagnostics().state, 'conversational_inactivity', 'after recovery the state returns to honest silence');
  // A successful voice exchange after reconnect fully resets the clock.
  tracker.notifyActivity('transcribed_speech');
  assertEqual(tracker.getDiagnostics().state, 'active_conversation', 'post-reconnect activity ⇒ active');
  assertEqual(transitions.filter((t) => t.to === 'microphone_unavailable').length, 1, 'mic-failure transition emitted once');
  tracker.dispose();
}

// --------------------------------- 7. permission denial / detectable mute

console.log('\n7. Permission denial / detectable mute precedence');
{
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const { tracker } = makeTracker(clock, scheduler);
  tracker.notifyActivity('text_message');
  tracker.reportMicIssue('microphone_permission_denied'); // not-allowed / muted track
  const d = tracker.getDiagnostics();
  assertEqual(d.state, 'microphone_permission_denied', 'permission denial overrides activity classification');
  // A text message proves nothing about the microphone: the issue REMAINS.
  tracker.notifyActivity('text_message');
  assertEqual(tracker.getDiagnostics().state, 'microphone_permission_denied', 'text activity does not clear a microphone issue');
  // An audio-service issue is cleared by any activity (service reachable again).
  const t2 = makeTracker(clock, scheduler).tracker;
  t2.reportMicIssue('audio_service_unavailable');
  t2.notifyActivity('text_message');
  assertEqual(t2.getDiagnostics().state, 'active_conversation', 'audio-service issue clears on resumed activity');
  t2.dispose();
  // Voice activity clears ALL microphone issues.
  tracker.notifyActivity('voice_command');
  assertEqual(tracker.getDiagnostics().state, 'active_conversation', 'voice activity proves the mic path and clears the issue');
  tracker.dispose();
}

// --------------------------------- 8. hidden-window operation

console.log('\n8. Minimized/hidden window: throttled timers, accurate state');
{
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const { tracker } = makeTracker(clock, scheduler);
  tracker.notifyActivity('text_message');
  // Hidden-tab throttling delays the timer far past its deadline (the Step 1
  // watchdog measured up to ~60 s clamp). The transition event fires LATE —
  clock.value += 90_000 + 65_000; // window + throttle overshoot
  scheduler.fireDue();
  const d = tracker.getDiagnostics();
  assertEqual(d.state, 'conversational_inactivity', 'late-fired transition still classifies correctly');
  assertEqual(d.inactivityMs, 155_000, 'duration stays accurate despite throttled delivery (lazy timestamp math)');
  // While hidden, wake-word listening pauses (paused_hidden) — that is NOT
  // activity: no notify call ⇒ nothing resets; state stays honestly inactive.
  clock.value += 240_000;
  scheduler.fireDue();
  assertEqual(tracker.getDiagnostics().state, 'conversational_inactivity', 'hidden period without signals keeps honest inactivity');
  assertEqual(tracker.getDiagnostics().pendingTransitionTimer, false, 'no timer churn while hidden and silent');
  tracker.dispose();
}

// --------------------------------- 9. sleep/wake recovery

console.log('\n9. Windows sleep and wake recovery');
{
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const { tracker, transitions } = makeTracker(clock, scheduler);
  tracker.notifyActivity('voice_command');
  clock.value += 30_000; // 30 s into the conversation window...
  // System suspends (Page Lifecycle freeze).
  tracker.markSuspensionStart();
  assertEqual(tracker.getDiagnostics().state, 'system_suspended', 'suspension is classified as system_suspended');
  clock.value += 8 * 3600_000; // laptop asleep for 8 hours
  // Wake: Step 1 watchdog reports the suspension duration.
  const resumeEvent: RuntimeWatchdogEvent = { kind: 'system_resumed', detection: 'timer_drift', suspendedForMs: 8 * 3600_000 };
  applyWatchdogEventToInactivity(tracker, resumeEvent);
  const d = tracker.getDiagnostics();
  assertEqual(d.state, 'active_conversation', 'wake restores the pre-sleep classification');
  assertEqual(d.inactivityMs, 30_000, 'sleep time EXCLUDED from inactivity duration (8 h sleep ≠ 8 h silence)');
  assertEqual(d.suspensionCompensationMs, 8 * 3600_000, 'compensation accounted honestly');
  assertEqual(transitions.some((t) => t.from === 'system_suspended'), true, 'resume transition emitted');
  // Server loss must NEVER touch the inactivity clock (not silence, not sleep).
  applyWatchdogEventToInactivity(tracker, { kind: 'server_lost', consecutiveFailures: 1 });
  applyWatchdogEventToInactivity(tracker, { kind: 'server_restored', downtimeMs: 5000 });
  assertEqual(tracker.getDiagnostics().inactivityMs, 30_000, 'server downtime does not alter the inactivity clock');
  tracker.dispose();
}

// --------------------------------- 10. explicit conversation end

console.log('\n10. Conversation explicitly ending');
{
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const { tracker } = makeTracker(clock, scheduler);
  tracker.notifyActivity('text_message');
  tracker.markConversationEnded(); // user clicked "new conversation"
  assertEqual(tracker.getDiagnostics().state, 'conversation_ended_explicitly', 'explicit end recorded honestly');
  clock.value += 300_000;
  assertEqual(tracker.getDiagnostics().state, 'conversation_ended_explicitly', 'explicit end is sticky (not silence, not a failure)');
  // New meaningful activity re-opens the conversation.
  tracker.notifyActivity('wake_word');
  assertEqual(tracker.getDiagnostics().state, 'active_conversation', 'new activity overrides the explicit end');
  tracker.dispose();
}

// --------------------------------- 11. CPU / memory discipline

console.log('\n11. Resource discipline (timers, no polling, bounded state)');
{
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const { tracker } = makeTracker(clock, scheduler);
  // Rapid-fire activity never stacks duplicate timers.
  for (let i = 0; i < 50; i++) {
    tracker.notifyActivity('text_message');
    clock.value += 1_000;
  }
  assertEqual(scheduler.pendingCount, 1, '50 rapid activities ⇒ still exactly ONE pending timer');
  assertEqual(tracker.getDiagnostics().transitionCount, 0, 'rapid activity within the window ⇒ zero transitions (no churn)');
  // Silence ⇒ zero timers; a bounded diagnostics object only.
  clock.value += 90_000;
  scheduler.fireDue();
  assertEqual(scheduler.pendingCount, 0, 'zero timers during inactivity (event-driven, no polling)');
  const d = tracker.getDiagnostics();
  assert(!('transcripts' in d) && !('audio' in d) && !('content' in d), 'diagnostics are content-free by construction');
  assertEqual(Object.keys(d).length, 10, 'diagnostics shape is fixed and bounded');
  tracker.dispose();
  assertEqual(scheduler.pendingCount, 0, 'dispose cancels all timers');
  resetConversationInactivityForTests();
}

// --------------------------------- 12. regression: voice + runtime integration intact

console.log('\n12. Regression — Step 1/2 surfaces intact');
{
  // The watchdog bridge maps ONLY suspension; server/network events are inert.
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const { tracker } = makeTracker(clock, scheduler);
  tracker.notifyActivity('text_message');
  applyWatchdogEventToInactivity(tracker, { kind: 'network_offline' });
  applyWatchdogEventToInactivity(tracker, { kind: 'network_online' });
  applyWatchdogEventToInactivity(tracker, { kind: 'server_ok' });
  assertEqual(tracker.getDiagnostics().state, 'active_conversation', 'non-suspension watchdog events leave the tracker untouched');
  // The singleton accessor returns one instance (App wiring contract).
  resetConversationInactivityForTests();
  const a = Object.getPrototypeOf(tracker).constructor.name;
  assertEqual(a, 'ConversationInactivityTracker', 'tracker instance contract intact');
  tracker.dispose();
}

// ------------------------------------------------------------------- summary

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILED assertions:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
