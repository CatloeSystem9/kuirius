/**
 * Observation budgets (Phase 13, spec §4) — bounded resource controls.
 *
 * Every capture must fit inside the per-task cap, the sliding rate window,
 * the consecutive-capture cap, and the unchanged-screen cap. When a budget
 * is exhausted the tracker returns a structured status and the observer
 * REDUCES observation (never an uncontrolled loop). Budgets are scoped per
 * task and reset on task start; the tracker holds only counters, never
 * screen data.
 */
import type { ObservationBudgetConfig, ObservationBudgetStatus } from './observationTypes';
import { DEFAULT_BUDGET } from './observationTypes';

const MAX_TRACKED_TASKS = 8;

interface TaskBudgetState {
  used: number;
  window: number[];
  consecutive: number;
  unchangedStreak: number;
  retries: number;
}

export class ObservationBudgetTracker {
  private config: ObservationBudgetConfig;
  private tasks = new Map<string, TaskBudgetState>();

  constructor(config: Partial<ObservationBudgetConfig> = {}) {
    this.config = { ...DEFAULT_BUDGET, ...config };
  }

  getConfig(): ObservationBudgetConfig {
    return { ...this.config };
  }

  /** Reset all counters for a (new) task scope. */
  resetTask(taskId: string): void {
    this.tasks.set(taskId, { used: 0, window: [], consecutive: 0, unchangedStreak: 0, retries: 0 });
    this.evict();
  }

  /** Drop all task scopes (used when observation stops globally). */
  resetAll(): void {
    this.tasks.clear();
  }

  private stateFor(taskId: string): TaskBudgetState {
    let state = this.tasks.get(taskId);
    if (!state) {
      state = { used: 0, window: [], consecutive: 0, unchangedStreak: 0, retries: 0 };
      this.tasks.set(taskId, state);
      this.evict();
    }
    return state;
  }

  /** Structured check BEFORE capturing. Pure read — records nothing. */
  check(taskId: string, now: number): ObservationBudgetStatus {
    const s = this.stateFor(taskId);
    const windowUsed = s.window.filter((t) => now - t < this.config.windowMs).length;

    const base = {
      used: s.used,
      remaining: Math.max(0, this.config.maxPerTask - s.used),
      windowUsed,
      consecutive: s.consecutive,
      unchangedStreak: s.unchangedStreak,
      retries: s.retries,
    };

    if (s.used >= this.config.maxPerTask) {
      return { ...base, allowed: false, reason: 'task_limit' };
    }
    if (windowUsed >= this.config.maxPerWindow) {
      const oldest = Math.min(...s.window);
      return {
        ...base,
        allowed: false,
        reason: 'window_limit',
        retryAfterMs: Math.max(0, this.config.windowMs - (now - oldest)),
      };
    }
    if (s.consecutive >= this.config.maxConsecutive) {
      return { ...base, allowed: false, reason: 'consecutive_limit' };
    }
    if (s.unchangedStreak >= this.config.maxUnchanged) {
      return { ...base, allowed: false, reason: 'unchanged_limit' };
    }
    return { ...base, allowed: true };
  }

  /** Record a capture that happened (successful or not). */
  recordCapture(taskId: string, now: number): void {
    const s = this.stateFor(taskId);
    s.used += 1;
    s.window.push(now);
    s.consecutive += 1;
    if (s.window.length > this.config.maxPerWindow * 4) {
      s.window = s.window.filter((t) => now - t < this.config.windowMs);
    }
  }

  /** Record that an observation reused the cache / waited — breaks the consecutive chain. */
  recordReuseOrWait(taskId: string): void {
    const s = this.stateFor(taskId);
    s.consecutive = 0;
  }

  /** Record that a capture found no meaningful change. */
  recordUnchanged(taskId: string): void {
    const s = this.stateFor(taskId);
    s.unchangedStreak += 1;
    s.consecutive = 0;
  }

  /** Record a meaningful change — resets the unchanged streak. */
  recordChanged(taskId: string): void {
    const s = this.stateFor(taskId);
    s.unchangedStreak = 0;
  }

  /** Record a retry after a failed observation; false when retries exhausted. */
  recordRetry(taskId: string): boolean {
    const s = this.stateFor(taskId);
    if (s.retries >= this.config.maxRetries) return false;
    s.retries += 1;
    return true;
  }

  private evict(): void {
    while (this.tasks.size > MAX_TRACKED_TASKS) {
      const oldest = this.tasks.keys().next().value;
      if (oldest === undefined) break;
      this.tasks.delete(oldest);
    }
  }
}
