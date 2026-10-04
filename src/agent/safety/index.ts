/**
 * Safety + Permission Hardening (Phase 18) — public surface.
 *
 * Central, fail-closed safety layer over the existing architecture: a
 * deterministic risk classifier, scoped/expiring/revocable grants, structured
 * permission decisions, an emergency stop wired to the existing cancellation
 * architecture, and a bounded redacted audit log. The gate is attached to the
 * ToolRegistry so every execution — from any caller — is evaluated; routing,
 * recovery, planning and proactive layers keep their own semantics unchanged.
 */
export * from './safetyTypes';
export { classifyRisk } from './riskClassifier';
export type { RiskAssessment } from './riskClassifier';
export { ScopedPermissionManager } from './scopedPermissions';
export type { ScopedCheckResult, GrantInput } from './scopedPermissions';
export { SafetyAuditLog } from './auditLog';
export { EmergencyStop } from './emergencyStop';
export { SafetyGate } from './safetyGate';
export { createSafetyTools } from './safetyTools';
export type { SafetyToolsDeps } from './safetyTools';
