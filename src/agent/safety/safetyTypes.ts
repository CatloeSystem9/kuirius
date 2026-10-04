/**
 * Safety + Permission Hardening (Phase 18) — shared types.
 *
 * A structured permission decision model (spec §6), scoped grants (spec §5/§7),
 * deterministic risk classes (spec §10), and a bounded, redacted audit trail
 * (spec §18). Everything here is plain data — no I/O, no timers, no model.
 */

/** Central safety decision for one action (spec §6). */
export type SafetyDecisionKind = 'allow' | 'deny' | 'require_confirmation' | 'expired' | 'revoked';

export type SafetyClass = 'safe' | 'confirm' | 'high_risk' | 'deny';

/** Grant scope (spec §5/§7) — authorization is never broader than requested. */
export type GrantScope =
  | { kind: 'once' }
  | { kind: 'task'; taskId: string }
  | { kind: 'session' }
  | { kind: 'duration'; expiresAt: number };

export interface ScopedGrant {
  id: string;
  permission: string; // PermissionManager domain (typed) or validated capability
  scope: GrantScope;
  /** Human-readable justification recorded in the audit trail. */
  reason: string;
  grantedAt: number;
  /** Emergency/global revoke clears this id. */
  temporary: boolean;
}

export interface SafetyEvaluation {
  decision: SafetyDecisionKind;
  klass: SafetyClass;
  /** Capability-oriented permission the decision is about. */
  permission: string;
  reason: string;
  /** Which scope satisfied (or was demanded of) the action. */
  scope?: string;
  /** Deterministic risk factors that produced the class. */
  factors: string[];
  /** Bounded audit reference. */
  auditId: string;
}

export type AuditKind =
  | 'executed'
  | 'blocked'
  | 'granted'
  | 'revoked'
  | 'expired'
  | 'emergency_stop'
  | 'emergency_resume'
  | 'confirmation_required';

export interface AuditEntry {
  id: string;
  at: number;
  kind: AuditKind;
  /** Tool name — never payloads. */
  tool?: string;
  decision?: SafetyDecisionKind;
  klass?: SafetyClass;
  permission?: string;
  reason?: string;
  /** Input KEYS only — values are never recorded (spec §17). */
  inputKeys?: string[];
  taskId?: string;
}

/** Redact anything that could carry a secret before it touches the audit log. */
export function redactText(text: string): string {
  return String(text ?? '')
    .replace(/\b(?:sk|pk|api)[-_]?[a-z0-9]{8,}/gi, '[redacted]')
    .replace(/\b(?:authorization|bearer|password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*\S+/gi, '$1: [redacted]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]')
    .slice(0, 200);
}

export function describeScope(scope: GrantScope): string {
  switch (scope.kind) {
    case 'once': return 'one action';
    case 'task': return `task ${scope.taskId}`;
    case 'session': return 'this session';
    case 'duration': return `until ${new Date(scope.expiresAt).toISOString()}`;
  }
}
