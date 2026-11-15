/**
 * Real E5 protected-store status (SPF remediation §10 verification aid).
 *
 * Usage: npx tsx scripts/spf-real-store-status.ts
 *
 * Boots the E5 layer against the REAL store (no env overrides in this
 * process) and prints the integrity state as one JSON line. Run before and
 * after test campaigns; the state (minus nothing) must be IDENTICAL — test
 * suites use isolated KRISHA_SANDBOX_DIR tmpdirs and must never mutate the
 * real store.
 */
import { getStorageInfo, verifyAuditChain, stopKind } from '../serverSafety';

const audit = verifyAuditChain();
const storage = getStorageInfo();
console.log(
  JSON.stringify({
    root: storage.root,
    protection: storage.protection,
    stopKind: stopKind(),
    audit: { ok: audit.ok, entries: audit.entries, segments: audit.segments, firstBrokenLine: audit.firstBrokenLine, reason: audit.reason },
  })
);
// The E5 boot keeps handles open (recovery pipe, integrity timer) — exit
// explicitly once the status line is printed.
process.exit(0);
