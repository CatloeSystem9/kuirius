/**
 * Adaptive observation policy engine (Phase 13, spec §2).
 *
 * Deterministic, allocation-free mapping from cheap local context to the
 * operating mode + reuse window. No timers, no model calls, no polling.
 */
import type {
  ObservationMode,
  ObservationPolicy,
  ObservationPriority,
} from './observationTypes';
import { PRIORITY_RANK } from './observationTypes';

/** Mode-specific reuse windows (ms). Idle ≈ no observation at all. */
export const MODE_MAX_AGE_MS: Record<ObservationMode, number> = {
  idle: 60_000,
  active_task: 1_500,
  after_action: 1_000,
  uncertain: 800,
  rapid_change: 400,
  settled: 3_000,
};

export const DEFAULT_IDLE_DELAY_MS = 2_000;

export interface PolicyContext {
  taskActive: boolean;
  /** Consecutive meaningful screen changes (rapidly changing UI detector). */
  changeStreak: number;
  /** Consecutive quiet checks (stable UI detector). */
  quietStreak: number;
  verificationStatus: 'passed' | 'failed' | 'inconclusive' | 'none';
  lastActionKind: 'mouse' | 'keyboard' | 'browser' | 'app' | 'fs' | 'none';
  /** A meaningful action just completed (post-action verification window). */
  justActed: boolean;
}

/** Rapid-change detector: N consecutive meaningful changes. */
const RAPID_CHANGE_STREAK = 3;
/** Stable-UI detector: N consecutive quiet checks. */
const SETTLED_STREAK = 3;

/**
 * Resolve the observation policy for the current context. Pure function —
 * identical inputs always produce an identical policy (spec §15).
 */
export function resolvePolicy(context: PolicyContext): ObservationPolicy {
  let mode: ObservationMode;
  let reason: string;

  if (!context.taskActive) {
    mode = 'idle';
    reason = 'no active task: observation stays dormant';
  } else if (context.verificationStatus === 'inconclusive') {
    mode = 'uncertain';
    reason = 'verification inconclusive: observe sooner';
  } else if (context.changeStreak >= RAPID_CHANGE_STREAK) {
    mode = 'rapid_change';
    reason = `rapidly changing UI (${context.changeStreak} consecutive changes): temporarily tighter observation`;
  } else if (context.justActed) {
    mode = 'after_action';
    reason = 'meaningful action just completed: verify the result';
  } else if (context.quietStreak >= SETTLED_STREAK) {
    mode = 'settled';
    reason = `stable UI (${context.quietStreak} quiet checks): loosen observation`;
  } else {
    mode = 'active_task';
    reason = 'active task: observe when the current step requires it';
  }

  return {
    mode,
    maxAgeMs: MODE_MAX_AGE_MS[mode],
    idleDelayMs: DEFAULT_IDLE_DELAY_MS,
    idleMinPriority: 'HIGH',
  };
}

/** True when the priority clears the bar for interrupting idle mode. */
export function priorityClearsIdle(priority: ObservationPriority, policy: ObservationPolicy): boolean {
  return PRIORITY_RANK[priority] >= PRIORITY_RANK[policy.idleMinPriority];
}

/** Staleness of a cached observation under the given policy. */
export function isStale(lastObservation: { timestamp: number } | null | undefined, now: number, policy: ObservationPolicy): boolean {
  if (!lastObservation) return true;
  return now - lastObservation.timestamp > policy.maxAgeMs;
}
