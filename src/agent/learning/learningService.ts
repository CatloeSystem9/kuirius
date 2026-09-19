/**
 * Learning Service (Phase 12 — Learning + Workflow Acquisition).
 *
 * Turns real task outcomes and user corrections into reusable, bounded,
 * structured knowledge — without a second planner, memory database, or
 * agent loop:
 *
 *   TASK_COMPLETED ─▶ learn/verify workflow evidence ─▶ confidence ▲
 *   TASK_FAILED    ─▶ failure evidence / no creation  ─▶ confidence ▼
 *   USER_MESSAGE   ─▶ durable corrections attached to matching workflows
 *   TOOL_COMPLETED / TOOL_FAILED ─▶ per-capability strategy statistics
 *
 * Learned workflows are SUGGESTIONS to the existing planner (see
 * WorkflowAwarePlanner): reuse still runs every step through the Agent Core's
 * verification, retry, recovery, permission, cancellation, and timeout stack.
 * Matching is local and deterministic (token similarity) — no model calls.
 */
import type { AgentEvent, AgentEventBus } from '../events';
import type { ToolRegistry } from '../toolRegistry';
import { selectToolForCapability } from '../toolSelector';
import type { AgentGoal, AgentPlan, AgentTask, PlanStep } from '../types';
import { similarity } from '../memory/similarity';
import { detectCorrection } from '../memory/memoryService';
import type { MemoryService } from '../memory/memoryService';
import { localStorageAdapter } from '../taskState';
import type { StorageAdapter } from '../taskState';
import {
  LearningWorkflowStore,
  MAX_EVIDENCE_PER_WORKFLOW,
  MAX_CORRECTIONS_PER_WORKFLOW,
} from './workflowStore';
import type { StrategyStat } from './workflowStore';
import type {
  CorrectionRecord,
  LearnOutcome,
  LearnedWorkflow,
  OutcomeKind,
  WorkflowCandidate,
  WorkflowStep,
} from './learningTypes';
import {
  applyOutcomeToConfidence,
  confidenceLevel,
  isReusable,
  sanitizeTemplate,
  toWorkflowStep,
} from './learningTypes';

/** Minimum trigger-similarity for a new outcome to reinforce an existing workflow. */
export const GOAL_MATCH_THRESHOLD = 0.5;
/** Minimum candidate score before a learned workflow may shape a new plan. */
export const REUSE_MIN_SCORE = 0.55;
/** A workflow must have produced at least one additional verified success after creation to be reusable. */
const INITIAL_CONFIDENCE = 0.4;

export interface LearningServiceOptions {
  registry: ToolRegistry;
  events: AgentEventBus;
  /** Injectable store (tests); defaults to the shared localStorage-backed store. */
  store?: LearningWorkflowStore;
  /** Optional Phase 2 memory integration (mirror + cross-link). */
  memory?: MemoryService;
  storage?: StorageAdapter;
  /** Resolves a task from its id so learning can read the executed plan (bridge wires the TaskStore). */
  taskResolver?: (taskId: string) => AgentTask | undefined;
}

export class LearningService {
  readonly registry: ToolRegistry;
  readonly events: AgentEventBus;
  readonly store: LearningWorkflowStore;
  private memory?: MemoryService;
  private taskResolver?: (taskId: string) => AgentTask | undefined;
  private detachFns: Array<() => void> = [];

  constructor(options: LearningServiceOptions) {
    this.registry = options.registry;
    this.events = options.events;
    this.store = options.store ?? new LearningWorkflowStore(options.storage ?? localStorageAdapter);
    this.memory = options.memory;
    this.taskResolver = options.taskResolver;
  }

  /** Subscribe to the existing event bus. Returns a detach function. */
  attach(): () => void {
    this.detach();

    this.detachFns.push(
      this.events.on('USER_MESSAGE', (event: AgentEvent) => {
        const input = String((event.payload as { input?: string } | undefined)?.input ?? '');
        if (input) this.recordCorrection(input);
      })
    );

    this.detachFns.push(
      this.events.on('TASK_COMPLETED', (event: AgentEvent) => {
        const task = event.taskId ? this.taskFromEvent(event) : undefined;
        if (task) this.learnFromTask(task);
      })
    );

    this.detachFns.push(
      this.events.on('TASK_FAILED', (event: AgentEvent) => {
        const task = event.taskId ? this.taskFromEvent(event) : undefined;
        if (task) this.learnFromTask(task);
      })
    );

    this.detachFns.push(
      this.events.on('TOOL_COMPLETED', (event: AgentEvent) => {
        const tool = String((event.payload as { tool?: string } | undefined)?.tool ?? '');
        const capability = this.capabilityOfTool(tool);
        if (capability) this.store.recordStrategyOutcome(capability, true, event.timestamp);
      })
    );

    this.detachFns.push(
      this.events.on('TOOL_FAILED', (event: AgentEvent) => {
        const tool = String((event.payload as { tool?: string } | undefined)?.tool ?? '');
        const capability = this.capabilityOfTool(tool);
        if (capability) this.store.recordStrategyOutcome(capability, false, event.timestamp);
      })
    );

    return () => this.detach();
  }

  detach(): void {
    for (const off of this.detachFns) off();
    this.detachFns = [];
  }

  // ---------------------------------------------------------------- learning

  /**
   * Learn from a finished task. Verified successes create or reinforce
   * executable workflows; failures only adjust confidence of an existing
   * match (a workflow is never created from a failure).
   */
  learnFromTask(task: AgentTask): LearnOutcome {
    if (!task.plan) return { learned: false, reason: 'no plan' };

    // A plan instantiated from a learned workflow updates THAT workflow's
    // usage statistics instead of creating a near-duplicate.
    if (task.plan.learnedFrom) {
      const outcome = this.outcomeOf(task);
      const updated = this.recordReuse(task.plan.learnedFrom.workflowId, outcome);
      return { learned: updated, workflowId: task.plan.learnedFrom.workflowId, reason: updated ? 'reuse outcome recorded' : 'workflow missing' };
    }

    const outcome = this.outcomeOf(task);
    const steps = this.executableSteps(task.plan.steps, outcome);

    // Failure evidence reinforces/damages an EXISTING workflow only — it never
    // creates one — so the 2-step minimum does not apply here.
    if (outcome === 'verified_failure' || outcome === 'unverified_failure') {
      return this.recordFailureEvidence(task, steps, outcome);
    }

    if (steps.length < 2) return { learned: false, reason: 'fewer than 2 executable steps' };

    // Safety: never learn workflows that chain high/critical-risk tools —
    // replaying those autonomously would bypass the "confirm risky actions"
    // boundary even though registry permissions still apply.
    if (steps.some((s) => this.riskOfTool(s) === 'high' || this.riskOfTool(s) === 'critical')) {
      return { learned: false, reason: 'workflow contains high/critical-risk steps' };
    }

    return this.recordSuccessEvidence(task, steps, outcome);
  }

  private recordSuccessEvidence(task: AgentTask, steps: WorkflowStep[], outcome: OutcomeKind): LearnOutcome {
    const goalPattern = this.normalizeGoal(task.goal.rawInput);
    const signature = stepSignature(steps);

    const existing = this.findMatchingWorkflow(goalPattern);
    if (existing) {
      if (existing.status !== 'active') {
        return { learned: false, workflowId: existing.id, reason: `workflow is ${existing.status}` };
      }

      const previousLevel = confidenceLevel(existing.confidence);
      existing.confidence = applyOutcomeToConfidence(existing.confidence, outcome);
      existing.evidence.push({ outcome, at: Date.now() });
      if (existing.evidence.length > MAX_EVIDENCE_PER_WORKFLOW) {
        existing.evidence = existing.evidence.slice(-MAX_EVIDENCE_PER_WORKFLOW);
      }

      // A different step sequence from a fresh verified success updates the
      // template as a new version — the workflow adapts instead of fossilizing.
      if (outcome === 'verified_success' && stepSignature(existing.steps) !== signature) {
        existing.steps = steps;
        existing.version += 1;
        existing.versionHistory.push({
          version: existing.version,
          createdAt: Date.now(),
          changeNote: 'step sequence updated from a new verified successful run',
        });
        if (existing.versionHistory.length > 10) existing.versionHistory = existing.versionHistory.slice(-10);
      }

      existing.updatedAt = Date.now();
      this.store.upsert(existing);
      this.events.emit({
        name: 'STRATEGY_UPDATED',
        payload: {
          workflowId: existing.id,
          confidence: existing.confidence,
          previousLevel,
          level: confidenceLevel(existing.confidence),
          outcome,
        },
        timestamp: Date.now(),
      });
      this.mirrorToMemory(existing);
      return { learned: true, workflowId: existing.id, version: existing.version, reason: 'reinforced existing workflow' };
    }

    // No match — create a candidate workflow (reusable only after repeated success).
    const workflow: LearnedWorkflow = {
      id: 'wf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: task.goal.description.slice(0, 60),
      trigger: {
        goalPattern,
        requiredCapabilities: Array.from(new Set(steps.map((s) => s.capability).filter((c): c is string => Boolean(c)))),
        domains: deriveDomains(steps),
      },
      steps,
      corrections: [],
      evidence: [{ outcome, at: Date.now() }],
      confidence: INITIAL_CONFIDENCE,
      status: 'active',
      version: 1,
      versionHistory: [],
      usage: { totalUses: 0, successfulUses: 0, failedUses: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.upsert(workflow);
    this.events.emit({
      name: 'WORKFLOW_LEARNED',
      payload: { workflowId: workflow.id, name: workflow.name, steps: steps.length, confidence: workflow.confidence },
      timestamp: Date.now(),
    });
    this.mirrorToMemory(workflow);
    return { learned: true, workflowId: workflow.id, version: workflow.version, reason: 'new workflow candidate' };
  }

  private recordFailureEvidence(task: AgentTask, steps: WorkflowStep[], outcome: OutcomeKind): LearnOutcome {
    const goalPattern = this.normalizeGoal(task.goal.rawInput);
    const existing = this.findMatchingWorkflow(goalPattern);
    if (!existing) return { learned: false, reason: 'failure does not create workflows' };

    const previousLevel = confidenceLevel(existing.confidence);
    existing.confidence = applyOutcomeToConfidence(existing.confidence, outcome);
    existing.evidence.push({ outcome, at: Date.now(), note: (task.error ?? 'unknown error').slice(0, 120) });
    if (existing.evidence.length > MAX_EVIDENCE_PER_WORKFLOW) {
      existing.evidence = existing.evidence.slice(-MAX_EVIDENCE_PER_WORKFLOW);
    }
    existing.knownFailurePoints = Array.from(
      new Set([...(existing.knownFailurePoints ?? []), ...steps.filter((s) => s.toolName).map((s) => s.toolName)])
    ).slice(-5);
    existing.updatedAt = Date.now();
    this.store.upsert(existing);
    this.events.emit({
      name: 'STRATEGY_UPDATED',
      payload: {
        workflowId: existing.id,
        confidence: existing.confidence,
        previousLevel,
        level: confidenceLevel(existing.confidence),
        outcome,
      },
      timestamp: Date.now(),
    });
    return { learned: true, workflowId: existing.id, version: existing.version, reason: 'failure evidence recorded' };
  }

  /** Attach a durable user correction to the matching workflow (if any). */
  recordCorrection(text: string): CorrectionRecord | null {
    const correction = detectCorrection(text);
    if (!correction.isCorrection) return null;

    this.events.emit({ name: 'USER_CORRECTION', payload: { durable: correction.durable }, timestamp: Date.now() });

    const match = this.findMatchingWorkflow(this.normalizeGoal(text));
    if (!match) return null;

    const record: CorrectionRecord = {
      id: 'corr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      workflowId: match.id,
      failureSummary: text.trim().slice(0, 120),
      correctedAction: text.trim().slice(0, 200),
      verified: false,
      createdAt: Date.now(),
    };
    match.corrections.push(record);
    if (match.corrections.length > MAX_CORRECTIONS_PER_WORKFLOW) {
      match.corrections = match.corrections.slice(-MAX_CORRECTIONS_PER_WORKFLOW);
    }
    // A correction means the current template disappointed the user at least
    // once — a small, bounded confidence reduction (never a hard delete).
    match.confidence = applyOutcomeToConfidence(match.confidence, 'unverified_failure');
    match.updatedAt = Date.now();
    this.store.upsert(match);
    this.events.emit({
      name: 'STRATEGY_UPDATED',
      payload: { workflowId: match.id, confidence: match.confidence, level: confidenceLevel(match.confidence), reason: 'user correction' },
      timestamp: Date.now(),
    });
    return record;
  }

  // ------------------------------------------------------------------ reuse

  /** Rank learned, reusable workflows against a new goal (deterministic, local). */
  suggest(goalText: string): WorkflowCandidate[] {
    const goalPattern = this.normalizeGoal(goalText);
    if (!goalPattern) return [];

    const candidates: WorkflowCandidate[] = [];
    for (const workflow of this.store.workflows) {
      if (!isReusable(workflow)) continue;

      const goalSimilarity = similarity(goalPattern, workflow.trigger.goalPattern);
      if (goalSimilarity < GOAL_MATCH_THRESHOLD) continue;

      const { coverage, reasons } = this.environmentCompatibility(workflow);
      if (coverage < 1) {
        reasons.push(`environment missing tools for ${Math.round((1 - coverage) * 100)}% of steps`);
      }

      const score = goalSimilarity * 0.6 + workflow.confidence * 0.25 + coverage * 0.15;
      candidates.push({
        workflow,
        score: Math.round(score * 1000) / 1000,
        goalSimilarity: Math.round(goalSimilarity * 1000) / 1000,
        capabilityCoverage: coverage,
        reasons,
      });
    }

    candidates.sort((a, b) => b.score - a.score || b.workflow.confidence - a.workflow.confidence);
    return candidates;
  }

  /**
   * Environment compatibility: every step must resolve to a concrete tool in
   * the CURRENT registry — by stored tool name, or by capability when the
   * original tool no longer exists (adaptation). Otherwise no reuse.
   */
  private environmentCompatibility(workflow: LearnedWorkflow): { coverage: number; reasons: string[] } {
    const reasons: string[] = [];
    let resolved = 0;
    for (const step of workflow.steps) {
      const tool = this.resolveToolForStep(step);
      if (tool) {
        resolved += 1;
        if (tool.name !== step.toolName) {
          reasons.push(`step ${step.order}: tool "${step.toolName}" replaced by "${tool.name}" via capability "${step.capability ?? 'n/a'}"`);
        }
      } else {
        reasons.push(`step ${step.order}: no tool for "${step.toolName}" (capability: ${step.capability ?? 'none'})`);
      }
    }
    return { coverage: workflow.steps.length === 0 ? 0 : resolved / workflow.steps.length, reasons };
  }

  private resolveToolForStep(step: WorkflowStep) {
    const direct = this.registry.get(step.toolName);
    if (direct) return direct;
    if (step.capability) {
      const selection = selectToolForCapability(this.registry, step.capability);
      if (selection) return selection.tool;
    }
    return null;
  }

  private riskOfTool(step: WorkflowStep): string {
    return this.resolveToolForStep(step)?.riskLevel ?? 'low';
  }

  /**
   * Instantiate a learned workflow as an AgentPlan — a strategy TEMPLATE whose
   * steps run through the normal Agent Core verification stack. Returns null
   * when no candidate is confident enough or the environment is incompatible.
   */
  planFromWorkflow(goal: AgentGoal): AgentPlan | null {
    const candidates = this.suggest(goal.rawInput);
    const best = candidates.find((c) => c.score >= REUSE_MIN_SCORE && c.capabilityCoverage === 1);
    if (!best) return null;

    const now = Date.now();
    const steps: PlanStep[] = best.workflow.steps.map((step, index) => ({
      id: `step_${now}_wf${index + 1}`,
      description: step.capability
        ? `${step.toolName} (${step.capability})`
        : step.toolName,
      toolName: step.toolName,
      capability: step.capability,
      input: sanitizeTemplate(step.inputTemplate),
      verification:
        step.verification?.type === 'output_contains' && step.verification.expected
          ? { type: 'output_contains', expected: step.verification.expected }
          : { type: 'tool_success' },
      observation: step.observation,
      status: 'pending',
      attempts: 0,
      outputKey: step.outputKey,
    }));

    this.events.emit({
      name: 'WORKFLOW_REUSED',
      payload: {
        workflowId: best.workflow.id,
        version: best.workflow.version,
        score: best.score,
        goalSimilarity: best.goalSimilarity,
        steps: steps.length,
      },
      timestamp: now,
    });

    return {
      goal,
      steps,
      createdAt: now,
      revision: 1,
      objective: goal.description,
      learnedFrom: { workflowId: best.workflow.id, version: best.workflow.version, score: best.score },
    };
  }

  /** Record the outcome of a reuse attempt against the reused workflow. */
  recordReuse(workflowId: string, outcome: OutcomeKind): boolean {
    const workflow = this.store.get(workflowId);
    if (!workflow) return false;

    workflow.usage.totalUses += 1;
    if (outcome === 'verified_success' || outcome === 'unverified_success') workflow.usage.successfulUses += 1;
    else workflow.usage.failedUses += 1;
    workflow.usage.lastUsedAt = Date.now();
    workflow.usage.lastOutcome = outcome;
    workflow.confidence = applyOutcomeToConfidence(workflow.confidence, outcome);
    workflow.updatedAt = Date.now();
    this.store.upsert(workflow);
    this.events.emit({
      name: 'STRATEGY_UPDATED',
      payload: { workflowId, confidence: workflow.confidence, level: confidenceLevel(workflow.confidence), outcome, source: 'reuse' },
      timestamp: Date.now(),
    });
    return true;
  }

  // ------------------------------------------------------------- management

  list(): LearnedWorkflow[] {
    return [...this.store.workflows];
  }

  get(id: string): LearnedWorkflow | undefined {
    return this.store.get(id);
  }

  disable(id: string): boolean {
    const workflow = this.store.get(id);
    if (!workflow) return false;
    workflow.status = 'disabled';
    workflow.updatedAt = Date.now();
    this.store.upsert(workflow);
    return true;
  }

  forget(id: string): boolean {
    return this.store.remove(id);
  }

  /** Per-capability success/failure statistics (tool preference learning). */
  strategyStats(): StrategyStat[] {
    return Array.from(this.store.strategyStats.values()).sort(
      (a, b) => b.successCount - b.failureCount - (a.successCount - a.failureCount)
    );
  }

  /** The best-performing capability for a task type, or null with no evidence. */
  preferredStrategy(capability: string): StrategyStat | null {
    return this.store.strategyStats.get(capability) ?? null;
  }

  stats(): { workflows: number; reusable: number; corrections: number; strategies: number } {
    return {
      workflows: this.store.workflows.length,
      reusable: this.store.workflows.filter((w) => isReusable(w)).length,
      corrections: this.store.workflows.reduce((sum, w) => sum + w.corrections.length, 0),
      strategies: this.store.strategyStats.size,
    };
  }

  reset(): void {
    this.store.clear();
  }

  // -------------------------------------------------------------- internals

  private taskFromEvent(event: AgentEvent): AgentTask | undefined {
    // Learning never blocks task flow; a missing task is a no-op.
    try {
      return this.taskResolver?.(event.taskId ?? '');
    } catch {
      return undefined;
    }
  }

  /**
   * Steps worth recording. Successful tasks contribute completed/uncertain
   * steps; failed tasks additionally contribute the failed steps so that
   * failure evidence and known failure points can be recorded at all.
   */
  private executableSteps(steps: PlanStep[], outcome?: OutcomeKind): WorkflowStep[] {
    const includeFailed = outcome === 'verified_failure' || outcome === 'unverified_failure';
    return steps
      .filter(
        (s) =>
          s.status === 'completed' ||
          s.status === 'uncertain' ||
          (includeFailed && s.status === 'failed')
      )
      .filter((s) => s.toolName !== 'system.note')
      .map((s, index) => toWorkflowStep(s, index + 1));
  }

  private outcomeOf(task: AgentTask): OutcomeKind {
    const verified =
      task.status === 'completed' &&
      (task.plan?.steps ?? []).every((s) => s.status === 'completed' || s.status === 'skipped' || s.status === 'uncertain');
    const anyUncertain = (task.plan?.steps ?? []).some((s) => s.status === 'uncertain');
    if (task.status === 'completed') return anyUncertain ? 'unverified_success' : verified ? 'verified_success' : 'unverified_success';
    return task.status === 'cancelled' ? 'unverified_failure' : 'verified_failure';
  }

  private findMatchingWorkflow(goalPattern: string): LearnedWorkflow | null {
    let best: LearnedWorkflow | null = null;
    let bestScore = GOAL_MATCH_THRESHOLD;
    for (const workflow of this.store.workflows) {
      const score = similarity(goalPattern, workflow.trigger.goalPattern);
      if (score > bestScore) {
        bestScore = score;
        best = workflow;
      }
    }
    return best;
  }

  private normalizeGoal(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  private capabilityOfTool(toolName: string): string | null {
    const tool = this.registry.get(toolName);
    const capability = tool?.capabilities?.[0];
    return capability ?? null;
  }

  /**
   * Phase 2 memory integration: reflect a reusable workflow into the existing
   * MemoryService. MemoryService.remember() merges duplicates (similarity ≥
   * 0.62), so repeated reinforcement raises confidence instead of duplicating,
   * and only a compact workflowId link is stored — never raw payloads.
   */
  private mirrorToMemory(workflow: LearnedWorkflow): void {
    if (!this.memory) return;
    const level = confidenceLevel(workflow.confidence);
    if (level !== 'usable' && level !== 'trusted') return;
    try {
      this.memory.remember(`Workflow: ${workflow.name}`, {
        category: 'workflow',
        source: 'workflow_learning',
        importance: 0.55,
        confidence: workflow.confidence,
        tags: ['phase12', 'reusable'],
        metadata: { workflowId: workflow.id, version: workflow.version, steps: workflow.steps.length },
      });
    } catch {
      // memory must never break learning
    }
  }
}

function stepSignature(steps: WorkflowStep[]): string {
  return steps.map((s) => `${s.toolName}|${s.capability ?? ''}`).join('>');
}

function deriveDomains(steps: WorkflowStep[]): string[] {
  const domains = new Set<string>();
  for (const step of steps) {
    const tool = step.toolName;
    if (tool.startsWith('browser.') || tool.startsWith('web.')) domains.add('browser');
    else if (tool.startsWith('filesystem.') || tool.startsWith('files.') || tool.startsWith('application.') || tool.startsWith('app.')) domains.add('system');
    else if (tool.startsWith('computer.') || tool.startsWith('keyboard.')) domains.add('desktop');
    else if (tool.startsWith('screen.')) domains.add('vision');
    else if (tool.startsWith('memory.')) domains.add('memory');
    else domains.add('general');
  }
  return Array.from(domains);
}
