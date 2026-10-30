/**
 * Self-Diagnostics v1: Runtime Health and Failure Awareness — Types.
 *
 * Defines the diagnostic registry schema, layered health checks, failure awareness
 * tracker, and structured diagnostic reporting for Krisha AI.
 */

export type SubsystemName =
  | 'core'
  | 'intelligence'
  | 'execution'
  | 'models'
  | 'persistence'
  | 'system';

export type DiagnosticSeverity = 'informational' | 'warning' | 'critical';

export type DiagnosticStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export type CheckType = 'passive' | 'active_probe' | 'configuration';

/** A bounded recursive evidence value. Diagnostic evidence never contains raw objects. */
export type DiagnosticEvidenceValue =
  | string
  | number
  | boolean
  | null
  | DiagnosticEvidenceValue[]
  | { [key: string]: DiagnosticEvidenceValue };

export type DiagnosticEvidence = Record<string, DiagnosticEvidenceValue>;

/** Whether a report used its passive default or explicitly included probes. */
export type DiagnosticRunMode = 'passive' | 'manual_probe';

/** A single diagnostic check definition. */
export interface DiagnosticCheckDef {
  /** Unique stable check ID, e.g. 'core.runtime.availability' */
  id: string;
  /** Human-readable title */
  name: string;
  /** Subsystem this check belongs to */
  subsystem: SubsystemName;
  /** What this check verifies */
  description: string;
  /** Baseline severity if this check fails */
  severity: DiagnosticSeverity;
  /** Nature of the check: passive inspection, safe active probe, or configuration validation */
  checkType: CheckType;
  /**
   * Synchronous local inspection only. Keeping v1 checks synchronous makes
   * their execution bounded without background timers, polling, or model/API
   * calls. Active probes are opt-in at report time and must still be read-only.
   */
  run: () => DiagnosticCheckOutcome;
}

/** The raw outcome returned by a check's run() method. */
export interface DiagnosticCheckOutcome {
  status: DiagnosticStatus;
  message: string;
  evidence?: DiagnosticEvidence;
  remediation?: string;
}

/** Result of executing a diagnostic check. */
export interface DiagnosticCheckResult {
  id: string;
  name: string;
  subsystem: SubsystemName;
  description: string;
  severity: DiagnosticSeverity;
  checkType: CheckType;
  status: DiagnosticStatus;
  message: string;
  timestamp: number;
  durationMs: number;
  evidence?: DiagnosticEvidence;
  remediation?: string;
}

/** Failure event passed into the failure tracker. */
export interface FailureEvent {
  subsystem: SubsystemName;
  source: string;
  error: string;
  taskId?: string;
  stepId?: string;
  toolName?: string;
  timestamp?: number;
  recoveryOutcome?: 'succeeded' | 'failed' | 'aborted' | 'none';
}

/** Aggregated failure record with recurrence tracking. */
export interface FailureRecord {
  fingerprint: string;
  subsystem: SubsystemName;
  source: string;
  error: string;
  occurrences: number;
  firstSeen: number;
  lastSeen: number;
  taskId?: string;
  stepId?: string;
  toolName?: string;
  affectedCapabilities: string[];
  lastRecoveryOutcome?: 'succeeded' | 'failed' | 'aborted' | 'none';
}

/** Structured diagnosis of a detected problem. */
export interface IssueDiagnosis {
  id: string;
  subsystem: SubsystemName;
  severity: DiagnosticSeverity;
  issue: string;
  evidence: string;
  affectedCapabilities: string[];
  likelyCause: string;
  isHypothesis: boolean;
  recommendation: string;
  userInterventionRequired: boolean;
}

/**
 * A direct observation of live control-plane state. This is deliberately
 * separate from a diagnostic assessment: a failing check does not alter this
 * state, and a healthy assessment is not an operational command or guarantee.
 */
export interface OperationalStateSnapshot {
  observedAt: number;
  activeTaskCount?: number;
  emergencyStopActive?: boolean;
  unavailableSources: string[];
}

export interface DiagnosticCacheInfo {
  source: 'fresh' | 'cache';
  ageMs: number;
}

/** Comprehensive diagnostic report generated on demand. */
export interface DiagnosticReport {
  /** Point-in-time assessment derived from diagnostic evidence only. */
  diagnosticStatus: DiagnosticStatus;
  /**
   * @deprecated Use diagnosticStatus. This remains an alias for compatibility;
   * it is a diagnostic assessment, never an operational state transition.
   */
  overallStatus: DiagnosticStatus;
  summary: string;
  timestamp: number;
  durationMs: number;
  runMode: DiagnosticRunMode;
  cache: DiagnosticCacheInfo;
  operationalState: OperationalStateSnapshot;
  subsystemHealth: Record<SubsystemName, DiagnosticStatus>;
  checkResults: DiagnosticCheckResult[];
  activeIssues: IssueDiagnosis[];
  recentFailures: FailureRecord[];
  metrics: {
    totalChecks: number;
    healthyChecks: number;
    degradedChecks: number;
    unhealthyChecks: number;
    unknownChecks: number;
    trackedFailureCount: number;
    reportedFailureCount: number;
  };
}
