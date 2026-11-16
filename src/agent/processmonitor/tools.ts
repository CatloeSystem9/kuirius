/**
 * Process monitor agent tools (Phase A).
 *
 * ONE read-only visibility tool (`processMonitor.status`) backed by the
 * server monitor route. NO process-control tool exists — terminate, suspend
 * and quarantine capabilities are deliberately absent from the agent surface
 * (Phase A is monitoring only; containment is a later phase with its own
 * authorization model).
 *
 * The tool is SAFE/LOCAL/read-only: it never mutates host state, works under
 * the emergency stop, and returns monitor health + bounded inventory
 * metadata. It follows the exact AgentTool contract of the diagnostics
 * tools.
 */
import type { AgentTool, ToolResult } from '../types';
import { ok, fail } from '../types';

interface MonitorStatusResponse {
  status?: Record<string, unknown>;
  recentEvents?: Array<{ kind: string; pid: number; name?: string; path?: string; at: number }>;
  error?: string;
}

export function createProcessMonitorTools(): AgentTool[] {
  return [
    {
      name: 'processMonitor.status',
      description:
        'Read-only visibility into Krisha\'s independent host process monitor: health state, subscription status, event counters and a bounded recent-event view. Monitoring only — this tool cannot start, stop, suspend or modify any process.',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 1.0,
      capabilities: ['processMonitor.status', 'system.health'],
      permissions: [],
      inputSchema: {
        optional: ['recentCount', 'reconcile'],
        types: { recentCount: 'number', reconcile: 'boolean' },
      },
      verification: {
        strategy: 'self_reported',
        description: 'Reports the monitor\'s own health telemetry verbatim; a DEGRADED/FAILED monitor is reported as such, never as fully monitored.',
      },
      async execute(input): Promise<ToolResult> {
        const recentCount = Math.max(1, Math.min(200, Number(input?.recentCount) || 50));
        const reconcile = input?.reconcile === true;
        try {
          const res = await fetch(`/api/processmonitor/status?recent=${recentCount}${reconcile ? '&reconcile=1' : ''}`);
          const data = (await res.json()) as MonitorStatusResponse;
          if (data?.error) return fail(`process monitor unavailable: ${data.error}`, { errorKind: 'not_found' });
          const status = data.status ?? {};
          const health = String(status.health ?? 'UNKNOWN');
          return ok({
            output: {
              health,
              healthReason: status.healthReason,
              subscriptions: status.subscriptions,
              workerRestarts: status.workerRestarts,
              eventsReceived: status.eventsReceived,
              eventsDropped: status.eventsDropped,
              inventorySize: status.inventorySize,
              preexistingCount: status.preexistingCount,
              unobservedTerminations: status.unobservedTerminations,
              pidReuses: status.pidReuses,
              lastEventAt: status.lastEventAt,
              lastHeartbeatAt: status.lastHeartbeatAt,
              recentEvents: (data.recentEvents ?? []).map((e) => ({
                kind: e.kind,
                pid: e.pid,
                name: e.name,
                hasPath: !!e.path,
                at: e.at,
              })),
              monitoringNote:
                health === 'ACTIVE'
                  ? 'Process event monitoring is active (creation/termination telemetry).'
                  : `Monitoring is NOT fully active (${health}) — host visibility is incomplete and must not be claimed as monitored.`,
            },
          });
        } catch (err) {
          return fail(`process monitor status unavailable: ${String((err as Error)?.message || err)}`, { errorKind: 'not_found' });
        }
      },
    },
  ];
}
