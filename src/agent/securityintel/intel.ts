/**
 * Security Event Intelligence (Phase E.1) — ingestion, normalization, dedup.
 *
 * Consumes ONLY existing metadata: subsystem audit records (via wrapped
 * callbacks in server.ts), Phase A monitor lifecycle events (via onEvent),
 * the LPV security sink, and the stop-state sampler. Performs no inference
 * and no I/O of its own. Bounded memory: fixed-capacity ring + dedup window.
 *
 * Out-of-order events are accepted as-is: `observedAt` (the source
 * timestamp) is what correlation uses; arrival order affects only ring
 * retention. Events whose source timestamp is missing carry
 * `observedTimestamp: false` and `observedAt: 0` — time-window correlation
 * skips them (they can still participate in subject-adjacency rules), and
 * assessments list them under missing information.
 */
import { randomBytes } from 'node:crypto';
import type {
  IngestStats,
  IntelOptions,
  RawSecurityEventInput,
  SecurityEvent,
  SecurityEventCategory,
  SecurityEventVia,
} from './eventTypes';
import { FACT_KEY_DENYLIST, FACT_STRING_MAX, FACT_VALUE_MAX } from './eventTypes';
import type { ProcessEvent } from '../processmonitor/monitorTypes';

const DEFAULT_CAPACITY = 2000;
const DEFAULT_DEDUP_WINDOW_MS = 2_000;

const AUDIT_KIND_CATEGORIES: Record<string, SecurityEventCategory> = {
  malware_classification: 'detection',
  exec_gate_allow: 'exec_gate',
  exec_gate_block: 'exec_gate',
  exec_gate_require_approval: 'exec_gate',
  exec_gate_deny: 'exec_gate',
  threat_containment: 'containment',
  spf_decision: 'spf',
  e5_stop_activated: 'stop',
  e5_stop_armed: 'stop',
  e5_stop_credentialed: 'stop',
  emergency_resume: 'stop',
  e5_stop_blocked: 'enforcement',
  blocked: 'enforcement',
  e5_first_install: 'monitor_health',
  e5_audit_chain_restarted: 'monitor_health',
  process_monitor_started: 'monitor_health',
  process_monitor_degraded: 'monitor_health',
  process_monitor_failed: 'monitor_health',
  process_monitor_rearmed: 'monitor_health',
  process_monitor_stopped: 'monitor_health',
  process_monitor_queue_overflow: 'monitor_health',
};

const SOURCE_DEFAULTS: Record<SecurityEventCategory, string> = {
  process: 'phase-a-monitor',
  detection: 'phase-b-engine',
  exec_gate: 'phase-c-exec-gate',
  containment: 'phase-d-containment',
  spf: 'spf',
  lpv: 'lpv',
  stop: 'e5-stop',
  enforcement: 'e5-enforcement',
  monitor_health: 'e5-audit',
  defender: 'windows-defender',
  unknown: 'unknown',
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Defensive sanitizer for one fact value. Objects/arrays are dropped (never
 *  serialized into metadata); strings are capped; unknown types become null. */
function sanitizeFactValue(v: unknown): string | number | boolean | null | undefined {
  if (v === null || v === undefined) return undefined;
  if (isFiniteNumber(v)) return v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.length === 0) return undefined;
    return s.length > FACT_STRING_MAX ? s.slice(0, FACT_STRING_MAX) : s;
  }
  return undefined; // objects, arrays, functions, bigint — never carried
}

function sanitizeFacts(input: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  const keys = Object.keys(input).sort().slice(0, FACT_VALUE_MAX);
  for (const rawKey of keys) {
    const key = rawKey.toLowerCase();
    if (FACT_KEY_DENYLIST.has(key)) continue;
    const value = sanitizeFactValue(input[rawKey]);
    if (value !== undefined) out[rawKey] = value;
  }
  return out;
}

/** Stable dedup identity: category + kind + subject identity + the facts that
 *  make the event distinct (decision/outcome/classification), NOT volatile
 *  fields (timestamps, request ids, counters). */
function dedupKeyOf(category: SecurityEventCategory, kind: string, subject: SecurityEvent['subject'], facts: Record<string, string | number | boolean | null>): string {
  const volatile = new Set(['at', 'requestid', 'seq', 'generation', 'count', 'dropped', 'expiresat', 'assessedat', 'evidenceagems', 'auditid', 'spfauditid']);
  const stableFacts = Object.keys(facts).filter((k) => !volatile.has(k.toLowerCase())).sort().map((k) => `${k}=${facts[k]}`).join(';');
  return [
    category,
    kind,
    subject.pid ?? '-',
    subject.name ?? '-',
    subject.executablePath ?? subject.route ?? '-',
    stableFacts,
  ].join('|');
}

export class SecurityEventIntel {
  private readonly capacity: number;
  private readonly dedupWindowMs: number;
  private readonly now: () => number;
  private readonly ring: SecurityEvent[] = [];
  private readonly statsInternal: IngestStats = {
    received: 0,
    accepted: 0,
    duplicatesCollapsed: 0,
    malformedRejected: 0,
    unknownCategory: 0,
    droppedOverflow: 0,
    lastIngestAt: null,
  };

  constructor(options: IntelOptions = {}) {
    this.capacity = Math.max(100, options.capacity ?? DEFAULT_CAPACITY);
    this.dedupWindowMs = Math.max(0, options.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS);
    this.now = options.now ?? Date.now;
  }

  // ------------------------------------------------------------- ingestion

  /** Ingest a loose audit/decision record (already metadata-only upstream;
   *  sanitized again defensively here). Returns the stored event id, or null
   *  when the record was malformed. */
  ingestRecord(input: RawSecurityEventInput, via: SecurityEventVia = 'audit-funnel'): string | null {
    this.statsInternal.received++;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      this.statsInternal.malformedRejected++;
      return null;
    }
    const kind = typeof input.kind === 'string' && input.kind.trim().length > 0 && input.kind.length <= 120
      ? input.kind.trim()
      : null;
    if (kind === null) {
      this.statsInternal.malformedRejected++;
      return null;
    }

    const explicitCategory = typeof input.categoryHint === 'string' ? input.categoryHint as SecurityEventCategory : undefined;
    const category: SecurityEventCategory = explicitCategory ?? AUDIT_KIND_CATEGORIES[kind] ?? 'unknown';
    if (category === 'unknown') this.statsInternal.unknownCategory++;

    const source = typeof input.source === 'string' && input.source.trim().length > 0
      ? input.source.trim()
      : SOURCE_DEFAULTS[category];

    const tsOk = isFiniteNumber(input.at) && (input.at as number) > 0;
    const observedAt = tsOk ? Math.floor(input.at as number) : 0;

    const subject: SecurityEvent['subject'] = {};
    const provided = (input.subject && typeof input.subject === 'object') ? input.subject as RawSecurityEventInput['subject'] : {};
    if (isFiniteNumber(provided?.pid) && (provided?.pid as number) > 0) subject.pid = provided?.pid as number;
    for (const key of ['name', 'executablePath', 'route', 'decision', 'classification'] as const) {
      const v = provided?.[key];
      if (typeof v === 'string' && v.length > 0) subject[key] = v.slice(0, FACT_STRING_MAX);
    }
    // Common audit fields promoted into the subject (bounded metadata).
    if (!subject.pid && isFiniteNumber(input.pid) && (input.pid as number) > 0) subject.pid = input.pid as number;
    if (!subject.pid && isFiniteNumber(input.targetPid) && (input.targetPid as number) > 0) subject.pid = input.targetPid as number;
    if (!subject.name && typeof input.processName === 'string' && input.processName) subject.name = (input.processName as string).slice(0, FACT_STRING_MAX);
    if (!subject.name && typeof input.targetName === 'string' && input.targetName) subject.name = (input.targetName as string).slice(0, FACT_STRING_MAX);
    if (!subject.name && typeof input.name === 'string' && input.name && keySafeName(input.name)) subject.name = (input.name as string).slice(0, FACT_STRING_MAX);
    if (!subject.executablePath && typeof input.path === 'string' && input.path) subject.executablePath = (input.path as string).slice(0, FACT_STRING_MAX);
    if (!subject.decision && (typeof input.decision === 'string' || typeof input.outcome === 'string')) {
      subject.decision = String(input.decision ?? input.outcome).slice(0, 64);
    }
    if (!subject.classification && typeof input.classification === 'string' && input.classification) {
      subject.classification = input.classification.slice(0, 32);
    }
    if (!subject.route && typeof input.route === 'string' && input.route) subject.route = input.route.slice(0, FACT_STRING_MAX);

    const facts = sanitizeFacts(input);

    const now = this.now();
    const key = dedupKeyOf(category, kind, subject, facts);

    // Deduplication: identical recent events collapse onto the existing
    // record (original observedAt preserved; seenCount incremented).
    if (this.dedupWindowMs > 0) {
      for (let i = this.ring.length - 1; i >= Math.max(0, this.ring.length - 64); i--) {
        const existing = this.ring[i];
        if (existing.provenance.originalKind === kind
          && existing.category === category
          && dedupKeyOf(existing.category, existing.provenance.originalKind, existing.subject, existing.facts) === key
          && now - existing.lastSeenAt <= this.dedupWindowMs) {
          existing.seenCount++;
          existing.lastSeenAt = now;
          this.statsInternal.duplicatesCollapsed++;
          return existing.id;
        }
      }
    }

    const event: SecurityEvent = {
      id: `sev_${now.toString(36)}_${randomBytes(6).toString('hex')}`,
      category,
      observedAt,
      ingestedAt: now,
      observedTimestamp: tsOk,
      lastSeenAt: now,
      seenCount: 1,
      subject,
      facts,
      provenance: {
        via,
        source,
        originalKind: kind,
        auditSeq: isFiniteNumber(input.auditSeq) && (input.auditSeq as number) > 0 ? input.auditSeq as number : 0,
      },
    };

    this.ring.push(event);
    if (this.ring.length > this.capacity) {
      this.ring.shift();
      this.statsInternal.droppedOverflow++;
    }
    this.statsInternal.accepted++;
    this.statsInternal.lastIngestAt = now;
    return event.id;
  }

  /** Phase A monitor lifecycle events (create/delete) — direct subscription. */
  ingestProcessEvent(event: ProcessEvent): string | null {
    if (event === null || typeof event !== 'object') {
      this.statsInternal.malformedRejected++;
      return null;
    }
    if (event.kind === 'create') {
      return this.ingestRecord({
        kind: 'process_create',
        at: event.at,
        source: 'phase-a-monitor',
        categoryHint: 'process',
        subject: { pid: event.pid, name: event.name, executablePath: event.path },
        ppid: event.ppid ?? null,
        sessionId: event.sessionId ?? null,
        enriched: event.enriched,
      }, 'monitor-events');
    }
    if (event.kind === 'delete') {
      return this.ingestRecord({
        kind: 'process_delete',
        at: event.at,
        source: 'phase-a-monitor',
        categoryHint: 'process',
        subject: { pid: event.pid, name: event.name },
        previouslyObserved: event.previouslyObserved,
      }, 'monitor-events');
    }
    this.statsInternal.malformedRejected++;
    return null;
  }

  // ------------------------------------------------------------- accessors

  /** All retained events (oldest first). Callers MUST NOT mutate. */
  events(): readonly SecurityEvent[] {
    return this.ring;
  }

  recent(count: number): SecurityEvent[] {
    const n = Math.max(1, Math.min(this.ring.length, Math.floor(count)));
    return this.ring.slice(this.ring.length - n);
  }

  stats(): IngestStats {
    return { ...this.statsInternal };
  }

  size(): number {
    return this.ring.length;
  }
}

/** Names are metadata; a `name` field on an audit record may be a route or
 *  operation name rather than a process name — accept anything bounded. */
function keySafeName(v: string): boolean {
  return v.length > 0 && v.length <= FACT_STRING_MAX;
}
