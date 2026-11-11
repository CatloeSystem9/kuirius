/**
 * E5 H4 — Runtime integrity monitoring.
 *
 * A lightweight, server-owned health evaluator that DERIVES the persistence
 * health state from the existing H3 verification primitives:
 *   - verifyAuditChain()            (audit chain / torn lines / segments)
 *   - journalIntegrityCheck()       (malformed lines / compaction artifact)
 *   - scanQuarantineIntegrity()     (bounded rotating page — full coverage
 *                                    over successive ticks, never a full
 *                                    continuous scan)
 *   - stopKind() / getStorageInfo() (uncertain stop state / storage loss)
 *
 * State model (derived, never persisted — every restart re-derives from disk,
 * so unresolved failures re-appear after restart):
 *   UNAVAILABLE        protected storage missing/unreadable
 *   ACTIVE_UNCERTAIN   stop state could not be validated (existing semantics)
 *   INTEGRITY_FAILURE  verified evidence of corruption (audit chain break,
 *                      malformed journal, quarantine metadata corruption,
 *                      association conflicts)
 *   DEGRADED           integrity intact but anomalies exist (orphans, temp
 *                      artifacts, journal-unlinked entries, compaction tmp)
 *                      — or verification itself was partially unavailable
 *                      (a monitoring failure is NEVER reported as healthy)
 *   HEALTHY            all bounded checks passed
 *
 * Response policy: the monitor REPORTS. It performs no repair, no release,
 * no deletion, no stop changes. Destructive authority operations keep their
 * existing fail-closed gates (rollback refuses on journal/audit integrity
 * failure; quarantine restore refuses per-item; UNCERTAIN refuses mutations).
 *
 * Resource bounds (i3-1005G1 / 8 GB target): one evaluation reads the audit
 * file and the journal file (both bounded, tens of KB), does one readdir and
 * classifies ≤100 quarantine artifacts (lstat + JSON parse each) — low single-
 * digit milliseconds on the target laptop. Cadence: default 60 s, clamped to
 * [15 s, 10 min] via KRISHA_INTEGRITY_INTERVAL_MS; re-entrancy-guarded; the
 * timer is unref'd so it never holds the process alive. No worker threads,
 * no dependencies, no unbounded memory (fixed-shape report + transition dedup).
 */
import { stopKind, getStorageInfo, verifyAuditChain, appendAuditSyncSafe } from './serverSafety';
import { journalIntegrityCheck } from './sandboxCore';
import { scanQuarantineIntegrity, ScanContinuation } from './quarantineCore';

export type IntegrityHealthState =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'INTEGRITY_FAILURE'
  | 'ACTIVE_UNCERTAIN'
  | 'UNAVAILABLE';

export interface IntegrityDomainReport {
  audit: { ok: boolean; entries: number; segments: number; reason: string | null };
  journal: { ok: boolean; malformedLines: number; totalLines: number; compactionTmpPresent: boolean };
  quarantine: {
    accessible: boolean;
    corrupted: number;
    orphanedData: number;
    orphanedMeta: number;
    tempArtifacts: number;
    journalUnlinked: number;
    associationConflicts: number;
    scannedThisTick: number;
    totalArtifacts: number;
    pageCompleted: boolean;
  };
  store: { root: string | null; protection: string };
}

export interface IntegrityHealthReport {
  state: IntegrityHealthState;
  previousState: IntegrityHealthState | null;
  evaluatedAt: number;
  /** Per-domain detail; a domain whose check THREW reports the error here and
   *  the aggregate state is never HEALTHY (verification unavailability is not
   *  proof of health). */
  domains: Partial<IntegrityDomainReport>;
  reasons: string[];
  evaluations: number;
}

let lastReport: IntegrityHealthReport | null = null;
let evaluations = 0;
let evaluating = false;
// Rotating quarantine cursor: successive ticks continue where the previous
// one stopped, so full quarantine coverage is reached over several bounded
// ticks without ever performing a full continuous scan.
let rotateAfter: string | undefined;
let rotateDigest: string | undefined;

const MIN_INTERVAL_MS = 15_000;
const MAX_INTERVAL_MS = 600_000;
export const DEFAULT_INTERVAL_MS = 60_000;

export function configuredIntervalMs(): number {
  const raw = Number(process.env.KRISHA_INTEGRITY_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, raw));
}

/** Derive the health state once. Read-only; never repairs anything. */
export function evaluateIntegrityHealth(): IntegrityHealthReport {
  const previousState = lastReport?.state ?? null;
  const reasons: string[] = [];
  const domains: Partial<IntegrityDomainReport> = {};
  const store = getStorageInfo();
  domains.store = { root: store.root, protection: store.protection };

  // 1. Storage availability — nothing else can be verified without it.
  if (!store.root || store.protection === 'unavailable') {
    reasons.push(`protected storage ${store.root ? 'protection unavailable' : 'missing'} — verification unavailable`);
    return finish('UNAVAILABLE', previousState, domains, reasons);
  }

  // 2. Stop-state uncertainty (existing M1 semantics, surfaced for monitoring).
  if (stopKind() === 'ACTIVE_UNCERTAIN') {
    reasons.push('stop state could not be validated (ACTIVE_UNCERTAIN)');
    return finish('ACTIVE_UNCERTAIN', previousState, domains, reasons);
  }

  const failures: string[] = [];
  const warnings: string[] = [];

  // 3. Audit chain (H3 primitive).
  try {
    const audit = verifyAuditChain();
    domains.audit = { ok: audit.ok, entries: audit.entries, segments: audit.segments, reason: audit.reason };
    if (!audit.ok) failures.push(`audit: ${audit.reason ?? 'chain verification failed'}`);
  } catch (err) {
    // Monitoring failure is never proof of health.
    warnings.push(`audit verification unavailable: ${String((err as Error)?.message || err).slice(0, 120)}`);
  }

  // 4. Journal integrity (H3 primitive).
  try {
    const journal = journalIntegrityCheck();
    domains.journal = {
      ok: journal.ok, malformedLines: journal.malformedLines,
      totalLines: journal.totalLines, compactionTmpPresent: journal.compactionTmpPresent,
    };
    if (!journal.ok) failures.push(`journal: ${journal.malformedLines} malformed of ${journal.totalLines} lines`);
    if (journal.compactionTmpPresent) warnings.push('journal: interrupted compaction artifact present');
  } catch (err) {
    warnings.push(`journal verification unavailable: ${String((err as Error)?.message || err).slice(0, 120)}`);
  }

  // 5. Quarantine — ONE bounded rotating page per evaluation (never a full
  //    continuous scan). A fresh-install directory without items is fine.
  try {
    const page = scanQuarantineIntegrity({ continuation: rotateAfter === undefined ? undefined : { after: rotateAfter, digest: rotateDigest }, limit: 100 });
    if (!page.itemsDirAccessible) {
      warnings.push('quarantine: items directory unreadable — this page of verification is unavailable');
    }
    if (page.corrupted.length > 0) failures.push(`quarantine: ${page.corrupted.length} corrupted metadata entr(ies) on this page`);
    if (page.associationConflicts.length > 0) failures.push(`quarantine: ${page.associationConflicts.length} journal-association conflict(s) on this page`);
    if (page.orphanedData.length > 0) warnings.push(`quarantine: ${page.orphanedData.length} orphaned data artifact(s) on this page`);
    if (page.orphanedMeta.length > 0) warnings.push(`quarantine: ${page.orphanedMeta.length} orphaned metadata entr(ies) on this page`);
    if (page.tempArtifacts.length > 0) warnings.push(`quarantine: ${page.tempArtifacts.length} temporary artifact(s) on this page`);
    if (page.journalUnlinked.length > 0) warnings.push(`quarantine: ${page.journalUnlinked.length} journal-unlinked entr(ies) on this page`);
    domains.quarantine = {
      accessible: page.itemsDirAccessible,
      corrupted: page.corrupted.length, orphanedData: page.orphanedData.length,
      orphanedMeta: page.orphanedMeta.length, tempArtifacts: page.tempArtifacts.length,
      journalUnlinked: page.journalUnlinked.length, associationConflicts: page.associationConflicts.length,
      scannedThisTick: page.pagination.processed, totalArtifacts: page.pagination.total,
      pageCompleted: page.pagination.completed,
    };
    // Rotate the cursor: continue next tick where this one ended; on page
    // completion or a changed artifact set, restart coverage from the top.
    if (page.pagination.completed || !page.itemsDirAccessible) {
      rotateAfter = undefined;
      rotateDigest = undefined;
    } else {
      rotateAfter = page.pagination.nextAfter ?? undefined;
      rotateDigest = page.pagination.digest;
    }
  } catch (err) {
    // Continuation fail-closed (artifact set changed) → restart coverage from
    // the top on the next tick; this tick's quarantine verification was
    // UNAVAILABLE and the state must not claim health.
    rotateAfter = undefined;
    rotateDigest = undefined;
    warnings.push(`quarantine verification unavailable: ${String((err as Error)?.message || err).slice(0, 120)}`);
  }

  const state: IntegrityHealthState = failures.length > 0 ? 'INTEGRITY_FAILURE'
    : warnings.length > 0 ? 'DEGRADED'
    : 'HEALTHY';
  if (failures.length) reasons.push(...failures);
  if (warnings.length) reasons.push(...warnings);
  return finish(state, previousState, domains, reasons);
}

function finish(state: IntegrityHealthState, previousState: IntegrityHealthState | null, domains: Partial<IntegrityDomainReport>, reasons: string[]): IntegrityHealthReport {
  evaluations++;
  const report: IntegrityHealthReport = {
    state, previousState, evaluatedAt: Date.now(), domains, reasons, evaluations,
  };
  const stateChanged = previousState !== null && previousState !== state;
  const firstEvaluation = previousState === null;
  // Deduplicated audit: only the INITIAL status and STATE TRANSITIONS are
  // recorded — repeated identical failures never flood the audit. An audit
  // write failure here cannot hide the failure: appendAuditSyncSafe surfaces
  // auditDegraded through the existing mechanisms, and the in-memory/endpoint
  // state still carries the report. No recursive logging: the monitor does
  // not audit its own audit failure beyond the one safe append attempt.
  if (firstEvaluation || stateChanged) {
    appendAuditSyncSafe({
      kind: 'e5_integrity_state',
      state,
      previousState,
      firstEvaluation,
      reasons: reasons.slice(0, 8),
    });
  }
  lastReport = report;
  return report;
}

/** Cached last report (for the read-only status endpoint; may be null before
 *  the first evaluation). */
export function lastIntegrityReport(): IntegrityHealthReport | null {
  return lastReport;
}

/** Server-owned periodic monitor. Returns the stop function. Re-entrancy
 *  guarded; the timer is unref'd so monitoring never holds the process.
 *  Evaluates ONCE immediately (the initial status is observable at startup),
 *  then on the bounded cadence. */
export function startIntegrityMonitor(intervalMs?: number): { stop: () => void; intervalMs: number; firstReport: IntegrityHealthReport } {
  const interval = intervalMs ?? configuredIntervalMs();
  const clamped = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, interval));
  const firstReport = evaluateIntegrityHealth();
  const timer = setInterval(() => {
    if (evaluating) return; // never overlap evaluations
    evaluating = true;
    try {
      evaluateIntegrityHealth();
    } catch {
      // evaluateIntegrityHealth already guards its own checks; a throw here
      // leaves the previous report standing — monitoring failure is never
      // converted into health.
    } finally {
      evaluating = false;
    }
  }, clamped);
  timer.unref?.();
  return { stop: () => clearInterval(timer), intervalMs: clamped, firstReport };
}

/** Continuation type re-export for route wiring. */
export type { ScanContinuation } from './quarantineCore';
