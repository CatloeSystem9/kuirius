/**
 * Approval Surface — types.
 *
 * One unified shape for every decision Krisha needs from the operator,
 * regardless of which subsystem raised it. The browser card and the Windows
 * toast are two SURFACES over the same request; the request itself is
 * server-side and owns the decision.
 *
 * What this is NOT: a second authority. Every request still routes back to
 * the subsystem that owns it (Phase C execution gate, E5 rollback core, LPV
 * vault, Phase D containment). This module only gathers them, presents them
 * somewhere the operator can see, and carries the decision back.
 */

/**
 * The kinds of action that can require an operator decision.
 *
 * `exec_launch`     — Phase C execution gate: launching SUSPICIOUS /
 *                     HIGH_CONFIDENCE_THREAT software.
 * `rollback`        — E5 rollback core: restoring a file from a journal.
 * `quarantine_release` — E5 quarantine: releasing a quarantined file.
 * `vault_retrieval` — LPV: retrieving or filling a stored secret.
 * `containment`     — Phase D: terminating a confirmed-malicious process.
 */
export type ApprovalActionType =
  | 'exec_launch'
  | 'rollback'
  | 'quarantine_release'
  | 'vault_retrieval'
  | 'containment';

/** The operator's answer. */
export type ApprovalDecision = 'approve' | 'deny';

/**
 * Where a decision came from. `auto` means no human was asked — the policy
 * gate decided (confidence-gated autonomy).
 */
export type ApprovalSurface = 'browser' | 'toast' | 'auto';

/** Which subsystem owns the request. */
export type ApprovalBackendKind = 'execgate' | 'rollback' | 'quarantine' | 'lpv' | 'containment';

/** Lifecycle of an approval request. */
export type ApprovalState =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'auto_approved'
  | 'auto_denied';

/** Risk shown on the card / toast. */
export type ApprovalRisk = 'low' | 'medium' | 'high' | 'critical';

/**
 * Action types the confidence gate is ALLOWED to decide on its own.
 *
 * This allowlist is the hard safety boundary of unattended autonomy. It is
 * deliberately tiny: only operations that restore a previously-working state
 * and have a bounded blast radius.
 *
 * NEVER auto-approvable, for reasons that are structural rather than
 * preference:
 * - `exec_launch`     — the execution gate exists to stop suspicious
 *                       software; auto-approving it would defeat the gate.
 * - `vault_retrieval` — the operator's decision is the control on secret
 *                       exposure (LPV's decision token doctrine).
 * - `containment`     — Phase D's authority is the operator CREDENTIAL, not
 *                       a click; it also has no pending-challenge surface.
 */
export const AUTO_APPROVABLE_ACTION_TYPES: readonly ApprovalActionType[] = [
  'rollback',
  'quarantine_release',
];

/** Is this action type allowed to be decided without a human? */
export function isAutoApprovable(actionType: ApprovalActionType): boolean {
  return AUTO_APPROVABLE_ACTION_TYPES.includes(actionType);
}

/** The unified request. */
export interface ApprovalRequest {
  /** Unified id — the decision key for every surface. */
  id: string;
  /** The kind of action being approved. */
  actionType: ApprovalActionType;
  /** Short headline. */
  title: string;
  /** What exactly is being approved — shown verbatim to the operator. */
  detail: string;
  /** Risk level, used for presentation and policy. */
  risk: ApprovalRisk;
  /** The owning subsystem and its handle. */
  backend: {
    kind: ApprovalBackendKind;
    /** Challenge id, plan hash, process pid, or path — backend-specific. */
    ref: string;
    /** Backend-specific extras the decision path needs. */
    extra?: Record<string, unknown>;
  };
  /** Epoch ms when the request was raised. */
  createdAt: number;
  /** Epoch ms after which the request can no longer be decided. */
  expiresAt: number;
  /** Current state. */
  state: ApprovalState;
  /**
   * Whether the request was actually shown to a human, and when.
   *
   * This is what makes a decision legitimate: a decision is only honoured
   * for a request that was genuinely SURFACED. A blind approve() for a
   * request nobody ever saw is refused — the same doctrine LPV enforces
   * with its one-time decision token.
   */
  surfaced: { at?: number; via?: ApprovalSurface };
  /** The decision, once made. */
  decision?: {
    decision: ApprovalDecision;
    at: number;
    via: ApprovalSurface;
    reason?: string;
  };
  /**
   * A token minted by the backend when the decision was 'approve' — the
   * exec gate's single-use launch approval, for example. The browser needs
   * it to complete the original operation.
   */
  issuedToken?: string;
  /** Backend-specific outcome details. */
  result?: Record<string, unknown>;
}

/** A request as seen by a surface (browser card or toast). */
export interface ApprovalRequestView {
  id: string;
  actionType: ApprovalActionType;
  title: string;
  detail: string;
  risk: ApprovalRisk;
  state: ApprovalState;
  createdAt: number;
  expiresAt: number;
  surfaced: { at?: number; via?: ApprovalSurface };
  /** True when this action type may ever be auto-decided. */
  autoApprovable: boolean;
  /** The decision token when the backend issued one. */
  issuedToken?: string;
  result?: Record<string, unknown>;
}

/** The result of a decision attempt. */
export interface ApprovalDecisionResult {
  ok: boolean;
  /** What happened, in honest language. */
  reason: string;
  request?: ApprovalRequestView;
}

/**
 * Per-action-type trust, derived from what actually happened.
 *
 * `score` is a decayed weighted average in [-3, 1]:
 *   success  = +1, operator decline = -2, refusal/failure = -3.
 * A high score means this kind of action has repeatedly worked out.
 */
export interface TrustRecord {
  actionType: ApprovalActionType;
  /** Raw signal count — the evidence base, undecayed. */
  samples: number;
  /** Successful completions (decayed weight). */
  successes: number;
  /** Times the operator declined (decayed weight). */
  declines: number;
  /** Times the operation was refused or failed (decayed weight). */
  failures: number;
  /** Decayed weighted score in [-3, 1]. */
  score: number;
  /** Whether this action type is currently on the green list. */
  trusted: boolean;
  /** Why it is or is not trusted — shown to the operator. */
  reason: string;
  /** Epoch ms of the most recent signal. */
  lastSignalAt?: number;
}

/** The learned trust state for every action type. */
export interface TrustState {
  records: TrustRecord[];
  /** The green list — action types currently trusted. */
  greenList: ApprovalActionType[];
  /**
   * Whether the WHOLE audit file verifies end to end.
   *
   * This is the authority-transition verdict. It can be false while the
   * evidence below is fine — an old discontinuity in the file does not
   * invalidate the current tail — and the operator is told either way.
   */
  chainVerified: boolean;
  /** Why the whole file does not verify, when it does not. */
  chainReason?: string;
  /**
   * Whether the EVIDENCE the gate acts on — the last contiguous,
   * hash-verified segment reaching the end of the file — is intact.
   *
   * Trust requires this. A broken tail teaches nothing.
   */
  evidenceVerified: boolean;
  /** Why the evidence is not usable, when it is not. */
  evidenceReason?: string;
  /** Epoch ms when this state was derived. */
  derivedAt: number;
  /** Epoch ms of the most recent learning signal seen. */
  lastSignalAt?: number;
}

/** The policy that decides ask-vs-auto. */
export interface ApprovalPolicy {
  /**
   * `always_ask`      — never decide without the operator.
   * `auto_when_trusted` — decide on your own ONLY for green-listed action
   *                      types, and ONLY while the operator is away.
   * `never_auto`       — always ask (same as always_ask, kept for clarity).
   */
  mode: 'always_ask' | 'auto_when_trusted' | 'never_auto';
  /**
   * When the operator is PRESENT, always ask — never auto-decide, even for
   * a trusted action type. Presence means an open, live client.
   */
  askWhenPresent: boolean;
  /**
   * When the operator is AWAY, auto-decide trusted action types (subject to
   * `mode`).
   */
  autoWhenAway: boolean;
  /** Score a type must reach to be trusted. */
  trustThreshold: number;
  /** Minimum signals before a type may be trusted at all. */
  minSamples: number;
}

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  mode: 'auto_when_trusted',
  askWhenPresent: true,
  autoWhenAway: true,
  trustThreshold: 0.6,
  minSamples: 5,
};

/** Clamp a possibly-untrusted policy object into a valid one. */
export function sanitizePolicy(raw: unknown): ApprovalPolicy {
  const base = DEFAULT_APPROVAL_POLICY;
  if (!raw || typeof raw !== 'object') return { ...base };
  const r = raw as Record<string, unknown>;
  const mode =
    r.mode === 'always_ask' || r.mode === 'auto_when_trusted' || r.mode === 'never_auto'
      ? r.mode
      : base.mode;
  const clamp01 = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
  const clampInt = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v)
      ? Math.max(min, Math.min(max, Math.floor(v)))
      : fallback;
  return {
    mode,
    askWhenPresent: typeof r.askWhenPresent === 'boolean' ? r.askWhenPresent : base.askWhenPresent,
    autoWhenAway: typeof r.autoWhenAway === 'boolean' ? r.autoWhenAway : base.autoWhenAway,
    trustThreshold: clamp01(r.trustThreshold, base.trustThreshold),
    minSamples: clampInt(r.minSamples, 1, 1000, base.minSamples),
  };
}

/**
 * How long an approval request stays decidable.
 *
 * The exec gate's own approval token lives 5 minutes; the rollback
 * challenge 10; the LPV challenge its own TTL. The unified request uses the
 * SHORTEST of those semantics — an approval request that outlives the
 * underlying token would be a promise the backend cannot keep.
 */
export const APPROVAL_REQUEST_TTL_MS = 5 * 60 * 1000;

/** Bounded registry size — the oldest pending request is evicted first. */
export const MAX_PENDING_APPROVALS = 32;
