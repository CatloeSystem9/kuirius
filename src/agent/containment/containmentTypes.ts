/**
 * Threat Containment (Phase D) — types.
 *
 * Narrowly scoped defensive containment: verify process identity, check
 * classification evidence, require operator authorization, terminate the
 * exact verified process instance. No broad kill, no name-based matching,
 * no automatic termination without approval.
 */
export type ContainmentOutcome =
  | 'TERMINATED'
  | 'ALREADY_EXITED'
  | 'REFUSED_IDENTITY_CHANGED'
  | 'REFUSED_PID_REUSED'
  | 'REFUSED_INSUFFICIENT_EVIDENCE'
  | 'REFUSED_STALE_EVIDENCE'
  | 'REFUSED_E_STOP'
  | 'REFUSED_NO_APPROVAL'
  | 'REFUSED_PROTECTED_PROCESS'
  | 'ACCESS_DENIED'
  | 'VERIFICATION_UNAVAILABLE';

export type ContainmentClassification =
  | 'CONFIRMED_MALWARE'
  | 'SUSPICIOUS'
  | 'UNKNOWN'
  | 'CLEAN'
  | 'UNAVAILABLE';

export interface ProcessIdentity {
  pid: number;
  name: string;
  /** WMI CreationDate for identity verification (prevents PID-reuse errors). */
  creationTime: string;
  executablePath: string;
}

export interface ContainmentEvidence {
  classification: ContainmentClassification;
  confidence: string;
  /** SHA-256 of the executable at assessment time. */
  fileHash?: string;
  /** Defender ThreatID when available. */
  defenderThreatId?: string;
  /** Timestamp of the assessment that produced this evidence. */
  assessedAt: number;
  evidenceSources: string[];
}

export interface ContainmentRequest {
  target: ProcessIdentity;
  evidence: ContainmentEvidence;
  /** Operator approval token (issued via the containment approval route). */
  approvalToken: string;
}

export interface ContainmentResult {
  outcome: ContainmentOutcome;
  reason: string;
  targetPid: number;
  targetName: string;
  audited: boolean;
}

export interface ContainmentAuditEvent {
  kind: 'threat_containment';
  outcome: ContainmentOutcome;
  reason: string;
  targetPid: number;
  targetName: string;
  targetCreationTime: string;
  classification: ContainmentClassification;
  confidence: string;
  evidenceSources: string[];
  hasApprovalToken: boolean;
  at: number;
}
