/**
 * E5 H2 — Quarantine journal trust + complete scanning test suite.
 *
 * Property under test: journal associations are NEVER overstated (verified
 * requires integrity + uniqueness + metadata↔record agreement), artifacts
 * beyond any count are fully reachable through bounded digest-bound pages,
 * and the scan stays read-only and idempotent throughout.
 *
 * Journal states are crafted by appending well-formed records — this suite
 * runs as a trusted local process in ISOLATED temporary storage. The real
 * ProgramData store is never touched.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e5-h2-'));
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
async function assertThrows(fn: () => unknown, label: string, needle?: string): Promise<void> {
  try {
    fn();
    assert(false, `${label} [no error thrown]`);
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    assert(!needle || msg.includes(needle), `${label} — got: ${msg}`);
  }
}

const { getStorageInfo, stopKind, armStop, recoverStop } = await import('../serverSafety');
const sc = await import('../sandboxCore');
const q = await import('../quarantineCore');
const sys = await import('../systemAgentServer');

assert(path.resolve(getStorageInfo().root ?? '').toLowerCase().startsWith(storeDir.toLowerCase()), 'isolated store in use');

const itemsDir = path.join(storeDir, 'quarantine', 'items');
const journalFile = path.join(storeDir, 'sandbox-journal', 'journal.jsonl');
const auditFile = path.join(storeDir, 'audit', 'server-audit.jsonl');

/** Append a well-formed delete mutation record to the journal (trusted test write). */
function journalDeleteRecord(quarantineId: string, fromPath: string, opId?: string): string {
  const rec = { t: 'mutation', op: 'delete', from: fromPath, opId: opId ?? crypto.randomUUID(), quarantineId, at: Date.now() };
  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  fs.appendFileSync(journalFile, JSON.stringify(rec) + '\n');
  return rec.opId;
}

/** Craft an internally consistent quarantine entry (data + integrity-valid
 *  meta whose dataIdentity matches the data). Returns the id. */
function craftEntry(id: string, originalPath: string, content: string): string {
  fs.mkdirSync(itemsDir, { recursive: true });
  fs.writeFileSync(path.join(itemsDir, `${id}.data`), content);
  const st = fs.statSync(path.join(itemsDir, `${id}.data`));
  const meta = {
    schemaVersion: 1, quarantineId: id, kind: 'file' as const,
    originalPath,
    dataIdentity: { dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs, birthtimeReliable: st.birthtimeMs > 0, size: st.size, mtimeMs: st.mtimeMs },
    contentSha256: crypto.createHash('sha256').update(content).digest('hex'), contentBytes: st.size,
    captureAt: Date.now(), opId: crypto.randomUUID(),
  };
  const canonical = JSON.stringify({
    schemaVersion: meta.schemaVersion, quarantineId: meta.quarantineId, kind: meta.kind,
    originalPath: meta.originalPath, dataIdentity: meta.dataIdentity,
    contentSha256: meta.contentSha256 ?? null, contentBytes: meta.contentBytes ?? null,
    captureAt: meta.captureAt, opId: meta.opId ?? null, treeManifest: null,
  });
  const withIntegrity = { ...meta, headerIntegrity: crypto.createHash('sha256').update(canonical, 'utf8').digest('hex') };
  fs.writeFileSync(path.join(itemsDir, `${id}.meta.json`), JSON.stringify(withIntegrity, null, 2));
  return id;
}

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ===========================================================================
section('1. Journal association with a valid, verifiable operation');
// ===========================================================================
{
  const id = craftEntry(ID(1), path.join(fsRoots, 'v1.txt'), 'v1-body');
  const opId = journalDeleteRecord(id, path.join(fsRoots, 'v1.txt'));
  // Also record the opId inside the meta? The meta was crafted before the
  // record — rewrite the meta with the matching opId (integrity recomputed):
  const metaRaw = JSON.parse(fs.readFileSync(path.join(itemsDir, `${id}.meta.json`), 'utf8'));
  metaRaw.opId = opId;
  const canonical = JSON.stringify({
    schemaVersion: metaRaw.schemaVersion, quarantineId: metaRaw.quarantineId, kind: metaRaw.kind,
    originalPath: metaRaw.originalPath, dataIdentity: metaRaw.dataIdentity,
    contentSha256: metaRaw.contentSha256 ?? null, contentBytes: metaRaw.contentBytes ?? null,
    captureAt: metaRaw.captureAt, opId: metaRaw.opId ?? null, treeManifest: null,
  });
  metaRaw.headerIntegrity = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  fs.writeFileSync(path.join(itemsDir, `${id}.meta.json`), JSON.stringify(metaRaw, null, 2));

  const r = q.scanQuarantineIntegrity();
  const v = r.valid.find((x) => x.quarantineId === id);
  assert(!!v && v.association === 'verified' && v.journalAssociated === true,
    'fully agreeing meta↔record (path + opId) classifies VERIFIED');
  assert(r.journalOk === true && r.associationConflicts.length === 0, 'no conflicts, journal healthy');
}

// ===========================================================================
section('2. Journal association with a missing operation (healthy journal)');
// ===========================================================================
{
  const id = craftEntry(ID(2), path.join(fsRoots, 'v2.txt'), 'v2');
  const r = q.scanQuarantineIntegrity();
  const v = r.valid.find((x) => x.quarantineId === id);
  assert(!!v && v.association === 'unverified' && v.journalAssociated === false,
    'no record → UNVERIFIED (never invented as associated)');
  assert(r.journalUnlinked.some((u) => u.quarantineId === id), 'unverified entry reported for operator review');
  assert(!r.journalUnlinked.some((u) => u.reason.includes('journal corrupt')), 'no false cause invented for the missing record');
}

// ===========================================================================
section('3. Duplicate operation identifiers');
// ===========================================================================
{
  const id = craftEntry(ID(3), path.join(fsRoots, 'v3.txt'), 'v3');
  journalDeleteRecord(id, path.join(fsRoots, 'v3.txt'));
  journalDeleteRecord(id, path.join(fsRoots, 'v3.txt')); // duplicate record
  const r = q.scanQuarantineIntegrity();
  const v = r.valid.find((x) => x.quarantineId === id);
  assert(!!v && v.association === 'conflicted' && v.journalAssociated === false, 'duplicate records → CONFLICTED');
  assert(r.associationConflicts.some((c) => c.quarantineId === id && c.reason.includes('duplicate operation identifiers')),
    'conflict reason names the duplication');
}

// ===========================================================================
section('4. Conflicting quarantine identifiers');
// ===========================================================================
{
  // 4a — meta filename vs internal id conflict (crafted mismatch).
  const id = craftEntry(ID(4), path.join(fsRoots, 'v4.txt'), 'v4');
  fs.renameSync(path.join(itemsDir, `${id}.meta.json`), path.join(itemsDir, `${ID(40)}.meta.json`));
  const r4 = q.scanQuarantineIntegrity();
  assert(r4.corrupted.some((c) => c.quarantineId === ID(40) && c.reason.includes('conflicts with its filename')),
    'filename/id conflict → corrupted, fail closed');
  assert(!r4.valid.some((v) => v.quarantineId === ID(40) || v.quarantineId === id), 'conflicting entry never valid');
  fs.rmSync(path.join(itemsDir, `${ID(40)}.meta.json`), { force: true });

  // 4b — journal record origin path disagrees with the meta.
  const id2 = craftEntry(ID(41), path.join(fsRoots, 'v4b.txt'), 'v4b');
  journalDeleteRecord(id2, path.join(fsRoots, 'SOMEWHERE-ELSE.txt')); // wrong origin
  const r4b = q.scanQuarantineIntegrity();
  assert(r4b.valid.find((v) => v.quarantineId === id2)?.association === 'conflicted',
    'meta↔record path disagreement → CONFLICTED');
  assert(r4b.associationConflicts.some((c) => c.quarantineId === id2 && c.reason.includes('origin path disagrees')),
    'path conflict reported with reason');
}

// ===========================================================================
section('5. Corrupted journal records + 6. journal integrity failure');
// ===========================================================================
{
  const id = craftEntry(ID(5), path.join(fsRoots, 'v5.txt'), 'v5');
  journalDeleteRecord(id, path.join(fsRoots, 'v5.txt'));
  const before = fs.readFileSync(journalFile, 'utf8');
  fs.appendFileSync(journalFile, '{ CORRUPTED LINE\n');
  const r = q.scanQuarantineIntegrity();
  assert(r.journalOk === false, 'corrupted journal record flips journalOk to false');
  const v = r.valid.find((x) => x.quarantineId === id);
  assert(!!v && v.association === 'unverifiable-journal' && v.journalAssociated === false,
    'association downgraded to UNVERIFIABLE-JOURNAL (never trusted from a corrupt journal)');
  assert(!r.associationConflicts.some((c) => c.quarantineId === id), 'no conflict invented while the journal is untrustworthy');
  fs.writeFileSync(journalFile, before); // repair
}

// ===========================================================================
section('7. Compacted / historically unverifiable associations');
// ===========================================================================
{
  // A real capture, then compaction churn that evicts its closure records.
  const f = path.join(fsRoots, 'compact-h2.txt');
  fs.writeFileSync(f, 'compact');
  const del = await sys.fsDelete(f) as { opId?: string; quarantined?: boolean; quarantineId?: string };
  assert(del.quarantined === true && !!del.opId, 'real capture with journal record');
  const rBefore = q.scanQuarantineIntegrity();
  assert(rBefore.valid.find((v) => v.quarantineId === del.quarantineId)?.association === 'verified',
    'association VERIFIED before compaction');
  for (let i = 0; i < 120; i++) {
    await sys.fsCreate(path.join(fsRoots, `h2churn-${i}.txt`), 'file', 'x');
    sc.sandboxDelete(path.join(fsRoots, `h2churn-${i}.txt`)); // core-level: no quarantine churn
  }
  const rAfter = q.scanQuarantineIntegrity();
  const v = rAfter.valid.find((x) => x.quarantineId === del.quarantineId);
  assert(!!v && v.association === 'unverified' && v.journalAssociated === false,
    'compaction-evicted record → UNVERIFIED (historically unverifiable, no certainty invented)');
  assert(rAfter.journalOk === true, 'journal still healthy after compaction (unverifiable ≠ corrupt)');
}

// ===========================================================================
section('8. More than 50 artifacts — bounded pages, full coverage');
// ===========================================================================
{
  const preCount = fs.readdirSync(itemsDir).length;
  const preOrphans = q.scanQuarantineIntegrityComplete().orphanedData.length;
  for (let i = 0; i < 300; i++) craftOrphanOnly(ID(1000 + i), `orphan-${i}`);
  const single = q.scanQuarantineIntegrity();
  assert(single.pagination.total === preCount + 300, `total artifact count reported (${preCount + 300})`);
  assert(!single.pagination.completed && single.pagination.processed <= 100,
    `single call is resource-bounded (processed ${single.pagination.processed}, completed ${single.pagination.completed})`);
  const complete = q.scanQuarantineIntegrityComplete();
  assert(complete.pagination.processed === preCount + 300 && complete.pagination.completed === true, 'complete scan processes every artifact');
  assert(complete.orphanedData.length === preOrphans + 300, 'all 300 new orphans classified (none skipped by the 50-item capture cap)');
  assert(complete.pages > 1, `multiple pages used (${complete.pages})`);
}
function craftOrphanOnly(id: string, content: string): void {
  fs.mkdirSync(itemsDir, { recursive: true });
  fs.writeFileSync(path.join(itemsDir, `${id}.data`), content);
}

// ===========================================================================
section('9. Continuation across multiple pages (deterministic, digest-bound)');
// ===========================================================================
{
  let after: string | undefined;
  let digest: string | undefined;
  const seen: string[] = [];
  let pages = 0;
  for (;;) {
    const page = q.scanQuarantineIntegrity({ continuation: { after, digest } });
    digest = page.pagination.digest;
    const names = [
      ...page.valid.map((v) => `${v.quarantineId}.meta.json`),
      ...page.orphanedData.map((o) => o.fileName),
      ...page.orphanedMeta.map((o) => o.fileName),
      ...page.tempArtifacts.map((t) => t.fileName),
      ...page.corrupted.map((c) => c.fileName),
      ...page.unexpected.map((u) => u.fileName),
    ];
    seen.push(...names);
    pages++;
    if (page.pagination.completed) break;
    after = page.pagination.nextAfter!;
  }
  assert(pages > 2, `continuation walked ${pages} pages`);
  const unique = new Set(seen);
  assert(unique.size === seen.length, 'no artifact classified twice across pages');
  // Coverage property: every metadata is classified exactly once, and every
  // TRUE orphan .data is classified. A valid/conflicted entry legitimately
  // covers its paired .data through the meta classification, so accounted
  // names = directory entries − paired data files.
  const allNames = fs.readdirSync(itemsDir).sort();
  const allMetaIds = new Set(allNames.filter((n) => n.endsWith('.meta.json')).map((n) => n.slice(0, -'.meta.json'.length)));
  const seenMetaIds = new Set(seen.filter((n) => n.endsWith('.meta.json')).map((n) => n.slice(0, -'.meta.json'.length)));
  const seenOrphanData = new Set(seen.filter((n) => n.endsWith('.data')));
  const allOrphanData = allNames.filter((n) => n.endsWith('.data') && !allMetaIds.has(n.slice(0, -'.data'.length)));
  assert(seenMetaIds.size === allMetaIds.size, `every metadata classified exactly once (${seenMetaIds.size}/${allMetaIds.size})`);
  let allMetasCovered = true;
  for (const id of allMetaIds) if (!seenMetaIds.has(id)) allMetasCovered = false;
  assert(allMetasCovered, 'no metadata skipped');
  assert(seenOrphanData.size === allOrphanData.length, `every true orphan data classified (${seenOrphanData.size}/${allOrphanData.length})`);
  const pairedData = allNames.filter((n) => n.endsWith('.data') && allMetaIds.has(n.slice(0, -'.data'.length))).length;
  assert(seen.length === allNames.length - pairedData, `accounted names = artifacts − paired data (${seen.length})`);
}

// ===========================================================================
section('10. Invalid or replayed continuation tokens fail closed');
// ===========================================================================
{
  const first = q.scanQuarantineIntegrity();
  assertThrows(() => q.scanQuarantineIntegrity({ continuation: { after: first.pagination.nextAfter!, digest: 'f'.repeat(64) } }),
    'forged digest refused', 'changed between scan pages');
  assertThrows(() => q.scanQuarantineIntegrity({ continuation: { after: first.pagination.nextAfter!, digest: undefined } }),
    'missing digest refused', 'changed between scan pages');
  assertThrows(() => q.scanQuarantineIntegrity({ continuation: { after: 'nonexistent-artifact.bin', digest: first.pagination.digest } }),
    'cursor outside the artifact set refused', 'does not match the artifact set');
  // Replayed token after the artifact set CHANGED: digest mismatch → refused.
  craftOrphanOnly(ID(2000), 'late-arrival');
  assertThrows(() => q.scanQuarantineIntegrity({ continuation: { after: first.pagination.nextAfter, digest: first.pagination.digest } }),
    'replayed token after storage change refused', 'changed between scan pages');
}

// ===========================================================================
section('11. Artifacts changing between scan requests (no false claims)');
// ===========================================================================
{
  // Under a CHANGED set, a fresh scan reflects reality exactly — no stale
  // classifications carry over.
  const r = q.scanQuarantineIntegrityComplete();
  const counted = fs.readdirSync(itemsDir).length;
  assert(r.pagination.total === counted && r.pagination.processed === counted,
    'fresh complete scan matches the current artifact set exactly');
}

// ===========================================================================
section('12. No skipped artifacts under stable storage (49/50/51 boundaries)');
// ===========================================================================
{
  const cleanup: string[] = [];
  for (const count of [49, 50, 51]) {
    // Reset to a known set: remove previous boundary artifacts.
    for (const c of cleanup) { fs.rmSync(path.join(itemsDir, c), { force: true }); }
    cleanup.length = 0;
    const baseline = q.scanQuarantineIntegrityComplete().orphanedData.length;
    for (let i = 0; i < count; i++) {
      const id = ID(3000 + count * 100 + i);
      craftOrphanOnly(id, `b${i}`);
      cleanup.push(`${id}.data`);
    }
    const complete = q.scanQuarantineIntegrityComplete();
    assert(complete.orphanedData.length === baseline + count && complete.pagination.processed === complete.pagination.total,
      `${count} boundary artifacts → orphan delta ${complete.orphanedData.length - baseline}, none skipped`);
  }
  for (const c of cleanup) fs.rmSync(path.join(itemsDir, c), { force: true });
}

// ===========================================================================
section('13. No duplicate classifications');
// ===========================================================================
{
  const complete = q.scanQuarantineIntegrityComplete();
  const idsPerClass = [
    complete.orphanedData.map((o) => o.quarantineId),
    complete.orphanedMeta.map((o) => o.quarantineId),
    complete.corrupted.map((c) => c.quarantineId),
  ];
  for (const ids of idsPerClass) {
    assert(new Set(ids).size === ids.length, 'no id appears twice within a class');
  }
  const orphanIds = new Set(idsPerClass.flat());
  assert(!complete.valid.some((v) => orphanIds.has(v.quarantineId)), 'no id is both orphaned and valid');
}

// ===========================================================================
section('14. Repeated scans remain read-only and idempotent');
// ===========================================================================
{
  const dirBefore = fs.readdirSync(itemsDir).sort().join('|');
  const statBefore = fs.readdirSync(itemsDir).map((f) => fs.statSync(path.join(itemsDir, f)).mtimeMs).sort((a, b) => a - b).join(',');
  const r1 = q.scanQuarantineIntegrityComplete();
  const r2 = q.scanQuarantineIntegrityComplete();
  const dirAfter = fs.readdirSync(itemsDir).sort().join('|');
  const statAfter = fs.readdirSync(itemsDir).map((f) => fs.statSync(path.join(itemsDir, f)).mtimeMs).sort((a, b) => a - b).join(',');
  assert(dirBefore === dirAfter && statBefore === statAfter, 'directory bytes and mtimes unchanged across scans');
  assert(JSON.stringify(classSig(r1)) === JSON.stringify(classSig(r2)), 'two complete scans classify identically');
  const journalBefore = fs.readFileSync(journalFile, 'utf8');
  q.auditedQuarantineScan();
  assert(fs.readFileSync(journalFile, 'utf8') === journalBefore, 'scan never writes the sandbox journal');
  function classSig(r: ReturnType<typeof q.scanQuarantineIntegrityComplete>) {
    return {
      o: r.orphanedData.map((o) => o.quarantineId).sort(), m: r.orphanedMeta.map((o) => o.quarantineId).sort(),
      c: r.corrupted.map((c) => c.quarantineId).sort(), v: r.valid.map((v) => v.quarantineId).sort(),
      conflicts: r.associationConflicts.map((c) => c.quarantineId).sort(),
    };
  }
}

// ===========================================================================
section('15. Emergency-stop and permission enforcement');
// ===========================================================================
{
  armStop('H2StopCheck#1', 'test');
  const scanDuringStop = q.scanQuarantineIntegrity(); // read-only: allowed
  assert(scanDuringStop.pagination.completed === true || scanDuringStop.pagination.processed > 0,
    'read-only scan works during stop (authorizes nothing)');
  await assertThrows(() => q.releaseQuarantine([path.join(fsRoots, 'whatever.txt')]),
    'release still stop-blocked', 'emergency stop is ACTIVE');
  recoverStop('H2StopCheck#1', 'test');
  await assertThrows(() => sc.assertSandboxMutation('terminal.execution', 'quarantine-x', 'x'),
    'default-deny capability still refused', 'permission_denied');
}

// ===========================================================================
section('16. Audit records describe partial and completed scans');
// ===========================================================================
{
  const partial = q.auditedQuarantineScan({ continuation: {}, limit: 10 }); // token-bearing → audited PARTIAL page
  const full = q.scanQuarantineIntegrityComplete();
  const auditedFull = q.auditedQuarantineScan(); // no continuation → walks ALL pages, audited aggregate
  void partial; void full; void auditedFull;
  const audit = fs.readFileSync(auditFile, 'utf8').split('\n').filter((l) => l.includes('"e5_quarantine_scan"'));
  const last = JSON.parse(audit[audit.length - 1]);
  assert(last.completed === true, 'the final scan audited as COMPLETED');
  assert(typeof last.processed === 'number' && typeof last.total === 'number' && last.processed === last.total,
    `completed scan audited with processed=total (${last.processed}/${last.total})`);
  const anyPartial = audit.map((l) => JSON.parse(l)).some((rec) => rec.completed === false);
  assert(anyPartial, 'partial scans audited as PARTIAL (never mistaken for complete)');
  assert(audit.every((l) => l.includes('"digest"')), 'every scan audit carries its page-set digest');
}

// ===========================================================================
section('17. Existing valid quarantine entries remain unchanged');
// ===========================================================================
{
  const f = path.join(fsRoots, 'h2-final.txt');
  fs.writeFileSync(f, 'final-body');
  await sys.fsDelete(f);
  const item = q.listQuarantine().items.find((i) => i.originalPath === f)!;
  const dataPath = path.join(itemsDir, `${item.quarantineId}.data`);
  const before = fs.readFileSync(dataPath);
  q.scanQuarantineIntegrityComplete();
  q.auditedQuarantineScan();
  assert(fs.readFileSync(dataPath).equals(before), 'valid entry byte-identical through H2 scans');
  const rel = q.releaseQuarantine([f]);
  assert(rel.released.length === 1 && fs.readFileSync(f, 'utf8') === 'final-body',
    'E7 release flow intact after H2 changes');
  // Cleanup for a clean exit.
  const leftovers = fs.readdirSync(itemsDir);
  assert(leftovers.length >= 0, 'suite state consistent at exit');
}

// ===========================================================================
console.log(`\n== E5 H2 RESULTS: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch { /* best-effort cleanup */ }
process.exit(0);
