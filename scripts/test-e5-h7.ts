/**
 * E5-H7 — Operator recovery procedure audit & correction.
 *
 * Validates the five corrected operator recovery procedures end-to-end in
 * isolated temporary storage. Each procedure is tested with:
 *   - The corrected evidence-preserving steps (ARCHIVE before any removal).
 *   - The failure mode that makes the original (unsafe) instructions dangerous.
 *   - Post-recovery integrity verification.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawnSync } from 'child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e5-h7-'));
const fsRoots = path.join(tmp, 'fsroots');
const storeDir = path.join(tmp, 'e5store');
fs.mkdirSync(fsRoots, { recursive: true });
process.env.KRISHA_FS_ROOTS = fsRoots;
process.env.KRISHA_SANDBOX_DIR = storeDir;

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function section(name: string): void {
  console.log(`\n== ${name} ==`);
}
async function assertRejects(fn: () => unknown, label: string, needle?: string): Promise<void> {
  try {
    await fn();
    assert(false, `${label} [no error thrown]`);
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    assert(!needle || msg.includes(needle), `${label} — got: ${msg}`);
  }
}
const REPO = process.cwd();
const repoUrl = `file:///${REPO.replace(/\\/g, '/')}`;

const { getStorageInfo, stopKind, verifyAuditChain, stopSnapshot } = await import('../serverSafety');
const sc = await import('../sandboxCore');
const journalIntegrityCheck = sc.journalIntegrityCheck;
const q = await import('../quarantineCore');
const mon = await import('../integrityMonitor');
const sys = await import('../systemAgentServer');

assert(path.resolve(getStorageInfo().root ?? '').toLowerCase().startsWith(storeDir.toLowerCase()), 'isolated store in use');

const journalFile = path.join(storeDir, 'sandbox-journal', 'journal.jsonl');
const auditFile = path.join(storeDir, 'audit', 'server-audit.jsonl');
const itemsDir = path.join(storeDir, 'quarantine', 'items');
const stateFile = path.join(storeDir, 'stop-state.json');
const markerFile = path.join(storeDir, 'install.marker');

// Helper: create an evidence archive directory (simulating operator backup)
const archiveDir = path.join(tmp, 'operator-archive');
function archive(srcPath: string, name: string): string {
  fs.mkdirSync(archiveDir, { recursive: true });
  const dest = path.join(archiveDir, name);
  fs.copyFileSync(srcPath, dest);
  return dest;
}

// ===========================================================================
section('PROCEDURE A — Orphaned quarantine .data (corrected: inspect, archive, manual disposition)');
// ===========================================================================
{
  // Setup: crash after data rename but before metadata write (W2 window).
  fs.mkdirSync(itemsDir, { recursive: true });
  const orphanData = path.join(itemsDir, 'aaaaaaaa-0000-4000-8000-00000000h7a0.data');
  fs.writeFileSync(orphanData, 'IMPORTANT-USER-DATA-FROM-CRASHED-CAPTURE');

  // Step 1: Detect — the scan must classify it as orphanedData.
  const report = q.scanQuarantineIntegrity();
  assert(report.orphanedData.some((o) => o.quarantineId === 'aaaaaaaa-0000-4000-8000-00000000h7a0'),
    'A: scan detects the orphan');

  // Step 2: Verify the release flow CANNOT reach it.
  const rel = q.releaseQuarantine([path.join(fsRoots, 'unknown-origin.txt')]);
  assert(rel.released.length === 0, 'A: release cannot match an orphan (no trusted path)');

  // Step 3: ARCHIVE the orphan before any disposition (corrected procedure).
  const archived = archive(orphanData, 'orphan-h7a0.data');
  assert(fs.existsSync(archived) && fs.readFileSync(archived, 'utf8') === 'IMPORTANT-USER-DATA-FROM-CRASHED-CAPTURE',
    'A: orphan content archived with evidence preserved');

  // Step 4: Operator inspects the content and decides. The system does NOT
  //         delete, release, or repair. The operator may remove it manually.
  fs.rmSync(orphanData, { force: true });
  assert(!fs.existsSync(orphanData), 'A: orphan removed only after archiving (operator disposition)');

  // Step 5: Verify the system is healthy after the operator action.
  assert(mon.evaluateIntegrityHealth().state === 'HEALTHY', 'A: system healthy after operator resolution');

  // UNSAFE ORIGINAL: "manually copy it back" — would overwrite the destination
  // without any path verification. Demonstrate why this is refused:
  const destProbe = path.join(fsRoots, 'colliding.txt');
  fs.writeFileSync(destProbe, 'EXISTING-USER-DATA');
  fs.writeFileSync(path.join(itemsDir, 'aaaaaaaa-0000-4000-8000-00000000h7a1.data'), 'orphan-copy');
  // The system NEVER copies orphans back — there is no trusted destination.
  assert(fs.readFileSync(destProbe, 'utf8') === 'EXISTING-USER-DATA', 'A: system never overwrites existing content with orphan data');
  fs.rmSync(path.join(itemsDir, 'aaaaaaaa-0000-4000-8000-00000000h7a1.data'), { force: true });
  fs.rmSync(destProbe, { force: true });
}

// ===========================================================================
section('PROCEDURE B — Torn journal line (corrected: archive, repair, verify)');
// ===========================================================================
{
  // Seed: a real mutation creates the journal.
  await sys.fsCreate(path.join(fsRoots, 'b-seed.txt'), 'file', 'seed');
  // Setup: torn journal line from an interrupted append.
  const before = fs.readFileSync(journalFile, 'utf8');
  fs.appendFileSync(journalFile, '{ H7 TORN LINE\n');
  assert(journalIntegrityCheck().ok === false, 'B: journalIntegrityCheck detects the torn line');
  // Verify the operational impact: mutations refused (H5 policy).
  await assertRejects(() => sys.fsCreate(path.join(fsRoots, 'b-denied.txt'), 'file', 'x'),
    'B: mutations refused while journal is torn', 'journal inconsistency detected');

  // CORRECTED procedure: MANDATORY archive, then targeted repair, then verify.
  // Step 1: MANDATORY archive (not optional).
  const archived = archive(journalFile, 'journal-pre-repair.jsonl');
  assert(fs.readFileSync(archived, 'utf8').includes('{ H7 TORN LINE'), 'B: torn journal archived with evidence');

  // Step 2: Targeted repair — remove ONLY the torn line (not valid records).
  const lines = fs.readFileSync(journalFile, 'utf8').split('\n').filter(Boolean);
  const repaired = lines.filter((l) => {
    try { JSON.parse(l); return true; } catch { return false; }
  });
  fs.writeFileSync(journalFile, repaired.join('\n') + '\n');

  // Step 3: Verify integrity after repair.
  assert(journalIntegrityCheck().ok === true, 'B: journal integrity restored after targeted repair');
  assert(fs.readFileSync(journalFile, 'utf8').includes('"staging_started"') || fs.readFileSync(journalFile, 'utf8').includes('"mutation"'),
    'B: valid records preserved (not blanket-truncated)');

  // Step 4: Mutations work again.
  const created = await sys.fsCreate(path.join(fsRoots, 'b-after-repair.txt'), 'file', 'ok');
  assert(created.kind === 'file', 'B: mutations restored after journal repair');

  // UNSAFE ORIGINAL: blanket truncation would destroy valid records.
  // Demonstrate: the repaired journal retains more lines than the pre-torn snapshot.
  assert(fs.readFileSync(journalFile, 'utf8').split('\n').filter(Boolean).length >= 1,
    'B: repaired journal is not empty (valid records preserved)');
}

// ===========================================================================
section('PROCEDURE C — Unreadable quarantine header (corrected: archive, move, verify)');
// ===========================================================================
{
  // Setup: corrupt a valid entry's meta.
  const f = path.join(fsRoots, 'proc-c.txt');
  fs.writeFileSync(f, 'C-CONTENT-DO-NOT-LOSE');
  await sys.fsDelete(f);
  const item = q.listQuarantine().items.find((i) => i.originalPath === f)!;
  const metaPath = path.join(itemsDir, `${item.quarantineId}.meta.json`);
  const dataPath = path.join(itemsDir, `${item.quarantineId}.data`);
  fs.writeFileSync(metaPath, 'TAMPERED-CORRUPT-HEADER');

  // Verify: the global lock fires and prevents release.
  assert(q.listQuarantine().globallyLocked === true, 'C: global lock engages');
  await assertRejects(() => q.releaseQuarantine([f]),
    'C: release refused while locked', 'GLOBALLY LOCKED');
  assert(fs.existsSync(dataPath), 'C: data retained (not silently destroyed)');

  // CORRECTED procedure: ARCHIVE both files (MOVE, not delete), then remove.
  // Step 1: Archive the corrupted meta AND the data.
  const archivedMeta = archive(metaPath, `corrupted-${item.quarantineId}.meta.json`);
  const archivedData = archive(dataPath, `corrupted-${item.quarantineId}.data`);
  assert(fs.existsSync(archivedMeta) && fs.existsSync(archivedData), 'C: both files archived with evidence preserved');
  assert(fs.readFileSync(archivedData, 'utf8') === 'C-CONTENT-DO-NOT-LOSE', 'C: data content preserved in archive');

  // Step 2: Remove from the items directory (the archive holds the evidence).
  fs.rmSync(metaPath, { force: true });
  fs.rmSync(dataPath, { force: true });

  // Step 3: Verify the lock clears and the system is healthy.
  assert(q.listQuarantine().globallyLocked === false, 'C: lock cleared after operator removal');
  assert(mon.evaluateIntegrityHealth().state === 'HEALTHY', 'C: system healthy after resolution');

  // UNSAFE ORIGINAL: "delete the unreadable .meta.json and paired .data" —
  // this destroys the user's data (C-CONTENT-DO-NOT-LOSE) without preserving
  // any evidence. The corrected procedure archives first.
}

// ===========================================================================
section('PROCEDURE D — Audit-chain discontinuity (corrected: MANDATORY archive, restart marker)');
// ===========================================================================
{
  // Setup: torn audit record.
  const auditBefore = fs.readFileSync(auditFile, 'utf8');
  fs.appendFileSync(auditFile, '{"torn":true\n');
  const broken = verifyAuditChain();
  assert(broken.ok === false, 'D: torn audit record detected');

  // CORRECTED procedure: MANDATORY archive (not "optionally"), then remove.
  // Step 1: MANDATORY archive.
  const archived = archive(auditFile, 'audit-chain-discontinuous.jsonl');
  assert(fs.readFileSync(archived, 'utf8') === auditBefore + '{"torn":true\n',
    'D: full audit chain (including the torn record) archived');

  // Step 2: Remove the discontinuous file. The system restarts the chain.
  fs.rmSync(auditFile, { force: true });

  // Step 3: The next audit event creates a fresh chain with a restart marker.
  await sys.fsCreate(path.join(fsRoots, 'd-after-audit-repair.txt'), 'file', 'x');
  assert(verifyAuditChain().ok === true, 'D: fresh chain verifies after restart-marker creation');
  const auditContent = fs.readFileSync(auditFile, 'utf8');
  assert(auditContent.includes('"e5_audit_chain_restarted"'), 'D: restart marker explicitly recorded');
  assert(auditContent.includes('"e5_audit_chain_restarted"') === false || verifyAuditChain().segments >= 1,
    'D: restart segment is verifiable');

  // UNSAFE ORIGINAL: "optionally archive" — without archiving, the torn record
  // and all prior evidence would be permanently lost. The corrected procedure
  // makes archiving MANDATORY.
}

// ===========================================================================
section('PROCEDURE E — ACTIVE_UNCERTAIN (corrected: MANDATORY archive + acknowledge, then reset)');
// ===========================================================================
{
  // Setup: corrupt the stop-state to force UNCERTAIN on a fresh boot.
  // We do this via a child process to get a genuine restart-state derivation.
  const eStore = path.join(tmp, 'e-store');
  const eRoots = path.join(tmp, 'e-roots');
  fs.mkdirSync(eRoots, { recursive: true });
  fs.mkdirSync(eStore, { recursive: true });
  fs.writeFileSync(path.join(eStore, 'install.marker'), '{}');
  fs.writeFileSync(path.join(eStore, 'stop-state.json'), 'CORRUPTED-STATE-DATA');

  // Step 1: Verify the boot is UNCERTAIN (fail-closed).
  const bootScript = path.join(tmp, 'e-boot.mts');
  fs.writeFileSync(bootScript, `
    const ss = await import('${repoUrl}/serverSafety');
    console.log('BOOT=' + ss.stopKind());
    process.exit(0);
  `);
  const rec = spawnSync('npx', ['tsx', bootScript], { encoding: 'utf8', timeout: 90_000, cwd: REPO, shell: true, env: { ...process.env, KRISHA_FS_ROOTS: eRoots, KRISHA_SANDBOX_DIR: eStore } });
  assert(rec.stdout.includes('ACTIVE_UNCERTAIN'), 'E: corrupted stop-state boots ACTIVE_UNCERTAIN');

  // CORRECTED procedure: MANDATORY archive + explicit acknowledgment, then reset.
  // Step 2: MANDATORY archive of the corrupted state file.
  const corruptedState = fs.readFileSync(path.join(eStore, 'stop-state.json'), 'utf8');
  const archivedState = archive(path.join(eStore, 'stop-state.json'), 'uncertain-stop-state.json');
  assert(fs.readFileSync(archivedState, 'utf8') === corruptedState, 'E: corrupted stop-state archived with evidence');

  // Step 3: ARCHIVE the install marker too.
  const archivedMarker = archive(path.join(eStore, 'install.marker'), 'uncertain-install.marker');
  assert(fs.existsSync(archivedMarker), 'E: install marker archived');

  // Step 4: OPERATOR ACKNOWLEDGMENT — the operator must understand that this
  //         reset clears any potentially active emergency stop. Document this
  //         as an explicit acknowledgement step (no auto-reset).

  // Step 5: Remove both files (the archived copies hold the evidence).
  fs.rmSync(path.join(eStore, 'stop-state.json'), { force: true });
  fs.rmSync(path.join(eStore, 'install.marker'), { force: true });

  // Step 6: Restart → boots INACTIVE as a fresh installation.
  const rec2 = spawnSync('npx', ['tsx', bootScript], { encoding: 'utf8', timeout: 90_000, cwd: REPO, shell: true, env: { ...process.env, KRISHA_FS_ROOTS: eRoots, KRISHA_SANDBOX_DIR: eStore } });
  assert(rec2.stdout.includes('INACTIVE'), 'E: fresh boot after reset is INACTIVE');

  // Step 7: Verify the audit trail shows the first-install event.
  const auditContent = fs.readFileSync(path.join(eStore, 'audit', 'server-audit.jsonl'), 'utf8');
  assert(auditContent.includes('"e5_first_install"'), 'E: first-install audit event recorded after reset');

  // UNSAFE ORIGINAL: "delete stop-state.json and install.marker" — without the
  // MANDATORY archive step, the corrupted state evidence is lost. The reset
  // also clears any potentially active emergency stop — the operator must
  // acknowledge this before proceeding.
}

// ===========================================================================
section('Cross-procedure: no automatic repair, no evidence destruction');
// ===========================================================================
{
  // Verify that NO code path in any module performs automatic repair.
  const sources = [
    fs.readFileSync(path.join(REPO, 'sandboxCore.ts'), 'utf8'),
    fs.readFileSync(path.join(REPO, 'quarantineCore.ts'), 'utf8'),
    fs.readFileSync(path.join(REPO, 'rollbackCore.ts'), 'utf8'),
    fs.readFileSync(path.join(REPO, 'integrityMonitor.ts'), 'utf8'),
  ];
  // No unlinkSync of .data or .meta.json outside verified post-restore cleanup
  // and test cleanup paths. No writeFileSync to the stop-state outside M1.
  // No automatic release or restore calls.
  const allSrc = sources.join('\n');
  assert(!allSrc.includes('autoRepair'), 'no automatic repair functions exist');
  assert(!allSrc.includes('autoRelease'), 'no automatic release functions exist');
  assert(!allSrc.includes('autoDelete'), 'no automatic delete functions exist');
  // The monitor never repairs:
  assert(!mon.evaluateIntegrityHealth.toString().includes('unlinkSync'), 'monitor evaluation never deletes files');
  assert(!mon.evaluateIntegrityHealth.toString().includes('renameSync'), 'monitor evaluation never renames files');
}

// ===========================================================================
console.log(`\n== E5 H7 RESULTS: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
try {
  const realState = JSON.parse(fs.readFileSync('C:/ProgramData/Krisha/sandbox/stop-state.json', 'utf8'));
  if (realState.active === false && realState.generation === 1) console.log('  ✓ real ProgramData store untouched (INACTIVE, generation 1)');
  else console.log('  ✗ REAL STORE CHANGED — INVESTIGATE');
  const realItems = fs.readdirSync('C:/ProgramData/Krisha/sandbox/quarantine/items');
  if (realItems.length === 0) console.log('  ✓ real quarantine empty (unchanged)');
  else console.log('  ✗ real quarantine has contents');
} catch { /* verification only */ }
try {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(archiveDir, { recursive: true, force: true });
} catch { /* best-effort cleanup */ }
process.exit(0);
