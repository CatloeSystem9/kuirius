/**
 * SPF privacy audit log.
 *
 * Every transmission decision is recorded with: detection category,
 * observation identifier, transmission destination, decision, reason,
 * detection confidence and timestamp (task §7).
 *
 * SECURITY: records NEVER contain actual passwords, OTPs, card numbers, API
 * keys or raw sensitive screenshots. Correlation uses a non-reversible
 * 8-hex content-hash prefix of the flagged span only. The log is a bounded
 * ring buffer with listeners — the integration point for Krisha's future
 * Action Transparency interface. Server-side wiring additionally appends
 * decisions to the existing tamper-evident E5 audit chain (reuse, no
 * duplicate security system).
 */
import type { SpfVerdict } from './spfTypes';
import { spfContentHashPrefix } from './spfTypes';

export interface SpfAuditEvent {
  id: string;
  timestamp: number;
  /** Highest-severity detection category, or 'none' for clean traffic. */
  category: string;
  /** Observation/step identifier when known. */
  observationId?: string;
  /** Transmission destination, e.g. 'gemini:chat'. */
  destination: string;
  decision: 'ALLOW' | 'REDACT' | 'BLOCK';
  /** Content-free machine reason. */
  reason: string;
  /** Detection confidence 0..1 (1 for clean/allow). */
  confidence: number;
  /** Non-reversible hash prefix of the flagged span (correlation only). */
  contentHashPrefix?: string;
  /** Payload transport that produced the decision. */
  transport?: string;
  /** Findings summary: detector ids and severities — never content. */
  findingSummaries: Array<{ category: string; severity: string; confidence: number; detectorId: string }>;
}

export type SpfAuditListener = (event: SpfAuditEvent) => void;

export class SpfAuditLog {
  private entries: SpfAuditEvent[] = [];
  private listeners = new Set<SpfAuditListener>();
  private counter = 0;
  private lastEvent: SpfAuditEvent | null = null;

  constructor(private readonly limit = 300) {}

  /**
   * Build an audit event from a verdict. Extracts only category/summary data;
   * findings carry spans (positions) — those are dropped here so no event can
   * be replayed into content.
   */
  eventFromVerdict(verdict: SpfVerdict, destination: string, observationId?: string, transport?: string): SpfAuditEvent {
    this.counter = (this.counter + 1) % 1_000_000;
    const topFinding = verdict.findings
      .filter((f) => f.severity !== 'uncertain')
      .sort((a, b) => b.confidence - a.confidence)[0];
    const event: SpfAuditEvent = {
      id: `spf_${Date.now().toString(36)}_${this.counter.toString(36)}`,
      timestamp: Date.now(),
      category: verdict.categories[0] ?? 'none',
      observationId,
      destination,
      decision: verdict.decision.toUpperCase() as 'ALLOW' | 'REDACT' | 'BLOCK',
      reason: verdict.reason,
      confidence: verdict.decision === 'allow' && verdict.categories.length === 0 ? 1 : verdict.confidence,
      contentHashPrefix: topFinding ? spfContentHashPrefix(`${topFinding.category}:${topFinding.start}:${topFinding.end}`) : undefined,
      transport,
      findingSummaries: verdict.findings.map((f) => ({
        category: f.category,
        severity: f.severity,
        confidence: f.confidence,
        detectorId: f.detectorId,
      })),
    };
    return event;
  }

  record(event: SpfAuditEvent): void {
    this.entries.push(event);
    if (this.entries.length > this.limit) this.entries.shift();
    this.lastEvent = event;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* listeners must never break the gate */
      }
    }
  }

  /** Record-and-return-id helper used by the firewall. */
  recordVerdict(verdict: SpfVerdict, destination: string, observationId?: string, transport?: string): string {
    const event = this.eventFromVerdict(verdict, destination, observationId, transport);
    this.record(event);
    return event.id;
  }

  subscribe(listener: SpfAuditListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRecent(count = 50): SpfAuditEvent[] {
    return this.entries.slice(-count);
  }

  last(): SpfAuditEvent | null {
    return this.lastEvent;
  }

  stats(): { total: number; allowed: number; redacted: number; blocked: number } {
    let allowed = 0;
    let redacted = 0;
    let blocked = 0;
    for (const e of this.entries) {
      if (e.decision === 'ALLOW') allowed++;
      else if (e.decision === 'REDACT') redacted++;
      else blocked++;
    }
    return { total: this.entries.length, allowed, redacted, blocked };
  }

  clear(): void {
    this.entries = [];
    this.lastEvent = null;
  }
}
