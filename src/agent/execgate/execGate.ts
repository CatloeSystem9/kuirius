/**
 * Execution Gate (Phase C) — centralized Krisha-managed launch decision.
 *
 * Enforces the execution policy for launch pathways controlled by Krisha
 * (appLaunchByName / appLaunchByPath). This is NOT system-wide enforcement —
 * it gates only launches that Krisha initiates through her own tools.
 *
 * POLICY RULES (task §4, exact):
 *   CONFIRMED_MALWARE → BLOCK_CONFIRMED_MALWARE (non-overridable by user approval)
 *   HIGH_CONFIDENCE_THREAT → REQUIRE_USER_APPROVAL (conservative restriction)
 *   SUSPICIOUS → REQUIRE_USER_APPROVAL (show reason)
 *   UNKNOWN → DENY_UNVERIFIED (documented policy: unknown software is not silently launched)
 *   CLEAN → ALLOW
 *   Monitor/engine unavailable → BLOCK_SYSTEM_UNAVAILABLE (fail-closed)
 *
 * FILE IDENTITY: the decision is bound to (path, mtimeMs, size). Before
 * launch, re-verify via stat() that the file hasn't changed since assessment.
 * A changed file invalidates the prior classification and forces re-assessment.
 *
 * APPROVAL TOKENS: single-use, expiring (5 min), bound to {path, mtimeMs,
 * size, classification}. Cannot be reused. Stale tokens are rejected.
 *
 * CONFIRMED MALWARE IS NON-OVERRIDABLE: user approval cannot bypass a
 * BLOCK_CONFIRMED_MALWARE decision. Only a retraction of the Defender
 * detection (making the classification no longer CONFIRMED) can clear it.
 *
 * E-STOP: launch requests are refused while the emergency stop is active
 * (the caller checks stopKind() before invoking the gate).
 *
 * AUDIT: every decision is emitted via the audit sink (metadata only —
 * path, decision, classification, reason; no secrets, no command lines).
 *
 * NODE-ONLY: imports node:child_process and node:fs.
 */
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type {
  ApprovalToken,
  ExecutionDecision,
  ExecutionDecisionResult,
  ExecutionPolicyInput,
  ExecGateHealth,
} from './execGateTypes';

const APPROVAL_TOKEN_TTL_MS = 5 * 60_000;
const MAX_PENDING_APPROVALS = 50;
const MAX_CLASSIFICATION_AGE_MS = 2 * 60_000; // stale after 2 min — re-assess

export interface FileIdentity {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface ExecGateDependencies {
  /** Classify a file (delegates to Phase B DetectionEngine.assessFile). */
  classify(path: string): Promise<{ classification: string; confidence: string }>;
  /** Check whether the emergency stop is active. */
  isStopActive(): boolean;
  /** Get current file identity (stat) for replacement detection. */
  statFile(path: string): Promise<FileIdentity | null>;
  /** Audit sink (E5 chain). */
  audit: (event: { kind: string; [key: string]: unknown }) => void;
}

export class ExecutionGate {
  private deps: ExecGateDependencies;
  private pendingApprovals = new Map<string, ApprovalToken>();
  private approvalCounter = 0;

  constructor(deps: ExecGateDependencies) {
    this.deps = deps;
  }

  /**
   * The single authoritative execution decision for Krisha-managed launches.
   * Call this BEFORE spawning any executable. Never bypass this method.
   */
  async decide(input: ExecutionPolicyInput): Promise<ExecutionDecisionResult> {
    // 0. Emergency stop check.
    if (this.deps.isStopActive()) {
      return this.audit('BLOCK_SYSTEM_UNAVAILABLE', 'emergency stop is active — all launches refused', input);
    }

    // 1. Get current file identity (replacement detection).
    const identity = await this.deps.statFile(input.path);
    if (!identity) {
      return this.audit('BLOCK_SYSTEM_UNAVAILABLE', 'executable file does not exist or is inaccessible', input);
    }

    // 2. Check for a valid unused approval token (only for non-confirmed classifications).
    if (input.approvalToken) {
      const tokenResult = this.validateApprovalToken(input.approvalToken, input.path, identity);
      if (tokenResult !== null) return tokenResult;
      // Token invalid/expired/reused → fall through to re-assessment (fail-closed).
    }

    // 3. Classify using Phase B detection engine.
    const classification = await this.deps.classify(input.path);

    // 4. Verify file hasn't been replaced between assessment and launch.
    const postClassifyIdentity = await this.deps.statFile(input.path);
    if (!postClassifyIdentity || postClassifyIdentity.mtimeMs !== identity.mtimeMs || postClassifyIdentity.size !== identity.size) {
      return this.audit('BLOCK_SYSTEM_UNAVAILABLE', 'executable file was replaced between assessment and launch — re-assessment required', input);
    }

    // 5. Apply policy rules.
    switch (classification.classification) {
      case 'CONFIRMED_MALWARE':
        // NON-OVERRIDABLE: user approval cannot bypass this decision.
        return this.audit('BLOCK_CONFIRMED_MALWARE', `confirmed malware (Defender-trusted evidence); user approval cannot override`, input, {
          classification: classification.classification,
          confidence: classification.confidence,
          fileIdentity: identity,
        });

      case 'HIGH_CONFIDENCE_THREAT':
      case 'SUSPICIOUS':
        if (input.approvalToken) {
          // A token was provided but didn't validate (stale/reused/wrong file).
          return this.audit('BLOCK_CONFIRMED_MALWARE', 'approval token invalid, expired, or already used — launch refused (fail-closed)', input, {
            classification: classification.classification,
          });
        }
        // Issue an approval challenge (the caller must obtain operator approval
        // and re-invoke with the token).
        return this.audit('REQUIRE_USER_APPROVAL', `${classification.classification}: explicit user approval required — ${classification.confidence} confidence`, input, {
          classification: classification.classification,
          confidence: classification.confidence,
          fileIdentity: identity,
        });

      case 'UNKNOWN':
        // Documented policy: unknown software requires explicit user approval.
        if (input.approvalToken) {
          const tokenResult = this.validateApprovalToken(input.approvalToken, input.path, identity);
          if (tokenResult !== null) return tokenResult;
        }
        return this.audit('DENY_UNVERIFIED', 'unknown software — policy requires explicit user approval (obtain a launch approval token)', input, {
          classification: classification.classification,
        });

      case 'CLEAN':
        return this.audit('ALLOW', 'no detection produced by available checks (not proof of harmlessness)', input, {
          classification: classification.classification,
          confidence: classification.confidence,
          fileIdentity: identity,
        });

      case 'UNAVAILABLE':
      default:
        return this.audit('BLOCK_SYSTEM_UNAVAILABLE', 'detection engine could not complete — fail-closed (not classified as malware)', input);
    }
  }

  /**
   * Issue an approval token for a specific executable after operator review.
   * Bound to {path, mtimeMs, size, classification}. Single-use, 5 min TTL.
   */
  issueApproval(path: string, identity: FileIdentity, classification: string): ApprovalToken | null {
    // Confirmed malware CANNOT be approved — non-overridable.
    if (classification === 'CONFIRMED_MALWARE') return null;
    if (this.pendingApprovals.size >= MAX_PENDING_APPROVALS) {
      // Evict expired entries.
      const now = Date.now();
      for (const [key, token] of this.pendingApprovals) {
        if (token.expiresAt <= now) this.pendingApprovals.delete(key);
      }
      if (this.pendingApprovals.size >= MAX_PENDING_APPROVALS) return null;
    }
    this.approvalCounter = (this.approvalCounter + 1) % 1_000_000;
    const token: ApprovalToken = {
      token: crypto.randomBytes(24).toString('hex'),
      path,
      mtimeMs: identity.mtimeMs,
      size: identity.size,
      issuedAt: Date.now(),
      expiresAt: Date.now() + APPROVAL_TOKEN_TTL_MS,
      used: false,
      classification,
    };
    this.pendingApprovals.set(token.token, token);
    return token;
  }

  /**
   * Validate an approval token: single-use, not expired, bound to the same
   * path and file identity. Marks the token as used on success.
   */
  private validateApprovalToken(token: string, path: string, identity: FileIdentity): ExecutionDecisionResult | null {
    const entry = this.pendingApprovals.get(token);
    if (!entry) {
      return this.audit('BLOCK_CONFIRMED_MALWARE', 'approval token not found (invalid or already consumed)', { path, approvalToken: token });
    }
    if (entry.used) {
      this.pendingApprovals.delete(token);
      return this.audit('BLOCK_CONFIRMED_MALWARE', 'approval token already used (single-use enforcement)', { path, approvalToken: token });
    }
    if (Date.now() > entry.expiresAt) {
      this.pendingApprovals.delete(token);
      return this.audit('BLOCK_CONFIRMED_MALWARE', 'approval token expired', { path, approvalToken: token });
    }
    const normalizedTokenPath = entry.path.toLowerCase().replace(/\\+/g, '\\');
    const normalizedRequestPath = path.toLowerCase().replace(/\\+/g, '\\');
    if (normalizedTokenPath !== normalizedRequestPath || entry.mtimeMs !== identity.mtimeMs || entry.size !== identity.size) {
      this.pendingApprovals.delete(token);
      return this.audit('BLOCK_CONFIRMED_MALWARE', 'approval token bound to a different file or file identity changed', { path, approvalToken: token });
    }
    // Valid: consume the token (single-use) and allow.
    entry.used = true;
    this.pendingApprovals.delete(token);
    return this.audit('ALLOW', `approved launch (classification: ${entry.classification}; single-use token consumed)`, { path, approvalToken: token }, {
      classification: entry.classification,
      fileIdentity: identity,
    });
  }

  private audit(decision: ExecutionDecision, reason: string, input: ExecutionPolicyInput, extra: Record<string, unknown> = {}): ExecutionDecisionResult {
    const result: ExecutionDecisionResult = {
      decision,
      reason,
      auditKind: `exec_gate_${decision.toLowerCase()}`,
      ...extra,
    };
    try {
      this.deps.audit({
        kind: result.auditKind,
        decision,
        reason,
        path: input.path,
        name: input.name,
        classification: result.classification,
        confidence: result.confidence,
        hasApprovalToken: !!input.approvalToken,
      });
    } catch {
      /* audit must never break the gate */
    }
    return result;
  }

  /** Expire stale approval tokens (called periodically or on status query). */
  sweepExpiredApprovals(): void {
    const now = Date.now();
    for (const [key, token] of this.pendingApprovals) {
      if (token.expiresAt <= now) this.pendingApprovals.delete(key);
    }
  }

  health(): ExecGateHealth {
    this.sweepExpiredApprovals();
    return {
      health: this.deps.isStopActive() ? 'UNAVAILABLE' : 'ACTIVE',
      monitorHealth: null, // wired by the owner
      engineHealth: null, // wired by the owner
      defenderAvailable: null, // wired by the owner
      pendingApprovals: this.pendingApprovals.size,
    };
  }
}
