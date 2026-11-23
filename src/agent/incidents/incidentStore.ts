/**
 * Incident Store (Phase F) — bounded registry, validated lifecycle, evidence
 * attachment, and restart persistence.
 *
 * Deterministic and single-threaded: all mutations are synchronous; the
 * orchestrator serializes event processing, so concurrent ingestion cannot
 * produce contradictory transitions (Node event loop + explicit transition
 * validation). Persistence is a single integrity-hashed JSON snapshot in the
 * protected E5 store (same pattern as stop-state.json), rewritten atomically
 * on every mutation — incidents are rare, so rewrite cost is negligible and
 * storage is bounded by construction.
 */
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import { durableWrite } from '../../../serverSafety';
import type {
  EvidenceItem,
  Incident,
  IncidentAuditEvent,
  IncidentState,
  IncidentTransition,
  IncidentResponse,
  IncidentStoreOptions,
} from './incidentTypes';
import { isValidTransition, shouldCreateIncident } from './incidentTypes';

const DEFAULTS = {
  maxActive: 24,
  maxArchived: 100,
  maxEvidencePerIncident: 40,
  maxAssessmentsPerIncident: 8,
  maxTransitionsPerIncident: 64,
  maxResponsesPerIncident: 24,
  staleEvidenceMs: 24 * 60 * 60 * 1000,
};

const SCHEMA = 1;
const ACTIVE_STATES: ReadonlySet<IncidentState> = new Set([
  'DETECTED', 'ASSESSING', 'CORRELATED', 'ACTION_PENDING', 'AWAITING_OPERATOR',
  'RESPONSE_IN_PROGRESS', 'INVESTIGATION_REQUIRED',
]);

interface PersistShape {
  schemaVersion: number;
  savedAt: number;
  incidents: Incident[];
  integrity: string;
}

export function newIncidentId(now: number): string {
  return `inc_${now.toString(36)}_${randomBytes(6).toString('hex')}`;
}

export class IncidentStore {
  private readonly opts: Required<Pick<IncidentStoreOptions, 'maxActive' | 'maxArchived' | 'maxEvidencePerIncident' | 'staleEvidenceMs'>> & {
    maxAssessmentsPerIncident: number;
    maxTransitionsPerIncident: number;
    maxResponsesPerIncident: number;
  };
  private readonly incidents = new Map<string, Incident>();
  private readonly now: () => number;
  private readonly audit: ((event: IncidentAuditEvent) => void) | undefined;
  private persistPath: string | null;
  private archivedTotal = 0;
  private loaded = false;

  constructor(options: IncidentStoreOptions = {}) {
    this.opts = {
      maxActive: options.maxActive ?? DEFAULTS.maxActive,
      maxArchived: options.maxArchived ?? DEFAULTS.maxArchived,
      maxEvidencePerIncident: options.maxEvidencePerIncident ?? DEFAULTS.maxEvidencePerIncident,
      staleEvidenceMs: options.staleEvidenceMs ?? DEFAULTS.staleEvidenceMs,
      maxAssessmentsPerIncident: DEFAULTS.maxAssessmentsPerIncident,
      maxTransitionsPerIncident: DEFAULTS.maxTransitionsPerIncident,
      maxResponsesPerIncident: DEFAULTS.maxResponsesPerIncident,
    };
    this.now = options.now ?? Date.now;
    this.audit = options.audit;
    this.persistPath = options.persistPath ?? null;
  }

  // ------------------------------------------------------------ persistence

  setPersistPath(p: string | null): void {
    this.persistPath = p;
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      // Keep the snapshot bounded: all active incidents + the most recent
      // archived ones.
      const kept = [...this.incidents.values()].filter(
        (i) => ACTIVE_STATES.has(i.state) || i.state === 'CONTAINED' || i.state === 'RESOLVED',
      );
      const closed = [...this.incidents.values()].filter((i) => i.state === 'CLOSED').slice(-40);
      const shape: PersistShape = {
        schemaVersion: SCHEMA,
        savedAt: this.now(),
        incidents: [...kept, ...closed],
        integrity: '',
      };
      shape.integrity = cryptoHash(JSON.stringify({ ...shape, integrity: '' }));
      durableWrite(this.persistPath, JSON.stringify(shape) + '\n');
    } catch {
      /* persistence failure must never break orchestration (the E5 audit
         chain still holds every operation) */
    }
  }

  /** Restore incidents from the persisted snapshot. Corrupt state is never
   *  silently trusted — it fails safe to an empty registry with an audit
   *  record (the E5 chain retains every prior operation). */
  loadPersisted(): number {
    if (this.loaded || !this.persistPath) return 0;
    this.loaded = true;
    try {
      if (!fs.existsSync(this.persistPath)) return 0;
      const raw = fs.readFileSync(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw) as PersistShape;
      if (parsed.schemaVersion !== SCHEMA) throw new Error('schema mismatch');
      const { integrity, ...fields } = parsed;
      if (cryptoHash(JSON.stringify({ ...fields, integrity: '' })) !== integrity) throw new Error('integrity mismatch');
      let restored = 0;
      for (const inc of parsed.incidents ?? []) {
        if (!inc || typeof inc.id !== 'string' || !inc.state) continue;
        this.incidents.set(inc.id, inc);
        restored++;
      }
      return restored;
    } catch (err) {
      // Fail safe: empty registry (never trust corrupt incident state).
      this.incidents.clear();
      this.audit?.({
        kind: 'incident_orchestration',
        incidentId: '-',
        op: 'restore_failed',
        detail: `incident snapshot corrupt — failing safe to empty registry: ${String((err as Error)?.message || err)}`,
        at: this.now(),
      });
      return 0;
    }
  }

  // ------------------------------------------------------------ creation

  /** Associate-or-create: returns the incident for the subject, creating one
   *  when no ACTIVE incident shares the same verified subject identity
   *  (normalized executablePath anchor — never the name alone). */
  associateOrCreate(subject: { executablePath: string | null; primaryPid: number | null; primaryCreationTime: string | null; displayName: string | null }): { incident: Incident; created: boolean } {
    if (subject.executablePath) {
      const key = subject.executablePath.toLowerCase();
      for (const inc of this.incidents.values()) {
        if (!ACTIVE_STATES.has(inc.state)) continue;
        if (inc.subject.executablePath && inc.subject.executablePath.toLowerCase() === key) {
          return { incident: inc, created: false };
        }
      }
    }
    const inc: Incident = {
      id: newIncidentId(this.now()),
      createdAt: this.now(),
      updatedAt: this.now(),
      state: 'DETECTED',
      severity: 'INFORMATIONAL',
      confidence: 'NONE',
      subject,
      evidence: [],
      assessments: [],
      transitions: [],
      responses: [],
      containmentOutcome: null,
      finalOutcome: null,
      containmentAuthorityEpoch: null,
      pendingOperatorDecision: null,
    };
    inc.transitions.push({ from: 'DETECTED', to: 'DETECTED', reason: 'incident created from correlated security evidence', at: this.now() });
    this.incidents.set(inc.id, inc);
    this.enforceBounds();
    this.audit?.({
      kind: 'incident_orchestration',
      incidentId: inc.id,
      op: 'incident_created',
      detail: `subject=${subject.executablePath ?? subject.displayName ?? 'unknown'} pid=${subject.primaryPid ?? '-'}`,
      state: inc.state,
      at: inc.createdAt,
    });
    this.persist();
    return { incident: inc, created: true };
  }

  // ------------------------------------------------------------ evidence

  attachEvidence(incidentId: string, item: Omit<EvidenceItem, 'id' | 'attachedAt' | 'stale'>): EvidenceItem | null {
    const inc = this.incidents.get(incidentId);
    if (!inc) return null;
    const full: EvidenceItem = {
      ...item,
      id: `ev_${this.now().toString(36)}_${randomBytes(5).toString('hex')}`,
      attachedAt: this.now(),
      stale: item.evidenceAgeMs > this.opts.staleEvidenceMs,
    };
    inc.evidence.push(full);
    if (inc.evidence.length > this.opts.maxEvidencePerIncident) {
      // Drop the OLDEST non-confirmed evidence first (bounded storage); the
      // E5 audit chain retains everything.
      const dropIdx = inc.evidence.findIndex((e) => e.verification !== 'confirmed-by-source');
      inc.evidence.splice(dropIdx >= 0 ? dropIdx : 0, 1);
    }
    inc.updatedAt = this.now();
    this.audit?.({
      kind: 'incident_orchestration',
      incidentId,
      op: 'evidence_attached',
      detail: `category=${full.category} source=${full.source} verification=${full.verification} stale=${full.stale}`,
      state: inc.state,
      at: full.attachedAt,
    });
    this.persist();
    return full;
  }

  recordAssessment(incidentId: string, summary: { id: string; kind: string; severity: string; confidenceLabel: string; reason: string; at: number }): void {
    const inc = this.incidents.get(incidentId);
    if (!inc) return;
    inc.assessments.push(summary);
    if (inc.assessments.length > this.opts.maxAssessmentsPerIncident) inc.assessments.shift();
    // Severity/confidence only move UP (a new assessment never silently
    // erases previous evidence; contradictions are recorded separately).
    const order: Record<string, number> = { INFORMATIONAL: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
    if ((order[summary.severity] ?? 0) > (order[inc.severity] ?? 0)) inc.severity = summary.severity as Incident['severity'];
    if (summary.confidenceLabel !== 'NONE' && inc.confidence === 'NONE') inc.confidence = summary.confidenceLabel;
    inc.updatedAt = this.now();
    this.audit?.({
      kind: 'incident_orchestration',
      incidentId,
      op: 'assessment_recorded',
      detail: `${summary.kind} severity=${summary.severity} confidence=${summary.confidenceLabel}`,
      state: inc.state,
      at: summary.at,
    });
    this.persist();
  }

  // ------------------------------------------------------------ transitions

  /** Validated transition. Returns null on success; a rejection reason when
   *  the transition is invalid (rejected transitions are audited, never
   *  applied — contradictory event processing cannot corrupt state). */
  transition(incidentId: string, to: IncidentState, reason: string): { ok: true } | { ok: false; reason: string } | null {
    const inc = this.incidents.get(incidentId);
    if (!inc) return null;
    if (inc.state === to) return { ok: true }; // idempotent re-assertion
    if (!isValidTransition(inc.state, to)) {
      const msg = `invalid transition ${inc.state} -> ${to} rejected`;
      this.audit?.({
        kind: 'incident_orchestration',
        incidentId,
        op: 'transition_rejected',
        detail: msg,
        state: inc.state,
        at: this.now(),
      });
      return { ok: false, reason: msg };
    }
    const t: IncidentTransition = { from: inc.state, to, reason: String(reason ?? '').slice(0, 300), at: this.now() };
    inc.state = to;
    inc.transitions.push(t);
    if (inc.transitions.length > this.opts.maxTransitionsPerIncident) inc.transitions.shift();
    inc.updatedAt = t.at;
    if (to === 'RESOLVED' || to === 'CLOSED') {
      if (!inc.finalOutcome) inc.finalOutcome = `${to}: ${t.reason}`;
      if (to === 'CLOSED') this.archivedTotal++;
    }
    this.audit?.({
      kind: 'incident_orchestration',
      incidentId,
      op: 'transition',
      detail: `${t.from} -> ${t.to}: ${t.reason}`,
      state: to,
      at: t.at,
    });
    this.persist();
    return { ok: true };
  }

  // ------------------------------------------------------------ responses

  recordResponse(incidentId: string, response: IncidentResponse): void {
    const inc = this.incidents.get(incidentId);
    if (!inc) return;
    inc.responses.push(response);
    if (inc.responses.length > this.opts.maxResponsesPerIncident) inc.responses.shift();
    inc.updatedAt = this.now();
    this.persist();
  }

  /** Replace the non-attempted eligibility snapshot with the current one
   *  (attempted responses are preserved first — history is never erased). */
  replaceEligibility(incidentId: string, responses: IncidentResponse[]): void {
    const inc = this.incidents.get(incidentId);
    if (!inc) return;
    const attempted = inc.responses.filter((r) => r.attempted);
    inc.responses = [...attempted, ...responses].slice(-this.opts.maxResponsesPerIncident);
    inc.updatedAt = this.now();
    this.persist();
  }

  setContainmentOutcome(incidentId: string, outcome: string, finalReason?: string): void {
    const inc = this.incidents.get(incidentId);
    if (!inc) return;
    inc.containmentOutcome = outcome;
    inc.updatedAt = this.now();
    if (finalReason) {
      const t: IncidentTransition = { from: inc.state, to: inc.state, reason: `containment outcome: ${outcome}`, at: this.now() };
      inc.transitions.push(t);
    }
    this.audit?.({
      kind: 'incident_orchestration',
      incidentId,
      op: 'containment_outcome',
      detail: outcome,
      state: inc.state,
      at: this.now(),
    });
    this.persist();
  }

  setPendingOperatorDecision(incidentId: string, decision: string | null): void {
    const inc = this.incidents.get(incidentId);
    if (!inc) return;
    inc.pendingOperatorDecision = decision;
    inc.updatedAt = this.now();
    this.persist();
  }

  setContainmentAuthorityEpoch(incidentId: string, epoch: number | null): void {
    const inc = this.incidents.get(incidentId);
    if (!inc) return;
    inc.containmentAuthorityEpoch = epoch;
    inc.updatedAt = this.now();
    this.persist();
  }

  // ------------------------------------------------------------ accessors

  get(id: string): Incident | undefined {
    return this.incidents.get(id);
  }

  all(): Incident[] {
    return [...this.incidents.values()];
  }

  active(): Incident[] {
    return this.incidents.size > 0
      ? this.all().filter((i) => ACTIVE_STATES.has(i.state) || i.state === 'CONTAINED')
      : [];
  }

  activeCount(): number {
    return this.active().length;
  }

  archivedCount(): number {
    return this.archivedTotal;
  }

  /** Find the newest ACTIVE incident for a subject path (association anchor). */
  findActiveByPath(executablePath: string): Incident | null {
    const key = executablePath.toLowerCase();
    let newest: Incident | null = null;
    for (const inc of this.incidents.values()) {
      if (!ACTIVE_STATES.has(inc.state)) continue;
      if (inc.subject.executablePath && inc.subject.executablePath.toLowerCase() === key) {
        if (!newest || inc.createdAt > newest.createdAt) newest = inc;
      }
    }
    return newest;
  }

  private enforceBounds(): void {
    const active = this.active();
    if (active.length <= this.opts.maxActive) return;
    // Evict the OLDEST active incident (marked RESOLVED with a reason; the
    // E5 audit retains its full history).
    const oldest = active.sort((a, b) => a.createdAt - b.createdAt)[0];
    this.transition(oldest.id, 'RESOLVED', 'evicted: active-incident bound reached (oldest incident resolved; full history in the E5 audit)');
  }
}

function cryptoHash(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export { shouldCreateIncident };
