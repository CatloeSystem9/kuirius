/**
 * Agent event system (Phase 1) — event-driven architecture groundwork (spec §39).
 * Typed, synchronous emitter with a bounded recent-event buffer for debugging.
 */

export type AgentEventName =
  | 'USER_MESSAGE'
  | 'TASK_STARTED'
  | 'TASK_PLANNED'
  | 'TASK_STEP_STARTED'
  | 'TASK_STEP_COMPLETED'
  | 'TASK_STEP_FAILED'
  | 'TASK_STEP_RETRY'
  | 'TASK_STEP_SKIPPED'
  | 'TASK_COMPLETED'
  | 'TASK_FAILED'
  | 'TASK_CANCELLED'
  | 'TOOL_REGISTERED'
  | 'TOOL_UNREGISTERED'
  | 'TOOL_SELECTED'
  | 'TOOL_STARTED'
  | 'TOOL_INVOKED'
  | 'TOOL_COMPLETED'
  | 'TOOL_FAILED'
  | 'TOOL_RETRIED'
  | 'TOOL_CANCELLED'
  | 'TOOL_VERIFIED'
  | 'SCREEN_OBSERVATION_STARTED'
  | 'SCREEN_OBSERVED'
  | 'SCREEN_CHANGED'
  | 'ACTIVE_WINDOW_CHANGED'
  | 'SCREEN_ANALYSIS_COMPLETED'
  | 'SCREEN_ANALYSIS_FAILED'
  // Offline vision guarantee — a cloud analysis request was downgraded to the
  // local provider (no pixel data left the machine).
  | 'SCREEN_CLOUD_DOWNGRADED'
  // Live Screen Perception — lightweight continuous observation (resource-bounded)
  | 'SCREEN_LIVE_STARTED'
  | 'SCREEN_LIVE_STOPPED'
  | 'SCREEN_UNDERSTANDING_UPDATED'
  | 'CURSOR_MOVE_STARTED'
  | 'CURSOR_MOVE_COMPLETED'
  | 'MOUSE_CLICK_STARTED'
  | 'MOUSE_CLICK_COMPLETED'
  | 'MOUSE_ACTION_FAILED'
  | 'MOUSE_ACTION_RETRIED'
  | 'MOUSE_ACTION_CANCELLED'
  | 'MOUSE_ACTION_VERIFIED'
  | 'KEYBOARD_ACTION_STARTED'
  | 'KEYBOARD_ACTION_COMPLETED'
  | 'KEYBOARD_ACTION_FAILED'
  | 'KEYBOARD_ACTION_RETRIED'
  | 'KEYBOARD_ACTION_CANCELLED'
  | 'KEYBOARD_ACTION_VERIFIED'
  | 'COMPUTER_USE_STARTED'
  | 'COMPUTER_OBSERVED'
  | 'COMPUTER_ACTION_PLANNED'
  | 'COMPUTER_ACTION_STARTED'
  | 'COMPUTER_ACTION_COMPLETED'
  | 'COMPUTER_ACTION_VERIFIED'
  | 'COMPUTER_ACTION_FAILED'
  | 'COMPUTER_RECOVERY_STARTED'
  | 'COMPUTER_USE_COMPLETED'
  | 'COMPUTER_USE_CANCELLED'
  | 'BROWSER_NAVIGATED'
  | 'BROWSER_OBSERVED'
  | 'BROWSER_ACTION_PLANNED'
  | 'BROWSER_ACTION_STARTED'
  | 'BROWSER_ACTION_COMPLETED'
  | 'BROWSER_ACTION_VERIFIED'
  | 'BROWSER_ACTION_FAILED'
  | 'BROWSER_RECOVERY_STARTED'
  | 'BROWSER_TASK_STARTED'
  | 'BROWSER_TASK_COMPLETED'
  | 'BROWSER_TASK_CANCELLED'
  | 'FS_OPERATION_STARTED'
  | 'FS_OPERATION_COMPLETED'
  | 'FS_OPERATION_FAILED'
  | 'APP_LAUNCHED'
  | 'APP_LAUNCH_FAILED'
  | 'APP_STATE_CHANGED'
  | 'APP_CLOSED'
  | 'NOTICE'
  | 'RECOVERY_STARTED'
  | 'RECOVERY_CLASSIFIED'
  | 'RECOVERY_STRATEGY_SELECTED'
  | 'RECOVERY_ATTEMPTED'
  | 'RECOVERY_REOBSERVED'
  | 'RECOVERY_VERIFIED'
  | 'RECOVERY_SUCCEEDED'
  | 'RECOVERY_FAILED'
  | 'RECOVERY_ABORTED'
  | 'SAFE_STOP_TRIGGERED'
  // Phase 12 — Learning + Workflow Acquisition
  | 'USER_CORRECTION'
  | 'STRATEGY_UPDATED'
  | 'WORKFLOW_DETECTED'
  | 'WORKFLOW_LEARNED'
  | 'WORKFLOW_REUSED'
  // Learned Skills v1 — validated reusable capabilities (tier above Phase 12)
  | 'SKILL_LEARNED'
  | 'SKILL_CANDIDATE'
  | 'SKILL_REINFORCED'
  | 'SKILL_UPDATED'
  | 'SKILL_REJECTED'
  | 'SKILL_REUSED'
  // Project Awareness v1 — read-only understanding of approved projects
  | 'PROJECT_INDEXED'
  | 'PROJECT_STATUS_UPDATED'
  | 'PROJECT_CHANGES'
  // Phase 16 — Advanced Planning (hierarchical, adaptive, bounded)
  | 'PLAN_CREATED'
  | 'PLAN_UPDATED'
  | 'PLAN_NODE_STARTED'
  | 'PLAN_NODE_COMPLETED'
  | 'PLAN_NODE_FAILED'
  | 'PLAN_REPLAN_REQUESTED'
  | 'PLAN_REPLANNED'
  | 'PLAN_BLOCKED'
  | 'PLAN_CLARIFICATION_REQUESTED'
  | 'PLAN_COMPLETED'
  | 'PLAN_CANCELLED'
  // Phase 19 — Long-Run Autonomy (persistent bounded sessions)
  | 'TASK_RESUMED'
  | 'TASK_PAUSED'
  | 'TASK_WAITING'
  | 'TASK_WAIT_COMPLETED'
  | 'TASK_CHECKPOINTED'
  | 'TASK_BUDGET_EXHAUSTED'
  // Deep Research Intelligence — additional capability, outside the numbered
  // roadmap (NOT roadmap Phase 16; Phase 16 = Advanced Planning above)
  | 'RESEARCH_STARTED'
  | 'RESEARCH_PLAN_CREATED'
  | 'RESEARCH_SEARCH_COMPLETED'
  | 'RESEARCH_SOURCE_INSPECTED'
  | 'RESEARCH_EVIDENCE_EXTRACTED'
  | 'RESEARCH_ANALYSIS_COMPLETED'
  | 'RESEARCH_FOLLOWUP_QUEUED'
  | 'RESEARCH_ROUND_COMPLETED'
  | 'RESEARCH_COMPLETED'
  | 'RESEARCH_INSUFFICIENT_EVIDENCE'
  | 'RESEARCH_FAILED'
  // Goal Continuity v1 — persistent user objectives across sessions
  | 'GOAL_STATUS_UPDATED'
  | 'GOAL_MILESTONE_RECORDED'
  | 'GOAL_RESUMPTION_BRIEFED';

export interface AgentEvent<P = unknown> {
  name: AgentEventName;
  taskId?: string;
  stepId?: string;
  payload?: P;
  timestamp: number;
}

type Handler = (event: AgentEvent) => void;

const BUFFER_LIMIT = 200;

export class AgentEventBus {
  private handlers = new Map<AgentEventName, Set<Handler>>();
  private recent: AgentEvent[] = [];

  on(name: AgentEventName, handler: Handler): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  off(name: AgentEventName, handler: Handler): void {
    this.handlers.get(name)?.delete(handler);
  }

  emit(event: AgentEvent): void {
    this.recent.push(event);
    if (this.recent.length > BUFFER_LIMIT) this.recent.shift();
    const set = this.handlers.get(event.name);
    if (set) {
      for (const handler of Array.from(set)) {
        try {
          handler(event);
        } catch (err) {
          console.warn('[AgentEventBus] handler error:', err);
        }
      }
    }
  }

  /** Last N events (newest last) — for diagnostics and tests. */
  recentEvents(): AgentEvent[] {
    return [...this.recent];
  }

  clear(): void {
    this.handlers.clear();
    this.recent = [];
  }
}
