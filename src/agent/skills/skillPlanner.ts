/**
 * Skill-Aware Planner (Learned Skills v1).
 *
 * A thin decorator over the existing planner stack — NOT a second planning
 * loop. Before delegating, it asks the skill engine one question:
 *
 *   "Do I already have a validated, reliable skill for this task?"
 *
 * Only a clean match (score ≥ threshold, full environment coverage, all
 * preconditions met, reliability ≥ floor) is instantiated — and even then the
 * resulting plan runs through the normal Agent Core verification, retry,
 * recovery, permission, and timeout stack. Otherwise the inner planner
 * (Phase 12 workflow reuse + heuristic planning) handles the goal unchanged.
 */
import type { AgentGoal, AgentPlan, PlanStep } from '../types';
import type { Planner } from '../planner';
import type { SkillEngine } from './skillEngine';

export class SkillAwarePlanner implements Planner {
  constructor(
    private inner: Planner,
    private skills: SkillEngine
  ) {}

  makePlan(goal: AgentGoal): AgentPlan {
    const reuse = this.skills.planFromSkill(goal);
    if (reuse) return reuse;
    return this.inner.makePlan(goal);
  }

  proposeAlternative(step: PlanStep, error: string): PlanStep | null {
    return this.inner.proposeAlternative(step, error);
  }
}
