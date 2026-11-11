/**
 * E5 M3 — Rollback: server-generated plans, operator-bound challenges,
 * conservative execution over M2 sandbox primitives.
 *
 * Architecture:
 *   - A rollback unit is ONE journal operation (server-minted opId). Plans
 *     identify the exact journal records involved, the affected paths, the
 *     intended inverse, the recorded identities, the stop generation, and a
 *     hash of the exact journal bytes — bound together by a deterministic
 *     plan hash. Plans live SERVER-SIDE ONLY; clients pass opaque ids and
 *     can never supply paths, identities, journal entries or plan content.
 *   - The model may REQUEST a plan. Approval exists ONLY through the Krisha
 *     UI affordance (POST /api/rollback/approve); there is no model-callable
 *     approval tool and no client-side boolean can approve.
 *   - Challenges are single-use, consumed at execution start, expire after
 *     10 minutes, and are invalidated by ANY journal change or stop-generation
 *     change. Retry requires a fresh plan and a fresh challenge.
 *   - Execution re-validates everything at the entry boundary and refuses
 *     conservatively on any inconsistency (data preserved, reason journaled).
 *
 * Honest boundaries (do not weaken these disclosures):
 *   - The challenge excludes the MODEL (no tool/page path can approve) but
 *     does NOT authenticate against a determined same-user local process,
 *     which can call the loopback HTTP API directly. That adversary class
 *     remains an accepted, disclosed boundary.
 *   - This is NOT historical restoration: restored content is what Krisha
 *     verified via two agreeing full reads of the quarantine source; it may
 *     not correspond to any single historical version.
 *   - In degraded storage mode the journal is not model-immutable — it can
 *     never authorize destructive rollback.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getStorageInfo, stopKind, stopSnapshot, appendAuditSyncSafe } from './serverSafety';
import {
  readJournalEntries, appendJournalEntry, journalIntegrityCheck,
  captureIdentity, identityMatches, FileIdentity, SandboxJournalEntry,
  sandboxDelete, sandboxMove, DeleteCaptureHook,
  assertSandboxMutation, E1_CONTRACT,
} from './sandboxCore';
import { verifyAuditChain } from './serverSafety';
import * as quarantine from './quarantineCore';

const PLAN_SCHEMA_VERSION = 1;
const CHALLENGE_TTL_MS = 10 * 60_000;
const MAX_STORED_PLANS = 16;
const MAX_PENDING_CHALLENGES = 16;
const STRICT_TOLERANCE_MS = 2;

// ---------------------------------------------------------------------------
// Plan model
// ---------------------------------------------------------------------------

export type PlanOpKind = 'create-file' | 'create-dir' | 'copy-file' | 'rename' | 'move' | 'delete-file' | 'delete-dir';

export interface RollbackPlan {
  schemaVersion: 1;
  opId: string;
  opKind: PlanOpKind;
  /** sha256 of the exact journal file bytes at plan time. */
  journalHash: string;
  stopGeneration: number;
  createdAt: number;
  /** The exact journal records the plan depends on. */
  journalRefs: Array<{ t: string; opId?: string; at: number }>;
  affectedPaths: Array<{ path: string; role: string }>;
  inverse: {
    kind: 'delete-created' | 'rename-back' | 'restore-from-quarantine';
    targetPath: string;
    sourcePath?: string;
    quarantineId?: string;
  };
  identities: {
    /** Node identity recorded at plan time (strict re-verification target). */
    target?: FileIdentity;
    /** Parent of the node at plan time (replacement detection). */
    parent?: FileIdentity;
    /** For rename-back: parent that must receive the node. */
    originParent?: FileIdentity;
    quarantineData?: FileIdentity;
  };
  /** Present when E1's verification discipline governs the restore. */
  e1Disclosure?: string;
}

export interface ChallengeRecord {
  challengeId: string;
  opId: string;
  planHash: string;
  journalHash: string;
  stopGeneration: number;
  createdAt: number;
  expiresAt: number;
  state: 'pending' | 'approved' | 'consumed' | 'declined' | 'expired';
}

const plans = new Map<string, { plan: RollbackPlan; planHash: string }>();
const challenges = new Map<string, ChallengeRecord>();

/** Server-authoritative stores — exported for operator-UI introspection and
 *  for deterministic tests. There is no client-facing mutation path through
 *  these objects; the HTTP API is the only channel. */
export const rollbackPlanStore = plans;
export const rollbackChallengeStore = challenges;

function canonicalPlanJson(p: RollbackPlan): string {
  // Deterministic serialization of the plan's BINDING content: fixed key
  // insertion order, arrays keep order. `createdAt` is deliberately EXCLUDED
  // — it is bookkeeping, not binding — so the same journal/op state always
  // yields the same plan hash (deterministic-hash requirement).
  const { createdAt, ...binding } = p;
  void createdAt;
  return JSON.stringify(binding);
}

function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function journalFileHash(): string {
  // Hash of the exact journal state. Absent journal = hash of empty.
  try {
    const { root } = getStorageInfo();
    if (!root) return sha256('');
    return sha256(fs.readFileSync(path.join(root, 'sandbox-journal', 'journal.jsonl')));
  } catch {
    return sha256('');
  }
}

function isStrictIdentityMatch(a: FileIdentity, b: FileIdentity): boolean {
  if (a.dev !== b.dev || a.ino !== b.ino) return false;
  if (a.birthtimeReliable && b.birthtimeReliable && Math.abs(a.birthtimeMs - b.birthtimeMs) > STRICT_TOLERANCE_MS) return false;
  if (a.size !== b.size) return false;
  if (Math.abs(a.mtimeMs - b.mtimeMs) > STRICT_TOLERANCE_MS) return false;
  return true;
}

function planEnvironmentRefusals(): string | null {
  const { protection } = getStorageInfo();
  if (protection !== 'full') {
    return `rollback refused: storage protection is "${protection}" — a tamperable journal cannot authorize destructive rollback`;
  }
  const integrity = journalIntegrityCheck();
  if (!integrity.ok) {
    return `rollback refused: journal inconsistency detected (${integrity.malformedLines} malformed of ${integrity.totalLines} lines) — conservative refusal, no guessed recovery`;
  }
  // E5 H4 — rollback is an authority transition: per the M3 design, authority
  // transitions refuse when the audit is compromised. A broken ON-DISK chain
  // is audit failure (distinct from a single failed append).
  const audit = verifyAuditChain();
  if (!audit.ok && audit.entries > 0) {
    return `rollback refused: audit chain integrity failure (${audit.reason ?? 'verification failed'}) — authority transition refused`;
  }
  return null;
}

interface PlanUnit {
  opKind: PlanOpKind;
  journalRefs: Array<{ t: string; opId?: string; at: number }>;
  affectedPaths: Array<{ path: string; role: string }>;
  inverse: RollbackPlan['inverse'];
  identities: RollbackPlan['identities'];
  e1Disclosure?: string;
}

/** Build a plan unit for ONE journal operation. Every branch is conservative:
 *  anything missing, changed, occupied or ambiguous refuses with a reason. */
function buildPlanUnit(opId: string): PlanUnit {
  const entries = readJournalEntries();
  const mutationHits = entries.filter((e) => e.t === 'mutation' && (e as { opId?: string }).opId === opId);
  const stagedHits = entries.filter((e) => (e.t === 'staging_committed' || e.t === 'staging_ready' || e.t === 'staging_started') && (e as { opId?: string }).opId === opId);
  const committedStaged = stagedHits.filter((e) => e.t === 'staging_committed');

  if (mutationHits.length > 1) throw new Error(`journal ambiguity: ${mutationHits.length} mutation records carry opId ${opId} — refusing`);
  if (committedStaged.length > 1) throw new Error(`journal ambiguity: ${committedStaged.length} staged-commit records carry opId ${opId} — refusing`);

  if (mutationHits.length === 1) {
    const rec = mutationHits[0] as SandboxJournalEntry & { op: string; from?: string; to?: string; quarantineId?: string };
    const refs = [{ t: rec.t, opId: rec.opId, at: rec.at }];
    if (rec.op === 'rename' || rec.op === 'move') {
      if (!rec.from || !rec.to) throw new Error('rename/move journal record lacks its paths — cannot plan (conservative refusal)');
      const target = captureIdentity(rec.to);
      if (!target) throw new Error(`"${rec.to}" no longer exists — nothing to move back`);
      if (fs.existsSync(rec.from)) throw new Error(`origin "${rec.from}" is now occupied — unexpected user changes present, refusing to plan`);
      const parent = captureIdentity(path.dirname(rec.to));
      const originParent = captureIdentity(path.dirname(rec.from));
      if (!originParent) throw new Error(`origin parent "${path.dirname(rec.from)}" does not exist`);
      return {
        opKind: rec.op === 'move' ? 'move' : 'rename',
        journalRefs: refs,
        affectedPaths: [{ path: rec.from, role: 'rollback-destination' }, { path: rec.to, role: 'current-location' }],
        inverse: { kind: 'rename-back', targetPath: rec.from, sourcePath: rec.to },
        identities: { target, parent: parent ?? undefined, originParent },
      };
    }
    if (rec.op === 'delete' || rec.op === 'delete-dir') {
      if (!rec.quarantineId) throw new Error('delete record carries no quarantine capture (predates M3 or capture was unavailable) — the content cannot be restored, refusing');
      const r = quarantine.readMeta(rec.quarantineId);
      if (!r.readable || !r.meta) throw new Error(`quarantine capture ${rec.quarantineId} has an unreadable header — restore cannot be planned`);
      if (r.meta.opId && r.meta.opId !== opId) throw new Error('quarantine record is bound to a different operation — refusing (ambiguous)');
      if (fs.existsSync(r.meta.originalPath)) throw new Error(`"${r.meta.originalPath}" now exists — unexpected user changes present, refusing to plan a restore over them`);
      const dataNow = captureIdentity(quarantineItemDataPath(rec.quarantineId));
      if (!dataNow || !identityMatches(r.meta.dataIdentity, dataNow).match) {
        throw new Error('quarantine data identity does not match its capture header — refusing to plan');
      }
      return {
        opKind: rec.op === 'delete-dir' ? 'delete-dir' : 'delete-file',
        journalRefs: refs,
        affectedPaths: [{ path: r.meta.originalPath, role: 'restore-target' }],
        inverse: { kind: 'restore-from-quarantine', targetPath: r.meta.originalPath, quarantineId: rec.quarantineId },
        identities: { quarantineData: r.meta.dataIdentity },
        e1Disclosure: E1_CONTRACT,
      };
    }
    if (rec.op === 'copy-dir') {
      throw new Error('recursive copy cannot be rolled back: per-child identities of the copied tree were never established (M2 disclosed limitation) — refusing');
    }
    if (rec.op === 'create-dir') {
      const target = rec.to;
      if (!target) throw new Error('create-dir record lacks its path — cannot plan');
      if (!fs.existsSync(target)) throw new Error(`"${target}" no longer exists — nothing to roll back`);
      const remaining = fs.readdirSync(target);
      if (remaining.length > 0) throw new Error(`directory "${target}" is not empty — later changes exist inside it; roll those back first (conservative ordering)`);
      const identity = captureIdentity(target)!;
      return {
        opKind: 'create-dir',
        journalRefs: refs,
        affectedPaths: [{ path: target, role: 'created' }],
        inverse: { kind: 'delete-created', targetPath: target },
        identities: { target: identity, parent: captureIdentity(path.dirname(target)) ?? undefined },
      };
    }
    throw new Error(`mutation op "${rec.op}" is not a rollback unit — refusing`);
  }

  if (committedStaged.length === 1) {
    const started = stagedHits.find((e) => e.t === 'staging_started') as SandboxJournalEntry & { op?: string; destPath?: string } | undefined;
    const ready = stagedHits.find((e) => e.t === 'staging_ready') as SandboxJournalEntry & { stage?: FileIdentity } | undefined;
    if (!started?.destPath || !ready?.stage) throw new Error('staged commit lacks its started/ready records — journal inconsistent, refusing');
    const committed = committedStaged[0];
    const current = captureIdentity(started.destPath);
    if (!current) throw new Error(`"${started.destPath}" no longer exists — cannot roll back`);
    if (!isStrictIdentityMatch(ready.stage, current)) {
      throw new Error(`"${started.destPath}" changed since its creation (content edited or node replaced) — rolling back would destroy those changes; refusing (E4 #6 discipline)`);
    }
    return {
      opKind: started.op === 'copy' ? 'copy-file' : 'create-file',
      journalRefs: [
        { t: started.t, opId: started.opId, at: started.at },
        { t: ready.t, opId: ready.opId, at: ready.at },
        { t: committed.t, opId: committed.opId, at: committed.at },
      ],
      affectedPaths: [{ path: started.destPath, role: started.op === 'copy' ? 'copied' : 'created' }],
      inverse: { kind: 'delete-created', targetPath: started.destPath },
      identities: { target: current, parent: captureIdentity(path.dirname(started.destPath)) ?? undefined },
    };
  }

  throw new Error(`no rollback-capable journal record for opId ${opId} — it may predate M3 identifiers or have been compacted out (conservative refusal)`);
}

function quarantineItemDataPath(id: string): string {
  const { root } = getStorageInfo();
  if (!root) throw new Error('storage unavailable');
  return path.join(root, 'quarantine', 'items', `${id}.data`);
}

export interface PlanResult {
  plan: RollbackPlan;
  planHash: string;
  challenge: { challengeId: string; expiresAt: number };
}

/** Model-callable: REQUEST a rollback plan. Planning is read-only and
 *  audited; it never mutates the filesystem and never approves anything. */
export function planRollback(opId: string): PlanResult {
  appendAuditSyncSafe({ kind: 'e5_rollback_plan_requested', opId });
  const refusal = planEnvironmentRefusals();
  if (refusal) {
    appendJournalEntry({ t: 'rollback_refused', opId, reason: refusal, at: Date.now() });
    throw new Error(refusal);
  }
  if (!opId || !/^[0-9a-f-]{36}$/.test(opId)) throw new Error('opId must be a server-minted journal operation id');
  const unit = buildPlanUnit(opId); // throws with the precise conservative reason
  const plan: RollbackPlan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    opId,
    opKind: unit.opKind,
    journalHash: journalFileHash(),
    stopGeneration: stopSnapshot().generation,
    createdAt: Date.now(),
    journalRefs: unit.journalRefs,
    affectedPaths: unit.affectedPaths,
    inverse: unit.inverse,
    identities: unit.identities,
    ...(unit.e1Disclosure ? { e1Disclosure: unit.e1Disclosure } : {}),
  };
  const planHash = sha256(canonicalPlanJson(plan));
  // Deterministic: identical plan data → identical hash (test-pinned).
  plans.set(planHash, { plan, planHash });
  while (plans.size > MAX_STORED_PLANS) {
    const oldest = plans.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    plans.delete(oldest);
  }
  const challenge = createChallenge(opId, planHash, plan.journalHash, plan.stopGeneration);
  appendAuditSyncSafe({ kind: 'e5_rollback_plan_created', opId, planHash, opKind: plan.opKind });
  return { plan, planHash, challenge };
}

function createChallenge(opId: string, planHash: string, journalHash: string, stopGeneration: number): { challengeId: string; expiresAt: number } {
  while (challenges.size >= MAX_PENDING_CHALLENGES) {
    const oldest = challenges.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    challenges.delete(oldest);
  }
  const now = Date.now();
  const rec: ChallengeRecord = {
    challengeId: crypto.randomBytes(32).toString('hex'),
    opId, planHash, journalHash, stopGeneration,
    createdAt: now,
    expiresAt: now + CHALLENGE_TTL_MS,
    state: 'pending',
  };
  challenges.set(rec.challengeId, rec);
  return { challengeId: rec.challengeId, expiresAt: rec.expiresAt };
}

export interface PendingChallengeView {
  challengeId: string;
  opId: string;
  planHash: string;
  expiresAt: number;
  state: string;
  plan: {
    opKind: string;
    affectedPaths: Array<{ path: string; role: string }>;
    inverse: { kind: string; targetPath: string; sourcePath?: string; quarantineId?: string };
  };
}

/** UI-facing: pending (not yet consumed/declined) challenges with plan
 *  summaries. The ONLY surface that shows the operator what they approve. */
export function pendingChallenges(): PendingChallengeView[] {
  const now = Date.now();
  const out: PendingChallengeView[] = [];
  for (const c of challenges.values()) {
    if (c.state === 'pending' && c.expiresAt <= now) c.state = 'expired';
    if (c.state !== 'pending' && c.state !== 'approved') continue;
    const entry = plans.get(c.planHash);
    out.push({
      challengeId: c.challengeId, opId: c.opId, planHash: c.planHash,
      expiresAt: c.expiresAt, state: c.state,
      plan: {
        opKind: entry?.plan.opKind ?? 'unknown',
        affectedPaths: entry?.plan.affectedPaths ?? [],
        inverse: entry?.plan.inverse ?? { kind: 'unknown', targetPath: '' },
      },
    });
  }
  return out;
}

function validateChallengeBinding(c: ChallengeRecord, at: 'approve' | 'execute'): void {
  if (c.state === 'consumed') throw new Error('challenge already consumed — replay rejected (single-use)');
  if (c.state === 'declined') throw new Error('challenge was declined by the operator — retry requires a fresh plan and challenge');
  if (c.state === 'expired' || c.expiresAt <= Date.now()) {
    c.state = 'expired';
    throw new Error(`challenge expired (${at}) — retry requires a fresh plan and challenge`);
  }
  if (c.journalHash !== journalFileHash()) {
    throw new Error(`journal state changed since planning — challenge invalidated (${at})`);
  }
  if (c.stopGeneration !== stopSnapshot().generation) {
    throw new Error(`stop generation changed (${c.stopGeneration} → ${stopSnapshot().generation}) — challenge invalidated (${at})`);
  }
}

/** Operator approval — reachable ONLY through the Krisha UI affordance.
 *  The model has no tool or bridge path here (disclosed same-user boundary
 *  applies to raw loopback HTTP). */
export function approveChallenge(challengeId: string): { approved: true; challengeId: string } {
  const c = challenges.get(challengeId);
  if (!c) throw new Error('unknown challenge');
  validateChallengeBinding(c, 'approve');
  if (c.state === 'approved') throw new Error('challenge already approved — replay rejected');
  c.state = 'approved';
  appendAuditSyncSafe({ kind: 'e5_rollback_challenge_approved', opId: c.opId, planHash: c.planHash });
  return { approved: true, challengeId: c.challengeId };
}

export function declineChallenge(challengeId: string): { declined: true } {
  const c = challenges.get(challengeId);
  if (!c) throw new Error('unknown challenge');
  c.state = 'declined';
  appendAuditSyncSafe({ kind: 'e5_rollback_challenge_declined', opId: c.opId, planHash: c.planHash });
  return { declined: true };
}

export interface ExecuteResult {
  executed: true;
  opKind: PlanOpKind;
  inverse: RollbackPlan['inverse'];
  planHash: string;
  detail: string;
}

/** Consume the challenge and execute the ONE planned inverse operation.
 *  Everything re-validated at the entry boundary; any failure refuses that
 *  operation, preserves data, journals the reason, and never reports success
 *  for work that did not happen. */
export function executeRollback(input: { opId: string; planHash: string; challengeId: string }): ExecuteResult {
  const stored = plans.get(input.planHash);
  if (!stored) throw new Error('unknown plan hash — plans are server-generated; refusing');
  const plan = stored.plan;
  if (plan.opId !== input.opId) throw new Error(`plan ${input.planHash.slice(0, 12)}… is bound to a different operation — refusing (wrong operation id)`);
  const c = challenges.get(input.challengeId);
  if (!c) throw new Error('unknown challenge');
  if (c.planHash !== input.planHash || c.opId !== input.opId) throw new Error('challenge does not bind this operation and plan hash — refusing');
  validateChallengeBinding(c, 'execute');
  if (c.state !== 'approved') throw new Error(`challenge is "${c.state}", not approved — operator approval through the Krisha UI is required`);
  // Single-use consumption happens at execution START (before any mutation).
  c.state = 'consumed';
  appendAuditSyncSafe({ kind: 'e5_rollback_execute_start', opId: input.opId, planHash: input.planHash });
  try {
    // Entry-boundary re-validation (§4):
    const refusal = planEnvironmentRefusals();
    if (refusal) throw new Error(refusal);
    if (stopKind() !== 'INACTIVE') throw new Error(`emergency stop is ACTIVE (${stopKind()}) — rollback halted at the entry boundary`);
    assertSandboxMutation('filesystem.write', 'rollback', plan.opId);
    // The exact journal records must still be present and unchanged.
    const entries = readJournalEntries();
    for (const ref of plan.journalRefs) {
      const stillThere = entries.some((e) => e.t === ref.t && (e as { opId?: string }).opId === ref.opId && e.at === ref.at);
      if (!stillThere) throw new Error('journal no longer contains the bound records (compacted or changed) — refusing (stale plan)');
    }
    let detail = '';
    if (plan.inverse.kind === 'delete-created') {
      const target = plan.inverse.targetPath;
      if (!fs.existsSync(target)) throw new Error(`"${target}" no longer exists — nothing to roll back`);
      const now = captureIdentity(target);
      if (!now || !plan.identities.target || !isStrictIdentityMatch(plan.identities.target, now)) {
        throw new Error('target changed since planning (identity/size/mtime) — refusing to destroy possible user changes');
      }
      const parentNow = captureIdentity(path.dirname(target));
      if (!parentNow || !plan.identities.parent || !identityMatches(plan.identities.parent, parentNow).match) {
        throw new Error('parent directory replaced since planning — refusing');
      }
      // Capture into quarantine on the way out (E7 retention applies to
      // rollback deletions too).
      const res = sandboxDelete(target, false, captureHookFor(plan.opId));
      detail = `removed ${plan.opKind} (quarantined: ${res.quarantineId ?? 'n/a'})`;
    } else if (plan.inverse.kind === 'rename-back') {
      const src = plan.inverse.sourcePath!;
      const dst = plan.inverse.targetPath;
      if (!fs.existsSync(src)) throw new Error(`"${src}" no longer exists — nothing to move back`);
      if (fs.existsSync(dst)) throw new Error(`rollback destination "${dst}" is now occupied — unexpected user changes, refusing`);
      const now = captureIdentity(src);
      if (!now || !plan.identities.target || !identityMatches(plan.identities.target, now).match) {
        throw new Error('node identity changed since planning — refusing to move a replacement');
      }
      const parentNow = captureIdentity(path.dirname(src));
      if (!parentNow || !plan.identities.parent || !identityMatches(plan.identities.parent, parentNow).match) {
        throw new Error('current parent replaced since planning — refusing');
      }
      const originParentNow = captureIdentity(path.dirname(dst));
      if (!originParentNow || !plan.identities.originParent || !identityMatches(plan.identities.originParent, originParentNow).match) {
        throw new Error('origin parent replaced since planning — refusing');
      }
      sandboxMove(src, dst);
      detail = `moved ${path.basename(src)} back to ${dst}`;
    } else {
      // restore-from-quarantine
      if (!plan.identities.quarantineData) throw new Error('plan lacks quarantine identity — refusing');
      const res = quarantine.restoreFromQuarantine(plan.inverse.quarantineId!, plan.inverse.targetPath);
      detail = `restored from quarantine; verified: ${res.verifiedBy}`;
    }
    appendJournalEntry({ t: 'rollback_executed', opId: plan.opId, planHash: input.planHash, at: Date.now() });
    appendAuditSyncSafe({ kind: 'e5_rollback_executed', opId: plan.opId, planHash: input.planHash, opKind: plan.opKind, detail });
    return { executed: true, opKind: plan.opKind, inverse: plan.inverse, planHash: input.planHash, detail };
  } catch (err) {
    const reason = String((err as Error)?.message || err);
    try {
      appendJournalEntry({ t: 'rollback_refused', opId: plan.opId, planHash: input.planHash, reason, at: Date.now() });
    } catch { /* journal failure itself surfaced via auditDegraded */ }
    appendAuditSyncSafe({ kind: 'e5_rollback_refused', opId: plan.opId, planHash: input.planHash, reason });
    throw err;
  }
}

function captureHookFor(_opId: string): DeleteCaptureHook {
  return quarantine.captureNode;
}

// Re-exported for the route layer's convenience and for E1 tests.
export { E1_CONTRACT };
