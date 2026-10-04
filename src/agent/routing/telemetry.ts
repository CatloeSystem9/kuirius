/**
 * Performance telemetry (Phase 17, spec §15) — lightweight, PASSIVE, local.
 * Records only what actually happens (routes, model calls, escalations,
 * fallbacks, cache stats, tool/task durations) into bounded ring buffers.
 * No background collection, no timers, no analytics system — nothing runs
 * unless something happens. snapshot() is bounded and cheap.
 */

export interface RouteRecord {
  at: number;
  tier: string;
  model: string;
  reason: string;
  complexity: string;
}

export interface ModelCallRecord {
  at: number;
  model: string;
  latencyMs: number;
  ok: boolean;
  via: 'primary' | 'fallback' | 'escalation' | 'coalesced';
  errorKind?: string;
}

export interface EscalationRecord {
  at: number;
  from: string;
  to: string;
  reason: string;
}

export interface FallbackRecord {
  at: number;
  from: string;
  to: string | null;
  reason: string;
}

const RING_LIMIT = 100;
const TOOL_STATS_LIMIT = 64;

export interface PerfSnapshot {
  counters: {
    routes: number;
    escalations: number;
    fallbacks: number;
    cacheHits: number;
    cacheMisses: number;
    coalesced: number;
    modelCalls: number;
    modelCallFailures: number;
    tasksCompleted: number;
  };
  modelCalls: { avgLatencyMs: number; maxLatencyMs: number };
  tasks: { count: number; avgDurationMs: number };
  tools: { tool: string; count: number; avgMs: number }[];
  recent: {
    routes: RouteRecord[];
    modelCalls: ModelCallRecord[];
    escalations: EscalationRecord[];
    fallbacks: FallbackRecord[];
  };
}

export class PerformanceTelemetry {
  private counters = {
    routes: 0,
    escalations: 0,
    fallbacks: 0,
    cacheHits: 0,
    cacheMisses: 0,
    coalesced: 0,
    modelCalls: 0,
    modelCallFailures: 0,
    tasksCompleted: 0,
  };
  private routes: RouteRecord[] = [];
  private modelCalls: ModelCallRecord[] = [];
  private escalations: EscalationRecord[] = [];
  private fallbacks: FallbackRecord[] = [];
  private toolStats = new Map<string, { count: number; totalMs: number }>();
  private taskDurations: number[] = [];

  private pushRing<T>(ring: T[], item: T): void {
    ring.push(item);
    if (ring.length > RING_LIMIT) ring.shift();
  }

  recordRoute(record: RouteRecord): void {
    this.counters.routes++;
    this.pushRing(this.routes, record);
  }

  recordModelCall(record: ModelCallRecord): void {
    this.counters.modelCalls++;
    if (!record.ok) this.counters.modelCallFailures++;
    this.pushRing(this.modelCalls, record);
  }

  recordEscalation(record: EscalationRecord): void {
    this.counters.escalations++;
    this.pushRing(this.escalations, record);
  }

  recordFallback(record: FallbackRecord): void {
    this.counters.fallbacks++;
    this.pushRing(this.fallbacks, record);
  }

  recordCacheHit(key?: string): void {
    this.counters.cacheHits++;
    void key;
  }
  recordCacheMiss(key?: string): void {
    this.counters.cacheMisses++;
    void key;
  }
  recordCoalesced(_info: { at: number; key: string }): void {
    this.counters.coalesced++;
  }

  recordToolDuration(tool: string, durationMs: number): void {
    // Raw tool name as key — the map itself is bounded (TOOL_STATS_LIMIT).
    const stat = this.toolStats.get(tool) ?? { count: 0, totalMs: 0 };
    if (!this.toolStats.has(tool) && this.toolStats.size >= TOOL_STATS_LIMIT) {
      // Drop the least-used stat to stay bounded.
      let minKey = tool;
      let minCount = Number.MAX_SAFE_INTEGER;
      for (const [k, v] of this.toolStats) {
        if (v.count < minCount) {
          minCount = v.count;
          minKey = k;
        }
      }
      this.toolStats.delete(minKey);
    }
    stat.count++;
    stat.totalMs += Math.max(0, durationMs);
    this.toolStats.set(tool, stat);
  }

  recordTaskDuration(durationMs: number): void {
    this.counters.tasksCompleted++;
    this.taskDurations.push(Math.max(0, durationMs));
    if (this.taskDurations.length > RING_LIMIT) this.taskDurations.shift();
  }

  snapshot(): PerfSnapshot {
    const latencies = this.modelCalls.filter((m) => m.ok).map((m) => m.latencyMs);
    const avgLatencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
    const maxLatencyMs = latencies.length ? Math.max(...latencies) : 0;

    return {
      counters: { ...this.counters },
      modelCalls: { avgLatencyMs, maxLatencyMs },
      tasks: {
        count: this.taskDurations.length,
        avgDurationMs: this.taskDurations.length ? Math.round(this.taskDurations.reduce((a, b) => a + b, 0) / this.taskDurations.length) : 0,
      },
      tools: [...this.toolStats.entries()]
        .map(([tool, v]) => ({ tool, count: v.count, avgMs: Math.round(v.totalMs / v.count) }))
        .sort((a, b) => b.count * b.avgMs - a.count * a.avgMs)
        .slice(0, 5),
      recent: {
        routes: this.routes.slice(-20),
        modelCalls: this.modelCalls.slice(-20),
        escalations: this.escalations.slice(-20),
        fallbacks: this.fallbacks.slice(-20),
      },
    };
  }

  reset(): void {
    this.counters = {
      routes: 0,
      escalations: 0,
      fallbacks: 0,
      cacheHits: 0,
      cacheMisses: 0,
      coalesced: 0,
      modelCalls: 0,
      modelCallFailures: 0,
      tasksCompleted: 0,
    };
    this.routes = [];
    this.modelCalls = [];
    this.escalations = [];
    this.fallbacks = [];
    this.toolStats.clear();
    this.taskDurations = [];
  }
}

let singleton: PerformanceTelemetry | null = null;

/** Process-wide telemetry (server and agent each get their own instance). */
export function getPerformanceTelemetry(): PerformanceTelemetry {
  if (!singleton) singleton = new PerformanceTelemetry();
  return singleton;
}

export function resetPerformanceTelemetry(): void {
  getPerformanceTelemetry().reset();
}
