/**
 * Safety tools (Phase 18) — operator-facing visibility and control through
 * the Phase 3 contract. Deliberately NO self-grant tool exists: the agent
 * can never widen its own permissions (spec §4/§14); grants are made by the
 * embedding application/user, not by Krisha.
 */
import type { AgentTool } from '../types';
import type { SafetyGate } from './safetyGate';
import type { ScopedPermissionManager } from './scopedPermissions';
import type { SafetyAuditLog } from './auditLog';
import type { EmergencyStop } from './emergencyStop';

export interface SafetyToolsDeps {
  gate: SafetyGate;
  scoped: ScopedPermissionManager;
  audit: SafetyAuditLog;
  emergencyStop: EmergencyStop;
}

export function createSafetyTools(deps: SafetyToolsDeps): AgentTool[] {
  const { gate, scoped, audit, emergencyStop } = deps;
  return [
    {
      name: 'safety.status',
      description: 'Read the current safety posture: emergency-stop state, active scoped permissions, gate policy. Read-only, no side effects.',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 0.99,
      capabilities: ['safety.status'],
      permissions: [],
      inputSchema: {},
      verification: { strategy: 'self_reported', description: 'Direct read of live safety state.' },
      timeoutMs: 2_000,
      async execute(): Promise<any> {
        return {
          success: true,
          output: {
            summary: `Emergency stop: ${emergencyStop.isActive() ? 'ACTIVE' : 'inactive'}. Scoped grants: ${scoped.count()}. High-risk confirmation mode: ${gate.requireConfirmationForHighRisk ? 'on' : 'off'}.`,
            emergencyStop: emergencyStop.status(),
            grants: scoped.list().map((g) => ({ permission: g.permission, scope: g.scopeText, reason: g.reason })),
            requireConfirmationForHighRisk: gate.requireConfirmationForHighRisk,
          },
        };
      },
    },
    {
      name: 'safety.emergency_stop',
      description: 'Activate the safety emergency stop: cancels active tasks, revokes temporary permissions, and blocks new side-effecting actions. E5 M1: the stop is persisted server-side and CANNOT be deactivated through any tool — only the operator recovery CLI (with the recovery credential) can lift it.',
      category: 'system',
      riskLevel: 'low',
      cost: 'free',
      reliability: 0.99,
      capabilities: ['safety.emergency_stop'],
      permissions: [],
      inputSchema: {
        required: ['activate'],
        optional: ['reason'],
        types: { activate: 'boolean', reason: 'string' },
      },
      verification: { strategy: 'self_reported', description: 'The stop state itself is the verifiable effect; audited server-side.' },
      timeoutMs: 5_000,
      async execute(input): Promise<any> {
        // E5 M1c (decision D3/D4): activation is safety-positive and remains
        // model-callable. DEACTIVATION IS STRUCTURALLY ABSENT — the only
        // recovery path is the operator recovery CLI + recovery credential.
        if (input.activate !== true) {
          return {
            success: false,
            errorKind: 'invalid_input',
            retryable: false,
            error: 'deactivation is not available through tools — only the operator recovery CLI with the recovery credential can lift an emergency stop',
          };
        }
        const result = emergencyStop.activate(String(input.reason ?? 'operator requested emergency stop'));
        return {
          success: true,
          output: {
            summary: `EMERGENCY STOP ACTIVE: ${result.reason}. Side-effecting actions are blocked until operator recovery.`,
            ...result,
            recovery: 'operator CLI required (krisha-recovery) — the model cannot lift this stop',
          },
        };
      },
    },
    {
      name: 'safety.audit',
      description: 'Read recent safety-audit entries (bounded, redacted): decisions, blocks, grants, revocations, emergency events.',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 0.99,
      capabilities: ['safety.audit'],
      permissions: [],
      inputSchema: { optional: ['limit'], types: { limit: 'number' } },
      verification: { strategy: 'self_reported', description: 'Direct read of the bounded audit ring.' },
      timeoutMs: 2_000,
      async execute(input): Promise<any> {
        const limit = Math.max(1, Math.min(Number(input.limit ?? 20), 100));
        const entries = audit.recent(limit);
        return {
          success: true,
          output: {
            summary: `${entries.length} audit entr(ies); ${audit.count()} stored (bounded ring).`,
            entries,
          },
        };
      },
    },
  ];
}
