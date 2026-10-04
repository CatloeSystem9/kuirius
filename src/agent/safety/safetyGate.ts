/**
 * Central safety gate (Phase 18, spec §4) — the single evaluation point for
 * every ToolRegistry execution, from ANY caller (Agent Core, planner, plan
 * engine, recovery, proactive, research, tools calling tools): the registry
 * invokes the gate before running a tool, so side-effecting actions cannot
 * bypass it.
 *
 * Decision pipeline per action:
 *   risk classification (deterministic)
 *   → emergency-stop check (side effects blocked while active)
 *   → permission coverage (authoritative PermissionManager + scoped grants,
 *     fail-closed on unknown permission ids — spec §19)
 *   → scoped-grant applicability (task/once/duration/expired/revoked)
 *   → audit entry (bounded, redacted)
 *
 * Compatibility contract: legacy session-wide grants keep working exactly as
 * before (recorded as 'allow (session grant)'); deny/require_confirmation
 * surfaces only where no authorization covers the action. The optional
 * `requireConfirmationForHighRisk` policy switch enables explicit
 * confirmation for high-risk actions for embedding UIs (Phase 20) without
 * changing the default behavior of existing legitimate flows.
 */
import type { PermissionManager } from '../permissions';
import type { SafetyAuditLog } from './auditLog';
import type { EmergencyStop } from './emergencyStop';
import { classifyRisk, type RiskAssessment } from './riskClassifier';
import type { ScopedPermissionManager } from './scopedPermissions';
import type { SafetyClass, SafetyDecisionKind, SafetyEvaluation } from './safetyTypes';

export interface SafetyGateOptions {
  /** Authoritative session permission layer (existing Phase 3 manager). */
  permissions?: PermissionManager;
  scoped?: ScopedPermissionManager;
  emergencyStop?: EmergencyStop;
  audit?: SafetyAuditLog;
  /** When true, high-risk actions need an explicit high-risk grant (UI phase). */
  requireConfirmationForHighRisk?: boolean;
  now?: () => number;
}

export interface GateContext {
  taskId?: string;
}

export class SafetyGate {
  readonly requireConfirmationForHighRisk: boolean;

  constructor(private options: SafetyGateOptions = {}) {
    this.requireConfirmationForHighRisk = options.requireConfirmationForHighRisk === true;
  }

  /**
   * Evaluate one tool invocation. NEVER throws and NEVER executes — the
   * caller (ToolRegistry) decides what to do with the decision.
   */
  evaluate(toolName: string, declaredRisk: string | undefined, declaredPermissions: string[] | undefined, input: Record<string, unknown> | undefined, context?: GateContext): SafetyEvaluation {
    const now = this.options.now ?? Date.now();
    const risk = classifyRisk(toolName, declaredRisk, input);
    const permissions = declaredPermissions ?? [];
    const inputKeys = Object.keys(input ?? {}).slice(0, 12);

    const finish = (decision: SafetyDecisionKind, reason: string, permission: string): SafetyEvaluation => {
      const evaluation: SafetyEvaluation = {
        decision,
        klass: risk.klass,
        permission,
        reason: reason.slice(0, 200),
        factors: risk.factors,
        auditId: '',
      };
      const entry = this.options.audit?.append({
        kind: decision === 'allow' ? 'executed' : decision === 'require_confirmation' ? 'confirmation_required' : 'blocked',
        tool: toolName,
        decision,
        klass: risk.klass,
        permission,
        reason: evaluation.reason,
        inputKeys,
        taskId: context?.taskId,
      });
      if (entry) evaluation.auditId = entry.id;
      return evaluation;
    };

    // 1. Permission coverage — FAIL CLOSED (spec §19): an unknown permission
    // id is a defect, never an implicit allow.
    const base = this.options.permissions;
    const unknown = permissions.filter((p) => !this.isKnownPermission(p));
    if (unknown.length > 0) {
      return finish('deny', `unknown permission id(s): ${unknown.join(', ')} — fail closed`, permissions[0] ?? 'unknown');
    }
    // Revocation is a kill-switch: it overrides even session-level grants
    // until an explicit new grant is made (spec §8).
    if (permissions[0] && this.options.scoped?.isRevoked(permissions[0])) {
      return finish('revoked', `permission "${permissions[0]}" has been revoked — re-authorization required`, permissions[0]);
    }
    const missing = base ? base.missing(permissions as never) : [];
    if (missing.length > 0) {
      // Scoped grants can satisfy coverage ONLY when the session layer
      // explicitly leaves the capability unset-by-default (not revoked).
      const satisfiedByScope = missing.every((p) => this.scopedSatisfies(p, context));
      if (!satisfiedByScope) {
        return finish('deny', `missing permission(s): ${missing.join(', ')}`, missing[0]);
      }
    }

    // 2. Emergency stop — new side-effecting actions are blocked; read-only
    // local work continues so the operator keeps visibility (spec §9).
    if (this.options.emergencyStop?.isActive() && risk.klass !== 'safe') {
      return finish('deny', `emergency stop active${this.options.emergencyStop.status().reason ? `: ${this.options.emergencyStop.status().reason}` : ''}`, permissions[0] ?? 'emergency');
    }

    // 3. High-risk policy (optional confirmation mode, spec §3).
    if (this.requireConfirmationForHighRisk && risk.klass === 'high_risk') {
      const highRiskGrant = this.scopedSatisfies('safety.high_risk_ack', context);
      if (!highRiskGrant) {
        return finish('require_confirmation', `high-risk action requires explicit confirmation: ${risk.factors.join('; ')}`, permissions[0] ?? 'safety.high_risk_ack');
      }
    }

    // 4. Allowed — with the governing scope recorded for the audit trail.
    const scopeText = base ? 'session grant' : 'no base layer (decision-only registry)';
    return finish('allow', `allowed (${scopeText}); risk ${risk.klass}`, permissions[0] ?? 'none');
  }

  private scopedSatisfies(permission: string, context?: GateContext): boolean {
    const scoped = this.options.scoped;
    if (!scoped) return false;
    const result = scoped.check(permission, context);
    return result.status === 'granted';
  }

  private isKnownPermission(permission: string): boolean {
    // The authoritative domain list lives in the Phase 3 PermissionManager.
    // Import-cycle-free check via the base manager when available.
    const base = this.options.permissions;
    if (base) {
      const probe = base as unknown as { isKnown?: (p: string) => boolean };
      if (typeof probe.isKnown === 'function') return probe.isKnown(permission);
    }
    // Fallback: the Phase 3 domain list (kept in sync with permissions.ts).
    const KNOWN = new Set([
      'screen.observation', 'mouse.control', 'keyboard.control', 'browser.interaction',
      'filesystem.read', 'filesystem.write', 'application.launch', 'terminal.execution',
      'camera.access', 'microphone.access', 'location.access', 'memory.access',
      'safety.high_risk_ack',
    ]);
    return KNOWN.has(permission);
  }
}

/** Re-exported for the gate's callers (tools, tests). */
export type { RiskAssessment, SafetyClass };
