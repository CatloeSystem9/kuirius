/**
 * Self-Diagnostics v1: Core Runtime Checks.
 *
 * Verifies Agent Core, a bounded task lifecycle sample, and event bus access.
 */

import type { DiagnosticCheckDef, DiagnosticCheckOutcome } from '../diagnosticTypes';
import type { AgentCore } from '../../agentCore';
import type { AgentEventBus } from '../../events';
import type { TaskStore } from '../../taskState';

export interface CoreCheckDeps {
  core?: AgentCore;
  bus?: AgentEventBus;
  store?: TaskStore;
}

export function createCoreChecks(deps: CoreCheckDeps): DiagnosticCheckDef[] {
  return [
    {
      id: 'core.runtime.availability',
      name: 'Agent Core Runtime Availability',
      subsystem: 'core',
      description: 'Verifies Agent Core instance is constructed, configured, and responsive.',
      severity: 'critical',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        if (!deps.core) {
          return {
            status: 'unhealthy',
            message: 'Agent Core instance is not configured or missing.',
            remediation: 'Ensure AgentCore is instantiated during application bootstrap.',
          };
        }
        return {
          status: 'healthy',
          message: 'Agent Core is instantiated and available.',
          evidence: {
            hasStore: Boolean(deps.core.store),
            hasRegistry: Boolean(deps.core.registry),
            hasPermissions: Boolean(deps.core.permissions),
            hasEvents: Boolean(deps.core.events),
          },
        };
      },
    },
    {
      id: 'core.task.lifecycle',
      name: 'Task Lifecycle Consistency',
      subsystem: 'core',
      description: 'Checks task store records for contradictory lifecycle states.',
      severity: 'warning',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        const store = deps.store ?? deps.core?.store;
        if (!store) {
          return {
            status: 'unknown',
            message: 'TaskStore reference not available for lifecycle audit.',
            remediation: 'Provide TaskStore instance to diagnostics.',
          };
        }

        const sampleLimit = 20;
        const tasks = store.sample(sampleLimit);
        const contradictory: { taskId: string; reason: string }[] = [];

        for (const task of tasks) {
          if (task.status === 'completed' && (!task.completedAt || task.completedAt < task.createdAt)) {
            contradictory.push({
              taskId: task.id,
              reason: 'Task is marked completed but has an invalid completedAt timestamp.',
            });
          }
          if (task.status === 'running' && task.completedAt) {
            contradictory.push({
              taskId: task.id,
              reason: 'Task is marked running but completedAt is already populated.',
            });
          }
        }

        if (contradictory.length > 0) {
          return {
            status: 'degraded',
            message: `Detected ${contradictory.length} contradictory state(s) in a bounded task sample.`,
            evidence: { contradictoryTasks: contradictory, sampledTasks: tasks.length, sampleLimit },
            remediation: 'Inspect task state mutations in AgentCore to ensure consistent transitions.',
          };
        }

        return {
          status: 'healthy',
          message: `Task lifecycle states are consistent in a bounded sample of ${tasks.length} task(s).`,
          evidence: { sampledTasks: tasks.length, sampleLimit },
        };
      },
    },
    {
      id: 'core.events.bus',
      name: 'Agent Event Bus Registration & Delivery',
      subsystem: 'core',
      description: 'Passively verifies that the bounded event buffer can be read.',
      severity: 'critical',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        const bus = deps.bus ?? deps.core?.events;
        if (!bus) {
          return {
            status: 'unhealthy',
            message: 'AgentEventBus is missing or undefined.',
            remediation: 'Instantiate AgentEventBus before initializing subsystems.',
          };
        }

        try {
          const events = bus.recentEvents();
          if (!Array.isArray(events)) {
            return {
              status: 'unhealthy',
              message: 'Event bus recent-event buffer did not return an array.',
              remediation: 'Review AgentEventBus buffer implementation.',
            };
          }
          return {
            status: 'healthy',
            message: `Agent Event Bus buffer is readable (${events.length} buffered event(s)); no synthetic event was emitted.`,
            evidence: { bufferedEvents: events.length },
          };
        } catch (err: any) {
          return {
            status: 'unhealthy',
            message: `Event bus buffer inspection failed: ${err?.message || String(err)}`,
            remediation: 'Review AgentEventBus buffer implementation.',
          };
        }
      },
    },
  ];
}
