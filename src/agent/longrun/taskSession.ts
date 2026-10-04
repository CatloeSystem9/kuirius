/**
 * Task session (Phase 19) — a deterministic lifecycle state machine wrapped
 * around one existing AgentCore task. All transitions are validated against
 * the transition table; invalid transitions are rejected (and audited by the
 * manager) instead of silently applied.
 */
import type { SessionCheckpoint, SessionState } from './sessionTypes';
import { canTransition, isTerminal } from './sessionTypes';

export class TaskSession {
  private state: SessionState;
  private reasons: string[] = [];
  private readonly createdAt: number;
  private updatedAt: number;

  constructor(
    readonly taskId: string,
    initial: SessionState,
    private now: () => number = Date.now,
    private onInvalidTransition?: (from: SessionState, to: SessionState) => void
  ) {
    this.state = initial;
    this.createdAt = now();
    this.updatedAt = this.createdAt;
  }

  get current(): SessionState {
    return this.state;
  }

  get startedAt(): number {
    return this.createdAt;
  }

  /** Last non-empty transition reasons (bounded). */
  reasonTrail(): string[] {
    return [...this.reasons];
  }

  /**
   * Attempt a transition. Returns false (and keeps the current state) when
   * the transition is invalid — callers must treat that as a safety signal,
   * never force it.
   */
  transitionTo(next: SessionState, reason?: string): boolean {
    if (isTerminal(this.state)) return false;
    if (!canTransition(this.state, next)) {
      this.onInvalidTransition?.(this.state, next);
      return false;
    }
    this.state = next;
    this.updatedAt = this.now();
    if (reason) {
      this.reasons.push(`${new Date(this.updatedAt).toISOString().slice(11, 19)} ${next}: ${reason.slice(0, 120)}`);
      if (this.reasons.length > 12) this.reasons.shift();
    }
    return true;
  }

  /** Apply a session's own state onto its checkpoint record. */
  applyTo(checkpoint: SessionCheckpoint): SessionCheckpoint {
    checkpoint.lifecycle = this.state;
    checkpoint.updatedAt = this.now();
    if (this.reasons.length > 0) {
      const last = this.reasons[this.reasons.length - 1];
      if (this.state === 'PAUSED') checkpoint.pauseReason = last;
      if (this.state === 'FAILED') checkpoint.failureReason = last;
      if (this.state === 'BLOCKED') checkpoint.blockReason = last;
    }
    return checkpoint;
  }
}
