/**
 * Approval Registry — one place where every operator decision lives.
 *
 * The subsystems that need an operator (Phase C execution gate, the E5
 * rollback core, the E5 quarantine, the LPV vault, Phase D containment) each
 * keep their OWN challenge state and their OWN authority. This registry does
 * NOT replace any of them. It:
 *
 *   1. mirrors their challenges into ONE list, so a single surface (the
 *      browser card or the Windows toast) can present all of them;
 *   2. carries the decision back to the owning subsystem;
 *   3. applies the confidence-gated autonomy policy (act alone when the
 *      operator is away and the action type is proven safe).
 *
 * THE DECISION CAPABILITY
 *
 * Every request gets a random `capability`. It is delivered ONLY through
 * the operator-facing pending listing, and a decision must present it. This
 * is the same doctrine the LPV vault enforces with its one-time decision
 * token: a blind approve(id) that never surfaced the request to a human is
 * refused. The capability travels inside the toast's protocol URI, so only
 * the operator who saw the toast can act on it.
 *
 * FAIL-CLOSED
 *
 * A decision is refused — never faked — when the request is unknown, already
 * decided, expired, was never surfaced, or arrives without a matching
 * capability. Auto-decision is only ever attempted for the small allowlist of
 * auto-approvable action types, and only when the confidence gate says the
 * type is proven safe.
 */
import * as crypto from 'crypto';
import type {
  ApprovalActionType,
  ApprovalBackendKind,
  ApprovalDecision,
  ApprovalDecisionResult,
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalRequestView,
  ApprovalRisk,
  ApprovalState,
  ApprovalSurface,
  TrustRecord,
} from './approvalTypes';
import {
  APPROVAL_REQUEST_TTL_MS,
  DEFAULT_APPROVAL_POLICY,
  MAX_PENDING_APPROVALS,
  isAutoApprovable,
} from './approvalTypes';
import { TrustGate } from './trustGate';
import { PresenceTracker, evaluatePolicy } from './policy';

/** What a backend does when the operator approves or denies. */
export interface ApprovalBackendOutcome {
  ok: boolean;
  reason: string;
  /** A token minted by the backend (the exec gate's single-use launch approval). */
  issuedToken?: string;
  /** Backend-specific outcome details. */
  result?: Record<string, unknown>;
}

/** What a backend does when the operator approves or denies. */
export interface ApprovalBackend {
  /** Apply the approval. May mint a token (exec gate launch approval). */
  approve(request: ApprovalRequest): Promise<ApprovalBackendOutcome> | ApprovalBackendOutcome;
  /** Apply the denial. */
  decline(request: ApprovalRequest): Promise<ApprovalBackendOutcome> | ApprovalBackendOutcome;
}

export interface ApprovalRegistryOptions {
  /** Backend adapters, keyed by the subsystem that owns the request. */
  backends: Partial<Record<ApprovalBackendKind, ApprovalBackend>>;
  /** The confidence gate (per-action-type trust). */
  trust: TrustGate;
  /** Presence tracker (is the operator reachable). */
  presence: PresenceTracker;
  getPolicy?: () => ApprovalPolicy;
  now?: () => number;
  /** Audit sink — every state change is audited. */
  audit?: (event: { kind: string; [key: string]: unknown }) => void;
  /** Called when a request needs to be shown to the operator. */
  onSurface?: (request: ApprovalRequest) => void;
}

export interface RaiseApprovalInput {
  actionType: ApprovalActionType;
  title: string;
  detail: string;
  risk: ApprovalRisk;
  backend: { kind: ApprovalBackendKind; ref: string; extra?: Record<string, unknown> };
  /** Overrides the default TTL. */
  ttlMs?: number;
}

export class ApprovalRegistry {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly capabilities = new Map<string, string>();
  private readonly deps: ApprovalRegistryOptions;
  private readonly nowFn: () => number;

  constructor(options: ApprovalRegistryOptions) {
    this.deps = options;
    this.nowFn = options.now || (() => Date.now());
  }

  /**
   * Raise a request for operator approval.
   *
   * The confidence-gated autonomy policy runs HERE, at raise time: if the
   * operator is away and the action type is trusted, the request is decided
   * immediately and the backend is told — no human is interrupted. Otherwise
   * it stays pending for a surface to present.
   */
  public async raise(input: RaiseApprovalInput): Promise<ApprovalRequest> {
    const now = this.nowFn();
    const policy = this.policy();
    const request: ApprovalRequest = {
      id: `apr_${now.toString(36)}_${crypto.randomBytes(6).toString('hex')}`,
      actionType: input.actionType,
      title: input.title,
      detail: input.detail,
      risk: input.risk,
      backend: input.backend,
      createdAt: now,
      expiresAt: now + (input.ttlMs ?? APPROVAL_REQUEST_TTL_MS),
      state: 'pending',
      surfaced: {},
    };

    // The capability is generated here and released ONLY through the
    // operator-facing pending listing.
    this.capabilities.set(request.id, crypto.randomBytes(16).toString('hex'));

    this.requests.set(request.id, request);
    this.sweep();
    this.deps.audit?.({
      kind: 'approval_requested',
      id: request.id,
      actionType: input.actionType,
      backend: input.backend.kind,
      risk: input.risk,
    });

    // Confidence-gated autonomy.
    const trust = this.deps.trust.evaluate(input.actionType, policy);
    const decision = evaluatePolicy(
      {
        actionType: input.actionType,
        operatorPresent: this.deps.presence.isPresent(),
        trust,
      },
      policy
    );

    if (decision.outcome === 'auto_approve') {
      await this.applyAuto(request, 'approve', decision.reason);
      return request;
    }
    if (decision.outcome === 'auto_deny') {
      await this.applyAuto(request, 'deny', decision.reason);
      return request;
    }

    // Needs a human — present it.
    try {
      this.deps.onSurface?.(request);
    } catch (err) {
      console.warn('[ApprovalRegistry] Surface notification failed:', err);
    }
    return request;
  }

  /**
   * Record that a request was actually shown to the operator.
   *
   * Surfaces report this honestly. The browser card and the Windows toast
   * both call it — the server does not assume a request was seen.
   */
  public markSurfaced(id: string, via: ApprovalSurface): boolean {
    const request = this.requests.get(id);
    if (!request) return false;
    if (request.state !== 'pending') return false;
    request.surfaced = { at: this.nowFn(), via };
    this.deps.audit?.({ kind: 'approval_surfaced', id, via, actionType: request.actionType });
    return true;
  }

  /**
   * Record a decision from a surface.
   *
   * `capability` must match the one released with the pending listing. A
   * decision without it is refused — the blind-approve guard.
   */
  public async decide(
    id: string,
    decision: ApprovalDecision,
    via: ApprovalSurface,
    capability: string | undefined,
    reason?: string
  ): Promise<ApprovalDecisionResult> {
    const request = this.requests.get(id);
    if (!request) {
      return { ok: false, reason: 'unknown approval request' };
    }
    if (request.state !== 'pending') {
      return { ok: false, reason: `request is ${request.state} — already decided`, request: this.toView(request) };
    }
    if (this.nowFn() > request.expiresAt) {
      request.state = 'expired';
      this.deps.audit?.({ kind: 'approval_expired', id, actionType: request.actionType });
      return { ok: false, reason: 'the request expired before it was decided', request: this.toView(request) };
    }
    if (!request.surfaced.at) {
      // Never shown to a human -> a decision cannot be legitimate.
      this.deps.audit?.({ kind: 'approval_decision_refused', id, reason: 'never surfaced' });
      return { ok: false, reason: 'this request was never shown to the operator', request: this.toView(request) };
    }

    const expected = this.capabilities.get(id);
    if (!expected || !capability || !timingSafeEqual(expected, capability)) {
      this.deps.audit?.({ kind: 'approval_decision_refused', id, reason: 'capability mismatch' });
      return { ok: false, reason: 'invalid decision capability', request: this.toView(request) };
    }

    // A decision from a surface is always a real decision — auto-decision
    // already happened at raise time and would not be pending.
    request.state = decision === 'approve' ? 'approved' : 'denied';
    request.decision = { decision, at: this.nowFn(), via, ...(reason ? { reason } : {}) };
    this.capabilities.delete(id);

    const backend = this.deps.backends[request.backend.kind];
    if (!backend) {
      request.state = 'pending';
      this.deps.audit?.({ kind: 'approval_decision_refused', id, reason: 'no backend adapter' });
      return { ok: false, reason: `no backend adapter for ${request.backend.kind}`, request: this.toView(request) };
    }

    try {
      const outcome =
        decision === 'approve'
          ? await backend.approve(request)
          : await backend.decline(request);
      request.result = outcome.result ?? { reason: outcome.reason };
      if (outcome.issuedToken) request.issuedToken = outcome.issuedToken;
      this.deps.audit?.({
        kind: decision === 'approve' ? 'approval_granted' : 'approval_denied',
        id,
        actionType: request.actionType,
        via,
        ok: outcome.ok,
        reason: outcome.reason,
      });
      return {
        ok: outcome.ok,
        reason: outcome.reason,
        request: this.toView(request),
      };
    } catch (err: any) {
      const message = err?.message || String(err);
      this.deps.audit?.({ kind: 'approval_backend_error', id, actionType: request.actionType, reason: message });
      return { ok: false, reason: message, request: this.toView(request) };
    }
  }

  /**
   * The operator-facing pending listing.
   *
   * This is the ONLY place the decision capability is released — exactly like
   * the LPV vault's pending listing releases its decision token.
   */
  public pending(): Array<ApprovalRequestView & { capability: string }> {
    this.sweep();
    const out: Array<ApprovalRequestView & { capability: string }> = [];
    for (const request of this.requests.values()) {
      if (request.state !== 'pending') continue;
      const capability = this.capabilities.get(request.id);
      if (!capability) continue;
      out.push({ ...this.toView(request), capability });
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  /** Everything, including decided requests (diagnostics). */
  public list(): ApprovalRequestView[] {
    return Array.from(this.requests.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => this.toView(r));
  }

  /** The current trust state and green list. */
  public trustState(): {
    records: TrustRecord[];
    greenList: ApprovalActionType[];
    chainVerified: boolean;
    chainReason?: string;
    evidenceVerified: boolean;
    evidenceReason?: string;
  } {
    const state = this.deps.trust.getState(this.policy());
    return {
      records: state.records,
      greenList: state.greenList,
      chainVerified: state.chainVerified,
      chainReason: state.chainReason,
      evidenceVerified: state.evidenceVerified,
      evidenceReason: state.evidenceReason,
    };
  }

  /** The current policy. */
  public policy(): ApprovalPolicy {
    return this.deps.getPolicy?.() ?? DEFAULT_APPROVAL_POLICY;
  }

  /** The operator's presence, as the server sees it. */
  public presenceState(): { present: boolean; lastSeenAt: number } {
    return { present: this.deps.presence.isPresent(), lastSeenAt: this.deps.presence.lastSeen() };
  }

  // ------------------------------------------------------------- internals

  /** Apply an automatic decision (confidence-gated autonomy). */
  private async applyAuto(
    request: ApprovalRequest,
    decision: ApprovalDecision,
    reason: string
  ): Promise<void> {
    request.state = decision === 'approve' ? 'auto_approved' : 'auto_denied';
    request.decision = { decision, at: this.nowFn(), via: 'auto', reason };
    this.capabilities.delete(request.id);

    const backend = this.deps.backends[request.backend.kind];
    if (!backend) {
      this.deps.audit?.({ kind: 'approval_auto_failed', id: request.id, reason: 'no backend adapter' });
      return;
    }
    try {
      const outcome =
        decision === 'approve'
          ? await backend.approve(request)
          : await backend.decline(request);
      request.result = outcome.result ?? { reason: outcome.reason };
      if (outcome.issuedToken) request.issuedToken = outcome.issuedToken;
      this.deps.audit?.({
        kind: 'approval_auto_decided',
        id: request.id,
        actionType: request.actionType,
        decision,
        ok: outcome.ok,
        reason,
      });
    } catch (err: any) {
      this.deps.audit?.({
        kind: 'approval_auto_failed',
        id: request.id,
        reason: err?.message || String(err),
      });
    }
  }

  /** Drop expired requests and bound the registry. */
  private sweep(): void {
    const now = this.nowFn();
    for (const request of this.requests.values()) {
      if (request.state === 'pending' && now > request.expiresAt) {
        request.state = 'expired';
        this.capabilities.delete(request.id);
        this.deps.audit?.({ kind: 'approval_expired', id: request.id, actionType: request.actionType });
      }
    }
    // Bound the registry: the OLDEST pending requests go first.
    const pending = Array.from(this.requests.values())
      .filter((r) => r.state === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
    if (pending.length > MAX_PENDING_APPROVALS) {
      for (const request of pending.slice(0, pending.length - MAX_PENDING_APPROVALS)) {
        request.state = 'expired';
        this.capabilities.delete(request.id);
        this.deps.audit?.({ kind: 'approval_evicted', id: request.id, actionType: request.actionType });
      }
    }
  }

  private toView(request: ApprovalRequest): ApprovalRequestView {
    return {
      id: request.id,
      actionType: request.actionType,
      title: request.title,
      detail: request.detail,
      risk: request.risk,
      state: request.state,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      surfaced: request.surfaced,
      autoApprovable: isAutoApprovable(request.actionType),
      ...(request.issuedToken ? { issuedToken: request.issuedToken } : {}),
      ...(request.result ? { result: request.result } : {}),
    };
  }
}

/** Constant-time string comparison — the capability is a secret. */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
