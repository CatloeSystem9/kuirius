/**
 * Self-Diagnostics v1: System Consistency Checks.
 *
 * Verifies overall subsystem wiring, dependency cross-connections,
 * and loop cycle trace health.
 */

import type { DiagnosticCheckDef, DiagnosticCheckOutcome } from '../diagnosticTypes';
import type { AgentCore } from '../../agentCore';
import type { ToolRegistry } from '../../toolRegistry';
import type { AgentEventBus } from '../../events';
import type { PermissionManager } from '../../permissions';
import type { TaskStore } from '../../taskState';

export interface SystemCheckDeps {
  core?: AgentCore;
  registry?: ToolRegistry;
  bus?: AgentEventBus;
  permissions?: PermissionManager;
  store?: TaskStore;
}

export function createSystemChecks(deps: SystemCheckDeps): DiagnosticCheckDef[] {
  return [
    {
      id: 'system.subsystem_wiring',
      name: 'Subsystem Interconnection & Dependency Health',
      subsystem: 'system',
      description: 'Verifies required subsystems are properly wired to AgentCore and not broken or disconnected.',
      severity: 'critical',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        const core = deps.core;
        if (!core) {
          return {
            status: 'unhealthy',
            message: 'Agent Core reference is missing from system wiring check.',
            remediation: 'Ensure AgentCore is initialized.',
          };
        }

        const brokenLinks: string[] = [];

        if (!core.registry) brokenLinks.push('AgentCore.registry is missing');
        if (!core.events) brokenLinks.push('AgentCore.events is missing');
        if (!core.store) brokenLinks.push('AgentCore.store is missing');
        if (!core.permissions) brokenLinks.push('AgentCore.permissions is missing');
        if (!core.recovery) brokenLinks.push('AgentCore.recovery is missing');

        if (brokenLinks.length > 0) {
          return {
            status: 'unhealthy',
            message: `Broken subsystem connections detected: ${brokenLinks.join('; ')}`,
            evidence: { brokenLinks },
            remediation: 'Review AgentCore constructor options in bridge.ts.',
          };
        }

        return {
          status: 'healthy',
          message: 'All core subsystem interconnections are valid and properly wired.',
          evidence: {
            registry: Boolean(core.registry),
            events: Boolean(core.events),
            store: Boolean(core.store),
            permissions: Boolean(core.permissions),
            recovery: Boolean(core.recovery),
          },
        };
      },
    },
    {
      id: 'system.cycle_traces',
      name: 'Intelligence Loop Trace Store',
      subsystem: 'system',
      description: 'Inspects Intelligence Loop cycle trace capacity and recent trace records.',
      severity: 'informational',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        const traces = typeof deps.core?.cycleTrace?.list === 'function'
          ? deps.core.cycleTrace.list()
          : typeof deps.core?.cycleTrace?.size === 'number'
          ? Array.from({ length: deps.core.cycleTrace.size })
          : undefined;
        if (!traces) {
          return {
            status: 'unknown',
            message: 'Cycle trace store is not available on AgentCore.',
            remediation: 'Ensure cycleTrace is exposed on AgentCore.',
          };
        }

        return {
          status: 'healthy',
          message: `Cycle trace store is tracking ${traces.length} task trace(s).`,
          evidence: {
            activeTraces: traces.length,
          },
        };
      },
    },
  ];
}
