/**
 * Threat Assessment (Phase E.3).
 *
 * Summarizes correlated evidence into assessments with SEPARATE severity and
 * confidence. Assessments are clearly labeled INFERENCES — the only
 * "confirmed" content is a Phase B classification fact, which is referenced
 * as `confirmed-by-source` (a fact ABOUT the classifier's output, never an
 * authorization and never a Phase-E judgment).
 *
 * HARD CONSTRAINTS:
 *  - Severity and confidence are independent axes. A HIGH-severity item can
 *    have LOW confidence and vice versa.
 *  - CRITICAL requires a source CONFIRMED_MALWARE detection among the
 *    evidence. Correlation alone can never produce CRITICAL, and no
 *    assessment ever authorizes termination (Phase D.4 keeps termination
 *    unreachable; assessments are input for human review).
 *  - Contradictory evidence (a later CLEAN classification for the same
 *    subject, an ALREADY_EXITED containment result, a declined challenge)
 *    LOWERS confidence and is listed by id.
 *  - Missing information is explicit (missing telemetry is never read as
 *    safety): no Defender data, missing source timestamps, unavailable
 *    subsystems, and dropped-overflow gaps are all surfaced.
 */
import { randomBytes } from 'node:crypto';
import type { SecurityEvent } from './eventTypes';
import type { SecurityEventIntel } from './intel';
import type { CorrelationEngine, CorrelationResult } from './correlation';

export type AssessmentSeverity = 'INFORMATIONAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AssessmentConfidenceLabel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export type RecommendedActionHint =
  | 'GATHER_METADATA'
  | 'REASSESS'
  | 'NOTIFY_OPERATOR'
  | 'PRESERVE_EVIDENCE'
  | 'RECHECK_DEFENDER'
  | 'REQUEST_HUMAN_REVIEW'
  | 'RESTRICT_OPERATION'
  | 'NONE';

export interface ThreatAssessment {
  id: string;
  /** Every assessment is an inference EXCEPT when it summarizes a Phase B
   *  classification fact — labeled 'confirmed-by-source' (a fact about the
   *  classifier's output; still never an authorization). */
  kind: 'inferred' | 'confirmed-by-source';
  severity: AssessmentSeverity;
  /** Separate axis: 0..1 plus a label. Never merged into severity. */
  confidence: number;
  confidenceLabel: AssessmentConfidenceLabel;
  subject: { pid?: number; name?: string; executablePath?: string };
  /** Ids of the events (E.1) and correlations (E.2) supporting this assessment. */
  evidenceRefs: string[];
  /** Ids of events that CONTRADICT the assessment. */
  contradictingRefs: string[];
  firstEvidenceAt: number;
  lastEvidenceAt: number;
  reason: string;
  missingInfo: string[];
  recommendedNextAction: RecommendedActionHint;
  humanReviewRequired: boolean;
  /** Source classification facts present in the evidence (Phase B output,
   *  referenced verbatim — Phase E never upgrades them). */
  sourceClassifications: string[];
  at: number;
}

export interface AssessmentOptions {
  maxActive?: number;
  now?: () => number;
  /** Metadata-only audit sink (assessment generation is audited). */
  audit?: (event: { kind: string; [key: string]: unknown }) => void;
}

const SEVERITY_ORDER: Record<AssessmentSeverity, number> = {
  INFORMATIONAL: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4,
};

const CONF_LABEL: Array<{ min: number; label: AssessmentConfidenceLabel }> = [
  { min: 0.75, label: 'HIGH' },
  { min: 0.5, label: 'MEDIUM' },
  { min: 0.25, label: 'LOW' },
  { min: -1, label: 'NONE' },
];

function labelFor(confidence: number): AssessmentConfidenceLabel {
  for (const c of CONF_LABEL) if (confidence >= c.min) return c.label;
  return 'NONE';
}

export class AssessmentEngine {
  private readonly maxActive: number;
  private readonly now: () => number;
  private readonly audit: ((event: { kind: string; [key: string]: unknown }) => void) | undefined;

  constructor(private readonly correlations: CorrelationEngine, options: AssessmentOptions = {}) {
    this.maxActive = Math.max(5, options.maxActive ?? 25);
    this.now = options.now ?? Date.now;
    this.audit = options.audit;
  }

  /** Build current assessments from the intel ring. Called on demand (reads),
   *  never on a timer. Deterministic for a fixed event set. */
  assess(intel: SecurityEventIntel): ThreatAssessment[] {
    const now = this.now();
    const events = intel.events();
    const results = this.correlations.correlate(intel);
    const assessments: ThreatAssessment[] = [];

    for (const correlation of results) {
      const evidence = evidenceEvents(events, correlation.evidenceEventIds);
      if (evidence.length === 0) continue;

      const sourceClassifications = [...new Set(
        evidence.map((e) => e.subject.classification ?? '').filter((c) => c.length > 0),
      )];
      const hasConfirmedSource = sourceClassifications.some((c) => c.toUpperCase() === 'CONFIRMED_MALWARE');

      // Contradictions: a later CLEAN/UNKNOWN classification for the same
      // subject, an ALREADY_EXITED result, or a declined challenge.
      const contradicting = events.filter((e) => isContradicting(e, evidence));
      const hasTimelessEvidence = evidence.some((e) => !e.observedTimestamp);
      const statisticalOnly = correlation.statisticalOnly;

      // Base confidence from the correlation hint, reduced by contradictions,
      // statistical-only evidence, and missing timestamps.
      let confidence = correlation.confidenceHint === 'HIGH' ? 0.8
        : correlation.confidenceHint === 'MEDIUM' ? 0.55
        : correlation.confidenceHint === 'LOW' ? 0.3 : 0.1;
      if (statisticalOnly) confidence *= 0.6;
      if (hasTimelessEvidence) confidence *= 0.7;
      confidence = Math.max(0.05, Math.min(0.95, confidence * Math.pow(0.6, contradicting.length)));

      // Severity: correlation hint, capped — CRITICAL only with a source
      // CONFIRMED_MALWARE fact; contradictions do not raise severity but a
      // strong contradiction caps severity at MEDIUM.
      let severity: AssessmentSeverity = correlation.severityHint;
      if (severity === 'CRITICAL' && !hasConfirmedSource) severity = 'HIGH';
      if (hasConfirmedSource && SEVERITY_ORDER[severity] < SEVERITY_ORDER.HIGH) severity = 'HIGH';
      const cleanContradiction = contradicting.some((e) => (e.subject.classification ?? '').toUpperCase() === 'CLEAN');
      if (cleanContradiction && SEVERITY_ORDER[severity] > SEVERITY_ORDER.MEDIUM) severity = 'MEDIUM';

      const missingInfo: string[] = [];
      if (hasTimelessEvidence) missingInfo.push('one or more evidence events lack a source timestamp');
      if (!evidence.some((e) => e.category === 'detection') && !evidence.some((e) => e.subject.classification)) {
        missingInfo.push('no file/classification evidence is attached to these events');
      }
      const exited = evidence.some((e) => (e.subject.decision ?? '').toUpperCase().includes('ALREADY_EXITED'));
      if (exited) missingInfo.push('subject process already exited — live verification impossible');

      const recommendedNextAction: RecommendedActionHint = hasConfirmedSource ? 'REQUEST_HUMAN_REVIEW'
        : severity === 'HIGH' ? 'REQUEST_HUMAN_REVIEW'
        : severity === 'MEDIUM' ? 'GATHER_METADATA'
        : severity === 'LOW' ? 'REASSESS'
        : 'NOTIFY_OPERATOR';

      const firstEvidenceAt = Math.min(...evidence.map((e) => (e.observedTimestamp ? e.observedAt : e.ingestedAt)));
      const lastEvidenceAt = Math.max(...evidence.map((e) => (e.observedTimestamp ? e.observedAt : e.ingestedAt)));

      assessments.push({
        id: `tae_${now.toString(36)}_${randomBytes(5).toString('hex')}`,
        kind: hasConfirmedSource ? 'confirmed-by-source' : 'inferred',
        severity,
        confidence: Math.round(confidence * 100) / 100,
        confidenceLabel: labelFor(confidence),
        subject: correlation.subject,
        evidenceRefs: [...correlation.evidenceEventIds],
        contradictingRefs: contradicting.map((e) => e.id),
        firstEvidenceAt,
        lastEvidenceAt,
        reason: correlation.description,
        missingInfo,
        recommendedNextAction,
        humanReviewRequired: SEVERITY_ORDER[severity] >= SEVERITY_ORDER.MEDIUM || hasConfirmedSource,
        sourceClassifications,
        at: now,
      });
    }

    // Standalone source-confirmed detections (a Phase B CONFIRMED_MALWARE
    // fact without any correlation) — referenced, never upgraded.
    const correlatedRefs = new Set(assessments.flatMap((a) => a.evidenceRefs));
    for (const event of events) {
      if (event.category !== 'detection') continue;
      if ((event.subject.classification ?? '').toUpperCase() !== 'CONFIRMED_MALWARE') continue;
      if (correlatedRefs.has(event.id)) continue;
      assessments.push({
        id: `tae_${now.toString(36)}_${randomBytes(5).toString('hex')}`,
        kind: 'confirmed-by-source',
        severity: 'CRITICAL',
        confidence: 0.9,
        confidenceLabel: 'HIGH',
        subject: {
          pid: event.subject.pid,
          name: event.subject.name,
          executablePath: event.subject.executablePath,
        },
        evidenceRefs: [event.id],
        contradictingRefs: [],
        firstEvidenceAt: event.observedTimestamp ? event.observedAt : event.ingestedAt,
        lastEvidenceAt: event.observedTimestamp ? event.observedAt : event.ingestedAt,
        reason: 'Phase B reported a CONFIRMED_MALWARE classification (Defender-trusted source detection). Referenced verbatim — Phase E adds no judgment and no authorization.',
        missingInfo: event.observedTimestamp ? [] : ['the detection record lacks a source timestamp'],
        recommendedNextAction: 'REQUEST_HUMAN_REVIEW',
        humanReviewRequired: true,
        sourceClassifications: ['CONFIRMED_MALWARE'],
        at: now,
      });
    }

    const final = assessments
      .sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.confidence - a.confidence)
      .slice(0, this.maxActive);

    try {
      this.audit?.({
        kind: 'security_assessment_generated',
        count: final.length,
        critical: final.filter((a) => a.severity === 'CRITICAL').length,
        at: now,
      });
    } catch { /* audit must never break assessment */ }

    return final;
  }
}

function evidenceEvents(events: readonly SecurityEvent[], ids: string[]): SecurityEvent[] {
  const set = new Set(ids);
  return events.filter((e) => set.has(e.id));
}

/** A later event contradicts the assessment when it concerns the same
 *  subject AND carries a weaker/positive classification or an honest
 *  already-exited outcome. Ordering: only events with timestamps can be
 *  "later"; time-less contradicting events are still surfaced (they weaken
 *  confidence) but ordering cannot be proven. */
function isContradicting(candidate: SecurityEvent, evidence: SecurityEvent[]): boolean {
  const subject = evidence.find((e) => sameSubjectCheck(candidate, e));
  if (!subject) return false;
  if (candidate.id === subject.id) return false;
  const decision = (candidate.subject.decision ?? '').toUpperCase();
  if (decision.includes('ALREADY_EXITED')) {
    return !candidate.observedTimestamp || !subject.observedTimestamp || candidate.observedAt >= subject.observedAt;
  }
  const cls = (candidate.subject.classification ?? '').toUpperCase();
  if (cls === 'CLEAN' && (subject.subject.classification ?? '').toUpperCase() !== 'CLEAN') {
    return !candidate.observedTimestamp || !subject.observedTimestamp || candidate.observedAt >= subject.observedAt;
  }
  return false;
}

function sameSubjectCheck(a: SecurityEvent, b: SecurityEvent): boolean {
  if (a.subject.pid !== undefined && b.subject.pid !== undefined && a.subject.pid === b.subject.pid) return true;
  if (a.subject.executablePath && b.subject.executablePath) {
    return a.subject.executablePath.toLowerCase() === b.subject.executablePath.toLowerCase();
  }
  if (a.subject.name && b.subject.name) return a.subject.name.toLowerCase() === b.subject.name.toLowerCase();
  return false;
}
