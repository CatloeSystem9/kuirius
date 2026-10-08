/**
 * Intelligence Loop v1 — lightweight cycle observability.
 *
 * A bounded per-task trace of the intelligence cycle:
 *   understand → context → plan → execute → verify → outcome
 *
 * NOT a dashboard, NOT UI: a small in-memory structure for debugging, tests
 * and future observability. Bounded (16 traces × 24 stages, FIFO eviction);
 * no persistence, no polling — stages are recorded inline by the existing
 * Agent Core flow.
 */

/** Maximum concurrent traces kept in memory (oldest evicted). */
export const MAX_CYCLE_TRACES = 16;
/** Maximum stages recorded per cycle (bounded detail). */
export const MAX_TRACE_STAGES = 24;
/** Maximum characters per recorded detail string value. */
export const MAX_TRACE_DETAIL_CHARS = 200;

/** The stages of one intelligence cycle, in order. */
export type CycleStage = 'understand' | 'context' | 'plan' | 'execute' | 'verify' | 'outcome';

export interface CycleStageRecord {
  stage: CycleStage;
  at: number;
  /** Bounded explainability detail (strings capped, small values only). */
  detail: Record<string, string | number | boolean>;
}

export interface CycleTrace {
  taskId: string;
  goal: string;
  startedAt: number;
  stages: CycleStageRecord[];
  /** Final task outcome ('completed' | 'failed' | 'cancelled' | ...). */
  outcome?: string;
  /** Goal-level verification outcome ('pass' | 'uncertain' | 'fail'). */
  verification?: string;
}

/** Bounded, deterministic trace store. Never throws; failures are silent. */
export class CycleTraceStore {
  private traces = new Map<string, CycleTrace>();

  begin(taskId: string, goal: string, at: number): void {
    try {
      if (!taskId) return;
      this.traces.delete(taskId); // restart of the same task id → fresh trace
      while (this.traces.size >= MAX_CYCLE_TRACES) {
        const oldest = this.traces.keys().next().value as string | undefined;
        if (!oldest) break;
        this.traces.delete(oldest);
      }
      this.traces.set(taskId, {
        taskId,
        goal: String(goal ?? '').slice(0, MAX_TRACE_DETAIL_CHARS),
        startedAt: at,
        stages: [],
      });
    } catch {
      // observability must never break execution
    }
  }

  record(taskId: string, stage: CycleStage, detail: Record<string, string | number | boolean> = {}, at: number = Date.now()): void {
    try {
      const trace = this.traces.get(taskId);
      if (!trace || trace.stages.length >= MAX_TRACE_STAGES) return;
      const bounded: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(detail)) {
        if (typeof value === 'number' || typeof value === 'boolean') bounded[key] = value;
        else if (typeof value === 'string') bounded[key] = value.slice(0, MAX_TRACE_DETAIL_CHARS);
      }
      trace.stages.push({ stage, at, detail: bounded });
    } catch {
      // ignore
    }
  }

  finish(taskId: string, outcome: string, verification: string | undefined, at: number = Date.now()): void {
    try {
      const trace = this.traces.get(taskId);
      if (!trace) return;
      trace.outcome = String(outcome).slice(0, MAX_TRACE_DETAIL_CHARS);
      trace.verification = verification ? String(verification).slice(0, MAX_TRACE_DETAIL_CHARS) : undefined;
      trace.stages.push({ stage: 'outcome', at, detail: { outcome: trace.outcome, verification: trace.verification ?? 'none' } });
    } catch {
      // ignore
    }
  }

  get(taskId: string): CycleTrace | undefined {
    return this.traces.get(taskId);
  }

  get size(): number {
    return this.traces.size;
  }

  clear(): void {
    this.traces.clear();
  }
}
