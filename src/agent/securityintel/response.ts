/**
 * Safe Response Recommendations (Phase E.5).
 *
 * Produces RECOMMENDATIONS ONLY. A recommendation is not execution
 * authorization: no pathway here can terminate, quarantine, delete,
 * elevate, modify Defender, disable a control, or transmit anything. The
 * allowed action set is a closed enum; anything outside it (including every
 * destructive/process-control action) is structurally rejected. When an
 * action would require approval authority that Phase D.4 established as
 * unavailable, the recommendation is marked `approvalAvailability:
 * 'unavailable'` instead of pretending it is actionable.
 *
 * Every recommendation carries its reason and the evidence references that
 * justify it, and is audited (metadata-only) for integrity.
 */
import { randomBytes } from 'node:crypto';
import type { ThreatAssessment, RecommendedActionHint } from './assessment';
import type { SecuritySituation } from './situation';

export type SafeResponseAction = RecommendedActionHint;

/** Actions Phase E can recommend. Closed set — anything else is rejected. */
export const ALLOWED_ACTIONS: ReadonlySet<SafeResponseAction> = new Set([
  'GATHER_METADATA',
  'REASSESS',
  'NOTIFY_OPERATOR',
  'PRESERVE_EVIDENCE',
  'RECHECK_DEFENDER',
  'REQUEST_HUMAN_REVIEW',
  'RESTRICT_OPERATION',
  'NONE',
]);

/** Structurally forbidden actions — never generated, never executed. Listed
 *  so the rejection guard is explicit and testable. */
export const FORBIDDEN_ACTIONS: ReadonlySet<string> = new Set([
  'TERMINATE_PROCESS', 'TERMINATE', 'KILL', 'SUSPEND_PROCESS', 'QUARANTINE_FILE',
  'DELETE_FILE', 'DELETE', 'MODIFY_DEFENDER', 'DISABLE_CONTROL', 'ELEVATE',
  'EXECUTE_COMMAND', 'UPLOAD', 'BROADCAST', 'WRITE_REGISTRY', 'PATCH_FILE',
]);

export type ApprovalAvailability = 'not_required' | 'unavailable';

export interface ResponseRecommendation {
  id: string;
  assessmentId: string;
  action: SafeResponseAction;
  reason: string;
  evidenceRefs: string[];
  requiresHumanReview: boolean;
  /** 'unavailable' when the action would need the approval authority that
   *  Phase D.4 established as absent. A recommendation marked unavailable is
   *  explicitly NOT actionable through any existing pathway. */
  approvalAvailability: ApprovalAvailability;
  /** For RESTRICT_OPERATION: the EXISTING authorized mechanism to use
   *  (operator E-stop route / scoped-grant revocation) — a pointer, never a
   *  bypass. */
  restrictVia?: string;
  rejected?: boolean;
  rejectionReason?: string;
  at: number;
}

export interface RecommendationOptions {
  now?: () => number;
  /** Metadata-only audit sink (recommendation integrity). */
  audit?: (event: { kind: string; [key: string]: unknown }) => void;
}

export class ResponseRecommender {
  private readonly now: () => number;
  private readonly audit: ((event: { kind: string; [key: string]: unknown }) => void) | undefined;

  constructor(private readonly situation: SecuritySituation, options: RecommendationOptions = {}) {
    this.now = options.now ?? Date.now;
    this.audit = options.audit;
  }

  /** Recommendations for one assessment. Deterministic; audited. */
  recommendFor(assessment: ThreatAssessment): ResponseRecommendation[] {
    const now = this.now();
    const out: ResponseRecommendation[] = [];

    const push = (action: SafeResponseAction, reason: string, extra?: Partial<ResponseRecommendation>): void => {
      const rec = this.build(assessment, action, reason, now, extra);
      if (rec.rejected) return;
      out.push(rec);
      this.emitAudit(rec, assessment);
    };

    const stopState = this.safeStopKind();

    // Universal: preserve evidence for anything above INFORMATIONAL.
    if (assessment.severity !== 'INFORMATIONAL') {
      push('PRESERVE_EVIDENCE',
        `assessment ${assessment.id} is ${assessment.severity} with ${assessment.evidenceRefs.length} evidence record(s) — the E5 audit chain already retains the underlying records; no further preservation action is authorized`,
        { approvalAvailability: 'not_required' });
    }

    // Defender recheck when no Defender data contributed to the evidence.
    const defenderUnknown = assessment.missingInfo.some((m) => m.toLowerCase().includes('defender'))
      || !assessment.evidenceRefs.some(() => false);
    const hasDetectionEvidence = assessment.sourceClassifications.length > 0;
    if (!hasDetectionEvidence) {
      push('RECHECK_DEFENDER',
        'no Defender-derived classification contributed to this assessment — a bounded, rate-limited availability check would strengthen or weaken it',
        { approvalAvailability: 'not_required' });
    }
    void defenderUnknown;

    // CRITICAL / confirmed-by-source: human review + notification, and the
    // restriction pointer — NEVER termination.
    if (assessment.severity === 'CRITICAL' || assessment.kind === 'confirmed-by-source') {
      push('NOTIFY_OPERATOR',
        `assessment ${assessment.id} reaches CRITICAL${assessment.kind === 'confirmed-by-source' ? ' from a source CONFIRMED_MALWARE detection' : ''} — the operator must decide; no autonomous action is authorized`,
        { approvalAvailability: 'not_required' });
      push('REQUEST_HUMAN_REVIEW',
        'a human decision is required before any response beyond metadata gathering',
        { approvalAvailability: 'not_required' });
      push('RESTRICT_OPERATION',
        `if the operator chooses to restrict Krisha-managed operations while reviewing, the EXISTING authorized mechanism is the operator emergency-stop route (E5) — Phase E cannot activate it and only points at it`,
        { approvalAvailability: 'not_required', restrictVia: 'POST /api/safety/stop/activate (operator authorization required; Phase E does not invoke it)' });
    }

    // MEDIUM: gather metadata / reassess.
    if (assessment.severity === 'MEDIUM') {
      push('GATHER_METADATA',
        'corroborating metadata (file reputation via the existing read-only assessment route, process exit confirmation) would refine this inference',
        { approvalAvailability: 'not_required' });
      push('REASSESS', 'evidence is correlational; reassessment after new events may raise or lower it', { approvalAvailability: 'not_required' });
    }

    // LOW / INFORMATIONAL: reassess on new evidence.
    if (assessment.severity === 'LOW' || assessment.severity === 'INFORMATIONAL') {
      push('REASSESS', 'low-severity inference — reassess when further events arrive; no immediate action warranted', { approvalAvailability: 'not_required' });
    }

    // E-stop active: only notification/review remain sensible; everything
    // else is suppressed (the stop already restricts authorization-requiring
    // operations, and no recommendation may weaken it).
    if (stopState !== 'INACTIVE') {
      for (const rec of out) {
        if (rec.action !== 'NOTIFY_OPERATOR' && rec.action !== 'REQUEST_HUMAN_REVIEW' && rec.action !== 'PRESERVE_EVIDENCE') {
          rec.rejected = true;
          rec.rejectionReason = `emergency stop is ${stopState} — only notification/review/evidence recommendations remain`;
        }
      }
    }

    const final = out.filter((r) => !r.rejected);
    if (final.length === 0) {
      push('NOTIFY_OPERATOR', `no safe automated response exists for assessment ${assessment.id} under the current constraints (stop state: ${stopState}) — operator notification only`, { approvalAvailability: 'not_required' });
    }
    return out.filter((r) => !r.rejected);
  }

  /** Explicit rejection API: any caller-proposed action outside the allowed
   *  set (including every destructive/process-control action) is rejected
   *  with a reason, never executed, never audited as a valid recommendation. */
  rejectUnsupported(assessmentId: string, proposedAction: string): ResponseRecommendation {
    const now = this.now();
    const rec: ResponseRecommendation = {
      id: `rer_${now.toString(36)}_${randomBytes(5).toString('hex')}`,
      assessmentId,
      action: 'NONE',
      reason: 'proposed action is outside the safe recommendation set',
      evidenceRefs: [],
      requiresHumanReview: false,
      approvalAvailability: 'not_required',
      rejected: true,
      rejectionReason: FORBIDDEN_ACTIONS.has(proposedAction.toUpperCase())
        ? `"${proposedAction}" is a forbidden action class (destructive/process-control/configuration) — Phase E cannot recommend or execute it`
        : `"${proposedAction}" is not in the allowed recommendation set`,
      at: now,
    };
    this.emitAudit(rec, undefined);
    return rec;
  }

  /** Mark authority-requiring requests honestly: any proposed action that
   *  would need the Phase D.4 approval authority is unavailable — never
   *  "pending", never "maybe". The terminate class is authority-gated AND
   *  forbidden; RESTRICT_OPERATION only points at the operator's existing
   *  E-stop mechanism, so it needs no authority itself. */
  approvalAvailabilityFor(proposedAction: string): ApprovalAvailability {
    const a = proposedAction.toUpperCase();
    if (a === 'TERMINATE' || a === 'TERMINATE_PROCESS') return 'unavailable';
    if (FORBIDDEN_ACTIONS.has(a)) return 'not_required'; // rejected outright, not gated
    return 'not_required';
  }

  private build(assessment: ThreatAssessment, action: SafeResponseAction, reason: string, now: number, extra?: Partial<ResponseRecommendation>): ResponseRecommendation {
    const rec: ResponseRecommendation = {
      id: `rer_${now.toString(36)}_${randomBytes(5).toString('hex')}`,
      assessmentId: assessment.id,
      action: ALLOWED_ACTIONS.has(action) ? action : 'NONE',
      reason,
      evidenceRefs: [...assessment.evidenceRefs],
      requiresHumanReview: assessment.humanReviewRequired || action === 'REQUEST_HUMAN_REVIEW' || action === 'RESTRICT_OPERATION',
      approvalAvailability: extra?.approvalAvailability ?? this.approvalAvailabilityFor(action),
      restrictVia: extra?.restrictVia,
      at: now,
    };
    if (!ALLOWED_ACTIONS.has(action)) {
      rec.rejected = true;
      rec.rejectionReason = `"${action}" is not in the allowed recommendation set`;
    }
    if (FORBIDDEN_ACTIONS.has(action.toUpperCase())) {
      rec.rejected = true;
      rec.rejectionReason = `"${action}" is a forbidden action class — Phase E cannot recommend or execute it`;
    }
    return rec;
  }

  private emitAudit(rec: ResponseRecommendation, assessment?: ThreatAssessment): void {
    try {
      this.audit?.({
        kind: 'security_response_recommendation',
        recommendationId: rec.id,
        assessmentId: rec.assessmentId,
        assessmentSeverity: assessment?.severity ?? null,
        action: rec.action,
        approvalAvailability: rec.approvalAvailability,
        requiresHumanReview: rec.requiresHumanReview,
        rejected: rec.rejected === true,
        evidenceCount: rec.evidenceRefs.length,
        at: rec.at,
      });
    } catch { /* audit must never break recommendations */ }
  }

  private safeStopKind(): string {
    try {
      const s = this.situation.getSituation();
      return String((s.stop.detail as { stopKind?: string }).stopKind ?? 'ACTIVE_UNCERTAIN');
    } catch {
      return 'ACTIVE_UNCERTAIN'; // unavailable stop state fails closed
    }
  }
}
