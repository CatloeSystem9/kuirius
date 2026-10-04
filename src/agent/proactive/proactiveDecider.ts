/**
 * Proactive decision engine (Phase 15) — deterministic local logic answering:
 * useful? evidenced? relevant? user busy? interruption justified? already
 * suggested? previously rejected? reversible? permission needed? safer
 * non-action alternative? confirmation required?
 *
 * Never fabricates a reason to interrupt: low confidence → WAIT or
 * RECORD_ONLY. High-impact categories are hard-blocked at LEVEL 4.
 */
import type { ProactiveContext } from './proactiveContext';
import { evaluatePolicy } from './proactivePolicy';
import {
  isNeverAutomatic,
  type ActivityState,
  type ProactiveActionLevel,
  type ProactiveDecision,
  type ProactiveOpportunity,
  type ProactiveRiskCategory,
  type ProactiveSuggestedAction,
} from './proactiveTypes';

/** Risk → minimum action level mapping (spec §7). */
export function minimumLevelFor(risk: ProactiveRiskCategory): ProactiveActionLevel {
  if (isNeverAutomatic(risk)) return 4;
  switch (risk) {
    case 'file_write':
      return 3; // execute only after explicit confirmation
    case 'file_read':
    case 'observation':
    case 'navigation':
    case 'general':
    default:
      return 1; // low-risk suggestion is acceptable
  }
}

export interface DecideInput {
  opportunity: ProactiveOpportunity;
  activity: ActivityState;
  /** Relevant memory strings recalled for this evaluation (bounded, redacted). */
  relevantMemories?: string[];
  /** Granted permission names (from the authoritative PermissionManager). */
  grantedPermissions: ReadonlySet<string>;
  now: number;
}

/**
 * Two-stage decision: policy gates first (annoyance/expiry bounds), then the
 * usefulness/interruption judgment. Output is fully deterministic.
 */
export function decide(input: DecideInput, context: ProactiveContext): ProactiveDecision {
  const { opportunity: opp, activity, grantedPermissions, now } = input;

  // --- stage 1: policy gates -------------------------------------------------
  const gate = evaluatePolicy(opp, context, now);
  if (!gate.allowed) {
    opp.status = gate.gate === 'expired' ? 'EXPIRED' : 'SUPPRESSED';
    opp.statusReasons.push(`${gate.gate}: ${gate.reason}`);
    return { action: 'SUPPRESS', level: 0, reason: gate.reason, opportunity: opp };
  }

  // --- stage 2: hard safety block (LEVEL 4 categories) -----------------------
  if (opp.suggestedAction && isNeverAutomatic(opp.suggestedAction.category)) {
    opp.status = 'SUPPRESSED';
    opp.statusReasons.push('level4: high-impact category is never automatically executed');
    return {
      action: 'SUPPRESS',
      level: 4,
      reason: `category "${opp.suggestedAction.category}" is never automatically executed (LEVEL 4)`,
      opportunity: opp,
    };
  }

  // --- stage 3: usefulness + evidence strength -------------------------------
  const evidenceStrong = opp.confidence >= context.budget.minPresentConfidence && opp.evidence.length > 0;
  const useful = opp.expectedBenefit >= 0.35;
  if (!useful || !evidenceStrong) {
    opp.status = 'CONSIDERING';
    opp.statusReasons.push(useful ? 'evidence too weak' : 'expected benefit too low');
    return {
      action: useful ? 'WAIT' : 'RECORD_ONLY',
      level: 0,
      reason: useful ? `evidence too weak (confidence ${opp.confidence.toFixed(2)}) — waiting for stronger signals` : `expected benefit ${opp.expectedBenefit.toFixed(2)} too low — recording only`,
      opportunity: opp,
    };
  }

  // --- stage 4: still relevant? ----------------------------------------------
  if (opp.expiresAt - now < 30_000) {
    opp.status = 'EXPIRED';
    opp.statusReasons.push('opportunity no longer relevant (about to expire)');
    return { action: 'RECORD_ONLY', level: 0, reason: 'opportunity window nearly over — no longer relevant', opportunity: opp };
  }

  // --- stage 5: user busy / uncertainty → prefer non-interruption ------------
  if (activity === 'BUSY') {
    opp.status = 'SUPPRESSED';
    opp.statusReasons.push('user busy: active task in flight');
    return { action: 'SUPPRESS', level: 0, reason: 'user is busy (active task) — low-value interruption suppressed', opportunity: opp };
  }

  const interruptionJustified = opp.importance * opp.urgency >= opp.intrusiveness * 0.5;
  if (!interruptionJustified && activity !== 'IDLE') {
    opp.status = 'SUPPRESSED';
    opp.statusReasons.push(`interruption not justified (activity=${activity})`);
    return {
      action: activity === 'UNCERTAIN' ? 'WAIT' : 'SUPPRESS',
      level: 0,
      reason: `interruption not justified now (importance*urgency ${ (opp.importance * opp.urgency).toFixed(2) } < intrusiveness threshold, activity=${activity})`,
      opportunity: opp,
    };
  }

  // --- stage 6: no suggested action → informational suggestion or silent record
  if (!opp.suggestedAction) {
    if (interruptionJustified || activity === 'IDLE') {
      // Informational-only suggestion (workflow recognition, corrections,
      // unfinished-task resume offers). Nothing is executable here — accept()
      // reports honestly that there is no action attached.
      opp.status = 'CONSIDERING';
      opp.statusReasons.push('informational suggestion (no executable action)');
      return { action: 'SUGGEST', level: 1, reason: 'notable signal — presenting an informational, non-executable suggestion', opportunity: opp };
    }
    opp.status = 'CONSIDERING';
    opp.statusReasons.push('no actionable suggestion attached');
    return { action: 'RECORD_ONLY', level: 0, reason: 'signal is notable but no safe action is associated and interruption is not justified', opportunity: opp };
  }

  // --- stage 7: permission + reversibility ------------------------------------
  const action = opp.suggestedAction;
  const missing = action.requiredPermissions.filter((p) => !grantedPermissions.has(p));
  if (!action.reversible && action.category !== 'general') {
    opp.status = 'SUPPRESSED';
    opp.statusReasons.push('irreversible non-general action is not proactively suggestable');
    return { action: 'SUPPRESS', level: 0, reason: 'action is irreversible — proactive execution never allowed', opportunity: opp };
  }
  if (missing.length > 0) {
    // Safer alternative: ask, never act.
    opp.status = 'CONSIDERING';
    opp.statusReasons.push(`missing permissions: ${missing.join(', ')}`);
    return {
      action: 'REQUEST_CONFIRMATION',
      level: 2,
      reason: `action requires permission(s) ${missing.join(', ')} — requesting explicit confirmation`,
      opportunity: opp,
    };
  }

  // --- stage 8: action level ---------------------------------------------------
  const minLevel = Math.max(minimumLevelFor(action.category), action.minLevel);
  if (opp.confidence < context.budget.minExecuteConfidence && minLevel >= 3) {
    opp.status = 'CONSIDERING';
    opp.statusReasons.push(`confidence ${opp.confidence.toFixed(2)} below execution threshold`);
    return {
      action: 'REQUEST_CONFIRMATION',
      level: 2,
      reason: `confidence below execution threshold — confirmation required before any execution`,
      opportunity: opp,
    };
  }

  opp.status = 'CONSIDERING';
  opp.statusReasons.push(`decided: minLevel=${minLevel}`);
  if (minLevel >= 3) {
    return { action: 'EXECUTE_AFTER_CONFIRMATION', level: 3, reason: 'low-risk reversible action proposed for execution after explicit confirmation', opportunity: opp };
  }
  return { action: 'SUGGEST', level: 1, reason: 'low-risk suggestion — presenting concise offer', opportunity: opp };
}
