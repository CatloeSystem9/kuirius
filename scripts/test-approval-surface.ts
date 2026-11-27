/**
 * Approval Surface test suite.
 *
 * Covers the two halves of the feature:
 *
 *   1. Confidence-gated autonomy — per-action-type trust learned from the E5
 *      audit chain, with the fail-closed rules that keep it safe.
 *   2. The offline-auto / online-ask policy — when the operator may be
 *      asked, and when Krisha may act alone.
 *   3. The registry — the unified hub, including the blind-approve guard
 *      (a decision must present a capability released only through the
 *      operator-facing listing) and the surfacing requirement.
 *
 * Usage: npx tsx scripts/test-approval-surface.ts
 * Exits non-zero on any failure.
 */
import { TrustGate } from '../src/agent/approval/trustGate';
import { PresenceTracker, evaluatePolicy } from '../src/agent/approval/policy';
import { ApprovalRegistry } from '../src/agent/approval/approvalRegistry';
import {
  DEFAULT_APPROVAL_POLICY,
  sanitizePolicy,
  isAutoApprovable,
  type ApprovalActionType,
  type ApprovalPolicy,
  type ApprovalRequest,
} from '../src/agent/approval/approvalTypes';

// ------------------------------------------------------------------ harness

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  assert(actual === expected, `${label} (expected ${String(expected)}, got ${String(actual)})`);
}

// ------------------------------------------------------------------ helpers

const DAY = 24 * 60 * 60 * 1000;

/** Build a trust gate over a synthetic audit chain. */
function makeGate(
  entries: Array<Record<string, unknown>>,
  options: { verified?: boolean; available?: boolean; coversTail?: boolean; now?: number } = {}
) {
  const now = options.now ?? Date.now();
  return new TrustGate({
    readAudit: () => ({
      entries,
      available: options.available !== false,
      coversTail: options.coversTail !== false,
      ...(options.available === false ? { reason: 'audit file unreadable' } : {}),
    }),
    verifyChain: () =>
      options.verified === false
        ? { ok: false, reason: 'audit chain verification failed at line 3' }
        : { ok: true, reason: null },
    now: () => now,
    cacheMs: 0,
  });
}

/** A synthetic audit entry. */
function auditEntry(kind: string, at: number): Record<string, unknown> {
  return { kind, at, seq: 1, prevHash: 'genesis', hash: 'x' };
}

/** A policy that trusts anything with enough evidence. */
const TRUSTING_POLICY: ApprovalPolicy = {
  ...DEFAULT_APPROVAL_POLICY,
  mode: 'auto_when_trusted',
  askWhenPresent: true,
  autoWhenAway: true,
  trustThreshold: 0.6,
  minSamples: 5,
};

/** A registry over a fake backend that records what it was asked to do. */
function makeRegistry(options: {
  entries?: Array<Record<string, unknown>>;
  verified?: boolean;
  policy?: ApprovalPolicy;
  present?: boolean;
  now?: () => number;
}) {
  const calls: Array<{ action: 'approve' | 'deny'; ref: string }> = [];
  const now = options.now ?? (() => Date.now());
  const trust = makeGate(options.entries ?? [], { verified: options.verified, now: now() });
  const presence = new PresenceTracker({ now });
  if (options.present) presence.markPresent(now());
  const registry = new ApprovalRegistry({
    trust,
    presence,
    getPolicy: () => options.policy ?? TRUSTING_POLICY,
    now,
    backends: {
      rollback: {
        approve: (request: ApprovalRequest) => {
          calls.push({ action: 'approve', ref: request.backend.ref });
          return { ok: true, reason: 'approved' };
        },
        decline: (request: ApprovalRequest) => {
          calls.push({ action: 'deny', ref: request.backend.ref });
          return { ok: true, reason: 'declined' };
        },
      },
    },
  });
  return { registry, calls, presence, trust };
}

// =========================================================== 1. TRUST GATE

console.log('\n1. Trust gate — a broken TAIL teaches nothing');
{
  const entries = Array.from({ length: 20 }, () => auditEntry('e5_rollback_executed', Date.now()));
  const gate = makeGate(entries, { coversTail: false });
  const verdict = gate.evaluate('rollback');
  assert(!verdict.trusted, 'an unverified audit tail trusts nothing');
  assertEqual(gate.greenList().length, 0, 'the green list is empty when the tail does not verify');
  assert(
    verdict.reason.includes('not verifiable'),
    `the reason names the evidence failure (got "${verdict.reason}")`
  );
}

console.log('\n2. Trust gate — an unreadable chain teaches nothing');
{
  const gate = makeGate([], { available: false });
  assert(!gate.evaluate('rollback').trusted, 'an unreadable audit chain trusts nothing');
  assertEqual(gate.greenList().length, 0, 'the green list is empty when the chain is unreadable');
}

console.log('\n2b. Trust gate — an old break does not invalidate a verified tail');
{
  const now = Date.now();
  const entries = Array.from({ length: 10 }, () => auditEntry('e5_rollback_executed', now));
  // The whole file does not verify (an old discontinuity somewhere), but the
  // recent segment reaches the end of the file and is intact.
  const gate = makeGate(entries, { verified: false, coversTail: true });
  const state = gate.getState();
  assertEqual(state.chainVerified, false, 'the whole-file verdict is reported honestly');
  assert(state.chainReason, 'the whole-file failure reason is reported');
  assertEqual(state.evidenceVerified, true, 'the recent evidence is verified');
  assert(gate.evaluate('rollback').trusted, 'the recent verified evidence is still usable');
}

console.log('\n3. Trust gate — successful rollbacks build trust');
{
  const now = Date.now();
  const entries = Array.from({ length: 10 }, () => auditEntry('e5_rollback_executed', now));
  const gate = makeGate(entries, { now });
  const verdict = gate.evaluate('rollback');
  assert(verdict.trusted, 'ten successful rollbacks make rollback trusted');
  assertEqual(verdict.samples, 10, 'the sample count is the raw signal count');
  assert(verdict.score > 0.99, `the score is near 1.0 (got ${verdict.score})`);
  assert(gate.greenList().includes('rollback'), 'rollback is on the green list');
}

console.log('\n4. Trust gate — evidence before trust');
{
  const now = Date.now();
  const entries = Array.from({ length: 3 }, () => auditEntry('e5_rollback_executed', now));
  const gate = makeGate(entries, { now });
  const verdict = gate.evaluate('rollback');
  assert(!verdict.trusted, 'three successful rollbacks are not enough');
  assert(
    verdict.reason.includes('not enough history'),
    `the reason says the history is too short (got "${verdict.reason}")`
  );
}

console.log('\n5. Trust gate — failures and declines pull the score down');
{
  const now = Date.now();
  const good = Array.from({ length: 10 }, () => auditEntry('e5_rollback_executed', now));
  const withFailure = [
    ...good,
    auditEntry('e5_rollback_refused', now),
    auditEntry('e5_rollback_refused', now),
  ];
  const gate = makeGate(withFailure, { now });
  const verdict = gate.evaluate('rollback');
  assert(!verdict.trusted, 'two failures over ten successes break the trust');
  assert(verdict.score < 0.6, `the score fell below the threshold (got ${verdict.score})`);

  // A single decline is milder than a failure.
  const withDecline = [...good, auditEntry('e5_rollback_challenge_declined', now)];
  const declineGate = makeGate(withDecline, { now });
  assert(
    declineGate.evaluate('rollback').trusted,
    'a single operator decline over ten successes keeps the trust'
  );
}

console.log('\n6. Trust gate — old evidence fades');
{
  const now = Date.now();
  const fresh = Array.from({ length: 10 }, () => auditEntry('e5_rollback_executed', now));
  const stale = Array.from({ length: 10 }, () => auditEntry('e5_rollback_executed', now - 120 * DAY));
  const freshGate = makeGate(fresh, { now });
  const staleGate = makeGate(stale, { now });
  assert(freshGate.evaluate('rollback').trusted, 'fresh evidence is trusted');
  assert(!staleGate.evaluate('rollback').trusted, 'evidence older than the decay window is not trusted');
}

console.log('\n7. Trust gate — never-auto-approvable types stay untrusted');
{
  const now = Date.now();
  const entries = Array.from({ length: 50 }, () => auditEntry('e5_rollback_executed', now));
  const gate = makeGate(entries, { now });
  for (const actionType of ['exec_launch', 'vault_retrieval', 'containment'] as ApprovalActionType[]) {
    assert(!isAutoApprovable(actionType), `${actionType} is not auto-approvable`);
    assert(!gate.evaluate(actionType).trusted, `${actionType} is never trusted`);
  }
  assert(!gate.greenList().includes('exec_launch'), 'exec_launch never reaches the green list');
}

// =========================================================== 8. POLICY

console.log('\n8. Policy — online asks, offline auto-decides only what is proven safe');
{
  const trusted = { trusted: true, score: 1, samples: 10, reason: 'trusted' };
  const untrusted = { trusted: false, score: 0, samples: 0, reason: 'no history yet' };

  const online = evaluatePolicy(
    { actionType: 'rollback', operatorPresent: true, trust: trusted },
    TRUSTING_POLICY
  );
  assertEqual(online.outcome, 'ask', 'a trusted type still asks when the operator is present');

  const offlineTrusted = evaluatePolicy(
    { actionType: 'rollback', operatorPresent: false, trust: trusted },
    TRUSTING_POLICY
  );
  assertEqual(offlineTrusted.outcome, 'auto_approve', 'a trusted type acts alone when the operator is away');

  const offlineUntrusted = evaluatePolicy(
    { actionType: 'rollback', operatorPresent: false, trust: untrusted },
    TRUSTING_POLICY
  );
  assertEqual(offlineUntrusted.outcome, 'ask', 'an untrusted type still asks when the operator is away');

  const alwaysAsk = evaluatePolicy(
    { actionType: 'rollback', operatorPresent: false, trust: trusted },
    { ...TRUSTING_POLICY, mode: 'always_ask' }
  );
  assertEqual(alwaysAsk.outcome, 'ask', 'the always_ask policy never acts alone');

  const execLaunch = evaluatePolicy(
    { actionType: 'exec_launch', operatorPresent: false, trust: trusted },
    TRUSTING_POLICY
  );
  assertEqual(execLaunch.outcome, 'ask', 'exec_launch always asks, even when trusted');
}

console.log('\n9. Policy — presence tracking expires');
{
  let clock = 1_000_000;
  const presence = new PresenceTracker({ now: () => clock });
  assert(!presence.isPresent(), 'nobody is present before the first heartbeat');
  presence.markPresent();
  assert(presence.isPresent(), 'the operator is present right after a heartbeat');
  clock += 30_000;
  assert(presence.isPresent(), 'the operator is still present 30 s later');
  clock += 120_000;
  assert(!presence.isPresent(), 'the operator counts as away once the presence window passes');
  presence.markPresent();
  presence.markAbsent();
  assert(!presence.isPresent(), 'the operator can report that they left');
}

console.log('\n10. Policy — sanitizing a hostile policy object');
{
  const sane = sanitizePolicy({ mode: 'nonsense', trustThreshold: 99, minSamples: -5 });
  assertEqual(sane.mode, 'auto_when_trusted', 'an unknown mode falls back to the default');
  assertEqual(sane.trustThreshold, 1, 'the trust threshold is clamped into [0,1]');
  assertEqual(sane.minSamples, 1, 'the minimum samples is clamped to at least 1');
  const empty = sanitizePolicy(null);
  assertEqual(empty.mode, DEFAULT_APPROVAL_POLICY.mode, 'a missing policy falls back to the default');
}

// =========================================================== 11. REGISTRY

console.log('\n11. Registry — confidence-gated autonomy acts alone when the operator is away');
{
  const now = Date.now();
  const entries = Array.from({ length: 10 }, () => auditEntry('e5_rollback_executed', now));
  const { registry, calls } = makeRegistry({ entries, present: false });
  const request = await registry.raise({
    actionType: 'rollback',
    title: 'Rollback',
    detail: 'restore two files',
    risk: 'medium',
    backend: { kind: 'rollback', ref: 'chal_1' },
  });
  assertEqual(request.state, 'auto_approved', 'a trusted type is auto-approved while the operator is away');
  assertEqual(calls.length, 1, 'the backend was called once');
  assertEqual(calls[0].action, 'approve', 'the backend was asked to approve');
  assertEqual(registry.pending().length, 0, 'an auto-decided request is not pending');
}

console.log('\n12. Registry — the operator present means ask');
{
  const now = Date.now();
  const entries = Array.from({ length: 10 }, () => auditEntry('e5_rollback_executed', now));
  const { registry, calls } = makeRegistry({ entries, present: true });
  const request = await registry.raise({
    actionType: 'rollback',
    title: 'Rollback',
    detail: 'restore two files',
    risk: 'medium',
    backend: { kind: 'rollback', ref: 'chal_2' },
  });
  assertEqual(request.state, 'pending', 'a request raised while the operator is present stays pending');
  assertEqual(calls.length, 0, 'nothing was decided without the operator');
  assertEqual(registry.pending().length, 1, 'the request is pending');
}

console.log('\n13. Registry — a decision needs the capability from the operator listing');
{
  const { registry, calls } = makeRegistry({ present: true });
  await registry.raise({
    actionType: 'rollback',
    title: 'Rollback',
    detail: 'restore two files',
    risk: 'medium',
    backend: { kind: 'rollback', ref: 'chal_3' },
  });

  const pending = registry.pending();
  assertEqual(pending.length, 1, 'the request is pending');
  const capability = pending[0].capability;
  assert(typeof capability === 'string' && capability.length > 0, 'the listing releases a capability');

  // A blind decision (no capability) is refused.
  const blind = await registry.decide('apr_missing', 'approve', 'browser', undefined);
  assert(!blind.ok, 'a decision for an unknown request is refused');

  const noCapability = await registry.decide(pending[0].id, 'approve', 'browser', undefined);
  assert(!noCapability.ok, 'a decision without the capability is refused');
  assertEqual(calls.length, 0, 'the backend was never called for a blind decision');

  const wrongCapability = await registry.decide(pending[0].id, 'approve', 'browser', 'deadbeef');
  assert(!wrongCapability.ok, 'a decision with the wrong capability is refused');
  assertEqual(calls.length, 0, 'the backend was never called for a wrong capability');
}

console.log('\n14. Registry — a decision needs the request to have been surfaced');
{
  const { registry, calls } = makeRegistry({ present: true });
  await registry.raise({
    actionType: 'rollback',
    title: 'Rollback',
    detail: 'restore two files',
    risk: 'medium',
    backend: { kind: 'rollback', ref: 'chal_4' },
  });
  const capability = registry.pending()[0].capability;

  // The capability alone is not enough — it was never shown to a human.
  const unsurfaced = await registry.decide(registry.pending()[0].id, 'approve', 'browser', capability);
  assert(!unsurfaced.ok, 'a decision on a request that was never surfaced is refused');
  assert(
    unsurfaced.reason.includes('never shown'),
    `the reason says the request was never shown (got "${unsurfaced.reason}")`
  );
  assertEqual(calls.length, 0, 'the backend was never called for an unsurfaced request');

  // Surface it, then decide — now it works.
  assert(registry.markSurfaced(registry.pending()[0].id, 'toast'), 'the request can be marked as surfaced');
  const decided = await registry.decide(registry.pending()[0].id, 'approve', 'toast', capability);
  assert(decided.ok, 'a surfaced request with the right capability is decided');
  assertEqual(calls.length, 1, 'the backend was called once');
  assertEqual(calls[0].action, 'approve', 'the backend was asked to approve');
  assertEqual(registry.pending().length, 0, 'the decided request is no longer pending');
}

console.log('\n15. Registry — a decision cannot be replayed');
{
  const { registry, calls } = makeRegistry({ present: true });
  await registry.raise({
    actionType: 'rollback',
    title: 'Rollback',
    detail: 'restore two files',
    risk: 'medium',
    backend: { kind: 'rollback', ref: 'chal_5' },
  });
  const pendingId = registry.pending()[0].id;
  const capability = registry.pending()[0].capability;
  registry.markSurfaced(pendingId, 'browser');
  await registry.decide(pendingId, 'approve', 'browser', capability);

  const replay = await registry.decide(pendingId, 'approve', 'browser', capability);
  assert(!replay.ok, 'the same decision cannot be replayed');
  assertEqual(calls.length, 1, 'the backend was called exactly once');
}

console.log('\n16. Registry — an expired request cannot be decided');
{
  let clock = 2_000_000;
  const { registry, calls } = makeRegistry({ present: true, now: () => clock });
  await registry.raise({
    actionType: 'rollback',
    title: 'Rollback',
    detail: 'restore two files',
    risk: 'medium',
    backend: { kind: 'rollback', ref: 'chal_6' },
    ttlMs: 1000,
  });
  const pendingId = registry.pending()[0].id;
  const capability = registry.pending()[0].capability;
  registry.markSurfaced(pendingId, 'browser');

  clock += 5000;
  const expired = await registry.decide(pendingId, 'approve', 'browser', capability);
  assert(!expired.ok, 'an expired request cannot be decided');
  assertEqual(calls.length, 0, 'the backend was never called for an expired request');
}

console.log('\n17. Registry — the capability is released only through the pending listing');
{
  const { registry } = makeRegistry({ present: true });
  await registry.raise({
    actionType: 'rollback',
    title: 'Rollback',
    detail: 'restore two files',
    risk: 'medium',
    backend: { kind: 'rollback', ref: 'chal_7' },
  });
  const listed = registry.list();
  assertEqual(listed.length, 1, 'the request is listed');
  assert(
    !('capability' in (listed[0] as Record<string, unknown>)),
    'the general listing does NOT carry the capability'
  );
  assert(
    'capability' in (registry.pending()[0] as Record<string, unknown>),
    'the operator-facing pending listing DOES carry the capability'
  );
}

console.log('\n18. Registry — a denial is carried to the backend');
{
  const { registry, calls } = makeRegistry({ present: true });
  await registry.raise({
    actionType: 'rollback',
    title: 'Rollback',
    detail: 'restore two files',
    risk: 'medium',
    backend: { kind: 'rollback', ref: 'chal_8' },
  });
  const pendingId = registry.pending()[0].id;
  const capability = registry.pending()[0].capability;
  registry.markSurfaced(pendingId, 'browser');
  const denied = await registry.decide(pendingId, 'deny', 'browser', capability);
  assert(denied.ok, 'the denial was applied');
  assertEqual(calls[0].action, 'deny', 'the backend was asked to decline');
}

console.log('\n19. Registry — the green list and policy are visible');
{
  const now = Date.now();
  const entries = Array.from({ length: 10 }, () => auditEntry('e5_rollback_executed', now));
  const { registry } = makeRegistry({ entries });
  const trust = registry.trustState();
  assert(trust.chainVerified, 'the chain verified');
  assert(trust.greenList.includes('rollback'), 'the green list is reported');
  assertEqual(registry.policy().mode, 'auto_when_trusted', 'the policy is reported');
}

// ------------------------------------------------------------------ summary

console.log(`\n${'='.repeat(60)}`);
console.log(`Approval surface tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailed assertions:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('All approval surface tests passed.');
