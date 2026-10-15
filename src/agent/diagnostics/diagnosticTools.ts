/**
 * Self-Diagnostics v1: Diagnostic Agent Tools.
 *
 * Exposes control-plane tools (`diagnostics.health`, `diagnostics.inspect`)
 * adhering to the Phase 3 AgentTool contract (SAFE, FREE, LOCAL).
 */

import type { AgentTool, ToolResult } from '../types';
import { ok } from '../types';
import type { DiagnosticsService } from './diagnosticsService';
import type { SubsystemName } from './diagnosticTypes';

export function createDiagnosticTools(diagnostics: DiagnosticsService): AgentTool[] {
  return [
    {
      name: 'diagnostics.health',
      description: 'Check Krisha\'s own operational health, subsystem statuses, failure awareness, and verified recommendations. Safe and read-only.',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 1.0,
      capabilities: ['diagnostics.health', 'system.health'],
      permissions: [],
      inputSchema: {
        optional: ['refresh'],
        types: { refresh: 'boolean' },
      },
      verification: {
        strategy: 'self_reported',
        description: 'Verified diagnostic report aggregated across all subsystem checks.',
      },
      timeoutMs: 5000,
      async execute(input): Promise<ToolResult> {
        const refresh = Boolean(input?.refresh);
        const report = await diagnostics.generateReport({ refresh });

        const formattedIssues = report.activeIssues.map((issue) => ({
          subsystem: issue.subsystem,
          severity: issue.severity,
          issue: issue.issue,
          likelyCause: issue.likelyCause,
          isHypothesis: issue.isHypothesis,
          recommendation: issue.recommendation,
          userInterventionRequired: issue.userInterventionRequired,
        }));

        return ok({
          output: {
            overallStatus: report.overallStatus,
            summary: report.summary,
            subsystemHealth: report.subsystemHealth,
            metrics: report.metrics,
            activeIssues: formattedIssues,
            timestamp: report.timestamp,
            durationMs: report.durationMs,
          },
        });
      },
    },
    {
      name: 'diagnostics.inspect',
      description: 'Inspect detailed check results and failure logs for a specific subsystem. Safe and read-only.',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 1.0,
      capabilities: ['diagnostics.inspect'],
      permissions: [],
      inputSchema: {
        optional: ['subsystem'],
        types: { subsystem: 'string' },
      },
      verification: {
        strategy: 'self_reported',
        description: 'Detailed subsystem diagnostics with check results and evidence.',
      },
      timeoutMs: 5000,
      async execute(input): Promise<ToolResult> {
        const targetSubsystem = input?.subsystem as SubsystemName | undefined;
        const report = await diagnostics.generateReport();

        let filteredChecks = report.checkResults;
        let filteredFailures = report.recentFailures;

        if (targetSubsystem) {
          filteredChecks = filteredChecks.filter((c) => c.subsystem === targetSubsystem);
          filteredFailures = filteredFailures.filter((f) => f.subsystem === targetSubsystem);
        }

        return ok({
          output: {
            subsystem: targetSubsystem || 'all',
            status: targetSubsystem ? report.subsystemHealth[targetSubsystem] : report.overallStatus,
            checks: filteredChecks.map((c) => ({
              id: c.id,
              name: c.name,
              status: c.status,
              severity: c.severity,
              message: c.message,
              durationMs: c.durationMs,
              evidence: c.evidence,
              remediation: c.remediation,
            })),
            recentFailures: filteredFailures.slice(0, 10),
          },
        });
      },
    },
  ];
}
