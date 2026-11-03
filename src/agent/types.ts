/**
 * Agent Core — shared types (Phase 1)
 *
 * Pure TypeScript, no React, no DOM. The core loop is:
 * INPUT → GOAL → PLAN → TOOL → RESULT → VERIFY → NEXT STEP
 * with cancellation, per-step timeout, retry limits, and honest verification.
 */
import type { WebAction, LocalFileAction, LaptopAppAction, MapsLocationAction, ActiveModal, GlobeAction } from '../types';
import type { LocalIndexedFile } from '../utils/fileSystemAccess';

export type TaskId = string;
export type StepId = string;

/** Why a step was attempted / what it expects. */
export type Verification =
  | { type: 'tool_success' }
  | { type: 'output_contains'; expected: string };

export type StepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'uncertain'
  | 'failed'
  | 'skipped'
  | 'cancelled';

/** Task-state-driven run condition evaluated before a step executes (Phase 10). */
export type StepCondition =
  | { kind: 'context_exists'; key: string }
  | { kind: 'context_missing'; key: string }
  | { kind: 'context_equals'; key: string; value: unknown }
  | { kind: 'context_contains'; key: string; value: string };

export interface PlanStep {
  id: StepId;
  description: string;
  /** Registered tool name in the ToolRegistry. */
  toolName: string;
  /** Capability tag; the registry/selector resolves the concrete tool (Phase 3). */
  capability?: string;
  input: Record<string, unknown>;
  /** Step-level verification override; falls back to the tool's strategy. */
  verification?: Verification;
  status: StepStatus;
  attempts: number;
  verified?: boolean;
  error?: string;
  result?: ToolResult;
  startedAt?: number;
  finishedAt?: number;
  /** Store the tool result output into task context under this key (Phase 10). */
  outputKey?: string;
  /** Observation requirement for this step (Phase 13, learned workflows):
   * requireFresh forbids reusing cached screen state for this step. */
  observation?: { requireFresh?: boolean; region?: string };
  /** Run only when this condition holds against the task context (Phase 10). */
  condition?: import('./context').StepCondition;
  /** Steps that must have completed before this one runs (Phase 10). */
  dependsOn?: string[];
}

export interface AgentGoal {
  description: string;
  rawInput: string;
  kind: 'command' | 'chat';
}

export interface AgentPlan {
  goal: AgentGoal;
  steps: PlanStep[];
  createdAt: number;
  revision: number;
  /** Human-readable objective (Phase 10). */
  objective?: string;
  /** When task context has this key, the objective is achieved and remaining steps are skipped (Phase 10). */
  evidenceKey?: string;
  /** Set when the plan was instantiated from a learned workflow (Phase 12). */
  learnedFrom?: { workflowId: string; version: number; score: number };
  /** Set when the plan was instantiated from a validated learned skill (Learned Skills v1). */
  skillFrom?: { skillId: string; version: number; score: number };
}

export type TaskStatus =
  | 'planning'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  /**
   * Intelligence Loop v1 (spec §9): steps executed but verification evidence
   * was incomplete — the goal was NOT verifiably achieved. Honest terminal
   * state; consolidation refuses to learn from these tasks.
   */
  | 'uncertain';

export interface AgentTask {
  id: TaskId;
  goal: AgentGoal;
  plan: AgentPlan | null;
  status: TaskStatus;
  currentStepIndex: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
  summary?: string;
  /** Relevant memories recalled for this task's input (Phase 2). */
  memoryContext?: string[];
  /** Structured scratchpad carrying results between steps (Phase 10). */
  context?: Record<string, unknown>;
  /**
   * Intelligence Loop v1 — goal-level verification (EXPECTED vs ACTUAL).
   * Honest by design: uncertainty is never reported as success. Recorded at
   * terminal states; consolidation refuses to learn from 'uncertain'.
   */
  verification?: TaskVerification;
}

/** Goal/result comparison recorded when a task reaches a terminal state. */
export interface TaskVerification {
  outcome: 'pass' | 'uncertain' | 'fail';
  /** What the goal asked for (bounded). */
  expected: string;
  /** What the evidence says was actually achieved (bounded). */
  actual: string;
  /** Why this outcome was reached (explainability). */
  reason: string;
  checkedAt: number;
}

/** Structured tool result — every tool must return this (Phase 3 contract). */
export interface ToolResult {
  success: boolean;
  output?: unknown;
  error?: string;
  /** Failure classification (invalid_input / permission_denied / timeout / ...). */
  errorKind?: ToolErrorKind;
  /** Relevant state snapshot for reasoning / follow-up steps. */
  state?: Record<string, unknown>;
  /** Declarative UI effects; applied by the App bridge, never by the core. */
  ui?: UiEffect[];
  /** Whether retrying this tool could plausibly help. */
  retryable?: boolean;
  /** Set by the Agent Core after the verification phase. */
  verified?: boolean;
  /** Normalization metadata added by the registry (Phase 3). */
  toolId?: string;
  timestamp?: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ToolContext {
  taskId: TaskId;
  stepId: StepId;
  signal: AbortSignal;
  /** Shared scratchpad across the steps of one task. */
  memory: Record<string, unknown>;
  /** The original user request that produced this step (Phase 3). */
  userRequest?: string;
  /** Relevant memories recalled for this task (Phase 3, from MemoryService). */
  relevantMemories?: string[];
  /** Permission registry used for pre-execution validation (Phase 3). */
  permissions?: import('./permissions').PermissionManager;
  /** Effective timeout for this invocation in ms (Phase 3). */
  timeoutMs?: number;
}

export type ToolRiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

/**
 * Conceptual permission domains (Phase 3). Tools declare what they need;
 * the PermissionManager decides what is currently granted.
 */
export type ToolPermission =
  | 'screen.observation'
  | 'mouse.control'
  | 'keyboard.control'
  | 'browser.interaction'
  | 'filesystem.read'
  | 'filesystem.write'
  | 'application.launch'
  | 'terminal.execution'
  | 'camera.access'
  | 'microphone.access'
  | 'location.access'
  | 'memory.access';

/** Logical tool categories; computer/vision/voice are extension points for Phases 4+. */
export type ToolCategory =
  | 'communication'
  | 'web'
  | 'filesystem'
  | 'applications'
  | 'location'
  | 'computer'
  | 'vision'
  | 'voice'
  | 'memory'
  | 'system';

/** Structured failure classification so the core can reason about retries. */
export type ToolErrorKind =
  | 'invalid_input'
  | 'permission_denied'
  | 'timeout'
  | 'cancelled'
  | 'not_found'
  | 'execution_error'
  | 'verification_failed'
  | 'unknown';

/** Relative resource cost, used by tool selection (cheapest reliable first). */
export type ToolCost = 'free' | 'cheap' | 'moderate' | 'expensive';

/** Lightweight input schema for pre-execution validation (Phase 3). */
export interface ToolInputSchema {
  required?: string[];
  optional?: string[];
  types?: Partial<Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>>;
  validators?: Record<string, (value: unknown) => boolean>;
  description?: string;
}

/** How the Agent Core should verify this tool's effect. */
export interface ToolVerification {
  strategy: 'self_reported' | 'output_contains' | 'state_check' | 'external';
  expectedOutput?: string;
  /** Honest description of what can and cannot be verified yet. */
  description?: string;
}

export interface ToolRetryPolicy {
  /** Overrides the core's default max attempts for this tool. */
  maxAttempts?: number;
}

export interface AgentTool {
  /** Unique tool id (kept as `name` for Phase 1 compatibility). */
  name: string;
  description: string;
  category: ToolCategory | string;
  riskLevel: ToolRiskLevel;
  /** Capability tags used by the tool selector (e.g. 'browser.open_url'). */
  capabilities?: string[];
  /** Permissions that must be granted before execution. */
  permissions?: ToolPermission[];
  /** Declared input contract; validated before execute() runs. */
  inputSchema?: ToolInputSchema;
  /** Verification strategy exposed to the Agent Core. */
  verification?: ToolVerification;
  /** Tool-specific timeout override (ms). */
  timeoutMs?: number;
  /** Tool-specific retry overrides. */
  retryPolicy?: ToolRetryPolicy;
  /** Relative resource cost for selection. */
  cost?: ToolCost;
  /** Expected reliability 0..1 for selection ranking. */
  reliability?: number;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Declarative UI effects (mirror of existing Message action attachments). */
export type UiEffect =
  | { kind: 'web_action'; action: WebAction }
  | { kind: 'app_action'; action: LaptopAppAction }
  | { kind: 'file_action'; action: LocalFileAction }
  | { kind: 'maps_action'; action: MapsLocationAction }
  | { kind: 'viewer_file'; file: LocalIndexedFile }
  | { kind: 'open_modal'; modal: ActiveModal }
  | { kind: 'globe_action'; action: GlobeAction }
  | { kind: 'pose'; pose: string };

export const ok = (result: Omit<ToolResult, 'success'> = {}): ToolResult => ({ success: true, retryable: false, ...result });

export const fail = (error: string, result: Omit<ToolResult, 'success' | 'error'> = {}): ToolResult => ({
  success: false,
  error,
  retryable: true,
  ...result,
});
