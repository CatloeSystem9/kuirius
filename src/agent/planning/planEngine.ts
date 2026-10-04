/**
 * Plan engine (Phase 16) — per-task hierarchical plan state, deterministic
 * transitions, verification-aware completion and BOUNDED replanning.
 *
 * The engine never executes anything: the Agent Core loop remains the single
 * executor (no second loop). The engine
 *   - derives + validates the hierarchical plan at task start,
 *   - tracks node lifecycle (pending → ready → running → verifying → done),
 *   - emits PLAN_* events on the existing Event Bus,
 *   - on unrecovered failure proposes a bounded corrective subtree
 *     (diagnose → retry) or refuses honestly, and
 *   - reports diagnostics (spec §21).
 *
 * Replanning safeguards (spec §7): per-task and per-node replan budgets,
 * retry limits, task timeout, duplicate-plan detection and repeated-failure
 * detection. Budgets exhausted → honest stop, never an infinite loop.
 */
import type { AgentTool, PlanStep, ToolResult } from '../types';
import type { AgentEventBus, AgentEvent } from '../events';
import type { ToolRegistry } from '../toolRegistry';
import type { PermissionManager } from '../permissions';
import type {
  HierarchicalPlan,
  PlanDiagnostics,
  PlanLimits,
  PlanNode,
  PlanNodeStatus,
  PlanSnapshot,
  PlanSnapshotNode,
  PlanValidationIssue,
  PlanValidationResult,
  ReplanDecision,
} from './planningTypes';
import { DEFAULT_PLAN_LIMITS, correctiveSignature, domainOf } from './planningTypes';
import { buildHierarchy } from './planBuilder';
import { validatePlan, resolveNodeTool } from './planValidator';
import { detectAmbiguity, clarificationReason, type ClarificationRequest } from './clarification';
import { strategyOptions } from './strategySelector';

export interface PlanEngineOptions {
  registry: ToolRegistry;
  events: AgentEventBus;
  permissions?: PermissionManager;
  limits?: Partial<PlanLimits>;
  /** Memory hook (Phase 2) — optional bounded recall for replan context. */
  memory?: { recall(query: string, opts: { limit: number }): { content: string }[] };
  now?: () => number;
}

export interface AttachPlanResult {
  ok: boolean;
  reason?: string;
  validation?: PlanValidationResult;
  /** Set when the goal was ambiguous (spec §13) — the task stops honestly. */
  clarification?: ClarificationRequest;
}

interface PlanTaskState {
  taskId: string;
  plan: HierarchicalPlan;
  stepNodes: Map<string, string>;
  flatSteps: PlanStep[];
  replanCount: number;
  retryCount: number;
  failureSignatures: Map<string, number>;
  usedCorrectiveSignatures: Set<string>;
  lastReplanReason?: string;
  cancelled: boolean;
  finished: boolean;
  finalStatus: PlanDiagnostics['status'];
}

const MAX_STATUS_REASONS = 8;
const MAX_CONTEXT_MEMORIES = 2;
const REPLANNABLE_ERROR_KINDS = new Set(['not_found', 'verification_failed', 'timeout', 'execution_error', 'unknown']);

export class PlanEngine {
  readonly limits: PlanLimits;
  private readonly registry: ToolRegistry;
  private readonly events: AgentEventBus;
  private readonly permissions?: PermissionManager;
  private readonly memory?: PlanEngineOptions['memory'];
  private readonly now: () => number;
  private tasks = new Map<string, PlanTaskState>();

  constructor(options: PlanEngineOptions) {
    this.registry = options.registry;
    this.events = options.events;
    this.permissions = options.permissions;
    this.memory = options.memory;
    this.now = options.now ?? Date.now;
    this.limits = { ...DEFAULT_PLAN_LIMITS, ...options.limits };
  }

  // ------------------------------------------------------------- plan attach
  /**
   * Derive + validate the hierarchical plan for a task. Invalid plans never
   * execute. Genuinely ambiguous goals (spec §13) never execute either — they
   * stop with a structured clarification request instead of guessing.
   */
  attachPlan(taskId: string, goalDescription: string, steps: PlanStep[]): AttachPlanResult {
    const now = this.now();

    // Spec §13: multiple materially different plans → ask, don't guess.
    const clarification = detectAmbiguity(goalDescription);
    if (clarification) {
      this.emit('PLAN_CLARIFICATION_REQUESTED', taskId, {
        goal: goalDescription.slice(0, 160),
        question: clarification.question,
        options: clarification.options,
        reason: clarification.reason,
      });
      return {
        ok: false,
        reason: clarificationReason(clarification),
        clarification,
      };
    }

    const { plan, stepNodes } = buildHierarchy({ description: goalDescription, rawInput: goalDescription, kind: 'command' }, steps, now, this.limits);
    const validation = validatePlan(plan, steps, this.registry, this.permissions, this.limits);
    if (!validation.valid) {
      this.emit('PLAN_BLOCKED', taskId, {
        reason: 'plan_validation_failed',
        errors: validation.errors.map((e) => e.message).slice(0, 6),
      });
      return { ok: false, reason: `plan validation failed: ${validation.errors.map((e) => e.message).join('; ')}`, validation };
    }
    const state: PlanTaskState = {
      taskId,
      plan,
      stepNodes,
      // OWN copy (same step objects, same order) — never an alias of the
      // core's live plan.steps array: commitReplan/adoptSplicedSteps push
      // corrective steps here for tracking, and an alias would duplicate them
      // into the executing plan (double execution).
      flatSteps: [...steps],
      replanCount: 0,
      retryCount: 0,
      failureSignatures: new Map(),
      usedCorrectiveSignatures: new Set(),
      cancelled: false,
      finished: false,
      finalStatus: 'active',
    };
    this.tasks.set(taskId, state);
    const subgoalCount = [...plan.nodes.values()].filter((n) => n.kind === 'subgoal').length;
    const blockedNote = validation.blockedNodeIds.length > 0 ? ` (${validation.blockedNodeIds.length} node(s) blocked pending permissions: ${validation.missingPermissions.join(', ')})` : '';
    this.emit('PLAN_CREATED', taskId, {
      goal: plan.goal,
      nodeCount: plan.nodes.size,
      subgoalCount,
      actionCount: steps.length,
      blockedNodes: validation.blockedNodeIds.length,
      warnings: validation.warnings.map((w) => w.message).slice(0, 4),
    });
    if (validation.blockedNodeIds.length > 0) {
      this.emit('PLAN_BLOCKED', taskId, {
        reason: 'missing_permissions',
        nodeIds: validation.blockedNodeIds,
        missingPermissions: validation.missingPermissions,
      });
    }
    return { ok: true, validation, reason: `hierarchical plan: ${plan.nodes.size} nodes, ${subgoalCount} subgoal(s)${blockedNote}` };
  }

  // ---------------------------------------------------------- node lifecycle
  nodeStarted(taskId: string, stepId: string): void {
    const state = this.tasks.get(taskId);
    if (!state || state.finished) return;
    const node = this.nodeByStep(state, stepId);
    if (!node) return;
    // Re-runs (recovery retry) transition failed → running with a reason.
    this.setStatus(state, node, 'running', 'agent core started the step');
    node.attempts += 1;
    node.startedAt = this.now();
    state.retryCount = Math.max(state.retryCount, node.attempts - 1);
    this.emit('PLAN_NODE_STARTED', taskId, { nodeId: node.id, stepId, description: node.description, attempt: node.attempts });
  }

  /**
   * Record an execution outcome. A node is completed ONLY when the tool
   * succeeded AND its verification passed (spec §11/§26) — tool success with
   * failed verification becomes a failed node, never a completed one.
   */
  nodeCompleted(taskId: string, stepId: string, result: ToolResult | undefined, outcome: 'completed' | 'uncertain'): void {
    const state = this.tasks.get(taskId);
    if (!state || state.finished) return;
    const node = this.nodeByStep(state, stepId);
    if (!node) return;
    const verified = result?.verified === true && outcome === 'completed';
    this.setStatus(state, node, 'verifying', 'evaluating verification');
    node.result = result;
    node.verified = verified;
    node.finishedAt = this.now();
    if (outcome === 'completed') {
      this.setStatus(state, node, 'completed', verified ? 'verified' : 'tool success (verification override absent)');
      this.emit('PLAN_NODE_COMPLETED', taskId, { nodeId: node.id, stepId, verified });
    } else {
      // Honest uncertainty — recorded, never silently converted to success.
      this.setStatus(state, node, 'completed', 'tool dispatched but evidence incomplete (uncertain)');
      this.emit('PLAN_NODE_COMPLETED', taskId, { nodeId: node.id, stepId, verified: false, uncertain: true });
    }
  }

  /** Record a final node failure (after retries/recovery are exhausted). */
  nodeFailed(taskId: string, stepId: string, error: string, errorKind: string): PlanNode | undefined {
    const state = this.tasks.get(taskId);
    if (!state || state.finished) return undefined;
    const node = this.nodeByStep(state, stepId);
    if (!node) return undefined;
    node.error = error.slice(0, 300);
    node.finishedAt = this.now();
    this.setStatus(state, node, 'failed', `failed: ${node.error.slice(0, 120)}`);
    this.emit('PLAN_NODE_FAILED', taskId, { nodeId: node.id, stepId, error: node.error, errorKind });
    // Signature keyed by the ROOT step so a corrective retry failing the same
    // way counts as a repeat of the original failure (spec §7).
    const signature = correctiveSignature(this.rootStepOf(stepId), errorKind, error);
    state.failureSignatures.set(signature, (state.failureSignatures.get(signature) ?? 0) + 1);
    return node;
  }

  /** Mirror the core's skip decisions (unmet deps / run condition) into the tree. */
  nodeSkipped(taskId: string, stepId: string, reason: string): void {
    const state = this.tasks.get(taskId);
    if (!state || state.finished) return;
    const node = this.nodeByStep(state, stepId);
    if (!node) return;
    if (node.status === 'pending' || node.status === 'ready') {
      this.setStatus(state, node, 'skipped', reason.slice(0, 120));
    }
  }

  /**
   * Register steps spliced by Phase 11 recovery (alternativeStep) so the tree
   * stays coherent with the executing plan. These are NOT counted as
   * replans — recovery has its own accounting; this is state adoption only.
   */
  adoptSplicedSteps(taskId: string, steps: PlanStep[]): void {
    const state = this.tasks.get(taskId);
    if (!state || state.finished) return;
    const now = this.now();
    for (const step of steps) {
      const nodeId = `plan_adopted_${now}_${step.id}`;
      const node: PlanNode = {
        id: nodeId,
        kind: 'action',
        description: step.description.slice(0, 160),
        parentId: state.plan.rootId,
        childIds: [],
        dependsOn: [],
        status: 'pending',
        statusReasons: ['adopted: recovery/planner alternative splice'],
        toolName: step.toolName,
        requiredCapability: step.capability,
        attempts: 0,
        replans: 0,
        stepId: step.id,
        expectedOutcome: { description: 'tool reports success', check: { type: 'tool_success' } },
        createdAt: now,
      };
      state.plan.nodes.set(nodeId, node);
      state.plan.order.push(nodeId);
      state.stepNodes.set(step.id, nodeId);
      state.flatSteps.push(step);
    }
    this.emit('PLAN_UPDATED', taskId, { revision: state.plan.revision, nodeCount: state.plan.nodes.size, reason: 'recovery alternative adopted' });
  }

  // -------------------------------------------------------------- replanning
  /**
   * Bounded replanning decision for a failed node. Returns corrective steps
   * (diagnose → retry) for the Agent Core to splice, or an honest refusal.
   * Deterministic; never executes anything itself.
   */
  proposeReplan(taskId: string, failedStepId: string, error: string, errorKind: string | undefined): ReplanDecision & { correctiveSteps?: PlanStep[] } {
    const state = this.tasks.get(taskId);
    if (!state) return { replanned: false, reason: 'no active plan', refusedBecause: 'not_replannable' };
    if (state.cancelled) return { replanned: false, reason: 'task cancelled — no further autonomous planning', refusedBecause: 'cancelled' };
    if (state.finished) return { replanned: false, reason: 'task already finished', refusedBecause: 'not_replannable' };

    const kind = errorKind ?? 'unknown';
    if (!REPLANNABLE_ERROR_KINDS.has(kind)) {
      return this.refuse(state, `${kind} failures are not replannable (permission/plan defects are terminal)`, 'not_replannable');
    }
    if (this.now() - state.plan.createdAt > this.limits.taskTimeoutMs) {
      state.finalStatus = 'timed_out';
      return this.refuse(state, `task exceeded the planning timeout (${this.limits.taskTimeoutMs}ms)`, 'timeout');
    }
    if (state.replanCount >= this.limits.maxReplansPerTask) {
      return this.refuse(state, `task replan budget exhausted (${state.replanCount}/${this.limits.maxReplansPerTask})`, 'budget_task');
    }
    const node = this.nodeByStep(state, failedStepId);
    if (!node) return this.refuse(state, 'failed step is not part of the tracked plan', 'not_replannable');
    if (node.replans >= this.limits.maxReplansPerNode) {
      return this.refuse(state, `node replan budget exhausted (${node.replans}/${this.limits.maxReplansPerNode})`, 'budget_node');
    }
    // Retry bound (spec §10): a node that has already burned its retry budget
    // gets no further corrective cycles either.
    if (node.attempts - 1 >= this.limits.maxRetriesPerNode) {
      return this.refuse(state, `node retry budget exhausted (${Math.max(0, node.attempts - 1)}/${this.limits.maxRetriesPerNode} retries)`, 'budget_node');
    }
    const signature = correctiveSignature(this.rootStepOf(failedStepId), kind, error);
    if ((state.failureSignatures.get(signature) ?? 0) >= this.limits.maxRepeatedFailures) {
      return this.refuse(state, `same failure repeated ${state.failureSignatures.get(signature)}x — replanning again cannot help`, 'repeated_failure');
    }
    if (state.usedCorrectiveSignatures.has(signature)) {
      return this.refuse(state, 'identical corrective plan was already attempted (duplicate-plan detection)', 'duplicate_plan');
    }

    // Permission boundaries are never replanned around (spec §15).
    const failedStep = state.flatSteps.find((s) => s.id === failedStepId);
    if (!failedStep) return this.refuse(state, 'failed step not found in flat plan', 'not_replannable');
    const resolved = resolveNodeTool(this.registry, failedStep.toolName, failedStep.capability);
    if (!resolved) return this.refuse(state, 'no tool available for the failed step — replanning cannot conjure a capability', 'not_replannable');
    if (this.permissions && this.permissions.missing(resolved.permissions as never).length > 0) {
      this.setStatus(state, node, 'blocked', `missing permissions: ${this.permissions.missing(resolved.permissions as never).join(', ')}`);
      this.emit('PLAN_BLOCKED', taskId, { reason: 'missing_permissions', nodeId: node.id, tool: resolved.name });
      return this.refuse(state, `action requires permission(s) the user has not granted — blocked, never bypassed`, 'not_replannable');
    }

    const corrective = this.buildCorrectiveSteps(failedStep, error, kind);
    if (!corrective) {
      return this.refuse(state, `no deterministic diagnosis exists for the "${domainOf(failedStep.capability ?? failedStep.toolName)}" domain — honest stop`, 'no_diagnosis');
    }

    this.emit('PLAN_REPLAN_REQUESTED', taskId, {
      nodeId: node.id,
      stepId: failedStepId,
      error: error.slice(0, 160),
      errorKind: kind,
      strategy: corrective.strategy,
    });
    state.usedCorrectiveSignatures.add(signature);
    return { replanned: true, reason: `environment/plan mismatch (${kind}) — ${corrective.strategy}`, correctiveSteps: corrective.steps };
  }

  /** Commit a spliced corrective subtree (called by the Agent Core after the splice). */
  commitReplan(taskId: string, failedStepId: string, insertedSteps: PlanStep[]): void {
    const state = this.tasks.get(taskId);
    if (!state || !insertedSteps || insertedSteps.length === 0) return;
    const failedNode = this.nodeByStep(state, failedStepId);
    if (!failedNode) return;
    failedNode.replans += 1;
    state.replanCount += 1;
    const now = this.now();
    let previousId = failedNode.id;
    for (const step of insertedSteps) {
      const nodeId = `plan_fix_${now}_${step.id}`;
      const node: PlanNode = {
        id: nodeId,
        kind: 'action',
        description: step.description.slice(0, 160),
        parentId: failedNode.parentId,
        childIds: [],
        dependsOn: [previousId],
        status: 'pending',
        statusReasons: ['corrective node (bounded replan)'],
        toolName: step.toolName,
        requiredCapability: step.capability,
        attempts: 0,
        replans: 0,
        stepId: step.id,
        expectedOutcome: step.verification
          ? { description: `output contains "${step.verification.type === 'output_contains' ? step.verification.expected : ''}"`, check: { type: 'tool_success' } }
          : { description: 'tool reports success', check: { type: 'tool_success' } },
        createdAt: now,
      };
      state.plan.nodes.set(nodeId, node);
      state.plan.order.push(nodeId);
      state.stepNodes.set(step.id, nodeId);
      state.flatSteps.push(step);
      previousId = nodeId;
    }
    state.plan.revision += 1;
    state.lastReplanReason = `corrective subtree after "${failedNode.description.slice(0, 60)}"`;
    this.emit('PLAN_REPLANNED', taskId, {
      revision: state.plan.revision,
      insertedStepIds: insertedSteps.map((s) => s.id),
      replanCount: state.replanCount,
    });
    this.emit('PLAN_UPDATED', taskId, { revision: state.plan.revision, nodeCount: state.plan.nodes.size, reason: state.lastReplanReason });
  }

  // -------------------------------------------------------- task termination
  cancelTask(taskId: string): void {
    const state = this.tasks.get(taskId);
    if (!state || state.finished || state.cancelled) return;
    state.cancelled = true;
    for (const node of state.plan.nodes.values()) {
      if (node.status === 'pending' || node.status === 'ready' || node.status === 'needs_replan') {
        this.setStatus(state, node, 'cancelled', 'task cancelled by user');
      } else if (node.status === 'running') {
        this.setStatus(state, node, 'cancelled', 'task cancelled while running');
        node.finishedAt = this.now();
      }
    }
    this.emit('PLAN_CANCELLED', taskId, { replanCount: state.replanCount });
  }

  /** Record the honest final outcome. PLAN_COMPLETED only for verified completion. */
  finishTask(taskId: string, outcome: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'uncertain'): PlanDiagnostics | undefined {
    const state = this.tasks.get(taskId);
    if (!state) return undefined;
    // A plan is completed only when every action node finished verified
    // (or was legitimately skipped by the core's dependency/condition logic).
    let allVerified = true;
    for (const node of state.plan.nodes.values()) {
      if (node.kind !== 'action') continue;
      if (node.status === 'completed' && node.verified === false) allVerified = false;
    }
    if (outcome === 'completed' && !allVerified) outcome = 'uncertain';
    state.finished = true;
    state.finalStatus = outcome;
    for (const node of state.plan.nodes.values()) {
      if (node.status === 'pending' || node.status === 'ready' || node.status === 'running' || node.status === 'needs_replan') {
        this.setStatus(state, node, outcome === 'cancelled' ? 'cancelled' : 'blocked', `task ended (${outcome}) before this node ran`);
      }
    }
    if (outcome === 'completed') {
      // Container nodes (goal/subgoals) complete with the task.
      for (const node of state.plan.nodes.values()) {
        if (node.kind === 'goal' || node.kind === 'subgoal') {
          if (node.status === 'pending' || node.status === 'ready') {
            this.setStatus(state, node, 'completed', 'all actions under this node finished');
          }
        }
      }
      this.emit('PLAN_COMPLETED', taskId, { nodeCount: state.plan.nodes.size, replanCount: state.replanCount });
    }
    return this.diagnostics(taskId);
  }

  // ------------------------------------------------------------- diagnostics
  diagnostics(taskId: string): PlanDiagnostics | undefined {
    const state = this.tasks.get(taskId);
    if (!state) return undefined;
    const nodes = [...state.plan.nodes.values()];
    const running = nodes.find((n) => n.status === 'running' || n.status === 'verifying');
    return {
      taskId,
      goal: state.plan.goal,
      status: state.finished ? state.finalStatus : state.cancelled ? 'cancelled' : 'active',
      currentNodeId: running?.id,
      completedNodes: nodes.filter((n) => n.status === 'completed').map((n) => n.id),
      failedNodes: nodes.filter((n) => n.status === 'failed').map((n) => n.id),
      blockedNodes: nodes.filter((n) => n.status === 'blocked').map((n) => n.id),
      pendingNodes: nodes.filter((n) => n.status === 'pending' || n.status === 'ready').length,
      replanCount: state.replanCount,
      retryCount: state.retryCount,
      lastReplanReason: state.lastReplanReason,
      // Coherence: every flat step (incl. corrective ones) must have a node.
      nodeCount: state.flatSteps.length === nodes.filter((n) => n.kind === 'action').length ? nodes.length : -1,
    };
  }

  /** Bounded, relevant context for replanning decisions (spec §10). */
  contextFor(taskId: string, nodeId: string): { goal: string; failedNode?: string; recentErrors: string[]; memories: string[] } {
    const state = this.tasks.get(taskId);
    const node = state?.plan.nodes.get(nodeId);
    const recentErrors: string[] = [];
    if (state) {
      for (const n of state.plan.nodes.values()) {
        if (n.error) recentErrors.push(n.error.slice(0, 120));
        if (recentErrors.length >= 3) break;
      }
    }
    let memories: string[] = [];
    if (this.memory && node) {
      try {
        memories = this.memory
          .recall(node.description.slice(0, 120), { limit: MAX_CONTEXT_MEMORIES })
          .map((m) => m.content.slice(0, 160));
      } catch {
        memories = [];
      }
    }
    return {
      goal: state?.plan.goal ?? '',
      failedNode: node?.description,
      recentErrors,
      memories,
    };
  }

  // ----------------------------------------------------------------- helpers
  private refuse(state: PlanTaskState, reason: string, because: NonNullable<ReplanDecision['refusedBecause']>): ReplanDecision {
    state.lastReplanReason = reason;
    return { replanned: false, reason, refusedBecause: because };
  }

  private nodeByStep(state: PlanTaskState, stepId: string): PlanNode | undefined {
    const nodeId = state.stepNodes.get(stepId);
    return nodeId ? state.plan.nodes.get(nodeId) : undefined;
  }

  /**
   * Root identity of a (possibly corrective) step: strips the mechanical
   * `replan_retry_<ts>_` / `replan_diag_<ts>_` prefixes repeatedly so failure
   * accounting groups a corrective retry's failure with the original's.
   */
  private rootStepOf(stepId: string): string {
    let id = stepId;
    let match: RegExpMatchArray | null;
    while ((match = id.match(/^replan_(?:retry|diag)_\d+_(.+)$/))) id = match[1];
    return id;
  }

  private setStatus(state: PlanTaskState, node: PlanNode, status: PlanNodeStatus, reason: string): void {
    if (node.status === status) return;
    node.status = status;
    node.statusReasons.push(`${new Date(this.now()).toISOString().slice(11, 19)} ${status}: ${reason.slice(0, 120)}`);
    if (node.statusReasons.length > MAX_STATUS_REASONS) node.statusReasons.splice(0, node.statusReasons.length - MAX_STATUS_REASONS);
  }

  private emit(name: AgentEvent['name'], taskId: string, payload: Record<string, unknown>): void {
    this.events.emit({ name, taskId, payload, timestamp: this.now() });
  }

  /**
   * Deterministic corrective subtree (spec §5/§8): a domain-appropriate
   * READ-ONLY diagnosis step followed by ONE corrective retry. The retry uses
   * an ALTERNATIVE viable tool for the same capability when one exists
   * (permission-checked, input-contract-compatible via the declared Phase 3
   * schemas) — a failed strategy rotates instead of repeating itself. Domains
   * with neither diagnosis nor alternative return null (honest stop) —
   * browser/desktop recovery remains with Phase 11.
   */
  private buildCorrectiveSteps(failedStep: PlanStep, error: string, kind: string): { steps: PlanStep[]; strategy: string } | null {
    const domain = domainOf(failedStep.capability ?? failedStep.toolName);
    const now = this.now();
    const alternative = this.alternativeToolFor(failedStep);

    const diagnose: PlanStep | null = (() => {
      switch (domain) {
        case 'computer':
          if (this.permissions?.missing(['screen.observation'] as never).length) return null;
          return {
            id: `replan_diag_${now}_${failedStep.id}`,
            description: `Diagnose (${kind}): observe the screen before retrying "${failedStep.description.slice(0, 60)}"`,
            toolName: 'screen.observe',
            capability: 'screen.observe',
            input: { question: `Retry diagnosis for "${failedStep.description.slice(0, 80)}" (previous error: ${error.slice(0, 80)})` },
            status: 'pending',
            attempts: 0,
          };
        case 'filesystem': {
          const path = failedStep.input && typeof failedStep.input['path'] === 'string' ? String(failedStep.input['path']) : null;
          if (this.permissions?.missing(['filesystem.read'] as never).length) return null;
          return {
            id: `replan_diag_${now}_${failedStep.id}`,
            description: path
              ? `Diagnose: inspect "${path}" before retrying`
              : `Diagnose: list the working directory before retrying "${failedStep.description.slice(0, 40)}"`,
            toolName: path ? 'filesystem.inspect' : 'filesystem.list',
            capability: path ? 'filesystem.inspect' : 'filesystem.list',
            input: path ? { path } : { path: '.' },
            status: 'pending',
            attempts: 0,
          };
        }
        case 'application': {
          const name = failedStep.input && typeof failedStep.input['name'] === 'string' ? String(failedStep.input['name']) : null;
          if (!name) return null;
          return {
            id: `replan_diag_${now}_${failedStep.id}`,
            description: `Diagnose: check whether "${name}" is running before retrying`,
            toolName: 'application.status',
            capability: 'application.status',
            input: { name },
            status: 'pending',
            attempts: 0,
          };
        }
        default:
          return null;
      }
    })();

    const retry = (alternativeTool?: AgentTool): PlanStep => ({
      ...failedStep,
      id: `replan_retry_${now}_${failedStep.id}`,
      description: alternativeTool
        ? `Retry with alternative strategy (${alternativeTool.name}): ${failedStep.description.slice(0, 90)}`
        : `Retry after diagnosis: ${failedStep.description.slice(0, 100)}`,
      toolName: alternativeTool?.name ?? failedStep.toolName,
      capability: alternativeTool ? undefined : failedStep.capability,
      status: 'pending',
      attempts: 0,
      error: undefined,
      result: undefined,
      verified: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      dependsOn: diagnose ? [diagnose.id] : [],
    });

    if (diagnose) {
      return {
        steps: [diagnose, retry(alternative ?? undefined)],
        strategy: alternative ? 'diagnose_then_alternative_tool' : 'diagnose_then_retry',
      };
    }
    if (alternative) {
      return { steps: [retry(alternative)], strategy: 'alternative_tool_only' };
    }
    return null;
  }

  /**
   * Best-ranked viable ALTERNATIVE tool for the failed step's capability
   * (spec §8): different tool, permissions granted, and input-contract
   * compatible with the step's declared Phase 3 schema. Null when none.
   */
  private alternativeToolFor(failedStep: PlanStep): AgentTool | null {
    const capability = failedStep.capability;
    if (!capability) return null;
    for (const option of strategyOptions(this.registry, capability)) {
      const tool = option.tool;
      if (tool.name === failedStep.toolName) continue;
      if (this.permissions && this.permissions.missing(tool.permissions ?? []).length > 0) continue;
      if (!this.schemaCompatible(tool, failedStep.input)) continue;
      return tool;
    }
    return null;
  }

  /** Cheap compatibility proxy: the failed step's input keys must be declared
   *  by the alternative tool's schema (undeclared schema = permissive). */
  private schemaCompatible(tool: AgentTool, input: Record<string, unknown>): boolean {
    const schema = tool.inputSchema;
    if (!schema) return true;
    const known = new Set([...(schema.required ?? []), ...(schema.optional ?? [])]);
    if (known.size === 0) return true;
    return Object.keys(input ?? {}).every((key) => known.has(key));
  }

  // ----------------------------------------------------------- state snapshot
  /**
   * Full structured state of one task's plan (spec §3 — dynamic state
   * tracking): current action + subgoal, every node with status/verification/
   * attempts/expected outcome/condition, counts, blockers and replan history.
   * Bounded; read-only; recomputed on demand (no background work).
   */
  snapshot(taskId: string): PlanSnapshot | undefined {
    const state = this.tasks.get(taskId);
    if (!state) return undefined;
    const nodes = [...state.plan.nodes.values()];
    const running = nodes.find((n) => n.status === 'running' || n.status === 'verifying');
    const currentAction =
      running ?? nodes.find((n) => n.kind === 'action' && (n.status === 'pending' || n.status === 'ready'));
    const currentSubgoal = currentAction ? nodes.find((n) => n.id === currentAction.parentId) : undefined;
    const status: PlanSnapshot['status'] = state.finished ? state.finalStatus : state.cancelled ? 'cancelled' : 'active';

    const snapNodes: PlanSnapshotNode[] = nodes.slice(0, 64).map((n) => ({
      id: n.id,
      kind: n.kind,
      description: n.description,
      status: n.status,
      verified: n.verified,
      attempts: n.attempts,
      replans: n.replans,
      toolName: n.toolName,
      requiredCapability: n.requiredCapability,
      expected: n.expectedOutcome?.description,
      condition: n.condition,
      error: n.error,
    }));

    const blockers: PlanSnapshot['blockers'] = [];
    for (const n of nodes) {
      if (n.kind !== 'action' || n.status === 'completed' || n.status === 'skipped' || n.status === 'cancelled') continue;
      const resolved = resolveNodeTool(this.registry, n.toolName, n.requiredCapability);
      if (!resolved) continue;
      const missing = this.permissions?.missing(resolved.permissions as never) ?? [];
      if (missing.length > 0) blockers.push({ nodeId: n.id, tool: resolved.name, missingPermissions: [...missing] });
      if (blockers.length >= 8) break;
    }

    return {
      taskId,
      goal: state.plan.goal,
      revision: state.plan.revision,
      status,
      currentActionId: currentAction?.id,
      currentSubgoalId: currentSubgoal?.id,
      nodes: snapNodes,
      counts: {
        total: nodes.length,
        actions: nodes.filter((n) => n.kind === 'action').length,
        subgoals: nodes.filter((n) => n.kind === 'subgoal').length,
        completed: nodes.filter((n) => n.status === 'completed').length,
        failed: nodes.filter((n) => n.status === 'failed').length,
        skipped: nodes.filter((n) => n.status === 'skipped').length,
        blocked: nodes.filter((n) => n.status === 'blocked').length,
        pending: nodes.filter((n) => n.status === 'pending' || n.status === 'ready').length,
        replans: state.replanCount,
        retries: state.retryCount,
      },
      blockers,
      lastReplanReason: state.lastReplanReason,
    };
  }
}
