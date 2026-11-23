/**
 * Security Event Intelligence (Phase E.1) — normalized event schema.
 *
 * Phase E unifies security-relevant metadata from the EXISTING subsystems
 * (Phase A monitor, Phase B detection, Phase C execution gate, Phase D
 * containment, SPF, LPV, E5 stop) into one bounded, provenance-preserving
 * event stream. Phase E collects NOTHING new: every event is metadata an
 * existing subsystem already produced (its own audit record or lifecycle
 * event), re-emitted in a consistent schema.
 *
 * INVARIANTS:
 *  - Events are OBSERVED FACTS only. Inference happens exclusively in the
 *    correlation (E.2) and assessment (E.3) layers, which reference events
 *    by id.
 *  - Original timestamps and source identifiers are preserved. A missing
 *    source timestamp is recorded honestly (`observedTimestamp: false`,
 *    `observedAt: 0`) — never silently substituted (ingestedAt is separate).
 *  - Missing telemetry is never interpreted as safety: absence of events is
 *    visible via counters and situation states, never as a negative result.
 *  - Storage is bounded (ring buffer + dedup window); overflow drops the
 *    OLDEST events and counts them.
 *  - Metadata-only: no credentials, secrets, screen content, or command
 *    lines survive sanitization (defensive denylist even though upstream
 *    sources are already metadata-only).
 */

export type SecurityEventCategory =
  | 'process'
  | 'detection'
  | 'exec_gate'
  | 'containment'
  | 'spf'
  | 'lpv'
  | 'stop'
  | 'enforcement'
  | 'monitor_health'
  | 'defender'
  | 'unknown';

/** How the event reached the intelligence layer (provenance trail). */
export type SecurityEventVia =
  | 'audit-funnel'
  | 'monitor-events'
  | 'lpv-sink'
  | 'stop-sampler'
  | 'defender-check';

/** Subject references are metadata only; paths are allowed (existing audit
 *  records already carry them); command lines and contents never are. */
export interface SecurityEventSubject {
  pid?: number;
  name?: string;
  executablePath?: string;
  route?: string;
  decision?: string;
  classification?: string;
}

export interface SecurityEventProvenance {
  via: SecurityEventVia;
  /** The subsystem that produced the original record. */
  source: string;
  /** The original record kind, preserved verbatim. */
  originalKind: string;
  /** E5 audit seq when the record came through the audit funnel (0 otherwise). */
  auditSeq: number;
}

export interface SecurityEvent {
  /** Intel-assigned identifier (`sev_...`) — the reference used by correlation and assessments. */
  id: string;
  category: SecurityEventCategory;
  /** Original event timestamp from the source; 0 when the source had none. */
  observedAt: number;
  /** Intel ingestion time (never substitutes for observedAt). */
  ingestedAt: number;
  /** false = the source did not provide a timestamp (honest gap marker). */
  observedTimestamp: boolean;
  /** Last time a duplicate of this event collapsed onto this record. */
  lastSeenAt: number;
  /** How many identical events collapsed onto this record (deduplication). */
  seenCount: number;
  subject: SecurityEventSubject;
  /** Sanitized metadata facts (strings capped, objects dropped, secrets denied). */
  facts: Record<string, string | number | boolean | null>;
  provenance: SecurityEventProvenance;
}

/** Loose input shape accepted by the intel layer (audit records, monitor
 *  events, LPV sink records, sampler observations). */
export interface RawSecurityEventInput {
  kind?: unknown;
  at?: unknown;
  source?: unknown;
  categoryHint?: SecurityEventCategory;
  via?: SecurityEventVia;
  auditSeq?: unknown;
  subject?: Partial<SecurityEventSubject>;
  [key: string]: unknown;
}

export interface IngestStats {
  received: number;
  accepted: number;
  duplicatesCollapsed: number;
  malformedRejected: number;
  unknownCategory: number;
  droppedOverflow: number;
  lastIngestAt: number | null;
}

export interface IntelOptions {
  /** Ring capacity (oldest events are dropped and counted beyond this). */
  capacity?: number;
  /** Events with the same dedup key inside this window collapse into one record. */
  dedupWindowMs?: number;
  /** Clock injection (tests). */
  now?: () => number;
  /** Metadata-only audit sink for intel lifecycle records (optional). */
  audit?: (event: { kind: string; [key: string]: unknown }) => void;
}

/** Keys that must NEVER survive into facts (defense in depth — upstream
 *  sources are metadata-only already, but the intel layer enforces it too). */
export const FACT_KEY_DENYLIST = new Set([
  'password', 'passwd', 'secret', 'token', 'apikey', 'api_key', 'key',
  'authorization', 'credential', 'code', 'cmdline', 'commandline',
  'command_line', 'arguments', 'content', 'text', 'body', 'payload',
  'dataurl', 'base64', 'screen', 'screenshot', 'document', 'value',
]);

export const FACT_STRING_MAX = 200;
export const FACT_VALUE_MAX = 24;
