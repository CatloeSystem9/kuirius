/**
 * Incident Orchestrator (Phase F) — coordination core.
 *
 * Connects the existing subsystems into traceable incidents:
 *   Phase E intelligence (assessments + evidence) → incident lifecycle →
 *   response eligibility (E-stop / credential / identity aware) →
 *   containment EXECUTED ONLY THROUGH PHASE D.
 *
 * HARD RULES (enforced structurally, not by convention):
 *  - Phase F never classifies: incident severity comes from Phase E
 *    assessments verbatim; CRITICAL requires a confirmed-by-source
 *    assessment (a Phase B CONFIRMED_MALWARE fact).
 *  - Containment calls Phase D's issueApproval/contain unmodified — the
 *    operator credential verification, the authority epoch, the process
 *    pinning, and the E-stop checks inside Phase D are the authority; this
 *    layer adds coordination, not authority.
 *  - Every eligibility decision is re-evaluated against LIVE subsystem
 *    state (E-stop, credential enrollment + epoch, evidence) immediately
 *    before execution; unavailable subsystems fail closed.
 *  - Processing is event-driven with a short coalescing debounce (no
 *    polling loops); incident storage is bounded.
 */
import { randomBytes } from 'node:crypto';
import type { SecurityEventIntel } from '../securityintel/intel';
import type { SecurityEvent } from '../securityintel/eventTypes';
import type { CorrelationEngine, CorrelationResult } from '../securityintel/correlation';
import type { AssessmentEngine, ThreatAssessment } from '../securityintel/assessment';
import type { ThreatContainment } from '../containment/containment';
import type { Incident, IncidentResponse, ResponseActionKind, ResponseEligibility, EvidenceCategory, EvidenceItem } from './incidentTypes';
import { shouldCreateIncident } from './incidentTypes';
import { IncidentStore } from './incidentStore';

export interface OrchestratorDeps {
  intel: SecurityEventIntel;
  correlations: CorrelationEngine;
  assessments: AssessmentEngine;
  /** Phase D containment — used AS-IS (credential verification, epoch,
   *  pinning and E-stop checks inside Phase D are the authority). */
  containment: ThreatContainment;
  /** E5 approval-credential state (Phase D completion). */
  credentialSet(): boolean;
  credentialEpoch(): number;
  /** E5 authoritative stop state ('INACTIVE' | 'ACTIVE_...' | 'ACTIVE_UNCERTAIN'). */
  stopKind(): string;
  store: IncidentStore;
  /** Metadata-only audit sink (wired to the E5 funnel by server.ts). */
  audit(event: { kind: string; [key: string]: unknown }): void;
  now?: () => number;
  /** Coalescing debounce for event-driven processing (default 250 ms). */
  debounceMs?: number;
}

const MAX_CORRELATION_EVIDENCE = 6;
const MAX_EVIDENCE_PER_PASS = 12;

export class IncidentOrchestrator {
  private readonly now: () => number;
  private readonly debounceMs: number;
  private processing: NodeJS.Timeout | null = null;
  private lastProcessedAt = 0;
  private lastStopKind: string;

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? Date.now;
    this.debounceMs = Math.max(50, deps.debounceMs ?? 250);
    this.lastStopKind = deps.stopKind();
    this.deps.store.loadPersisted();
  }

  // ------------------------------------------------------- event-driven entry

  /** Coalesced processing trigger (called by the server's ingestion tap).
   *  Event-driven: nothing runs without new events or explicit reads. */
  scheduleProcessing(): void {
    if (this.processing) return;
    this.processing = setTimeout(() => {
      this.processing = null;
      try {
        this.processIntelligence();
      } catch {
        /* a processing failure must never break the ingesting subsystem */
      }
    }, this.debounceMs);
    this.processing.unref?.();
  }

  /** Immediate sweep when an E-stop transition arrives (rare, critical). */
  sweepStopTransition(): void {
    const kind = this.deps.stopKind();
    if (kind === this.lastStopKind) return;
    this.lastStopKind = kind;
    if (kind === 'INACTIVE') return;
    // An active/uncertain stop prohibits containment-class responses across
    // ALL active incidents, immediately.
    for (const incident of this.deps.store.active()) {
      const elig = this.evaluateContainmentEligibility(incident);
      if (elig === 'BLOCKED_BY_ESTOP') {
        this.deps.audit({
          kind: 'incident_response_blocked',
          incidentId: incident.id,
          action: 'CONTAIN',
          eligibility: 'BLOCKED_BY_ESTOP',
          stopKind: kind,
          at: this.now(),
        });
        incident.pendingOperatorDecision =
          kind === 'ACTIVE_UNCERTAIN'
            ? 'containment blocked: emergency-stop state UNAVAILABLE — fail-closed'
            : 'containment blocked: emergency stop is active — operator recovery required first';
      }
    }
    this.deps.audit({
      kind: 'incident_stop_sweep',
      stopKind: kind,
      activeIncidents: this.deps.store.activeCount(),
      at: this.now(),
    });
  }

  // ------------------------------------------------------------ processing

  /** One orchestration pass: correlate + assess + associate-or-create +
   *  attach evidence + record assessments + update eligibility. Deterministic
   *  for a fixed event set; bounded per pass. */
  processIntelligence(): { created: number; updated: number; assessments: number } {
    this.lastProcessedAt = this.now();
    const intel = this.deps.intel;
    const correlations: CorrelationResult[] = this.deps.correlations.correlate(intel);
    const assessments: ThreatAssessment[] = this.deps.assessments.assess(intel);
    const correlationByRef = new Map<string, CorrelationResult>();
    for (const c of correlations) for (const ref of c.evidenceEventIds) correlationByRef.set(ref, c);

    let created = 0;
    let updated = 0;
    let evidenceAttached = 0;

    for (const assessment of assessments) {
      // Policy: only confirmed-by-source or MEDIUM+ assessments become
      // incidents; a verified executable identity is REQUIRED (never the
      // name alone).
      if (!shouldCreateIncident(assessment)) continue;
      const path = assessment.subject.executablePath;
      if (!path) continue;

      const evidenceEvents = this.evidenceEvents(intel, assessment);
      const primary = evidenceEvents.find((e) => e.subject.pid !== undefined) ?? evidenceEvents[0];
      const { incident, created: isNew } = this.deps.store.associateOrCreate({
        executablePath: path,
        primaryPid: primary?.subject.pid ?? null,
        primaryCreationTime: null, // creation time is verified at pin time (Phase D)
        displayName: assessment.subject.name ?? null,
      });
      if (isNew) created++;
      else updated++;

      // Transitions: DETECTED -> ASSESSING on first assessment.
      if (incident.state === 'DETECTED') {
        this.deps.store.transition(incident.id, 'ASSESSING', 'first Phase E assessment attached');
      }
      // ASSESSING -> CORRELATED when Phase E correlations back the incident.
      const correlated = evidenceEvents.some((e) => correlationByRef.has(e.id));
      if ((incident.state === 'ASSESSING' || incident.state === 'DETECTED') && correlated) {
        this.deps.store.transition(incident.id, 'CORRELATED', 'Phase E correlation evidence attached');
      }
      // Correlated -> ACTION_PENDING when the classification is source-confirmed.
      if ((incident.state === 'CORRELATED' || incident.state === 'ASSESSING' || incident.state === 'DETECTED')
        && assessment.kind === 'confirmed-by-source') {
        this.deps.store.transition(incident.id, 'ACTION_PENDING', 'source CONFIRMED_MALWARE evidence present — response actions become decidable');
      }

      // Evidence attachment (bounded; every item preserves provenance).
      for (const ev of evidenceEvents.slice(0, MAX_EVIDENCE_PER_PASS)) {
        if (incident.evidence.some((e) => e.sourceEventId === ev.id)) continue; // dedup by event id
        const corr = correlationByRef.get(ev.id);
        const item: Omit<EvidenceItem, 'id' | 'attachedAt' | 'stale'> = {
          category: this.categoryOf(ev),
          sourceEventId: ev.id,
          source: ev.provenance.source,
          originalKind: ev.provenance.originalKind,
          observedAt: ev.observedAt,
          subject: {
            pid: ev.subject.pid,
            name: ev.subject.name,
            executablePath: ev.subject.executablePath,
          },
          classification: ev.subject.classification ?? null,
          classificationSource: ev.subject.classification ? ev.provenance.source : null,
          confidence: null,
          severity: assessment.severity,
          evidenceAgeMs: ev.observedAt > 0 ? Math.max(0, this.now() - ev.observedAt) : -1,
          correlationRefs: corr ? [corr.ruleId] : [],
          verification: ev.subject.classification?.toUpperCase() === 'CONFIRMED_MALWARE' && ev.category === 'detection'
            ? 'confirmed-by-source'
            : 'observed',
        };
        this.deps.store.attachEvidence(incident.id, item);
        evidenceAttached++;
      }

      // Contradictions become explicitly-marked evidence (never erased).
      for (const ref of assessment.contradictingRefs.slice(0, 3)) {
        const ev = intel.events().find((e) => e.id === ref);
        if (!ev || incident.evidence.some((e) => e.sourceEventId === ev.id)) continue;
        const item: Omit<EvidenceItem, 'id' | 'attachedAt' | 'stale'> = {
          category: this.categoryOf(ev),
          sourceEventId: ev.id,
          source: ev.provenance.source,
          originalKind: ev.provenance.originalKind,
          observedAt: ev.observedAt,
          subject: { pid: ev.subject.pid, name: ev.subject.name, executablePath: ev.subject.executablePath },
          classification: ev.subject.classification ?? null,
          classificationSource: ev.subject.classification ? ev.provenance.source : null,
          confidence: null,
          severity: null,
          evidenceAgeMs: ev.observedAt > 0 ? Math.max(0, this.now() - ev.observedAt) : -1,
          correlationRefs: [],
          verification: 'contradicted',
        };
        this.deps.store.attachEvidence(incident.id, item);
      }

      this.deps.store.recordAssessment(incident.id, {
        id: assessment.id,
        kind: assessment.kind,
        severity: assessment.severity,
        confidenceLabel: assessment.confidenceLabel,
        reason: assessment.reason,
        at: this.now(),
      });

      // Credential-revocation sweep: pending containment authorization on
      // this incident is invalidated when the authority epoch moved.
      if (incident.containmentAuthorityEpoch !== null
        && incident.containmentAuthorityEpoch !== this.deps.credentialEpoch()) {
        this.deps.store.setPendingOperatorDecision(
          incident.id,
          'containment authorization INVALIDATED — the approval credential was cleared or re-enrolled since the incident recorded it',
        );
        this.deps.audit({
          kind: 'incident_authority_invalidated',
          incidentId: incident.id,
          recordedEpoch: incident.containmentAuthorityEpoch,
          currentEpoch: this.deps.credentialEpoch(),
          at: this.now(),
        });
      }

      // Eligibility snapshot + state progression toward AWAITING_OPERATOR.
      this.refreshResponseEligibility(incident);
    }

    if (created > 0 || updated > 0 || evidenceAttached > 0) {
      this.deps.audit({
        kind: 'incident_processing_pass',
        assessments: assessments.length,
        created,
        updated,
        evidenceAttached,
        at: this.now(),
      });
    }
    return { created, updated, assessments: assessments.length };
  }

  // ------------------------------------------------------------ eligibility

  /** Containment eligibility against LIVE state. Pure evaluation — never
   *  executes anything. */
  evaluateContainmentEligibility(incident: Incident): ResponseEligibility {
    const state = incident.state;
    if (state === 'CONTAINED' || state === 'RESOLVED' || state === 'CLOSED') return 'BLOCKED_ALREADY_DONE';
    if (state === 'REFUSED' || state === 'RESPONSE_UNAVAILABLE') return 'BLOCKED_ALREADY_DONE';
    if (incident.responses.some((r) => r.action === 'CONTAIN' && r.eligibility === 'ELIGIBLE' && r.attempted && !r.result?.startsWith('retry'))) {
      return 'BLOCKED_ALREADY_DONE';
    }
    const stop = this.deps.stopKind();
    if (stop !== 'INACTIVE') return 'BLOCKED_BY_ESTOP'; // ACTIVE_UNCERTAIN fails closed too
    if (!this.deps.credentialSet()) return 'BLOCKED_NO_AUTHORITY';
    if (incident.containmentAuthorityEpoch !== null && incident.containmentAuthorityEpoch !== this.deps.credentialEpoch()) {
      return 'BLOCKED_NO_AUTHORITY'; // credential revoked/rotated since the incident recorded it
    }
    // CRITICAL containment requires authoritative Phase B confirmation.
    const confirmed = incident.evidence.some((e) => e.verification === 'confirmed-by-source');
    if (!confirmed) return 'PROHIBITED';
    // Identity: the incident must still reference a live-looking verified
    // subject; identity changes are detected at pin time by Phase D.
    if (!incident.subject.executablePath) return 'PROHIBITED';
    const contradiction = incident.evidence.filter((e) => e.verification === 'contradicted');
    if (contradiction.length >= 2) return 'UNAVAILABLE'; // conflicting evidence — human investigation first
    return incident.state === 'AWAITING_OPERATOR' || incident.state === 'ACTION_PENDING'
      ? 'ELIGIBLE_REQUIRES_OPERATOR'
      : 'ELIGIBLE';
  }

  /** Refresh + record the incident's response eligibility snapshot (bounded:
   *  the CURRENT eligibility replaces the previous non-attempted one). */
  refreshResponseEligibility(incident: Incident): void {
    const containElig = this.evaluateContainmentEligibility(incident);
    const responses: IncidentResponse[] = incident.responses.filter((r) => r.attempted);
    const mk = (action: ResponseActionKind, eligibility: ResponseEligibility, reason: string): IncidentResponse => ({
      id: `rsp_${this.now().toString(36)}_${randomBytes(4).toString('hex')}`,
      action,
      eligibility,
      reason,
      evidenceRefs: incident.evidence.slice(-3).map((e) => e.id),
      attempted: false,
      authorityEpoch: action === 'CONTAIN' ? this.deps.credentialEpoch() : undefined,
      at: this.now(),
    });

    responses.push(mk('PRESERVE_EVIDENCE', 'INFORMATION_ONLY', 'the E5 audit chain already retains every underlying record — preservation is informational'));
    const hasConfirmed = incident.evidence.some((e) => e.verification === 'confirmed-by-source');
    if (incident.severity === 'CRITICAL' || hasConfirmed) {
      responses.push(mk('NOTIFY_OPERATOR', 'ELIGIBLE', 'the operator must decide on any containment action'));
      responses.push(mk('REQUEST_HUMAN_REVIEW', 'ELIGIBLE_REQUIRES_OPERATOR', 'human review required before containment'));
    }
    const stop = this.deps.stopKind();
    responses.push(mk(
      'RESTRICT_OPERATION',
      stop === 'INACTIVE' ? 'ELIGIBLE_REQUIRES_OPERATOR' : 'BLOCKED_BY_ESTOP',
      stop === 'INACTIVE'
        ? 'restriction is available ONLY through the operator E-stop route — Phase F points at it and never activates it'
        : `emergency stop is ${stop} — restriction is already in force`,
    ));
    responses.push(mk('CONTAIN', containElig, this.containmentReason(containElig, incident)));

    // AWAITING_OPERATOR progression: containment is decided and needs the
    // operator, but is not yet authorized.
    if (containElig === 'ELIGIBLE' || containElig === 'ELIGIBLE_REQUIRES_OPERATOR') {
      const target = containElig === 'ELIGIBLE_REQUIRES_OPERATOR' ? 'AWAITING_OPERATOR' : 'AWAITING_OPERATOR';
      if (incident.state === 'ACTION_PENDING' || incident.state === 'CORRELATED') {
        this.deps.store.transition(incident.id, target, `containment eligible (${containElig}) — awaiting the operator's decision and credential`);
        this.deps.store.setPendingOperatorDecision(
          incident.id,
          'operator decision required: containment of a source-confirmed malicious process (approve with the operator credential)',
        );
        this.deps.store.setContainmentAuthorityEpoch(incident.id, this.deps.credentialEpoch());
      }
    }
    if (containElig === 'BLOCKED_BY_ESTOP' && (incident.state === 'AWAITING_OPERATOR' || incident.state === 'ACTION_PENDING')) {
      this.deps.store.setPendingOperatorDecision(
        incident.id,
        `containment blocked by the emergency stop (${stop}) — recovery required before any containment decision`,
      );
    }
    if (containElig === 'BLOCKED_NO_AUTHORITY' && incident.pendingOperatorDecision?.startsWith('operator decision required')) {
      this.deps.store.setPendingOperatorDecision(incident.id, 'containment authorization INVALIDATED — the approval credential was cleared or re-enrolled');
    }

    this.deps.store.replaceEligibility(incident.id, responses);
  }

  private containmentReason(elig: ResponseEligibility, incident: Incident): string {
    switch (elig) {
      case 'ELIGIBLE':
      case 'ELIGIBLE_REQUIRES_OPERATOR':
        return 'source-confirmed evidence present; executes ONLY through Phase D with the operator credential and a verified pinned identity';
      case 'BLOCKED_BY_ESTOP':
        return `emergency stop is ${this.deps.stopKind()} — fail-closed`;
      case 'BLOCKED_NO_AUTHORITY':
        return 'no enrolled approval credential, or the credential changed since the incident recorded it';
      case 'BLOCKED_ALREADY_DONE':
        return 'containment already performed or the incident is finished';
      case 'PROHIBITED':
        return 'no authoritative Phase B confirmation — correlation alone can never justify containment';
      case 'UNAVAILABLE':
        return 'conflicting evidence requires human investigation first';
      default:
        return `not eligible (${elig})`;
    }
  }

  // ------------------------------------------------------------ execution

  /**
   * Coordinated containment through Phase D. Re-checks eligibility against
   * LIVE state immediately before execution, then calls Phase D's
   * issueApproval + contain UNMODIFIED (credential verification, authority
   * epoch, pinning, and E-stop checks inside Phase D are the authority).
   * Every step is audited; any refusal transitions the incident honestly.
   */
  async respondContain(incidentId: string, operatorCredential: string): Promise<IncidentResponse> {
    const incident = this.deps.store.get(incidentId);
    const at = this.now();
    const fail = (eligibility: ResponseEligibility, reason: string): IncidentResponse => {
      const response: IncidentResponse = {
        id: `rsp_${at.toString(36)}_${randomBytes(4).toString('hex')}`,
        action: 'CONTAIN',
        eligibility,
        reason,
        evidenceRefs: incident?.evidence.slice(-3).map((e) => e.id) ?? [],
        attempted: false,
        at,
      };
      if (incident) this.deps.store.recordResponse(incidentId, response);
      this.deps.audit({
        kind: 'incident_response_refused',
        incidentId,
        action: 'CONTAIN',
        eligibility,
        reason,
        at,
      });
      return response;
    };

    if (!incident) return fail('PROHIBITED', 'unknown incident');
    // LIVE re-evaluation immediately before execution.
    const elig = this.evaluateContainmentEligibility(incident);
    if (elig !== 'ELIGIBLE' && elig !== 'ELIGIBLE_REQUIRES_OPERATOR') {
      return fail(elig, this.containmentReason(elig, incident));
    }

    const transition = this.deps.store.transition(incidentId, 'RESPONSE_IN_PROGRESS', 'operator-authorized containment starting (Phase D execution)');
    if (transition && transition.ok === false) {
      return fail('BLOCKED_ALREADY_DONE', `state transition refused: ${transition.reason}`);
    }

    const response: IncidentResponse = {
      id: `rsp_${at.toString(36)}_${randomBytes(4).toString('hex')}`,
      action: 'CONTAIN',
      eligibility: 'ELIGIBLE',
      reason: 'operator-authorized containment via Phase D (credential + epoch + pinning verified inside Phase D)',
      evidenceRefs: incident.evidence.slice(-3).map((e) => e.id),
      attempted: true,
      attemptedAt: this.now(),
      authorityEpoch: this.deps.credentialEpoch(),
      at,
    };

    try {
      // Phase D verifies the operator credential and mints the token.
      const issuance = await this.deps.containment.issueApproval(incident.subject.primaryPid ?? 0, operatorCredential);
      if (issuance.outcome !== 'APPROVAL_ISSUED' || !issuance.token) {
        // Approval-time refusal: recorded and audited, but the incident does
        // NOT transition — the operator decision is still pending and a retry
        // with the correct credential is legitimate.
        response.eligibility = issuance.outcome === 'APPROVAL_AUTHORITY_UNAVAILABLE' ? 'UNAVAILABLE' : 'BLOCKED_NO_AUTHORITY';
        response.result = `${issuance.outcome}: ${issuance.reason}`;
        this.deps.store.recordResponse(incidentId, response);
        this.deps.audit({ kind: 'incident_response_refused', incidentId, action: 'CONTAIN', eligibility: response.eligibility, reason: response.result, at: this.now() });
        return response;
      }

      // Phase D executes the containment (pinning + identity + E-stop checks
      // inside Phase D are authoritative).
      const result = await this.deps.containment.contain({ pid: incident.subject.primaryPid ?? 0, approvalToken: issuance.token.token });
      response.result = `${result.outcome}: ${result.reason}`;
      this.deps.store.recordResponse(incidentId, response);
      this.deps.store.setContainmentOutcome(incidentId, result.outcome);

      if (result.outcome === 'TERMINATED') {
        this.deps.store.transition(incidentId, 'CONTAINED', `Phase D terminated the pinned instance: ${result.reason}`);
        this.deps.store.transition(incidentId, 'RESOLVED', 'malicious process contained and verified exited');
        this.deps.store.setPendingOperatorDecision(incidentId, null);
      } else if (result.outcome === 'ALREADY_EXITED') {
        this.deps.store.transition(incidentId, 'RESOLVED', 'the malicious process had already exited — accurate outcome, nothing terminated');
        this.deps.store.setPendingOperatorDecision(incidentId, null);
      } else if (result.outcome.startsWith('REFUSED_')) {
        this.deps.store.transition(incidentId, 'REFUSED', `Phase D refused containment: ${result.reason}`);
      } else {
        // ACCESS_DENIED / VERIFICATION_UNAVAILABLE / IDENTITY_NOT_GUARANTEED
        this.deps.store.transition(incidentId, 'RESPONSE_UNAVAILABLE', `Phase D could not complete containment: ${result.reason}`);
      }
      this.deps.audit({
        kind: 'incident_response_attempt',
        incidentId,
        action: 'CONTAIN',
        outcome: result.outcome,
        targetPid: result.targetPid,
        at: this.now(),
      });
      return response;
    } catch (err) {
      response.eligibility = 'UNAVAILABLE';
      response.result = `containment infrastructure failure: ${String((err as Error)?.message || err)}`;
      this.deps.store.recordResponse(incidentId, response);
      this.deps.store.transition(incidentId, 'RESPONSE_UNAVAILABLE', `containment infrastructure failure — fail-closed: ${String((err as Error)?.message || err)}`);
      this.deps.audit({ kind: 'incident_response_refused', incidentId, action: 'CONTAIN', eligibility: 'UNAVAILABLE', reason: response.result, at: this.now() });
      return response;
    }
  }

  // ------------------------------------------------------------ helpers

  private evidenceEvents(intel: SecurityEventIntel, assessment: ThreatAssessment): SecurityEvent[] {
    const byId = new Map(intel.events().map((e) => [e.id, e]));
    const out: SecurityEvent[] = [];
    for (const ref of assessment.evidenceRefs) {
      const ev = byId.get(ref);
      if (ev) out.push(ev);
    }
    return out;
  }

  private categoryOf(ev: SecurityEvent): EvidenceCategory {
    switch (ev.category) {
      case 'process': return 'process_lifecycle';
      case 'detection': return 'classification';
      case 'exec_gate': return 'exec_gate';
      case 'containment': return 'containment';
      case 'spf': return 'spf';
      case 'lpv': return 'lpv';
      case 'stop': return 'stop';
      default: return 'other';
    }
  }
}
