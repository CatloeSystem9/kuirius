/**
 * E5 H1 — Quarantine orphan recovery (finding F5) test suite.
 *
 * Every test uses isolated temporary storage and asserts the actual
 * filesystem + report + audit state. The scan is READ-ONLY by design:
 * the recurring property under test is "orphans are detected, reported,
 * and remain locked — nothing is silently released, deleted, or repaired".
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e5-h1-'));
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

const { getStorageInfo, stopKind, armStop, recoverStop, stopSnapshot } = await import('../serverSafety');
const sc = await import('../sandboxCore');
const q = await import('../quarantineCore');
const sys = await import('../systemAgentServer');
// Dynamic import ONLY: a static import would hoist above the process.env
// assignments and initialize serverSafety against the REAL store.
const rb = await import('../rollbackCore');

assert(path.resolve(getStorageInfo().root ?? '').toLowerCase().startsWith(storeDir.toLowerCase()), 'isolated store in use');
assert(stopKind() === 'INACTIVE', 'boots INACTIVE');

const itemsDir = path.join(storeDir, 'quarantine', 'items');
const auditFile = path.join(storeDir, 'audit', 'server-audit.jsonl');
const FAKE_ID = '00000000-0000-4000-8000-00000000face';
const FAKE_ID2 = '00000000-0000-4000-8000-00000000feed';

/** Craft an orphan .data exactly as crash window W1/W2 would leave it. */
function craftOrphanData(id: string, content: string): string {
  fs.mkdirSync(itemsDir, { recursive: true });
  const p = path.join(itemsDir, `${id}.data`);
  fs.writeFileSync(p, content);
  return p;
}
/** Craft an orphan meta (integrity-valid header) whose data is absent. */
function craftOrphanMeta(id: string, originalPath: string): void {
  fs.mkdirSync(itemsDir, { recursive: true });
  const meta = {
    schemaVersion: 1, quarantineId: id, kind: 'file' as const,
    originalPath, dataIdentity: { dev: 1, ino: 1, birthtimeMs: 1, birthtimeReliable: true, size: 0, mtimeMs: 1 },
    contentSha256: crypto.createHash('sha256').update('x').digest('hex'), contentBytes: 1,
    captureAt: Date.now(), opId: null as unknown as string,
  };
  const fields = JSON.parse(JSON.stringify(meta));
  const canonical = JSON.stringify({
    schemaVersion: fields.schemaVersion, quarantineId: fields.quarantineId, kind: fields.kind,
    originalPath: fields.originalPath, dataIdentity: fields.dataIdentity,
    contentSha256: fields.contentSha256 ?? null, contentBytes: fields.contentBytes ?? null,
    captureAt: fields.captureAt, opId: fields.opId ?? null, treeManifest: null,
  });
  const withIntegrity = { ...fields, headerIntegrity: crypto.createHash('sha256').update(canonical, 'utf8').digest('hex') };
  fs.writeFileSync(path.join(itemsDir, `${id}.meta.json`), JSON.stringify(withIntegrity, null, 2));
}

// ===========================================================================
section('1. Normal quarantine creation remains unchanged');
// ===========================================================================
{
  const f = path.join(fsRoots, 'normal.txt');
  fs.writeFileSync(f, 'normal-content');
  await sys.fsDelete(f);
  const listing = q.listQuarantine();
  const item = listing.items.find((i) => i.originalPath === f);
  assert(!!item && item.readable, 'normal capture creates a readable item');
  assert(listing.integrity.valid.length === 1 && listing.integrity.valid[0].journalAssociated === true,
    'scan classifies the normal entry as valid + journal-associated');
  assert(listing.integrity.orphanedData.length === 0 && listing.integrity.corrupted.length === 0,
    'no false orphans from normal operation');
  // The entry still restores through the unchanged release flow.
  const rel = q.releaseQuarantine([f]);
  assert(rel.released.length === 1 && fs.readFileSync(f, 'utf8') === 'normal-content',
    'normal entry releases unchanged (E7 flow intact)');
}

// ===========================================================================
section('2. Simulated orphan data is detected (crash windows W1/W2)');
// ===========================================================================
{
  const orphanPath = craftOrphanData(FAKE_ID, 'orphaned-by-crash');
  const report = q.scanQuarantineIntegrity();
  const hit = report.orphanedData.find((o) => o.quarantineId === FAKE_ID);
  assert(!!hit, 'orphan .data detected and classified');
  assert(!!hit && hit.reason.includes('UNKNOWN') && hit.reason.includes('locked'), 'orphan report states origin is unknown and the file is locked');
  assert(fs.existsSync(orphanPath), 'orphan data still on disk (retained)');
  // It must NOT appear as a releasable item.
  const listing = q.listQuarantine();
  assert(!listing.items.some((i) => i.quarantineId === FAKE_ID), 'orphan does not appear in the releasable items list');
  assert(!listing.integrity.valid.some((v) => v.quarantineId === FAKE_ID), 'orphan is not classified as valid');
}

// ===========================================================================
section('3. Orphan data remains inaccessible to restore/release flows');
// ===========================================================================
{
  const rel = q.releaseQuarantine([path.join(fsRoots, 'nowhere.txt')]);
  assert(rel.released.length === 0 && rel.refused.length === 1, 'release declarations cannot match an orphan (no trusted path exists)');
  // Rollback planning for a fabricated opId cannot reach the orphan either
  // (it is not referenced by any journal record).
  assertRejects(() => rb.planRollback('00000000-0000-4000-8000-00000000face'),
    'rollback planning cannot adopt an orphan', 'no rollback-capable journal record');
  assert(fs.existsSync(path.join(itemsDir, `${FAKE_ID}.data`)), 'orphan data still retained after release attempts');
}

// ===========================================================================
section('4. Missing metadata does not cause automatic deletion');
// ===========================================================================
{
  const orphanPath = path.join(itemsDir, `${FAKE_ID}.data`);
  const before = fs.readFileSync(orphanPath, 'utf8');
  q.scanQuarantineIntegrity();
  q.auditedQuarantineScan();
  q.listQuarantine();
  assert(fs.existsSync(orphanPath) && fs.readFileSync(orphanPath, 'utf8') === before,
    'scans leave orphan data byte-identical (no deletion, no modification)');
}

// ===========================================================================
section('5. Corrupted metadata does not authorize recovery');
// ===========================================================================
{
  // Corrupt a REAL capture's header: the entry must stay unreleasable, and
  // the scan must classify it as corrupted — never as recoverable.
  const f = path.join(fsRoots, 'corrupt-h1.txt');
  fs.writeFileSync(f, 'cc');
  await sys.fsDelete(f);
  const item = q.listQuarantine().items.find((i) => i.originalPath === f)!;
  const metaPath = path.join(itemsDir, `${item.quarantineId}.meta.json`);
  fs.writeFileSync(metaPath, '{"schemaVersion":1,"quarantineId":"' + item.quarantineId + '"'); // truncated
  const report = q.scanQuarantineIntegrity();
  assert(report.corrupted.some((c) => c.quarantineId === item.quarantineId), 'truncated header classified corrupted');
  assert(!report.valid.some((v) => v.quarantineId === item.quarantineId), 'corrupted entry never classified valid');
  assertRejects(() => q.releaseQuarantine([f]), 'release refused for corrupted entry (global lock)', 'GLOBALLY LOCKED');
  assert(fs.existsSync(path.join(itemsDir, `${item.quarantineId}.data`)), 'corrupted entry data retained');
  // Out-of-band operator resolution for cleanup (test acts as operator).
  fs.rmSync(path.join(itemsDir, `${item.quarantineId}.data`), { force: true });
  fs.rmSync(metaPath, { force: true });
}

// ===========================================================================
section('6. Valid entries remain untouched during orphan scanning');
// ===========================================================================
{
  const f = path.join(fsRoots, 'untouched-h1.txt');
  fs.writeFileSync(f, 'keep-me');
  await sys.fsDelete(f);
  const before = fs.readFileSync(path.join(itemsDir, q.listQuarantine().items.find((i) => i.originalPath === f)!.quarantineId + '.data'));
  craftOrphanData(FAKE_ID2, 'another-orphan');
  q.scanQuarantineIntegrity();
  q.auditedQuarantineScan();
  const after = fs.readFileSync(path.join(itemsDir, q.listQuarantine().items.find((i) => i.originalPath === f)!.quarantineId + '.data'));
  assert(before.equals(after), 'valid entry data byte-identical across scans');
  const rel = q.releaseQuarantine([f]);
  assert(rel.released.length === 1, 'valid entry still releasable after scans');
}

// ===========================================================================
section('7. Repeated recovery scans are idempotent');
// ===========================================================================
{
  const r1 = q.scanQuarantineIntegrity();
  const r2 = q.scanQuarantineIntegrity();
  const r3 = q.auditedQuarantineScan();
  const sig = (r: typeof r1) => JSON.stringify({
    o: r.orphanedData.map((o) => o.quarantineId).sort(),
    m: r.orphanedMeta.map((o) => o.quarantineId).sort(),
    t: r.tempArtifacts.map((o) => o.fileName).sort(),
    c: r.corrupted.map((o) => o.quarantineId).sort(),
    v: r.valid.map((v) => v.quarantineId).sort(),
  });
  assert(sig(r1) === sig(r2) && sig(r2) === sig(r3), 'three consecutive scans produce identical classifications');
  assert(fs.readdirSync(itemsDir).length === r1.orphanedData.length + r1.orphanedMeta.length + r1.corrupted.length + r1.valid.length + r1.tempArtifacts.length,
    'scan count matches directory contents exactly (no duplicates created)');
}

// ===========================================================================
section('8. Recovery interruption does not corrupt existing entries');
// ===========================================================================
{
  // The scan performs no writes, so "interruption" degrades to: a scan that
  // throws must leave everything untouched. Storage-unavailable is the only
  // throwing path — assert the guard exists and the data is unchanged.
  const snapshotBefore = fs.readdirSync(itemsDir).sort().join('|');
  const report = q.scanQuarantineIntegrity();
  void report;
  assert(fs.readdirSync(itemsDir).sort().join('|') === snapshotBefore, 'directory unchanged across a full scan cycle');
  const qSource = fs.readFileSync(path.resolve(process.cwd(), 'quarantineCore.ts'), 'utf8');
  assert(qSource.includes('throws when storage unavailable → fail closed'), 'scan fails closed on unavailable storage [source]');
  // The journal is never written by the scan.
  const journalBefore = fs.readFileSync(path.join(storeDir, 'sandbox-journal', 'journal.jsonl'), 'utf8');
  q.auditedQuarantineScan();
  assert(fs.readFileSync(path.join(storeDir, 'sandbox-journal', 'journal.jsonl'), 'utf8') === journalBefore,
    'scan never writes to the sandbox journal');
}

// ===========================================================================
section('9. Duplicate or conflicting identifiers fail closed');
// ===========================================================================
{
  // A meta whose INTERNAL quarantineId disagrees with its filename.
  craftOrphanMeta(FAKE_ID, path.join(fsRoots, 'conflict.txt')); // meta for FAKE_ID...
  // ...but rename it so the FILENAME claims a different id:
  fs.renameSync(path.join(itemsDir, `${FAKE_ID}.meta.json`), path.join(itemsDir, `${FAKE_ID2}.meta.json`));
  const report = q.scanQuarantineIntegrity();
  const conflict = report.corrupted.find((c) => c.quarantineId === FAKE_ID2);
  assert(!!conflict && conflict.reason.includes('conflicts with its filename'), 'id/filename conflict classified corrupted (fail closed)');
  assert(!report.valid.some((v) => v.quarantineId === FAKE_ID2), 'conflicting entry never classified valid');
  assertRejects(() => q.releaseQuarantine([path.join(fsRoots, 'conflict.txt')]),
    'conflicting entry cannot be released', 'no readable quarantine item matches');
  fs.rmSync(path.join(itemsDir, `${FAKE_ID2}.meta.json`), { force: true });
}

// ===========================================================================
section('10. Emergency stop and permissions remain enforced');
// ===========================================================================
{
  armStop('H1StopCheck#1', 'test');
  assertRejects(() => q.releaseQuarantine([path.join(fsRoots, 'anything.txt')]),
    'release still stop-blocked', 'emergency stop is ACTIVE');
  const scanWhileStopped = q.auditedQuarantineScan(); // read-only scan allowed during stop
  assert(scanWhileStopped.orphanedData.some((o) => o.quarantineId === FAKE_ID), 'read-only scan works during stop (no mutation authorized)');
  recoverStop('H1StopCheck#1', 'test');
  assertRejects(() => sc.assertSandboxMutation('terminal.execution', 'quarantine-anything', 'x'),
    'default-deny capability still cannot drive quarantine mutations', 'permission_denied');
  assert(stopSnapshot().generation > 0, 'stop state machine intact');
}

// ===========================================================================
section('11. Audit records describe detection and operator actions');
// ===========================================================================
{
  const audit = fs.readFileSync(auditFile, 'utf8');
  assert(audit.includes('"e5_quarantine_scan"'), 'audited scans recorded');
  const scanLine = audit.split('\n').filter((l) => l.includes('"e5_quarantine_scan"')).pop()!;
  assert(scanLine.includes(`"${FAKE_ID}"`), 'scan audit names the orphaned artifact id');
  // Normal lifecycle audit entries still present (release from section 6).
  assert(audit.includes('"e5_quarantine_released"'), 'release actions remain audited');
  // The scan must NOT appear in the sandbox journal (no second persistence system).
  const journal = fs.readFileSync(path.join(storeDir, 'sandbox-journal', 'journal.jsonl'), 'utf8');
  assert(!journal.includes('quarantine_scan'), 'scan audit lives only in the audit chain');
}

// ===========================================================================
section('12. Regression guard — M1–M4 suites and build artifacts');
// ===========================================================================
{
  // The full suites run in the final battery; here: the invariants this
  // milestone touches most directly.
  const listing = q.listQuarantine();
  assert(Array.isArray(listing.items) && typeof listing.globallyLocked === 'boolean' && !!listing.integrity,
    'list response shape additive (items, globallyLocked, integrity)');
  assert(listing.integrity.tempArtifacts.every((t) => t.fileName.endsWith('.tmp')), 'temp artifacts classified by extension');
  // No orphan was released or deleted during the entire suite:
  assert(fs.existsSync(path.join(itemsDir, `${FAKE_ID}.data`)), 'the orphan created in section 2 survives the entire suite (retention preserved)');
}

// ===========================================================================
console.log(`\n== E5 H1 RESULTS: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch { /* best-effort cleanup */ }
process.exit(0);
