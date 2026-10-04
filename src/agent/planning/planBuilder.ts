/**
 * Plan builder (Phase 16) — deterministic derivation of the hierarchical plan
 * tree from the existing flat AgentPlan. Reuses the flat steps verbatim (they
 * remain the single execution surface); the tree adds hierarchy + state.
 *
 * Grouping rule: consecutive action steps in the same domain (deterministic
 * capability prefix mapping) form one subgoal. Dependencies mirror the flat
 * sequential order (the Agent Core executes steps in order) plus any explicit
 * step.dependsOn declarations. No heuristics, no model calls.
 */
import type { AgentGoal, PlanStep } from '../types';
import type { HierarchicalPlan, PlanDomain, PlanLimits, PlanNode, PlanNodeExpectedOutcome } from './planningTypes';
import { domainOf, DEFAULT_PLAN_LIMITS } from './planningTypes';

/** Mirror the step's declared verification as the node's expected outcome (spec §11). */
function expectedOutcomeFor(step: PlanStep): PlanNodeExpectedOutcome {
  const verification = step.verification;
  if (verification?.type === 'output_contains') {
    return {
      description: `output contains "${verification.expected}"`,
      check: { type: 'output_contains', expected: verification.expected },
    };
  }
  return {
    description: 'tool reports success and its declared verification passes',
    check: { type: 'tool_success' },
  };
}

function makeNode(partial: Omit<PlanNode, 'status' | 'statusReasons' | 'childIds' | 'dependsOn' | 'attempts' | 'replans' | 'createdAt'> & Partial<PlanNode>): PlanNode {
  return {
    status: 'pending',
    statusReasons: [],
    childIds: [],
    dependsOn: [],
    attempts: 0,
    replans: 0,
    createdAt: partial.createdAt,
    ...partial,
  } as PlanNode;
}

export interface BuildHierarchyResult {
  plan: HierarchicalPlan;
  /** stepId → action node id. */
  stepNodes: Map<string, string>;
}

/**
 * Derive the hierarchical plan. The flat order is preserved exactly; the tree
 * is a view over it (goal → subgoals → actions) with sequential dependencies.
 */
export function buildHierarchy(goal: AgentGoal, steps: PlanStep[], now: number, limits: PlanLimits = DEFAULT_PLAN_LIMITS): BuildHierarchyResult {
  const nodes = new Map<string, PlanNode>();
  const order: string[] = [];
  const stepNodes = new Map<string, string>();

  const rootId = `plan_goal_${now}`;
  const root = makeNode({
    id: rootId,
    kind: 'goal',
    description: goal.description.slice(0, 160),
    parentId: null,
    createdAt: now,
  });
  nodes.set(rootId, root);
  order.push(rootId);

  let currentSubgoalId: string | null = null;
  let currentDomain: PlanDomain | null = null;
  let previousActionId: string | null = null;
  let subgoalIndex = 0;
  // Explicit deps are declared against STEP ids (the core's convention); they
  // are translated to NODE ids after the loop once every node exists.
  const rawDeps = new Map<string, string[]>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const domain = domainOf(step.capability ?? step.toolName);

    if (domain !== currentDomain || !currentSubgoalId) {
      subgoalIndex += 1;
      currentSubgoalId = `plan_sub_${now}_${subgoalIndex}`;
      currentDomain = domain;
      const subgoal = makeNode({
        id: currentSubgoalId,
        kind: 'subgoal',
        description: `${domain} subgoal`,
        parentId: rootId,
        createdAt: now,
      });
      nodes.set(currentSubgoalId, subgoal);
      order.push(currentSubgoalId);
      root.childIds.push(currentSubgoalId);
      // Subgoals run in flat order too (previous subgoal's last action first).
      if (previousActionId) subgoal.dependsOn.push(previousActionId);
    }

    const actionId = `plan_act_${now}_${i + 1}`;
    const action = makeNode({
      id: actionId,
      kind: 'action',
      description: step.description.slice(0, 160),
      parentId: currentSubgoalId!,
      createdAt: now,
      requiredCapability: step.capability,
      toolName: step.toolName,
      expectedOutcome: expectedOutcomeFor(step),
      stepId: step.id,
      // Structural conditions are carried on the node explicitly (spec §7) —
      // the Agent Core still evaluates them at runtime against task context.
      condition: step.condition,
    });
    if (previousActionId) action.dependsOn.push(previousActionId);
    if ((step.dependsOn ?? []).length > 0) rawDeps.set(actionId, [...(step.dependsOn ?? [])]);
    nodes.set(actionId, action);
    order.push(actionId);
    nodes.get(currentSubgoalId)!.childIds.push(actionId);
    stepNodes.set(step.id, actionId);
    previousActionId = actionId;
  }

  // Translate explicit step-id deps into node ids (deduplicated).
  for (const [actionId, deps] of rawDeps) {
    const action = nodes.get(actionId)!;
    for (const depStepId of deps) {
      const depNodeId = stepNodes.get(depStepId);
      if (depNodeId && !action.dependsOn.includes(depNodeId)) action.dependsOn.push(depNodeId);
    }
  }

  return {
    plan: { goal: goal.description.slice(0, 160), rootId, nodes, order, createdAt: now, revision: 1 },
    stepNodes,
  };
}
