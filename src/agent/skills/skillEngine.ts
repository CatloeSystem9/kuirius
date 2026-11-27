/**
 * Skill Engine (Learned Skills v1).
 *
 * Turns genuinely verified task executions into validated, reusable skills:
 *
 *   TASK_COMPLETED (verification = pass) ─▶ extract ─▶ validate ─▶ dedupe
 *     ─▶ store ─▶ mirror (Knowledge Graph + Memory)
 *   new task goal ─▶ match (similarity + Semantic Intelligence) ─▶ check
 *     reliability + environment + preconditions ─▶ instantiate plan
 *   skill-driven task ends ─▶ record outcome ─▶ smoothed reliability
 *
 * Hard boundaries (spec §5/§7):
 *  - skills are learned ONLY from tasks whose honest goal-level verification
 *    says 'pass' (Intelligence Loop v1) — never from failures, cancellations,
 *    uncertain results, user messages, or unverified model plans;
 *  - reuse NEVER bypasses the lifecycle: planFromSkill produces a normal
 *    AgentPlan that runs through the Agent Core, ToolRegistry and the
 *    Phase 18 SafetyGate like every other execution;
 *  - high/critical-risk workflows are never learned;
 *  - a single failure never collapses reliability (EWMA smoothing);
 *  - matching is local + deterministic (token similarity + bounded semantic
 *    expansion) — no model calls, no network, no background work.
 */
import type { AgentEvent, AgentEventBus } from '../events';
import type { ToolRegistry } from '../toolRegistry';
import type { AgentGoal, AgentPlan, AgentTask, PlanStep, ToolPermission } from '../types';
import type { PermissionManager } from '../permissions';
import { similarity } from '../memory/similarity';
import type { MemoryService } from '../memory/memoryService';
import { normalizeTerm, semanticOverlapFor } from '../semantic/index';
import type { SemanticIntelligence } from '../semantic/index';
import type { KnowledgeGraphFacade } from '../knowledge/index';
import type { StorageAdapter } from '../taskState';
import { localStorageAdapter } from '../taskState';
import type { OutcomeKind } from '../learning/learningTypes';
import { sanitizeTemplate, toWorkflowStep } from '../learning/learningTypes';
import { SkillStore } from './skillStore';
import { resolveSkillTool, validateSkill } from './skillValidator';
import type { LearnedSkill, SkillLearnOutcome, SkillMatch, SkillStep } from './skillTypes';
import {
  INITIAL_SKILL_RELIABILITY,
  MAX_VERSION_HISTORY,
  SKILL_DISABLE_BELOW,
  SKILL_GOAL_MATCH_THRESHOLD,
  SKILL_MIN_RELIABILITY,
  SKILL_REUSE_MIN_SCORE,
  SKILL_SEMANTIC_ACCEPT_OVERLAP,
  SKILL_SEMANTIC_ACCEPT_SIMILARITY,
  SKILL_SIMILAR_ACCEPT,
  applySkillOutcome,
  extractKeywords,
  isReusableSkill,
  skillSignature,
} from './skillTypes';

const SENSITIVE_PERMISSIONS = new Set<ToolPermission>([
  'filesystem.write',
  'application.launch',
  'terminal.execution',
  'mouse.control',
  'keyboard.control',
  'camera.access',
  'microphone.access',
]);

const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TRACKED_TASKS = 256;

export interface SkillEngineOptions {
  registry: ToolRegistry;
  events: AgentEventBus;
  /** StorageAdapter for bounded skill persistence (defaults to localStorage). */
  storage?: StorageAdapter;
  /** Semantic Intelligence for near-duplicate detection + goal matching. */
  semantic?: SemanticIntelligence;
  /** Knowledge Graph: learned skills are indexed as 'uses' relationships. */
  knowledgeGraph?: KnowledgeGraphFacade;
  /** Memory: reusable skills are mirrored as compact workflow records. */
  memory?: MemoryService;
  /** Permission preconditions are evaluated against this manager. */
  permissions?: PermissionManager;
  /** Resolves a task id so the engine can read the executed plan. */
  taskResolver?: (taskId: string) => AgentTask | undefined;
}

export class SkillEngine {
  readonly registry: ToolRegistry;
  readonly events: AgentEventBus;
  readonly store: SkillStore;
  private readonly semantic?: SemanticIntelligence;
  private readonly knowledgeGraph?: KnowledgeGraphFacade;
  private readonly memory?: MemoryService;
  private readonly permissions?: PermissionManager;
  private readonly taskResolver?: (taskId: string) => AgentTask | undefined;
  private readonly recordedTasks = new Set<string>();
  private detachFns: Array<() => void> = [];

  constructor(options: SkillEngineOptions) {
    this.registry = options.registry;
    this.events = options.events;
    this.store = new SkillStore(options.storage ?? localStorageAdapter);
    this.semantic = options.semantic;
    this.knowledgeGraph = options.knowledgeGraph;
    this.memory = options.memory;
    this.permissions = options.permissions;
    this.taskResolver = options.taskResolver;
  }

  /** Subscribe to the existing event bus. Returns a detach function. */
  attach(): () => void {
    this.detach();
    this.detachFns.push(
      this.events.on('TASK_COMPLETED', (event: AgentEvent) => {
        const task = this.taskFromEvent(event);
        if (!task) return;
        const skillId = task.plan?.skillFrom?.skillId;
        if (skillId) {
          this.recordOutcome(skillId, this.outcomeOf(task), task.id);
          return;
        }
        this.observeTask(task);
      })
    );
    this.detachFns.push(
      this.events.on('TASK_FAILED', (event: AgentEvent) => {
        const task = this.taskFromEvent(event);
        if (!task) return;
        const skillId = task.plan?.skillFrom?.skillId;
        if (skillId) this.recordOutcome(skillId, this.outcomeOf(task), task.id);
        // Failures never create skills.
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
   * Observe a finished task and possibly learn a skill. Creation requires a
   * genuinely verified success (honest goal-level verification), at least two
   * executable steps, and a passing deterministic validation.
   */
  observeTask(task: AgentTask): SkillLearnOutcome {
    if (!task.plan) return { learned: false, reason: 'no plan' };
    if (task.plan.skillFrom) return { learned: false, reason: 'skill-driven task — recorded against the reused skill' };
    if (task.plan.learnedFrom) return { learned: false, reason: 'workflow-reuse task — recorded by the Phase 12 layer' };
    if (task.status !== 'completed') return { learned: false, reason: `task ${task.status} — skills come only from completed work` };

    // Genuine-success gate: the Intelligence Loop's honest verdict wins; tasks
    // without one fall back to a strict all-steps-verified check.
    const verified = task.verification
      ? task.verification.outcome === 'pass'
      : (task.plan.steps ?? []).every((s) => s.status === 'completed' || s.status === 'skipped') &&
        (task.plan.steps ?? []).some((s) => s.status === 'completed');
    if (!verified) {
      return { learned: false, reason: `not a genuinely verified success (verification: ${task.verification?.outcome ?? 'absent'})` };
    }

    const steps = this.extractSkillSteps(task.plan);
    if (steps.length < 2) return { learned: false, reason: 'fewer than 2 executable steps' };
    if (steps.length > 10) return { learned: false, reason: 'more than 10 executable steps' };

    const goalPattern = this.normalizeGoal(task.goal.rawInput);
    const signature = skillSignature(steps);
    const validation = validateSkill({ goalPattern, expectedOutcome: this.expectedOutcomeOf(task), steps }, this.registry);
    if (validation.status === 'rejected') {
      this.events.emit({
        name: 'SKILL_REJECTED',
        payload: { taskId: task.id, reason: validation.errors[0] ?? 'validation failed', goalPattern },
        timestamp: Date.now(),
      });
      return { learned: false, reason: `validation failed: ${validation.errors[0] ?? 'unknown'}` };
    }

    // Duplicate / near-duplicate handling: identical sequences reinforce the
    // existing skill; the same goal with a different (verified) sequence
    // becomes a new VERSION of it — never a third near-duplicate artifact.
    const existing = this.findRelatedSkill(goalPattern);
    if (existing) {
      const sameSequence = skillSignature(existing.steps) === signature;
      if (sameSequence) {
        // The workflow just succeeded again outside the skill path (e.g. it
        // was planned normally) — honest evidence, counted like a verified
        // use so a freshly learned skill can reach the reuse floor.
        existing.stats.reinforcements += 1;
        existing.stats.totalUses += 1;
        existing.stats.successfulUses += 1;
        existing.stats.consecutiveFailures = 0;
        existing.stats.lastUsedAt = Date.now();
        existing.stats.lastOutcome = 'verified_success';
        existing.reliability = applySkillOutcome(existing.reliability, 'verified_success');
        existing.updatedAt = Date.now();
        this.store.upsert(existing);
        this.events.emit({
          name: 'SKILL_REINFORCED',
          payload: { skillId: existing.id, reinforcements: existing.stats.reinforcements, reliability: existing.reliability },
          timestamp: Date.now(),
        });
        return { learned: true, skillId: existing.id, version: existing.version, reason: 'reinforced existing skill' };
      }
      existing.steps = steps;
      existing.version += 1;
      existing.versionHistory.push({
        version: existing.version,
        createdAt: Date.now(),
        changeNote: 'step sequence updated from a new verified successful run',
      });
      if (existing.versionHistory.length > MAX_VERSION_HISTORY) {
        existing.versionHistory = existing.versionHistory.slice(-MAX_VERSION_HISTORY);
      }
      existing.validation = validation;
      existing.trigger.keywords = extractKeywords(goalPattern);
      existing.updatedAt = Date.now();
      this.store.upsert(existing);
      this.mirrorToGraph(existing);
      this.mirrorToMemory(existing);
      this.events.emit({
        name: 'SKILL_UPDATED',
        payload: { skillId: existing.id, version: existing.version, reason: 'verified improvement' },
        timestamp: Date.now(),
      });
      return { learned: true, skillId: existing.id, version: existing.version, reason: 'skill updated from verified improvement' };
    }

    // A manual flow is only promoted after three genuinely verified, matching
    // successes. Until then it is merely bounded evidence, not an executable
    // reusable artifact.
    const repetitions = this.store.recordCandidate(goalPattern, signature, task.id);
    if (repetitions < 3) {
      this.events.emit({
        name: 'SKILL_CANDIDATE',
        payload: { goalPattern, repetitions, needed: 3, steps: steps.length },
        timestamp: Date.now(),
      });
      return { learned: false, reason: `verified manual flow seen ${repetitions}/3 times` };
    }
    this.store.removeCandidate(goalPattern, signature);

    const environment = deriveSkillDomains(steps);
    const requiredTools = Array.from(new Set(steps.map((s) => s.toolName)));
    const requiredPermissions = this.permissionsOfTools(requiredTools);
    const skill: LearnedSkill = {
      id: 'skill_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: task.goal.description.slice(0, 60),
      description: `Validated ${steps.length}-step workflow learned from a verified task: ${goalPattern.slice(0, 120)}`,
      purpose: goalPattern,
      trigger: {
        goalPattern,
        keywords: extractKeywords(goalPattern),
        domains: environment,
      },
      steps,
      preconditions: derivePreconditions(requiredTools, requiredPermissions),
      requiredTools,
      requiredPermissions,
      expectedOutcome: this.expectedOutcomeOf(task),
      sensitive: this.isSensitive(requiredTools, requiredPermissions),
      provenance: {
        sourceTaskId: task.id,
        sourceWorkflowId: task.plan.learnedFrom?.workflowId,
        learnedAt: Date.now(),
        verificationReason: (task.verification?.reason ?? 'all executed steps verified').slice(0, 200),
      },
      validation,
      status: 'active',
      version: 1,
      versionHistory: [],
      stats: { totalUses: 0, successfulUses: 0, failedUses: 0, consecutiveFailures: 0, reinforcements: 0 },
      reliability: INITIAL_SKILL_RELIABILITY,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.upsert(skill);
    this.events.emit({
      name: 'SKILL_LEARNED',
      payload: {
        skillId: skill.id,
        name: skill.name,
        steps: steps.length,
        version: skill.version,
        reliability: skill.reliability,
        sensitive: skill.sensitive,
      },
      timestamp: Date.now(),
    });
    this.mirrorToGraph(skill);
    this.mirrorToMemory(skill);
    return { learned: true, skillId: skill.id, version: skill.version, reason: 'new validated skill' };
  }

  // --------------------------------------------------------------- retrieval

  /**
   * Rank reusable skills against a new goal. Deterministic + local: token
   * similarity first, bounded Semantic Intelligence expansion to bridge
   * different vocabulary. Every candidate carries explicit blockers so reuse
   * decisions are transparent and auditable.
   */
  match(goalText: string): SkillMatch[] {
    const pattern = this.normalizeGoal(goalText);
    if (!pattern) return [];

    const keywords = extractKeywords(pattern);
    const expansions = this.semantic ? this.semantic.expand(keywords, { intent: 'command' }) : [];
    const tokens = new Set(pattern.split(' ').filter(Boolean));

    const out: SkillMatch[] = [];
    for (const skill of this.store.skills) {
      if (skill.status !== 'active' || skill.validation.status !== 'validated') continue;

      const base = similarity(pattern, skill.trigger.goalPattern);
      if (base < SKILL_SEMANTIC_ACCEPT_SIMILARITY) continue;

      let semanticOverlap = 0;
      let semanticReason: string | undefined;
      if (this.semantic) {
        const content = [skill.trigger.goalPattern, skill.name, skill.description, skill.trigger.keywords.join(' ')].join(' ');
        const skillTokens = new Set(normalizeTerm(content).split(' ').filter(Boolean));
        const hit = semanticOverlapFor(skillTokens, content, expansions);
        semanticOverlap = Math.min(1, hit.overlap);
        semanticReason = hit.reason;
      }
      const accepted =
        base >= SKILL_SIMILAR_ACCEPT ||
        (base >= SKILL_SEMANTIC_ACCEPT_SIMILARITY && semanticOverlap >= SKILL_SEMANTIC_ACCEPT_OVERLAP);
      if (!accepted) continue;

      const reasons: string[] = [];
      const blockers: string[] = [];
      const env = this.environmentCheck(skill);
      if (env.coverage < 1) {
        blockers.push(`environment missing tools for ${Math.round((1 - env.coverage) * 100)}% of steps`);
      }
      reasons.push(...env.reasons);

      const pre = this.checkPreconditions(skill);
      if (!pre.met) blockers.push(...pre.blockers);

      if (!isReusableSkill(skill)) {
        blockers.push(`reliability ${skill.reliability} below the ${SKILL_MIN_RELIABILITY} reuse floor — needs another verified success`);
      }
      if (skill.sensitive) {
        reasons.push('sensitive workflow — the Phase 18 gate will require approval at execution');
      }
      reasons.push(semanticReason ? `semantic: ${semanticReason}` : 'token similarity');

      const score = round3(base * 0.5 + semanticOverlap * 0.15 + skill.reliability * 0.25 + env.coverage * 0.1);
      out.push({
        skill,
        score,
        goalSimilarity: round3(base),
        semanticOverlap: round3(semanticOverlap),
        environmentCoverage: round3(env.coverage),
        preconditionsMet: pre.met,
        reasons: reasons.slice(0, 6),
        blockers: blockers.slice(0, 6),
      });
    }

    out.sort((a, b) => b.score - a.score || b.skill.reliability - a.skill.reliability);
    return out;
  }

  /**
   * Instantiate the best matching skill as a NORMAL AgentPlan. Returns null
   * when nothing matches cleanly — the caller (planner) then plans normally.
   * Preconditions are re-validated HERE, immediately before execution, so a
   * skill whose prerequisites changed is never run ("do not execute a skill
   * if its prerequisites have changed").
   */
  planFromSkill(goal: AgentGoal): AgentPlan | null {
    if (goal.kind !== 'command') return null;
    const matches = this.match(goal.rawInput);
    const best = matches.find(
      (m) => m.blockers.length === 0 && m.score >= SKILL_REUSE_MIN_SCORE && m.environmentCoverage === 1 && m.preconditionsMet
    );
    if (!best) return null;

    // Preconditions may have changed between match() and now — re-check.
    const pre = this.checkPreconditions(best.skill);
    if (!pre.met) return null;

    const now = Date.now();
    const steps: PlanStep[] = best.skill.steps.map((step, index) => ({
      id: `step_${now}_sk${index + 1}`,
      description: step.description ?? step.toolName,
      toolName: step.toolName,
      capability: step.capability,
      // Defense in depth: templates are re-sanitized at instantiation even
      // though they were sanitized at extraction time.
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
      name: 'SKILL_REUSED',
      payload: {
        skillId: best.skill.id,
        version: best.skill.version,
        score: best.score,
        goalSimilarity: best.goalSimilarity,
        steps: steps.length,
        sensitive: best.skill.sensitive,
      },
      timestamp: now,
    });

    return {
      goal,
      steps,
      createdAt: now,
      revision: 1,
      objective: goal.description,
      skillFrom: { skillId: best.skill.id, version: best.skill.version, score: best.score },
    };
  }

  // -------------------------------------------------------------- outcomes

  /**
   * Record a real execution outcome against a skill. Reliability moves by
   * bounded EWMA smoothing (a single failure never collapses a proven skill);
   * the same task can never record twice; a skill decaying below the disable
   * floor is auto-disabled (reversible, bounded self-limitation).
   */
  recordOutcome(skillId: string, outcome: OutcomeKind, taskId?: string): boolean {
    const skill = this.store.get(skillId);
    if (!skill) return false;
    if (taskId) {
      if (skill.stats.lastRecordedTaskId === taskId || this.recordedTasks.has(taskId)) return false;
      this.recordedTasks.add(taskId);
      if (this.recordedTasks.size > MAX_TRACKED_TASKS) {
        const oldest = this.recordedTasks.values().next().value;
        if (oldest !== undefined) this.recordedTasks.delete(oldest);
      }
      skill.stats.lastRecordedTaskId = taskId;
    }

    skill.stats.totalUses += 1;
    if (outcome === 'verified_success' || outcome === 'unverified_success') {
      skill.stats.successfulUses += 1;
      skill.stats.consecutiveFailures = 0;
    } else {
      skill.stats.failedUses += 1;
      skill.stats.consecutiveFailures += 1;
    }
    skill.stats.lastUsedAt = Date.now();
    skill.stats.lastOutcome = outcome;
    skill.reliability = applySkillOutcome(skill.reliability, outcome);
    if (skill.reliability < SKILL_DISABLE_BELOW) {
      skill.status = 'disabled';
    }
    skill.updatedAt = Date.now();
    this.store.upsert(skill);
    this.events.emit({
      name: 'SKILL_UPDATED',
      payload: {
        skillId,
        reliability: skill.reliability,
        outcome,
        consecutiveFailures: skill.stats.consecutiveFailures,
        status: skill.status,
        source: 'execution',
      },
      timestamp: Date.now(),
    });
    return true;
  }

  /**
   * Identify outdated or unreliable skills (report only — deletion is the
   * user's call via skill.forget; auto-disable already happened in
   * recordOutcome when reliability decayed below the floor).
   */
  auditStale(now = Date.now()): { unreliable: string[]; stale: string[]; disabled: number } {
    const unreliable: string[] = [];
    const stale: string[] = [];
    let disabled = 0;
    for (const skill of this.store.skills) {
      if (skill.status === 'disabled') {
        disabled += 1;
        continue;
      }
      if (skill.reliability < SKILL_MIN_RELIABILITY) unreliable.push(skill.id);
      if (skill.stats.lastUsedAt === undefined) {
        if (now - skill.createdAt > STALE_AFTER_MS) stale.push(skill.id);
      } else if (now - skill.stats.lastUsedAt > STALE_AFTER_MS) {
        stale.push(skill.id);
      }
    }
    return { unreliable, stale, disabled };
  }

  // ------------------------------------------------------------- management

  list(): LearnedSkill[] {
    return [...this.store.skills];
  }

  get(id: string): LearnedSkill | undefined {
    return this.store.get(id);
  }

  disable(id: string): boolean {
    const skill = this.store.get(id);
    if (!skill) return false;
    skill.status = 'disabled';
    skill.updatedAt = Date.now();
    this.store.upsert(skill);
    return true;
  }

  forget(id: string): boolean {
    return this.store.remove(id);
  }

  stats(): { skills: number; reusable: number; sensitive: number; disabled: number; avgReliability: number } {
    const skills = this.store.skills;
    const reusable = skills.filter((s) => isReusableSkill(s)).length;
    const avg = skills.length === 0 ? 0 : skills.reduce((sum, s) => sum + s.reliability, 0) / skills.length;
    return {
      skills: skills.length,
      reusable,
      sensitive: skills.filter((s) => s.sensitive).length,
      disabled: skills.filter((s) => s.status === 'disabled').length,
      avgReliability: round3(avg),
    };
  }

  clear(): void {
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

  /** Executable, completed steps only — uncertain work never becomes a skill. */
  private extractSkillSteps(plan: AgentPlan): SkillStep[] {
    return plan.steps
      .filter((s) => s.status === 'completed')
      .filter((s) => s.toolName !== 'system.note')
      .map((s, index) => {
        const step = toWorkflowStep(s, index + 1) as SkillStep;
        step.description = (s.description ?? s.toolName).slice(0, 120);
        return step;
      });
  }

  private outcomeOf(task: AgentTask): OutcomeKind {
    if (task.verification) {
      if (task.verification.outcome === 'pass') return 'verified_success';
      if (task.verification.outcome === 'fail') return 'verified_failure';
      return task.status === 'completed' ? 'unverified_success' : 'unverified_failure';
    }
    // No recorded verification — mirror the Phase 12 honest classification.
    const anyUncertain = (task.plan?.steps ?? []).some((s) => s.status === 'uncertain');
    if (task.status === 'completed') return anyUncertain ? 'unverified_success' : 'verified_success';
    return task.status === 'cancelled' ? 'unverified_failure' : 'verified_failure';
  }

  private expectedOutcomeOf(task: AgentTask): string {
    const actual = task.verification?.actual || task.summary || '';
    return (actual.trim() || 'all executed steps verified successfully').slice(0, 200);
  }

  private permissionsOfTools(toolNames: string[]): ToolPermission[] {
    const perms = new Set<ToolPermission>();
    for (const name of toolNames) {
      for (const p of this.registry.get(name)?.permissions ?? []) perms.add(p);
    }
    return Array.from(perms);
  }

  private isSensitive(requiredTools: string[], requiredPermissions: ToolPermission[]): boolean {
    if (requiredPermissions.some((p) => SENSITIVE_PERMISSIONS.has(p))) return true;
    return requiredTools.some((name) => {
      const risk = this.registry.get(name)?.riskLevel;
      return risk === 'medium';
    });
  }

  /** Same-goal skill (reinforce or version-bump), else null. */
  private findRelatedSkill(goalPattern: string): LearnedSkill | null {
    let best: LearnedSkill | null = null;
    let bestScore = SKILL_GOAL_MATCH_THRESHOLD;
    for (const skill of this.store.skills) {
      const score = similarity(goalPattern, skill.trigger.goalPattern);
      if (score > bestScore) {
        bestScore = score;
        best = skill;
      }
    }
    return best;
  }

  /** Every step must resolve to a concrete tool in the CURRENT registry. */
  private environmentCheck(skill: LearnedSkill): { coverage: number; reasons: string[]; blockers: string[] } {
    const reasons: string[] = [];
    const blockers: string[] = [];
    let resolved = 0;
    for (const step of skill.steps) {
      const tool = resolveSkillTool(this.registry, step);
      if (tool) {
        resolved += 1;
        if (tool.name !== step.toolName) {
          reasons.push(`step ${step.order}: tool "${step.toolName}" replaced by "${tool.name}" via capability`);
        }
      } else {
        blockers.push(`step ${step.order}: no tool for "${step.toolName}"`);
      }
    }
    return { coverage: skill.steps.length === 0 ? 0 : resolved / skill.steps.length, reasons, blockers };
  }

  /** Precondition evaluation (tool availability + permission state). */
  private checkPreconditions(skill: LearnedSkill): { met: boolean; blockers: string[] } {
    const blockers: string[] = [];
    for (const pre of skill.preconditions) {
      if (pre.kind === 'tool_available') {
        if (!this.registry.get(pre.tool)) blockers.push(`prerequisite changed: tool "${pre.tool}" is no longer registered`);
      } else if (this.permissions && !this.permissions.isGranted(pre.permission)) {
        blockers.push(`permission "${pre.permission}" is not granted`);
      }
    }
    return { met: blockers.length === 0, blockers };
  }

  /** Knowledge Graph index: skill node + bounded 'uses' edges to its tools. */
  private mirrorToGraph(skill: LearnedSkill): void {
    if (!this.knowledgeGraph) return;
    try {
      const graph = this.knowledgeGraph.graph;
      const node = graph.upsertNode({
        type: 'component',
        label: `Skill: ${skill.name}`.slice(0, 80),
        properties: { skillId: skill.id, version: skill.version, reliability: skill.reliability },
      });
      if (!node) return;
      for (const toolName of skill.requiredTools.slice(0, 5)) {
        const toolNode = graph.upsertNode({ type: 'tool', label: toolName.slice(0, 80) });
        if (!toolNode) continue;
        graph.upsertEdge({
          sourceId: node.id,
          targetId: toolNode.id,
          relationship: 'uses',
          confidence: 0.6,
          source: 'skill_learning',
        });
      }
    } catch {
      // the graph must never break skill learning
    }
  }

  /** Memory mirror: compact record only (MemoryService merges duplicates). */
  private mirrorToMemory(skill: LearnedSkill): void {
    if (!this.memory) return;
    try {
      this.memory.remember(`Skill: ${skill.name}`, {
        category: 'workflow',
        source: 'workflow_learning',
        importance: 0.6,
        confidence: skill.reliability,
        tags: ['learned-skill', 'skill'],
        metadata: { skillId: skill.id, version: skill.version, steps: skill.steps.length, kind: 'learned_skill' },
      });
    } catch {
      // memory must never break learning
    }
  }

  private normalizeGoal(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
  }
}

// ------------------------------------------------------------------ helpers

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function deriveSkillDomains(steps: SkillStep[]): string[] {
  const domains = new Set<string>();
  for (const step of steps) {
    const tool = step.toolName;
    if (tool.startsWith('browser.') || tool.startsWith('web.')) domains.add('browser');
    else if (tool.startsWith('filesystem.') || tool.startsWith('files.') || tool.startsWith('application.') || tool.startsWith('app.')) domains.add('system');
    else if (tool.startsWith('computer.') || tool.startsWith('keyboard.')) domains.add('desktop');
    else if (tool.startsWith('screen.')) domains.add('vision');
    else if (tool.startsWith('memory.')) domains.add('memory');
    else if (tool.startsWith('research.')) domains.add('research');
    else domains.add('general');
  }
  return Array.from(domains);
}

function derivePreconditions(requiredTools: string[], requiredPermissions: ToolPermission[]): LearnedSkill['preconditions'] {
  const preconditions: LearnedSkill['preconditions'] = requiredTools
    .slice(0, 10)
    .map((tool) => ({ kind: 'tool_available' as const, tool, description: `tool "${tool}" must be registered` }));
  for (const permission of requiredPermissions.slice(0, 6)) {
    preconditions.push({
      kind: 'permission_granted',
      permission,
      description: `permission "${permission}" must be granted before reuse`,
    });
  }
  return preconditions;
}
