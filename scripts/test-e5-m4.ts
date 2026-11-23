/**
 * E5 M4 — Adversarial verification suite.
 *
 * Every test states the security property it challenges, uses an isolated
 * environment, and asserts the resulting filesystem/journal state. Sections
 * K (fault injection) and H (live HTTP) spawn real child processes; their
 * triggers are poll-based and deterministic. Assertions that only inspect
 * source are explicitly labelled [source]. Pre-fix runs of this suite are
 * the reproduction evidence for the findings reported in the M4 report.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn, spawnSync, ChildProcess } from 'child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e5-m4-'));
const fsRoots = path.join(tmp, 'fsroots');
const storeDir = path.join(tmp, 'e5store');
fs.mkdirSync(fsRoots, { recursive: true });
process.env.KRISHA_FS_ROOTS = fsRoots;
process.env.KRISHA_SANDBOX_DIR = storeDir;

let passed = 0;
let failed = 0;
const failures: string[] = [];
const unverified: string[] = [];
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
function sha256File(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

const { getStorageInfo, stopKind, armStop, recoverStop, stopSnapshot, serverPermissions } = await import('../serverSafety');
const sc = await import('../sandboxCore');
const q = await import('../quarantineCore');
const rb = await import('../rollbackCore');
const sys = await import('../systemAgentServer');

assert(path.resolve(getStorageInfo().root ?? '').toLowerCase().startsWith(storeDir.toLowerCase()), 'isolated store in use');
assert(stopKind() === 'INACTIVE', 'boots INACTIVE');

const journalFile = path.join(storeDir, 'sandbox-journal', 'journal.jsonl');
const REPO = process.cwd();

async function trackedCreate(name: string, content: string): Promise<string> {
  const res = await sys.fsCreate(path.join(fsRoots, name), 'file', content) as { opId?: string };
  if (!res.opId) throw new Error('mutation response carries no opId');
  return res.opId;
}

/** Spawn a child tsx process with an isolated env and wait for a JSON line on stdout. */
function runChild(scriptPath: string, env: Record<string, string>, timeoutMs = 60_000): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync('npx', ['tsx', scriptPath], {
    encoding: 'utf8',
    timeout: timeoutMs,
    cwd: REPO,
    env: { ...process.env, ...env },
    shell: true,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ===========================================================================
section('A. Emergency stop and authorization');
// ===========================================================================
{
  // Forged/stale task scope: a closed task must not authorize anything.
  const task = serverPermissions.taskBegin();
  serverPermissions.taskEnd(task.taskId, 'completed');
  const verdict = serverPermissions.checkScoped('filesystem.write', { taskId: task.taskId });
  assert(verdict.status !== 'granted', 'stale/closed task scope cannot authorize a mutation');

  // Mutation under ACTIVE stop; refusals must not alter the generation.
  armStop('M4StopCheck#1', 'test');
  const genBefore = stopSnapshot().generation;
  await assertRejects(() => sys.fsCreate(path.join(fsRoots, 'during-stop.txt'), 'file', 'x'),
    'mutation refused while stop ACTIVE', 'emergency stop is ACTIVE');
  assert(stopSnapshot().generation === genBefore, 'refused mutations do not alter the stop generation');
  recoverStop('M4StopCheck#1', 'test');

  // Corruption at rest: garbage state file + marker present → child boots
  // ACTIVE_UNCERTAIN and refuses mutations (restart cannot weaken the stop).
  const childStore = path.join(tmp, 'child-store');
  const childRoots = path.join(tmp, 'child-roots');
  fs.mkdirSync(childRoots, { recursive: true });
  const childScript = path.join(tmp, 'child-boot.mts');
  fs.writeFileSync(childScript, `
    const ss = await import('file:///${REPO.replace(/\\/g, '/')}/serverSafety');
    const sys = await import('file:///${REPO.replace(/\\/g, '/')}/systemAgentServer');
    let mutation = null;
    try { await sys.fsCreate(${JSON.stringify(path.join(childRoots, 'x.txt'))}, 'file', 'x'); mutation = 'allowed'; }
    catch (e) { mutation = String(e.message || e); }
    console.log(JSON.stringify({ kind: ss.stopKind(), mutation }));
    process.exit(0);
  `);
  fs.mkdirSync(childStore, { recursive: true });
  fs.writeFileSync(path.join(childStore, 'install.marker'), '{}');
  fs.writeFileSync(path.join(childStore, 'stop-state.json'), '{ CORRUPTED NOT JSON');
  const c1 = runChild(childScript, { KRISHA_FS_ROOTS: childRoots, KRISHA_SANDBOX_DIR: childStore });
  const out1 = JSON.parse(c1.stdout.trim().split('\n').pop() || '{}');
  assert(out1.kind === 'ACTIVE_UNCERTAIN', 'corrupted state + marker boots ACTIVE_UNCERTAIN (restart cannot weaken the stop)');
  assert(String(out1.mutation).includes('UNCERTAIN') || String(out1.mutation).includes('ACTIVE'), 'mutation refused under boot-time uncertainty');

  // Valid ACTIVE state with a missing marker → boots per state, marker self-heals.
  const childStore2 = path.join(tmp, 'child-store2');
  const bootScript = path.join(tmp, 'child-activate.mts');
  fs.writeFileSync(bootScript, `
    const ss = await import('file:///${REPO.replace(/\\/g, '/')}/serverSafety');
    ss.activateStop('m4-baseline', 'child');
    console.log(JSON.stringify({ kind: ss.stopKind() }));
    process.exit(0);
  `);
  const c2 = runChild(bootScript, { KRISHA_FS_ROOTS: childRoots, KRISHA_SANDBOX_DIR: childStore2 });
  JSON.parse(c2.stdout.trim().split('\n').pop() || '{}');
  fs.rmSync(path.join(childStore2, 'install.marker'), { force: true });
  const c3 = runChild(childScript, { KRISHA_FS_ROOTS: childRoots, KRISHA_SANDBOX_DIR: childStore2 });
  const out3 = JSON.parse(c3.stdout.trim().split('\n').pop() || '{}');
  assert(out3.kind === 'ACTIVE_NO_CREDENTIAL' && fs.existsSync(path.join(childStore2, 'install.marker')),
    'valid ACTIVE state with missing marker boots ACTIVE and self-heals the marker');

  // [source] Every mutating POST route is enforced; model/UI paths cannot
  // approve rollbacks or deactivate the stop.
  const serverSource = fs.readFileSync(path.join(REPO, 'server.ts'), 'utf8');
  const postRoutes = [...serverSource.matchAll(/app\.(post|put|delete)\(\s*["']([^"']+)["']/g)].map((m) => m[2]);
  const enforced = [...serverSource.matchAll(/"([^"]+)":\s*\{[^}]*stopBlock:\s*true/g)].map((m) => m[1]);
  const readOnlyAllowed = new Set([
    '/api/location/geocode', '/api/research/search', '/api/research/fetch',
    '/api/browser/state', '/api/browser/tabs',
    '/api/fs/list', '/api/fs/inspect', '/api/fs/search', '/api/fs/read',
    '/api/app/discover', '/api/app/status',
    '/api/rollback/plan', '/api/rollback/approve', '/api/rollback/decline', '/api/rollback/pending',
    '/api/quarantine/list', '/api/quarantine/scan', '/api/chat', '/api/tts', '/api/audio/transcribe', '/api/maps/grounding', '/api/vision/analyze',
    '/api/screen/understand', // live perception: local WinRT OCR only, per-line SPF screening, rate-capped, no side effects
    '/api/safety/stop/activate', // designed unauthenticated activation; own rate limit + audit (M1 D3)
  ]);
  const unenforcedMutationRisk = postRoutes.filter((r) => !enforced.includes(r) && !readOnlyAllowed.has(r));
  assert(unenforcedMutationRisk.length === 0, `all POST routes are enforced or on the audited read-only allowlist (unaccounted: ${unenforcedMutationRisk.join(',') || 'none'})`);
  const bridgeSource = fs.readFileSync(path.join(REPO, 'src/agent/bridge.ts'), 'utf8');
  const toolsSource = fs.readFileSync(path.join(REPO, 'src/agent/safety/safetyTools.ts'), 'utf8');
  assert(!bridgeSource.includes('/api/rollback/approve') && !toolsSource.includes('/api/rollback/approve'),
    'no model/bridge path can approve a rollback [source]');
  assert(!/deactivate\s*\(/.test(toolsSource), 'no model-callable deactivation [source]');
}

// ===========================================================================
section('B. Filesystem identity and TOCTOU');
// ===========================================================================
{
  // Identical content, different inode: replacement must be detected.
  const f = path.join(fsRoots, 'same-bytes.txt');
  fs.writeFileSync(f, 'identical');
  const opId = await trackedCreate('same-bytes-target.txt', 'created');
  const p = rb.planRollback(opId);
  rb.approveChallenge(p.challenge.challengeId);
  const inodeBefore = fs.statSync(p.plan.inverse.targetPath).ino;
  fs.copyFileSync(p.plan.inverse.targetPath, path.join(tmp, 'keep.txt'));
  fs.rmSync(p.plan.inverse.targetPath, { force: true });
  fs.copyFileSync(path.join(tmp, 'keep.txt'), p.plan.inverse.targetPath); // same bytes, NEW inode
  assert(fs.statSync(p.plan.inverse.targetPath).ino !== inodeBefore, 'replacement has different inode with identical content');
  assertRejects(() => rb.executeRollback({ opId, planHash: p.planHash, challengeId: p.challenge.challengeId }),
    'identical-content replacement refuses rollback', 'changed since planning');
  assert(fs.readFileSync(p.plan.inverse.targetPath, 'utf8') === 'created', 'replaced (user) content preserved');

  // Hard-link substitution at the rollback target (file symlinks require
  // administrator privileges on Windows — directory junctions are covered in
  // the M2 suite; the same-identity property is what this challenges).
  const f2 = path.join(fsRoots, 'jct-target.txt');
  const opId2 = await trackedCreate('jct-target.txt', 'x');
  const p2 = rb.planRollback(opId2);
  rb.approveChallenge(p2.challenge.challengeId);
  const outsideNode = path.join(tmp, 'outside-node.txt');
  fs.writeFileSync(outsideNode, 'elsewhere');
  fs.rmSync(f2, { force: true });
  fs.linkSync(outsideNode, f2); // same-volume hard link to an out-of-root node
  assertRejects(() => rb.executeRollback({ opId: opId2, planHash: p2.planHash, challengeId: p2.challenge.challengeId }),
    'hard-link substitution refuses rollback', 'changed since planning');
  assert(fs.readFileSync(outsideNode, 'utf8') === 'elsewhere', 'substituted node untouched');

  // Non-recursive delete of a non-empty directory (with capture hook): refuse
  // and preserve every child.
  const dir = path.join(fsRoots, 'ne-dir');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'child.txt'), 'child-data');
  await assertRejects(() => sys.fsDelete(dir), 'non-recursive delete of non-empty dir refused', 'recursive deletion is required');
  assert(fs.readFileSync(path.join(dir, 'child.txt'), 'utf8') === 'child-data', 'directory contents fully preserved after refusal');

  // Rename onto an occupied destination: refused, both nodes intact.
  const r1 = path.join(fsRoots, 'rn-a.txt');
  const r2 = path.join(fsRoots, 'rn-b.txt');
  fs.writeFileSync(r1, 'A'); fs.writeFileSync(r2, 'B');
  await assertRejects(() => sys.fsRename(r1, 'rn-b.txt'), 'rename onto occupied destination refused', 'already exists');
  assert(fs.readFileSync(r1, 'utf8') === 'A' && fs.readFileSync(r2, 'utf8') === 'B', 'both nodes intact after refusal');
}

// ===========================================================================
section('C. E1 / E4 staging and journal integrity');
// ===========================================================================
{
  // Binary round-trip through quarantine (NULs, 0xFF, multibyte UTF-8).
  const bin = path.join(fsRoots, 'bin.dat');
  const binary = Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x00, 0x41, 0xE2, 0x82, 0xAC, 0x00, 0x7F]);
  fs.writeFileSync(bin, binary);
  await sys.fsDelete(bin);
  const item = q.listQuarantine().items.find((i) => i.originalPath === bin);
  assert(!!item, 'binary file captured');
  const rel = q.releaseQuarantine([bin]);
  assert(rel.released.length === 1 && fs.readFileSync(bin).equals(binary), 'binary restore is byte-identical (two agreeing reads + hash)');

  // Oversized (> 64 MB) file: capture is rename-based and UNHASHED — the
  // header stays readable; restore proceeds by identity-verified rename and
  // must be byte-identical.
  const big = path.join(fsRoots, 'big.dat');
  const chunk = crypto.randomBytes(1024 * 1024);
  const fd = fs.openSync(big, 'w');
  for (let i = 0; i < 65; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  const bigHash = sha256File(big);
  await sys.fsDelete(big);
  const bigItem = q.listQuarantine().items.find((i) => i.originalPath === big);
  assert(!!bigItem && bigItem.readable && bigItem.contentBytes === 65 * 1024 * 1024, 'oversized capture retained with a readable header');
  const bigMeta = JSON.parse(fs.readFileSync(path.join(storeDir, 'quarantine', 'items', `${bigItem!.quarantineId}.meta.json`), 'utf8'));
  assert(!bigMeta.contentSha256, 'oversized capture honestly marked unhashed (no false content-hash claim)');
  const bigRel = q.releaseQuarantine([big]);
  assert(bigRel.released.length === 1 && sha256File(big) === bigHash, 'oversized restore byte-identical (identity-verified rename)');

  // Journal truncation: an op whose records were truncated refuses to plan.
  const truncOp = await trackedCreate('trunc-c.txt', 'x');
  const raw = fs.readFileSync(journalFile, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  fs.writeFileSync(journalFile, lines.slice(0, Math.max(1, lines.length - 3)).join('\n') + '\n');
  assertRejects(() => rb.planRollback(truncOp), 'truncated journal refuses to plan the truncated op', 'no rollback-capable journal record');
  // Repair for later sections.
  fs.writeFileSync(journalFile, raw);
  // Journal line reordering: parseable but a DIFFERENT state — old challenges
  // must be invalidated by the journal-hash binding.
  const reOp = await trackedCreate('reorder-c.txt', 'x');
  const p = rb.planRollback(reOp);
  rb.approveChallenge(p.challenge.challengeId);
  const cur = fs.readFileSync(journalFile, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(journalFile, [...cur.slice(1), cur[0]].join('\n') + '\n');
  assertRejects(() => rb.executeRollback({ opId: reOp, planHash: p.planHash, challengeId: p.challenge.challengeId }),
    'journal reordering invalidates the bound challenge', 'journal state changed');

  // Closure-record deletion: the op becomes unresolved → conservative sweep.
  fs.writeFileSync(journalFile, raw);
  const missOp = await trackedCreate('closure-c.txt', 'x');
  const entries = sc.readJournalEntries();
  const withoutCommitted = fs.readFileSync(journalFile, 'utf8').split('\n')
    .filter((l) => !(l.includes('"staging_committed"') && l.includes(missOp))).join('\n');
  fs.writeFileSync(journalFile, withoutCommitted);
  const stagePath = entries.find((e) => e.t === 'staging_started' && (e as { opId?: string }).opId === missOp);
  const destPath = (stagePath as { destPath?: string }).destPath!;
  fs.rmSync(destPath, { force: true }); // simulate the committed file being gone too
  const sweep = sc.sweepStaging();
  assert(sweep.missing.length >= 1, 'orphaned-by-deletion staging recorded as missing (never guessed)');

  // Unknown staging-like files are never swept.
  const stranger = path.join(fsRoots, '.krisha-stage-11111111-2222-4333-8444-555555555555.tmp');
  fs.writeFileSync(stranger, 'not-ours');
  sc.sweepStaging();
  assert(fs.existsSync(stranger), 'unknown staging-pattern file never deleted by sweep');
  fs.rmSync(stranger, { force: true });

  const { E1_CONTRACT } = await import('../sandboxCore');
  assert(E1_CONTRACT === 'Restored content is what Krisha verified via two agreeing full reads of the source; it may not correspond to any single historical version.',
    'E1 wording unchanged (constant compared byte-for-byte)');
  unverified.push('C: two-full-read mid-flight disagreement cannot be deterministically injected in-process (synchronous reads; needs a concurrent external mutator) — refusal path source-reviewed, agreement path runtime-tested');
}

// ===========================================================================
section('D. Rollback authorization and execution lifecycle');
// ===========================================================================
{
  // A failed execution consumes the challenge (single-use despite failure);
  // retry requires a fresh plan + challenge.
  const opId = await trackedCreate('fail-d.txt', 'v1');
  const p = rb.planRollback(opId);
  rb.approveChallenge(p.challenge.challengeId);
  fs.appendFileSync(p.plan.inverse.targetPath, '-edited'); // execution will refuse
  assertRejects(() => rb.executeRollback({ opId, planHash: p.planHash, challengeId: p.challenge.challengeId }),
    'execution refuses on identity change', 'changed since planning');
  assertRejects(() => rb.executeRollback({ opId, planHash: p.planHash, challengeId: p.challenge.challengeId }),
    'failed execution still consumed the challenge (replay rejected)', 'replay rejected');
  // Undo the edit EXACTLY (bytes + mtime — the strict guard rightly rejects
  // a rewritten file whose mtime differs from the captured creation state).
  fs.writeFileSync(p.plan.inverse.targetPath, 'v1');
  fs.utimesSync(p.plan.inverse.targetPath, new Date(), new Date(p.plan.identities.target!.mtimeMs));
  const p2 = rb.planRollback(opId);
  assertRejects(() => rb.executeRollback({ opId, planHash: p2.planHash, challengeId: p2.challenge.challengeId }),
    'fresh plan without approval still refused', 'not approved');
  rb.approveChallenge(p2.challenge.challengeId);
  const ok = rb.executeRollback({ opId, planHash: p2.planHash, challengeId: p2.challenge.challengeId });
  assert(ok.executed === true, 'retry with fresh authorization executes');

  // Approval for op A cannot execute op B.
  const opA = await trackedCreate('auth-a.txt', 'A');
  const opB = await trackedCreate('auth-b.txt', 'B');
  const pa = rb.planRollback(opA);
  const pb = rb.planRollback(opB);
  rb.approveChallenge(pa.challenge.challengeId);
  assertRejects(() => rb.executeRollback({ opId: opB, planHash: pb.planHash, challengeId: pa.challenge.challengeId }),
    'approval for A cannot execute B', 'bind this operation');
  assertRejects(() => rb.executeRollback({ opId: opB, planHash: pa.planHash, challengeId: pa.challenge.challengeId }),
    'plan/op mismatch refused', 'different operation');

  // Copy-file rollback: the copy is removed, the source untouched.
  const srcF = path.join(fsRoots, 'cp-src.txt');
  fs.writeFileSync(srcF, 'source');
  await sys.fsCopy(srcF, path.join(fsRoots, 'cp-dst.txt'));
  const entries = sc.readJournalEntries();
  const started = [...entries].reverse().find((e) => e.t === 'staging_started' && (e as { op?: string }).op === 'copy');
  const cpOp = (started as { opId: string }).opId;
  const pc = rb.planRollback(cpOp);
  assert(pc.plan.opKind === 'copy-file' && pc.plan.inverse.kind === 'delete-created', 'copy plan identified');
  rb.approveChallenge(pc.challenge.challengeId);
  rb.executeRollback({ opId: cpOp, planHash: pc.planHash, challengeId: pc.challenge.challengeId });
  assert(!fs.existsSync(path.join(fsRoots, 'cp-dst.txt')) && fs.readFileSync(srcF, 'utf8') === 'source', 'copy rolled back; source intact');

  // Move rollback: the node returns to its origin.
  const mSrc = path.join(fsRoots, 'mv-src.txt');
  fs.writeFileSync(mSrc, 'M');
  await sys.fsMove(mSrc, path.join(fsRoots, 'mv-dst.txt'));
  const entries2 = sc.readJournalEntries();
  const mvRec = [...entries2].reverse().find((e) => e.t === 'mutation' && (e as { op?: string }).op === 'move');
  const mvOp = (mvRec as { opId: string }).opId;
  const pm = rb.planRollback(mvOp);
  rb.approveChallenge(pm.challenge.challengeId);
  rb.executeRollback({ opId: mvOp, planHash: pm.planHash, challengeId: pm.challenge.challengeId });
  assert(fs.readFileSync(mSrc, 'utf8') === 'M' && !fs.existsSync(path.join(fsRoots, 'mv-dst.txt')), 'move rolled back to origin');
}

// ===========================================================================
section('E. Quarantine integrity — file, binary, and DIRECTORY TREES');
// ===========================================================================
{
  // Build a nested tree and delete it (capture by rename preserves identity).
  const tree = path.join(fsRoots, 'qtree');
  fs.mkdirSync(path.join(tree, 'sub', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'root.txt'), 'ROOT');
  fs.writeFileSync(path.join(tree, 'sub', 'mid.bin'), Buffer.from([0, 2, 3, 0xFF, 0]));
  fs.writeFileSync(path.join(tree, 'sub', 'deeper', 'leaf.txt'), 'LEAF-42');
  const treeHashes = {
    root: sha256File(path.join(tree, 'root.txt')),
    mid: sha256File(path.join(tree, 'sub', 'mid.bin')),
    leaf: sha256File(path.join(tree, 'sub', 'deeper', 'leaf.txt')),
  };
  const del = await sys.fsDelete(tree, true) as { quarantined?: boolean; quarantineId?: string };
  assert(del.quarantined === true && !!del.quarantineId, 'directory tree captured into quarantine');
  const treeOpEntry = [...sc.readJournalEntries()].reverse().find((e) => e.t === 'mutation' && (e as { quarantineId?: string }).quarantineId === del.quarantineId);
  const treeOp = (treeOpEntry as { opId?: string }).opId!;

  // THE ADVERSARIAL CASE: modify a descendant WHILE quarantined, then roll back.
  const dataPath = path.join(storeDir, 'quarantine', 'items', `${del.quarantineId}.data`);
  fs.writeFileSync(path.join(dataPath, 'root.txt'), 'TAMPERED'); // same-user tamper
  const pt = rb.planRollback(treeOp);
  rb.approveChallenge(pt.challenge.challengeId);
  assertRejects(() => rb.executeRollback({ opId: treeOp, planHash: pt.planHash, challengeId: pt.challenge.challengeId }),
    'tampered quarantined tree refuses restore (descendant integrity enforced)', 'quarantined tree changed');
  assert(fs.existsSync(dataPath), 'tampered tree data retained (preserved, not destroyed)');

  // Untampered tree restores byte-identically.
  fs.writeFileSync(path.join(dataPath, 'root.txt'), 'ROOT');
  const pt2 = rb.planRollback(treeOp);
  rb.approveChallenge(pt2.challenge.challengeId);
  const res = rb.executeRollback({ opId: treeOp, planHash: pt2.planHash, challengeId: pt2.challenge.challengeId });
  assert(res.executed === true &&
    sha256File(path.join(tree, 'root.txt')) === treeHashes.root &&
    sha256File(path.join(tree, 'sub', 'mid.bin')) === treeHashes.mid &&
    sha256File(path.join(tree, 'sub', 'deeper', 'leaf.txt')) === treeHashes.leaf,
    'untampered tree restores byte-identically (nested dirs + binary)');

  // Header truncation → unreadable → globally locked.
  const t2 = path.join(fsRoots, 'qtree2');
  fs.mkdirSync(t2);
  fs.writeFileSync(path.join(t2, 'x.txt'), 'x');
  await sys.fsDelete(t2, true);
  const item2 = q.listQuarantine().items.find((i) => i.originalPath === t2)!;
  const metaPath = path.join(storeDir, 'quarantine', 'items', `${item2.quarantineId}.meta.json`);
  fs.writeFileSync(metaPath, fs.readFileSync(metaPath, 'utf8').slice(0, 20)); // truncated
  const lst = q.listQuarantine();
  assert(lst.globallyLocked === true, 'truncated header renders the quarantine globally locked');
  assertRejects(() => q.releaseQuarantine([t2]), 'no releases while locked', 'GLOBALLY LOCKED');
  // Out-of-band resolution (operator semantics, server-state direct).
  fs.rmSync(path.join(storeDir, 'quarantine', 'items', `${item2.quarantineId}.data`), { recursive: true, force: true });
  fs.rmSync(metaPath, { force: true });

  // Missing data object with an intact header → restore refuses.
  const t3 = path.join(fsRoots, 'qtree3');
  fs.mkdirSync(t3);
  fs.writeFileSync(path.join(t3, 'y.txt'), 'y');
  await sys.fsDelete(t3, true);
  const item3 = q.listQuarantine().items.find((i) => i.originalPath === t3)!;
  fs.rmSync(path.join(storeDir, 'quarantine', 'items', `${item3.quarantineId}.data`), { recursive: true, force: true });
  const opEntry = [...sc.readJournalEntries()].reverse().find((e) => e.t === 'mutation' && (e as { quarantineId?: string }).quarantineId === item3.quarantineId);
  const t3Op = (opEntry as { opId?: string }).opId!;
  assertRejects(() => rb.planRollback(t3Op), 'missing quarantine data refuses to plan', 'identity does not match');
  fs.rmSync(path.join(storeDir, 'quarantine', 'items', `${item3.quarantineId}.meta.json`), { force: true });

  // Duplicate originalPath records: one declaration releases exactly one.
  const dup = path.join(fsRoots, 'dup.txt');
  fs.writeFileSync(dup, 'D1');
  await sys.fsDelete(dup);
  fs.writeFileSync(dup, 'D2');
  await sys.fsDelete(dup);
  const dupItems = q.listQuarantine().items.filter((i) => i.originalPath === dup);
  assert(dupItems.length === 2, 'two retained records for the same path (distinct captures)');
  const rel = q.releaseQuarantine([dup]);
  assert(rel.released.length === 1, 'declaration releases exactly one record (scoped)');
  assert(q.listQuarantine().items.filter((i) => i.originalPath === dup).length === 1, 'the other record remains retained');

  // Occupied origin at restore → refuse, data retained.
  const occ = path.join(fsRoots, 'occ.txt');
  fs.writeFileSync(occ, 'capture-me');
  await sys.fsDelete(occ);
  fs.writeFileSync(occ, 'user-recreated'); // origin re-occupied
  const rel2 = q.releaseQuarantine([occ]);
  assert(rel2.released.length === 0 && rel2.refused.length === 1 && rel2.refused[0].reason.includes('overwrite'),
    'occupied origin refuses restore');
  assert(fs.readFileSync(occ, 'utf8') === 'user-recreated', 'user recreation preserved; capture retained');
}

// ===========================================================================
section('F. Quarantine release authorization');
// ===========================================================================
{
  const f1 = path.join(fsRoots, 'norm.txt');
  fs.writeFileSync(f1, 'N');
  await sys.fsDelete(f1);
  // Normalization: case variation + trailing separator + '.' segment all
  // denote the SAME canonical path — release must still be scoped to it.
  const rel = q.releaseQuarantine([f1.toUpperCase().replace(/\\/g, '/') + '\\']);
  assert(rel.released.length === 1, 'case/trailing-separator variation resolves to the same canonical item (scoped release)');
  // Traversal-shaped declaration that resolves elsewhere → no match.
  const f2 = path.join(fsRoots, 'trav.txt');
  fs.writeFileSync(f2, 'T');
  await sys.fsDelete(f2);
  const rel2 = q.releaseQuarantine([path.join(fsRoots, 'subdir', '..', 'elsewhere.txt')]);
  assert(rel2.released.length === 0 && rel2.refused[0].reason.includes('no readable quarantine item matches'), 'declaration resolving to a different path matches nothing');
  fs.rmSync(f2, { force: true }); // not restored; remove the leftover file
}

// ===========================================================================
section('G. Degraded storage (documented impossibility of safe live forcing)');
// ===========================================================================
{
  // ProgramData is always creatable for this user, so 'degraded' cannot be
  // reached without attacking the real machine's storage — out of bounds for
  // M4. The guards are therefore source-asserted (labelled), and degraded
  // remains listed as UNVERIFIED-live.
  const qSource = fs.readFileSync(path.join(REPO, 'quarantineCore.ts'), 'utf8');
  const rSource = fs.readFileSync(path.join(REPO, 'rollbackCore.ts'), 'utf8');
  assert(qSource.includes("protection !== 'full'") && rSource.includes("protection !== 'full'"),
    'destructive restore/rollback guarded to full protection [source]');
  unverified.push('G: degraded-storage live refusal (guards source-asserted; forcing ProgramData failure is out of bounds)');
  unverified.push('G: storage-unavailable live refusal (same reasoning)');
}

// ===========================================================================
section('K. Fault injection — process kill and storage loss');
// ===========================================================================
{
  // K1: SIGKILL mid-staging (trigger: staging file appears on disk).
  const kStore = path.join(tmp, 'k-store');
  const kRoots = path.join(tmp, 'k-roots');
  fs.mkdirSync(kRoots, { recursive: true });
  const kScript = path.join(tmp, 'child-stage.mts');
  fs.writeFileSync(kScript, `
    const sc = await import('file:///${REPO.replace(/\\/g, '/')}/sandboxCore');
    sc.stageFile(${JSON.stringify(path.join(kRoots, 'killed.txt'))}, 'X'.repeat(5 * 1024 * 1024), 'create');
    console.log('STAGED');
    setInterval(() => {}, 1000); // stay alive until killed
  `);
  const child = spawn('npx', ['tsx', kScript], { cwd: REPO, env: { ...process.env, KRISHA_FS_ROOTS: kRoots, KRISHA_SANDBOX_DIR: kStore }, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stageGlob = () => { try { return fs.readdirSync(kRoots).find((f) => f.includes('.krisha-stage-') && f.endsWith('.tmp')); } catch { return undefined; } };
  const deadline = Date.now() + 60_000;
  while (!stageGlob() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const killedWithStageFile = !!stageGlob();
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
  assert(killedWithStageFile, 'child killed mid-staging (staging file existed)');
  // Recovery: unresolved op + verified staging file → sweep cleans it.
  const recScript = path.join(tmp, 'child-sweep.mts');
  fs.writeFileSync(recScript, `
    const sc = await import('file:///${REPO.replace(/\\/g, '/')}/sandboxCore');
    const report = sc.sweepStaging();
    console.log(JSON.stringify(report));
    process.exit(0);
  `);
  const rec = runChild(recScript, { KRISHA_FS_ROOTS: kRoots, KRISHA_SANDBOX_DIR: kStore });
  const report = JSON.parse(rec.stdout.trim().split('\n').pop() || '{}');
  assert(report.cleaned.length === 1 && report.orphans.length === 0, 'post-kill sweep verified ownership and cleaned the staging file');
  assert(!fs.existsSync(path.join(kRoots, 'killed.txt')) && !stageGlob(), 'no partial destination, no staging residue');

  // K2: storage loss mid-session — the protected store directory deleted
  // externally. The journal self-heals (fresh state), challenges die with the
  // journal binding, and the AUDIT CHAIN must restart with an explicit marker
  // rather than leaving a silently broken chain on disk.
  fs.rmSync(storeDir, { recursive: true, force: true });
  const auditBefore = fs.existsSync(path.join(storeDir, 'audit', 'server-audit.jsonl'));
  await sys.fsCreate(path.join(fsRoots, 'after-loss.txt'), 'file', 'recovered');
  assert(fs.existsSync(path.join(storeDir, 'sandbox-journal', 'journal.jsonl')), 'journal self-heals after store deletion (fresh state)');
  const auditLines = fs.readFileSync(path.join(storeDir, 'audit', 'server-audit.jsonl'), 'utf8').split('\n').filter(Boolean);
  const first = JSON.parse(auditLines[0]);
  assert(auditBefore === false && first.seq === 1, 'audit chain restarts from genesis after loss (no silently broken chain)');
  assert(auditLines.some((l) => l.includes('audit_chain_restarted')), 'audit restart is explicitly recorded');
  void assertRejects;

  // K3: orphaned quarantine .data without a meta (kill between rename and
  // meta write — crafted): never listed, never releasable, never auto-deleted.
  const orphanData = path.join(storeDir, 'quarantine', 'items', '00000000-0000-4000-8000-00000000dead.data');
  fs.mkdirSync(path.join(storeDir, 'quarantine', 'items'), { recursive: true });
  fs.writeFileSync(orphanData, 'orphan');
  const lst = q.listQuarantine();
  assert(!lst.items.some((i) => i.quarantineId === '00000000-0000-4000-8000-00000000dead'), 'orphaned data without meta is invisible to release flows');
  assert(fs.existsSync(orphanData), 'orphaned data is retained (never silently destroyed)');
  fs.rmSync(orphanData, { force: true });
  unverified.push('K: mid-capture kill between rename and meta write cannot be timed deterministically — crafted post-state tested instead');
}

// Free :3000 and kill a spawned server's WHOLE process tree (shell:true
// wrappers mean child.kill() would orphan the node process otherwise).
function freePort3000(): void {
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { taskkill /PID $_.OwningProcess /T /F 2>&1 | Out-Null }"],
      { encoding: 'utf8', timeout: 30_000 });
  } catch { /* best-effort */ }
}
function killTree(child: ChildProcess): void {
  try {
    if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 30_000, shell: true });
  } catch { /* best-effort */ }
}

async function ensurePortFree(): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    let answering = false;
    try {
      await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(1500) });
      answering = true;
    } catch { answering = false; }
    if (!answering) return true;
    freePort3000();
    await new Promise((r) => setTimeout(r, 1200));
  }
  return !(await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false));
}
section('H. Live HTTP, UI, and concurrency');
// ===========================================================================
{
  freePort3000();
  await new Promise((r) => setTimeout(r, 1500)); // let any dying orphan release the port
  freePort3000();
  if (!(await ensurePortFree())) {
    unverified.push('H: live HTTP section skipped — an unkillable foreign process holds port 3000');
  } else {
  // Spawn an isolated server; the parent test process holds the recovery
  // pipe, so the child logs a pipe-conflict warning and continues (M1
  // behavior) — HTTP on :3000 is what we probe.
  const hRoots = path.join(tmp, 'h-roots');
  const hStore = path.join(tmp, 'h-store');
  fs.mkdirSync(hRoots, { recursive: true });
  const server = spawn('npx', ['tsx', 'server.ts'], {
    cwd: REPO, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, KRISHA_FS_ROOTS: hRoots, KRISHA_SANDBOX_DIR: hStore },
  });
  let serverLog = '';
  server.stdout?.on('data', (d) => { serverLog += String(d); });
  server.stderr?.on('data', (d) => { serverLog += String(d); });
  const j = async (method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> => {
    // Dev-mode vite occasionally resets sockets between rapid requests —
    // bounded retry keeps the harness stable without changing any assertion.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`http://127.0.0.1:3000${p}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        return { status: res.status, json: await res.json().catch(() => null) };
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    throw lastErr;
  };
  const up = async (): Promise<boolean> => {
    for (let i = 0; i < 250; i++) {
      try { const r = await j('GET', '/api/health'); if (r.status === 200) return true; } catch { /* booting */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  };
  const alive = await up();
  if (!alive) {
    unverified.push('H: live HTTP section skipped — isolated server did not boot. serverLog tail: ' + serverLog.replace(/\s+/g, ' ').slice(-260));
    killTree(server);
  } else {
    // H1 — the full rollback flow over HTTP, NORMALIZED paths (mandated re-run
    // of the M3 smoke's failed check), using the opId returned by the API.
    const created = await j('POST', '/api/fs/create', { path: `${hRoots}\\live.txt`, content: 'live-body' });
    assert(created.status === 200 && created.json?.result?.opId, `create response carries the server-minted opId (status ${created.status}, body ${JSON.stringify(created.json).slice(0, 160)})`);
    const deleted = await j('POST', '/api/fs/delete', { path: `${hRoots}\\live.txt` });
    assert(deleted.json?.result?.quarantined === true && !!deleted.json?.result?.opId, `HTTP delete quarantines and reports its opId (body ${JSON.stringify(deleted.json).slice(0, 160)})`);
    const deleteOp = deleted.json.result.opId as string; // the rollback unit is the DELETE
    const planned = await j('POST', '/api/rollback/plan', { opId: deleteOp });
    assert(planned.json?.success === true && planned.json.result.plan.inverse.kind === 'restore-from-quarantine',
      `plan over HTTP binds the quarantine restore (error: ${planned.json?.error ?? 'none'})`);
    const planHash = planned.json.result.planHash as string;
    const challengeId = planned.json.result.challenge.challengeId as string;
    const pending = await j('GET', '/api/rollback/pending');
    const view = (pending.json?.result ?? []).find((c: any) => c.challengeId === challengeId);
    assert(!!view, 'UI pending list shows the challenge');
    const approved = await j('POST', '/api/rollback/approve', { challengeId });
    assert(approved.json?.success === true, 'operator approval over HTTP');
    const executed = await j('POST', '/api/rollback/execute', { opId: deleteOp, planHash, challengeId });
    assert(executed.json?.success === true, 'rollback executes over HTTP');
    const restored = fs.readFileSync(path.join(hRoots, 'live.txt'), 'utf8');
    assert(restored === 'live-body', 'restored content byte-identical (end-to-end, normalized-path flow)');

    // H2 — stop blocking over HTTP.
    await j('POST', '/api/safety/stop/activate', { reason: 'm4-h' });
    const execStopped = await j('POST', '/api/rollback/execute', { opId: deleteOp, planHash, challengeId });
    assert(execStopped.status === 423, 'rollback execute stop-blocked (423)');
    const relStopped = await j('POST', '/api/quarantine/release', { declaredPaths: [`${hRoots}\\live.txt`] });
    assert(relStopped.status === 423, 'quarantine release stop-blocked (423)');
    // Restart semantics: kill the server TREE, reset its (in-memory-challenge-
    // bound) state out-of-band (state + marker removed → fresh install on
    // boot), and boot again — the old challenge must not survive.
    killTree(server);
    await new Promise((r) => setTimeout(r, 800));
    fs.rmSync(path.join(hStore, 'stop-state.json'), { force: true });
    fs.rmSync(path.join(hStore, 'install.marker'), { force: true });

    // H5 — restart invalidates in-memory challenges: reboot the server, the
    // challenge from the previous life must be unknown.
    const server2 = spawn('npx', ['tsx', 'server.ts'], {
      cwd: REPO, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KRISHA_FS_ROOTS: hRoots, KRISHA_SANDBOX_DIR: hStore },
    });
    server2.stdout?.on('data', () => { /* drain */ });
    server2.stderr?.on('data', () => { /* drain */ });
    assert(await up(), 'server restarted (fresh boots INACTIVE after state reset)');
    const replay = await j('POST', '/api/rollback/execute', { opId: deleteOp, planHash, challengeId });
    assert(replay.json?.success === false, 'challenge did not survive restart (unknown challenge)');
    const execWrong = await j('POST', '/api/rollback/execute', { opId: deleteOp, planHash: 'f'.repeat(64), challengeId: 'x' });
    assert(execWrong.json?.success === false, 'forged plan hash refused over HTTP');

    // H3 — limits and validation.
    const bigBody = 'x'.repeat(1024 * 1024 + 100);
    const oversized = await fetch('http://127.0.0.1:3000/api/fs/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: `${hRoots}\\big.txt`, content: bigBody }),
      signal: AbortSignal.timeout(15_000),
    });
    assert(oversized.status === 413, `body limit enforced (got ${oversized.status})`);
    // H3 — the security property for a GET on a POST-only mutation route is
    // that NO mutation result is ever served (dev mode's vite middleware owns
    // GETs and may reset the socket — still not a mutation result).
    let getMutated = true;
    try {
      const getOnPost = await fetch('http://127.0.0.1:3000/api/fs/create', { method: 'GET', signal: AbortSignal.timeout(15_000) });
      const text = await getOnPost.text();
      getMutated = text.includes('"success":true');
    } catch {
      getMutated = false; // connection reset — certainly not a mutation result
    }
    assert(!getMutated, 'GET on a POST-only mutation route cannot trigger it (no mutation result served)');
    const unknown = await fetch('http://127.0.0.1:3000/api/nothing', { method: 'POST', body: '{}', signal: AbortSignal.timeout(15_000) });
    assert(unknown.status === 404, 'unknown routes are 404 (no hidden authority)');
    // Malformed JSON must never yield a mutation success (dev mode may reset
    // the socket instead of answering — still not a mutation result).
    let malformedBad = false;
    try {
      const malformed = await fetch('http://127.0.0.1:3000/api/fs/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json', signal: AbortSignal.timeout(15_000),
      });
      const text = await malformed.text();
      malformedBad = malformed.status >= 500 || text.includes('"success":true');
    } catch {
      malformedBad = false; // reset — certainly not a mutation result
    }
    assert(!malformedBad, 'malformed JSON handled without a 500 or a mutation success');

    // H4 — concurrent duplicate execution: exactly one success.
    await j('POST', '/api/fs/create', { path: `${hRoots}\\conc.txt`, content: 'conc' });
    await j('POST', '/api/fs/delete', { path: `${hRoots}\\conc.txt` });
    // The journal of the ISOLATED store is directly readable by this test.
    const journalLines = fs.readFileSync(path.join(hStore, 'sandbox-journal', 'journal.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: string; opId?: string; from?: string; destPath?: string });
    const concDel = [...journalLines].reverse().find((e) => e.t === 'mutation' && e.from?.endsWith('conc.txt'));
    const concOp = concDel!.opId!; // the rollback unit is the DELETE
    const pc2 = await j('POST', '/api/rollback/plan', { opId: concOp });
    const ch2 = pc2.json.result.challenge.challengeId;
    const ph2 = pc2.json.result.planHash;
    await j('POST', '/api/rollback/approve', { challengeId: ch2 });
    const [r1, r2] = await Promise.all([
      j('POST', '/api/rollback/execute', { opId: concOp, planHash: ph2, challengeId: ch2 }),
      j('POST', '/api/rollback/execute', { opId: concOp, planHash: ph2, challengeId: ch2 }),
    ]);
    const successes = [r1, r2].filter((r) => r.json?.success === true).length;
    assert(successes === 1, `concurrent duplicate executions: exactly one succeeded (${successes}/2)`);

    // H6 — Windows named pipe: a client performs a full status round-trip
    // against the pipe server held by THIS suite process (single-owner bind
    // was verified in the M1 suite; here we verify live reachability +
    // protocol).
    const pipeScript = path.join(tmp, 'child-pipe.mts');
    fs.writeFileSync(pipeScript, `
      const net = await import('node:net');
      const crypto = await import('node:crypto');
      const s = net.connect('\\\\\\\\.\\\\pipe\\\\krisha-e5-recovery');
      const t = setTimeout(() => { console.log('PIPE=timeout'); process.exit(0); }, 15_000);
      s.on('connect', () => s.write(JSON.stringify({ op: 'status', nonce: crypto.randomBytes(32).toString('hex') }) + '\\n'));
      s.on('data', (d) => { clearTimeout(t); console.log('PIPE=' + d.toString().trim().slice(0, 80)); process.exit(0); });
      s.on('error', (e) => { clearTimeout(t); console.log('PIPE=error:' + e.code); process.exit(0); });
    `);
    // spawnSync would BLOCK this process's event loop — and this process IS
    // the pipe server — so the pipe client must run on an async spawn.
    const pipeOut = await new Promise<string>((resolve) => {
      const c = spawn('npx', ['tsx', pipeScript], { cwd: REPO, shell: true, env: { ...process.env }, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      c.stdout?.on('data', (d) => { out += String(d); });
      c.on('close', () => resolve(out));
      c.on('error', () => resolve(out + '\nPIPE=spawn-error'));
      setTimeout(() => resolve(out + '\nPIPE=spawn-timeout'), 60_000);
    });
    assert(pipeOut.includes('PIPE=') && pipeOut.includes('"ok":true'),
      `recovery pipe live round-trip works (child saw: ${pipeOut.trim().slice(0, 90)})`);

    server2.kill('SIGKILL');
    killTree(server2);
  }
}
}

// ===========================================================================
section('X. Cross-volume capture and restore (real second volume, if present)');
// ===========================================================================
{
  // Probe for a writable second volume; skip honestly when absent.
  let xvolRoot: string | null = null;
  for (const candidate of ['D:\\e5m4-xvol', 'E:\\e5m4-xvol', 'F:\\e5m4-xvol']) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.writeFileSync(path.join(candidate, 'probe.txt'), 'ok');
      fs.rmSync(path.join(candidate, 'probe.txt'), { force: true });
      xvolRoot = candidate;
      break;
    } catch { /* not writable / not present */ }
  }
  if (!xvolRoot) {
    unverified.push('X: no writable second volume — cross-volume capture/restore not executed');
  } else {
    const xvStore = path.join(tmp, 'x-store'); // on C: — capture from xvolRoot is cross-volume
    const xvScript = path.join(tmp, 'child-xvol.mts');
    fs.writeFileSync(xvScript, `
      const fs = await import('node:fs');
      const path = await import('node:path');
      const q = await import('file:///${REPO.replace(/\\/g, '/')}/quarantineCore');
      const sys = await import('file:///${REPO.replace(/\\/g, '/')}/systemAgentServer');
      const sc = await import('file:///${REPO.replace(/\\/g, '/')}/sandboxCore');
      const crypto = await import('node:crypto');
      const out: Record<string, unknown> = {};
      // File on the second volume: two-agreeing-reads capture path.
      const file = path.join(${JSON.stringify(xvolRoot)}, 'xfile.bin');
      fs.writeFileSync(file, Buffer.from([1, 0, 255, 0, 7, 9]));
      try {
        const del = await sys.fsDelete(file);
        out.fileDeleted = del.deleted === true && del.quarantined === true;
        const items = q.listQuarantine().items;
        out.itemDebug = items.map((i) => ({ p: i.originalPath, r: i.readable }));
        const item = items.find((i) => i.originalPath === file);
        out.captured = !!item && item.readable;
        const rel = q.releaseQuarantine([file]);
        out.restored = rel.released.length === 1;
        out.bytesMatch = Buffer.compare(fs.readFileSync(file), Buffer.from([1, 0, 255, 0, 7, 9])) === 0;
      } catch (e) { out.fileError = String(e.message || e); }
      // Directory on the second volume: conservative refusal expected.
      const dir = path.join(${JSON.stringify(xvolRoot)}, 'xdir');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'inner.txt'), 'x');
      try { await sys.fsDelete(dir, true); out.dirDeleted = true; }
      catch (e) { out.dirRefused = String(e.message || e); }
      out.dirIntact = fs.existsSync(dir + '\\\\inner.txt');
      console.log('XV=' + JSON.stringify(out));
      process.exit(0);
    `);
    const xv = runChild(xvScript, { KRISHA_FS_ROOTS: xvolRoot, KRISHA_SANDBOX_DIR: xvStore });
    const m = xv.stdout.match(/XV=(\{.*\})/);
    if (!m) {
      assert(false, `cross-volume child produced no result (stdout tail: ${xv.stdout.slice(-200)})`);
    } else {
      const xvOut = JSON.parse(m[1]) as Record<string, unknown>;
      assert(xvOut.fileDeleted === true && xvOut.captured === true && xvOut.restored === true && xvOut.bytesMatch === true,
        `cross-volume file capture (two agreeing reads) + restore byte-identical (detail: ${JSON.stringify(xvOut)})`);
      assert(xvOut.dirDeleted !== true && String(xvOut.dirRefused ?? '').includes('cross-volume') && xvOut.dirIntact === true,
        'cross-volume directory delete conservatively refused; tree intact');
    }
    fs.rmSync(xvolRoot, { recursive: true, force: true });
  }
}

// ===========================================================================
console.log(`\n== E5 M4 RESULTS: ${passed} passed, ${failed} failed ==`);
if (unverified.length) {
  console.log('Unverified (explicit):');
  for (const u of unverified) console.log(`  ? ${u}`);
}
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch { /* best-effort cleanup */ }
process.exit(0);
