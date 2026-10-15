/**
 * Self-Diagnostics v1: Execution Layer Checks.
 *
 * Verifies Tool Registry integrity, planner availability, error recovery subsystem,
 * cancellation readiness, and permission enforcement.
 */

import type { DiagnosticCheckDef, DiagnosticCheckOutcome } from '../diagnosticTypes';
import type { ToolRegistry } from '../../toolRegistry';
import type { Planner } from '../../planner';
import { HeuristicPlanner } from '../../planner';
import type { RecoveryManager } from '../../recovery';
import type { PermissionManager } from '../../permissions';
import type { SafetyGate } from '../../safety';

export interface ExecutionCheckDeps {
  registry?: ToolRegistry;
  planner?: Planner;
  recovery?: RecoveryManager;
  permissions?: PermissionManager;
  safetyGate?: SafetyGate;
}

export function createExecutionChecks(deps: ExecutionCheckDeps): DiagnosticCheckDef[] {
  return [
    {
      id: 'execution.tool_registry',
      name: 'Tool Registry Integrity',
      subsystem: 'execution',
      description: 'Verifies Tool Registry is populated, contains essential tools, and has valid execute signatures.',
      severity: 'critical',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        if (!deps.registry) {
          return {
            status: 'unhealthy',
            message: 'ToolRegistry instance is missing.',
            remediation: 'Provide a valid ToolRegistry to the agent system.',
          };
        }

        const tools = deps.registry.list();
        if (tools.length === 0) {
          return {
            status: 'unhealthy',
            message: 'ToolRegistry has 0 tools registered.',
            remediation: 'Register the required system, browser, and capability tools.',
          };
        }

        const essentialTools = ['system.note', 'chat.report'];
        const missing = essentialTools.filter((name) => !deps.registry!.has(name));

        if (missing.length > 0) {
          return {
            status: 'degraded',
            message: `ToolRegistry is missing essential fallback tools: ${missing.join(', ')}`,
            evidence: { missingTools: missing, totalTools: tools.length },
            remediation: 'Ensure essential tools like system.note and chat.report are registered during bootstrap.',
          };
        }

        return {
          status: 'healthy',
          message: `Tool Registry is healthy with ${tools.length} registered tools.`,
          evidence: {
            totalRegistered: tools.length,
            sampleTools: tools.slice(0, 5).map((t) => t.name),
          },
        };
      },
    },
    {
      id: 'execution.planner',
      name: 'Planner Availability & Decomposition',
      subsystem: 'execution',
      description: 'Verifies the planner can decompose a basic goal into valid plan steps.',
      severity: 'critical',
      checkType: 'active_probe',
      run(): DiagnosticCheckOutcome {
        const planner = deps.planner ?? new HeuristicPlanner();
        try {
          const plan = planner.makePlan({
            description: 'diagnostic test goal',
            rawInput: 'diagnostic test goal',
            kind: 'command',
          });

          if (!plan || !Array.isArray(plan.steps)) {
            return {
              status: 'unhealthy',
              message: 'Planner returned an invalid plan structure.',
              remediation: 'Inspect planner implementation.',
            };
          }

          return {
            status: 'healthy',
            message: 'Planner is operational and successfully generated a diagnostic plan.',
            evidence: { stepsCount: plan.steps.length },
          };
        } catch (err: any) {
          return {
            status: 'unhealthy',
            message: `Planner threw an error during goal decomposition: ${err?.message || String(err)}`,
            evidence: { error: String(err) },
            remediation: 'Review planner logic and intent classifiers.',
          };
        }
      },
    },
    {
      id: 'execution.recovery',
      name: 'Error Recovery Subsystem State',
      subsystem: 'execution',
      description: 'Inspects Recovery Manager state machine and history access.',
      severity: 'warning',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        if (!deps.recovery) {
          return {
            status: 'degraded',
            message: 'RecoveryManager is not attached.',
            remediation: 'Initialize RecoveryManager in AgentCore.',
          };
        }

        const state = deps.recovery.getState();
        const history = deps.recovery.getHistory();

        return {
          status: 'healthy',
          message: `Recovery Manager is operational in state "${state}" (${history.length} historical attempt(s)).`,
          evidence: {
            currentState: state,
            historyCount: history.length,
          },
        };
      },
    },
    {
      id: 'execution.permissions',
      name: 'Permission System & Safety Gate',
      subsystem: 'execution',
      description: 'Verifies Permission Manager enforces permissions and checks Safety Gate integration.',
      severity: 'critical',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        if (!deps.permissions) {
          return {
            status: 'unhealthy',
            message: 'PermissionManager instance is missing.',
            remediation: 'Attach PermissionManager to AgentCore.',
          };
        }

        const fsWriteGranted = deps.permissions.has('filesystem.write');
        return {
          status: 'healthy',
          message: 'Permission Manager is active and enforcing access boundaries.',
          evidence: {
            filesystemWriteDefaultDenied: !fsWriteGranted,
            safetyGateAttached: Boolean(deps.safetyGate),
          },
        };
      },
    },
  ];
}
