/**
 * Proactive intelligence types (Phase 15).
 *
 * Event-driven opportunity detection with strict anti-annoyance and safety
 * boundaries. No polling, no autonomous unsafe action: every proactive
 * action flows through the existing Phase 3 permission system, and
 * high-impact categories are never executed automatically (LEVEL 4).
 */

/** Structured, bounded triggers derived from existing AgentEventBus events. */
export type ProactiveSignalType =
  | 'task_completed'
  | 'task_failed'
  | 'task_unfinished'
  | 'verification_result'
  | 'app_state_changed'
  | 'browser_navigation'
  | 'screen_changed'
  | 'repeated_correction'
  | 'workflow_pattern'
  | 'deadline_reminder'
  | 'file_state_changed'
  | 'context_change'
  | 'explicit_preference'
  | 'inactivity';

/** Approximate user-activity classification (no continuous polling). */
export type ActivityState = 'IDLE' | 'FOCUSED' | 'ACTIVE' | 'BUSY' | 'UNCERTAIN';

/**
 * Proactive action levels. LEVEL 4 categories are NEVER executed
 * automatically — the decider hard-blocks them regardless of confidence.
 */
export type ProactiveActionLevel = 0 | 1 | 2 | 3 | 4;

/** Risk category of a suggested action (drives the hard level-4 block). */
export type ProactiveRiskCategory =
  | 'general'
  | 'navigation'
  | 'observation'
  | 'file_read'
  | 'file_write'
  | 'destructive'
  | 'communication'
  | 'financial'
  | 'credential'
  | 'security'
  | 'system_change';

/** A suggested concrete action. `level4` categories are never auto-executed. */
export interface ProactiveSuggestedAction {
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  category: ProactiveRiskCategory;
  requiredPermissions: string[];
  reversible: boolean;
  minLevel: ProactiveActionLevel;
}

export type OpportunityStatus =
  | 'DETECTED'
  | 'CONSIDERING'
  | 'SUPPRESSED'
  | 'PRESENTED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'EXECUTED'
  | 'VERIFIED'
  | 'FAILED';

/** Bounded, redacted evidence reference (never raw screen content). */
export interface ProactiveEvidence {
  source: string;
  quote: string;
  timestamp: number;
  confidence: number;
}

/** Structured signal produced from a bus event (deduplicated, TTL-bounded). */
export interface ProactiveSignal {
  id: string;
  type: ProactiveSignalType;
  /** Stable dedup key: same entity within the dedup window refreshes, not duplicates. */
  dedupKey: string;
  taskId?: string;
  timestamp: number;
  expiresAt: number;
  confidence: number;
  /** 0..1 — how much this matters to the user. */
  importance: number;
  /** 0..1 — how time-sensitive this is. */
  urgency: number;
  /** Short redacted strings only (spec §14 — no raw screen content, no secrets). */
  evidence: ProactiveEvidence[];
  /** Bounded metadata payload (small primitives only). */
  metadata: Record<string, string | number | boolean>;
}

/** The central Phase 15 opportunity model. */
export interface ProactiveOpportunity {
  id: string;
  type: ProactiveSignalType;
  /** Stable key for duplicate suppression (type + category + entity hash). */
  dedupKey: string;
  createdAt: number;
  expiresAt: number;
  confidence: number;
  importance: number;
  urgency: number;
  /** 0..1 — estimated usefulness if accepted. */
  expectedBenefit: number;
  /** 0..1 — how disruptive presenting this would be right now. */
  intrusiveness: number;
  risk: ProactiveRiskCategory;
  requiredPermissions: string[];
  suggestedAction?: ProactiveSuggestedAction;
  triggerSignalIds: string[];
  evidence: ProactiveEvidence[];
  status: OpportunityStatus;
  /** Bounded reason trail for auditing (why suppressed/presented/…). */
  statusReasons: string[];
}

/** Deterministic decision produced by the decision engine. */
export type ProactiveDecisionAction =
  | 'RECORD_ONLY'
  | 'SUPPRESS'
  | 'WAIT'
  | 'SUGGEST'
  | 'REQUEST_CONFIRMATION'
  | 'EXECUTE_AFTER_CONFIRMATION';

export interface ProactiveDecision {
  action: ProactiveDecisionAction;
  level: ProactiveActionLevel;
  reason: string;
  opportunity: ProactiveOpportunity;
}

/** A presented suggestion (LEVEL 1+). Bounded; expires. */
export interface ProactiveSuggestion {
  id: string;
  opportunityId: string;
  text: string;
  level: ProactiveActionLevel;
  confirmationRequired: boolean;
  presentedAt: number;
  expiresAt: number;
  category: ProactiveRiskCategory;
  dedupKey: string;
  suggestedAction?: ProactiveSuggestedAction;
  status: 'PRESENTED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
}

/** Interruption budget configuration (all bounded, deterministic). */
export interface InterruptionBudgetConfig {
  /** Max suggestions presented within `windowMs`. */
  maxPresentedPerWindow: number;
  windowMs: number;
  /** Cooldown per opportunity category after a presentation. */
  perCategoryCooldownMs: number;
  /** Base suppression window after a rejection. */
  rejectionSuppressMs: number;
  /** Max suppression window (escalation cap). */
  rejectionSuppressMaxMs: number;
  /** Rejections of one category before proactive memory records the preference. */
  rejectionsBeforeMemory: number;
  /** Min confidence to present at all. */
  minPresentConfidence: number;
  /** Min confidence to ever execute after confirmation. */
  minExecuteConfidence: number;
}

export const DEFAULT_BUDGET: InterruptionBudgetConfig = {
  maxPresentedPerWindow: 3,
  windowMs: 10 * 60_000,
  perCategoryCooldownMs: 5 * 60_000,
  rejectionSuppressMs: 30 * 60_000,
  rejectionSuppressMaxMs: 24 * 60 * 60_000,
  rejectionsBeforeMemory: 3,
  minPresentConfidence: 0.55,
  minExecuteConfidence: 0.7,
};

export const DEFAULT_SIGNAL_TTL_MS = 2 * 60_000;
export const DEFAULT_OPPORTUNITY_TTL_MS = 10 * 60_000;
export const DEFAULT_SUGGESTION_TTL_MS = 5 * 60_000;

/** Hard level-4 categories — never automatically executed (spec §7/§13). */
export const NEVER_AUTOMATIC_CATEGORIES: readonly ProactiveRiskCategory[] = [
  'destructive',
  'communication',
  'financial',
  'credential',
  'security',
  'system_change',
];

export function isNeverAutomatic(category: ProactiveRiskCategory): boolean {
  return NEVER_AUTOMATIC_CATEGORIES.includes(category);
}
