/**
 * Incident Orchestration (Phase F) — types.
 *
 * Phase F coordinates the EXISTING security subsystems (A–E) into traceable
 * incidents with a deterministic lifecycle, structured evidence, and
 * authorization-aware response eligibility. It is a COORDINATION layer:
 *
 *  - Phase E remains the ONLY intelligence/classification source. Phase F
 *    never classifies and never promotes UNKNOWN/SUSPICIOUS; CRITICAL
 *    requires a source CONFIRMED_MALWARE fact (confirmed-by-source).
 *  - Containment executes ONLY through Phase D (operator credential
 *    verification, authority epoch, process-instance pinning untouched).
 *  - The E-stop is authoritative at evaluation AND execution.
 *  - Incident records are metadata-only (no secrets, no command lines, no
 *    content) and bounded.
 */

export type IncidentState =
  | 'DETECTED'
  | 'ASSESSING'
  | 'CORRELATED'
  | 'ACTION_PENDING'
  | 'AWAITING_OPERATOR'
  | 'RESPONSE_IN_PROGRESS'
  | 'CONTAINED'
  | 'RESOLVED'
  | 'CLOSED'
  | 'INVESTIGATION_REQUIRED'
  | 'REFUSED'
  | 'RESPONSE_UNAVAILABLE';

/** Valid lifecycle transitions. Anything not listed here is rejected (and
 *  audited) — invalid transitions can never corrupt an incident. */
export const VALID_TRANSITIONS: Record<IncidentState, readonly IncidentState[]> = {
  DETECTED: ['ASSESSING', 'CORRELATED', 'RESOLVED', 'CLOSED', 'INVESTIGATION_REQUIRED'],
  ASSESSING: ['CORRELATED', 'ACTION_PENDING', 'AWAITING_OPERATOR', 'INVESTIGATION_REQUIRED', 'RESOLVED', 'CLOSED', 'RESPONSE_UNAVAILABLE'],
  CORRELATED: ['ACTION_PENDING', 'AWAITING_OPERATOR', 'INVESTIGATION_REQUIRED', 'RESOLVED', 'CLOSED', 'RESPONSE_UNAVAILABLE'],
  ACTION_PENDING: ['AWAITING_OPERATOR', 'RESPONSE_IN_PROGRESS', 'INVESTIGATION_REQUIRED', 'RESOLVED', 'CLOSED', 'RESPONSE_UNAVAILABLE', 'REFUSED'],
  AWAITING_OPERATOR: ['RESPONSE_IN_PROGRESS', 'ACTION_PENDING', 'REFUSED', 'RESOLVED', 'CLOSED', 'RESPONSE_UNAVAILABLE', 'INVESTIGATION_REQUIRED'],
  RESPONSE_IN_PROGRESS: ['CONTAINED', 'AWAITING_OPERATOR', 'RESOLVED', 'CLOSED', 'RESPONSE_UNAVAILABLE', 'REFUSED'],
  CONTAINED: ['RESOLVED', 'CLOSED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
  INVESTIGATION_REQUIRED: ['ASSESSING', 'CORRELATED', 'ACTION_PENDING', 'AWAITING_OPERATOR', 'RESOLVED', 'CLOSED'],
  REFUSED: ['CLOSED', 'RESOLVED', 'INVESTIGATION_REQUIRED'],
  RESPONSE_UNAVAILABLE: ['CLOSED', 'RESOLVED', 'INVESTIGATION_REQUIRED', 'AWAITING_OPERATOR', 'ACTION_PENDING'],
};

export function isValidTransition(from: IncidentState, to: IncidentState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) === true;
}

export interface IncidentTransition {
  from: IncidentState;
  to: IncidentState;
  reason: string;
  at: number;
}

export type EvidenceCategory =
  | 'process_lifecycle'
  | 'classification'
  | 'exec_gate'
  | 'containment'
  | 'spf'
  | 'lpv'
  | 'stop'
  | 'correlation'
  | 'response'
  | 'other';

export type EvidenceVerification = 'observed' | 'confirmed-by-source' | 'contradicted';

/** One structured evidence item. Metadata only. The ORIGINAL Phase E event
 *  id is preserved as provenance; the item carries a bounded copy of the
 *  subject/facts so the incident survives restarts (the intel ring does not). */
export interface EvidenceItem {
  id: string;
  category: EvidenceCategory;
  /** Phase E normalized event id (dangling after restart — the original
   *  records remain in the E5 audit chain; documented). */
  sourceEventId: string | null;
  /** Subsystem that produced the underlying record. */
  source: string;
  originalKind: string;
  /** Original event timestamp (0 = the source had none — honest gap). */
  observedAt: number;
  attachedAt: number;
  subject: {
    pid?: number;
    name?: string;
    executablePath?: string;
    creationTime?: string;
  };
  /** Classification provenance: verbatim from the source subsystem, never
   *  upgraded by Phase F or by correlation. */
  classification: string | null;
  classificationSource: string | null;
  confidence: string | null;
  severity: string | null;
  /** Age of the evidence at attachment (ms) — stale evidence is identifiable. */
  evidenceAgeMs: number;
  stale: boolean;
  /** Phase E correlation references backing this item (when applicable). */
  correlationRefs: string[];
  verification: EvidenceVerification;
}

export type ResponseActionKind =
  | 'NOTIFY_OPERATOR'
  | 'PRESERVE_EVIDENCE'
  | 'REQUEST_HUMAN_REVIEW'
  | 'RECHECK_DEFENDER'
  | 'REASSESS'
  | 'GATHER_METADATA'
  | 'RESTRICT_OPERATION'
  | 'CONTAIN';

export type ResponseEligibility =
  | 'ELIGIBLE'
  | 'ELIGIBLE_REQUIRES_OPERATOR'
  | 'INFORMATION_ONLY'
  | 'BLOCKED_BY_ESTOP'
  | 'BLOCKED_NO_AUTHORITY'
  | 'BLOCKED_IDENTITY_CHANGED'
  | 'BLOCKED_ALREADY_DONE'
  | 'PROHIBITED'
  | 'UNAVAILABLE';

export interface IncidentResponse {
  id: string;
  action: ResponseActionKind;
  eligibility: ResponseEligibility;
  reason: string;
  evidenceRefs: string[];
  /** Containment responses carry the Phase D authority epoch they were
   *  evaluated against; execution re-checks it. */
  authorityEpoch?: number;
  attempted: boolean;
  attemptedAt?: number;
  result?: string;
  at: number;
}

export interface Incident {
  id: string;
  createdAt: number;
  updatedAt: number;
  state: IncidentState;
  /** Severity of the highest-severity CONFIRMED-BACKED assessment; never
   *  upgraded by Phase F. */
  severity: 'INFORMATIONAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  confidence: string;
  /** Subject identity: executablePath is the association anchor (never the
   *  name alone); pid instances are tracked per evidence item. */
  subject: {
    executablePath: string | null;
    primaryPid: number | null;
    primaryCreationTime: string | null;
    displayName: string | null;
  };
  evidence: EvidenceItem[];
  /** Phase E assessment summaries attached to this incident (bounded). */
  assessments: Array<{
    id: string;
    kind: string;
    severity: string;
    confidenceLabel: string;
    reason: string;
    at: number;
  }>;
  transitions: IncidentTransition[];
  responses: IncidentResponse[];
  /** Containment outcome once known (from Phase D results). */
  containmentOutcome: string | null;
  finalOutcome: string | null;
  /** Authority epoch recorded when containment became eligible (revocation
   *  invalidates it). */
  containmentAuthorityEpoch: number | null;
  pendingOperatorDecision: string | null;
}

export interface IncidentAuditEvent {
  kind: 'incident_orchestration';
  incidentId: string;
  op: string;
  detail: string;
  state?: IncidentState;
  at: number;
}

export interface IncidentStoreOptions {
  /** Maximum ACTIVE incidents (oldest closed/resolved evicted beyond this). */
  maxActive?: number;
  /** Maximum retained CLOSED/RESOLVED incidents (archive bound). */
  maxArchived?: number;
  /** Maximum evidence items per incident (bounded storage). */
  maxEvidencePerIncident?: number;
  /** Evidence older than this (at attach time) is marked stale. */
  staleEvidenceMs?: number;
  /** Persist state to the E5 store across restarts. */
  persistPath?: string | null;
  now?: () => number;
  audit?: (event: IncidentAuditEvent) => void;
}

/** Policy: which assessments create incidents. Deliberately conservative —
 *  INFORMATIONAL/LOW events remain events, not incidents. */
export function shouldCreateIncident(assessment: {
  kind: string;
  severity: string;
  sourceClassifications?: string[];
}): boolean {
  if (assessment.kind === 'confirmed-by-source') return true;
  const s = assessment.severity;
  return s === 'CRITICAL' || s === 'HIGH' || s === 'MEDIUM';
}
