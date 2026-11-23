/**
 * Live Conversation Continuity (Step 5) — conversational turn manager.
 *
 * Coordinates ONE coherent conversation flow (listening → processing →
 * speaking → listening/idle) on top of the existing surfaces — nothing here
 * replaces them:
 *   - Step 1 watchdog: suspension/server truth (stale turns are marked, never
 *     replayed).
 *   - Step 2 voice pipeline: playback + its session discipline; this manager
 *     only OBSERVES playback start/end through the existing activity listener
 *     and never drives a second playback path.
 *   - Step 3 tracker: the SOLE inactivity source; its `active_conversation`
 *     window IS the live-continuity window — consecutive voice turns need no
 *     wake word while the conversation is still active.
 *   - Step 4 proactive service: unaffected structurally — a live conversation
 *     keeps the tracker in active_conversation, which the proactive service
 *     already treats as ineligible; this manager additionally consumes the
 *     activity that produces that state.
 *
 * Content discipline: turns are tracked by id, phase, timestamps and outcome
 * only — never transcripts or message content. No polling: every state change
 * is pushed by an existing event source.
 */

export type TurnPhase = 'idle' | 'listening' | 'processing' | 'speaking';
export type TurnOutcome = 'completed' | 'interrupted' | 'failed' | 'stale';
export type TurnSource = 'text' | 'wake_word' | 'voice_followup' | 'transcribed';

export interface TurnRecord {
  id: number;
  phase: TurnPhase;
  source: TurnSource;
  startedAt: number;
  /** Epoch ms the reply's speech started (0 = not yet). */
  speechStartedAt: number;
  /** Epoch ms the turn reached a terminal outcome (0 = ongoing). */
  endedAt: number;
  outcome: TurnOutcome | 'ongoing';
}

export interface TurnManagerDiagnostics {
  phase: TurnPhase;
  currentTurnId: number;
  liveContinuity: boolean;
  /** Turns kept for bounded observability (content-free). */
  recentTurns: Array<{ id: number; source: TurnSource; outcome: TurnOutcome | 'ongoing'; durationMs: number }>;
  interruptions: number;
  staleTurns: number;
  failedTurns: number;
}

type Unsubscribe = () => void;

/** Grace period after Krix stops speaking before live follow-ups are accepted
 *  (echo-tail / speaker bleed guard — bounded, no timers kept open). */
export const LIVE_FOLLOWUP_GRACE_MS = 900;
/** Minimum meaningful length for a live follow-up utterance (noise guard). */
export const LIVE_FOLLOWUP_MIN_CHARS = 2;

export interface ConversationTurnManagerOptions {
  now?: () => number;
  /** Called when the manager wants playback stopped (interruption). The App
   *  wires this to the EXISTING stopKrishaSpeech() — no second playback path. */
  stopPlayback?: () => void;
}

export class ConversationTurnManager {
  private nowFn: () => number;
  private stopPlayback: () => void;

  private turnCounter = 0;
  private current: TurnRecord | null = null;
  private history: TurnRecord[] = [];
  /** The turn whose playback is live (stale-end guard for superseded turns). */
  private speechTurnId: number | null = null;
  private liveContinuity = false;
  private speechEndedAt = 0;
  private interruptions = 0;
  private staleTurns = 0;
  private failedTurns = 0;
  private listeners = new Set<(phase: TurnPhase) => void>();

  constructor(options: ConversationTurnManagerOptions = {}) {
    this.nowFn = options.now ?? (() => Date.now());
    this.stopPlayback = options.stopPlayback ?? (() => undefined);
  }

  subscribe(listener: (phase: TurnPhase) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------ turn lifecycle

  /**
   * A user turn begins. `source` distinguishes the real input pathway; the
   * returned turn id is the stale-guard token for every later callback.
   * Duplicate submissions are refused while a turn is in processing; an
   * ongoing LISTENING turn (wake word heard, message being submitted) is
   * ADOPTED rather than duplicated.
   */
  beginTurn(source: TurnSource): number | null {
    if (this.current && this.current.outcome === 'ongoing') {
      if (this.current.phase === 'processing') {
        // A response is already in flight — refuse (no duplicate submission).
        return null;
      }
      if (this.current.phase === 'listening') {
        // Adopt the listening turn (wake word → its command submission).
        this.current.phase = 'processing';
        this.emit();
        return this.current.id;
      }
      if (this.current.phase === 'speaking') {
        // The user moved on while Krix was speaking (e.g. typed a new message
        // without barging in). The old turn is superseded — playback may
        // continue, and its later end event is discarded as stale.
        this.endCurrent('interrupted');
        this.interruptions += 1;
        this.speechTurnId = null;
      }
    }
    this.turnCounter += 1;
    this.current = {
      id: this.turnCounter,
      phase: source === 'text' ? 'processing' : 'listening',
      source,
      startedAt: this.nowFn(),
      speechStartedAt: 0,
      endedAt: 0,
      outcome: 'ongoing',
    };
    this.emit();
    return this.current.id;
  }

  /** The message was submitted; the reply is being generated. */
  beginProcessing(turnId: number): boolean {
    if (!this.isCurrent(turnId) || !this.current) return false;
    if (this.current.phase === 'processing') return false; // idempotent
    this.current.phase = 'processing';
    this.emit();
    return true;
  }

  /** Krix's reply playback started (existing voice-output signal). */
  beginSpeaking(turnId: number): boolean {
    if (!this.isCurrent(turnId) || !this.current) return false;
    this.current.phase = 'speaking';
    this.current.speechStartedAt = this.nowFn();
    this.emit();
    return true;
  }

  /** Convenience for the shared voice-output listener (no turn id available). */
  notifySpeechStarted(): void {
    if (this.current && this.current.outcome === 'ongoing' && (this.current.phase === 'processing' || this.current.phase === 'listening')) {
      this.beginSpeaking(this.current.id);
      this.speechTurnId = this.current.id;
    }
  }

  /**
   * Convenience for the shared voice-output listener. End events for
   * superseded turns are discarded (stale-callback protection).
   */
  notifySpeechEnded(interrupted = false): void {
    if (this.speechTurnId !== null && this.isCurrent(this.speechTurnId)) {
      this.endSpeaking(this.speechTurnId, interrupted);
    }
    this.speechTurnId = null;
  }

  /** Krix finished speaking: the turn completes and live continuity opens. */
  endSpeaking(turnId: number, interrupted = false): boolean {
    if (!this.isCurrent(turnId) || !this.current) return false;
    const source = this.current.source;
    this.endCurrent(interrupted ? 'interrupted' : 'completed');
    this.speechEndedAt = this.nowFn();
    // Voice-driven exchanges stay in conversation: while Step 3 still reports
    // an active conversation, listening continues without a wake word.
    if (!interrupted && (source === 'wake_word' || source === 'voice_followup' || source === 'transcribed')) {
      this.liveContinuity = true;
    }
    return true;
  }

  /** Close the turn explicitly (fetch failure, empty input, etc.). */
  failTurn(turnId: number): void {
    if (!this.isCurrent(turnId) || !this.current) return;
    this.endCurrent('failed');
    this.current = null;
    this.emit();
  }

  // ------------------------------------------------------------- interruption

  /**
   * The user's input pathway requests barge-in during Krix's playback.
   * Returns the interrupted turn id (the caller stops playback via the
   * existing pipeline) or null when there is nothing to interrupt. Noise
   * NEVER reaches this method — callers gate on real input signals.
   */
  requestBargeIn(): number | null {
    if (this.current && this.current.phase === 'speaking' && this.current.outcome === 'ongoing') {
      const turnId = this.current.id;
      this.endCurrent('interrupted');
      this.interruptions += 1;
      this.speechTurnId = null;
      this.stopPlayback(); // existing pipeline stop — the cancelled response
      // is already in history as a real (partially spoken) reply; the next
      // turn continues the same conversation context.
      this.current = null;
      this.emit();
      return turnId;
    }
    return null;
  }

  // ----------------------------------------------------- live continuity window

  /** Voice exchanges open the no-wake-word continuity window. */
  setLiveContinuity(active: boolean): void {
    if (this.liveContinuity === active) return;
    this.liveContinuity = active;
    this.emit();
  }

  /** Whether a live follow-up may be accepted right now. */
  canAcceptLiveFollowUp(text: string): boolean {
    if (!this.liveContinuity) return false;
    if (this.current && this.current.outcome === 'ongoing') return false; // mid-turn
    if (!text || text.trim().length < LIVE_FOLLOWUP_MIN_CHARS) return false; // noise
    if (this.nowFn() - this.speechEndedAt < LIVE_FOLLOWUP_GRACE_MS) return false; // echo tail
    return true;
  }

  // ----------------------------------------------------------------- lifecycle

  /** Step 1 watchdog: server loss / suspension mark in-flight work stale. */
  notifyWatchdogEvent(event: { kind: string; suspendedForMs?: number }): void {
    if (event.kind === 'server_lost' || event.kind === 'system_resumed') {
      if (this.current && this.current.outcome === 'ongoing' && this.current.phase === 'processing') {
        this.endCurrent('stale');
        this.current = null;
        this.emit();
      }
      // 'speaking' turns are ended by the real playback end (Step 2 session
      // events) — sleep freezes audio, the end event never fires, so the
      // suspended speaking turn is closed here as stale too.
      if (event.kind === 'system_resumed' && this.current && this.current.outcome === 'ongoing' && this.current.phase === 'speaking') {
        this.endCurrent('stale');
        this.current = null;
        this.emit();
      }
    }
  }

  /** Explicit stop: everything in flight is cancelled (never "completed"). */
  stopAll(): void {
    if (this.current && this.current.outcome === 'ongoing') {
      this.endCurrent('interrupted');
      this.current = null;
      this.emit();
    }
    this.liveContinuity = false;
  }

  getPhase(): TurnPhase {
    if (this.current && this.current.outcome === 'ongoing') return this.current.phase;
    return this.liveContinuity ? 'listening' : 'idle';
  }

  getDiagnostics(): TurnManagerDiagnostics {
    const now = this.nowFn();
    return {
      phase: this.getPhase(),
      currentTurnId: this.current?.id ?? 0,
      liveContinuity: this.liveContinuity,
      recentTurns: this.history.slice(-32).map((t) => ({
        id: t.id,
        source: t.source,
        outcome: t.outcome,
        durationMs: (t.endedAt || now) - t.startedAt,
      })),
      interruptions: this.interruptions,
      staleTurns: this.staleTurns,
      failedTurns: this.failedTurns,
    };
  }

  dispose(): void {
    this.listeners.clear();
    this.history = [];
    this.current = null;
  }

  // ------------------------------------------------------------------ internals

  private isCurrent(turnId: number): boolean {
    return !!this.current && this.current.id === turnId && this.current.outcome === 'ongoing';
  }

  private endCurrent(outcome: TurnOutcome): void {
    if (!this.current) return;
    if (this.speechTurnId === this.current.id) this.speechTurnId = null;
    this.current.outcome = outcome;
    this.current.endedAt = this.nowFn();
    this.history.push(this.current);
    if (this.history.length > 64) this.history.shift();
    if (outcome === 'stale') this.staleTurns += 1;
    if (outcome === 'failed') this.failedTurns += 1;
    this.current = null;
    this.emit();
  }

  private emit(): void {
    const phase = this.getPhase();
    for (const listener of [...this.listeners]) {
      try {
        listener(phase);
      } catch {
        // a broken subscriber never breaks the turn flow
      }
    }
  }
}

// ------------------------------------------------------------------ singleton

let singleton: ConversationTurnManager | null = null;

export function getConversationTurnManager(options?: ConversationTurnManagerOptions): ConversationTurnManager {
  if (!singleton) {
    singleton = new ConversationTurnManager(options);
  }
  return singleton;
}

export function resetConversationTurnManagerForTests(): void {
  singleton?.dispose();
  singleton = null;
}
