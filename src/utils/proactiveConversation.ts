/**
 * Proactive Conversations (Step 4) — initiation service.
 *
 * Lets Krix independently initiate ONE occasional, contextually appropriate
 * voice message after SUSTAINED conversational inactivity, using exactly the
 * surfaces built in Steps 1–3:
 *   - Step 3 tracker supplies the inactivity state/duration (no second
 *     silence detector exists here — the service only consumes transitions).
 *   - Generation rides the existing chat intelligence via
 *     /api/proactive/generate (same identity/persona/memory pipeline; the
 *     model may answer [SILENT] — silence is a first-class outcome).
 *   - Delivery rides the Step 2 voice pipeline (session discipline, recovery,
 *     no duplicate playback).
 *
 * Presence, not notifications: at most ONE attempt per inactivity period,
 * bounded quiet hours, minimum interval between proactive messages, and
 * immediate cancellation the moment the user shows any interaction. If
 * anything is not clearly eligible at PLAYBACK time, Krix stays silent.
 *
 * Content discipline: no polling of the microphone, no transcripts, no
 * fabricated user activity, no persistence of proactive state across
 * restarts (a fresh boot starts quiet), no memory dumping beyond the normal
 * relevance-recalled context the chat pipeline already uses.
 */
import type { ConversationInactivityTracker, InactivityTransition } from './conversationInactivity';
import type { RuntimeWatchdogEvent } from './runtimeWatchdog';

export interface ProactiveSettings {
  enabled: boolean;
  /** Sustained inactivity before Krix MAY decide to speak (minutes). */
  inactivityMinutes: number;
  /** Minimum time between proactive messages (hours). */
  minIntervalHours: number;
  quietHoursEnabled: boolean;
  /** Local-time quiet window (0–23; overnight windows supported). */
  quietStartHour: number;
  quietEndHour: number;
}

export const DEFAULT_PROACTIVE_SETTINGS: ProactiveSettings = {
  enabled: true,
  inactivityMinutes: 30,
  minIntervalHours: 3,
  quietHoursEnabled: true,
  quietStartHour: 23,
  quietEndHour: 8,
};

/** Build the service settings from stored CompanionSettings (bounded/clamped). */
export function proactiveSettingsFromCompanion(s: {
  proactiveConversations?: boolean;
  proactiveInactivityMinutes?: number;
  proactiveMinIntervalHours?: number;
  proactiveQuietHoursEnabled?: boolean;
  proactiveQuietHoursStart?: number;
  proactiveQuietHoursEnd?: number;
}): ProactiveSettings {
  const clampNum = (v: number | undefined, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : fallback;
  return {
    enabled: s.proactiveConversations ?? DEFAULT_PROACTIVE_SETTINGS.enabled,
    inactivityMinutes: clampNum(s.proactiveInactivityMinutes, 5, 720, DEFAULT_PROACTIVE_SETTINGS.inactivityMinutes),
    minIntervalHours: clampNum(s.proactiveMinIntervalHours, 1, 168, DEFAULT_PROACTIVE_SETTINGS.minIntervalHours),
    quietHoursEnabled: s.proactiveQuietHoursEnabled ?? DEFAULT_PROACTIVE_SETTINGS.quietHoursEnabled,
    quietStartHour: clampNum(s.proactiveQuietHoursStart, 0, 23, DEFAULT_PROACTIVE_SETTINGS.quietStartHour),
    quietEndHour: clampNum(s.proactiveQuietHoursEnd, 0, 23, DEFAULT_PROACTIVE_SETTINGS.quietEndHour),
  };
}

export type ProactivePhase =
  | 'monitoring'
  | 'generating'
  | 'pending_delivery'
  | 'delivered';

export interface ProactiveDiagnostics {
  phase: ProactivePhase;
  enabled: boolean;
  /** Epoch ms of the transition that opened the current inactivity period (0 = none). */
  currentPeriodStartedAt: number;
  periodConsumed: boolean;
  lastProactiveAt: number;
  generationAttempts: number;
  silentDecisions: number;
  cancellations: number;
  pendingTimer: boolean;
}

export interface ProactiveMessage {
  text: string;
  expression: string;
  emotionData: {
    expression: string;
    intensity: number;
    gesture: string;
    blushLevel: number;
  };
}

export interface ProactiveDeps {
  /** Step 3 tracker (transitions feed the period lifecycle). */
  tracker: ConversationInactivityTracker;
  /** Current user settings (re-read on every decision — never cached stale). */
  getSettings: () => ProactiveSettings;
  /** Explicit voice-output availability (existing voiceEnabled setting). */
  isVoiceEnabled: () => boolean;
  /** Whether Krix is currently speaking (never interrupt playback). */
  isSpeaking: () => boolean;
  /** Step 1 watchdog server reachability (generation needs the server). */
  serverAvailable: () => boolean;
  /**
   * Generate via the existing intelligence pipeline. Implementations must
   * honor the AbortSignal (cancellation must abort in-flight requests).
   */
  generate: (ctx: { inactivityMinutes: number; signal: AbortSignal }) => Promise<{ silent: boolean; message?: ProactiveMessage }>;
  /**
   * Deliver through the Step 2 voice pipeline + conversation history.
   * Called ONLY after the final eligibility recheck passes.
   */
  deliver: (message: ProactiveMessage, ctx: { inactivityMinutes: number }) => void;
  now?: () => number;
  scheduleFn?: (fn: () => void, delayMs: number) => () => void;
}

type Unsubscribe = () => void;

/** Is `hour` (0–23) inside the quiet window (overnight windows supported)? */
export function isQuietHour(hour: number, start: number, end: number): boolean {
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return false;
  const s = Math.max(0, Math.min(23, Math.floor(start)));
  const e = Math.max(0, Math.min(23, Math.floor(end)));
  if (s === e) return false;
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

export class ProactiveConversationService {
  private deps: ProactiveDeps;
  private nowFn: () => number;
  private scheduleFn: (fn: () => void, delayMs: number) => () => void;

  private phase: ProactivePhase = 'monitoring';
  private currentPeriodStartedAt = 0;
  private periodConsumed = true;
  private lastProactiveAt = 0;
  private generationAttempts = 0;
  private silentDecisions = 0;
  private cancellations = 0;
  private cancelTimer: (() => void) | null = null;
  private timerPending = false;
  private abortController: AbortController | null = null;
  private detachTracker: Unsubscribe | null = null;

  constructor(deps: ProactiveDeps) {
    this.deps = deps;
    this.nowFn = deps.now ?? (() => Date.now());
    this.scheduleFn = deps.scheduleFn ?? ((fn, delayMs) => {
      const id = setTimeout(fn, delayMs);
      return () => clearTimeout(id);
    });
  }

  /** Attach to the tracker's transitions (the ONLY event feed — no polling). */
  attach(): void {
    if (this.detachTracker) return;
    this.detachTracker = this.deps.tracker.subscribe((t: InactivityTransition) => this.onTrackerTransition(t));
  }

  detach(): void {
    this.detachTracker?.();
    this.detachTracker = null;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.timerPending = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  /** Watchdog events (App forwards): stale/drop semantics after wake or loss. */
  notifyWatchdogEvent(event: RuntimeWatchdogEvent): void {
    if (event.kind === 'system_resumed') {
      // Anything generated before the sleep is stale — drop it, consume the
      // period. Step 3 already excluded sleep from the inactivity duration,
      // so eligibility after wake is computed from honest time only.
      this.cancelPending('suspended');
      this.periodConsumed = true;
    } else if (event.kind === 'server_lost') {
      // Generation/delivery needs the server — cancel and consume the period.
      this.cancelPending('server_lost');
      this.periodConsumed = true;
    }
  }

  /** Immediate stop: abort generation/delivery AND stop current speech. */
  stopNow(): void {
    this.cancelPending('stopped');
    this.periodConsumed = true;
  }

  /** Settings changed (e.g. user disabled) — re-evaluate immediately. */
  onSettingsChanged(): void {
    const s = this.deps.getSettings();
    if (!s.enabled || !this.deps.isVoiceEnabled()) {
      this.cancelPending('disabled');
      this.periodConsumed = true;
    }
  }

  getDiagnostics(): ProactiveDiagnostics {
    return {
      phase: this.phase,
      enabled: this.deps.getSettings().enabled && this.deps.isVoiceEnabled(),
      currentPeriodStartedAt: this.currentPeriodStartedAt,
      periodConsumed: this.periodConsumed,
      lastProactiveAt: this.lastProactiveAt,
      generationAttempts: this.generationAttempts,
      silentDecisions: this.silentDecisions,
      cancellations: this.cancellations,
      pendingTimer: this.timerPending,
    };
  }

  // ------------------------------------------------------------- internals

  private onTrackerTransition(t: InactivityTransition): void {
    if (t.to === 'active_conversation') {
      // The user resumed interacting — anything pending is cancelled at once
      // (requirement §5: user speech/text/wake-word take priority). An active
      // conversation is NEVER interrupted.
      this.cancelPending('user_active');
      this.currentPeriodStartedAt = 0;
      this.periodConsumed = true;
      return;
    }
    if (t.to === 'conversational_inactivity') {
      // A new inactivity period opened: arm the single threshold timer for
      // the REMAINING time (the tracker's own window may already account for
      // part of the threshold — the total since last activity is what counts).
      this.currentPeriodStartedAt = t.at;
      this.periodConsumed = false;
      this.armThresholdTimer(Math.max(0, this.deps.getSettings().inactivityMinutes * 60_000 - t.inactivityMs));
      return;
    }
    // Failure/suspension/ended states: hold or drop, never generate.
    if (t.to === 'system_suspended' || t.to === 'conversation_ended_explicitly') {
      this.cancelPending(t.to);
      this.periodConsumed = true;
    }
    // Microphone/service failures: proactive speech does not depend on the
    // microphone (output only), so mic issues do NOT cancel — but the state
    // stays classified by Step 3 and eligibility is re-checked at delivery.
  }

  /** ONE timer per period, armed for the remaining time to the threshold. */
  private armThresholdTimer(remainingMs: number): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.timerPending = true;
    this.cancelTimer = this.scheduleFn(() => {
      this.cancelTimer = null;
      this.timerPending = false;
      void this.onThresholdReached();
    }, remainingMs);
  }

  private async onThresholdReached(): Promise<void> {
    if (!this.isEligible()) {
      // Not eligible at the threshold (quiet hours, interval, disabled,
      // server down, Krix speaking...): the period is consumed — no retries
      // in the same period, no repeated AI calls (requirement §7).
      this.periodConsumed = true;
      return;
    }
    const s = this.deps.getSettings();
    this.phase = 'generating';
    this.generationAttempts += 1;
    this.abortController = new AbortController();
    try {
      const result = await this.deps.generate({
        inactivityMinutes: s.inactivityMinutes,
        signal: this.abortController.signal,
      });
      if (this.abortController?.signal.aborted) return; // cancelled mid-flight
      this.abortController = null;
      if (result.silent || !result.message) {
        // The model decided there was nothing worthwhile — correct answer.
        this.silentDecisions += 1;
        this.periodConsumed = true;
        this.phase = 'monitoring';
        return;
      }
      this.phase = 'pending_delivery';
      // FINAL eligibility recheck immediately before audio playback (§5) —
      // covers settings changes, quiet-hours rollover, new activity, wake.
      if (!this.isEligible()) {
        this.cancelPending('ineligible_at_delivery');
        return;
      }
      this.lastProactiveAt = this.nowFn();
      this.periodConsumed = true; // one attempt per period — always
      this.phase = 'delivered';
      this.deps.deliver(result.message, { inactivityMinutes: s.inactivityMinutes });
      // Return to monitoring: the next period opens only on real activity.
      this.phase = 'monitoring';
    } catch {
      // Generation failure → silence (fail-safe), period consumed.
      this.abortController = null;
      this.periodConsumed = true;
      this.phase = 'monitoring';
    }
  }

  /** Full eligibility gate — used at generation AND re-checked at delivery. */
  private isEligible(): boolean {
    const s = this.deps.getSettings();
    if (!s.enabled) return false;
    if (!this.deps.isVoiceEnabled()) return false; // explicit mute/disabled voice
    if (this.periodConsumed) return false;
    if (this.deps.isSpeaking()) return false; // never interrupt playback
    if (!this.deps.serverAvailable()) return false;
    // Quiet hours (local time).
    const hour = new Date(this.nowFn()).getHours();
    if (s.quietHoursEnabled && isQuietHour(hour, s.quietStartHour, s.quietEndHour)) return false;
    // Minimum interval between proactive messages.
    if (this.lastProactiveAt > 0 && this.nowFn() - this.lastProactiveAt < s.minIntervalHours * 3600_000) return false;
    // Step 3 state must still be honest inactivity (not failures/suspension).
    const d = this.deps.tracker.getDiagnostics();
    if (d.state !== 'conversational_inactivity') return false;
    // Sustained = actually reached the configured threshold.
    if (d.inactivityMs < s.inactivityMinutes * 60_000) return false;
    return true;
  }

  private cancelPending(_reason: string): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.cancellations += 1;
    }
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.timerPending = false;
    if (this.phase === 'generating' || this.phase === 'pending_delivery') {
      this.cancellations += 1;
      this.phase = 'monitoring';
    }
  }
}

// ------------------------------------------------------------------ singleton

let singleton: ProactiveConversationService | null = null;

export function getProactiveConversationService(deps?: ProactiveDeps): ProactiveConversationService {
  if (!singleton) {
    if (!deps) throw new Error('ProactiveConversationService requires deps on first creation');
    singleton = new ProactiveConversationService(deps);
    singleton.attach();
  }
  return singleton;
}

export function resetProactiveConversationForTests(): void {
  singleton?.detach();
  singleton = null;
}
