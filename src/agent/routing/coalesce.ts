/**
 * Request coalescer (Phase 17, spec §12) — identical in-flight work is shared
 * instead of duplicated. Only safe for read-only, deterministic work (e.g.
 * the same vision analysis requested twice concurrently); independent tasks
 * keep independent executions. Errors propagate to every waiter; the next
 * caller starts fresh.
 */
import type { PerformanceTelemetry } from './telemetry';

export class RequestCoalescer<T> {
  private inflight = new Map<string, Promise<T>>();
  private counts = { coalesced: 0, distinct: 0, failed: 0 };

  constructor(private telemetry?: PerformanceTelemetry) {}

  /** Number of currently shared executions. */
  get size(): number {
    return this.inflight.size;
  }

  stats(): { coalesced: number; distinct: number; failed: number } {
    return { ...this.counts };
  }

  async run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      this.counts.coalesced++;
      this.telemetry?.recordCoalesced({ at: Date.now(), key: key.slice(0, 60) });
      return existing;
    }
    this.counts.distinct++;
    const execution = (async () => {
      try {
        return await fn();
      } catch (err) {
        this.counts.failed++;
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, execution);
    return execution;
  }
}
