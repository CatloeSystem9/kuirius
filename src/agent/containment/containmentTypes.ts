/**
 * Threat Containment (Phase D.3) — types.
 *
 * Narrowly scoped defensive containment: pin the exact process instance,
 * verify its identity THROUGH the pinned OS reference, require operator
 * authorization, and terminate the pinned instance. No broad kill, no
 * name-based matching, no automatic termination without approval.
 *
 * PHASE D.3 IDENTITY MODEL:
 *  Termination is bound to a process-instance reference (an OS process
 *  handle opened with PROCESS_TERMINATE at verification time), NOT to a
 *  PID. A handle refers to the kernel process OBJECT — if the process
 *  exits and its PID is reused, the handle still refers to the original
 *  (now exited) object, so termination can never follow PID reuse.
 *  Identity (creation time, image path, name) is read THROUGH the pin,
 *  making the verification and the termination target the same object.
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
  | 'REFUSED_APPROVAL_INVALID'
  | 'REFUSED_PROTECTED_PROCESS'
  | 'IDENTITY_NOT_GUARANTEED'
  | 'ACCESS_DENIED'
  | 'VERIFICATION_UNAVAILABLE'
  | 'APPROVAL_ISSUED'
  | 'APPROVAL_AUTHORITY_UNAVAILABLE';

/**
 * Result of the INDEPENDENT approval-authority check (Phase D.4, completed
 * in the Phase D final pass with a credential-backed authority).
 *
 * This is the boundary between "a caller holds a permission" and "an
 * operator actually decided". A permission is a capability grant; it is NOT
 * evidence that a human operator reviewed and approved THIS action. The
 * authority dependency models whatever mechanism can establish that
 * decision. The production wiring verifies the operator's enrollment
 * credential (a dedicated operator secret enrolled through the recovery
 * pipe, stored in the protected E5 store): without enrollment the authority
 * is `authorized: false, unavailable: true` and termination is unreachable
 * (fail-closed; the missing capability is documented, not simulated).
 */
export type ApprovalAuthorityResult =
  | { authorized: true; authorityId: string; method: string; /** Authority epoch at decision time — when provided, termination re-checks it for mid-operation invalidation. */ authorityEpoch?: number }
  | { authorized: false; unavailable: boolean; reason: string };

export type ContainmentClassification =
  | 'CONFIRMED_MALWARE'
  | 'HIGH_CONFIDENCE_THREAT'
  | 'SUSPICIOUS'
  | 'UNKNOWN'
  | 'CLEAN'
  | 'UNAVAILABLE';

export interface ProcessIdentity {
  pid: number;
  name: string;
  /** Creation time of the exact process instance (ISO 8601, read through the pinned OS reference). */
  creationTime: string;
  executablePath: string;
}

/** Server-derived classification evidence (Phase B engine output). */
export interface ClassificationEvidence {
  classification: ContainmentClassification;
  confidence: string;
  /** Timestamp of the server-side assessment (ms epoch). */
  assessedAt: number;
  evidenceSources: string[];
}

export interface ContainmentRequest {
  /** PID of the process to contain (must match the approval token binding). */
  pid: number;
  /** Operator approval token issued by ThreatContainment.issueApproval (server-side). */
  approvalToken: string;
}

/** A server-minted, single-use containment approval bound to one process instance. */
export interface ContainmentApprovalToken {
  token: string;
  pid: number;
  name: string;
  creationTime: string;
  executablePath: string;
  classification: ContainmentClassification;
  /** Authority epoch at issuance — termination refuses when the authority
   *  changed between approval and termination (credential cleared/rotated). */
  authorityEpoch?: number;
  issuedAt: number;
  expiresAt: number;
}

export interface ContainmentResult {
  outcome: ContainmentOutcome;
  reason: string;
  targetPid: number;
  targetName: string;
  audited: boolean;
}

/** Result of a server-side containment approval issuance attempt. */
export interface ContainmentApprovalIssuance {
  outcome: ContainmentOutcome;
  reason: string;
  /** Present only when outcome is APPROVAL_ISSUED. */
  token?: ContainmentApprovalToken;
  /** Server-read identity of the approved process instance. */
  identity?: ProcessIdentity;
  classification?: ContainmentClassification;
}

/** Why a process instance could not be pinned. */
export type PinFailure = 'NOT_FOUND' | 'ACCESS_DENIED' | 'INFRASTRUCTURE';

/**
 * Thrown when a terminate-capable process-instance reference cannot be
 * established. NOT_FOUND is expressed as a null pin instead; this error
 * covers ACCESS_DENIED (the process exists but the OS refused the reference)
 * and INFRASTRUCTURE (the pinning mechanism itself failed).
 */
export class PinUnavailableError extends Error {
  constructor(
    readonly failure: Exclude<PinFailure, 'NOT_FOUND'>,
    readonly win32Error?: number,
    message?: string,
  ) {
    super(message ?? `process-instance pin unavailable (${failure}${win32Error !== undefined ? `; win32=${win32Error}` : ''})`);
    this.name = 'PinUnavailableError';
  }
}

/**
 * A pinned process instance: an OS-level reference to the EXACT process
 * object that was verified. Termination through the pin can never follow
 * PID reuse — the reference is bound to the process object, not the PID.
 */
export interface PinnedProcess {
  readonly pid: number;
  /** Identity read THROUGH the pin (authoritative for the pinned object). */
  readonly name: string;
  readonly creationTime: string;
  readonly executablePath: string;
  /** Terminate the pinned instance. Resolves true only if the pinned instance exited. */
  terminate(): Promise<boolean>;
  /** Post-termination exit check for the pinned instance. null = cannot determine. */
  hasExited(): Promise<boolean | null>;
  /** Release the pin without terminating. MUST be called on every path. */
  release(): void;
}

export interface ContainmentAuditEvent {
  kind: 'threat_containment';
  /** Per-attempt identifier (metadata-only correlation). */
  requestId: string;
  outcome: ContainmentOutcome;
  reason: string;
  targetPid: number;
  targetName: string;
  targetCreationTime: string;
  classification: ContainmentClassification;
  confidence: string;
  evidenceSources: string[];
  /** Age of the classification evidence at decision time (ms). */
  evidenceAgeMs: number;
  /** E-stop state at the relevant boundary. */
  estopActive: boolean;
  /** Whether a valid approval token was validated for this attempt. */
  authorized: boolean;
  /** Whether every pre-termination gate passed (termination was eligible). */
  terminationEligible: boolean;
  terminationAttempted: boolean;
  terminationResult: 'not_attempted' | 'succeeded' | 'failed' | 'unknown';
  postVerifyResult: 'not_performed' | 'exited' | 'still_running' | 'unavailable';
  /** Approval-authority decision behind this attempt ('unavailable' | 'denied' | <method>). */
  approvalAuthority: string;
  hasApprovalToken: boolean;
  at: number;
}

export interface ContainmentDependencies {
  /**
   * INDEPENDENT approval-authority check (Phase D.4; credential-backed in
   * the Phase D completion). Decides whether a verified operator decision
   * exists for containing the process holding `pid`. This is deliberately
   * SEPARATE from HTTP permissions: holding `application.launch` (or any
   * permission) is NOT proof of operator approval. Three call shapes:
   *   - `{ pid, operatorCredential }` at APPROVAL time: verifies the
   *     operator's enrollment credential server-side (the human decision).
   *   - `{ pid }` at CONTAINMENT entry: the authority must still exist.
   *   - `{ pid, authorityEpoch }` immediately before termination: the
   *     authority must be UNCHANGED since issuance (a mid-operation loss of
   *     authorization must prevent termination).
   * When no authority exists (production default before operator
   * enrollment), the wiring returns `authorized: false, unavailable: true`
   * and termination is unreachable. Throws only on infrastructure failure
   * (treated as unavailable — fail-closed).
   */
  verifyApprovalAuthority(input: { pid: number; operatorCredential?: string; authorityEpoch?: number }): ApprovalAuthorityResult | Promise<ApprovalAuthorityResult>;
  /**
   * Read the identity of the process currently holding `pid` WITHOUT
   * retaining a reference (approval-time read). Returns null when no such
   * process exists. Throws on infrastructure failure.
   */
  readProcessIdentity(pid: number): Promise<ProcessIdentity | null>;
  /**
   * Pin the process instance currently holding `pid`. Identity is read
   * THROUGH the pin. Returns null when no such process exists; throws
   * PinUnavailableError when a terminate-capable reference cannot be
   * established.
   */
  pinProcess(pid: number): Promise<PinnedProcess | null>;
  /** Check whether the emergency stop is active (E5 authoritative). */
  isStopActive(): boolean;
  /**
   * Server-side classification (Phase B engine). Returns null when the
   * assessment could not complete — containment fails closed.
   */
  classify(executablePath: string): Promise<ClassificationEvidence | null>;
  /** Audit sink (E5 chain). Metadata-only. */
  audit(event: ContainmentAuditEvent): void;
}
