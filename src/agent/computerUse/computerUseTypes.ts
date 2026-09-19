/**
 * Computer-Use Agent types (Phase 7).
 *
 * The orchestrator runs the closed loop
 *   OBSERVE → UNDERSTAND → PLAN → ACT → OBSERVE AGAIN → VERIFY → CONTINUE
 * inside a single `computer.use` Agent Core step. The Agent Core remains
 * responsible for task state, step limits, timeouts, retries, cancellation,
 * permissions, and memory — the orchestrator only coordinates the
 * already-built vision / mouse / keyboard services.
 */
import type { Point, SemanticTarget } from '../computer/mouseTypes';
import type { ScreenState } from '../vision/visionTypes';

export type ComputerActionKind =
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'move_cursor'
  | 'scroll'
  | 'drag'
  | 'type'
  | 'press_key'
  | 'hotkey'
  | 'key_down'
  | 'key_up'
  | 'copy'
  | 'paste'
  | 'select_all'
  | 'wait';

export interface ComputerActionIntent {
  kind: ComputerActionKind;
  description: string;
  params: Record<string, unknown>;
}

/** One executed action with honest evidence. */
export interface ComputerActionRecord {
  intent: ComputerActionIntent;
  status: 'completed' | 'failed' | 'skipped';
  verified?: boolean;
  verificationNote?: string;
  error?: string;
  recoveries?: number;
}

export type ComputerUseStatus = 'completed' | 'partial' | 'failed' | 'cancelled';

export interface ComputerUseResult {
  status: ComputerUseStatus;
  goal: string;
  actions: ComputerActionRecord[];
  focusChanges: FocusChange[];
  observations: number;
  summary: string;
}

/** A focus mismatch detected between actions. */
export interface FocusChange {
  from?: string;
  to?: string;
  afterActionIndex: number;
}

export interface ComputerUseOptions {
  observer?: import('../vision/screenObserver').ScreenObserver;
  /** Adaptive observation layer (Phase 13): when present, the OBSERVE step
   * consults it for when/how to observe instead of the fixed stale-ms rule. */
  adaptive?: import('../observation/adaptiveObserver').AdaptiveObserver;
  /** Multimodal evidence hook (Phase 14): successful observations are
   * recorded as ui_state evidence for cross-modal reasoning. Optional and
   * read-only for the CU loop — it cannot bypass any CU behavior. */
  multimodal?: { recordObservation(state: ScreenState): void };
  mouse: import('../computer/computerControl').ComputerControlService;
  keyboard: import('../computer/keyboardControl').KeyboardControlService;
  events?: import('../events').AgentEventBus;
  /** Max executed actions per run (loop protection). */
  maxActions?: number;
  /** Max recovery attempts per action. */
  maxRecoveriesPerAction?: number;
  /** Reuse window for observations between actions (ms). */
  stateStaleMs?: number;
  /** Bounded settle-wait budget after actions (ms). */
  waitTimeoutMs?: number;
}

/** Cancellation/timeout helpers shared by the loop. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || (err as any).kind === 'cancelled');
}

export function stateSummary(state: ScreenState): string {
  return state.analysis.summary || `Observation ${state.id}`;
}
