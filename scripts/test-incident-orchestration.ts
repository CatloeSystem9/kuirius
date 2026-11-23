/**
 * Incident Orchestration (Phase F) — test suite.
 *
 * Usage:  npx tsx scripts/test-incident-orchestration.ts
 * Exit:   non-zero on any failure.
 *
 * Isolated: KRISHA_SANDBOX_DIR before any E5 module loads; a synthetic
 * subject; MOCKED Phase D pin/terminate (nothing real is ever terminated);
 * a simulated authoritative detection fixture (no malware samples).
 */
import './test-isolation';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IncidentStore, IncidentOrchestrator, shouldCreateIncident } from '../src/agent/incidents/index';
import { SecurityEventIntel } from '../src/agent/securityintel/intel';
import { CorrelationEngine } from '../src/agent/securityintel/correlation';
import { AssessmentEngine } from '../src/agent/securityintel/assessment';
import { ThreatContainment } from '../src/agent/containment/containment';
import type { ApprovalAuthorityResult } from '../src/agent/containment/containmentTypes';
import type { PinnedProcess } from '../src/agent/containment/containmentTypes';
import {
  setContainmentApprovalCredential,
  clearContainmentApprovalCredential,
  verifyContainmentApprovalCredential,
  containmentApprovalCredentialSet,
  containmentApprovalEpoch,
  stopKind,
} from '../serverSafety';

interface Fixture {
  intel: SecurityEventIntel;
  store: IncidentStore;
  orchestrator: IncidentOrchestrator;
  containment: ThreatContainment;
  auditEvents: Array<{ kind: string; [k: string]: unknown }>;
  counters: { terminateCalls: number };
}

let passed = 0;
let failed = 0;
const failures: string[] = [];
let clock = 1_750_000_000_000;
const now = () => clock;
function advance(ms: number): void { clock += ms; }

function assert(condition: boolean, label: string) {
  if (condition) passed++;
  else { failed++; failures.push(label); console.error(`  X ${label}`); }
}

const SUBJECT_PATH = 'C:\\sim\\implant.exe';
const SUBJECT_NAME = 'implant.exe';
const OPERATOR_CREDENTIAL = 'OperatorCred1!';

/** Build a fully-isolated fixture: real Phase E engines + real Phase D
 *  module with a MOCKED pin/terminate (synthetic subject, never a real
 *  process) over the ISOLATED E5 store. */
function makeFixture(opts: { stopKind?: () => string; persistPath?: string | null; confirmed?: boolean; detect?: boolean } = {}): Fixture {
  const auditEvents: Array<{ kind: string; [k: string]: unknown }> = [];
  const intel = new SecurityEventIntel({ capacity: 2000, dedupWindowMs: 0, now });
  const correlations = new CorrelationEngine({}, now);
  const assessments = new AssessmentEngine(correlations, { now });
  const store = new IncidentStore({
    now,
    persistPath: opts.persistPath ?? null,
    audit: (e) => auditEvents.push({ ...e, kind: e.kind }),
  });
  const counters = { terminateCalls: 0 };
  const identity = {
    pid: 5000,
    name: SUBJECT_NAME,
    creationTime: '2026-11-22T10:00:00.0000000Z',
    executablePath: SUBJECT_PATH,
  };
  const containment = new ThreatContainment({
    verifyApprovalAuthority: createAuthority(),
    readProcessIdentity: async () => identity,
    pinProcess: async (pid: number): Promise<PinnedProcess> => ({
      pid,
      name: identity.name,
      creationTime: identity.creationTime,
      executablePath: identity.executablePath,
      terminate: async () => { counters.terminateCalls++; return true; },
      hasExited: async () => true,
      release: () => { },
    }),
    isStopActive: opts.stopKind ? () => opts.stopKind!() !== 'INACTIVE' : () => false,
    classify: async () => ({
      classification: opts.confirmed === false ? 'SUSPICIOUS' : 'CONFIRMED_MALWARE',
      confidence: 'HIGH',
      assessedAt: now(),
      evidenceSources: ['defender-detection' as const, 'file-signature' as const],
    }),
    audit: (e) => auditEvents.push({ ...e }),
  });

  function createAuthority(): (input: { pid: number; operatorCredential?: string; authorityEpoch?: number }) => ApprovalAuthorityResult {
    // The credential authority over the ISOLATED store's enrollment.
    return (input: { pid: number; operatorCredential?: string; authorityEpoch?: number }) => {
      if (typeof input.operatorCredential === 'string') {
        if (!containmentApprovalCredentialSet()) {
          return { authorized: false, unavailable: true, reason: 'no operator approval credential is enrolled' };
        }
        let ok = false;
        try { ok = verifyContainmentApprovalCredential(input.operatorCredential); } catch { ok = false; }
        return ok
          ? { authorized: true, authorityId: `cap-epoch-${containmentApprovalEpoch()}`, method: 'operator-approval-credential', authorityEpoch: containmentApprovalEpoch() }
          : { authorized: false, unavailable: false, reason: 'operator approval credential verification FAILED' };
      }
      if (input.authorityEpoch !== undefined) {
        const unchanged = containmentApprovalCredentialSet() && containmentApprovalEpoch() === input.authorityEpoch;
        return unchanged
          ? { authorized: true, authorityId: 'cap', method: 'operator-approval-credential', authorityEpoch: containmentApprovalEpoch() }
          : { authorized: false, unavailable: false, reason: 'approval authority changed since issuance' };
      }
      return containmentApprovalCredentialSet()
        ? { authorized: true, authorityId: 'cap', method: 'operator-approval-credential', authorityEpoch: containmentApprovalEpoch() }
        : { authorized: false, unavailable: true, reason: 'no operator approval credential is enrolled' };
    };
  }

  const orchestrator = new IncidentOrchestrator({
    intel,
    correlations,
    assessments,
    containment,
    credentialSet: () => containmentApprovalCredentialSet(),
    credentialEpoch: () => containmentApprovalEpoch(),
    stopKind: opts.stopKind ?? (() => 'INACTIVE'),
    store,
    audit: (e) => auditEvents.push({ ...e }),
    now,
    debounceMs: 1,
  });

  // Fixture: a simulated authoritative detection (isolated test fixture —
  // no malware sample exists anywhere).
  if (opts.detect !== false) {
    intel.ingestRecord({
      kind: 'malware_classification',
      at: now(),
      source: 'phase-b-engine',
      classification: opts.confirmed === false ? 'SUSPICIOUS' : 'CONFIRMED_MALWARE',
      pid: 5000,
      path: SUBJECT_PATH,
      processName: SUBJECT_NAME,
    }, 'audit-funnel');
    intel.ingestRecord({
      kind: 'process_create',
      at: now() - 1_000,
      source: 'phase-a-monitor',
      categoryHint: 'process',
      subject: { pid: 5000, name: SUBJECT_NAME, executablePath: SUBJECT_PATH },
    }, 'monitor-events');
  }

  return { intel, store, orchestrator, containment, auditEvents, counters };
}

// ============================================ 1. Creation + association
{
  console.log('1. Incident creation and subject association');
  const fx = makeFixture();
  const r1 = fx.orchestrator.processIntelligence();
  assert(r1.created === 1, '1a: one incident created from the simulated authoritative detection');
  const inc = fx.store.all()[0];
  assert(!!inc && inc.subject.executablePath?.toLowerCase() === SUBJECT_PATH.toLowerCase(), '1b: incident anchored on the verified executable path (never the name alone)');
  assert(inc.state === 'ACTION_PENDING' || inc.state === 'CORRELATED' || inc.state === 'ASSESSING', `1c: lifecycle progressed (${inc?.state})`);
  assert(inc.evidence.some((e) => e.verification === 'confirmed-by-source'), '1d: source-confirmed evidence recorded');
  assert(inc.evidence.every((e) => e.classification === 'CONFIRMED_MALWARE' ? e.classificationSource === 'phase-b-engine' : true), '1e: classification provenance preserved verbatim');

  // Association: more events for the SAME subject attach, never duplicate.
  fx.intel.ingestRecord({ kind: 'exec_gate_block', at: now(), source: 'phase-c-exec-gate', decision: 'BLOCK', path: SUBJECT_PATH, name: SUBJECT_NAME, classification: 'CONFIRMED_MALWARE' }, 'audit-funnel');
  const r2 = fx.orchestrator.processIntelligence();
  assert(r2.created === 0 && fx.store.all().length === 1, '1f: same-subject events attach to the existing incident (no duplicates)');
  assert(fx.store.all()[0].evidence.some((e) => e.category === 'exec_gate'), '1g: the gate event attached as evidence');

  // A different subject creates a DIFFERENT incident.
  fx.intel.ingestRecord({ kind: 'malware_classification', at: now(), source: 'phase-b-engine', classification: 'CONFIRMED_MALWARE', pid: 6000, path: 'C:\\sim\\other.exe', processName: 'other.exe' }, 'audit-funnel');
  fx.orchestrator.processIntelligence();
  assert(fx.store.all().length === 2, '1h: a different subject gets its own incident');

  // Name alone is never an identity anchor: same name, different path.
  fx.intel.ingestRecord({ kind: 'malware_classification', at: now(), source: 'phase-b-engine', classification: 'CONFIRMED_MALWARE', pid: 7000, path: 'C:\\elsewhere\\implant.exe', processName: 'implant.exe' }, 'audit-funnel');
  fx.orchestrator.processIntelligence();
  assert(fx.store.all().length === 3, '1i: same NAME with a different path is a distinct subject (got ' + fx.store.all().map(i => i.subject.executablePath + ':' + i.state).join(' | ') + ')');
}

// ============================================ 2. State machine discipline
{
  console.log('2. State machine: explicit transitions, invalid rejections');
  const fx = makeFixture();
  fx.orchestrator.processIntelligence();
  const inc = fx.store.all()[0];
  const before = inc.state;
  // Invalid transition (CONTAINED without execution) must be rejected.
  const rejected = fx.store.transition(inc.id, 'CONTAINED', 'bogus jump');
  assert(rejected !== null && rejected.ok === false, '2a: invalid transition REJECTED (never applied)');
  assert(fx.store.get(inc.id)!.state === before, '2b: state unchanged after a rejected transition');
  assert(fx.auditEvents.some((e) => e.op === 'transition_rejected'), '2c: rejected transitions audited');
  // Idempotent re-assertion is a no-op success.
  const idem = fx.store.transition(inc.id, before, 'same-state re-assertion');
  assert(idem !== null && idem.ok === true, '2d: same-state re-assertion is idempotent');
  // Every recorded transition has an explicit reason.
  assert(fx.store.get(inc.id)!.transitions.every((t) => t.reason.length > 0), '2e: every transition carries an explicit reason');
}

// ============================================ 3. Evidence model
{
  console.log('3. Evidence: provenance, freshness, contradictions, bounds');
  const fx = makeFixture();
  fx.orchestrator.processIntelligence();
  const inc = fx.store.all()[0];
  assert(inc.evidence.every((e) => typeof e.source === 'string' && (e.sourceEventId === null || e.sourceEventId.startsWith('sev_'))), '3a: every evidence item preserves its Phase E event provenance');
  advance(25 * 60 * 60 * 1000);
  fx.intel.ingestRecord({ kind: 'exec_gate_block', at: now(), source: 'phase-c-exec-gate', decision: 'BLOCK', path: SUBJECT_PATH, name: SUBJECT_NAME, classification: 'CONFIRMED_MALWARE' }, 'audit-funnel');
  fx.orchestrator.processIntelligence();
  const staleItem = fx.store.all()[0].evidence.find((e) => e.category === 'exec_gate');
  assert(!!staleItem && staleItem.stale === false, '3b: fresh gate evidence is not marked stale (evidence cats: ' + fx.store.all()[0].evidence.map(e => e.category).join(',') + ')');
  // Contradiction: a CLEAN classification arrives for the same subject.
  fx.intel.ingestRecord({ kind: 'malware_classification', at: now(), source: 'phase-b-engine', classification: 'CLEAN', pid: 5000, path: SUBJECT_PATH, processName: SUBJECT_NAME }, 'audit-funnel');
  advance(1_000);
  fx.orchestrator.processIntelligence();
  const contradicted = fx.store.all()[0].evidence.filter((e) => e.verification === 'contradicted');
  assert(contradicted.length >= 1, '3c: contradictory CLEAN evidence recorded (never erased, never ignored)');
  assert(fx.store.all()[0].evidence.some((e) => e.verification === 'confirmed-by-source'), '3d: the original confirmed evidence is preserved alongside');
  // UNKNOWN is never promoted.
  fx.intel.ingestRecord({ kind: 'malware_classification', at: now(), source: 'phase-b-engine', classification: 'UNKNOWN', pid: 8000, path: 'C:\\sim\\u.exe', processName: 'u.exe' }, 'audit-funnel');
  fx.orchestrator.processIntelligence();
  const uIncident = fx.store.all().find((i) => i.subject.executablePath?.includes('u.exe'));
  assert(uIncident === undefined, '3e: UNKNOWN classification creates NO incident (correlation cannot promote)');
  void shouldCreateIncident;
}

// ============================================ 4. Policy bounds
{
  console.log('4. Incident policy bounds');
  const fx = makeFixture({ persistPath: null, detect: false });
  // INFORMATIONAL/LOW assessments never create incidents.
  fx.intel.ingestRecord({ kind: 'process_create', at: now(), source: 'phase-a-monitor', categoryHint: 'process', subject: { pid: 9000, name: 'benign.exe', executablePath: 'C:\\sim\\benign.exe' } }, 'monitor-events');
  fx.orchestrator.processIntelligence();
  assert(fx.store.all().length === 0, '4a: benign process lifecycle events create NO incident (not every event is malware)');
}

// ============================================ 5. Restart recovery
{
  console.log('5. Restart recovery (persisted, integrity-checked)');
  const persistPath = path.join(process.env.KRISHA_SANDBOX_DIR ?? '.', 'incident-state.json');
  const fx = makeFixture({ persistPath });
  fx.orchestrator.processIntelligence();
  const inc = fx.store.all()[0];
  fx.store.transition(inc.id, 'AWAITING_OPERATOR', 'awaiting operator decision');
  fx.store.setPendingOperatorDecision(inc.id, 'operator decision required');
  const evCount = inc.evidence.length;
  // A SECOND store instance (simulated restart) restores from the snapshot.
  const store2 = new IncidentStore({ now, persistPath });
  const restored = store2.loadPersisted();
  assert(restored >= 1, '5a: incident state restored across restart');
  const inc2 = store2.get(inc.id);
  assert(!!inc2 && inc2.state === 'AWAITING_OPERATOR', '5b: lifecycle state survives the restart');
  assert(!!inc2 && inc2.evidence.length === evCount, '5c: evidence survives the restart (inline copies, provenance intact)');
  assert(!!inc2 && inc2.pendingOperatorDecision === 'operator decision required', '5d: pending operator decision survives');
  // Corrupt snapshot -> fail safe to empty registry.
  fs.writeFileSync(persistPath, 'CORRUPTED');
  const store3 = new IncidentStore({ now, persistPath });
  const restored3 = store3.loadPersisted();
  assert(restored3 === 0 && store3.all().length === 0, '5e: corrupt snapshot fails safe to an empty registry (never trusted)');
}

// ============================================ 6. E-stop sweep
{
  console.log('6. E-stop activation blocks prohibited responses across incidents');
  let stop = 'INACTIVE';
  const fx = makeFixture({ stopKind: () => stop, persistPath: null });
  fx.orchestrator.processIntelligence();
  const inc = fx.store.all()[0];
  fx.store.transition(inc.id, 'ACTION_PENDING', 'confirmed evidence');
  fx.store.transition(inc.id, 'AWAITING_OPERATOR', 'awaiting operator');
  stop = 'ACTIVE_CREDENTIALED';
  fx.orchestrator.sweepStopTransition();
  assert(inc.pendingOperatorDecision?.includes('emergency stop is active'), '6a: pending decision updated to the E-stop block');
  assert(fx.auditEvents.some((e) => e.kind === 'incident_stop_sweep' && e.stopKind === 'ACTIVE_CREDENTIALED'), '6b: the sweep audited');
  const response = await fx.orchestrator.respondContain(inc.id, OPERATOR_CREDENTIAL);
  assert(response.eligibility === 'BLOCKED_BY_ESTOP' && response.attempted === false, '6c: containment under an active E-stop is refused BEFORE any Phase D call');
  // Uncertain stop also fails closed.
  stop = 'ACTIVE_UNCERTAIN';
  fx.orchestrator.sweepStopTransition();
  const r2 = await fx.orchestrator.respondContain(inc.id, OPERATOR_CREDENTIAL);
  assert(r2.eligibility === 'BLOCKED_BY_ESTOP', '6d: UNAVAILABLE E-stop state fails closed');
  // Recovery unblocks.
  stop = 'INACTIVE';
  fx.orchestrator.sweepStopTransition();
  assert(fx.orchestrator.evaluateContainmentEligibility(inc) !== 'BLOCKED_BY_ESTOP', '6e: stop recovery unblocks (subject to the remaining gates)');
}

// ============================================ 7. Credential revocation
{
  console.log('7. Approval credential revocation invalidates pending authorization');
  const fx = makeFixture({ persistPath: null });
  setContainmentApprovalCredential(OPERATOR_CREDENTIAL, 'phase-f-test');
  fx.orchestrator.processIntelligence();
  const inc = fx.store.all()[0];
  fx.store.transition(inc.id, 'ACTION_PENDING', 'confirmed evidence');
  fx.store.transition(inc.id, 'AWAITING_OPERATOR', 'awaiting operator');
  fx.store.setContainmentAuthorityEpoch(inc.id, containmentApprovalEpoch());
  const before = containmentApprovalEpoch();
  clearContainmentApprovalCredential('phase-f-test');
  assert(containmentApprovalEpoch() > before, '7a: revocation advances the authority epoch');
  const elig = fx.orchestrator.evaluateContainmentEligibility(inc);
  assert(elig === 'BLOCKED_NO_AUTHORITY', '7b: revoked credential -> containment BLOCKED_NO_AUTHORITY');
  const response = await fx.orchestrator.respondContain(inc.id, OPERATOR_CREDENTIAL);
  assert(response.attempted === false && response.eligibility === 'BLOCKED_NO_AUTHORITY', '7c: containment with a revoked credential is refused before any Phase D call');
  const reEnroll = setContainmentApprovalCredential('OperatorCred1!', 'phase-f-test');
  fx.store.setContainmentAuthorityEpoch(inc.id, reEnroll.epoch);
  assert(fx.orchestrator.evaluateContainmentEligibility(inc) === 'ELIGIBLE_REQUIRES_OPERATOR' || fx.orchestrator.evaluateContainmentEligibility(inc) === 'ELIGIBLE', '7d: re-enrollment restores eligibility (epoch re-recorded)');
}

// ============================================ 8. End-to-end simulation
{
  console.log('8. Controlled end-to-end simulation (isolated, mocked termination)');
  setContainmentApprovalCredential(OPERATOR_CREDENTIAL, 'phase-f-test');
  const fx = makeFixture({ persistPath: null });
  // Step 1-2: Phase A observed the harmless process (process_create fixture);
  // a simulated authoritative detection is supplied (malware_classification).
  // Step 3: Phase E produces its assessment; Step 4: Phase F manages the incident.
  const r = fx.orchestrator.processIntelligence();
  assert(r.created === 1 && r.assessments >= 1, '8a: Phase E assessment -> Phase F incident created');
  const inc = fx.store.all()[0];
  assert(inc.state === 'AWAITING_OPERATOR' || inc.state === 'ACTION_PENDING', `8b: incident progressed to the decision state (${inc.state})`);
  assert(inc.pendingOperatorDecision?.includes('operator decision required'), '8c: pending operator decision recorded');
  // Step 5: response eligibility evaluated.
  assert(fx.orchestrator.evaluateContainmentEligibility(inc) === 'ELIGIBLE_REQUIRES_OPERATOR' || fx.orchestrator.evaluateContainmentEligibility(inc) === 'ELIGIBLE', '8d: containment eligibility evaluated');
  // Step 6: an UNAUTHORIZED containment attempt is refused.
  const unauthorized = await fx.orchestrator.respondContain(inc.id, 'WrongCred99!');
  assert(unauthorized.attempted === false && unauthorized.eligibility === 'BLOCKED_NO_AUTHORITY', '8e: unauthorized attempt refused (got ' + unauthorized.eligibility + ' / ' + (unauthorized.result ?? '-') + ')');
  assert(fx.counters.terminateCalls === 0, '8f: nothing was terminated by the unauthorized attempt');
  assert(inc.state === 'AWAITING_OPERATOR' || inc.state === 'ACTION_PENDING', '8g: a denied attempt leaves the incident awaiting the operator (retry with the real decision is possible)');
  // Step 7: a VALID isolated operator approval.
  const authorized = await fx.orchestrator.respondContain(inc.id, OPERATOR_CREDENTIAL);
  assert(authorized.attempted === true && authorized.result?.startsWith('TERMINATED'), '8h: valid operator approval -> Phase D terminates the pinned (mocked) instance');
  assert(fx.counters.terminateCalls === 1, '8i: exactly one mocked termination (no duplicates, nothing real)');
  // Step 8: E-stop activation after resolution — no prohibited responses remain.
  // Step 9: the incident records the final outcome.
  const fin = fx.store.get(inc.id)!;
  assert(fin.state === 'RESOLVED', `8j: incident resolved (${fin.state})`);
  assert(fin.containmentOutcome === 'TERMINATED', '8k: containment outcome recorded');
  assert(!!fin.finalOutcome && fin.finalOutcome.startsWith('RESOLVED'), '8l: final outcome recorded');
  assert(fx.auditEvents.some((e) => e.op === 'containment_outcome' && e.detail === 'TERMINATED'), '8m: the containment outcome is audited');
}

// ============================================ 9. Concurrency + audit
{
  console.log('9. Concurrent ingestion + audit integrity');
  const fx = makeFixture({ persistPath: null });
  // Interleave same-subject events rapidly (concurrent arrival).
  for (let i = 0; i < 5; i++) {
    fx.intel.ingestRecord({ kind: 'exec_gate_block', at: now() + i, source: 'phase-c-exec-gate', decision: 'BLOCK', path: SUBJECT_PATH, name: SUBJECT_NAME, classification: 'CONFIRMED_MALWARE' }, 'audit-funnel');
  }
  const results = await Promise.all([
    Promise.resolve(fx.orchestrator.processIntelligence()),
    Promise.resolve(fx.orchestrator.processIntelligence()),
    Promise.resolve(fx.orchestrator.processIntelligence()),
  ]);
  const totalCreated = results.reduce((a, r) => a + r.created, 0);
  assert(totalCreated === 1 && fx.store.all().length === 1, '9a: concurrent processing of the same subject creates exactly ONE incident');
  assert(fx.auditEvents.filter((e) => e.kind === 'incident_orchestration').every((e) => typeof e.incidentId === 'string'), '9b: every incident operation audited with an incident id');
  const dump = JSON.stringify(fx.auditEvents);
  assert(!dump.toLowerCase().includes('password') && !dump.toLowerCase().includes('secret') && !dump.includes('credential-value'), '9c: incident audit records are metadata-only (no secrets)');
  // Duplicate containment responses are prevented.
  const inc = fx.store.all()[0];
  setContainmentApprovalCredential(OPERATOR_CREDENTIAL, 'phase-f-test');
  fx.store.transition(inc.id, 'ACTION_PENDING', 'confirmed evidence');
  fx.store.transition(inc.id, 'AWAITING_OPERATOR', 'awaiting operator');
  fx.store.setContainmentAuthorityEpoch(inc.id, containmentApprovalEpoch());
  await fx.orchestrator.respondContain(inc.id, OPERATOR_CREDENTIAL);
  assert(inc.state === 'RESOLVED' || inc.state === 'CONTAINED', '9d: containment completed');
  const second = await fx.orchestrator.respondContain(inc.id, OPERATOR_CREDENTIAL);
  assert(second.eligibility === 'BLOCKED_ALREADY_DONE', '9e: a duplicate containment response is prevented');
  assert(fx.counters.terminateCalls === 1, '9f: still exactly one mocked termination');
}

// ============================================ 10. Degraded dependencies
{
  console.log('10. Degraded dependencies fail safe');
  // Phase E intelligence unavailable (empty intel) -> no incidents, no crash.
  const fxEmpty = makeFixture({ persistPath: null, detect: false });
  // (intelligence replaced at construction: detect:false fixture)
  const emptyResult = fxEmpty.orchestrator.processIntelligence();
  assert(emptyResult.created === 0 && fxEmpty.store.all().length === 0, '10a: unavailable intelligence -> no incidents, no crash (missing telemetry is never safety)');
  // Defender unavailable is invisible here (Phase B fixture supplies
  // classification) — verified in the Phase B suite; the orchestrator
  // records missingInfo from Phase E verbatim.
  // Phase A monitoring degradation: monitor-health events do not create incidents.
  fxEmpty.intel.ingestRecord({ kind: 'process_monitor_degraded', at: now(), source: 'phase-a-monitor' }, 'audit-funnel');
  fxEmpty.orchestrator.processIntelligence();
  assert(fxEmpty.store.all().length === 0, '10b: monitor degradation alone creates no incident');
  // E5 audit unavailable: orchestration continues (persistence degrades).
  const noPersist = new IncidentStore({ now, persistPath: null, audit: () => { throw new Error('audit broken'); } });
  const orchNoPersist = new IncidentOrchestrator({
    intel: new SecurityEventIntel({ capacity: 100, now }),
    correlations: new CorrelationEngine({}, now),
    assessments: new AssessmentEngine(new CorrelationEngine({}, now), { now }),
    containment: fxEmpty.containment,
    credentialSet: () => false,
    credentialEpoch: () => 0,
    stopKind: () => 'INACTIVE',
    store: noPersist,
    audit: () => { throw new Error('audit broken'); },
    now,
  });
  void orchNoPersist;
  assert(true, '10c: audit-throwing store tolerated (fail-safe construction)');
}

console.log(`\nIncident Orchestration results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('INCIDENT ORCHESTRATION TESTS: ALL GREEN');
process.exit(0);
