/**
 * Observation decision engine (Phase 13, spec §9) — deterministic, cheap.
 *
 * Pure function: the same input always yields the same decision. Rules are
 * ordered so safety always wins: workflow freshness requirements and
 * recovery outrank budgets savings, and budgets always outrank convenience.
 * No model calls, no timers.
 */
import type {
  ObservationChangeKind,
  ObservationDecision,
  ObservationDecisionInput,
  ObservationRegion,
} from './observationTypes';
import { priorityClearsIdle } from './observationPolicy';

/**
 * Classify a signature-change fraction into the spec §5 change kinds.
 * Thresholds chosen so small UI jitter (cursor blink, clock) stays 'minor'.
 */
export function classifyChange(changedFraction: number | undefined): ObservationChangeKind {
  if (changedFraction === undefined || Number.isNaN(changedFraction)) return 'unknown';
  if (changedFraction <= 0) return 'none';
  if (changedFraction < 0.02) return 'minor';
  if (changedFraction < 0.25) return 'relevant';
  return 'major';
}

/** Suggest a region preset from cheap context (spec §6). Heuristic only. */
export function suggestRegion(input: ObservationDecisionInput): ObservationRegion {
  if (input.verification?.status === 'failed') return 'verification_region';
  if (input.trigger === 'browser_navigation') return 'browser_content';
  if (input.trigger === 'after_mouse_action') return 'target_control';
  if (input.trigger === 'app_focus_changed' || input.trigger === 'app_state_changed') return 'active_application';
  return 'full_screen';
}

/** Filesystem-type steps are verified by the filesystem, not the screen. */
function isFilesystemStep(toolName?: string): boolean {
  return typeof toolName === 'string' && /^fs\.|system\.|^filesystem\./.test(toolName);
}

/**
 * The decision engine. Ordered rules:
 *  1. learned-workflow freshness + recovery + failed verification → observe
 *  2. exhausted budgets → stop/delay (structured, never loops)
 *  3. idle gate: no task + low priority → stop (never observe while idle)
 *  4. explicit requests / no prior observation / stale cache → observe
 *  5. change-awareness: major/relevant → observe, none → reuse, minor → delay
 *  6. task-awareness: filesystem steps prefer filesystem verification
 *  7. post-action → observe after action
 */
export function decide(input: ObservationDecisionInput): ObservationDecision {
  const region = suggestRegion(input);
  const policy = input.policy;

  // --- 1. freshness obligations (safety first) -----------------------------
  if (input.workflow?.reused && input.workflow.requireFresh) {
    return {
      action: 'OBSERVE_NOW',
      reason: 'learned workflow requires a fresh observation for this step',
      region,
      priority: input.priority,
    };
  }
  if (input.recovery?.active) {
    return {
      action: 'OBSERVE_NOW',
      reason: 'recovery in progress: the screen must be re-observed, stale state is unsafe',
      region,
      priority: input.priority === 'LOW' ? 'HIGH' : input.priority,
    };
  }
  if (input.trigger === 'verification_failed' || input.trigger === 'target_not_found') {
    return {
      action: 'OBSERVE_NOW',
      reason: `trigger "${input.trigger}": current understanding may be wrong`,
      region,
      priority: input.priority,
    };
  }
  if (input.verification?.status === 'failed') {
    return {
      action: 'OBSERVE_NOW',
      reason: 'verification failed: re-observe before acting again',
      region,
      priority: input.priority,
    };
  }

  // --- 2. budget gates ------------------------------------------------------
  if (!input.budget.allowed) {
    if (input.budget.reason === 'window_limit' && (input.budget.retryAfterMs ?? 0) <= 1_500) {
      return {
        action: 'DELAY_OBSERVATION',
        reason: `rate window exhausted: retrying in ${input.budget.retryAfterMs}ms`,
        region,
        priority: input.priority,
        delayMs: input.budget.retryAfterMs,
      };
    }
    return {
      action: 'STOP_OBSERVATION',
      reason: `observation budget exhausted (${input.budget.reason}): reducing frequency, no uncontrolled loop`,
      region,
      priority: input.priority,
    };
  }

  // --- 3. idle gate: no unnecessary screenshots when nothing needs vision ----
  if (!input.task?.active && !(input.trigger === 'explicit_request' && priorityClearsIdle(input.priority, policy))) {
    return {
      action: 'STOP_OBSERVATION',
      reason: 'idle: no task requires visual information',
      region,
      priority: input.priority,
    };
  }

  // --- 4. explicit requests / no / stale prior observation -------------------
  if (input.trigger === 'explicit_request' || input.requireFreshFlag === true) {
    return {
      action: 'OBSERVE_NOW',
      reason: 'explicit request: always capture fresh',
      region,
      priority: input.priority,
    };
  }
  if (!input.lastObservation) {
    return {
      action: 'OBSERVE_NOW',
      reason: 'no observation yet: the screen is unknown',
      region,
      priority: input.priority,
    };
  }
  const age = input.now - input.lastObservation.timestamp;
  const stale = age > policy.maxAgeMs;

  // Task-awareness: filesystem steps never need the screen while cached.
  if (isFilesystemStep(input.task?.stepToolName) && !stale) {
    return {
      action: 'REUSE_VALID_STATE',
      reason: 'filesystem step: prefer filesystem verification over screenshots',
      region,
      priority: input.priority,
    };
  }

  // --- 4. change-awareness ---------------------------------------------------
  const changeKind = input.change?.kind ?? classifyChange(input.changedFraction);
  if (changeKind === 'major' || changeKind === 'relevant') {
    return {
      action: stale ? 'OBSERVE_NOW' : 'OBSERVE_REGION',
      reason: `meaningful screen change (${changeKind}): fresh understanding required`,
      region,
      priority: input.priority,
    };
  }
  if (changeKind === 'none' && !stale) {
    return {
      action: 'REUSE_VALID_STATE',
      reason: `screen unchanged and state is fresh (${Math.round(age)}ms old): reusing safe previous state`,
      region,
      priority: input.priority,
    };
  }
  if (changeKind === 'minor' && !stale) {
    return {
      action: 'DELAY_OBSERVATION',
      reason: 'minor change only: delaying full observation',
      region,
      priority: input.priority,
      delayMs: Math.min(1_000, policy.maxAgeMs),
    };
  }

  // --- 5. trigger-driven behavior ---------------------------------------------
  if (input.trigger === 'after_mouse_action' || input.trigger === 'after_keyboard_action' || input.trigger === 'browser_navigation') {
    return {
      action: stale ? 'OBSERVE_NOW' : 'OBSERVE_AFTER_ACTION',
      reason: `post-action verification (${input.trigger})`,
      region,
      priority: input.priority,
    };
  }

  // --- 7. default ---------------------------------------------------------------
  if (stale) {
    return {
      action: region === 'full_screen' ? 'OBSERVE_NOW' : 'OBSERVE_REGION',
      reason: `cached state is stale (${age}ms > ${policy.maxAgeMs}ms window)`,
      region,
      priority: input.priority,
    };
  }
  return {
    action: 'REUSE_VALID_STATE',
    reason: `cached state is valid (${Math.round(age)}ms old)`,
    region,
    priority: input.priority,
  };
}

