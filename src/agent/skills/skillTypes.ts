/**
 * Learned Skills v1 — types.
 *
 * A learned skill is a structured, VALIDATED, reusable capability distilled
 * from a genuinely verified task execution — the curated tier above the Phase
 * 12 workflow candidates (which are reuse *suggestions*; skills additionally
 * require honest goal-level verification, explicit validation, preconditions,
 * provenance and smoothed reliability tracking).
 *
 * Everything here is deterministic, local and bounded. Skills never bypass
 * the Agent Core lifecycle, permissions, the Phase 18 SafetyGate, or step
 * verification — reuse only ever produces a normal plan for the existing
 * executor. No secrets are ever stored (templates are sanitized at extraction
 * AND re-sanitized at instantiation).
 */
import type { ToolPermission } from '../types';
import type { OutcomeKind, WorkflowStep } from '../learning/learningTypes';

// ---------------------------------------------------------------- primitives

export type SkillStatus = 'active' | 'disabled';
export type SkillValidationStatus = 'validated' | 'rejected';

/** One reusable action inside a skill (Phase 12 step shape + transparency). */
export interface SkillStep extends WorkflowStep {
  /** Human-readable step description carried over from the executed plan. */
  description?: string;
}

/** A precondition that must hold before a skill may be reused. */
export type SkillPrecondition =
  | { kind: 'tool_available'; tool: string; description: string }
  | { kind: 'permission_granted'; permission: ToolPermission; description: string };

export interface SkillValidation {
  status: SkillValidationStatus;
  /** Deterministic rejection reasons (empty when validated). */
  errors: string[];
  /** Non-blocking observations recorded for transparency. */
  warnings: string[];
  checkedAt: number;
}

export interface SkillStats {
  totalUses: number;
  successfulUses: number;
  failedUses: number;
  consecutiveFailures: number;
  reinforcements: number;
  lastUsedAt?: number;
  lastOutcome?: OutcomeKind;
  /** Duplicate/conflicting-update prevention: the last task that recorded an outcome. */
  lastRecordedTaskId?: string;
}

export interface SkillVersionInfo {
  version: number;
  createdAt: number;
  changeNote: string;
}

/** Where a skill came from — always a real, verified task execution. */
export interface SkillProvenance {
  sourceTaskId: string;
  sourceWorkflowId?: string;
  learnedAt: number;
  /** The honest goal-level verification verdict that justified learning. */
  verificationReason: string;
}

/** The learned skill itself — compact by design (bounded store). */
export interface LearnedSkill {
  id: string;
  name: string;
  description: string;
  /** What the skill is for (normalized goal pattern). */
  purpose: string;
  trigger: {
    goalPattern: string;
    /** Distinctive keywords used for semantic matching (bounded). */
    keywords: string[];
    domains: string[];
  };
  steps: SkillStep[];
  preconditions: SkillPrecondition[];
  requiredTools: string[];
  requiredPermissions: ToolPermission[];
  /** The verified end state observed when the skill was learned. */
  expectedOutcome: string;
  /** True when the workflow touches medium-risk or sensitive domains —
   * surfaced for transparency; the Phase 18 gate still gates every run. */
  sensitive: boolean;
  provenance: SkillProvenance;
  validation: SkillValidation;
  status: SkillStatus;
  version: number;
  versionHistory: SkillVersionInfo[];
  stats: SkillStats;
  /** Smoothed 0..1 reliability (EWMA — a single failure never collapses it). */
  reliability: number;
  createdAt: number;
  updatedAt: number;
}

/** A ranked skill match for a new task goal. */
export interface SkillMatch {
  skill: LearnedSkill;
  score: number;
  goalSimilarity: number;
  semanticOverlap: number;
  environmentCoverage: number;
  preconditionsMet: boolean;
  /** Explainability: why this skill matched (and anything that blocks reuse). */
  reasons: string[];
  blockers: string[];
}

export interface SkillLearnOutcome {
  learned: boolean;
  skillId?: string;
  version?: number;
  reason: string;
}

// ---------------------------------------------------------------- constants

export const SKILL_SCHEMA_VERSION = 2;
export const SKILLS_STORAGE_KEY = 'krisha_skills_v1';

/** Hard caps — the skill store stays lightweight on an i3 laptop. */
export const MAX_SKILLS = 30;
export const MAX_SKILL_STEPS = 10;
export const MAX_VERSION_HISTORY = 10;
export const MAX_KEYWORDS = 8;

/** Verified manual-flow evidence held until it has recurred three times. */
export interface SkillCandidate {
  id: string;
  goalPattern: string;
  stepSignature: string;
  successes: number;
  firstTaskId: string;
  lastTaskId: string;
  createdAt: number;
  updatedAt: number;
}

/** Minimum token similarity to treat a task as the same skill (reinforce). */
export const SKILL_GOAL_MATCH_THRESHOLD = 0.5;
/** Minimum final match score before a skill may shape a new plan. */
export const SKILL_REUSE_MIN_SCORE = 0.6;
/** Direct token-similarity acceptance floor for reuse. */
export const SKILL_SIMILAR_ACCEPT = 0.55;
/** Weaker token similarity may still match with strong semantic support. */
export const SKILL_SEMANTIC_ACCEPT_SIMILARITY = 0.4;
export const SKILL_SEMANTIC_ACCEPT_OVERLAP = 0.5;
/** Reliability floor for autonomous reuse (validated + proven, not raw). */
export const SKILL_MIN_RELIABILITY = 0.6;
/** A freshly validated skill starts just below the reuse floor: it becomes
 * autonomously reusable only after one more verified success. */
export const INITIAL_SKILL_RELIABILITY = 0.55;
/** Below this reliability a skill is disabled (bounded self-limitation). */
export const SKILL_DISABLE_BELOW = 0.15;

/**
 * Smoothed reliability update (EWMA). Verified success pulls toward 1 with
 * weight 0.2, verified failure pulls toward 0 with the SAME weight — so a
 * single unusual failure can never collapse a proven skill (1.0 → 0.8, still
 * reusable), while a genuinely broken skill decays out of reuse within a few
 * verified failures.
 */
export function applySkillOutcome(reliability: number, outcome: OutcomeKind): number {
  let next: number;
  switch (outcome) {
    case 'verified_success': next = reliability * 0.8 + 1 * 0.2; break;
    case 'unverified_success': next = reliability * 0.9 + 1 * 0.1; break;
    case 'verified_failure': next = reliability * 0.8 + 0 * 0.2; break;
    case 'unverified_failure': next = reliability * 0.9 + 0 * 0.1; break;
    default: next = reliability;
  }
  return Math.max(0, Math.min(1, Math.round(next * 1000) / 1000));
}

/** A skill may only be auto-reused when validated, active, and reliable. */
export function isReusableSkill(skill: LearnedSkill): boolean {
  if (skill.status !== 'active') return false;
  if (skill.validation.status !== 'validated') return false;
  return skill.reliability >= SKILL_MIN_RELIABILITY;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'then', 'after', 'that', 'this', 'these', 'those',
  'to', 'of', 'in', 'on', 'for', 'with', 'my', 'me', 'i', 'it', 'is', 'are', 'was',
  'please', 'can', 'you', 'your', 'from', 'at', 'by', 'as', 'be', 'into', 'about',
]);

/** Distinctive keywords of a goal (deterministic, bounded, plural-folded). */
export function extractKeywords(text: string): string[] {
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return Array.from(new Set(words)).slice(0, MAX_KEYWORDS);
}

/** Deterministic step-sequence signature (duplicate detection). */
export function skillSignature(steps: SkillStep[]): string {
  return steps.map((s) => `${s.toolName}|${s.capability ?? ''}`).join('>');
}
