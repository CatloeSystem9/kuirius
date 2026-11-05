/**
 * Goal Continuity v1 — persistent user objectives across sessions.
 * Public surface of the goals subsystem.
 */
export { GoalEngine } from './goalEngine';
export type { GoalEngineOptions, GoalObservation, GoalBriefing } from './goalEngine';
export { GoalStore, openGoals, repairGoal } from './goalStore';
export { detectGoalIntent, isGenericSubject, isConfirmationStatement, isSameGoalStatement, resolveGoalTarget } from './goalIntent';
export type { GoalIntent, GoalIntentKind } from './goalIntent';
export { createGoalTools } from './goalTools';
export type { GoalToolsDeps } from './goalTools';
export * from './goalTypes';
