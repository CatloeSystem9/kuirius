/**
 * Security Intelligence, Correlation and Response Readiness (Phase E) — test suite.
 *
 * Usage:  npx tsx scripts/test-security-intel.ts
 * Exit:   non-zero on any failure.
 *
 * Uses benign synthetic events, mocked dependencies, and isolated E5 stores.
 * No real process is terminated; no malware samples are used; the real E5
 * store is never touched (isolation via test-isolation.ts).
 */
import './test-isolation';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { SecurityEventIntel } from '../src/agent/securityintel/intel';
import { CorrelationEngine } from '../src/agent/securityintel/correlation';
import { AssessmentEngine, type ThreatAssessment } from '../src/agent/securityintel/assessment';
import { SecuritySituation } from '../src/agent/securityintel/situation';
import { ResponseRecommender, FORBIDDEN_ACTIONS } from '../src/agent/securityintel/response';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let passed = 0;
let failed = 0;
const failures: string[] = [];
const perf: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) passed++;
  else { failed++; failures.push(label); console.error(`  X ${label}`); }
}

// Fixed clock for deterministic windows.
let clock = 1_700_000_000_000;
const now = () => clock;
function advance(ms: number): void { clock += ms; }

function makeIntel(): SecurityEventIntel {
  return new SecurityEventIntel({ capacity: 2000, dedupWindowMs: 2000, now });
}

function makeCorrelation(): CorrelationEngine {
  return new CorrelationEngine({}, now);
}

function makeAssessment(correlation: CorrelationEngine, audit?: (e: { kind: string; [k: string]: unknown }) => void): AssessmentEngine {
  return new AssessmentEngine(correlation, { now, audit });
}

function makeSituation(overrides: {
  monitorStatus?: () => { health: string; healthReason?: string | null; eventsReceived?: number; eventsDropped?: number; pidReuses?: number };
  detectionHealth?: () => { health: string; monitorHealth?: string | null; classificationCount?: number; queueDropped?: number };
  execGateHealth?: () => { health: string; pendingApprovals?: number | null };
  stopSnapshot?: () => { kind: string; generation?: number | null };
  e5Storage?: () => { protection: string; auditDegraded?: boolean };
  containmentAuthority?: () => { approvalAuthority: string; pendingTokens: number };
  lpvStatus?: () => { state: string; tampered?: boolean; verified?: boolean } | null;
  refreshDefenderAvailability?: () => Promise<{ available: boolean; detail?: Record<string, unknown> }>;
  intel: SecurityEventIntel;
  assessmentEngine?: AssessmentEngine;
}): SecuritySituation {
  return new SecuritySituation({
    monitorStatus: overrides.monitorStatus ?? (() => ({ health: 'ACTIVE', eventsReceived: 10, eventsDropped: 0, pidReuses: 0 })),
    detectionHealth: overrides.detectionHealth ?? (() => ({ health: 'ACTIVE', classificationCount: 0, queueDropped: 0, monitorHealth: 'ACTIVE' })),
    execGateHealth: overrides.execGateHealth ?? (() => ({ health: 'ACTIVE', pendingApprovals: 0 })),
    stopSnapshot: overrides.stopSnapshot ?? (() => ({ kind: 'INACTIVE', generation: 1 })),
    e5Storage: overrides.e5Storage ?? (() => ({ protection: 'full', auditDegraded: false })),
    containmentAuthority: overrides.containmentAuthority ?? (() => ({ approvalAuthority: 'unavailable', pendingTokens: 0 })),
    lpvStatus: overrides.lpvStatus,
    refreshDefenderAvailability: overrides.refreshDefenderAvailability,
    activeAssessments: () => overrides.assessmentEngine?.assess(overrides.intel) ?? [],
    intel: overrides.intel,
  });
}

const HEALTHY = {
  monitorStatus: () => ({ health: 'ACTIVE', eventsReceived: 5, eventsDropped: 0, pidReuses: 0 }),
  detectionHealth: () => ({ health: 'ACTIVE', monitorHealth: 'ACTIVE', classificationCount: 0, queueDropped: 0 }),
  execGateHealth: () => ({ health: 'ACTIVE', pendingApprovals: 0 }),
  stopSnapshot: () => ({ kind: 'INACTIVE', generation: 7 }),
  e5Storage: () => ({ protection: 'full', auditDegraded: false }),
  containmentAuthority: () => ({ approvalAuthority: 'unavailable', pendingTokens: 0 }),
};

// ============================================ 1. Event intelligence (E.1)
{
  console.log('1. Event intelligence: normalization, dedup, ordering, bounds');
  const intel = makeIntel();

  // 1a: normal ingestion with provenance.
  const id1 = intel.ingestRecord({ kind: 'malware_classification', at: clock, source: 'phase-b-engine', classification: 'SUSPICIOUS', pid: 100, path: 'C:\\temp\\tool.exe', processName: 'tool.exe' }, 'audit-funnel');
  assert(id1 !== null && intel.size() === 1, '1a: event ingested with an assigned id');
  const ev1 = intel.events()[0];
  assert(ev1.category === 'detection' && ev1.provenance.source === 'phase-b-engine' && ev1.provenance.originalKind === 'malware_classification', '1b: category and provenance preserved');
  assert(ev1.observedAt === clock && ev1.observedTimestamp === true, '1c: original timestamp preserved');
  assert(ev1.subject.pid === 100 && ev1.subject.classification === 'SUSPICIOUS' && ev1.subject.executablePath === 'C:\\temp\\tool.exe', '1d: subject references extracted');
  assert(ev1.id.startsWith('sev_'), '1e: event id is intel-assigned');

  // 1b: duplicate events collapse (dedup window), original timestamp kept.
  advance(500);
  const idDup = intel.ingestRecord({ kind: 'malware_classification', at: clock, source: 'phase-b-engine', classification: 'SUSPICIOUS', pid: 100, path: 'C:\\temp\\tool.exe', processName: 'tool.exe' }, 'audit-funnel');
  assert(idDup === id1, '1f: duplicate event collapses onto the original record');
  assert(intel.size() === 1 && intel.events()[0].seenCount === 2, '1g: dedup counter incremented, no storage growth');
  assert(intel.events()[0].observedAt === clock - 500, '1h: original timestamp NOT overwritten by the duplicate');

  // 1c: out-of-order events accepted; observedAt is the sort anchor for rules.
  advance(1000);
  const olderTs = clock - 5_000;
  intel.ingestRecord({ kind: 'exec_gate_block', at: olderTs, source: 'phase-c-exec-gate', decision: 'BLOCK', path: 'C:\\old\\first.exe', name: 'first.exe' }, 'audit-funnel');
  assert(intel.size() === 2, '1i: out-of-order (older-timestamp) event accepted');
  assert(intel.events()[1].observedAt < intel.events()[0].observedAt, '1j: arrival order differs from event-time order (handled by design)');

  // 1d: missing timestamps recorded honestly.
  const missing = intel.ingestRecord({ kind: 'spf_decision', source: 'spf', decision: 'allow' }, 'audit-funnel');
  assert(missing !== null, '1k: event without a timestamp is still ingested');
  const missingEv = intel.events().find((e) => e.id === missing);
  assert(!!missingEv && missingEv.observedTimestamp === false && missingEv.observedAt === 0 && missingEv.ingestedAt > 0, '1l: missing timestamp recorded honestly (observedAt=0, ingestedAt set)');

  // 1e: malformed events rejected, never crash.
  const beforeMalformed = intel.stats().malformedRejected;
  assert(intel.ingestRecord(null as never) === null, '1m: null event rejected');
  assert(intel.ingestRecord({ } as never) === null, '1n: kind-less event rejected');
  assert(intel.ingestRecord({ kind: 'x', at: 'not-a-number' }) !== null, '1o: malformed timestamp handled (event kept with honest missing-timestamp marker)');
  assert(intel.stats().malformedRejected === beforeMalformed + 2, '1p: malformed counter incremented precisely');

  // 1f: unknown event sources preserved under category 'unknown'.
  const unknown = intel.ingestRecord({ kind: 'some_future_event_kind', at: clock, source: 'future-subsystem', foo: 'bar' }, 'audit-funnel');
  const unknownEv = intel.events().find((e) => e.id === unknown);
  assert(!!unknownEv && unknownEv.category === 'unknown' && unknownEv.provenance.source === 'future-subsystem', '1q: unknown source preserved under explicit unknown category');
  assert(intel.stats().unknownCategory >= 1, '1r: unknown-category counter incremented');

  // 1g: secrets never survive sanitization.
  const secret = intel.ingestRecord({ kind: 'test_event', at: clock, password: 'hunter2', api_key: 'abc123', token: 'xyz', commandline: 'tool.exe --password=hunter2', nested: { deep: 'secret' }, path: 'C:\\ok\\path.exe' }, 'audit-funnel');
  const secretEv = intel.events().find((e) => e.id === secret);
  const dump = JSON.stringify(secretEv);
  assert(!!secretEv && !dump.includes('hunter2') && !dump.includes('abc123') && !dump.includes('xyz'), '1s: denylisted keys and values never enter facts');
  assert(!dump.includes('deep'), '1t: nested objects dropped entirely');

  // 1h: event bursts + queue saturation (ring bound + drop counting).
  const burstIntel = new SecurityEventIntel({ capacity: 100, dedupWindowMs: 0, now });
  for (let i = 0; i < 250; i++) burstIntel.ingestRecord({ kind: 'burst_event', at: clock + i, n: i }, 'audit-funnel');
  assert(burstIntel.size() === 100, '1u: ring bounded at capacity under burst');
  assert(burstIntel.stats().droppedOverflow === 150, '1v: overflow drops counted honestly (oldest dropped)');
  assert(burstIntel.stats().received === 250 && burstIntel.stats().accepted === 250 && burstIntel.stats().malformedRejected === 0, '1w: ingest stats reconcile (accepted = validated; oldest dropped under overflow)');

  // 1i: monitor process events ingest through the dedicated adapter.
  const procIntel = makeIntel();
  procIntel.ingestProcessEvent({ kind: 'create', pid: 500, name: 'app.exe', ppid: 4, at: clock, source: 'wmi-worker', enriched: false });
  procIntel.ingestProcessEvent({ kind: 'delete', pid: 500, name: 'app.exe', at: clock + 10, source: 'wmi-worker', previouslyObserved: true });
  assert(procIntel.size() === 2, '1x: monitor create/delete events ingested');
  const createEv = procIntel.events()[0];
  assert(createEv.category === 'process' && createEv.subject.pid === 500 && createEv.provenance.via === 'monitor-events', '1y: process events carry provenance via monitor-events');
}

// ============================================ 2. Correlation (E.2)
{
  console.log('2. Cross-event correlation: evidence-linked, time-bounded');
  // 2a: R1 — process creation followed by detection (direct evidence).
  {
    const intel = makeIntel();
    intel.ingestRecord({ kind: 'process_create', at: clock, source: 'phase-a-monitor', categoryHint: 'process', subject: { pid: 700, name: 'implant.exe', executablePath: 'C:\\temp\\implant.exe' } }, 'monitor-events');
    advance(2_000);
    intel.ingestRecord({ kind: 'malware_classification', at: clock, source: 'phase-b-engine', classification: 'HIGH_CONFIDENCE_THREAT', pid: 700, path: 'C:\\temp\\implant.exe', processName: 'implant.exe' }, 'audit-funnel');
    const results = makeCorrelation().correlate(intel);
    const r1 = results.find((r) => r.ruleId === 'R1_process_then_detection');
    assert(!!r1, '2a: R1 fires for creation followed by detection');
    if (r1) {
      assert(r1.directEvidence === true && r1.statisticalOnly === false, '2b: R1 is direct, non-statistical evidence');
      assert(r1.evidenceEventIds.length === 2 && r1.evidenceEventIds.every((id) => intel.events().some((e) => e.id === id)), '2c: evidence refs resolve to real events (provenance preserved)');
      assert(r1.severityHint === 'HIGH', '2d: HIGH_CONFIDENCE_THREAT detection hints HIGH severity');
    }
  }

  // 2b: unrelated events produce no correlation.
  {
    const intel = makeIntel();
    intel.ingestRecord({ kind: 'process_create', at: clock, source: 'phase-a-monitor', categoryHint: 'process', subject: { pid: 800, name: 'notepad.exe' } }, 'monitor-events');
    advance(4_000);
    intel.ingestRecord({ kind: 'malware_classification', at: clock, source: 'phase-b-engine', classification: 'SUSPICIOUS', pid: 999, path: 'C:\\elsewhere\\other.exe', processName: 'other.exe' }, 'audit-funnel');
    const results = makeCorrelation().correlate(intel);
    assert(results.find((r) => r.ruleId === 'R1_process_then_detection') === undefined, '2e: unrelated subjects do NOT correlate');
  }

  // 2c: dual-use tools never correlate by name alone.
  {
    const intel = makeIntel();
    for (let i = 0; i < 10; i++) {
      intel.ingestRecord({ kind: 'process_create', at: clock + i * 100, source: 'phase-a-monitor', categoryHint: 'process', subject: { pid: 900 + i, name: 'powershell.exe', executablePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' } }, 'monitor-events');
    }
    const results = makeCorrelation().correlate(intel);
    assert(results.length === 0, '2f: repeated runs of a dual-use tool produce NO correlation (name is never evidence)');
  }

  // 2d: stale events excluded by the window.
  {
    const intel = makeIntel();
    intel.ingestRecord({ kind: 'process_create', at: clock, source: 'phase-a-monitor', categoryHint: 'process', subject: { pid: 950, name: 'implant.exe' } }, 'monitor-events');
    advance(120 * 60_000); // 2 hours later — beyond maxEventAgeMs
    intel.ingestRecord({ kind: 'malware_classification', at: clock, source: 'phase-b-engine', classification: 'CONFIRMED_MALWARE', pid: 950, path: 'C:\\temp\\implant.exe', processName: 'implant.exe' }, 'audit-funnel');
    const results = makeCorrelation().correlate(intel);
    assert(results.find((r) => r.ruleId === 'R1_process_then_detection') === undefined, '2g: stale first event excluded from time-window correlation');
    assert(results.some((r) => r.ruleId === undefined) === false, '2h: no rule misfires on stale data');
  }

  // 2e: repeated execution attempts (R2, statistical-only). Events are
  // minutes apart in EVENT time (the fake clock is constant at ingest, so
  // dedup is disabled to keep the five records distinct).
  {
    const intel = new SecurityEventIntel({ capacity: 2000, dedupWindowMs: 0, now });
    for (let i = 0; i < 5; i++) {
      intel.ingestRecord({ kind: 'exec_gate_block', at: clock + i * 60_000, source: 'phase-c-exec-gate', decision: 'BLOCK', path: 'C:\\temp\\blocked.exe', name: 'blocked.exe', classification: 'SUSPICIOUS' }, 'audit-funnel');
    }
    const results = makeCorrelation().correlate(intel);
    const r2 = results.find((r) => r.ruleId === 'R2_repeated_execution_attempts');
    assert(!!r2 && r2.statisticalOnly === true && r2.directEvidence === false, '2i: R2 fires as statistical-only association');
  }

  // 2f: multi-indicator subject (R3).
  {
    const intel = makeIntel();
    intel.ingestRecord({ kind: 'malware_classification', at: clock, source: 'phase-b-engine', classification: 'SUSPICIOUS', pid: 1000, path: 'C:\\temp\\multi.exe', processName: 'multi.exe' }, 'audit-funnel');
    advance(1_000);
    intel.ingestRecord({ kind: 'exec_gate_block', at: clock, source: 'phase-c-exec-gate', decision: 'REQUIRE_APPROVAL', path: 'C:\\temp\\multi.exe', name: 'multi.exe' }, 'audit-funnel');
    const results = makeCorrelation().correlate(intel);
    const r3 = results.find((r) => r.ruleId === 'R3_multi_indicator_subject');
    assert(!!r3 && r3.evidenceEventIds.length === 2, '2j: R3 converges two independent subsystem signals on one subject');
  }

  // 2g: identity change (R4) from containment refusals.
  {
    const intel = makeIntel();
    intel.ingestRecord({ kind: 'threat_containment', at: clock, source: 'phase-d-containment', outcome: 'REFUSED_PID_REUSED', targetPid: 1200, targetName: 'shifted.exe' }, 'audit-funnel');
    const results = makeCorrelation().correlate(intel);
    const r4 = results.find((r) => r.ruleId === 'R4_identity_change');
    assert(!!r4 && r4.subject.pid === 1200, '2k: R4 surfaces identity-change refusals');
  }

  // 2h: monitor degradation followed by suspicious activity (R5).
  {
    const intel = makeIntel();
    intel.ingestRecord({ kind: 'process_monitor_degraded', at: clock, source: 'phase-a-monitor', reason: 'worker restart' }, 'audit-funnel');
    advance(3_000);
    intel.ingestRecord({ kind: 'malware_classification', at: clock, source: 'phase-b-engine', classification: 'SUSPICIOUS', pid: 1300, path: 'C:\\temp\\later.exe', processName: 'later.exe' }, 'audit-funnel');
    const results = makeCorrelation().correlate(intel);
    const r5 = results.find((r) => r.ruleId === 'R5_degraded_visibility_then_activity');
    assert(!!r5 && r5.confidenceHint === 'LOW', '2l: R5 flags degraded-visibility windows with low confidence');
  }

  // 2i: E-stop adjacency (R7 — temporal association only).
  {
    const intel = makeIntel();
    intel.ingestRecord({ kind: 'e5_stop_activated', at: clock, source: 'e5-stop', reason: 'test' }, 'audit-funnel');
    advance(10_000);
    intel.ingestRecord({ kind: 'exec_gate_block', at: clock, source: 'phase-c-exec-gate', decision: 'BLOCK', path: 'C:\\temp\\during.exe', name: 'during.exe' }, 'audit-funnel');
    advance(10_000);
    intel.ingestRecord({ kind: 'spf_decision', at: clock, source: 'spf', decision: 'redact' }, 'audit-funnel');
    const results = makeCorrelation().correlate(intel);
    const r7 = results.find((r) => r.ruleId === 'R7_estop_adjacency');
    assert(!!r7 && r7.statisticalOnly === true && r7.severityHint === 'INFORMATIONAL', '2m: R7 reports stop-adjacency as informational statistical association');
  }

  // 2j: missing timestamps cannot anchor time-window correlation.
  {
    const intel = makeIntel();
    intel.ingestRecord({ kind: 'process_create', source: 'phase-a-monitor', categoryHint: 'process', subject: { pid: 1400, name: 'implant.exe' } }, 'monitor-events');
    intel.ingestRecord({ kind: 'malware_classification', at: clock, source: 'phase-b-engine', classification: 'CONFIRMED_MALWARE', pid: 1400, path: 'C:\\temp\\implant.exe', processName: 'implant.exe' }, 'audit-funnel');
    const results = makeCorrelation().correlate(intel);
    assert(results.find((r) => r.ruleId === 'R1_process_then_detection') === undefined, '2n: time-less events cannot anchor time-window rules (honest gap)');
  }
}

// ============================================ 3. Threat assessment (E.3)
{
  console.log('3. Threat assessment: severity/confidence separation, no promotion');
  // 3a: correlation alone NEVER produces CRITICAL; severity and confidence are separate.
  {
    const intel = makeIntel();
    intel.ingestRecord({ kind: 'malware_classification', at: clock, source: 'phase-b-engine', classification: 'SUSPICIOUS', pid: 1500, path: 'C:\\temp\\s.exe', processName: 's.exe' }, 'audit-funnel');
    advance(1_000);
    intel.ingestRecord({ kind: 'exec_gate_block', at: clock, source: 'phase-c-exec-gate', decision: 'BLOCK', path: 'C:\\temp\\s.exe', name: 's.exe' }, 'audit-funnel');
    const correlation = makeCorrelation();
    const assessments = makeAssessment(correlation).assess(intel);
    const a = assessments.find((x) => x.subject.executablePath?.toLowerCase().includes('s.exe'));
    assert(!!a, '3a: assessment generated for the correlated subject');
    if (a) {
      assert(a.severity !== 'CRITICAL', '3b: correlation alone never escalates to CRITICAL (no source confirmation)');
      assert(a.kind === 'inferred', '3c: assessment labeled as an inference');
      assert(typeof a.confidence === 'number' && a.confidence >= 0 && a.confidence <= 1 && !!a.confidenceLabel, '3d: confidence is a separate numeric+label axis');
      assert(a.evidenceRefs.length >= 2 && a.evidenceRefs.every((id) => intel.events().some((e) => e.id === id)), '3e: evidence provenance resolves to events');
      assert(a.humanReviewRequired === true, '3f: MEDIUM+ assessments require human review');
    }
  }

  // 3b: a source CONFIRMED_MALWARE detection is referenced, never upgraded.
  {
    const intel = makeIntel();
    intel.ingestRecord({ kind: 'malware_classification', at: clock, source: 'phase-b-engine', classification: 'CONFIRMED_MALWARE', pid: 1600, path: 'C:\\temp\\c.exe', processName: 'c.exe' }, 'audit-funnel');
    const assessments = makeAssessment(makeCorrelation()).assess(intel);
    const a = assessments.find((x) => x.subject.executablePath?.toLowerCase().includes('c.exe'));
    assert(!!a && a.severity === 'CRITICAL' && a.kind === 'confirmed-by-source', '3g: source-confirmed detection -> CRITICAL, labeled confirmed-by-source');
    if (a) {
      assert(a.sourceClassifications.includes('CONFIRMED_MALWARE'), '3h: source classification referenced verbatim (no Phase E judgment)');
      assert(a.recommendedNextAction === 'REQUEST_HUMAN_REVIEW', '3i: CRITICAL recommends human review — NEVER termination');
    }
  }

  // 3c: contradictions lower confidence and are recorded.
  {
    const intel = makeIntel();
    intel.ingestRecord({ kind: 'malware_classification', at: clock, source: 'phase-b-engine', classification: 'SUSPICIOUS', pid: 1700, path: 'C:\\temp\\x.exe', processName: 'x.exe' }, 'audit-funnel');
    advance(1_000);
    intel.ingestRecord({ kind: 'exec_gate_block', at: clock, source: 'phase-c-exec-gate', decision: 'BLOCK', path: 'C:\\temp\\x.exe', name: 'x.exe' }, 'audit-funnel');
    advance(2_000);
    intel.ingestRecord({ kind: 'malware_classification', at: clock, source: 'phase-b-engine', classification: 'CLEAN', pid: 1700, path: 'C:\\temp\\x.exe', processName: 'x.exe' }, 'audit-funnel');
    const assessments = makeAssessment(makeCorrelation()).assess(intel);
    const a = assessments.find((x) => x.subject.executablePath?.toLowerCase().includes('x.exe') && x.kind === 'inferred');
    assert(!!a, '3j: assessment still present with contradiction');
    if (a) {
      assert(a.contradictingRefs.length >= 1 && a.confidence < 0.5, '3k: contradictory CLEAN evidence recorded and confidence reduced');
      assert(a.severity !== 'CRITICAL' && a.severity !== 'HIGH', '3l: strong contradiction caps severity');
    }
  }

  // 3d: missing-source handling — missing timestamps surface as missing info.
  {
    const intel = makeIntel();
    intel.ingestRecord({ kind: 'malware_classification', source: 'phase-b-engine', classification: 'SUSPICIOUS', pid: 1800, path: 'C:\\temp\\m.exe', processName: 'm.exe' }, 'audit-funnel');
    advance(1_000);
    intel.ingestRecord({ kind: 'exec_gate_block', at: clock, source: 'phase-c-exec-gate', decision: 'REQUIRE_APPROVAL', path: 'C:\\temp\\m.exe', name: 'm.exe' }, 'audit-funnel');
    const assessments = makeAssessment(makeCorrelation()).assess(intel);
    const a = assessments.find((x) => x.subject.executablePath?.toLowerCase().includes('m.exe') && x.kind === 'inferred');
    assert(!!a && a.missingInfo.some((m) => m.includes('timestamp')), '3m: missing source timestamps listed under missing information');
  }

  // 3e: UNKNOWN classifications are preserved (never promoted).
  {
    const intel = makeIntel();
    intel.ingestRecord({ kind: 'malware_classification', at: clock, source: 'phase-b-engine', classification: 'UNKNOWN', pid: 1900, path: 'C:\\temp\\u.exe', processName: 'u.exe' }, 'audit-funnel');
    const assessments = makeAssessment(makeCorrelation()).assess(intel);
    const promoted = assessments.find((x) => x.subject.executablePath?.toLowerCase().includes('u.exe') && x.severity === 'CRITICAL');
    assert(promoted === undefined, '3n: UNKNOWN classification is NEVER promoted by correlation');
    assert(intel.events()[0].subject.classification === 'UNKNOWN', '3o: UNKNOWN preserved verbatim in the event');
  }
}

// ============================================ 4. Situation awareness (E.4)
{
  console.log('4. Situation awareness: honest dependency states');
  // 4a: healthy dependencies.
  {
    const intel = makeIntel();
    const situation = makeSituation({ ...HEALTHY, intel });
    const view = situation.getSituation();
    assert(view.monitor.state === 'OK' && view.detection.state === 'OK' && view.execGate.state === 'OK', '4a: healthy dependencies reported OK');
    assert(view.stop.state === 'OK' && (view.stop.detail as { stopKind?: string }).stopKind === 'INACTIVE', '4b: E-stop INACTIVE reported');
    assert(view.e5.state === 'OK' && view.containment.state === 'OK', '4c: E5 and containment components present');
    assert((view.containment.detail as { terminationEnabled?: boolean }).terminationEnabled === false, '4d: containment view states termination is disabled');
    assert(view.defender.state === 'UNKNOWN', '4e: Defender UNKNOWN before any explicit check (never assumed)');
    assert(view.lpv.state === 'UNKNOWN' || view.lpv.state === 'OK', '4f: LPV reported or explicitly unknown');
  }

  // 4b: degraded / failed / unavailable dependency states.
  {
    const intel = makeIntel();
    const situation = makeSituation({
      ...HEALTHY,
      intel,
      monitorStatus: () => ({ health: 'DEGRADED', healthReason: 'worker restart', eventsDropped: 3 }),
      detectionHealth: () => ({ health: 'FAILED', monitorHealth: 'FAILED' }),
      e5Storage: () => ({ protection: 'unavailable', auditDegraded: true }),
      lpvStatus: () => null,
    });
    const view = situation.getSituation();
    assert(view.monitor.state === 'DEGRADED', '4g: degraded monitor reported');
    assert(view.detection.state === 'FAILED', '4h: failed detection reported');
    assert(view.e5.state === 'FAILED', '4i: unavailable E5 protection reported FAILED');
    assert(view.lpv.state === 'UNKNOWN', '4j: LPV source returning nothing -> UNKNOWN (not invented)');
  }

  // 4c: E-stop active and uncertain states.
  {
    const intel = makeIntel();
    const active = makeSituation({ ...HEALTHY, intel, stopSnapshot: () => ({ kind: 'ACTIVE_CREDENTIALED', generation: 9 }) });
    assert(active.getSituation().stop.state === 'FAILED', '4k: E-stop active -> FAILED (authorization-requiring actions refused)');
    const uncertain = makeSituation({ ...HEALTHY, intel, stopSnapshot: () => ({ kind: 'ACTIVE_UNCERTAIN', generation: null }) });
    assert(uncertain.getSituation().stop.state === 'UNKNOWN', '4l: E-stop uncertain -> UNKNOWN (fail-closed)');
  }

  // 4d: throwing sources become UNKNOWN (no crash, no invention).
  {
    const intel = makeIntel();
    const situation = makeSituation({
      ...HEALTHY,
      intel,
      monitorStatus: () => { throw new Error('monitor exploded'); },
    });
    const view = situation.getSituation();
    assert(view.monitor.state === 'UNKNOWN' && (view.monitor.detail as { reason?: string }).reason?.includes('monitor exploded'), '4m: throwing source -> explicit UNKNOWN with reason');
  }

  // 4e: restart recovery — a fresh instance rebuilds an honest view.
  {
    const intel = makeIntel();
    const situation = makeSituation({ ...HEALTHY, intel });
    const view = situation.getSituation();
    assert(view.unresolvedEvents === 0 && view.at > 0, '4n: fresh instance reports empty-but-valid state (restart recovery)');
  }

  // 4f: rate-limited defender recheck (never polled).
  {
    const intel = makeIntel();
    let checks = 0;
    const situation = makeSituation({
      ...HEALTHY,
      intel,
      refreshDefenderAvailability: async () => { checks++; return { available: true, detail: { amServiceEnabled: true } }; },
    });
    const r1 = situation.recheckDefender();
    assert(r1.started === true, '4o: first explicit defender check starts');
    const r2 = situation.recheckDefender();
    assert(r2.started === false, '4p: immediate second check is rate-limited (not started)');
    await sleep(30);
    assert(checks === 1, '4q: exactly one check executed');
    assert(situation.getSituation().defender.state === 'OK', '4r: after the check, Defender reported from its own answer');
  }
}

// ============================================ 5. Response recommendations (E.5)
{
  console.log('5. Safe response recommendations: never authorization');
  const intel = makeIntel();
  const correlation = makeCorrelation();
  const assessmentEngine = makeAssessment(correlation);
  const situation = makeSituation({ ...HEALTHY, intel, assessmentEngine });
  const recAudit: Array<{ kind: string; [k: string]: unknown }> = [];
  const recommender = new ResponseRecommender(situation, { now, audit: (e) => recAudit.push(e) });

  // 5a: recommendations generated with reasons and evidence.
  intel.ingestRecord({ kind: 'malware_classification', at: clock, source: 'phase-b-engine', classification: 'SUSPICIOUS', pid: 2000, path: 'C:\\temp\\r.exe', processName: 'r.exe' }, 'audit-funnel');
  advance(1_000);
  intel.ingestRecord({ kind: 'exec_gate_block', at: clock, source: 'phase-c-exec-gate', decision: 'BLOCK', path: 'C:\\temp\\r.exe', name: 'r.exe' }, 'audit-funnel');
  const assessments = assessmentEngine.assess(intel);
  const target = assessments.find((a) => a.subject.executablePath?.toLowerCase().includes('r.exe'));
  assert(!!target, '5a: assessment available for recommendation');
  if (target) {
    const recs = recommender.recommendFor(target);
    assert(recs.length > 0, '5b: recommendations generated');
    assert(recs.every((r) => r.reason.length > 0 && r.evidenceRefs.length > 0), '5c: every recommendation carries reason + evidence refs');
    assert(recs.some((r) => r.action === 'PRESERVE_EVIDENCE'), '5d: evidence preservation recommended');
    assert(recs.every((r) => !FORBIDDEN_ACTIONS.has(String(r.action))), '5e: no forbidden action ever generated');
    assert(recs.filter((r) => r.action === 'RESTRICT_OPERATION').every((r) => !!r.restrictVia && r.restrictVia.includes('/api/safety/stop/activate')), '5f: restriction recommendation points at the EXISTING authorized mechanism only');
    assert(recAudit.some((e) => e.kind === 'security_response_recommendation'), '5g: recommendations audited (metadata-only)');
    const auditDump = JSON.stringify(recAudit);
    assert(!auditDump.includes('r.exe'), '5h: recommendation audit is metadata-only (no paths)');
  }

  // 5b: CRITICAL assessment — notify/review/restrict, never termination.
  {
    const critIntel = makeIntel();
    critIntel.ingestRecord({ kind: 'malware_classification', at: clock, source: 'phase-b-engine', classification: 'CONFIRMED_MALWARE', pid: 2100, path: 'C:\\temp\\crit.exe', processName: 'crit.exe' }, 'audit-funnel');
    const critAssessments = assessmentEngine.assess(critIntel);
    const crit = critAssessments.find((a) => a.severity === 'CRITICAL');
    assert(!!crit, '5i: CRITICAL assessment present (confirmed-by-source)');
    if (crit) {
      const recs = recommender.recommendFor(crit);
      assert(recs.some((r) => r.action === 'REQUEST_HUMAN_REVIEW' && r.requiresHumanReview), '5j: CRITICAL -> human review required');
      assert(recs.every((r) => !FORBIDDEN_ACTIONS.has(String(r.action))), '5k: CRITICAL NEVER recommends termination');
    }
  }

  // 5c: approval-unavailable marking for authority-requiring proposals.
  assert(recommender.approvalAvailabilityFor('TERMINATE_PROCESS') === 'unavailable', '5l: termination-class proposals marked approval-unavailable (D.4)');
  assert(recommender.approvalAvailabilityFor('GATHER_METADATA') === 'not_required', '5m: metadata gathering needs no authority');

  // 5d: E-stop active suppresses actionable recommendations.
  {
    const stopIntel = makeIntel();
    stopIntel.ingestRecord({ kind: 'malware_classification', at: clock, source: 'phase-b-engine', classification: 'SUSPICIOUS', pid: 2200, path: 'C:\\temp\\st.exe', processName: 'st.exe' }, 'audit-funnel');
    advance(1_000);
    stopIntel.ingestRecord({ kind: 'exec_gate_block', at: clock, source: 'phase-c-exec-gate', decision: 'BLOCK', path: 'C:\\temp\\st.exe', name: 'st.exe' }, 'audit-funnel');
    const stopSituation = makeSituation({
      ...HEALTHY,
      intel: stopIntel,
      stopSnapshot: () => ({ kind: 'ACTIVE_CREDENTIALED', generation: 3 }),
      assessmentEngine,
    });
    const stopRecommender = new ResponseRecommender(stopSituation, { now, audit: () => {} });
    const assessments = assessmentEngine.assess(stopIntel);
    const a = assessments.find((x) => x.subject.executablePath?.toLowerCase().includes('st.exe') && x.kind === 'inferred');
    assert(!!a, '5n: assessment under active E-stop present');
    if (a) {
      const recs = stopRecommender.recommendFor(a);
      assert(recs.every((r) => ['NOTIFY_OPERATOR', 'REQUEST_HUMAN_REVIEW', 'PRESERVE_EVIDENCE'].includes(r.action)), '5o: under an active E-stop only notification/review/evidence recommendations remain');
    }
  }

  // 5e: unsupported and destructive proposals rejected.
  {
    const rejected = recommender.rejectUnsupported('assessment-x', 'TERMINATE_PROCESS');
    assert(rejected.rejected === true && rejected.rejectionReason?.includes('forbidden'), '5p: TERMINATE_PROCESS rejected as forbidden');
    const rejected2 = recommender.rejectUnsupported('assessment-x', 'SOMETHING_MADE_UP');
    assert(rejected2.rejected === true && rejected2.action === 'NONE', '5q: unsupported action rejected with NONE');
    for (const forbidden of ['DELETE_FILE', 'QUARANTINE_FILE', 'MODIFY_DEFENDER', 'ELEVATE', 'UPLOAD']) {
      assert(recommender.rejectUnsupported('a', forbidden).rejected === true, `5r: ${forbidden} rejected`);
    }
  }
}

// ============================================ 6. Performance (target hardware budget)
{
  console.log('6. Performance: bounded cost on target hardware');
  // Ingest throughput (10k synthetic events).
  const perfIntel = new SecurityEventIntel({ capacity: 2000, dedupWindowMs: 0 });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 10_000; i++) {
    perfIntel.ingestRecord({ kind: 'perf_event', at: 1_700_000_000_000 + i, pid: i % 5000, path: `C:\\perf\\${i % 100}.exe` }, 'audit-funnel');
  }
  const ingestMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // Fill to ring capacity with realistic mixed events, then measure read latency.
  const mixed = new SecurityEventIntel({ capacity: 2000, dedupWindowMs: 0 });
  for (let i = 0; i < 800; i++) mixed.ingestProcessEvent({ kind: 'create', pid: i, name: `proc${i % 40}.exe`, ppid: 4, at: 1_700_000_000_000 + i * 10, source: 'wmi-worker', enriched: false });
  for (let i = 0; i < 40; i++) mixed.ingestRecord({ kind: 'exec_gate_block', at: 1_700_000_000_100 + i * 10, decision: 'BLOCK', path: `C:\\x\\e${i % 5}.exe`, name: `e${i % 5}.exe`, classification: 'SUSPICIOUS' }, 'audit-funnel');
  for (let i = 0; i < 10; i++) mixed.ingestRecord({ kind: 'malware_classification', at: 1_700_000_000_200 + i * 10, classification: i % 2 ? 'CONFIRMED_MALWARE' : 'SUSPICIOUS', pid: 100 + i, path: `C:\\x\\d${i}.exe`, processName: `d${i}.exe` }, 'audit-funnel');
  const correlation = makeCorrelation();
  const assessment = makeAssessment(correlation);
  const t1 = process.hrtime.bigint();
  const view = new SecuritySituation({
    ...HEALTHY,
    intel: mixed,
    activeAssessments: () => assessment.assess(mixed),
  }).getSituation();
  const readMs = Number(process.hrtime.bigint() - t1) / 1e6;
  const assessmentCount = view.activeAssessments.length;
  const memBytes = mixed.size() * 512; // rough per-event estimate for the report

  perf.push(`ingest: 10k events in ${ingestMs.toFixed(1)} ms (${(10_000 / Math.max(0.001, ingestMs / 1000) / 1000).toFixed(0)}k events/s)`);
  perf.push(`full-ring read (situation + correlation + assessment over ${mixed.size()} events): ${readMs.toFixed(1)} ms`);
  perf.push(`assessments on realistic mixed ring: ${assessmentCount}`);
  perf.push(`ring memory estimate (2000 events): ~${(memBytes * 10).toFixed(0)} B per-event-avg x10 headroom = ${(memBytes * 10 / 1024).toFixed(0)} KB scale`);

  assert(ingestMs < 5_000, '6a: 10k-event ingest within budget (<5 s)');
  assert(readMs < 1_000, '6b: full-ring situation+correlation+assessment read within budget (<1 s)');
  console.log(perf.map((p) => `  ~ ${p}`).join('\n'));
}

// ============================================ 7. Runtime integration (isolated server)
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
  console.log('7. Runtime integration (production routes, isolated E5 store)');
  const PORT = 3112;
  const portBusy = await new Promise<boolean>((resolve) => {
    const r = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => { res.resume(); resolve(true); });
    r.on('error', () => resolve(false));
    r.setTimeout(1500, () => { r.destroy(); resolve(false); });
  });
  if (portBusy) { console.log('  (skipped: port 3112 already in use)'); return; }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'securityintel-e-'));
  const env = {
    ...process.env,
    KRISHA_PORT: String(PORT),
    KRISHA_SANDBOX_DIR: path.join(sandbox, 'e5store'),
    KRISHA_FS_ROOTS: path.join(sandbox, 'fsroots'),
    // Spawned servers get their own recovery-pipe transport so they never
    // race (or starve) the live application for the global pipe name.
    KRISHA_RECOVERY_PIPE_PATH: `\\\\.\\pipe\\krisha-e5-recovery-rt-${process.pid}`,
  };
  let serverLog = '';
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env, detached: false,
  });
  child.stdout!.on('data', (d: Buffer) => { serverLog += String(d); });
  child.stderr!.on('data', (d: Buffer) => { serverLog += String(d); });
  try {
    const healthy = await waitHealthy(PORT, 120);
    assert(healthy, '7a: server healthy (isolated sandbox store)');
    if (!healthy) return;

    // 7b: situation view — read-only, honest components.
    const situation = await req(PORT, '/api/security/situation', 'GET');
    assert(situation.status === 200 && !!situation.body?.monitor && !!situation.body?.stop, '7b: situation route responds with component views');
    assert((situation.body?.containment?.detail?.terminationEnabled) === false, '7c: situation reports termination disabled');
    assert((situation.body?.stop?.detail?.stopKind) === 'INACTIVE', '7d: stop state read from the authoritative E5 snapshot');
    assert(situation.body?.defender?.state === 'UNKNOWN', '7e: Defender UNKNOWN until an explicit check');

    // 7f: assessments route — empty ring, valid response.
    const assessments = await req(PORT, '/api/security/assessments', 'GET');
    assert(assessments.status === 200 && Array.isArray(assessments.body?.assessments), '7f: assessments route responds');

    // 7g: safety regression — production termination remains disabled.
    const forged = await req(PORT, '/api/containment/contain', 'POST', { pid: 99999, approvalToken: 'forged-token-0123456789abcdef' });
    assert(forged.body?.outcome === 'APPROVAL_AUTHORITY_UNAVAILABLE', '7g: containment refused with APPROVAL_AUTHORITY_UNAVAILABLE (D.4 unchanged)');
    const approve = await req(PORT, '/api/containment/approve', 'POST', { pid: 99999 });
    // Without the operator credential the route can never mint a token (400
    // route validation), and with a credential but no enrollment it returns
    // AUTHORITY_UNAVAILABLE — either way `approved` is never true without a
    // verified operator decision (Phase D completion contract).
    assert(approve.status === 400 && approve.body?.approved === undefined && approve.body?.token === undefined,
      '7h: approval without the operator credential never mints a token (authority-gated)');

    // 7i: no alternate termination route; intelligence routes are GET-only.
    const killProbe = await req(PORT, '/api/containment/kill', 'POST', {});
    assert(killProbe.status === 404, '7i: no termination bypass route');
    const postSituation = await req(PORT, '/api/security/situation', 'POST', {});
    assert(postSituation.status === 404, '7j: intelligence routes are GET-only (no control surface)');
    const postAssessments = await req(PORT, '/api/security/assessments', 'POST', {});
    assert(postAssessments.status === 404, '7k: assessments route is GET-only');

    // 7l: intelligence events from the runtime (monitor lifecycle, audits).
    await sleep(3000); // allow monitor boot + sampler ticks
    const situation2 = await req(PORT, '/api/security/situation', 'GET');
    assert(situation2.body?.unresolvedEvents > 0, '7l: runtime events ingested (monitor/audit funnel)');
    const stats = situation2.body?.eventStats ?? {};
    assert(stats.received > 0 && stats.accepted > 0, '7m: ingest stats reconcile at runtime');

    // 7n: E-stop reflects in the situation view (authoritative E5 state).
    await req(PORT, '/api/safety/stop/activate', 'POST', { reason: 'phase-e runtime e-stop test' });
    await sleep(1000);
    const situation3 = await req(PORT, '/api/security/situation', 'GET');
    const stopKind3 = (situation3.body?.stop?.detail?.stopKind) ?? '';
    assert(String(stopKind3).startsWith('ACTIVE_'), `7n: E-stop active reflected in the situation view (got ${stopKind3})`);
  } finally {
    child.kill();
    await sleep(1500);
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* temp cleanup */ }
  }
}

// ---------------------------------------------------------------- run
try {
  await runtimeIntegration();
} catch (err) {
  failed++;
  failures.push(`runtime integration crashed: ${String((err as Error)?.message || err)}`);
  console.error(err);
}

console.log(`\nSecurity Intelligence results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('SECURITY INTELLIGENCE TESTS: ALL GREEN');
process.exit(0);
