/**
 * Self-Diagnostics v1: Diagnostic Registry.
 *
 * Manages bounded, synchronous diagnostic checks. V1 intentionally does not
 * schedule timers or await arbitrary promises: default checks are local,
 * deterministic observations, and active probes require explicit opt-in.
 */

import type {
  DiagnosticCheckDef,
  DiagnosticCheckResult,
  DiagnosticCheckOutcome,
  DiagnosticEvidence,
  DiagnosticEvidenceValue,
  SubsystemName,
  DiagnosticSeverity,
} from './diagnosticTypes';
import { redactText } from '../safety/safetyTypes';

export interface RunCheckOptions {
  /** Active probes are never included in the passive default report. */
  includeActiveProbes?: boolean;
}

export const MAX_DIAGNOSTIC_CHECKS = 32;
const MAX_EVIDENCE_KEYS = 12;
const MAX_EVIDENCE_ARRAY_ITEMS = 12;

function boundedText(value: unknown, fallback = 'Unavailable'): string {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value);
  return redactText(text);
}

function sanitizeEvidenceValue(value: unknown, depth = 0): DiagnosticEvidenceValue {
  if (depth >= 3) return '[truncated]';
  if (value === null) return null;
  if (typeof value === 'string') return boundedText(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[non-finite]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_EVIDENCE_ARRAY_ITEMS).map((item) => sanitizeEvidenceValue(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_EVIDENCE_KEYS);
    return Object.fromEntries(entries.map(([key, item]) => [boundedText(key), sanitizeEvidenceValue(item, depth + 1)]));
  }
  return boundedText(value);
}

function sanitizeEvidence(evidence: unknown): DiagnosticEvidence | undefined {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return undefined;
  const entries = Object.entries(evidence as Record<string, unknown>).slice(0, MAX_EVIDENCE_KEYS);
  return Object.fromEntries(entries.map(([key, value]) => [boundedText(key), sanitizeEvidenceValue(value, 1)])) as DiagnosticEvidence;
}

function isDiagnosticStatus(value: unknown): value is DiagnosticCheckOutcome['status'] {
  return value === 'healthy' || value === 'degraded' || value === 'unhealthy' || value === 'unknown';
}

export class DiagnosticRegistry {
  private checks = new Map<string, DiagnosticCheckDef>();

  register(check: DiagnosticCheckDef): void {
    if (!check?.id) throw new Error('Diagnostic check must have a valid id');
    if (typeof check.run !== 'function') throw new Error(`Diagnostic check "${check.id}" must define a synchronous run function`);
    if (this.checks.has(check.id)) {
      throw new Error(`Diagnostic check already registered: ${check.id}`);
    }
    if (this.checks.size >= MAX_DIAGNOSTIC_CHECKS) {
      throw new Error(`Diagnostic registry is bounded to ${MAX_DIAGNOSTIC_CHECKS} checks`);
    }
    this.checks.set(check.id, check);
  }

  registerAll(checks: DiagnosticCheckDef[]): void {
    for (const check of checks) {
      this.register(check);
    }
  }

  unregister(id: string): boolean {
    return this.checks.delete(id);
  }

  get(id: string): DiagnosticCheckDef | undefined {
    return this.checks.get(id);
  }

  list(): DiagnosticCheckDef[] {
    return Array.from(this.checks.values());
  }

  findBySubsystem(subsystem: SubsystemName): DiagnosticCheckDef[] {
    return this.list().filter((c) => c.subsystem === subsystem);
  }

  findBySeverity(severity: DiagnosticSeverity): DiagnosticCheckDef[] {
    return this.list().filter((c) => c.severity === severity);
  }

  clear(): void {
    this.checks.clear();
  }

  /**
   * Run one local check. Exceptions and malformed output become an evidence
   * result; diagnostics never bubble an error into Agent Core execution.
   */
  runCheck(id: string, _options: RunCheckOptions = {}): DiagnosticCheckResult {
    const check = this.checks.get(id);
    const now = Date.now();

    if (!check) {
      return {
        id,
        name: 'Unknown check',
        subsystem: 'system',
        description: 'Missing diagnostic check',
        severity: 'warning',
        checkType: 'passive',
        status: 'unknown',
        message: `Diagnostic check "${id}" is not registered in the registry.`,
        timestamp: now,
        durationMs: 0,
        remediation: 'Ensure all standard diagnostic checks are registered during initialization.',
      };
    }

    const start = Date.now();
    try {
      const outcome = check.run();
      if (!outcome || !isDiagnosticStatus(outcome.status) || typeof outcome.message !== 'string') {
        throw new Error('Check returned an invalid diagnostic outcome');
      }

      const durationMs = Date.now() - start;

      return {
        id: check.id,
        name: check.name,
        subsystem: check.subsystem,
        description: check.description,
        severity: check.severity,
        checkType: check.checkType,
        status: outcome.status,
        message: boundedText(outcome.message),
        timestamp: now,
        durationMs,
        evidence: sanitizeEvidence(outcome.evidence),
        remediation: outcome.remediation ? boundedText(outcome.remediation) : undefined,
      };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const safeError = boundedText(err?.message || err, 'Unknown diagnostic check failure');

      return {
        id: check.id,
        name: check.name,
        subsystem: check.subsystem,
        description: check.description,
        severity: check.severity,
        checkType: check.checkType,
        status: 'unhealthy',
        message: `Check execution failed: ${safeError}`,
        timestamp: now,
        durationMs,
        evidence: {
          errorName: boundedText(err?.name, 'Error'),
          errorMessage: safeError,
        },
        remediation: 'Review the check implementation and the referenced subsystem state.',
      };
    }
  }

  /**
   * Run all checks matching an optional filter.
   */
  runAll(filter?: {
    subsystem?: SubsystemName;
    severity?: DiagnosticSeverity;
  }, options?: RunCheckOptions): DiagnosticCheckResult[] {
    let selected = this.list();
    if (filter?.subsystem) {
      selected = selected.filter((c) => c.subsystem === filter.subsystem);
    }
    if (filter?.severity) {
      selected = selected.filter((c) => c.severity === filter.severity);
    }
    if (!options?.includeActiveProbes) {
      selected = selected.filter((c) => c.checkType !== 'active_probe');
    }

    const results: DiagnosticCheckResult[] = [];
    for (const check of selected) {
      results.push(this.runCheck(check.id, options));
    }
    return results;
  }
}
