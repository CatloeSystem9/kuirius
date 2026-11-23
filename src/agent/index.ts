/**
 * Agent layer public surface (Phase 3).
 */
export * from './types';
export * from './events';
export * from './permissions';
export * from './toolRegistry';
export * from './toolSelector';
export * from './taskState';
export * from './planner';
export * from './agentCore';
export * from './browserTools';
export * from './vision/visionTypes';
export * from './vision/screenObserver';
export * from './vision/screenTools';
export * from './vision/liveWatcher';
export * from './vision/screenUnderstanding';
export * from './vision/liveTools';
export * from './computer/mouseTypes';
export * from './computer/computerControl';
export * from './computer/mouseTools';
export * from './computer/keyboardTypes';
export * from './computer/keyboardControl';
export * from './computer/keyboardTools';
export * from './computerUse/computerUseTypes';
export * from './computerUse/computerUseAgent';
export * from './computerUse/computerUseTools';
export * from './browser/browserTypes';
export * from './browser/browserAgent';
export { createBrowserTools as createBrowserAgentTools } from './browser/browserTools';
export * from './browser/browserDecider';
export { resolveContextPath, resolveContextRefs, boundContextValue } from './context';
export type { StepCondition as ContextCondition } from './context';
export * from './system/systemTypes';
export * from './system/systemServices';
export * from './system/systemTools';
export * from './learning/learningTypes';
export * from './learning/workflowStore';
export * from './learning/learningService';
export * from './learning/workflowPlanner';
export * from './goals';
export * from './diagnostics';
// Persistent Identity Foundation (Step 1): who Krisha is — stable across
// restarts, sessions, models and providers. Independent of memory/memory v2,
// model routing, voice and avatar systems.
export * from './identity';
// bridge re-exports planner names (isMultiStepRequest/isScreenIntent/isMouseIntent) —
// export its own API explicitly to avoid ambiguous star-export collisions.
export { createAgentSystem, runAgentTask, type AgentHost, type AgentSystem, type AgentRunResult } from './bridge';
