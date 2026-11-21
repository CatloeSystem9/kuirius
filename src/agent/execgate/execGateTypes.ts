/**
 * Execution Gate (Phase C) — types.
 *
 * Centralized execution decision engine for Krisha-managed launches.
 * Blocks confirmed malware non-overridably; requires approval for
 * suspicious software; fail-closed when telemetry is unavailable.
 *
 * Does NOT provide system-wide execution protection (that requires
 * elevation / AppLocker / WDAC — documented in the Phase C report).
 */
export type ExecutionDecision =
  | 'ALLOW'
  | 'BLOCK_CONFIRMED_MALWARE'
  | 'REQUIRE_USER_APPROVAL'
  | 'DENY_UNVERIFIED'
  | 'BLOCK_SYSTEM_UNAVAILABLE';

export interface ExecutionPolicyInput {
  /** Absolute normalized path of the executable to launch. */
  path: string;
  /** Display name (from app discovery). */
  name?: string;
  /** Whether the operator has approved this specific launch. */
  approvalToken?: string;
}

export interface ExecutionDecisionResult {
  decision: ExecutionDecision;
  /** Content-free explanation (no secret material). */
  reason: string;
  /** Classification that drove the decision (if available). */
  classification?: string;
  confidence?: string;
  /** File identity at assessment time (for replacement detection). */
  fileIdentity?: { path: string; mtimeMs: number; size: number };
  /** Audit event kind for E5 chain. */
  auditKind: string;
  /** Approval token issued (REQUIRE_USER_APPROVAL only, after operator approval). */
  approvalToken?: string;
}

export interface ApprovalToken {
  token: string;
  path: string;
  /** File identity at approval time (replacement detection). */
  mtimeMs: number;
  size: number;
  issuedAt: number;
  expiresAt: number;
  used: boolean;
  classification: string;
}

export interface ExecGateHealth {
  health: 'ACTIVE' | 'STOPPED' | 'UNAVAILABLE';
  monitorHealth: string | null;
  engineHealth: string | null;
  defenderAvailable: boolean | null;
  pendingApprovals: number;
}
