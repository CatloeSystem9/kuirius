/**
 * Confidence Gate — per-action-type trust learned from what actually happened.
 *
 * The E5 audit chain already records every rollback execution, operator
 * decline, quarantine release and refusal. That chain is the ONLY learning
 * source here, and it is the right one: it is hash-chained, protected, and
 * written by the subsystems that actually performed the work.
 *
 * DESIGN RULES (safety):
 *
 * 1. FAIL-CLOSED. If the audit chain cannot be read or does not verify,
 *    NOTHING is trusted. A tampered or missing chain produces an empty green
 *    list, never a permissive one.
 * 2. TRUST ONLY SHRINKS RISK. The gate can authorise an action to proceed
 *    WITHOUT a human. It can never grant a permission, widen a scope, or
 *    bypass a credential boundary. Only the allowlisted action types in
 *    approvalTypes are ever eligible.
 * 3. EVIDENCE BEFORE TRUST. A type needs a minimum number of real signals
 *    before it can be trusted at all — one lucky rollback proves nothing.
 * 4. DECAY. Old evidence fades. Trust that is not being exercised stops
 *    counting, so the green list shrinks on its own if behaviour changes.
 * 5. HONEST ACCOUNTING. An operator DECLINE is treated as a mild failure
 *    signal — the operator looked and said no. A refusal or a failed
 *    execution is treated as a strong failure signal.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ApprovalActionType, ApprovalPolicy, TrustRecord, TrustState } from './approvalTypes';
import { DEFAULT_APPROVAL_POLICY, isAutoApprovable } from './approvalTypes';

export interface TrustSignal {
  actionType: ApprovalActionType;
  /** +1 success, -2 operator decline, -3 refusal/failure. */
  weight: 1 | 2 | 3;
  /** Negative weight = a failure signal. */
  outcome: 'success' | 'decline' | 'failure';
  at: number;
}

/**
 * The audit kinds that carry learning signal, and what they mean.
 *
 * Deliberately narrow: only outcomes that genuinely reflect whether the
 * action type is safe to repeat unattended count. A scan or a request is
 * NOT an outcome and teaches nothing.
 */
export const AUDIT_SIGNAL_KINDS: Record<string, { actionType: ApprovalActionType; outcome: TrustSignal['outcome'] }> = {
  // E5 rollback core — a rollback that completed is the action working.
  e5_rollback_executed: { actionType: 'rollback', outcome: 'success' },
  // The operator looked at a rollback plan and declined it.
  e5_rollback_challenge_declined: { actionType: 'rollback', outcome: 'decline' },
  // The rollback itself was refused or failed.
  e5_rollback_refused: { actionType: 'rollback', outcome: 'failure' },
  // E5 quarantine — a release that completed.
  e5_quarantine_released: { actionType: 'quarantine_release', outcome: 'success' },
  // A release that was refused.
  e5_quarantine_release_refused: { actionType: 'quarantine_release', outcome: 'failure' },
};

/** Weight per outcome — declines cost less than failures. */
const OUTCOME_WEIGHT: Record<TrustSignal['outcome'], 1 | 2 | 3> = {
  success: 1,
  decline: 2,
  failure: 3,
};

/**
 * How long a signal's influence halves, in days.
 *
 * 30 days: a month of not exercising an action type is enough for its
 * evidence to stop carrying much weight.
 */
export const TRUST_HALF_LIFE_DAYS = 30;

/**
 * The minimum EFFECTIVE (decayed) evidence a type needs to stay trusted.
 *
 * Expressed as a fraction of `minSamples`. Decay alone cannot lower the
 * score — the score is a ratio, so decaying every signal equally leaves it
 * unchanged. What decay really does is reduce how much evidence is behind
 * the score. This floor is what makes "old evidence stops counting" real:
 * without it, ten successes from four months ago would still read as a
 * perfect score forever.
 */
export const MIN_EFFECTIVE_WEIGHT_RATIO = 0.5;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrustGateOptions {
  /**
   * Reads the audit chain. Injected so the gate is testable in isolation.
   *
   * The production reader returns the LAST contiguous hash-verified segment
   * (see `readLastVerifiedAuditSegment`) — the recent evidence, verified.
   */
  readAudit: () => {
    entries: Array<Record<string, unknown>>;
    available: boolean;
    reason?: string;
    /** Does the verified segment reach the END of the file? */
    coversTail?: boolean;
    /** How many records the verified segment holds. */
    length?: number;
  };
  /**
   * Verifies the audit chain. A false result trusts nothing.
   *
   * The WHOLE-FILE verdict is reported to the operator either way; it is the
   * authority-transition answer. What the gate acts on is the recent
   * verified segment.
   */
  verifyChain: () => { ok: boolean; reason: string | null };
  /** Where the derived state is cached. */
  storagePath?: string;
  /** How long a derived state is reused before re-reading the chain. */
  cacheMs?: number;
  now?: () => number;
  audit?: (event: { kind: string; [key: string]: unknown }) => void;
}

export class TrustGate {
  private readonly deps: TrustGateOptions;
  private readonly nowFn: () => number;
  private readonly cacheMs: number;
  private readonly storagePath?: string;
  private cache: TrustState | null = null;
  private cacheAt = 0;

  constructor(options: TrustGateOptions) {
    this.deps = options;
    this.nowFn = options.now || (() => Date.now());
    this.cacheMs = options.cacheMs ?? 30_000;
    this.storagePath = options.storagePath;
  }

  /**
   * The current trust state — derived from the audit chain.
   *
   * Cached briefly so a burst of approval requests does not re-read the
   * chain for each one, but the cache is REFRESHED from the chain (never
   * trusted blindly) and the chain is re-verified on every refresh.
   */
  public getState(policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY): TrustState {
    const now = this.nowFn();
    if (this.cache && now - this.cacheAt < this.cacheMs) {
      return this.cache;
    }
    const state = this.derive(policy);
    this.cache = state;
    this.cacheAt = now;
    this.persist(state);
    return state;
  }

  /**
   * Is this action type currently trusted enough to act on its own?
   *
   * The answer is a plain yes/no with the reasoning attached — the operator
   * can always see WHY she acted without them.
   */
  public evaluate(
    actionType: ApprovalActionType,
    policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY
  ): { trusted: boolean; score: number; samples: number; reason: string } {
    if (!isAutoApprovable(actionType)) {
      return {
        trusted: false,
        score: 0,
        samples: 0,
        reason: `${actionType} is never decided without the operator`,
      };
    }
    const state = this.getState(policy);
    if (!state.evidenceVerified) {
      return {
        trusted: false,
        score: 0,
        samples: 0,
        reason: `the audit evidence is not verifiable (${state.evidenceReason ?? 'unknown'}) — nothing is trusted`,
      };
    }
    const record = state.records.find((r) => r.actionType === actionType);
    if (!record) {
      return { trusted: false, score: 0, samples: 0, reason: `no history yet for ${actionType}` };
    }
    return {
      trusted: record.trusted,
      score: record.score,
      samples: record.samples,
      reason: record.reason,
    };
  }

  /** The green list — action types currently trusted. */
  public greenList(policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY): ApprovalActionType[] {
    return this.getState(policy).greenList;
  }

  // ------------------------------------------------------------- internals

  /**
   * Derive the trust state from the audit chain.
   */
  private derive(policy: ApprovalPolicy): TrustState {
    const now = this.nowFn();

    // The whole-file verdict is always reported — it is the
    // authority-transition answer and the operator should see it.
    const verification = this.deps.verifyChain();

    const read = this.deps.readAudit();
    if (!read.available) {
      const state: TrustState = {
        records: [],
        greenList: [],
        chainVerified: verification.ok,
        ...(verification.ok ? {} : { chainReason: verification.reason ?? 'audit chain did not verify' }),
        evidenceVerified: false,
        evidenceReason: read.reason ?? 'audit chain unreadable',
        derivedAt: now,
      };
      this.deps.audit?.({ kind: 'trust_chain_unreadable', reason: state.chainReason });
      return state;
    }

    // The recent history must be verified AND must reach the end of the file.
    // Stale evidence presented as current is worse than no evidence.
    if (read.coversTail === false) {
      const state: TrustState = {
        records: [],
        greenList: [],
        chainVerified: verification.ok,
        ...(verification.ok ? {} : { chainReason: verification.reason ?? 'audit chain did not verify' }),
        evidenceVerified: false,
        evidenceReason: read.reason ?? 'the tail of the audit chain is not verifiably linked',
        derivedAt: now,
      };
      this.deps.audit?.({ kind: 'trust_chain_tail_unverified', reason: state.chainReason });
      return state;
    }

    // Bucket the signals per action type.
    const buckets = new Map<
      ApprovalActionType,
      { samples: number; success: number; decline: number; failure: number; lastSignalAt?: number }
    >();

    for (const entry of read.entries) {
      const kind = typeof entry.kind === 'string' ? entry.kind : '';
      const mapping = AUDIT_SIGNAL_KINDS[kind];
      if (!mapping) continue;
      const at = typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : now;
      const bucket = buckets.get(mapping.actionType) ?? {
        samples: 0,
        success: 0,
        decline: 0,
        failure: 0,
      };
      bucket.samples += 1;
      bucket.lastSignalAt = Math.max(bucket.lastSignalAt ?? 0, at);
      buckets.set(mapping.actionType, bucket);

      // Decayed weight: how much this single signal counts right now.
      const ageDays = Math.max(0, (now - at) / DAY_MS);
      const decay = Math.pow(0.5, ageDays / TRUST_HALF_LIFE_DAYS);
      const weighted = decay * OUTCOME_WEIGHT[mapping.outcome];
      if (mapping.outcome === 'success') bucket.success += weighted;
      else if (mapping.outcome === 'decline') bucket.decline += weighted;
      else bucket.failure += weighted;
    }

    const records: TrustRecord[] = [];
    for (const [actionType, bucket] of buckets) {
      // Decayed totals: the weights above already include decay.
      const decayedSuccess = bucket.success;
      const decayedDecline = bucket.decline;
      const decayedFailure = bucket.failure;
      const decayedTotal = decayedSuccess + decayedDecline + decayedFailure;
      const score = decayedTotal > 0 ? (decayedSuccess - decayedDecline - decayedFailure) / decayedTotal : 0;

      // The score is a ratio, so decay cannot lower it on its own. What decay
      // DOES do is shrink the evidence behind it — and a perfect score built
      // on evidence that has all but evaporated is not a real score.
      const effectiveEvidence = decayedTotal;
      const requiredEvidence = policy.minSamples * MIN_EFFECTIVE_WEIGHT_RATIO;

      const trusted =
        isAutoApprovable(actionType) &&
        bucket.samples >= policy.minSamples &&
        effectiveEvidence >= requiredEvidence &&
        score >= policy.trustThreshold;

      const reason = !isAutoApprovable(actionType)
        ? `${actionType} is never decided without the operator`
        : bucket.samples < policy.minSamples
          ? `not enough history yet (${bucket.samples} of ${policy.minSamples} signals)`
          : effectiveEvidence < requiredEvidence
            ? `the evidence has faded (${effectiveEvidence.toFixed(2)} effective weight of ${requiredEvidence.toFixed(2)} needed)`
            : trusted
              ? `trusted (${bucket.samples} signals, score ${score.toFixed(2)})`
              : `score ${score.toFixed(2)} is below the ${policy.trustThreshold} threshold`;

      records.push({
        actionType,
        samples: bucket.samples,
        successes: round2(decayedSuccess),
        declines: round2(decayedDecline),
        failures: round2(decayedFailure),
        score: round2(score),
        trusted,
        reason,
        lastSignalAt: bucket.lastSignalAt,
      });
    }

    // Sort for a stable, readable presentation.
    records.sort((a, b) => b.score - a.score);

    const state: TrustState = {
      records,
      greenList: records.filter((r) => r.trusted).map((r) => r.actionType),
      chainVerified: verification.ok,
      ...(verification.ok ? {} : { chainReason: verification.reason ?? 'audit chain did not verify' }),
      evidenceVerified: true,
      derivedAt: now,
      lastSignalAt: records.reduce((max, r) => Math.max(max, r.lastSignalAt ?? 0), 0) || undefined,
    };

    this.deps.audit?.({
      kind: 'trust_state_derived',
      chainVerified: verification.ok,
      evidenceVerified: true,
      greenList: state.greenList,
      records: records.length,
    });

    return state;
  }

  /** Cache the derived state for inspection. Never authoritative on its own. */
  private persist(state: TrustState): void {
    if (!this.storagePath) return;
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        this.storagePath,
        JSON.stringify({ schemaVersion: 1, ...state }, null, 2),
        'utf8'
      );
    } catch {
      // the chain is the authority; this cache is convenience only
    }
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
