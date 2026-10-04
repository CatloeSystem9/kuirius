/**
 * Planning layer (Phase 16) — public surface.
 *
 * Hierarchical, adaptive, BOUNDED planning on top of the existing flat plan
 * model. The Agent Core remains the single executor; this layer derives the
 * hierarchy, validates plans, tracks node lifecycle, emits PLAN_* events and
 * performs bounded replanning (diagnose → one corrective retry) with honest
 * refusal when budgets are exhausted.
 */
export * from './planningTypes';
export { buildHierarchy } from './planBuilder';
export type { BuildHierarchyResult } from './planBuilder';
export { validatePlan, resolveNodeTool, treeDepth } from './planValidator';
export { strategyOptions, preferredPlan } from './strategySelector';
export type { StrategyOption } from './strategySelector';
export { detectAmbiguity, clarificationReason } from './clarification';
export type { ClarificationRequest } from './clarification';
export { PlanEngine } from './planEngine';
export type { PlanEngineOptions, AttachPlanResult } from './planEngine';
