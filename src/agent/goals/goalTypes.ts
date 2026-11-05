/**
 * Goal Continuity v1 — types, lifecycle, and bounded constants.
 *
 * A goal is a durable, user-owned objective ("build this application",
 * "finish the integration") that survives conversations and restarts so
 * Krisha can restore context and PROPOSE the next step — never execute one
 * on its own. Records are compact, bounded and reference existing systems
 * (projects, memory, graph) instead of duplicating them.
 */

/** Goal lifecycle states (spec §3). */
export type GoalStatus = 'proposed' | 'active' | 'paused' | 'blocked' | 'completed' | 'abandoned';

/** Terminal states — no transitions out (a completed/abandoned goal never silently resumes). */
export const GOAL_TERMINAL_STATES: ReadonlySet<GoalStatus> = new Set(['completed', 'abandoned']);

/**
 * Deterministic transition table (mirrors the long-run session precedent in
 * longrun/sessionTypes.ts). Anything not listed is INVALID and is rejected
 * safely — a goal can never silently jump between contradictory states.
 */
export const GOAL_TRANSITIONS: Record<GoalStatus, GoalStatus[]> = {
  proposed: ['active', 'completed', 'abandoned'],
  active: ['paused', 'blocked', 'completed', 'abandoned'],
  paused: ['active', 'blocked', 'completed', 'abandoned'],
  blocked: ['active', 'paused', 'completed', 'abandoned'],
  completed: [],
  abandoned: [],
};

export function canTransitionGoal(from: GoalStatus, to: GoalStatus): boolean {
  if (from === to) return false;
  return GOAL_TRANSITIONS[from].includes(to);
}

export function isTerminalGoal(status: GoalStatus): boolean {
  return GOAL_TERMINAL_STATES.has(status);
}

/** Non-terminal statuses — the only ones lifecycle statements may target. */
export const GOAL_OPEN_STATUSES: readonly GoalStatus[] = ['proposed', 'active', 'paused', 'blocked'];

/** A bounded progress marker recorded for a goal. */
export interface GoalMilestone {
  text: string;
  at: number;
  /** Task that produced this milestone (task results), when applicable. */
  sourceTaskId?: string;
  outcome?: 'progress' | 'attempt_failed';
}

/** Association with an APPROVED Project Awareness root. */
export interface GoalProjectRef {
  projectId: string;
  root: string;
  name: string;
}

/** The durable goal record — concise and structured, never a conversation. */
export interface GoalRecord {
  /** Unique, assigned once at creation ('goal_' + timestamp/base36) — stable across restarts. */
  id: string;
  /** User-facing objective description (bounded). */
  description: string;
  status: GoalStatus;
  /** Bounded provenance snippet of the user statement that created the goal. */
  originMessage?: string;
  milestones: GoalMilestone[];
  progress: {
    completed: string[];
    remaining: string[];
    blockers: string[];
  };
  /** Approved projects this goal is associated with (≤3). */
  projectRefs: GoalProjectRef[];
  /** Other goals that must complete before this one (spec: dependencies/blockers). */
  blockedByGoalIds: string[];
  lastActivityAt: number;
  /** Rate-limits repeated resumption briefings for the same goal. */
  lastBriefedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** Bounded limits — the goal store stays lightweight on an i3 laptop. */
export interface GoalLimits {
  maxGoals: number;
  maxMilestones: number;
  maxProgressItems: number;
  maxProjectRefs: number;
  maxDescriptionChars: number;
  maxItemChars: number;
  maxOriginChars: number;
}

export const DEFAULT_GOAL_LIMITS: GoalLimits = {
  maxGoals: 24,
  maxMilestones: 20,
  maxProgressItems: 10,
  maxProjectRefs: 3,
  maxDescriptionChars: 200,
  maxItemChars: 200,
  maxOriginChars: 160,
};

// ------------------------------------------------------------------ storage

export const GOALS_STORAGE_KEY = 'krisha_goals_v1';
export const GOALS_SCHEMA_VERSION = 1;

export interface GoalStoreSchema {
  schemaVersion: number;
  goals: GoalRecord[];
}

// ------------------------------------------------------------- thresholds

/** A restated objective updates the existing goal instead of duplicating it. */
export const GOAL_DUPLICATE_THRESHOLD = 0.62;
/** Minimum similarity for a lifecycle statement ("we finished X") to target a goal. */
export const GOAL_LIFECYCLE_MATCH_THRESHOLD = 0.5;
/** Minimum similarity for a completed task to count as goal progress. */
export const GOAL_TASK_MATCH_THRESHOLD = 0.55;
/** Minimum similarity for an approved project to be auto-associated. */
export const GOAL_PROJECT_MATCH_THRESHOLD = 0.5;
/** Minimum similarity before a goal is considered relevant to a message. */
export const GOAL_BRIEF_MIN_RELEVANCE = 0.35;
/** Max goals in one resumption briefing. */
export const GOAL_BRIEF_LIMIT = 3;
/** Rate-limit for briefing the SAME goal again. */
export const GOAL_BRIEF_COOLDOWN_MS = 10 * 60 * 1000;

// ------------------------------------------------------------------ events

export interface GoalStatusUpdatedPayload {
  goalId: string;
  description: string;
  status: GoalStatus;
  previousStatus?: GoalStatus;
  reason?: string;
  forgotten?: boolean;
}

export interface GoalMilestonePayload {
  goalId: string;
  milestone: string;
  sourceTaskId?: string;
  outcome?: GoalMilestone['outcome'];
}

export interface GoalBriefedPayload {
  goalId: string;
  description: string;
  relevance: number;
  briefing: string[];
}

// ------------------------------------------------------------------- stats

export interface GoalStats {
  total: number;
  proposed: number;
  active: number;
  paused: number;
  blocked: number;
  completed: number;
  abandoned: number;
  withProjectRefs: number;
  milestones: number;
}
