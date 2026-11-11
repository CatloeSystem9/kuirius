/**
 * E5 M2 — Sandbox Core test suite.
 *
 * Covers: path traversal, symlink/junction escapes, hard links, ADS,
 * parent-directory replacement, file identity changes, staging creation/
 * cleanup/unknown/interrupted cases, in-process permission + emergency-stop
 * enforcement, existing filesystem regressions, E1/E4 contract preservation,
 * and journal boundedness. Mirrors the M1 suite conventions.
 *
 * Executed evidence only: every assertion below was run to completion.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e5-m2-'));
const fsRoots = path.join(tmp, 'fsroots');
const storeDir = path.join(tmp, 'e5store'); // OUTSIDE the model roots
fs.mkdirSync(fsRoots, { recursive: true });

// Environment MUST be set before the first import of serverSafety (its init
// runs at module load).
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
function assertThrows(fn: () => unknown, label: string, needle?: string): string {
  try {
    fn();
    assert(false, `${label} [no error thrown]`);
    return '';
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    assert(!needle || msg.includes(needle), `${label} — got: ${msg}`);
    return msg;
  }
}
async function assertRejects(fn: () => Promise<unknown>, label: string, needle?: string): Promise<string> {
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

const { resolveSafePath, assertNotProtected, getStorageInfo, stopKind, armStop, recoverStop, activateStop, serverPermissions, stopSnapshot } = await import('../serverSafety');
const sc = await import('../sandboxCore');
const sys = await import('../systemAgentServer');

assert(path.resolve(getStorageInfo().root ?? '').toLowerCase().startsWith(storeDir.toLowerCase()), 'store resolved to the isolated KRISHA_SANDBOX_DIR');
assert(stopKind() === 'INACTIVE', 'boots INACTIVE');

const journalFile = path.join(storeDir, 'sandbox-journal', 'journal.jsonl');

// ===========================================================================
section('A. Traversal, ADS, and protected-storage refusals through sandbox ops');
// ===========================================================================
{
  assertThrows(() => sc.sandboxCreateFile(path.join(fsRoots, '..', 'escape.txt'), 'x'), 'traversal above root refused', 'outside the allowed filesystem roots');
  // Both refusals below are correct outcomes (containment fires first for
  // out-of-root paths; the denylist is the second layer for in-root paths).
  assertThrows(() => sc.sandboxCreateFile('C:\\Windows\\System32\\krisha-escape.txt', 'x'), 'system denylist path refused');
  assertThrows(() => sc.sandboxCreateFile(path.join(fsRoots, 'note.txt:ads'), 'x'), 'ADS spelling refused through sandbox create', 'Alternate data stream');
  // Direct store paths sit OUTSIDE the model roots → containment refuses
  // before the protected-storage layer (defense in depth either way).
  const storeProbe = path.join(storeDir, 'stop-state.json');
  assertThrows(() => sc.sandboxCreateFile(storeProbe, 'x'), 'sandbox create into protected store refused');
  assertThrows(() => sc.sandboxDelete(storeDir), 'sandbox delete of protected store refused');
  assertThrows(() => sc.sandboxRename(storeProbe, 'x.txt'), 'sandbox rename of protected state refused');
  // A junction INSIDE a model root that resolves INTO the store must be
  // refused by the protected-storage layer specifically (realpath-hardened).
  try {
    fs.symlinkSync(storeDir, path.join(fsRoots, 'store-junction'), 'junction');
    assertThrows(() => sc.sandboxCreateFile(path.join(fsRoots, 'store-junction', 'x.txt'), 'x'), 'sandbox create through store junction refused (protected layer)', 'E5 protected storage');
    await assertRejects(() => sys.fsReadFile(path.join(fsRoots, 'store-junction', 'stop-state.json'), 0), 'read through store junction refused', 'E5 protected storage');
  } catch (err) {
    assert(false, `store-junction setup failed (privileges?): ${String((err as Error)?.message || err)}`);
  }
  assert(resolveSafePath(path.join(fsRoots, 'ok.txt'), 'write').startsWith(fsRoots), 'normal in-root resolution preserved');
}

// ===========================================================================
section('B. Symlink / junction / hard-link handling');
// ===========================================================================
{
  const outside = path.join(tmp, 'outside-target.txt');
  fs.writeFileSync(outside, 'secret');
  try {
    fs.symlinkSync(outside, path.join(fsRoots, 'junction-escape'), 'junction');
    assertThrows(() => sc.sandboxRename(path.join(fsRoots, 'junction-escape'), 'moved.txt'), 'junction source refused for rename', 'symlink or junction');
    assertThrows(() => sc.sandboxDelete(path.join(fsRoots, 'junction-escape')), 'junction refused for delete', 'symlink or junction');
    assertThrows(() => sc.sandboxCopy(path.join(fsRoots, 'junction-escape'), path.join(fsRoots, 'copy-of-junction.txt')), 'junction refused for copy', 'symlink or junction');
  } catch (err) {
    assert(false, `junction setup failed (privileges?): ${String((err as Error)?.message || err)}`);
  }
  // Hard link ALIAS of protected storage must stay refused (M1 inode defense
  // preserved under the M2 core) — asynchronous refusal.
  try {
    const marker = path.join(storeDir, 'install.marker');
    fs.linkSync(marker, path.join(fsRoots, 'marker-alias.txt'));
    await assertRejects(() => sys.fsReadFile(path.join(fsRoots, 'marker-alias.txt'), 0), 'hard-link alias of protected storage refused', 'hard-link alias');
    await assertRejects(() => sys.fsDelete(path.join(fsRoots, 'marker-alias.txt')), 'hard-link alias delete refused', 'hard-link alias');
  } catch (err) {
    assert(false, `hard-link setup failed: ${String((err as Error)?.message || err)}`);
  }
  // Hard link of a NORMAL model-root file is a legal alias: mutation through
  // one name is the same node — the core neither hides nor denies this.
  const base = path.join(fsRoots, 'hl-base.txt');
  fs.writeFileSync(base, 'A');
  fs.linkSync(base, path.join(fsRoots, 'hl-alias.txt'));
  assertThrows(() => sc.sandboxCreateFile(path.join(fsRoots, 'hl-alias.txt'), 'x'), 'create refuses existing hard-link alias (no overwrite)', 'already exists');
}

// ===========================================================================
section('C. Staging lifecycle — creation, commit, verified abort (E4 #1-#4)');
// ===========================================================================
{
  const dest = path.join(fsRoots, 'staged-a.txt');
  const sw = sc.stageFile(dest, 'alpha-content');
  assert(STAGE_SUFFIX(sw.stagePath), `staging file uses the reserved pattern (${path.basename(sw.stagePath)})`);
  assert(fs.existsSync(sw.stagePath), 'staging file created O_EXCL');
  const journal = fs.readFileSync(journalFile, 'utf8');
  const firstStageIdx = journal.indexOf('staging_started');
  const readyIdx = journal.indexOf('staging_ready');
  assert(firstStageIdx >= 0 && readyIdx > firstStageIdx, 'journal records staging_started BEFORE staging_ready (E4 #1/#3)');

  const entry = sc.commitStaged(sw);
  assert(entry.kind === 'file' && entry.size === 'alpha-content'.length, 'commit places verified content at destination');
  assert(fs.existsSync(dest) && !fs.existsSync(sw.stagePath), 'staging file consumed by commit');

  const dest2 = path.join(fsRoots, 'staged-b.txt');
  const sw2 = sc.stageFile(dest2, 'beta-content');
  const aborted = sc.abortStaged(sw2);
  assert(aborted.deleted === true, 'verified abort deletes its own staging file (E4 #4)');
  assert(!fs.existsSync(sw2.stagePath) && !fs.existsSync(dest2), 'aborted staging leaves no artifacts');
}
function STAGE_SUFFIX(p: string): boolean {
  return /\.krisha-stage-[0-9a-f-]{36}\.tmp$/.test(p);
}

// ===========================================================================
section('D. Identity changes and parent replacement (E4 #6 — unsafe conditions)');
// ===========================================================================
{
  // Identity change: staging file modified after staging_ready.
  const dest = path.join(fsRoots, 'staged-c.txt');
  const sw = sc.stageFile(dest, 'original');
  fs.appendFileSync(sw.stagePath, '-tampered'); // size + mtime change
  const abortResult = sc.abortStaged(sw);
  assert(abortResult.deleted === false && (abortResult.reason ?? '').includes('identity changed'), 'tampered staging file NOT deleted (E4 #6/#7)');
  assert(fs.existsSync(sw.stagePath), 'tampered staging file left in place for inspection');
  const commitThrow = assertThrows(() => sc.commitStaged(sw), 'commit of tampered staging refused', 'unsafe condition');
  assert(commitThrow.includes('identity changed'), 'commit refusal names the identity change');
  fs.unlinkSync(sw.stagePath); // test cleanup of the orphan we deliberately created

  // Parent replacement: parent directory swapped after staging while the
  // staging file itself keeps its inode (moved out and back).
  const parentDir = path.join(fsRoots, 'swap-parent');
  fs.mkdirSync(parentDir);
  const dest2 = path.join(parentDir, 'staged-d.txt');
  const sw2 = sc.stageFile(dest2, 'gamma');
  const stageHold = path.join(tmp, 'stage-hold.tmp');
  fs.renameSync(sw2.stagePath, stageHold);           // preserve staging inode
  fs.rmSync(parentDir, { recursive: true });         // destroy the parent node
  fs.mkdirSync(parentDir);                           // DIFFERENT directory inode, same path
  fs.renameSync(stageHold, sw2.stagePath);           // staging file back, identity intact
  assertThrows(() => sc.commitStaged(sw2), 'commit after parent replacement refused', 'parent directory changed');
  // The refused commit CLOSES the op as an orphan (conservative E4: the
  // condition is recorded, the file is left for inspection — cleanup never
  // deletes after an unresolved safety condition).
  const sweepAfterParentSwap = sc.sweepStaging();
  assert(!sweepAfterParentSwap.cleaned.includes(sw2.stagePath), 'orphan-closed staging is not sweep-deleted');
  assert(fs.existsSync(sw2.stagePath), 'post-swap staging file preserved for inspection');
  fs.rmSync(sw2.stagePath, { force: true }); // test cleanup of the deliberate orphan
}

// ===========================================================================
section('E. Unknown and interrupted staging (E4 #5/#7 + crash recovery)');
// ===========================================================================
{
  // Unknown staging-pattern file with NO journal record: never ours to delete.
  const unknown = path.join(fsRoots, '.krisha-stage-00000000-0000-4000-8000-000000000000.tmp');
  fs.writeFileSync(unknown, 'not-ours');
  const report1 = sc.sweepStaging();
  assert(fs.existsSync(unknown), 'sweep never deletes staging files absent from the journal (E4 #7)');
  assert(report1.orphans.every((o) => o.stagePath !== unknown), 'unknown file is not reported as a journal orphan (it has no record at all)');

  // Forged abort against an unknown opId: refused, file untouched.
  const forged = sc.abortStaged({ opId: '00000000-0000-4000-8000-000000000000', stagePath: unknown, destPath: path.join(fsRoots, 'nope.txt') });
  assert(forged.deleted === false, 'abort without a ready record refuses to delete (ownership unverifiable)');
  assert(fs.existsSync(unknown), 'unknown file survives a forged abort');

  // Interrupted staging: staged but never committed → sweep cleans (verified).
  const dest = path.join(fsRoots, 'staged-interrupted.txt');
  const sw = sc.stageFile(dest, 'interrupted');
  const report2 = sc.sweepStaging();
  assert(report2.cleaned.includes(sw.stagePath), 'sweep deletes VERIFIED uncommitted staging (interrupted operation)');
  assert(!fs.existsSync(sw.stagePath) && !fs.existsSync(dest), 'interrupted staging leaves no staging or destination file');

  // Staging file lost before sweep → recorded missing, nothing deleted.
  const dest2 = path.join(fsRoots, 'staged-lost.txt');
  const sw2 = sc.stageFile(dest2, 'lost');
  fs.unlinkSync(sw2.stagePath);
  const report3 = sc.sweepStaging();
  assert(report3.missing.includes(sw2.stagePath), 'missing staging file recorded (unsafe condition surfaced, nothing forced)');

  fs.unlinkSync(unknown); // test cleanup
}

// ===========================================================================
section('F. In-process permission and emergency-stop enforcement');
// ===========================================================================
{
  // Permission: baseline write is seeded (operator decision) — use a
  // capability that is default-deny to prove the gate fires.
  assertThrows(() => sc.assertSandboxMutation('terminal.execution', 'create', path.join(fsRoots, 'x.txt')), 'default-deny capability refused by the sandbox gate', 'permission_denied');
  serverPermissions.grantScoped({ permission: 'terminal.execution', scope: { kind: 'once' }, reason: 'm2-test' });
  const first = serverPermissions.checkScoped('terminal.execution').status;
  const second = serverPermissions.checkScoped('terminal.execution').status;
  assert(first === 'granted' && second === 'denied', 'scoped once grant resolves through the sandbox gate exactly once');

  // Emergency stop: mutations refused while ACTIVE, allowed again after
  // credential recovery (M1 state machine intact under the M2 gate).
  armStop('M2SandboxCheck#1', 'test');
  assert(stopSnapshot().kind === 'ACTIVE_CREDENTIALED', 'stop armed for the gate test');
  assertThrows(() => sc.sandboxCreateFile(path.join(fsRoots, 'during-stop.txt'), 'x'), 'sandbox create refused while stop ACTIVE', 'emergency stop is ACTIVE');
  assertRejects(() => sys.fsCreate(path.join(fsRoots, 'during-stop2.txt'), 'file', 'x'), 'HTTP-layer fsCreate refused while stop ACTIVE', 'emergency stop is ACTIVE');
  recoverStop('M2SandboxCheck#1', 'test');
  assert(stopKind() === 'INACTIVE', 'stop recovered');
  await sys.fsCreate(path.join(fsRoots, 'after-stop.txt'), 'file', 'ok');
  assert(fs.existsSync(path.join(fsRoots, 'after-stop.txt')), 'mutations work again after recovery');

  // UNCERTAIN: state file removed under a live marker → null state.
  const stateFile = path.join(storeDir, 'stop-state.json');
  const savedState = fs.readFileSync(stateFile, 'utf8');
  fs.unlinkSync(stateFile);
  const before = stopKind();
  assert(before === 'INACTIVE', 'in-memory state still INACTIVE until reboot (UNCERTAIN is a boot-time determination)');
  fs.writeFileSync(stateFile, savedState);
}

// ===========================================================================
section('G. Filesystem operation regressions through the core');
// ===========================================================================
{
  // create / read-back (identity-verified field) / inspect
  const f = path.join(fsRoots, 'reg-a.txt');
  const created = await sys.fsCreate(f, 'file', 'hello m2');
  assert(created.kind === 'file' && created.size === 8, 'create through sandbox core preserves FsEntry shape');
  const readBack = await sys.fsReadFile(f, 0);
  assert(readBack.content === 'hello m2', 'read-back content correct');
  assert(readBack.identityVerified === true, 'read reports identityVerified on a stable file');
  const inspect = await sys.fsInspect(f);
  assert(inspect.isText === true, 'inspect works through the core');

  // rename
  const renamed = await sys.fsRename(f, 'reg-a2.txt');
  assert(renamed.name === 'reg-a2.txt', 'rename works');
  await assertRejects(() => sys.fsRename(path.join(fsRoots, 'reg-a2.txt'), 'subdir/../escape.txt'), 'rename cannot traverse via new name', 'Invalid new name');

  // copy (two-read path) + copy into directory + overwrite
  const copy1 = await sys.fsCopy(path.join(fsRoots, 'reg-a2.txt'), path.join(fsRoots, 'reg-copy.txt'));
  assert(copy1.size === 8, 'file copy (two agreeing reads) succeeds');
  fs.mkdirSync(path.join(fsRoots, 'reg-dir'));
  await sys.fsCopy(path.join(fsRoots, 'reg-copy.txt'), path.join(fsRoots, 'reg-dir'));
  assert(fs.existsSync(path.join(fsRoots, 'reg-dir', 'reg-copy.txt')), 'copy into existing directory preserved');
  await sys.fsCopy(path.join(fsRoots, 'reg-a2.txt'), path.join(fsRoots, 'reg-dir', 'reg-copy.txt'), true);
  await assertRejects(() => sys.fsCopy(path.join(fsRoots, 'reg-a2.txt'), path.join(fsRoots, 'reg-dir', 'reg-copy.txt')), 'copy without overwrite refuses existing destination', 'set overwrite');

  // move + move into directory
  await sys.fsMove(path.join(fsRoots, 'reg-copy.txt'), path.join(fsRoots, 'reg-dir', 'moved.txt'));
  assert(fs.existsSync(path.join(fsRoots, 'reg-dir', 'moved.txt')), 'move into directory preserved');
  await sys.fsMove(path.join(fsRoots, 'reg-a2.txt'), path.join(fsRoots, 'reg-moved-root.txt'));
  assert(fs.existsSync(path.join(fsRoots, 'reg-moved-root.txt')), 'root-level move preserved');

  // delete semantics
  await assertRejects(() => sys.fsDelete(path.join(fsRoots, 'reg-dir')), 'non-recursive delete of non-empty dir refused', 'recursive deletion is required');
  const del = await sys.fsDelete(path.join(fsRoots, 'reg-dir'), true);
  assert(del.deleted === true, 'recursive delete works');
  const delSingle = await sys.fsDelete(path.join(fsRoots, 'reg-moved-root.txt'));
  assert(delSingle.deleted === true, 'single-file delete works');
  await assertRejects(() => sys.fsDelete(path.join(fsRoots, 'reg-moved-root.txt')), 'delete of already-deleted path refused', 'does not exist');
  assert(!fs.existsSync(path.join(fsRoots, 'reg-moved-root.txt')), 'deleted path is gone');

  // create-dir + no-overwrite
  await sys.fsCreate(path.join(fsRoots, 'reg-dir2'), 'dir');
  await assertRejects(() => sys.fsCreate(path.join(fsRoots, 'reg-dir2'), 'dir'), 'create-dir refuses existing', 'already exists');
  await assertRejects(() => sys.fsCreate(path.join(fsRoots, 'missing-parent', 'child.txt'), 'file', 'x'), 'create refuses missing parent', 'Parent directory');

  // listing/search still skip protected storage
  const listing = await sys.fsList(fsRoots);
  assert(listing.entries.every((e) => !e.path.startsWith(storeDir)), 'listing never exposes protected storage');
}

// ===========================================================================
section('H. E1 / E4 contract preservation (source-level + behavioral)');
// ===========================================================================
{
  const coreSource = fs.readFileSync(path.resolve(process.cwd(), 'sandboxCore.ts'), 'utf8');
  const E1 = 'Restored content is what Krisha verified via two agreeing full reads of the source; it may not correspond to any single historical version.';
  assert(coreSource.includes(E1), 'E1 wording preserved verbatim in the sandbox core');
  assert(sc.E1_CONTRACT === E1, 'E1 export equals the mandated contract text');
  assert(coreSource.includes("fs.openSync(stagePath, 'wx')"), 'staging creation uses O_EXCL (E4 #2)');
  const journal = fs.readFileSync(journalFile, 'utf8');
  assert(journal.includes('"staging_started"'), 'journal records staging_started (E4 #1)');
  assert(journal.includes('"staging_orphan"'), 'journal records unverifiable orphans instead of deleting them (E4 #7)');

  // E1 verification discipline applied to copy: the two-read success path
  // (content agreement) is exercised in section G. The inter-read
  // disagreement branch requires a concurrent external mutator inside a
  // synchronous window and is UNVERIFIED-dynamic (disclosed in the report).
  assert(coreSource.includes('read1.equals(read2)'), 'two-read agreement comparison present (E1 primitive)');
}

// ===========================================================================
section('I. Bounded journal + compaction preserves unresolved staging');
// ===========================================================================
{
  const sw = sc.stageFile(path.join(fsRoots, 'staged-compact.txt'), 'survives-compaction');
  const linesBefore = fs.readFileSync(journalFile, 'utf8').split('\n').filter(Boolean).length;
  for (let i = 0; i < 110; i++) {
    await sys.fsCreate(path.join(fsRoots, `churn-${i}.txt`), 'file', 'x');
    // Core-level delete WITHOUT the quarantine hook: compaction churn must
    // not fill the E7 retention cap (quarantine behavior is M3's suite).
    sc.sandboxDelete(path.join(fsRoots, `churn-${i}.txt`));
  }
  const linesAfter = fs.readFileSync(journalFile, 'utf8').split('\n').filter(Boolean).length;
  assert(linesAfter < 400 + 20, `journal stays bounded after churn (${linesBefore} → ${linesAfter} lines)`);
  const report = sc.sweepStaging();
  assert(report.cleaned.includes(sw.stagePath), 'unresolved staging survives compaction and is still verified-cleanable');
  assert(!fs.existsSync(sw.stagePath), 'compacted-journal sweep removed the verified staging file');
}

// ===========================================================================
console.log(`\n== E5 M2 RESULTS: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch { /* tmpdir cleanup is best-effort */ }
// serverSafety's recovery-pipe server holds the event loop open — exit
// explicitly on the success path.
process.exit(0);
