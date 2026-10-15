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
  /** Execution logic */
  run: () => Promise<DiagnosticCheckOutcome> | DiagnosticCheckOutcome;
}

/** The raw outcome returned by a check's run() method. */
export interface DiagnosticCheckOutcome {
  status: DiagnosticStatus;
  message: string;
  evidence?: Record<string, unknown>;
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
  evidence?: Record<string, unknown>;
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

/** Comprehensive diagnostic report generated on demand. */
export interface DiagnosticReport {
  overallStatus: DiagnosticStatus;
  summary: string;
  timestamp: number;
  durationMs: number;
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
    activeFailuresCount: number;
  };
}
