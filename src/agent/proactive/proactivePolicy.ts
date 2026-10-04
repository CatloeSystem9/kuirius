/**
 * Proactive policy (Phase 15) — deterministic, testable gates applied before
 * any decision: interruption budget, per-category cooldowns, duplicate
 * suppression, rejection suppression, expiry, and confidence thresholds.
 * Pure functions over (opportunity, context state, now).
 */
import type { ProactiveContext } from './proactiveContext';
import type { ProactiveOpportunity } from './proactiveTypes';

export interface PolicyGateResult {
  allowed: boolean;
  /** Machine-readable gate name for telemetry/tests. */
  gate: string;
  reason: string;
}

/**
 * Run all policy gates in order. First failing gate wins. These gates are
 * safety/annoyance bounds ONLY — usefulness judgment lives in the decider.
 */
export function evaluatePolicy(opportunity: ProactiveOpportunity, context: ProactiveContext, now: number): PolicyGateResult {
  // 1. Expiry — an expired opportunity is never presented.
  if (opportunity.expiresAt <= now) {
    return { allowed: false, gate: 'expired', reason: 'opportunity expired before evaluation' };
  }

  // 2. Already handled — same dedup key presented/suppressed recently.
  if (context.hasPresentedRecently(opportunity.dedupKey, now, 30 * 60_000)) {
    return { allowed: false, gate: 'duplicate', reason: 'same suggestion was already presented recently' };
  }

  // 3. Rejection suppression — the user declined this category recently.
  const suppressedUntil = context.rejectionSuppressionUntil(opportunity.risk, now);
  if (now < suppressedUntil) {
    return {
      allowed: false,
      gate: 'rejection_suppressed',
      reason: `category "${opportunity.risk}" suppressed after rejection until ${new Date(suppressedUntil).toISOString()}`,
    };
  }

  // 4. Per-category cooldown.
  const last = context.lastPresentedInCategory(opportunity.risk);
  if (last > 0 && now - last < context.budget.perCategoryCooldownMs) {
    const wait = context.budget.perCategoryCooldownMs - (now - last);
    return { allowed: false, gate: 'cooldown', reason: `category "${opportunity.risk}" in cooldown for another ${Math.round(wait / 1000)}s` };
  }

  // 5. Interruption budget — hard cap on presentations per rolling window.
  if (context.presentedWithinWindow(now).length >= context.budget.maxPresentedPerWindow) {
    return {
      allowed: false,
      gate: 'budget_exhausted',
      reason: `interruption budget exhausted (${context.budget.maxPresentedPerWindow} per ${Math.round(context.budget.windowMs / 60000)}m)`,
    };
  }

  // 6. Confidence thresholds — never present (let alone execute) weak evidence.
  if (opportunity.confidence < context.budget.minPresentConfidence) {
    return { allowed: false, gate: 'low_confidence', reason: `confidence ${opportunity.confidence.toFixed(2)} below presentation threshold ${context.budget.minPresentConfidence}` };
  }

  return { allowed: true, gate: 'pass', reason: 'all policy gates passed' };
}
