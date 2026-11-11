/**
 * E5 M3 — Rollback & Quarantine test suite.
 *
 * Deterministic throughout: challenge expiry is exercised by manipulating the
 * server-authoritative challenge store (no sleeps); races are covered by
 * refusal-path assertions, not timing. Every assertion below was executed.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e5-m3-'));
const fsRoots = path.join(tmp, 'fsroots');
const storeDir = path.join(tmp, 'e5store'); // OUTSIDE the model roots
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
async function assertRejects(fn: () => unknown, label: string, needle?: string): Promise<string> {
  try {
    await fn();
    assert(false, `${label} [no error thrown]`);
    return '';
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    assert(!needle || msg.includes(needle), `${label} — got: ${msg}`);
    return msg;
  }
}

const { resolveSafePath, getStorageInfo, stopKind, armStop, recoverStop, stopSnapshot, serverPermissions } = await import('../serverSafety');
const sc = await import('../sandboxCore');
const q = await import('../quarantineCore');
const rb = await import('../rollbackCore');
const sys = await import('../systemAgentServer');

assert(path.resolve(getStorageInfo().root ?? '').toLowerCase().startsWith(storeDir.toLowerCase()), 'store resolved to the isolated KRISHA_SANDBOX_DIR');
assert(stopKind() === 'INACTIVE', 'boots INACTIVE');

const journalFile = path.join(storeDir, 'sandbox-journal', 'journal.jsonl');

/** Perform a real tracked file-create through the HTTP-layer op and return
 *  the server-minted opId from the journal. */
async function trackedCreate(name: string, content: string): Promise<string> {
  await sys.fsCreate(path.join(fsRoots, name), 'file', content);
  const entries = sc.readJournalEntries();
  const started = [...entries].reverse().find((e) => e.t === 'staging_started' && (e as { destPath?: string }).destPath?.endsWith(name));
  if (!started) throw new Error(`no staging_started found for ${name}`);
  return (started as { opId: string }).opId;
}

// ===========================================================================
section('A. Plan generation, deterministic hashing, and plan binding');
// ===========================================================================
{
  const opId = await trackedCreate('plan-a.txt', 'plan-body');
  const p1 = rb.planRollback(opId);
  assert(p1.plan.opKind === 'create-file' && p1.plan.inverse.kind === 'delete-created', 'plan identifies the create and its inverse');
  assert(p1.plan.journalRefs.length === 3, 'plan binds the exact staging records (started/ready/committed)');
  assert(p1.plan.stopGeneration === stopSnapshot().generation, 'plan records the current stop generation');
  assert(typeof p1.plan.journalHash === 'string' && p1.plan.journalHash.length === 64, 'plan binds the journal state hash');
  const p2 = rb.planRollback(opId);
  assert(p1.planHash === p2.planHash, 'plan hash is deterministic for identical journal state');
  assert(p1.challenge.challengeId !== p2.challenge.challengeId, 'each plan request issues a fresh challenge id');
  assert(p1.challenge.challengeId.length === 64, 'challenge id is cryptographically random (32 bytes hex)');
  // Client-supplied plan content is never trusted: only the server-side plan is.
  assert(rb.rollbackPlanStore.has(p1.planHash), 'plan stored server-side under its hash');
  await assertRejects(() => rb.planRollback('00000000-0000-4000-8000-000000000000'),
    'plan for unknown opId refused', 'no rollback-capable journal record');
}

// ===========================================================================
section('B. Stale plans and journal binding');
// ===========================================================================
{
  const opId = await trackedCreate('stale-b.txt', 'stale-body');
  const p = rb.planRollback(opId);
  await trackedCreate('unrelated-b.txt', 'moves the journal');
  assertRejects(() => rb.executeRollback({ opId, planHash: p.planHash, challengeId: p.challenge.challengeId }),
    'stale plan rejected after journal change', 'journal state changed');
  // A fresh plan against the same op still works (binding is per-state).
  const p2 = rb.planRollback(opId);
  assert(p2.plan.opKind === 'create-file', 'fresh plan after journal change succeeds');
}

// ===========================================================================
section('C. Challenge lifecycle — approval, expiry, replay, wrong ids');
// ===========================================================================
{
  const opId = await trackedCreate('chal-c.txt', 'chal-body');
  const p = rb.planRollback(opId);

  assertRejects(() => rb.executeRollback({ opId, planHash: p.planHash, challengeId: p.challenge.challengeId }),
    'execute before approval refused', 'not approved');

  // Wrong plan hash / wrong op id / unknown challenge — deterministic refusals.
  assertRejects(() => rb.executeRollback({ opId, planHash: 'f'.repeat(64), challengeId: p.challenge.challengeId }),
    'unknown plan hash refused', 'unknown plan hash');
  assertRejects(() => rb.executeRollback({ opId: '00000000-0000-4000-8000-000000000000', planHash: p.planHash, challengeId: p.challenge.challengeId }),
    'wrong operation id refused', 'different operation');
  assertRejects(() => rb.executeRollback({ opId, planHash: p.planHash, challengeId: 'deadbeef' }),
    'unknown challenge refused', 'unknown challenge');

  rb.approveChallenge(p.challenge.challengeId);
  assertRejects(() => rb.approveChallenge(p.challenge.challengeId),
    'double-approval (replay) rejected', 'replay rejected');
  const res = rb.executeRollback({ opId, planHash: p.planHash, challengeId: p.challenge.challengeId });
  assert(res.executed === true && res.opKind === 'create-file', 'approved challenge executes the inverse');
  assert(!fs.existsSync(path.join(fsRoots, 'chal-c.txt')), 'created file removed by rollback');
  assertRejects(() => rb.executeRollback({ opId, planHash: p.planHash, challengeId: p.challenge.challengeId }),
    'consumed challenge replay rejected', 'replay rejected');

  // Expiry: deterministic — manipulate the server-authoritative store.
  const opId2 = await trackedCreate('chal-c2.txt', 'chal-body-2');
  const p2 = rb.planRollback(opId2);
  const rec = rb.rollbackChallengeStore.get(p2.challenge.challengeId)!;
  rec.expiresAt = Date.now() - 1000; // expired
  assertRejects(() => rb.executeRollback({ opId: opId2, planHash: p2.planHash, challengeId: p2.challenge.challengeId }),
    'expired challenge refused at execute', 'expired');
  assertRejects(() => rb.approveChallenge(p2.challenge.challengeId),
    'expired challenge refused at approve', 'expired');

  // Declined challenge cannot execute; retry needs a fresh plan+challenge.
  const opId3 = await trackedCreate('chal-c3.txt', 'chal-body-3');
  const p3 = rb.planRollback(opId3);
  rb.declineChallenge(p3.challenge.challengeId);
  assertRejects(() => rb.executeRollback({ opId: opId3, planHash: p3.planHash, challengeId: p3.challenge.challengeId }),
    'declined challenge refused', 'declined');
  const p3b = rb.planRollback(opId3);
  rb.approveChallenge(p3b.challenge.challengeId);
  const r3 = rb.executeRollback({ opId: opId3, planHash: p3b.planHash, challengeId: p3b.challenge.challengeId });
  assert(r3.executed === true, 'fresh plan + fresh challenge after decline executes');
}

// ===========================================================================
section('D. Stop-generation binding and stop during rollback');
// ===========================================================================
{
  const opId = await trackedCreate('stop-d.txt', 'stop-body');
  const p = rb.planRollback(opId);
  rb.approveChallenge(p.challenge.challengeId);
  armStop('M3Rollback#1', 'test');
  assertRejects(() => rb.executeRollback({ opId, planHash: p.planHash, challengeId: p.challenge.challengeId }),
    'stop activation invalidates the challenge (generation change)', 'stop generation changed');
  recoverStop('M3Rollback#1', 'test');
  // Even a fresh plan+challenge cannot execute while the stop is ACTIVE.
  const p2 = rb.planRollback(opId); // planning allowed (read-only), stopGeneration recorded
  rb.approveChallenge(p2.challenge.challengeId);
  armStop('M3Rollback#2', 'test');
  assertRejects(() => rb.executeRollback({ opId, planHash: p2.planHash, challengeId: p2.challenge.challengeId }),
    'execution refused while stop ACTIVE (entry-boundary halt)', 'stop generation changed');
  recoverStop('M3Rollback#2', 'test');
  const p3 = rb.planRollback(opId);
  rb.approveChallenge(p3.challenge.challengeId);
  const ok = rb.executeRollback({ opId, planHash: p3.planHash, challengeId: p3.challenge.challengeId });
  assert(ok.executed === true, 'execution works after the stop is recovered');
}

// ===========================================================================
section('E. Identity changes, parent replacement, unexpected user changes');
// ===========================================================================
{
  // Identity change between planning and execution (create rollback).
  const opId = await trackedCreate('idch-e.txt', 'original');
  const p = rb.planRollback(opId);
  rb.approveChallenge(p.challenge.challengeId); // approval precedes the identity refusal
  fs.appendFileSync(path.join(fsRoots, 'idch-e.txt'), '-user-edit');
  assertRejects(() => rb.executeRollback({ opId, planHash: p.planHash, challengeId: p.challenge.challengeId }),
    'content-changed create refuses rollback at execution (user changes preserved)', 'target changed since planning');
  assert(fs.existsSync(path.join(fsRoots, 'idch-e.txt')), 'modified file PRESERVED after refusal');

  // Parent-directory replacement.
  const dirA = path.join(fsRoots, 'rb-parent');
  fs.mkdirSync(dirA);
  await sys.fsCreate(path.join(dirA, 'inner.txt'), 'file', 'x');
  const entries = sc.readJournalEntries();
  const started = [...entries].reverse().find((e) => e.t === 'staging_started' && (e as { destPath?: string }).destPath === path.join(dirA, 'inner.txt'));
  const opId2 = (started as { opId: string }).opId;
  const p2 = rb.planRollback(opId2);
  rb.approveChallenge(p2.challenge.challengeId);
  // Swap the parent directory (new inode, same path).
  const hold = path.join(tmp, 'hold-dir');
  fs.renameSync(path.join(fsRoots, 'rb-parent'), hold);
  fs.mkdirSync(path.join(fsRoots, 'rb-parent'));
  fs.renameSync(path.join(hold, 'inner.txt'), path.join(fsRoots, 'rb-parent', 'inner.txt')); // preserve the node itself
  assertRejects(() => rb.executeRollback({ opId: opId2, planHash: p2.planHash, challengeId: p2.challenge.challengeId }),
    'parent replacement refuses rollback', 'parent directory replaced');

  // Unexpected user change: rename-back blocked by an occupied origin.
  const src = path.join(fsRoots, 'rn-src.txt');
  fs.writeFileSync(src, 'rename-me');
  await sys.fsRename(src, 'rn-dst.txt');
  const entries2 = sc.readJournalEntries();
  const rec = [...entries2].reverse().find((e) => e.t === 'mutation' && (e as { op?: string }).op === 'rename');
  const opId3 = (rec as { opId: string }).opId;
  const p3 = rb.planRollback(opId3);
  rb.approveChallenge(p3.challenge.challengeId);
  fs.writeFileSync(src, 'user-created-here'); // someone re-took the origin path
  assertRejects(() => rb.executeRollback({ opId: opId3, planHash: p3.planHash, challengeId: p3.challenge.challengeId }),
    'rename-back refused when origin is occupied', 'occupied');
  assert(fs.readFileSync(src, 'utf8') === 'user-created-here', 'user file at origin untouched');
  assert(fs.existsSync(path.join(fsRoots, 'rn-dst.txt')), 'renamed node preserved after refusal');
  fs.unlinkSync(src);
  const p4 = rb.planRollback(opId3); // origin now free again
  rb.approveChallenge(p4.challenge.challengeId);
  const done = rb.executeRollback({ opId: opId3, planHash: p4.planHash, challengeId: p4.challenge.challengeId });
  assert(done.executed === true && fs.existsSync(src) && !fs.existsSync(path.join(fsRoots, 'rn-dst.txt')),
    'rename-back executes once the origin is free');
}

// ===========================================================================
section('F. Delete rollback through quarantine (E1 two-read restore)');
// ===========================================================================
{
  const f = path.join(fsRoots, 'del-f.txt');
  fs.writeFileSync(f, 'precious-content-42');
  const del = await sys.fsDelete(f);
  assert(del.deleted === true && (del as { quarantined?: boolean }).quarantined === true, 'delete captures content into quarantine (E7)');
  const qid = (del as { quarantineId?: string }).quarantineId!;
  const listing = q.listQuarantine();
  assert(listing.items.some((i) => i.quarantineId === qid && i.readable), 'quarantine item is header-readable');
  const entries = sc.readJournalEntries();
  const rec = [...entries].reverse().find((e) => e.t === 'mutation' && (e as { quarantineId?: string }).quarantineId === qid);
  const opId = (rec as { opId: string }).opId;
  assert(!!opId, 'delete journal record carries the server-minted opId + quarantine id');
  const p = rb.planRollback(opId);
  assert(p.plan.inverse.kind === 'restore-from-quarantine' && p.plan.e1Disclosure !== undefined, 'plan binds the quarantine restore with the E1 disclosure');
  rb.approveChallenge(p.challenge.challengeId);
  const res = rb.executeRollback({ opId, planHash: p.planHash, challengeId: p.challenge.challengeId });
  assert(res.executed === true && fs.readFileSync(f, 'utf8') === 'precious-content-42', 'restored content is byte-identical (E1-verified)');
  assert(!q.listQuarantine().items.some((i) => i.quarantineId === qid), 'quarantine record released after verified restore');
}

// ===========================================================================
section('G. Conservative refusals — copy-dir, create-dir with contents, compaction');
// ===========================================================================
{
  // Recursive copy: per-child identities were never established → refuse.
  const srcDir = path.join(fsRoots, 'copy-src');
  fs.mkdirSync(srcDir);
  fs.writeFileSync(path.join(srcDir, 'a.txt'), 'A');
  await sys.fsCopy(srcDir, path.join(fsRoots, 'copy-dst'));
  const entries = sc.readJournalEntries();
  const rec = [...entries].reverse().find((e) => e.t === 'mutation' && (e as { op?: string }).op === 'copy-dir');
  const opId = (rec as { opId: string }).opId;
  assertRejects(() => rb.planRollback(opId),
    'recursive-copy rollback refused (child identities not established)', 'per-child identities');

  // create-dir containing later changes → refuse (conservative ordering).
  await sys.fsCreate(path.join(fsRoots, 'cd-dir'), 'dir');
  fs.writeFileSync(path.join(fsRoots, 'cd-dir', 'later.txt'), 'later');
  const entries2 = sc.readJournalEntries();
  const rec2 = [...entries2].reverse().find((e) => e.t === 'mutation' && (e as { op?: string }).op === 'create-dir');
  const opId2 = (rec2 as { opId: string }).opId;
  assertRejects(() => rb.planRollback(opId2),
    'non-empty created-dir rollback refused', 'not empty');

  // Journal corruption → conservative refusal at planning.
  const opId3 = await trackedCreate('corrupt-g.txt', 'x');
  fs.appendFileSync(journalFile, '{corrupted line\n');
  assertRejects(() => rb.planRollback(opId3), 'corrupted journal refuses to plan', 'journal inconsistency');
  const good = fs.readFileSync(journalFile, 'utf8').replace('{corrupted line\n', '');
  fs.writeFileSync(journalFile, good); // repair for later sections

  // Compaction: a compacted-away op refuses; the journal stays consistent.
  const opId4 = await trackedCreate('compact-g.txt', 'x');
  const before = rb.planRollback(opId4);
  assert(before.plan.opKind === 'create-file', 'op plan-able before compaction');
  for (let i = 0; i < 120; i++) {
    await sys.fsCreate(path.join(fsRoots, `gchurn-${i}.txt`), 'file', 'x');
    // Core-level delete WITHOUT the quarantine hook: churn must not fill the
    // E7 retention cap (quarantine behavior is exercised in sections F/H/I).
    sc.sandboxDelete(path.join(fsRoots, `gchurn-${i}.txt`));
  }
  const lines = fs.readFileSync(journalFile, 'utf8').split('\n').filter(Boolean).length;
  assert(lines < 420, `journal stayed bounded through churn (${lines} lines)`);
  assertRejects(() => rb.planRollback(opId4),
    'compacted-away op conservatively refuses to plan', 'conservative refusal');
}

// ===========================================================================
section('H. Quarantine scope, declarations, and unauthorized release');
// ===========================================================================
{
  const a = path.join(fsRoots, 'q-a.txt');
  const b = path.join(fsRoots, 'q-b.txt');
  fs.writeFileSync(a, 'AAA'); fs.writeFileSync(b, 'BBB');
  await sys.fsDelete(a);
  await sys.fsDelete(b);
  assert(q.listQuarantine().items.length >= 2, 'two items retained in quarantine');

  // Wrong declaration → refused per declaration (return value); nothing released.
  const wrongDecl = q.releaseQuarantine([path.join(fsRoots, 'q-WRONG.txt')]);
  assert(wrongDecl.released.length === 0 && wrongDecl.refused.length === 1, 'non-matching declaration refused, nothing released');
  // Declaration matches only ONE item → scoped release.
  const rel = q.releaseQuarantine([a]);
  assert(rel.released.length === 1 && rel.released[0] === a && fs.readFileSync(a, 'utf8') === 'AAA', 'scoped release restores exactly the declared path');
  assert(q.listQuarantine().items.some((i) => i.originalPath === b), 'the undeclared item remains retained (scoped release only)');

  // Corrupt one header → quarantine GLOBALLY LOCKED.
  const items = q.listQuarantine().items;
  const target = items.find((i) => i.originalPath === b)!;
  fs.appendFileSync(path.join(storeDir, 'quarantine', 'items', `${target.quarantineId}.meta.json`), 'tamper');
  assert(q.listQuarantine().globallyLocked === true, 'unreadable header locks the quarantine globally');
  assertRejects(() => q.releaseQuarantine([b]), 'release refused while quarantine is globally locked', 'GLOBALLY LOCKED');
  // Acknowledgement alone cannot release: there is no acknowledge-to-release
  // path at all — the item stays retained until resolved out-of-band.
  assert(fs.existsSync(path.join(storeDir, 'quarantine', 'items', `${target.quarantineId}.data`)), 'unreadable item data retained (no silent destruction)');
  // Out-of-band resolution (test acts as the operator WITH the server stopped
  // semantics — direct record removal), then release works again.
  fs.rmSync(path.join(storeDir, 'quarantine', 'items', `${target.quarantineId}.data`), { force: true });
  fs.rmSync(path.join(storeDir, 'quarantine', 'items', `${target.quarantineId}.meta.json`), { force: true });
  assert(q.listQuarantine().globallyLocked === false, 'quarantine unlockable only by out-of-band resolution');
}

// ===========================================================================
section('I. Stop and permission enforcement over quarantine + degraded refusal');
// ===========================================================================
{
  const f = path.join(fsRoots, 'q-stop.txt');
  fs.writeFileSync(f, 'x');
  await sys.fsDelete(f);
  const item = q.listQuarantine().items.find((i) => i.originalPath === f);
  assert(!!item, 'item captured for the enforcement test');
  armStop('M3Quarantine#1', 'test');
  assertRejects(() => q.releaseQuarantine([f]), 'release refused while stop ACTIVE', 'emergency stop is ACTIVE');
  recoverStop('M3Quarantine#1', 'test');
  // Permission boundary: a default-deny capability cannot drive quarantine
  // operations (stop first, then permission — deterministic order).
  assertRejects(() => sc.assertSandboxMutation('terminal.execution', 'quarantine-restore', f),
    'default-deny capability cannot drive quarantine operations', 'permission_denied');
  // Non-matching declarations are REFUSED PER DECLARATION (return value).
  const wrong = q.releaseQuarantine([path.join(fsRoots, 'q-WRONG.txt')]);
  assert(wrong.released.length === 0 && wrong.refused.length === 1 && wrong.refused[0].reason.includes('not permission to release'),
    'non-matching declaration refused without releasing anything');
}

// ===========================================================================
section('J. Structural and contract preservation');
// ===========================================================================
{
  const serverSource = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');
  const coreSource = fs.readFileSync(path.resolve(process.cwd(), 'rollbackCore.ts'), 'utf8');
  const qSource = fs.readFileSync(path.resolve(process.cwd(), 'quarantineCore.ts'), 'utf8');
  const E1 = 'Restored content is what Krisha verified via two agreeing full reads of the source; it may not correspond to any single historical version.';
  assert(sc.E1_CONTRACT === E1, 'E1 wording preserved verbatim (single contract constant in sandboxCore)');
  assert(coreSource.includes('E1_CONTRACT') && qSource.includes('E1_CONTRACT'), 'rollback + quarantine cores reference the E1 contract (no rewording)');
  const qSrc2 = fs.readFileSync(path.resolve(process.cwd(), 'quarantineCore.ts'), 'utf8');
  assert(qSrc2.includes("protection !== 'full'") && qSrc2.includes('cannot prove capture integrity'), 'quarantine restore refuses in non-full protection (guard present)');
  assert(coreSource.includes("protection !== 'full'"), 'rollback planning/execution refuses in non-full protection (guard present)');
  for (const route of ['/api/rollback/execute', '/api/quarantine/release']) {
    assert(new RegExp(`"${route}"\\s*:\\s*\\{[^}]*stopBlock:\\s*true`).test(serverSource), `${route} is stop-block-enforced`);
  }
  assert(serverSource.includes('"/api/rollback/plan"') && serverSource.includes('"/api/rollback/approve"'), 'plan + approve routes exist');
  assert(!/app\.(post|get|put|delete)\([^)]*deactivate/i.test(serverSource), 'still no HTTP deactivation route');
  assert(coreSource.includes("crypto.randomBytes(32)"), 'challenge id uses a CSPRNG');
  assert(coreSource.includes("state = 'consumed'"), 'challenge consumed at execution start');
  assert(coreSource.includes("expiresAt: now + CHALLENGE_TTL_MS"), 'challenge bound to a 10-minute TTL constant');
  const auditLog = fs.readFileSync(path.join(storeDir, 'audit', 'server-audit.jsonl'), 'utf8');
  assert(auditLog.includes('"e5_rollback_plan_requested"') && auditLog.includes('"e5_rollback_executed"'), 'rollback lifecycle audited');
  assert(auditLog.includes('"e5_quarantine_released"'), 'quarantine releases audited');
}

// ===========================================================================
console.log(`\n== E5 M3 RESULTS: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch { /* tmpdir cleanup is best-effort */ }
process.exit(0);
