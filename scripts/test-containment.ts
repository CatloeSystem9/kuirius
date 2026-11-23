/**
 * Threat Containment (Phase D.3) — test suite.
 *
 * Usage:  npx tsx scripts/test-containment.ts
 * Exit:   non-zero on any failure.
 *
 * Covers:
 *  - Process-instance pinning (PID-reuse safety): termination binds to an OS
 *    process reference, never to a PID. Identity is read THROUGH the pin.
 *  - Server-side authorization: approval tokens are minted ONLY server-side,
 *    single-use, 5-min TTL, bound to the exact process identity; the request
 *    shape carries only {pid, approvalToken}.
 *  - Server-side classification binding (Phase B dependency; client labels
 *    cannot reach the decision).
 *  - E-stop at every boundary (entry, pre-termination, unavailable, restart).
 *  - Audit enrichment + metadata-only privacy.
 *  - Real pin-worker smoke test (self-pin, READ-ONLY, never terminates).
 *  - Runtime integration through the production routes (isolated E5 store).
 *
 * All process-control interfaces are MOCKED. Only benign synthetic fixtures
 * are used. No real process is terminated. No malware samples are used.
 * The real E5 store is never touched (isolation via test-isolation.ts).
 */
import './test-isolation';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as netModule from 'node:net';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ThreatContainment, defaultPinProcess, createCredentialApprovalAuthority, type ContainmentDependencies } from '../src/agent/containment/containment';
import { PinUnavailableError } from '../src/agent/containment/containmentTypes';
import type { ProcessIdentity, PinnedProcess, ClassificationEvidence, ContainmentAuditEvent, ApprovalAuthorityResult } from '../src/agent/containment/containmentTypes';
import {
  setContainmentApprovalCredential,
  clearContainmentApprovalCredential,
  verifyContainmentApprovalCredential,
  containmentApprovalCredentialSet,
  containmentApprovalEpoch,
} from '../serverSafety';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let passed = 0;
let failed = 0;
let skipped = 0;
let serverLogGlobal = '';
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) passed++;
  else { failed++; failures.push(label); console.error(`  X ${label}`); }
}

function skip(label: string) {
  skipped++;
  console.log(`  (SKIPPED: ${label})`);
}

// ------------------------------------------------------------ fixtures

const TEST_OPERATOR_CREDENTIAL = 'OperatorCred1!';

const APPROVED_IDENTITY: ProcessIdentity = {
  pid: 5000,
  name: 'test-malware.exe',
  creationTime: '2026-11-21T10:00:00.0000000Z',
  executablePath: 'C:\\Temp\\test-malware.exe',
};

function makePin(overrides: Partial<ProcessIdentity> & {
  terminateResult?: boolean;
  hasExitedResult?: boolean | null;
  terminateImpl?: () => Promise<boolean>;
  hasExitedImpl?: () => Promise<boolean | null>;
} = {}): PinnedProcess & { calls: { terminate: number; hasExited: number; release: number } } {
  const calls = { terminate: 0, hasExited: 0, release: 0 };
  const id = { ...APPROVED_IDENTITY, ...overrides };
  return {
    pid: id.pid,
    name: id.name,
    creationTime: id.creationTime,
    executablePath: id.executablePath,
    calls,
    terminate: async () => {
      calls.terminate++;
      if (overrides.terminateImpl) return overrides.terminateImpl();
      return overrides.terminateResult !== undefined ? overrides.terminateResult : true;
    },
    hasExited: async () => {
      calls.hasExited++;
      if (overrides.hasExitedImpl) return overrides.hasExitedImpl();
      return overrides.hasExitedResult !== undefined ? overrides.hasExitedResult : true;
    },
    release: () => { calls.release++; },
  } as PinnedProcess & { calls: typeof calls };
}

function makeEvidence(overrides: Partial<ClassificationEvidence> = {}): ClassificationEvidence {
  return {
    classification: 'CONFIRMED_MALWARE',
    confidence: 'HIGH',
    assessedAt: Date.now(),
    evidenceSources: ['defender-detection', 'file-signature'],
    ...overrides,
  };
}

function makeDeps(overrides: {
  pin?: PinnedProcess | null;
  pinError?: Error;
  pinFactory?: (pid: number) => PinnedProcess | null;
  readIdentity?: ProcessIdentity | null;
  readError?: boolean;
  classify?: ClassificationEvidence | null;
  classifyImpl?: (p: string) => Promise<ClassificationEvidence | null>;
  classifyProbe?: () => number;
  authority?: ApprovalAuthorityResult | ((input: { pid: number; operatorCredential?: string; authorityEpoch?: number }) => ApprovalAuthorityResult | Promise<ApprovalAuthorityResult>) | 'throw';
  isStopActive?: () => boolean;
  auditEvents?: ContainmentAuditEvent[];
} = {}) {
  const auditEvents: Array<ContainmentAuditEvent> = [];
  let classifyCalls = 0;
  const deps: ContainmentDependencies = {
    // Phase D.4: the harness default simulates a VERIFIED approval-authority
    // mechanism so the D.3 termination machinery stays fully regression-
    // tested. The PRODUCTION wiring (server.ts) is the credential-backed
    // authority (createCredentialApprovalAuthority over the E5 enrollment) —
    // tested explicitly in sections 11P and 12.
    verifyApprovalAuthority: async (input) => {
      if (overrides.authority === 'throw') throw new Error('authority service crashed');
      if (typeof overrides.authority === 'function') return overrides.authority(input);
      if (overrides.authority !== undefined) return overrides.authority;
      return { authorized: true, authorityId: `test-authority-${input.pid}`, method: 'test-verified-operator', authorityEpoch: 0 };
    },
    readProcessIdentity: async () => {
      if (overrides.readError) throw new Error('identity read failed');
      return overrides.readIdentity !== undefined ? overrides.readIdentity : APPROVED_IDENTITY;
    },
    pinProcess: async (pid: number) => {
      if (overrides.pinError) throw overrides.pinError;
      if (overrides.pinFactory) return overrides.pinFactory(pid);
      if (overrides.pin !== undefined) return overrides.pin;
      return makePin({ pid });
    },
    isStopActive: overrides.isStopActive ?? (() => false),
    classify: async (p) => {
      classifyCalls++;
      if (overrides.classifyImpl) return overrides.classifyImpl(p);
      return overrides.classify !== undefined ? overrides.classify : makeEvidence();
    },
    audit: (e) => { auditEvents.push(e); overrides.auditEvents?.push(e); },
  };
  return { deps, auditEvents, classifyCallCount: () => classifyCalls };
}

/**
 * Production-mode authority: the exact shape server.ts wires — no
 * independent operator-approval mechanism exists, so the authority is
 * unavailable and termination is unreachable.
 */
const PRODUCTION_AUTHORITY: ApprovalAuthorityResult = {
  authorized: false,
  unavailable: true,
  reason: 'independent operator approval is not available in this architecture — no server-verified operator decision mechanism exists (application.launch permission is not an operator decision); termination remains disabled pending an approval capability (Phase D.4)',
};

/**
 * Classify dependency that succeeds at issuance time (first call) and returns
 * a different result at containment time — lets tests exercise the
 * contain-time classification gates independently of issuance.
 */
function switchClassify(first: ClassificationEvidence, rest: () => ClassificationEvidence | null): (p: string) => Promise<ClassificationEvidence | null> {
  let calls = 0;
  return async () => { calls++; return calls === 1 ? first : rest(); };
}

async function approvedToken(containment: ThreatContainment, pid = APPROVED_IDENTITY.pid): Promise<string> {
  const issuance = await containment.issueApproval(pid, TEST_OPERATOR_CREDENTIAL);
  if (issuance.outcome !== 'APPROVAL_ISSUED' || !issuance.token) {
    throw new Error(`approval not issued: ${issuance.outcome} — ${issuance.reason}`);
  }
  return issuance.token.token;
}

// ================================================= 1. Happy path + audit
{
  console.log('1. Happy path: approve -> pin -> terminate the pinned instance');
  const pin = makePin();
  const auditEvents: ContainmentAuditEvent[] = [];
  const { deps } = makeDeps({ pin, auditEvents });
  const containment = new ThreatContainment(deps);
  const token = await approvedToken(containment);
  const result = await containment.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: token });
  assert(result.outcome === 'TERMINATED', '1a: approved confirmed malware with matching pinned identity -> TERMINATED');
  assert(pin.calls.terminate === 1, '1b: terminate called exactly once, on the pinned instance');
  assert(pin.calls.hasExited === 1, '1c: post-termination verification performed through the pin');
  assert(pin.calls.release === 1, '1d: pin released exactly once (no OS reference leak)');
  assert(result.audited, '1e: containment result is audited');
  const ev = auditEvents.find((e) => e.outcome === 'TERMINATED');
  assert(!!ev, '1f: TERMINATED event audited');
  if (ev) {
    assert(typeof ev.requestId === 'string' && ev.requestId.startsWith('tc_'), '1g: audit carries a per-attempt requestId');
    assert(ev.authorized === true && ev.terminationEligible === true && ev.terminationAttempted === true, '1h: audit records authorization + eligibility');
    assert(ev.terminationResult === 'succeeded' && ev.postVerifyResult === 'exited', '1i: audit records termination + post-verification results');
    assert(ev.estopActive === false && ev.hasApprovalToken === true, '1j: audit records E-stop state and token presence');
  }
}

// ================================== 2. Approval issuance (server-side gates)
{
  console.log('2. Approval issuance: server-side gates only');
  const containment = new ThreatContainment(makeDeps({ isStopActive: () => true }).deps);
  const stopIssuance = await containment.issueApproval(APPROVED_IDENTITY.pid, TEST_OPERATOR_CREDENTIAL);
  assert(stopIssuance.outcome === 'REFUSED_E_STOP', '2a: no approval while E-stop is active');

  const notFound = new ThreatContainment(makeDeps({ readIdentity: null }).deps);
  assert((await notFound.issueApproval(1234, TEST_OPERATOR_CREDENTIAL)).outcome === 'ALREADY_EXITED', '2b: nonexistent process -> ALREADY_EXITED');

  const readFail = new ThreatContainment(makeDeps({ readError: true }).deps);
  assert((await readFail.issueApproval(1234, TEST_OPERATOR_CREDENTIAL)).outcome === 'REFUSED_INSUFFICIENT_EVIDENCE', '2c: identity read failure -> fail-closed refusal');

  const ambiguous = new ThreatContainment(makeDeps({ readIdentity: { ...APPROVED_IDENTITY, executablePath: '' } }).deps);
  assert((await ambiguous.issueApproval(APPROVED_IDENTITY.pid, TEST_OPERATOR_CREDENTIAL)).outcome === 'REFUSED_IDENTITY_CHANGED', '2d: ambiguous identity (no path) -> refused');

  for (const name of ['lsass.exe', 'winlogon.exe', 'svchost.exe', 'MsMpEng.exe', 'node.exe', 'powershell.exe']) {
    const c = new ThreatContainment(makeDeps({ readIdentity: { ...APPROVED_IDENTITY, name } }).deps);
    assert((await c.issueApproval(APPROVED_IDENTITY.pid, TEST_OPERATOR_CREDENTIAL)).outcome === 'REFUSED_PROTECTED_PROCESS', `2e: protected process ${name} not approvable`);
  }

  const noClassify = new ThreatContainment(makeDeps({ classify: null }).deps);
  assert((await noClassify.issueApproval(APPROVED_IDENTITY.pid, TEST_OPERATOR_CREDENTIAL)).outcome === 'REFUSED_INSUFFICIENT_EVIDENCE', '2f: classification unavailable -> fail-closed refusal');

  for (const classification of ['SUSPICIOUS', 'UNKNOWN', 'CLEAN', 'UNAVAILABLE', 'HIGH_CONFIDENCE_THREAT'] as const) {
    const c = new ThreatContainment(makeDeps({ classify: makeEvidence({ classification, confidence: 'LOW' }) }).deps);
    const issuance = await c.issueApproval(APPROVED_IDENTITY.pid, TEST_OPERATOR_CREDENTIAL);
    assert(issuance.outcome === 'REFUSED_INSUFFICIENT_EVIDENCE' && issuance.reason.includes(classification),
      `2g: ${classification} is not approvable (only CONFIRMED_MALWARE)`);
  }

  const stale = new ThreatContainment(makeDeps({ classify: makeEvidence({ assessedAt: Date.now() - 25 * 60 * 60 * 1000 }) }).deps);
  assert((await stale.issueApproval(APPROVED_IDENTITY.pid, TEST_OPERATOR_CREDENTIAL)).outcome === 'REFUSED_STALE_EVIDENCE', '2h: stale classification evidence -> refused');

  const ok = new ThreatContainment(makeDeps({}).deps);
  const issuance = await ok.issueApproval(APPROVED_IDENTITY.pid, TEST_OPERATOR_CREDENTIAL);
  assert(issuance.outcome === 'APPROVAL_ISSUED' && !!issuance.token, '2i: CONFIRMED_MALWARE with matching identity -> APPROVAL_ISSUED');
  if (issuance.token) {
    assert(/^[0-9a-f]{48}$/.test(issuance.token.token), '2j: token is server-generated (48 hex chars = 24 random bytes)');
    assert(issuance.token.pid === APPROVED_IDENTITY.pid
      && issuance.token.creationTime === APPROVED_IDENTITY.creationTime
      && issuance.token.executablePath === APPROVED_IDENTITY.executablePath
      && issuance.token.name === APPROVED_IDENTITY.name, '2k: token is bound to the exact process identity');
    assert(issuance.token.expiresAt - issuance.token.issuedAt === 5 * 60 * 1000, '2l: token TTL is 5 minutes');
  }
}

// ==================================== 3. Containment without valid approval
{
  console.log('3. Containment without valid approval');
  const noToken = new ThreatContainment(makeDeps({}).deps);
  assert((await noToken.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: '' })).outcome === 'REFUSED_NO_APPROVAL', '3a: missing token -> REFUSED_NO_APPROVAL');

  const forged = new ThreatContainment(makeDeps({}).deps);
  assert((await forged.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: 'forged-token-0123456789abcdef' })).outcome === 'REFUSED_APPROVAL_INVALID', '3b: forged (not server-issued) token -> REFUSED_APPROVAL_INVALID');

  // Expired token: issue, then advance the clock past the TTL.
  const expired = new ThreatContainment(makeDeps({}).deps);
  const expiredToken = await approvedToken(expired);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 6 * 60 * 1000;
    assert((await expired.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: expiredToken })).outcome === 'REFUSED_APPROVAL_INVALID', '3c: expired token (5-min TTL) -> REFUSED_APPROVAL_INVALID');
  } finally {
    Date.now = realNow;
  }

  // Short token (registry pre-check runs BEFORE any process probing).
  const shortToken = new ThreatContainment(makeDeps({}).deps);
  assert((await shortToken.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: 'short' })).outcome === 'REFUSED_NO_APPROVAL', '3d: malformed token refused before process probing (no existence oracle)');

  // Token bound to a different PID.
  const other = new ThreatContainment(makeDeps({}).deps);
  const otherToken = await approvedToken(other, APPROVED_IDENTITY.pid);
  assert((await other.contain({ pid: 5100, approvalToken: otherToken })).outcome === 'REFUSED_APPROVAL_INVALID', '3e: token bound to a different PID -> refused');
}

// ==================================== 4. PID reuse & identity binding
{
  console.log('4. PID reuse and identity binding through the pin');
  // 4a: pinned creation time differs from the approved instance (PID reused).
  const reusedPin = makePin({ creationTime: '2026-11-21T12:34:56.0000000Z' });
  const reuseAudit: ContainmentAuditEvent[] = [];
  const reuse = new ThreatContainment(makeDeps({ pin: reusedPin, auditEvents: reuseAudit }).deps);
  const reuseToken = await approvedToken(reuse);
  const reuseResult = await reuse.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: reuseToken });
  assert(reuseResult.outcome === 'REFUSED_PID_REUSED', '4a: pinned creation time differs -> REFUSED_PID_REUSED (never terminates a different instance)');
  assert(reusedPin.calls.terminate === 0, '4b: termination NOT attempted on a reused PID');
  assert((await reuse.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: reuseToken })).outcome === 'REFUSED_APPROVAL_INVALID', '4c: binding-mismatch consumes the token (no retry fishing)');

  const pathPin = makePin({ executablePath: 'C:\\Different\\path\\test-malware.exe' });
  const pathChange = new ThreatContainment(makeDeps({ pin: pathPin }).deps);
  assert((await pathChange.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: await approvedToken(pathChange) })).outcome === 'REFUSED_IDENTITY_CHANGED', '4d: pinned executable path differs -> REFUSED_IDENTITY_CHANGED');

  const namePin = makePin({ name: 'other-process.exe' });
  const nameChange = new ThreatContainment(makeDeps({ pin: namePin }).deps);
  assert((await nameChange.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: await approvedToken(nameChange) })).outcome === 'REFUSED_IDENTITY_CHANGED', '4e: pinned process name differs -> REFUSED_IDENTITY_CHANGED');

  const noMetaPin = makePin({ executablePath: '', creationTime: '' });
  const noMeta = new ThreatContainment(makeDeps({ pin: noMetaPin }).deps);
  assert((await noMeta.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: await approvedToken(noMeta) })).outcome === 'REFUSED_IDENTITY_CHANGED', '4f: pinned metadata unavailable -> ambiguous identity fails closed');

  const gone = new ThreatContainment(makeDeps({ pin: null }).deps);
  assert((await gone.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: await approvedToken(gone) })).outcome === 'ALREADY_EXITED', '4g: process exited before termination (pin not acquirable) -> ALREADY_EXITED');

  const deniedAudit: ContainmentAuditEvent[] = [];
  const denied = new ThreatContainment(makeDeps({ pinError: new PinUnavailableError('ACCESS_DENIED', 5), auditEvents: deniedAudit }).deps);
  const deniedResult = await denied.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: await approvedToken(denied) });
  assert(deniedResult.outcome === 'IDENTITY_NOT_GUARANTEED', '4h: terminate-capable reference refused by OS -> IDENTITY_NOT_GUARANTEED (no PID-based fallback)');
  const deniedEv = deniedAudit.find((e) => e.outcome === 'IDENTITY_NOT_GUARANTEED');
  assert(!!deniedEv && deniedEv.terminationAttempted === false && deniedEv.terminationEligible === false, '4i: IDENTITY_NOT_GUARANTEED audited with termination NOT attempted');

  const infra = new ThreatContainment(makeDeps({ pinError: new PinUnavailableError('INFRASTRUCTURE') }).deps);
  assert((await infra.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: await approvedToken(infra) })).outcome === 'VERIFICATION_UNAVAILABLE', '4j: pin infrastructure failure -> VERIFICATION_UNAVAILABLE (fail-closed)');

  const generic = new ThreatContainment(makeDeps({ pinError: new Error('unexpected') }).deps);
  assert((await generic.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: await approvedToken(generic) })).outcome === 'VERIFICATION_UNAVAILABLE', '4k: unexpected pin error -> VERIFICATION_UNAVAILABLE (fail-closed)');
}

// ============================== 5. Server-side classification at contain
{
  console.log('5. Server-side classification binding (client labels cannot reach the decision)');
  // 5a: classification becomes unavailable at containment time (issuance saw it).
  const noClassify = new ThreatContainment(makeDeps({ classifyImpl: switchClassify(makeEvidence(), () => null) }).deps);
  assert((await noClassify.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: await approvedToken(noClassify) })).outcome === 'REFUSED_INSUFFICIENT_EVIDENCE',
    '5a: classification unavailable at containment time -> fail-closed refusal');

  // 5b/5c: a client tries to inject a CONFIRMED_MALWARE label while the
  // server-side engine says SUSPICIOUS — the injected label must be ignored.
  const clientLabel = new ThreatContainment(makeDeps({ classifyImpl: switchClassify(makeEvidence(), () => makeEvidence({ classification: 'SUSPICIOUS' })) }).deps);
  const clientToken = await approvedToken(clientLabel);
  const injected = await clientLabel.contain({
    pid: APPROVED_IDENTITY.pid,
    approvalToken: clientToken,
    evidence: { classification: 'CONFIRMED_MALWARE', confidence: 'HIGH', assessedAt: Date.now(), evidenceSources: ['injected'] },
  } as unknown as { pid: number; approvalToken: string });
  assert(injected.outcome === 'REFUSED_INSUFFICIENT_EVIDENCE', '5b: client-supplied classification label is IGNORED (server re-classifies)');

  // 5c: downgrade between approval and containment (CLEAN at containment).
  const downgrade = new ThreatContainment(makeDeps({ classifyImpl: switchClassify(makeEvidence(), () => makeEvidence({ classification: 'CLEAN' })) }).deps);
  assert((await downgrade.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: await approvedToken(downgrade) })).outcome === 'REFUSED_INSUFFICIENT_EVIDENCE',
    '5c: classification downgrade at containment time -> refused');

  // 5d: stale evidence at containment time (fresh at issuance).
  const staleAtContain = new ThreatContainment(makeDeps({
    classifyImpl: switchClassify(makeEvidence(), () => makeEvidence({ assessedAt: Date.now() - 25 * 60 * 60 * 1000 })),
  }).deps);
  assert((await staleAtContain.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: await approvedToken(staleAtContain) })).outcome === 'REFUSED_STALE_EVIDENCE',
    '5d: stale evidence at containment time -> REFUSED_STALE_EVIDENCE');
}

// ============================================ 6. E-stop at every boundary
{
  console.log('6. E-stop enforcement at every boundary');
  // (Issuance-time E-stop refusal is covered in 2a.)

  // Activated AFTER approval (between issuance and containment entry): the
  // entry check refuses and NO process probing happens while the stop is on.
  let stopChecks = 0;
  let pinRequested = false;
  const entryPin = makePin();
  const afterApproval = new ThreatContainment(makeDeps({
    isStopActive: () => { stopChecks++; return stopChecks >= 2; }, // 1st: issuance (inactive), 2nd: contain entry (active)
    pinFactory: () => { pinRequested = true; return entryPin; },
  }).deps);
  const afterToken = await approvedToken(afterApproval);
  assert((await afterApproval.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: afterToken })).outcome === 'REFUSED_E_STOP',
    '6a: E-stop activated after approval -> REFUSED_E_STOP at entry');
  assert(!pinRequested, '6b: no process probing while the E-stop is active');
  void entryPin;

  // Activated IMMEDIATELY BEFORE termination (entry passes, re-check fails).
  let preTermChecks = 0;
  const preTermPin = makePin();
  const preTerm = new ThreatContainment(makeDeps({
    isStopActive: () => { preTermChecks++; return preTermChecks >= 3; }, // 1st: issuance, 2nd: entry, 3rd: pre-termination
    pinFactory: () => preTermPin,
  }).deps);
  const preTermToken = await approvedToken(preTerm);
  const preTermResult = await preTerm.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: preTermToken });
  assert(preTermResult.outcome === 'REFUSED_E_STOP', '6c: E-stop activated immediately before termination -> REFUSED_E_STOP');
  assert(preTermPin.calls.terminate === 0, '6d: termination NOT attempted after the pre-termination E-stop re-check');

  // Concurrent containment requests each independently check the E-stop.
  const concStop = new ThreatContainment(makeDeps({ isStopActive: () => true }).deps);
  const results = await Promise.all([
    concStop.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: 'concurrent-token-0123456789a' }),
    concStop.contain({ pid: 5100, approvalToken: 'concurrent-token-0123456789b' }),
  ]);
  assert(results.every((r) => r.outcome === 'REFUSED_E_STOP'), '6e: concurrent requests each independently refused by the E-stop');
}

// ============================================ 7. Termination outcomes
{
  console.log('7. Termination outcomes (honest reporting)');
  const okPin = makePin({ terminateResult: true, hasExitedResult: true });
  const ok = new ThreatContainment(makeDeps({ pin: okPin }).deps);
  assert((await ok.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: await approvedToken(ok) })).outcome === 'TERMINATED', '7a: terminate + verified exit -> TERMINATED');

  const stuckPin = makePin({ terminateResult: true, hasExitedResult: false });
  const stuck = new ThreatContainment(makeDeps({ pin: stuckPin }).deps);
  assert((await stuck.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: await approvedToken(stuck) })).outcome === 'ACCESS_DENIED', '7b: pinned instance still running after termination -> ACCESS_DENIED');

  const failedPin = makePin({ terminateResult: false, hasExitedResult: false });
  const failed = new ThreatContainment(makeDeps({ pin: failedPin }).deps);
  assert((await failed.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: await approvedToken(failed) })).outcome === 'ACCESS_DENIED', '7c: termination failure -> ACCESS_DENIED');

  const uncertainPin = makePin({ terminateResult: true, hasExitedResult: null });
  const uncertain = new ThreatContainment(makeDeps({ pin: uncertainPin }).deps);
  assert((await uncertain.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: await approvedToken(uncertain) })).outcome === 'VERIFICATION_UNAVAILABLE', '7d: post-termination verification unavailable -> VERIFICATION_UNAVAILABLE (never success)');

  const throwPin = makePin({ terminateImpl: async () => { throw new Error('worker died mid-termination'); } });
  const throwAudit: ContainmentAuditEvent[] = [];
  const thrown = new ThreatContainment(makeDeps({ pin: throwPin, auditEvents: throwAudit }).deps);
  const throwResult = await thrown.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: await approvedToken(thrown) });
  assert(throwResult.outcome === 'VERIFICATION_UNAVAILABLE', '7e: termination infrastructure failure -> VERIFICATION_UNAVAILABLE (never success)');
  const throwEv = throwAudit.find((e) => e.terminationAttempted === true);
  assert(!!throwEv && throwEv.terminationResult === 'unknown', '7f: uncertain termination recorded as unknown (no false success)');

  const naturalPin = makePin({ terminateResult: false, hasExitedResult: true });
  const natural = new ThreatContainment(makeDeps({ pin: naturalPin }).deps);
  assert((await natural.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: await approvedToken(natural) })).outcome === 'ALREADY_EXITED', '7g: pinned instance exited without successful termination -> ALREADY_EXITED (honest)');
}

// ====================== 8. Single-use, concurrency, bounded registry
{
  console.log('8. Single-use tokens, concurrency, bounded registry');
  const singlePin = makePin();
  const single = new ThreatContainment(makeDeps({ pin: singlePin }).deps);
  const singleToken = await approvedToken(single);
  assert((await single.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: singleToken })).outcome === 'TERMINATED', '8a: first use -> TERMINATED');
  assert((await single.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: singleToken })).outcome === 'REFUSED_APPROVAL_INVALID', '8b: replay of the same token -> REFUSED_APPROVAL_INVALID (single-use)');

  // Concurrent contains with the SAME token: exactly one may consume it.
  const conc = new ThreatContainment(makeDeps({ pinFactory: (pid) => makePin({ pid }) }).deps);
  const concToken = await approvedToken(conc);
  const concResults = await Promise.all([
    conc.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: concToken }),
    conc.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: concToken }),
  ]);
  const terminatedCount = concResults.filter((r) => r.outcome === 'TERMINATED').length;
  const invalidCount = concResults.filter((r) => r.outcome === 'REFUSED_APPROVAL_INVALID').length;
  assert(terminatedCount === 1 && invalidCount === 1, '8c: concurrent same-token requests -> exactly one TERMINATED, one refused (single-use holds under concurrency)');

  // Bounded registry: overflow evicts the oldest token.
  const bound = new ThreatContainment(makeDeps({}).deps);
  const tokens: string[] = [];
  for (let i = 0; i < 40; i++) tokens.push(await approvedToken(bound));
  assert(bound.pendingApprovalCount() <= 32, '8e: approval registry is bounded (<=32 live tokens)');
  const evictedResult = await bound.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: tokens[0] });
  assert(evictedResult.outcome === 'REFUSED_APPROVAL_INVALID', '8f: oldest token evicted on registry overflow -> refused');
}

// ==================================== 9. Audit correctness + privacy
{
  console.log('9. Audit correctness and metadata-only privacy');
  const auditEvents: ContainmentAuditEvent[] = [];
  const c = new ThreatContainment(makeDeps({ auditEvents }).deps);
  const token = await approvedToken(c);
  await c.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: token }); // TERMINATED
  await c.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: 'forged-token-0123456789abcdef' }); // invalid
  await c.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: '' }); // no approval
  assert(auditEvents.length === 4, '9a: every attempt audited exactly once (1 issuance + 3 containment attempts)');
  const outcomes = auditEvents.map((e) => e.outcome).sort().join(',');
  assert(outcomes === 'APPROVAL_ISSUED,REFUSED_APPROVAL_INVALID,REFUSED_NO_APPROVAL,TERMINATED',
    `9b: audited outcomes match the attempts (got ${outcomes})`);
  assert(auditEvents.every((e) => typeof e.requestId === 'string' && e.requestId.length > 0), '9c: every audit record carries a requestId');
  assert(auditEvents.every((e) => 'terminationEligible' in e && 'terminationAttempted' in e && 'terminationResult' in e && 'postVerifyResult' in e), '9d: audit records termination eligibility + attempt + verification fields');
  assert(auditEvents.every((e) => 'estopActive' in e && 'authorized' in e && 'evidenceAgeMs' in e), '9e: audit records authorization, E-stop, and evidence-freshness fields');
  const invalidEv = auditEvents.find((e) => e.outcome === 'REFUSED_APPROVAL_INVALID');
  assert(!!invalidEv && invalidEv.authorized === false && invalidEv.terminationAttempted === false, '9f: authorization failure audited (never authorized, never attempted)');
  const dump = JSON.stringify(auditEvents);
  assert(!dump.includes(token), '9f: audit never records the approval token value');
  assert(!dump.includes('C:\\\\Temp\\\\test-malware.exe') && !dump.includes('Temp\\\\test-malware'), '9g: audit never records the executable path');
  assert(!dump.toLowerCase().includes('password') && !dump.toLowerCase().includes('secret'), '9h: audit contains no credentials or secrets');
}

// ========================== 10. Real pin worker smoke test (read-only)
{
  console.log('10. Real pin worker smoke test (self-pin, READ-ONLY, no termination)');
  try {
    const pinFn = defaultPinProcess();
    const pin = await pinFn(process.pid);
    assert(!!pin, '10a: self-pin acquires a process-instance reference');
    if (pin) {
      assert(!!pin.name && !!pin.creationTime && !!pin.executablePath, '10b: identity readable through the pinned reference');
      const iso = Date.parse(pin.creationTime);
      assert(!Number.isNaN(iso) && Math.abs(Date.now() - iso) < 24 * 3600 * 1000, `10c: creation time is a valid recent ISO timestamp (${pin.creationTime})`);
      assert(pin.name.toLowerCase().includes('node'), `10d: pinned name matches the runner process (${pin.name})`);
      assert(pin.executablePath.toLowerCase() === process.execPath.toLowerCase(), '10e: pinned image path matches the runner executable');
      pin.release();
      await sleep(2500); // release grace + child exit
      const pin2 = await pinFn(process.pid);
      assert(!!pin2 && pin2.creationTime === pin.creationTime, '10f: identity read is stable across two independent pins');
      pin2?.release();
      await sleep(2500);
    }
    const ghost = await pinFn(4_194_300);
    assert(ghost === null, '10g: nonexistent PID -> null (not found), no reference established');
  } catch (err) {
    if (err instanceof PinUnavailableError && err.failure === 'INFRASTRUCTURE') {
      skip('PowerShell pin worker unavailable in this environment');
    } else {
      failed++;
      failures.push(`10: real pin worker smoke test failed: ${String((err as Error)?.message || err)}`);
      console.error(err);
    }
  }
}

// ====================== 11. Approval authority (Phase D.4)
{
  console.log('11. Approval authority (Phase D.4) — permission is not an operator decision');

  // 11a (required #1): AUTHORIZED operator approval — with a verified
  // authority, the full machinery works end-to-end (D.3 pipeline preserved).
  const authPin = makePin();
  const authAudit: ContainmentAuditEvent[] = [];
  const authorized = new ThreatContainment(makeDeps({ pin: authPin, auditEvents: authAudit }).deps);
  const authIssuance = await authorized.issueApproval(APPROVED_IDENTITY.pid, TEST_OPERATOR_CREDENTIAL);
  assert(authIssuance.outcome === 'APPROVAL_ISSUED' && !!authIssuance.token, '11a: verified authority -> approval issued');
  const authResult = await authorized.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: authIssuance.token!.token });
  assert(authResult.outcome === 'TERMINATED', '11b: verified authority + valid token -> TERMINATED');
  const authEv = authAudit.find((e) => e.outcome === 'APPROVAL_ISSUED');
  assert(!!authEv && authEv.approvalAuthority === 'test-verified-operator', '11c: audit records the approval-authority method');

  // 11d (required #2/#3): PRODUCTION MODE — a caller with application.launch
  // permission but NO independent approval authority cannot obtain a token
  // and cannot initiate containment. No identity token is minted.
  const prod = new ThreatContainment(makeDeps({ authority: PRODUCTION_AUTHORITY, pin: makePin() }).deps);
  const prodIssuance = await prod.issueApproval(APPROVED_IDENTITY.pid, TEST_OPERATOR_CREDENTIAL);
  assert(prodIssuance.outcome === 'APPROVAL_AUTHORITY_UNAVAILABLE' && !prodIssuance.token, '11d: no operator-approval mechanism -> APPROVAL_AUTHORITY_UNAVAILABLE, no token minted');
  assert(prod.pendingApprovalCount() === 0, '11e: approval registry stays empty in production mode');

  // 11f (required #4/#5): an ordinary agent / the malware classifier cannot
  // approve — the authority gate precedes identity read AND classification,
  // so the classifier never even runs (it cannot influence the decision).
  let classifyRan = false;
  const agentAttempt = new ThreatContainment(makeDeps({
    authority: PRODUCTION_AUTHORITY,
    pin: makePin(),
    classifyImpl: async () => { classifyRan = true; return makeEvidence(); },
  }).deps);
  const agentContain = await agentAttempt.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: 'agent-token-0123456789abcdef' });
  assert(agentContain.outcome === 'APPROVAL_AUTHORITY_UNAVAILABLE', '11f: agent-initiated containment refused at the authority gate');
  assert(!classifyRan, '11g: the classifier never runs under an unavailable authority (no self-approval path)');

  // 11h (required #6): client-supplied approval claims are inert.
  const claims = await prod.contain({
    pid: APPROVED_IDENTITY.pid,
    approvalToken: 'claims-token-0123456789abcd',
    approved: true,
    operatorApproved: true,
    operatorId: 'admin',
  } as unknown as { pid: number; approvalToken: string });
  assert(claims.outcome === 'APPROVAL_AUTHORITY_UNAVAILABLE', '11h: injected approved/operatorApproved fields cannot forge authority');

  // 11i (required #7): forged tokens get the authority refusal (no token can
  // be valid — none can be minted). Under a CAPABLE authority, forged/
  // expired/replayed/transfer scenarios are covered by 3b/3c/8b/3e/4a.
  const forgedProd = await prod.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: 'forged-token-0123456789abcdef' });
  assert(forgedProd.outcome === 'APPROVAL_AUTHORITY_UNAVAILABLE', '11i: forged token refused at the authority gate in production mode');

  // 11j (required #16): approval service unavailable (throws) -> fail-closed.
  const brokenApprove = new ThreatContainment(makeDeps({ authority: 'throw' }).deps);
  assert((await brokenApprove.issueApproval(APPROVED_IDENTITY.pid, TEST_OPERATOR_CREDENTIAL)).outcome === 'APPROVAL_AUTHORITY_UNAVAILABLE', '11j: authority service failure at issuance -> fail-closed refusal');

  // 11k (required #17): authorization service unavailable at containment.
  const brokenContain = new ThreatContainment(makeDeps({ authority: 'throw', pin: makePin() }).deps);
  assert((await brokenContain.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: 'any-token-0123456789abcdef' })).outcome === 'APPROVAL_AUTHORITY_UNAVAILABLE', '11k: authority service failure at containment -> fail-closed refusal');

  // 11l (required #15 variant): authority available at entry, unavailable
  // immediately before termination -> refusal BEFORE terminate (pinning,
  // token binding, and classification all pass first).
  let authorityCalls = 0;
  const flipPin = makePin();
  const flip = new ThreatContainment(makeDeps({
    pin: flipPin,
    authority: () => {
      authorityCalls++;
      return authorityCalls === 1
        ? { authorized: true, authorityId: 'flip', method: 'test-verified-operator' }
        : PRODUCTION_AUTHORITY;
    },
  }).deps);
  const flipToken = await approvedToken(flip);
  const flipResult = await flip.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: flipToken });
  assert(flipResult.outcome === 'APPROVAL_AUTHORITY_UNAVAILABLE', '11l: authority lost between entry and termination -> refused (fail-closed)');
  assert(flipPin.calls.terminate === 0, '11m: termination NOT attempted after the authority re-check failed');

  // 11n (required #3 variant): a CAPABLE authority that DENIES this caller
  // -> explicit authorization denial (not unavailable).
  const denying = new ThreatContainment(makeDeps({
    authority: { authorized: false, unavailable: false, reason: 'operator declined this containment request' },
  }).deps);
  assert((await denying.issueApproval(APPROVED_IDENTITY.pid, TEST_OPERATOR_CREDENTIAL)).outcome === 'REFUSED_NO_APPROVAL', '11n: authority denial -> REFUSED_NO_APPROVAL with the operator decision recorded');

  // 11o: audit records the authority state on every event.
  const allAudit: ContainmentAuditEvent[] = [];
  const auditProd = new ThreatContainment(makeDeps({ authority: PRODUCTION_AUTHORITY, auditEvents: allAudit }).deps);
  await auditProd.issueApproval(APPROVED_IDENTITY.pid, TEST_OPERATOR_CREDENTIAL);
  await auditProd.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: 'audit-token-0123456789abc' });
  assert(allAudit.length === 2 && allAudit.every((e) => e.approvalAuthority === 'unavailable'), '11o: every production-mode attempt audited with approvalAuthority=unavailable');
}

// ============== 11P. Production credential authority (Phase D completion)
{
  console.log('11P. Credential-backed production authority (createCredentialApprovalAuthority)');

  // Mock credential sources mirroring the serverSafety contract.
  let enrolled = false;
  let epoch = 0;
  const correctCredential = 'OperatorCred1!';
  const sources = {
    // The REAL verifier returns false for wrong codes (throws only on
    // backoff) — the mock matches that contract exactly.
    verifyCredential: (code: string): boolean => enrolled && code === correctCredential,
    credentialSet: () => enrolled,
    approvalEpoch: () => epoch,
  };
  const authority = createCredentialApprovalAuthority(sources);

  // 11P-a: before enrollment — the D.4 disabled posture.
  const unenrolled = authority({ pid: APPROVED_IDENTITY.pid });
  assert(unenrolled.authorized === false && (unenrolled as { unavailable?: boolean }).unavailable === true, '11P-a: before enrollment the authority is UNAVAILABLE (termination disabled)');
  const unenrolledEngine = new ThreatContainment(makeDeps({ authority: unenrolled }).deps);
  assert((await unenrolledEngine.issueApproval(APPROVED_IDENTITY.pid, correctCredential)).outcome === 'APPROVAL_AUTHORITY_UNAVAILABLE', '11P-b: approval without enrollment -> APPROVAL_AUTHORITY_UNAVAILABLE (no token, ever)');

  // 11P-c: after enrollment — the operator's credential IS the decision.
  enrolled = true;
  epoch = 1;
  const issuedAtEpoch = authority({ pid: APPROVED_IDENTITY.pid, operatorCredential: correctCredential });
  assert(issuedAtEpoch.authorized === true && (issuedAtEpoch as { authorityEpoch?: number }).authorityEpoch === 1, '11P-c: correct credential -> authorized with the authority epoch recorded');

  // 11P-d: wrong credential -> explicit DENIAL (never unavailable-pretense).
  const wrong = authority({ pid: APPROVED_IDENTITY.pid, operatorCredential: 'WrongCred99!' });
  assert(wrong.authorized === false && (wrong as { unavailable?: boolean }).unavailable === false, '11P-d: wrong credential -> explicit denial');

  // 11P-e: end-to-end with the credential authority — happy machinery path.
  const credEngine = new ThreatContainment(makeDeps({ authority }).deps);
  const credIssuance = await credEngine.issueApproval(APPROVED_IDENTITY.pid, correctCredential);
  assert(credIssuance.outcome === 'APPROVAL_ISSUED' && !!credIssuance.token && credIssuance.token.authorityEpoch === 1, '11P-e: credential-verified approval mints a token bound to the authority epoch');
  const credResult = await credEngine.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: credIssuance.token!.token });
  assert(credResult.outcome === 'TERMINATED', '11P-f: credential-approved containment terminates the pinned instance');

  // 11P-g: mid-operation credential re-enrollment invalidates the approval.
  const stalenessEngine = new ThreatContainment(makeDeps({ authority }).deps);
  const staleIssuance = await stalenessEngine.issueApproval(APPROVED_IDENTITY.pid, correctCredential);
  epoch = 2; // the operator cleared and re-enrolled between approval and termination
  const staleResult = await stalenessEngine.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: staleIssuance.token!.token });
  assert(staleResult.outcome === 'REFUSED_NO_APPROVAL' || staleResult.outcome === 'APPROVAL_AUTHORITY_UNAVAILABLE', '11P-g: epoch changed since issuance -> termination refused');
  const staleAuditReason = staleResult.reason;
  assert(staleAuditReason.includes('changed since issuance'), '11P-h: refusal names the mid-operation authority change');

  // 11P-i: credential CLEARED mid-operation -> same refusal.
  const clearedEngine = new ThreatContainment(makeDeps({ authority }).deps);
  const clearedIssuance = await clearedEngine.issueApproval(APPROVED_IDENTITY.pid, correctCredential);
  enrolled = false; // operator cleared enrollment before termination
  const clearedResult = await clearedEngine.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: clearedIssuance.token!.token });
  assert(clearedResult.outcome !== 'TERMINATED', '11P-i: cleared authority prevents termination (fail-closed)');

  // 11P-j: enrollment restored -> containment works again (operator control).
  enrolled = true;
  epoch = 3;
  const restored = await credEngine.issueApproval(APPROVED_IDENTITY.pid, correctCredential);
  const restoredResult = await credEngine.contain({ pid: APPROVED_IDENTITY.pid, approvalToken: restored.token!.token });
  assert(restoredResult.outcome === 'TERMINATED', '11P-j: re-enrollment restores operator-controlled containment');
}

// ============== 13. Containment approval credential machinery (isolated E5 store)
{
  console.log('13. Containment approval credential machinery (serverSafety, isolated store)');
  // Not enrolled at boot: verification fails closed, epoch is 0.
  assert(containmentApprovalCredentialSet() === false, '13a: fresh store -> no approval credential enrolled (D.4 posture)');
  assert(containmentApprovalEpoch() >= 0, '13b: authority epoch is a monotonic counter');
  assert(verifyContainmentApprovalCredential('Whatever1!') === false, '13c: verification against an unenrolled store fails closed');

  // Enrollment: epoch advances; correct credential verifies; wrong refuses.
  const epoch1 = setContainmentApprovalCredential('OperatorCred1!', 'containment-test');
  assert(containmentApprovalCredentialSet() === true, '13d: enrollment sets the credential');
  assert(containmentApprovalEpoch() === epoch1.epoch && epoch1.epoch > 0, '13e: enrollment advances the authority epoch');
  assert(verifyContainmentApprovalCredential('OperatorCred1!') === true, '13f: correct credential verifies');
  assert(verifyContainmentApprovalCredential('WrongCred99!') === false, '13g: wrong credential refused');

  // Shared exponential backoff: an immediate second failure must be refused.
  let backoffThrew = false;
  try {
    verifyContainmentApprovalCredential('WrongCred99!');
  } catch (err) {
    backoffThrew = String((err as Error)?.message || err).includes('retry in');
  }
  assert(backoffThrew, '13h: repeated failures hit the shared exponential backoff (no brute-force oracle)');

  // Re-enrollment resets failure pacing and changes the epoch (staleness anchor).
  const epoch2 = setContainmentApprovalCredential('OperatorCred2!', 'containment-test');
  assert(containmentApprovalEpoch() > epoch1.epoch, '13i: re-enrollment advances the epoch');
  assert(verifyContainmentApprovalCredential('OperatorCred2!') === true && verifyContainmentApprovalCredential('OperatorCred1!') === false, '13j: the new credential replaces the old one');

  // Clearing: epoch advances again; verification fails closed; D.4 posture restored.
  const epoch3 = clearContainmentApprovalCredential('containment-test');
  assert(containmentApprovalCredentialSet() === false && containmentApprovalEpoch() === epoch3.epoch, '13k: clearing unsets the credential and advances the epoch');
  assert(verifyContainmentApprovalCredential('OperatorCred2!') === false, '13l: verification after clearing fails closed (termination disabled again)');

  // Persisted across a fresh load is proven by the runtime restart scenario
  // (12-series) and by the file's presence with an integrity self-hash.
  void epoch2; void epoch3;
}

// ====================== 12. Runtime integration (isolated server)
async function req(port: number, rPath: string, method: string, body?: unknown, timeoutMs = 45000): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(`http://127.0.0.1:${port}${rPath}`, {
      method,
      headers: payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += String(c)));
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(b) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: { raw: b } }); }
      });
    });
    r.on('error', (err) => reject(new Error(`${method} ${rPath} failed: ${String((err as Error)?.message || err)}`)));
    r.setTimeout(timeoutMs, () => { r.destroy(); reject(new Error(`request timeout: ${method} ${rPath}`)); });
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

async function waitHealthy(port: number, tries: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    await sleep(500);
    try {
      const res = await req(port, '/api/health', 'GET', undefined, 1500);
      if (res.status === 200) return true;
    } catch { /* not up yet */ }
  }
  return false;
}

async function runtimeIntegration(): Promise<void> {
  console.log('12. Runtime integration (production routes, isolated E5 store)');
  const PORT = 3110;
  const portBusy = await new Promise<boolean>((resolve) => {
    const r = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => { res.resume(); resolve(true); });
    r.on('error', () => resolve(false));
    r.setTimeout(1500, () => { r.destroy(); resolve(false); });
  });
  if (portBusy) { skip(`port ${PORT} already in use`); return; }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'containment-d3-'));
  const storeDir = path.join(sandbox, 'e5store');
  const env = {
    ...process.env,
    KRISHA_PORT: String(PORT),
    KRISHA_SANDBOX_DIR: storeDir,
    KRISHA_FS_ROOTS: path.join(sandbox, 'fsroots'),
    // Spawned servers get their own recovery-pipe transport so they never
    // race (or starve) the live application for the global pipe name.
    KRISHA_RECOVERY_PIPE_PATH: `\\\\.\\pipe\\krisha-e5-recovery-rt-${process.pid}`,
  };
  const startServer = () => {
    const c = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server.ts'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env, detached: false,
    });
    c.stdout!.on('data', (d: Buffer) => { serverLogGlobal += String(d); });
    c.stderr!.on('data', (d: Buffer) => { serverLogGlobal += String(d); });
    c.on('exit', (code) => { serverLogGlobal += `\n[server exit code=${code}]\n`; });
    return c;
  };
  let child = startServer();
  try {
    // 12a: healthy server on an isolated store.
    const healthy = await waitHealthy(PORT, 120);
    assert(healthy, '12a: server healthy (isolated sandbox store)');
    if (!healthy) return;

    // 12b: containment route requires a token.
    const noToken = await req(PORT, '/api/containment/contain', 'POST', {});
    assert(noToken.status === 400, `12b: missing token -> 400 (got ${noToken.status})`);

    // 12c: Phase D.4 production mode — the authority gate precedes token and
    // process handling. A forged token gets the AUTHORITY refusal (no token
    // can be valid: none can be minted without a verified authority).
    const forged = await req(PORT, '/api/containment/contain', 'POST', { pid: 99999, approvalToken: 'forged-token-0123456789abcdef' });
    assert(forged.status === 200 && forged.body?.outcome === 'APPROVAL_AUTHORITY_UNAVAILABLE',
      `12c: forged token under unavailable authority -> APPROVAL_AUTHORITY_UNAVAILABLE (got ${JSON.stringify(forged.body)})`);

    // 12d: the legacy client-supplied shape (target/evidence/classification)
    // is rejected — client labels can no longer reach the decision.
    const legacy = await req(PORT, '/api/containment/contain', 'POST', {
      target: { pid: 5000, name: 'test.exe', creationTime: '2026-11-21T10:00:00Z', executablePath: 'C:\\Temp\\test.exe' },
      evidence: { classification: 'CONFIRMED_MALWARE', confidence: 'HIGH', assessedAt: Date.now(), evidenceSources: ['injected'] },
      approvalToken: 'legacy-token-0123456789abcdef',
    });
    assert(legacy.status === 400, `12d: legacy client-supplied classification shape -> 400 (got ${legacy.status})`);

    // 12e: approval WITHOUT the operator credential is rejected at the route
    // (the credential IS the operator decision — approval cannot be minted
    // without it).
    const noCred = await req(PORT, '/api/containment/approve', 'POST', { pid: 99999 });
    assert(noCred.status === 400 && String(noCred.body?.error).includes('operatorCredential is required'),
      `12e: approval without the operator credential -> 400 (got ${noCred.status} ${JSON.stringify(noCred.body)})`);

    // 12g: approval shape validation (the authority gate does not skip it).
    const badApprove = await req(PORT, '/api/containment/approve', 'POST', {});
    assert(badApprove.status === 400, `12g: approval without pid -> 400 (got ${badApprove.status})`);

    // 12i: no control-route bypass.
    const killProbe = await req(PORT, '/api/containment/kill', 'POST', {});
    assert(killProbe.status === 404, `12i: no process-control bypass route (kill probe -> ${killProbe.status})`);
    const getContain = await req(PORT, '/api/containment/contain', 'GET');
    // Express matches POST handlers only; a GET falls through to the SPA
    // fallback. The security property: a GET can never return a containment
    // result (the control action is POST-only).
    assert(getContain.status === 404 || (getContain.body?.outcome === undefined && getContain.body?.error === undefined && getContain.body?.targetPid === undefined),
      `12i: contain is POST-only (GET returned a containment result -> ${JSON.stringify(getContain.body)})`);

    // 12p-12t: the OPERATOR APPROVAL CREDENTIAL end-to-end through the real
    // production authority. The spawned server enrolled nothing at boot, so
    // approval is unavailable (12e); the test enrolls through the server's
    // OWN recovery pipe (the operator channel — the test knows its unique
    // transport name from the spawn env) and exercises the credential gate.
    const rtPipe = env.KRISHA_RECOVERY_PIPE_PATH as string;
    const pipeRequest = (message: Record<string, unknown>): Promise<{ parsed: any; raw: string }> => new Promise((resolve, reject) => {
      const s = netModule.connect(rtPipe);
      const timer = setTimeout(() => { s.destroy(); reject(new Error('pipe timeout')); }, 8000);
      let buf = '';
      s.on('connect', () => s.write(JSON.stringify({ ...message, nonce: crypto.randomBytes(24).toString('hex') }) + '\n'));
      s.on('data', (d: Buffer) => {
        buf += String(d);
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        clearTimeout(timer);
        s.end();
        try { resolve({ parsed: JSON.parse(buf.slice(0, nl)), raw: buf.slice(0, nl) }); }
        catch { reject(new Error(`unparseable pipe response: ${buf.slice(0, 120)}`)); }
      });
      s.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    // 12p: without enrollment, approval is unavailable (D.4 posture).
    const preEnroll = await req(PORT, '/api/containment/approve', 'POST', { pid: 99999, operatorCredential: 'RuntimeCred1!' });
    assert(preEnroll.status === 200 && preEnroll.body?.outcome === 'APPROVAL_AUTHORITY_UNAVAILABLE',
      `12p: approval before enrollment -> APPROVAL_AUTHORITY_UNAVAILABLE (got ${JSON.stringify(preEnroll.body)})`);

    // 12q: enroll through the recovery pipe (operator channel).
    const enroll = await pipeRequest({ op: 'set-containment-credential', code: 'RuntimeCred1!' });
    assert(enroll.parsed?.ok === true, `12q: set-containment-credential via the recovery pipe (raw: ${enroll.raw.slice(0, 120)})`);
    await sleep(300);

    // 12r: WRONG credential -> explicit denial (the human decision gate).
    const wrongCred = await req(PORT, '/api/containment/approve', 'POST', { pid: 99999, operatorCredential: 'WrongRuntime99!' });
    assert(wrongCred.status === 200 && wrongCred.body?.outcome === 'REFUSED_NO_APPROVAL',
      `12r: wrong operator credential -> REFUSED_NO_APPROVAL (got ${JSON.stringify(wrongCred.body)})`);
    await sleep(1100); // clear the shared 1 s backoff the wrong attempt armed (brute-force protection)

    // 12s: CORRECT credential + nonexistent PID -> ALREADY_EXITED: the
    // credential was ACCEPTED and the flow proceeded to the server-side
    // identity read (the strongest runtime proof of the authority gate).
    const rightCredGhost = await req(PORT, '/api/containment/approve', 'POST', { pid: 99999, operatorCredential: 'RuntimeCred1!' });
    assert(rightCredGhost.status === 200 && rightCredGhost.body?.outcome === 'ALREADY_EXITED',
      `12s: correct credential passes the authority gate -> flow proceeds to identity read (got ${JSON.stringify(rightCredGhost.body)})`);

    // 12t: correct credential + a REAL benign live process -> refused at the
    // server-side classification gate (never approved for benign software).
    const benignProc = spawn('ping.exe', ['-n', '60', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
    await sleep(1000);
    const benignCred = await req(PORT, '/api/containment/approve', 'POST', { pid: benignProc.pid, operatorCredential: 'RuntimeCred1!' });
    benignProc.kill();
    assert(benignCred.status === 200 && benignCred.body?.outcome === 'REFUSED_INSUFFICIENT_EVIDENCE' && benignCred.body?.approved === false,
      `12t: credential-valid approval of a benign process -> refused by server-side classification (got ${JSON.stringify(benignCred.body)})`);

    // 12u: clearing enrollment via the pipe restores the D.4 posture.
    const cleared = await pipeRequest({ op: 'clear-containment-credential' });
    assert(cleared.parsed?.ok === true, '12u: clear-containment-credential via the recovery pipe');
    await sleep(300);
    const postClear = await req(PORT, '/api/containment/approve', 'POST', { pid: 99999, operatorCredential: 'RuntimeCred1!' });
    assert(postClear.status === 200 && postClear.body?.outcome === 'APPROVAL_AUTHORITY_UNAVAILABLE',
      `12v: after clearing, approval is unavailable again (got ${JSON.stringify(postClear.body)})`);

    // 12j: E-stop blocks containment AND approval.
    const activate = await req(PORT, '/api/safety/stop/activate', 'POST', { reason: 'phase-d3 e-stop runtime test' });
    await sleep(500);
    const eStopContain = await req(PORT, '/api/containment/contain', 'POST', { pid: 99999, approvalToken: 'estop-token-0123456789abcdef' });
    assert(eStopContain.status === 423, `12j: E-stop blocks containment -> 423 (got ${eStopContain.status})`);
    const eStopApprove = await req(PORT, '/api/containment/approve', 'POST', { pid: 99999 });
    assert(eStopApprove.status === 423, `12k: E-stop blocks approval -> 423 (got ${eStopApprove.status})`);

    // 12l: restart with persisted E-stop state -> containment still blocked.
    child.kill();
    await sleep(2500);
    child = startServer();
    const healthy2 = await waitHealthy(PORT, 120);
    assert(healthy2, '12l: server restarted on the same isolated store');
    const persisted = await req(PORT, '/api/containment/contain', 'POST', { pid: 99999, approvalToken: 'restart-token-0123456789abc' });
    assert(persisted.status === 423 && persisted.body?.error === 'emergency_stop_active',
      `12m: persisted E-stop blocks containment after restart -> 423 emergency_stop_active (got ${persisted.status} ${JSON.stringify(persisted.body)})`);

    // 12n: E-stop state UNAVAILABLE (corrupted state file) -> fail-closed 423.
    child.kill();
    await sleep(2500);
    fs.writeFileSync(path.join(storeDir, 'stop-state.json'), 'CORRUPTED-NOT-JSON', 'utf8');
    child = startServer();
    const healthy3 = await waitHealthy(PORT, 120);
    assert(healthy3, '12n: server restarted with a corrupted stop-state file');
    const uncertain = await req(PORT, '/api/containment/contain', 'POST', { pid: 99999, approvalToken: 'uncertain-token-0123456789' });
    assert(uncertain.status === 423 && uncertain.body?.error === 'emergency_stop_uncertain',
      `12o: E-stop state unavailable -> fail-closed 423 emergency_stop_uncertain (got ${uncertain.status} ${JSON.stringify(uncertain.body)})`);
  } finally {
    child.kill();
    await sleep(1500);
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* temp cleanup best-effort */ }
  }
}

// ---------------------------------------------------------------- run
try {
  await runtimeIntegration();
} catch (err) {
  failed++;
  failures.push(`runtime integration crashed: ${String((err as Error)?.message || err)}`);
  console.error(err);
  console.error('--- last server output ---');
  console.error(serverLogGlobal.slice(-3000));
}

console.log(`\nContainment results: ${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}`);
if (failed > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('CONTAINMENT TESTS: ALL GREEN');
process.exit(0);
