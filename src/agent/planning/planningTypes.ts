/**
 * Planning types (Phase 16) — hierarchical, adaptive plan model.
 *
 * A plan is a bounded tree: GOAL → SUBGOAL → ACTION/VERIFICATION. The tree is
 * derived deterministically from the existing flat AgentPlan (Phase 1/10) —
 * the flat step list remains the single execution surface driven by the Agent
 * Core loop; the tree adds hierarchy, explicit states, verification
 * expectations and replanning bookkeeping WITHOUT duplicating execution.
 *
 * Every state transition is deterministic and auditable (reason strings are
 * recorded on the node).
 */
import type { PlanStep, ToolResult } from '../types';

/** Node kinds (spec §2). `verification` nodes only assert; they never act. */
export type PlanNodeKind = 'goal' | 'subgoal' | 'action' | 'verification';

/**
 * Explicit bounded node states (spec §3). Transitions:
 *   pending → ready → running → verifying → completed
 *                                ↘ failed → (needs_replan → ready) | blocked
 *   any pending/ready state → skipped | cancelled
 */
export type PlanNodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'needs_replan'
  | 'cancelled';

/** Which layer a capability belongs to — drives subgoal grouping and diagnosis. */
export type PlanDomain = 'browser' | 'computer' | 'filesystem' | 'application' | 'memory' | 'communication' | 'general';

export interface PlanNodeExpectedOutcome {
  /** What success looks like, in plain text (surfaced in diagnostics). */
  description: string;
  /** Machine-checkable expectation evaluated against the tool result. */
  check:
    | { type: 'tool_success' }
    | { type: 'output_contains'; expected: string }
    | { type: 'output_flag'; flag: string; value: unknown };
}

export interface PlanNode {
  id: string;
  kind: PlanNodeKind;
  /** Short human-readable description (mirrors the flat step description). */
  description: string;
  parentId: string | null;
  childIds: string[];
  /** Step ids that must complete before this node runs (spec §5). */
  dependsOn: string[];
  status: PlanNodeStatus;
  /** Status-transition audit trail (bounded). */
  statusReasons: string[];
  /** Action nodes only: capability / tool that fulfils the node. */
  requiredCapability?: string;
  toolName?: string;
  /** Action nodes only: what success is expected to look like (spec §11). */
  expectedOutcome?: PlanNodeExpectedOutcome;
  /** Execution evidence. */
  attempts: number;
  result?: ToolResult;
  verified?: boolean;
  error?: string;
  /** Replanning bookkeeping (spec §7). */
  replans: number;
  /** Identity of the flat PlanStep this node wraps (actions only). */
  stepId?: string;
  /** Structural run condition mirrored from the flat step (Phase 10/16, spec §7):
   *  the Agent Core evaluates it at runtime; the tree carries it explicitly. */
  condition?: import('../context').StepCondition;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface HierarchicalPlan {
  goal: string;
  rootId: string;
  nodes: Map<string, PlanNode>;
  /** Depth-first pre-order — always dependency-compatible (parents before children). */
  order: string[];
  createdAt: number;
  revision: number;
}

/** Configurable bounds (spec §7/§18) — no scattered magic numbers. */
export interface PlanLimits {
  maxDepth: number;
  maxNodes: number;
  maxReplansPerTask: number;
  maxReplansPerNode: number;
  maxRetriesPerNode: number;
  /** Consecutive failures with the same node+error signature before stopping. */
  maxRepeatedFailures: number;
  taskTimeoutMs: number;
}

export const DEFAULT_PLAN_LIMITS: PlanLimits = {
  maxDepth: 3, // goal → subgoal → action/verification
  maxNodes: 24,
  maxReplansPerTask: 3,
  maxReplansPerNode: 1,
  maxRetriesPerNode: 3,
  maxRepeatedFailures: 2,
  taskTimeoutMs: 10 * 60_000,
};

export interface PlanValidationIssue {
  code:
    | 'missing_tool'
    | 'missing_permission'
    | 'unknown_dependency'
    | 'circular_dependency'
    | 'forward_dependency'
    | 'depth_exceeded'
    | 'size_exceeded'
    | 'missing_verification'
    | 'invalid_node';
  nodeId?: string;
  message: string;
}

export interface PlanValidationResult {
  /** false → the plan is malformed and must NOT execute. */
  valid: boolean;
  /** Hard errors (missing tool, cycles, bounds, structure). */
  errors: PlanValidationIssue[];
  /** Non-fatal findings (e.g. forward dependencies the runtime will skip). */
  warnings: PlanValidationIssue[];
  /** Nodes that exist but cannot run yet because a permission is not granted. */
  blockedNodeIds: string[];
  missingPermissions: string[];
}

/** Why a replan was considered and what came of it (spec §7). */
export interface ReplanDecision {
  /** true when corrective nodes were produced and spliced into the plan. */
  replanned: boolean;
  reason: string;
  /** Structured refusal causes for honest stops. */
  refusedBecause?:
    | 'budget_task'
    | 'budget_node'
    | 'repeated_failure'
    | 'duplicate_plan'
    | 'not_replannable'
    | 'timeout'
    | 'no_diagnosis'
    | 'cancelled';
  correctiveStepIds?: string[];
}

export interface PlanDiagnostics {
  taskId: string;
  goal: string;
  status: 'active' | 'completed' | 'failed' | 'cancelled' | 'blocked' | 'timed_out' | 'uncertain';
  currentNodeId?: string;
  completedNodes: string[];
  failedNodes: string[];
  blockedNodes: string[];
  pendingNodes: number;
  replanCount: number;
  retryCount: number;
  lastReplanReason?: string;
  nodeCount: number;
}

/** Compact per-node view for state tracking (spec §3) — bounded, no results. */
export interface PlanSnapshotNode {
  id: string;
  kind: PlanNodeKind;
  description: string;
  status: PlanNodeStatus;
  verified?: boolean;
  attempts: number;
  replans: number;
  toolName?: string;
  requiredCapability?: string;
  /** What success was expected to look like. */
  expected?: string;
  /** Structural run condition carried on the node (spec §7). */
  condition?: import('../context').StepCondition;
  error?: string;
}

/** Full structured state of one task's plan (spec §3 — dynamic state tracking). */
export interface PlanSnapshot {
  taskId: string;
  goal: string;
  revision: number;
  status: PlanDiagnostics['status'];
  currentActionId?: string;
  currentSubgoalId?: string;
  nodes: PlanSnapshotNode[];
  counts: {
    total: number;
    actions: number;
    subgoals: number;
    completed: number;
    failed: number;
    skipped: number;
    blocked: number;
    pending: number;
    replans: number;
    retries: number;
  };
  /** Nodes that cannot run right now because a permission is missing. */
  blockers: { nodeId: string; tool: string; missingPermissions: string[] }[];
  lastReplanReason?: string;
}

/** Domain of a capability/tool name — deterministic prefix mapping. */
export function domainOf(capabilityOrTool: string | undefined): PlanDomain {
  const s = (capabilityOrTool ?? '').toLowerCase();
  if (s.startsWith('browser.') || s.startsWith('web.')) return 'browser';
  if (s.startsWith('computer.') || s.startsWith('keyboard.') || s.startsWith('mouse.')) return 'computer';
  if (s.startsWith('filesystem.') || s.startsWith('files.')) return 'filesystem';
  if (s.startsWith('application.') || s.startsWith('app.')) return 'application';
  if (s.startsWith('memory.')) return 'memory';
  if (s.startsWith('chat.') || s.startsWith('communication.')) return 'communication';
  return 'general';
}

/** Deterministic corrective-plan signature for duplicate detection (spec §7). */
export function correctiveSignature(stepId: string, errorKind: string, errorText: string): string {
  return `${stepId}|${errorKind}|${errorText.slice(0, 80).toLowerCase()}`;
}
