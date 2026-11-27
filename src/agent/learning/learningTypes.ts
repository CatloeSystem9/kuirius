/**
 * Learning types (Phase 12 — Learning + Workflow Acquisition).
 *
 * Deterministic, bounded workflow knowledge: structured goals, triggers,
 * ordered steps, evidence and confidence — never raw screenshots, secrets,
 * or sensitive input. The Agent Core remains the central brain; learned
 * workflows are reuse *suggestions* that still pass through permissions,
 * verification, cancellation, timeouts, and recovery.
 */
import type { PlanStep } from '../types';

// ---------------------------------------------------------------- primitives

export type ConfidenceLevel = 'candidate' | 'usable' | 'trusted' | 'degraded' | 'disabled';

export const CONFIDENCE_THRESHOLDS: Record<Exclude<ConfidenceLevel, 'candidate'>, number> & { floor: number } = {
  trusted: 0.7,
  usable: 0.45,
  degraded: 0.15,
  disabled: 0.0,
  floor: 0.0,
};

export type LearningStatus = 'active' | 'superseded' | 'disabled';
export type OutcomeKind = 'verified_success' | 'unverified_success' | 'verified_failure' | 'unverified_failure';

/** The context in which a workflow was learned / is applicable. */
export interface TriggerContext {
  /** Normalized goal text used for matching. */
  goalPattern: string;
  /** Capability tags the workflow requires (must exist in the registry to reuse). */
  requiredCapabilities: string[];
  /** Environment tags (e.g. 'windows', 'filesystem', 'browser'). */
  domains: string[];
}

/** One reusable action inside a workflow. */
export interface WorkflowStep {
  order: number;
  toolName: string;
  capability?: string;
  /** Sanitized parameter TEMPLATE — secrets stripped, volatile values parameterized. */
  inputTemplate: Record<string, unknown>;
  /** Verification the step must pass when reused. */
  verification?: { type: 'tool_success' | 'output_contains'; expected?: string };
  /** Observation requirement when reused (Phase 13): 'fresh' forbids reusing
   * cached screen state for this step; 'none' keeps the default policy. */
  observation?: { requireFresh?: boolean; region?: string };
  /** Context placeholders this step consumes (e.g. 'found.matches.0.path'). */
  contextRefs?: string[];
  /** Output key this step produces for later steps. */
  outputKey?: string;
}

/** Evidence that a workflow worked — structured, never raw payloads. */
export interface WorkflowEvidence {
  outcome: OutcomeKind;
  at: number;
  note?: string;
}

export interface WorkflowUsage {
  totalUses: number;
  successfulUses: number;
  failedUses: number;
  lastUsedAt?: number;
  lastOutcome?: OutcomeKind;
}

export interface CorrectionRecord {
  id: string;
  workflowId?: string;
  failureSummary: string;
  correctedAction: string;
  verified: boolean;
  createdAt: number;
}

export interface WorkflowVersionInfo {
  version: number;
  createdAt: number;
  changeNote: string;
}

/** The learned workflow itself. */
export interface LearnedWorkflow {
  id: string;
  name: string;
  trigger: TriggerContext;
  steps: WorkflowStep[];
  dependencies?: string[];
  knownFailurePoints?: string[];
  corrections: CorrectionRecord[];
  evidence: WorkflowEvidence[];
  confidence: number;
  status: LearningStatus;
  version: number;
  versionHistory: WorkflowVersionInfo[];
  usage: WorkflowUsage;
  createdAt: number;
  updatedAt: number;
}

/** A ranked reuse suggestion derived from a learned workflow. */
export interface WorkflowCandidate {
  workflow: LearnedWorkflow;
  score: number;
  goalSimilarity: number;
  capabilityCoverage: number;
  reasons: string[];
}

/** Result of attempting to learn from a completed task. */
export interface LearnOutcome {
  learned: boolean;
  workflowId?: string;
  version?: number;
  reason?: string;
}

// ---------------------------------------------------------------- helpers

export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence < CONFIDENCE_THRESHOLDS.disabled) return 'disabled';
  if (confidence < CONFIDENCE_THRESHOLDS.degraded) return 'degraded';
  if (confidence < CONFIDENCE_THRESHOLDS.usable) return 'candidate';
  if (confidence < CONFIDENCE_THRESHOLDS.trusted) return 'usable';
  return 'trusted';
}

/** A workflow may only be auto-reused from the 'usable' level upward. */
export function isReusable(workflow: LearnedWorkflow): boolean {
  if (workflow.status !== 'active') return false;
  const level = confidenceLevel(workflow.confidence);
  return level === 'usable' || level === 'trusted';
}

/** Bounded, deterministic confidence update (spec §7). */
export function applyOutcomeToConfidence(confidence: number, outcome: OutcomeKind): number {
  let delta = 0;
  switch (outcome) {
    case 'verified_success': delta = +0.1; break;
    case 'unverified_success': delta = +0.01; break; // barely counts
    case 'verified_failure': delta = -0.2; break;
    case 'unverified_failure': delta = -0.05; break;
  }
  return Math.max(0, Math.min(1, Math.round((confidence + delta) * 1000) / 1000));
}

/** Extract a plan-step-shaped template from an executed step (sanitized). */
export function toWorkflowStep(step: PlanStep, order: number): WorkflowStep {
  return {
    order,
    toolName: step.toolName,
    capability: step.capability,
    inputTemplate: sanitizeTemplate(step.input),
    verification:
      step.verification?.type === 'output_contains'
        ? { type: 'output_contains', expected: step.verification.expected }
        : { type: 'tool_success' },
    observation: step.observation,
    contextRefs: collectContextRefs(step.input),
    outputKey: step.outputKey,
  };
}

function collectContextRefs(input: Record<string, unknown>, prefix = ''): string[] {
  const refs: string[] = [];
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof (value as any).$context === 'string') {
        refs.push((value as any).$context);
      } else {
        refs.push(...collectContextRefs(value as Record<string, unknown>, `${prefix}${key}.`));
      }
    }
  }
  return refs;
}

const SECRET_KEY_RE = /password|passwd|secret|token|api[-_]?key|credential|otp|auth[-_]?code/i;

/** Strip sensitive keys and secret-looking values from a step template. */
export function sanitizeTemplate(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string') {
      out[key] = maskIfSecretLike(value);
    } else if (value !== null && typeof value === 'object') {
      out[key] = Array.isArray(value)
        ? value.map((v) => (typeof v === 'string' ? maskIfSecretLike(v) : v))
        : sanitizeTemplate(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export const SECRET_VALUE_RE = /\bsk-[a-z0-9]{12,}\b|\bghp_[a-z0-9]{20,}\b|\bAKIA[0-9A-Z]{12,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

export function maskIfSecretLike(value: string): string {
  if (SECRET_VALUE_RE.test(value)) return '[redacted]';
  if (value.length > 200) return value.slice(0, 200) + '…';
  return value;
}

// ============================================================================
// Krix Learning Mechanism (Foundation for Krix Academy)
// ============================================================================

export type LearningSource =
  | 'conversation'
  | 'correction'
  | 'research'
  | 'task_outcome'
  | 'tool_result'
  | 'academy'
  | 'memory';

export type LearningCandidateType =
  | 'new_knowledge'
  | 'correction'
  | 'relationship'
  | 'procedure'
  | 'skill_change'
  | 'temporary';

export type VerificationStatus =
  | 'unverified'
  | 'user_provided'
  | 'hypothesis'
  | 'fact';

export type MasteryStatus = 'unverified' | 'tested' | 'proficient' | 'expert';

export interface Provenance {
  source: LearningSource;
  sourceId?: string;
  timestamp: number;
  rawText: string;
  confidence: number;
}

export interface ConceptRelationship {
  id: string;
  fromId: string;
  toId: string;
  type:
    | 'prerequisite'
    | 'related'
    | 'contradicts'
    | 'extends'
    | 'example_of'
    | 'part_of';
  strength: number;
  evidence: string;
  createdAt: number;
}

export interface ConceptContradiction {
  id: string;
  conceptId: string;
  conflictingText: string;
  conflictingSource: LearningSource;
  description: string;
  detectedAt: number;
  resolved: boolean;
  resolution?: string;
}

export interface ConceptVersionSnapshot {
  version: number;
  definition: string;
  verificationStatus: VerificationStatus;
  confidence: number;
  updatedAt: number;
  changeNote: string;
}

export interface AcquiredConcept {
  id: string;
  label: string;
  definition: string;
  relationships: ConceptRelationship[];
  prerequisites: string[];
  knowledgeGaps: string[];
  confidence: number;
  verificationStatus: VerificationStatus;
  provenance: Provenance[];
  version: number;
  versionHistory: ConceptVersionSnapshot[];
  contradictions: ConceptContradiction[];
  createdAt: number;
  updatedAt: number;
}

export interface ValidationEvidence {
  type:
    | 'task_success'
    | 'test_pass'
    | 'user_confirmation'
    | 'repeated_success';
  taskId?: string;
  description: string;
  timestamp: number;
  passed: boolean;
}

export interface AcquiredSkill {
  id: string;
  label: string;
  description: string;
  prerequisites: string[];
  requiredKnowledge: string[];
  requiredPermissions: string[];
  procedure: string;
  validationEvidence: ValidationEvidence[];
  masteryStatus: MasteryStatus;
  version: number;
  lastTestedAt?: number;
  knownLimitations: string[];
  createdAt: number;
  updatedAt: number;
}

export interface LearningCandidate {
  id: string;
  type: LearningCandidateType;
  source: LearningSource;
  content: string;
  context: Record<string, unknown>;
  confidence: number;
  sessionId: string;
  timestamp: number;
  idempotencyKey: string;
}

export interface LearningSession {
  id: string;
  startedAt: number;
  updatedAt: number;
  mode: 'guided' | 'independent' | 'ambient';
  topic?: string;
  source: LearningSource;
  candidates: LearningCandidate[];
  outcome?: LearningOutcome;
  status: 'active' | 'paused' | 'completed' | 'failed';
  resumeToken?: string;
  apiCallsUsed: number;
}

export interface StructuredCorrection {
  id: string;
  originalMistake: string;
  cause:
    | 'missing_knowledge'
    | 'incorrect_knowledge'
    | 'wrong_procedure'
    | 'misunderstood_context'
    | 'unknown';
  correctedKnowledge: string;
  evidence: string[];
  validatedAt?: number;
  appliedCount: number;
  conceptIds: string[];
  createdAt: number;
}

export interface ExperienceRecord {
  id: string;
  taskId: string;
  outcome: 'success' | 'failure' | 'partial';
  environmental: boolean;
  cause?: string;
  lessonDerived?: string;
  validated: boolean;
  conceptIds: string[];
  toolsUsed: string[];
  timestamp: number;
}

export interface LearningStrategyStat {
  id: string;
  method: string;
  source: LearningSource;
  successCount: number;
  failureCount: number;
  successRate: number;
  sampleSize: number;
  conceptDifficulties: Record<string, number>;
  lastUpdatedAt: number;
}

export interface RevisionRequirement {
  id: string;
  conceptId: string;
  reason: string;
  failureCount: number;
  priority: 'low' | 'medium' | 'high';
  resolved: boolean;
  createdAt: number;
}

export interface CapabilityChange {
  type: 'skill_acquired' | 'knowledge_updated' | 'correction_applied';
  id: string;
  evidence: string[];
}

export interface LearningOutcome {
  sessionId: string;
  understood: string[];
  conceptsAcquired: string[];
  conceptsUpdated: string[];
  conceptsRejected: string[];
  skillsAcquired: string[];
  skillsUpdated: string[];
  conflicts: ConceptContradiction[];
  uncertainties: string[];
  validatedItems: string[];
  failedAssessments: string[];
  remainingGaps: string[];
  capabilityChanges: CapabilityChange[];
}

export interface KnowledgeIntegrationResult {
  candidateId: string;
  action: 'created' | 'updated' | 'merged' | 'rejected' | 'flagged_conflict';
  conceptId?: string;
  conflict?: ConceptContradiction;
  reason: string;
}

export interface LearningQueueItem {
  id: string;
  type: 'intake' | 'integrate' | 'validate' | 'consolidate' | 'experience';
  payload: unknown;
  priority: number;
  createdAt: number;
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
  cancelled?: boolean;
}

export interface LearningConfig {
  maxConcurrentTasks: number;
  maxQueueSize: number;
  batchConsolidationDelayMs: number;
  apiCallBudgetPerSession: number;
  deduplicationWindowMs: number;
  enableExperienceLearning: boolean;
  enableCorrectionTracking: boolean;
}

export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  maxConcurrentTasks: 2,
  maxQueueSize: 50,
  batchConsolidationDelayMs: 5000,
  apiCallBudgetPerSession: 10,
  deduplicationWindowMs: 300_000,
  enableExperienceLearning: true,
  enableCorrectionTracking: true,
};
