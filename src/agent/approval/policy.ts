/**
 * Approval Policy — when to ask, when to act alone.
 *
 * The rule the operator asked for, stated plainly:
 *
 *   ONLINE  (the operator is here)  ->  ASK. Always. Never decide alone.
 *   OFFLINE (the operator is away)  ->  ACT ALONE, but only for action types
 *                                       the confidence gate has proven safe.
 *                                       Anything else still asks (by toast).
 *
 * "Online" means a live client is present — the Krisha window is open and
 * reporting presence. "Offline" means no presence heartbeat has arrived
 * within the presence window, which covers the closed-window, fullscreen-app
 * and away-from-the-machine cases that make browser-only prompts useless.
 *
 * The policy never grants permissions. It only decides whether a decision
 * needs a human, and it can only ever make a decision MORE conservative than
 * the confidence gate allows.
 */
import type { ApprovalActionType, ApprovalPolicy } from './approvalTypes';
import { DEFAULT_APPROVAL_POLICY, isAutoApprovable } from './approvalTypes';

export type PolicyOutcome = 'ask' | 'auto_approve' | 'auto_deny';

export interface PolicyDecision {
  outcome: PolicyOutcome;
  /** Honest explanation — shown in the activity feed and the audit chain. */
  reason: string;
}

export interface PolicyInput {
  actionType: ApprovalActionType;
  /** Is the operator present right now? */
  operatorPresent: boolean;
  /** The confidence gate's verdict for this action type. */
  trust: { trusted: boolean; score: number; samples: number; reason: string };
}

export interface ApprovalPolicyOptions {
  getPolicy?: () => ApprovalPolicy;
  now?: () => number;
}

/**
 * How long a presence heartbeat stays valid.
 *
 * 90 seconds: long enough that a briefly-busy client is still "present",
 * short enough that a closed laptop stops counting as online quickly.
 */
export const PRESENCE_WINDOW_MS = 90_000;

/** Tracks whether the operator is reachable right now. */
export class PresenceTracker {
  private lastSeenAt = 0;
  private readonly nowFn: () => number;
  private readonly windowMs: number;

  constructor(options: { now?: () => number; windowMs?: number } = {}) {
    this.nowFn = options.now || (() => Date.now());
    this.windowMs = options.windowMs ?? PRESENCE_WINDOW_MS;
  }

  /** The operator's client reported in. */
  public markPresent(at?: number): void {
    this.lastSeenAt = at ?? this.nowFn();
  }

  /** The operator's client went away (window closed, unload). */
  public markAbsent(): void {
    this.lastSeenAt = 0;
  }

  /** Is the operator considered present right now? */
  public isPresent(): boolean {
    if (this.lastSeenAt <= 0) return false;
    return this.nowFn() - this.lastSeenAt < this.windowMs;
  }

  /** Epoch ms of the last heartbeat (0 = never). */
  public lastSeen(): number {
    return this.lastSeenAt;
  }
}

/**
 * Decide whether an approval request needs a human.
 */
export function evaluatePolicy(input: PolicyInput, policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY): PolicyDecision {
  const { actionType, operatorPresent, trust } = input;

  // The hard boundary first: some action types are NEVER decided alone,
  // whatever the trust score says.
  if (!isAutoApprovable(actionType)) {
    return {
      outcome: 'ask',
      reason: `${actionType} always requires the operator`,
    };
  }

  if (policy.mode === 'always_ask' || policy.mode === 'never_auto') {
    return { outcome: 'ask', reason: 'policy is set to always ask' };
  }

  // ONLINE -> ASK. Even a trusted action type waits for the operator when
  // they are right there; there is no reason to act alone when they could
  // simply be asked.
  if (operatorPresent) {
    if (policy.askWhenPresent) {
      return { outcome: 'ask', reason: 'the operator is present — asking them' };
    }
  } else if (!policy.autoWhenAway) {
    return { outcome: 'ask', reason: 'the operator is away but auto-decide is off' };
  }

  // OFFLINE -> act alone only for proven-safe action types.
  if (!trust.trusted) {
    return {
      outcome: 'ask',
      reason: `the operator is away and ${actionType} is not trusted yet (${trust.reason})`,
    };
  }

  return {
    outcome: 'auto_approve',
    reason: `the operator is away and ${actionType} is trusted (${trust.reason})`,
  };
}
