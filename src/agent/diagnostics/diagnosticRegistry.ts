/**
 * Self-Diagnostics v1: Diagnostic Registry.
 *
 * Manages diagnostic checks, runs them with bounded execution times,
 * catches unhandled exceptions to prevent agent crashes, and produces
 * structured check results.
 */

import type {
  DiagnosticCheckDef,
  DiagnosticCheckResult,
  SubsystemName,
  DiagnosticSeverity,
} from './diagnosticTypes';

export interface RunCheckOptions {
  timeoutMs?: number;
}

export class DiagnosticRegistry {
  private checks = new Map<string, DiagnosticCheckDef>();

  register(check: DiagnosticCheckDef): void {
    if (!check?.id) throw new Error('Diagnostic check must have a valid id');
    if (this.checks.has(check.id)) {
      throw new Error(`Diagnostic check already registered: ${check.id}`);
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
   * Run a single diagnostic check safely under an isolated timer.
   * If the check throws, times out, or returns invalid data, an honest
   * unhealthy/degraded result is returned instead of bubbling an exception.
   */
  async runCheck(id: string, options: RunCheckOptions = {}): Promise<DiagnosticCheckResult> {
    const check = this.checks.get(id);
    const now = Date.now();
    const timeoutMs = Math.max(500, Math.min(options.timeoutMs ?? 3000, 10000));

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
      const outcomePromise = Promise.resolve(check.run());
      let timeoutHandle: any;

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Diagnostic check timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      const outcome = await Promise.race([outcomePromise, timeoutPromise]).finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      });

      const durationMs = Date.now() - start;

      return {
        id: check.id,
        name: check.name,
        subsystem: check.subsystem,
        description: check.description,
        severity: check.severity,
        checkType: check.checkType,
        status: outcome.status,
        message: outcome.message,
        timestamp: now,
        durationMs,
        evidence: outcome.evidence,
        remediation: outcome.remediation,
      };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const isTimeout = String(err?.message || '').includes('timed out');

      return {
        id: check.id,
        name: check.name,
        subsystem: check.subsystem,
        description: check.description,
        severity: check.severity,
        checkType: check.checkType,
        status: isTimeout ? 'degraded' : 'unhealthy',
        message: `Check execution failed: ${err?.message || String(err)}`,
        timestamp: now,
        durationMs,
        evidence: {
          errorName: err?.name,
          errorMessage: err?.message,
          stackTrace: err?.stack ? String(err.stack).slice(0, 300) : undefined,
        },
        remediation: isTimeout
          ? 'Subsystem did not respond within the diagnostic timeout. Inspect responsiveness.'
          : 'Subsystem threw an unhandled error during check. Review subsystem state and stack trace.',
      };
    }
  }

  /**
   * Run all checks matching an optional filter.
   */
  async runAll(filter?: {
    subsystem?: SubsystemName;
    severity?: DiagnosticSeverity;
  }, options?: RunCheckOptions): Promise<DiagnosticCheckResult[]> {
    let selected = this.list();
    if (filter?.subsystem) {
      selected = selected.filter((c) => c.subsystem === filter.subsystem);
    }
    if (filter?.severity) {
      selected = selected.filter((c) => c.severity === filter.severity);
    }

    const results: DiagnosticCheckResult[] = [];
    for (const check of selected) {
      results.push(await this.runCheck(check.id, options));
    }
    return results;
  }
}
