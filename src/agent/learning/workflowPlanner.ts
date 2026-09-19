/**
 * Workflow-Aware Planner (Phase 12).
 *
 * A thin decorator over the existing Planner (Phase 1) — NOT a second planning
 * loop. Before delegating, it asks the learning service one question:
 *
 *   "Do I already know a verified workflow for this task?"
 *
 * If a confident, environment-compatible workflow exists, it is instantiated
 * as a plan TEMPLATE; every step still runs through the Agent Core's normal
 * verification, retry, recovery, permission, and timeout stack. Otherwise the
 * inner planner plans normally — and the outcome is learned afterwards.
 */
import type { AgentGoal, AgentPlan, PlanStep } from '../types';
import type { Planner } from '../planner';
import type { LearningService } from './learningService';

export class WorkflowAwarePlanner implements Planner {
  constructor(
    private inner: Planner,
    private learning: LearningService
  ) {}

  makePlan(goal: AgentGoal): AgentPlan {
    const reuse = this.learning.planFromWorkflow(goal);
    if (reuse) return reuse;
    return this.inner.makePlan(goal);
  }

  proposeAlternative(step: PlanStep, error: string): PlanStep | null {
    return this.inner.proposeAlternative(step, error);
  }
}
