/**
 * Proactive scheduler (Phase 15) — lightweight, event-triggered scheduling.
 * No recurring timers and no polling: only bounded ONE-SHOT delayed checks
 * (e.g. a single inactivity follow-up after an unfinished task), each with a
 * cancellation path, expiration, and a reason. Every scheduled entry is
 * aborted if its AbortSignal fires or the budget is exceeded.
 */
import type { ProactiveOpportunity } from './proactiveTypes';

export interface ScheduledCheck {
  id: string;
  opportunity: ProactiveOpportunity;
  fireAt: number;
  reason: string;
  requiredPermissions: string[];
  cancel(): void;
}

const MAX_SCHEDULED = 8;

export class ProactiveScheduler {
  private entries = new Map<string, { check: ScheduledCheck; timer: ReturnType<typeof setTimeout> | undefined; fired: boolean }>();

  constructor(
    private readonly onFire: (check: ScheduledCheck) => void,
    private readonly onCancel: (check: ScheduledCheck) => void
  ) {}

  /**
   * Schedule a single one-shot check. Returns null when the budget is full
   * or the fire time is not in the future. The caller owns cancellation.
   */
  schedule(opportunity: ProactiveOpportunity, fireAt: number, reason: string, signal?: AbortSignal): ScheduledCheck | null {
    const now = Date.now();
    if (fireAt <= now) return null;
    if (this.entries.size >= MAX_SCHEDULED) return null;
    if (signal?.aborted) return null;

    const id = opportunity.id;
    // One entry per opportunity (idempotent scheduling).
    if (this.entries.has(id)) return null;

    const check: ScheduledCheck = {
      id,
      opportunity,
      fireAt,
      reason,
      requiredPermissions: opportunity.requiredPermissions,
      cancel: () => this.cancel(id),
    };
    const entry: { check: ScheduledCheck; timer: ReturnType<typeof setTimeout> | undefined; fired: boolean } = { check, timer: undefined, fired: false };
    const delay = Math.min(fireAt - now, 2 ** 31 - 1);
    entry.timer = setTimeout(() => {
      const e = this.entries.get(id);
      if (!e || e.fired) return;
      e.fired = true;
      this.entries.delete(id);
      if (signal?.aborted) {
        this.onCancel(check);
        return;
      }
      this.onFire(check);
    }, delay);
    if (typeof entry.timer === 'object' && entry.timer && 'unref' in entry.timer) {
      (entry.timer as { unref: () => void }).unref();
    }
    this.entries.set(id, entry);
    return check;
  }

  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    this.entries.delete(id);
    this.onCancel(entry.check);
    return true;
  }

  /** Cancel every scheduled check matching a predicate (e.g. taskId). */
  cancelWhere(predicate: (check: ScheduledCheck) => boolean): number {
    let n = 0;
    for (const [id, entry] of [...this.entries]) {
      if (predicate(entry.check)) {
        this.cancel(id);
        n++;
      }
    }
    return n;
  }

  pending(): ScheduledCheck[] {
    return [...this.entries.values()].map((e) => e.check);
  }

  dispose(): void {
    for (const [, entry] of this.entries) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
    }
    this.entries.clear();
  }
}
