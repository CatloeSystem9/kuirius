/**
 * Conversational Silence Detection (Step 3) — inactivity tracker.
 *
 * Maintains an accurate, content-free conversational-inactivity state for the
 * voice session established by Step 1 (background runtime) and Step 2
 * (background voice output). This layer DETECTS only — it never speaks,
 * never initiates conversations, and never stores transcripts or audio
 * (nothing content-bearing passes through here; timestamps and kinds only).
 *
 * State model (requirement §2 — failures are never ordinary silence):
 *   active_conversation         — meaningful exchange within the active window
 *   conversational_inactivity   — no meaningful activity beyond the window
 *   microphone_unavailable      — capture device missing/disconnected/zero-level
 *   microphone_permission_denied— OS/browser permission denied (mute when detectable)
 *   audio_service_unavailable   — recognition/transcription service unavailable
 *   system_suspended            — application frozen / system asleep (excluded
 *                                 from inactivity duration on resume)
 *   conversation_ended_explicitly — the user explicitly ended the conversation
 *
 * Meaningful activity (resets the clock) is deliberately narrow so background
 * noise cannot reset it: matched wake-word detections, sent voice commands,
 * sent transcribed speech, sent text messages, and Krix's own replies. Raw
 * interim transcripts from ambient audio are NOT meaningful activity.
 *
 * Timer discipline (requirement §4): ONE setTimeout chain, scheduled only
 * while the state is active_conversation, firing once at the exact moment the
 * active window expires. Silence schedules nothing. Duration is computed
 * lazily from timestamps on every read, so hidden-tab timer throttling can
 * delay a transition event but can never corrupt the measured duration.
 */
import type { RuntimeWatchdogEvent } from './runtimeWatchdog';

export type InactivityState =
  | 'active_conversation'
  | 'conversational_inactivity'
  | 'microphone_unavailable'
  | 'microphone_permission_denied'
  | 'audio_service_unavailable'
  | 'system_suspended'
  | 'conversation_ended_explicitly';

export type MicIssueKind =
  | 'microphone_unavailable'
  | 'microphone_permission_denied'
  | 'audio_service_unavailable';

export type VoiceActivitySource =
  | 'wake_word'
  | 'voice_command'
  | 'transcribed_speech'
  | 'text_message'
  | 'krix_reply';

export interface InactivityDiagnostics {
  state: InactivityState;
  /** ms since the last meaningful conversational activity, EXCLUDING system-suspension time. */
  inactivityMs: number;
  /** Epoch ms of the last meaningful activity (0 = none this session). */
  lastActivityAt: number;
  /** Total suspension time excluded from inactivityMs (honest accounting). */
  suspensionCompensationMs: number;
  /** Current detectable microphone/service issue, if any. */
  micIssue: MicIssueKind | null;
  micIssueAt: number;
  /** Window within which an exchange still counts as one conversation. */
  activeConversationWindowMs: number;
  /** True while exactly one transition timer is pending (0 or 1 — no duplicates). */
  pendingTransitionTimer: boolean;
  /** Number of state transitions since start (bounded observability). */
  transitionCount: number;
  /** Epoch ms the tracker started. */
  startedAt: number;
}

export interface InactivityTransition {
  from: InactivityState;
  to: InactivityState;
  at: number;
  inactivityMs: number;
}

/** Default: exchanges closer together than this are one conversation. */
const DEFAULT_ACTIVE_WINDOW_MS = 90_000;
/** Zero-level frames before a recording counts as muted (@rAF ≈ 60fps → 2.5 s). */
export const MUTE_ZERO_LEVEL_FRAMES = 150;

export interface ConversationInactivityOptions {
  /** Active-conversation window (default 90 s). */
  activeWindowMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable scheduler (tests) — returns a cancel function. */
  scheduleFn?: (fn: () => void, delayMs: number) => () => void;
}

type Unsubscribe = () => void;

export class ConversationInactivityTracker {
  private activeWindowMs: number;
  private nowFn: () => number;
  private scheduleFn: (fn: () => void, delayMs: number) => () => void;

  private lastActivityAt = 0;
  private suspensionCompensationMs = 0;
  private suspended = false;
  private suspensionStartedAt = 0;
  private explicitEndAt = 0;
  private micIssue: MicIssueKind | null = null;
  private micIssueAt = 0;

  private cancelTimer: (() => void) | null = null;
  private timerPending = false;
  private listeners = new Set<(t: InactivityTransition) => void>();
  private transitionCount = 0;
  private lastReportedState: InactivityState;
  private readonly startedAt: number;

  constructor(options: ConversationInactivityOptions = {}) {
    this.activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
    this.nowFn = options.now ?? (() => Date.now());
    this.scheduleFn = options.scheduleFn ?? ((fn, delayMs) => {
      const id = setTimeout(fn, delayMs);
      return () => clearTimeout(id);
    });
    this.startedAt = this.nowFn();
    this.lastReportedState = this.classify();
    this.attachDocumentSignals();
  }

  // ------------------------------------------------------------- activity

  /**
   * Record meaningful conversational activity. Raw/interim transcripts and
   * ambient noise must NOT be passed here — only events that represent a
   * real exchange (matched wake word, sent command/message, Krix's reply).
   */
  notifyActivity(source: VoiceActivitySource): void {
    const now = this.nowFn();
    this.lastActivityAt = now;
    this.explicitEndAt = 0;
    // A successful voice exchange proves the microphone path works.
    if (source !== 'text_message' || this.micIssue === 'audio_service_unavailable') {
      this.micIssue = null;
      this.micIssueAt = 0;
    }
    if (this.suspended) {
      // Activity while suspended cannot happen; treat as a wake race — clear.
      this.suspended = false;
    }
    this.reclassifyAndSchedule();
  }

  // ------------------------------------------------------- mic/service issues

  /** Report a detectable microphone or audio-service failure (never silence). */
  reportMicIssue(kind: MicIssueKind): void {
    const now = this.nowFn();
    this.micIssue = kind;
    this.micIssueAt = now;
    this.reclassify();
  }

  /** The microphone/service recovered (listening resumed, capture succeeded). */
  resolveMicIssue(): void {
    if (!this.micIssue) return;
    this.micIssue = null;
    this.micIssueAt = 0;
    this.reclassifyAndSchedule();
  }

  // ------------------------------------------------------------- suspension

  /** Page Lifecycle 'freeze' / detected suspension start. */
  markSuspensionStart(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.suspensionStartedAt = this.nowFn();
    this.reclassify();
  }

  /**
   * Suspension ended (watchdog resume / Page Lifecycle 'resume'). The sleep
   * duration is EXCLUDED from conversational inactivity — a laptop that slept
   * for 8 hours did not have an 8-hour silent conversation.
   */
  markSuspensionEnd(suspendedForMs?: number): void {
    if (!this.suspended) return;
    this.suspended = false;
    const gap = typeof suspendedForMs === 'number' && suspendedForMs > 0
      ? suspendedForMs
      : Math.max(0, this.nowFn() - this.suspensionStartedAt);
    // Compensate: shift the last-activity anchor forward by the sleep time.
    if (this.lastActivityAt > 0) {
      this.lastActivityAt += gap;
      const now = this.nowFn();
      if (this.lastActivityAt > now) this.lastActivityAt = now;
    }
    this.suspensionCompensationMs += gap;
    this.reclassifyAndSchedule();
  }

  // --------------------------------------------------------- explicit end

  /** The user explicitly ended the conversation (new-conversation action). */
  markConversationEnded(): void {
    this.explicitEndAt = this.nowFn();
    this.reclassify();
  }

  // ------------------------------------------------------------ subscription

  subscribe(listener: (t: InactivityTransition) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Content-free diagnostics (no transcripts, no audio, no user content). */
  getDiagnostics(): InactivityDiagnostics {
    return {
      state: this.classify(),
      inactivityMs: this.inactivityMs(),
      lastActivityAt: this.lastActivityAt,
      suspensionCompensationMs: this.suspensionCompensationMs,
      micIssue: this.micIssue,
      micIssueAt: this.micIssueAt,
      activeConversationWindowMs: this.activeWindowMs,
      pendingTransitionTimer: this.timerPending,
      transitionCount: this.transitionCount,
      startedAt: this.startedAt,
    };
  }

  /** Re-evaluate immediately (e.g. on return to the visible tab). */
  refresh(): void {
    this.reclassify();
  }

  dispose(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.timerPending = false;
    this.listeners.clear();
    this.detachDocumentSignals();
  }

  // -------------------------------------------------------------- internals

  private inactivityMs(): number {
    if (this.lastActivityAt === 0) {
      // No activity this session: count from tracker start (bounded, honest).
      return Math.max(0, this.nowFn() - this.startedAt);
    }
    return Math.max(0, this.nowFn() - this.lastActivityAt);
  }

  private classify(): InactivityState {
    if (this.suspended) return 'system_suspended';
    if (this.micIssue) return this.micIssue;
    if (this.explicitEndAt > 0 && this.explicitEndAt >= this.lastActivityAt) {
      return 'conversation_ended_explicitly';
    }
    return this.inactivityMs() < this.activeWindowMs
      ? 'active_conversation'
      : 'conversational_inactivity';
  }

  /** Recompute, emit on transition; schedule the single expiry timer when active. */
  private reclassifyAndSchedule(): void {
    this.reclassify();
    if (this.lastReportedState === 'active_conversation') {
      this.scheduleExpiryTimer();
    } else {
      this.cancelExpiryTimer();
    }
  }

  private reclassify(): void {
    const next = this.classify();
    if (next !== this.lastReportedState) {
      const transition: InactivityTransition = {
        from: this.lastReportedState,
        to: next,
        at: this.nowFn(),
        inactivityMs: this.inactivityMs(),
      };
      this.lastReportedState = next;
      this.transitionCount += 1;
      for (const listener of [...this.listeners]) {
        try {
          listener(transition);
        } catch {
          // a broken subscriber never breaks detection
        }
      }
    }
  }

  /** Exactly ONE pending timer, only while active_conversation. */
  private scheduleExpiryTimer(): void {
    this.cancelExpiryTimer();
    const elapsed = this.inactivityMs();
    const remaining = Math.max(0, this.activeWindowMs - elapsed);
    this.timerPending = true;
    this.cancelTimer = this.scheduleFn(() => {
      this.cancelTimer = null;
      this.timerPending = false;
      this.reclassify(); // fires the active → inactive transition exactly once
    }, remaining);
  }

  private cancelExpiryTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.timerPending = false;
  }

  // ------------------------------------------------------- document signals

  private detachDoc: Unsubscribe | null = null;
  private detachDoc2: Unsubscribe | null = null;

  private attachDocumentSignals(): void {
    if (typeof document === 'undefined') return;
    const onResume = () => this.markSuspensionEnd();
    document.addEventListener('resume', onResume);
    const onVisibility = () => {
      if (!document.hidden) this.refresh(); // re-evaluate on return to the tab
    };
    document.addEventListener('visibilitychange', onVisibility);
    this.detachDoc = () => document.removeEventListener('resume', onResume);
    this.detachDoc2 = () => document.removeEventListener('visibilitychange', onVisibility);
  }

  private detachDocumentSignals(): void {
    this.detachDoc?.();
    this.detachDoc2?.();
    this.detachDoc = null;
    this.detachDoc2 = null;
  }
}

// ------------------------------------------------------------------ watchdog bridge

/**
 * Map watchdog events onto the tracker (App wires this one-liner):
 * suspension detection is the watchdog's job (Step 1) — the tracker only
 * consumes its honest resume signal; server loss is NOT silence and never
 * touches the inactivity clock.
 */
export function applyWatchdogEventToInactivity(tracker: ConversationInactivityTracker, event: RuntimeWatchdogEvent): void {
  if (event.kind === 'system_resumed') {
    tracker.markSuspensionEnd(event.suspendedForMs);
  }
  // 'server_lost' / 'server_restored' / network events deliberately ignored:
  // an unreachable server says nothing about conversational inactivity.
}

// ------------------------------------------------------------------ singleton

let singleton: ConversationInactivityTracker | null = null;

/** Browser singleton (lazy). Tests construct their own instances. */
export function getConversationInactivityTracker(): ConversationInactivityTracker {
  if (!singleton) {
    singleton = new ConversationInactivityTracker();
  }
  return singleton;
}

/** Test hook: reset the singleton. */
export function resetConversationInactivityForTests(): void {
  singleton?.dispose();
  singleton = null;
}
