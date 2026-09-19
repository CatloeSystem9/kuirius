/**
 * Adaptive Observation types (Phase 13, spec §4).
 *
 * The observation layer decides WHEN/HOW/HOW OFTEN to look at the screen.
 * It never stores image data — visual payloads stay inside the Phase 4
 * ScreenObserver's bounded snapshot cache. All decisions are deterministic
 * and cheap (no model calls).
 */

/** How urgently an observation is needed. */
export type ObservationPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';

export const PRIORITY_RANK: Record<ObservationPriority, number> = {
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/**
 * What caused the observation need. Event-driven: the AdaptiveObserver
 * records triggers from the bus; explicit requests come from the Agent
 * Core / Computer-Use / Browser agents.
 */
export type ObservationTrigger =
  | 'explicit_request'
  | 'after_mouse_action'
  | 'after_keyboard_action'
  | 'browser_navigation'
  | 'app_focus_changed'
  | 'app_state_changed'
  | 'fs_operation'
  | 'verification_failed'
  | 'stale_state'
  | 'target_not_found'
  | 'recovery_request'
  | 'screen_change'
  | 'task_started'
  | 'task_step'
  | 'learned_workflow_requirement';

/** Coarse operating phase — drives the reuse window (policy engine). */
export type ObservationMode =
  | 'idle' // no active task: effectively no observation
  | 'active_task' // observe when the current step requires it
  | 'after_action' // just acted; verify soon
  | 'uncertain' // verification inconclusive / unknown screen state
  | 'rapid_change' // UI is changing quickly; temporarily tighter loop
  | 'settled'; // UI stable inside an active task; loosen reuse window

/** Region presets for targeted observation. Custom bounds are allowed. */
export type ObservationRegion =
  | 'full_screen'
  | 'active_application'
  | 'browser_content'
  | 'dialog_area'
  | 'target_control'
  | 'verification_region';

/** Classified magnitude of a screen change (cheap signature comparison). */
export type ObservationChangeKind = 'none' | 'minor' | 'relevant' | 'major' | 'unknown';

export interface ObservationChange {
  kind: ObservationChangeKind;
  /** Fraction of signature blocks changed, 0..1 (when measurable). */
  changedFraction?: number;
  detectedAt: number;
}

/** Bounded resource controls — every capture must fit inside these. */
export interface ObservationBudgetConfig {
  /** Maximum captures for one task. */
  maxPerTask: number;
  /** Sliding window for rate limiting. */
  windowMs: number;
  /** Maximum captures inside the sliding window. */
  maxPerWindow: number;
  /** Maximum back-to-back captures without an intervening reuse/wait. */
  maxConsecutive: number;
  /** Maximum retries after a failed observation. */
  maxRetries: number;
  /** Maximum consecutive observations that found no change. */
  maxUnchanged: number;
}

export const DEFAULT_BUDGET: ObservationBudgetConfig = {
  maxPerTask: 24,
  windowMs: 10_000,
  maxPerWindow: 6,
  maxConsecutive: 3,
  maxRetries: 2,
  maxUnchanged: 4,
};

export interface ObservationBudgetStatus {
  allowed: boolean;
  /** Machine-readable reason when not allowed (also used for telemetry). */
  reason?: 'task_limit' | 'window_limit' | 'consecutive_limit' | 'unchanged_limit';
  /** Ms until the rate window frees a slot (window_limit only). */
  retryAfterMs?: number;
  used: number;
  remaining: number;
  windowUsed: number;
  consecutive: number;
  unchangedStreak: number;
  retries: number;
}

/** Structured observation request — the unit of work for the observer. */
export interface ObservationRequest {
  trigger: ObservationTrigger;
  priority: ObservationPriority;
  reason?: string;
  taskId?: string;
  stepId?: string;
  /** Desired region (preset); 'full_screen' remains the default. */
  region?: ObservationRegion;
  /** Optional question passed through to the vision provider. */
  question?: string;
  /** Fresh capture required — cached state may NOT be reused. */
  requireFresh?: boolean;
  /** Hard timeout for the capture+analysis call. */
  timeoutMs?: number;
}

/** Policy thresholds — resolved per context by the policy engine. */
export interface ObservationPolicy {
  /** Mode-appropriate reuse window: cached states older than this are stale. */
  maxAgeMs: number;
  mode: ObservationMode;
  /** Delay suggested when observation should wait (DELAY_OBSERVATION). */
  idleDelayMs: number;
  /** Minimum priority that may trigger an immediate capture while idle. */
  idleMinPriority: ObservationPriority;
}

/** Deterministic decision produced by the decision engine. */
export type ObservationDecisionAction =
  | 'OBSERVE_NOW'
  | 'OBSERVE_AFTER_ACTION'
  | 'OBSERVE_REGION'
  | 'REUSE_VALID_STATE'
  | 'DELAY_OBSERVATION'
  | 'STOP_OBSERVATION';

export interface ObservationDecision {
  action: ObservationDecisionAction;
  /** Human-readable reason for debugging/telemetry. */
  reason: string;
  region: ObservationRegion;
  /** Suggested wait before the next observation attempt (DELAY only). */
  delayMs?: number;
  priority: ObservationPriority;
}

/** Runtime state of the adaptive observation layer (diagnostics + decisions). */
export interface ObservationState {
  lastObservationAt: number | null;
  lastStateId: string | null;
  changeStreak: number;
  quietStreak: number;
  consecutiveCaptures: number;
  pendingTrigger: ObservationTrigger | null;
  pendingTriggerAt: number | null;
  mode: ObservationMode;
  stopped: boolean;
}

/** Structured result of one observe() call. */
export interface ObservationResult {
  status: 'observed' | 'reused' | 'delayed' | 'stopped' | 'budget_exhausted' | 'failed' | 'cancelled';
  /** Freshly captured or reused screen state (Phase 4 ScreenState). */
  state?: import('../vision/visionTypes').ScreenState;
  decision: ObservationDecision;
  changeKind?: ObservationChangeKind;
  reusedFromCache: boolean;
  durationMs: number;
  budget: ObservationBudgetStatus;
  /** Structured failure — Phase 11 recovery may consume this. */
  error?: { kind: string; message: string };
}

/** How trustworthy the current cached state is. */
export type ObservationConfidence = 'high' | 'medium' | 'low' | 'stale';

/** Inputs to the deterministic decision engine (all cheap local data). */
export interface ObservationDecisionInput {
  now: number;
  trigger: ObservationTrigger;
  priority: ObservationPriority;
  policy: ObservationPolicy;
  lastObservation?: { stateId: string; timestamp: number } | null;
  change?: ObservationChange | null;
  lastAction?: { kind: 'mouse' | 'keyboard' | 'browser' | 'app' | 'fs' | 'none'; at: number } | null;
  task?: { active: boolean; stepToolName?: string } | null;
  verification?: { status: 'passed' | 'failed' | 'inconclusive' | 'none' } | null;
  recovery?: { active: boolean } | null;
  budget: ObservationBudgetStatus;
  workflow?: { reused: boolean; requireFresh?: boolean } | null;
  /** Raw signature-change fraction from the most recent comparison. */
  changedFraction?: number;
  /** The originating request required a fresh capture (never reuse cache). */
  requireFreshFlag?: boolean;
}
