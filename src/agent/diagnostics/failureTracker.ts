/**
 * Self-Diagnostics v1: Failure Awareness Tracker.
 *
 * Tracks, deduplicates, and analyzes runtime failure events across subsystems.
 * Associates failures with tasks and affected capabilities, monitors recovery
 * outcomes, and formats structured diagnoses without modifying operational state.
 */

import type {
  FailureEvent,
  FailureRecord,
  IssueDiagnosis,
  SubsystemName,
} from './diagnosticTypes';
import { redactText } from '../safety/safetyTypes';

export const MAX_FAILURE_RECORDS = 50;

/** Maps tool names or subsystem components to known capability tags. */
export function inferAffectedCapabilities(subsystem: SubsystemName, source: string): string[] {
  const s = source.toLowerCase();
  if (subsystem === 'models' || s.includes('model') || s.includes('router')) {
    return ['model.routing', 'model.generation'];
  }
  if (subsystem === 'persistence' || s.includes('store') || s.includes('storage')) {
    return ['storage.persistence', 'task.state'];
  }
  if (subsystem === 'intelligence') {
    if (s.includes('context')) return ['context.retrieval', 'context.packaging'];
    if (s.includes('knowledge') || s.includes('graph')) return ['knowledge.graph', 'relationship.query'];
    if (s.includes('semantic')) return ['semantic.expansion', 'semantic.scoring'];
    if (s.includes('consolidation') || s.includes('memory')) return ['memory.store', 'memory.recall'];
    return ['intelligence.context', 'intelligence.memory'];
  }
  if (subsystem === 'execution') {
    if (s.includes('filesystem') || s.includes('fs')) return ['filesystem.read', 'filesystem.write'];
    if (s.includes('browser') || s.includes('web')) return ['browser.open_url', 'browser.interaction'];
    if (s.includes('mouse') || s.includes('keyboard') || s.includes('computer')) return ['computer.use', 'mouse.control', 'keyboard.control'];
    if (s.includes('permission')) return ['permission.enforcement'];
    if (s.includes('planning')) return ['planning.replan', 'planning.hierarchical'];
    if (s.includes('recovery')) return ['error.recovery'];
    return ['tool.execution'];
  }
  if (subsystem === 'core') {
    return ['task.lifecycle', 'agent.core'];
  }
  return ['system.consistency'];
}

/** Generates a stable deduplication fingerprint from error text. */
export function createFailureFingerprint(subsystem: SubsystemName, source: string, error: string): string {
  // Normalize dynamic parts like timestamps, paths, or session IDs
  const normalizedError = redactText(error)
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\b\d{10,13}\b/g, '<timestamp>')
    .replace(/([a-zA-Z]:)?[\\/][\w\s.-]+[\\/][\w\s.-]+/g, '<path>')
    .slice(0, 100)
    .trim();

  return `${subsystem}:${source}:${normalizedError}`;
}

export class FailureTracker {
  private records = new Map<string, FailureRecord>();
  private maxRecords: number;

  constructor(maxRecords: number = MAX_FAILURE_RECORDS) {
    this.maxRecords = Math.max(1, Math.min(Math.floor(maxRecords) || 1, MAX_FAILURE_RECORDS));
  }

  /**
   * Record a failure event. If an identical failure is already tracked,
   * updates occurrence count and timestamps rather than creating duplicate entries.
   */
  recordFailure(event: FailureEvent): FailureRecord {
    const now = event.timestamp ?? Date.now();
    const source = redactText(event.source);
    const error = redactText(event.error);
    const fingerprint = createFailureFingerprint(event.subsystem, source, error);
    const existing = this.records.get(fingerprint);

    if (existing) {
      existing.occurrences += 1;
      existing.lastSeen = now;
      existing.error = error;
      if (event.taskId) existing.taskId = redactText(event.taskId);
      if (event.stepId) existing.stepId = redactText(event.stepId);
      if (event.toolName) existing.toolName = redactText(event.toolName);
      if (event.recoveryOutcome) existing.lastRecoveryOutcome = event.recoveryOutcome;
      return existing;
    }

    const toolName = event.toolName ? redactText(event.toolName) : undefined;
    const affectedCapabilities = inferAffectedCapabilities(event.subsystem, toolName || source);

    const newRecord: FailureRecord = {
      fingerprint,
      subsystem: event.subsystem,
      source,
      error,
      occurrences: 1,
      firstSeen: now,
      lastSeen: now,
      taskId: event.taskId ? redactText(event.taskId) : undefined,
      stepId: event.stepId ? redactText(event.stepId) : undefined,
      toolName,
      affectedCapabilities,
      lastRecoveryOutcome: event.recoveryOutcome,
    };

    // Bound the map size: evict the oldest entry if exceeding limit
    if (this.records.size >= this.maxRecords) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, rec] of this.records.entries()) {
        if (rec.lastSeen < oldestTime) {
          oldestTime = rec.lastSeen;
          oldestKey = key;
        }
      }
      if (oldestKey) this.records.delete(oldestKey);
    }

    this.records.set(fingerprint, newRecord);
    return newRecord;
  }

  /**
   * Update recovery outcome for a recent failure associated with a task/step.
   */
  updateRecoveryOutcome(taskId: string, outcome: 'succeeded' | 'failed' | 'aborted', stepId?: string): boolean {
    let found = false;
    for (const record of this.records.values()) {
      if (record.taskId === taskId && (!stepId || record.stepId === stepId)) {
        record.lastRecoveryOutcome = outcome;
        found = true;
      }
    }
    return found;
  }

  list(limit: number = MAX_FAILURE_RECORDS): FailureRecord[] {
    const capped = Math.max(1, Math.min(Math.floor(limit) || 1, this.maxRecords));
    return Array.from(this.records.values()).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, capped);
  }

  count(): number {
    return this.records.size;
  }

  findBySubsystem(subsystem: SubsystemName): FailureRecord[] {
    return this.list().filter((r) => r.subsystem === subsystem);
  }

  clear(): void {
    this.records.clear();
  }

  /**
   * Formulate diagnosis and recommendations for active failures.
   * Never invents root causes — clearly marks hypotheses.
   */
  diagnoseIssues(): IssueDiagnosis[] {
    const issues: IssueDiagnosis[] = [];

    for (const rec of this.list()) {
      const errLower = rec.error.toLowerCase();
      let likelyCause = 'unknown';
      let isHypothesis = true;
      let recommendation = 'Review subsystem error logs for further context.';
      let userInterventionRequired = false;

      if (errLower.includes('permission') || errLower.includes('denied') || errLower.includes('unauthorized')) {
        likelyCause = 'Security or permission boundary blocked execution.';
        isHypothesis = false;
        recommendation = 'Grant the necessary permission using the permission manager or confirm authorization.';
        userInterventionRequired = true;
      } else if (errLower.includes('not found') || errLower.includes('enoent')) {
        likelyCause = 'Target resource, file, or entity does not exist on disk or in the registry.';
        isHypothesis = false;
        recommendation = 'Verify the target identifier or path before retrying.';
      } else if (errLower.includes('timeout') || errLower.includes('timed out')) {
        likelyCause = 'Operation exceeded configured execution deadline (possible heavy load or unresponsive process).';
        isHypothesis = true;
        recommendation = 'Retry with higher timeout or verify if target application is responsive.';
      } else if (errLower.includes('api key') || errLower.includes('gemini_api_key')) {
        likelyCause = 'API key is missing, expired, or invalid.';
        isHypothesis = false;
        recommendation = 'Configure a valid GEMINI_API_KEY in the environment or settings.';
        userInterventionRequired = true;
      } else if (errLower.includes('aborted') || errLower.includes('cancelled')) {
        likelyCause = 'Task was cancelled by user or emergency stop.';
        isHypothesis = false;
        recommendation = 'Task cancellation is expected when requested by the user.';
      } else if (rec.lastRecoveryOutcome === 'failed') {
        likelyCause = 'Automated Phase 11 recovery strategies were attempted but unable to resolve the failure.';
        isHypothesis = true;
        recommendation = 'Safe stop was triggered. Manual inspection of target state is advised.';
      }

      issues.push({
        id: `issue_${rec.fingerprint.slice(0, 32)}`,
        subsystem: rec.subsystem,
        severity: rec.occurrences > 3 ? 'critical' : rec.occurrences > 1 ? 'warning' : 'informational',
        issue: `Failure in ${rec.source}: ${rec.error.slice(0, 150)}${rec.occurrences > 1 ? ` (${rec.occurrences} occurrences)` : ''}`,
        evidence: `Source: ${rec.source}, Error: "${rec.error}", Last seen: ${new Date(rec.lastSeen).toISOString()}`,
        affectedCapabilities: rec.affectedCapabilities,
        likelyCause,
        isHypothesis,
        recommendation,
        userInterventionRequired,
      });
    }

    return issues;
  }
}
