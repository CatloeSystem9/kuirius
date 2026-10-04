/**
 * Safety audit log (Phase 18, spec §17/§18) — bounded, redacted, passive.
 * Entries are appended by events that already happened (decisions, grants,
 * revocations, emergency stop); nothing polls, nothing runs in the
 * background, the ring never exceeds maxEntries, and secrets never enter.
 */
import type { AuditEntry, AuditKind } from './safetyTypes';
import { redactText } from './safetyTypes';

const MAX_ENTRIES = 200;

export class SafetyAuditLog {
  private entries: AuditEntry[] = [];
  private seq = 0;

  constructor(private maxEntries: number = MAX_ENTRIES) {}

  append(entry: Omit<AuditEntry, 'id' | 'at'> & { at?: number }): AuditEntry {
    this.seq += 1;
    const full: AuditEntry = {
      id: `audit_${(entry.at ?? Date.now())}_${this.seq}`,
      at: entry.at ?? Date.now(),
      kind: entry.kind,
      tool: entry.tool ? redactText(entry.tool) : undefined,
      decision: entry.decision,
      klass: entry.klass,
      permission: entry.permission,
      reason: entry.reason ? redactText(entry.reason) : undefined,
      inputKeys: entry.inputKeys ? entry.inputKeys.slice(0, 12) : undefined,
      taskId: entry.taskId ? redactText(entry.taskId) : undefined,
    };
    this.entries.push(full);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    return full;
  }

  /** Most recent entries, newest last (bounded read). */
  recent(limit = 25): AuditEntry[] {
    return this.entries.slice(-Math.max(1, Math.min(limit, this.maxEntries)));
  }

  count(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}
