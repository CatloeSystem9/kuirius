/**
 * Plan validator (Phase 16, spec §8) — reject malformed plans BEFORE execution.
 *
 * Hard errors (invalid plan): unknown dependencies, circular dependencies,
 * depth/size bound violations, actions whose tool/capability cannot be
 * resolved from the ToolRegistry, structurally invalid nodes.
 *
 * Blocked-but-valid: a required permission that is not currently granted does
 * NOT invalidate the plan — the node is reported as blocked and the existing
 * permission system remains authoritative at execution time (spec §15).
 */
import type { PlanStep } from '../types';
import type { ToolRegistry } from '../toolRegistry';
import type { PermissionManager } from '../permissions';
import type { HierarchicalPlan, PlanLimits, PlanValidationResult, PlanValidationIssue } from './planningTypes';
import { selectToolForCapability } from '../toolSelector';

/** Resolve the concrete tool that would execute an action node (same resolution the Agent Core uses). */
export function resolveNodeTool(registry: ToolRegistry, toolName: string | undefined, capability: string | undefined): { name: string; permissions: string[] } | null {
  if (capability) {
    const selection = selectToolForCapability(registry, capability);
    if (selection) return { name: selection.tool.name, permissions: selection.tool.permissions ?? [] };
  }
  if (toolName && registry.has(toolName)) {
    const tool = registry.get(toolName)!;
    return { name: tool.name, permissions: tool.permissions ?? [] };
  }
  return null;
}

/** Depth of the tree from the root (goal = depth 1). */
export function treeDepth(plan: HierarchicalPlan): number {
  let max = 0;
  const depthOf = (id: string, depth: number, seen: Set<string>): void => {
    if (seen.has(id)) return;
    seen.add(id);
    max = Math.max(max, depth);
    for (const child of plan.nodes.get(id)?.childIds ?? []) depthOf(child, depth + 1, seen);
  };
  depthOf(plan.rootId, 1, new Set());
  return max;
}

export function validatePlan(
  plan: HierarchicalPlan,
  steps: PlanStep[],
  registry: ToolRegistry,
  permissions: PermissionManager | undefined,
  limits: PlanLimits
): PlanValidationResult {
  const errors: PlanValidationIssue[] = [];
  const warnings: PlanValidationIssue[] = [];
  const blockedNodeIds: string[] = [];
  const missingPermissionSet = new Set<string>();

  // --- size bounds ----------------------------------------------------------
  if (plan.nodes.size > limits.maxNodes) {
    errors.push({ code: 'size_exceeded', message: `plan has ${plan.nodes.size} nodes (limit ${limits.maxNodes})` });
  }
  const depth = treeDepth(plan);
  if (depth > limits.maxDepth) {
    errors.push({ code: 'depth_exceeded', message: `plan depth ${depth} exceeds limit ${limits.maxDepth}` });
  }

  // --- structural validity ---------------------------------------------------
  const stepIds = new Set(steps.map((s) => s.id));
  for (const node of plan.nodes.values()) {
    if (node.kind === 'action') {
      if (!node.stepId || !stepIds.has(node.stepId)) {
        errors.push({ code: 'invalid_node', nodeId: node.id, message: `action node "${node.id}" does not reference a real step` });
      }
      if (!node.expectedOutcome) {
        errors.push({ code: 'missing_verification', nodeId: node.id, message: `action node "${node.id}" has no verification condition` });
      }
    }
    for (const dep of node.dependsOn) {
      if (!plan.nodes.has(dep)) {
        errors.push({ code: 'unknown_dependency', nodeId: node.id, message: `node "${node.id}" depends on unknown node "${dep}"` });
      }
    }
  }
  // Flat declarations are validated too: a dependency naming no real step is
  // invalid regardless of how the tree translated it.
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!stepIds.has(dep)) {
        errors.push({ code: 'unknown_dependency', nodeId: plan.nodes.get(step.id)?.id, message: `step "${step.id}" depends on unknown step "${dep}"` });
      }
    }
  }

  // --- circular dependencies (DFS over dependsOn, actions only) --------------
  const state = new Map<string, 1 | 2>(); // 1 = visiting, 2 = done
  const visit = (id: string, stack: string[]): void => {
    const st = state.get(id);
    if (st === 2) return;
    if (st === 1) {
      errors.push({ code: 'circular_dependency', nodeId: id, message: `circular dependency: ${[...stack, id].join(' → ')}` });
      return;
    }
    state.set(id, 1);
    const node = plan.nodes.get(id);
    if (node) for (const dep of node.dependsOn) visit(dep, [...stack, id]);
    state.set(id, 2);
  };
  for (const id of plan.order) visit(id, []);

  // --- tool availability (spec §14) ------------------------------------------
  for (const node of plan.nodes.values()) {
    if (node.kind !== 'action') continue;
    const resolved = resolveNodeTool(registry, node.toolName, node.requiredCapability);
    if (!resolved) {
      errors.push({
        code: 'missing_tool',
        nodeId: node.id,
        message: `no tool available for "${node.toolName ?? ''}" (capability "${node.requiredCapability ?? 'none'}")`,
      });
      continue;
    }
    // --- permissions (spec §15): blocked, not invalid -------------------------
    if (permissions) {
      const missing = permissions.missing(resolved.permissions as never);
      if (missing.length > 0) {
        blockedNodeIds.push(node.id);
        for (const p of missing) missingPermissionSet.add(String(p));
      }
    }
  }

  // --- impossible (forward) dependencies -------------------------------------
  // The Agent Core executes flat steps in order: a dependency on a LATER step
  // can never be completed when the depending step runs, so the step is
  // skipped at runtime. That is a planning defect — reported as a warning
  // (non-fatal; the runtime skip is the graceful repair, spec §11).
  const stepIndex = new Map<string, number>();
  steps.forEach((s, i) => stepIndex.set(s.id, i));
  for (const node of plan.nodes.values()) {
    if (node.kind !== 'action' || !node.stepId) continue;
    const ownIndex = stepIndex.get(node.stepId);
    if (ownIndex === undefined) continue;
    for (const depId of node.dependsOn) {
      const depNode = plan.nodes.get(depId);
      if (!depNode?.stepId) continue;
      const depIndex = stepIndex.get(depNode.stepId);
      if (depIndex !== undefined && depIndex > ownIndex) {
        warnings.push({
          code: 'forward_dependency',
          nodeId: node.id,
          message: `step "${node.stepId}" depends on later step "${depNode.stepId}" — it will be skipped at runtime`,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    blockedNodeIds,
    missingPermissions: [...missingPermissionSet],
  };
}
