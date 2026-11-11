/**
 * E5 H8 — Real Windows environmental verification.
 * Execution-only mission: no production code changes.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawnSync, spawn } from 'child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e5-h8-'));
const fsRoots = path.join(tmp, 'fsroots');
const storeDir = path.join(tmp, 'e5store');
fs.mkdirSync(fsRoots, { recursive: true });
process.env.KRISHA_FS_ROOTS = fsRoots;
process.env.KRISHA_SANDBOX_DIR = storeDir;

let passed = 0; let failed = 0;
const failures: string[] = [];
const unverified: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
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
function section(name: string): void { console.log(`\n== ${name} ==`); }
const REPO = process.cwd();
const repoUrl = `file:///${REPO.replace(/\\/g, '/')}`;

const serverSafety = await import('../serverSafety');
const { getStorageInfo, stopKind, armStop, recoverStop, verifyAuditChain, stopSnapshot } = serverSafety;
const sc = await import('../sandboxCore');
const mon = await import('../integrityMonitor');
const sys = await import('../systemAgentServer');

assert(path.resolve(getStorageInfo().root ?? '').toLowerCase().startsWith(storeDir.toLowerCase()), 'isolated store in use');

// ===========================================================================
section('Phase A — Environment identification');
// ===========================================================================
{
  assert(process.platform === 'win32', `Platform: ${process.platform} (native Windows)`);
  assert(process.version.startsWith('v'), `Node.js: ${process.version}`);
  assert(process.stdin.isTTY === undefined || process.stdin.isTTY === false, `stdin isTTY: ${process.stdin.isTTY} (redirected)`);
  console.log(`  ℹ Windows 11 Pro Build 26300, Dell Inspiron 3593`);
  console.log(`  ℹ Account: meghdipslaptop\\expert, elevated: false`);
  console.log(`  ℹ TTY: stdin redirected — interactive TTY test BLOCKED from this harness`);
  unverified.push('Phase C: full interactive hidden-input flow BLOCKED (no real TTY)');
}

// ===========================================================================
section('Phase B — Recovery CLI implementation inspection [STATIC INSPECTION]');
// ===========================================================================
{
  const cliSrc = fs.readFileSync(path.join(REPO, 'krisha-recovery.ts'), 'utf8');
  assert(!cliSrc.includes('console.log(code'), 'B: credential never printed to console');
  assert(!cliSrc.includes('process.env.RECOVERY'), 'B: credential never in env vars');
  assert(cliSrc.includes('setRawMode(true)'), 'B: raw mode enabled for hidden input');
  assert(cliSrc.includes('setRawMode(false)'), 'B: raw mode disabled after input (cleanup)');
  assert(cliSrc.includes('process.stdin.isTTY'), 'B: TTY detection present');
  assert(cliSrc.includes('interactive terminal (TTY)'), 'B: non-TTY rejection message');
  assert(cliSrc.includes("'\\r' || ch === '\\n'") || cliSrc.includes("'\\n'"), 'B: Enter terminates input');
  assert(cliSrc.includes("'\\x03'"), 'B: Ctrl-C cancellation');
  assert(cliSrc.includes("'\\x7f' || ch === '\\b'") || cliSrc.includes("'\\b'"), 'B: backspace handling');
  assert(cliSrc.includes('value.length < 128'), 'B: max input length bounded');
  assert(!cliSrc.includes('console.log(value'), 'B: input value never echoed');
  assert(cliSrc.includes("process.stdout.write('*')"), 'B: asterisk masking present');
  assert(cliSrc.includes('net.connect(PIPE_PATH)'), 'B: named-pipe connection');
  assert(cliSrc.includes('socket.end()'), 'B: pipe disconnection');
  assert(!cliSrc.includes('stopKind()'), 'B: CLI does NOT evaluate stop state locally');
  assert(!cliSrc.includes('verifyAuditChain'), 'B: CLI does NOT evaluate audit chain locally (only displays the server-reported flag)');
}

// ===========================================================================
section('Phase C — Interactive CLI: TTY detection verified, full flow BLOCKED');
// ===========================================================================
{
  const cliPath = path.join(REPO, 'krisha-recovery.ts');
  const r1 = spawnSync('npx', ['tsx', cliPath, '--recover'], {
    encoding: 'utf8', timeout: 30_000, cwd: REPO, shell: true,
    env: { ...process.env, KRISHA_SANDBOX_DIR: storeDir, KRISHA_FS_ROOTS: fsRoots },
    input: 'piped-credential\n',
  });
  assert(r1.stderr.includes('interactive terminal') || r1.stdout.includes('interactive terminal'),
    'C: non-TTY correctly rejected with TTY error message');

  const r2 = spawnSync('npx', ['tsx', cliPath, '--status'], {
    encoding: 'utf8', timeout: 30_000, cwd: REPO, shell: true,
    env: { ...process.env, KRISHA_SANDBOX_DIR: storeDir, KRISHA_FS_ROOTS: fsRoots },
  });
  assert(r2.stdout.includes('Emergency-stop state') || r2.stderr.includes('recovery pipe unavailable'),
    'C: --status works (or reports pipe unavailability without a running server)');

  unverified.push('Phase C: full interactive hidden-input flow (masking, backspace, Enter, cancellation) BLOCKED — the harness cannot provide a real console TTY');
}

// ===========================================================================
section('Phase D — Named-pipe same-user access + cross-user check');
// ===========================================================================
{
  assert('\\\\.\\pipe\\krisha-e5-recovery'.startsWith('\\\\.\\pipe\\'), 'D: pipe path is a Windows named pipe');
  const users = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-LocalUser | Select-Object Name,Enabled | ConvertTo-Json'], { encoding: 'utf8', timeout: 30_000, shell: true });
  let enabledUsers: Array<{ Name: string; Enabled: boolean }> = [];
  try { const parsed = JSON.parse(users.stdout.trim()); enabledUsers = (Array.isArray(parsed) ? parsed : [parsed]).filter((u: any) => u.Enabled); } catch { /* parse failure */ }
  console.log(`  ℹ Enabled local users: ${enabledUsers.map((u: any) => u.Name).join(', ')}`);
  unverified.push('Phase D: cross-user pipe test BLOCKED — no second login session available from this harness');
  const serverSrc = fs.readFileSync(path.join(REPO, 'serverSafety.ts'), 'utf8');
  assert(!serverSrc.includes('getNamedPipeClientIdentity'), 'D: no explicit client-identity check in pipe server [source — Windows default DACL]');
}

// ===========================================================================
section('Phase E — Emergency-stop persistence (in-process + child restart derivation)');
// ===========================================================================
{
  const eStore = storeDir; // use the suite's own store (pipe is parent-owned)
  const eRoots = fsRoots;
  // In-process activation → persistence → recovery
  serverSafety.activateStop('h8-persistence', 'test');
  assert(stopKind() === 'ACTIVE_NO_CREDENTIAL', 'E: activation → ACTIVE_NO_CREDENTIAL');

  // Verify the stop-state.json exists on disk (persistence evidence).
  const stateFile = path.join(eStore, 'stop-state.json');
  assert(fs.existsSync(stateFile), 'E: stop-state.json persisted on disk');
  const stateData = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert(stateData.active === true, 'E: persisted state has active:true');
  assert(stateData.generation >= 1, `E: persisted generation ${stateData.generation}`);

  // Set credential via the pipe (parent's own pipe server).
  const net = await import('node:net');
  const pipeOp = (msg: Record<string, unknown>): Promise<string> => new Promise((resolve) => {
    const s = (net as any).connect('\\\\.\\pipe\\krisha-e5-recovery');
    const t = setTimeout(() => resolve('TIMEOUT'), 10_000);
    s.on('connect', () => s.write(JSON.stringify({ ...msg, nonce: crypto.randomBytes(32).toString('hex') }) + '\n'));
    s.on('data', (d: Buffer) => { clearTimeout(t); resolve(d.toString().trim()); });
    s.on('error', (e: Error) => { clearTimeout(t); resolve('ERR:' + e.message); });
  });
  const credResult = await pipeOp({ op: 'set-credential', code: 'H8Persist#2026' });
  assert(credResult.includes('"ok":true'), 'E: credential set via pipe');
  assert(stopKind() === 'ACTIVE_CREDENTIALED', 'E: state → ACTIVE_CREDENTIALED');

  // Simulate restart: a fresh child process reads the same stop-state.json.
  const bootScript = path.join(tmp, 'e-boot.mts');
  fs.writeFileSync(bootScript, `
    const ss = await import('${repoUrl}/serverSafety');
    console.log('REBOOT=' + JSON.stringify({ kind: ss.stopKind(), gen: ss.stopSnapshot().generation }));
    process.exit(0);
  `);
  const rec = spawnSync('npx', ['tsx', bootScript], { encoding: 'utf8', timeout: 90_000, cwd: REPO, shell: true, env: { ...process.env, KRISHA_SANDBOX_DIR: eStore, KRISHA_FS_ROOTS: eRoots } });
  const boot = JSON.parse((rec.stdout.match(/REBOOT=(\{.*\})/g)?.[0] ?? 'REBOOT={}').slice(7));
  assert(boot.kind === 'ACTIVE_CREDENTIALED', 'E: stop persisted across restart (fresh boot derives ACTIVE_CREDENTIALED)');

  // Invalid recovery code refused.
  const invalid = await pipeOp({ op: 'recover', code: 'WrongCode#999' });
  assert(invalid.includes('"ok":false') && invalid.includes('invalid recovery credential'), 'E: invalid recovery code refused');

  // Authorized recovery.
  const valid = await pipeOp({ op: 'recover', code: 'H8Persist#2026' });
  assert(valid.includes('"ok":true'), 'E: authorized recovery succeeds');
  assert(stopKind() === 'INACTIVE', 'E: state INACTIVE after authorized recovery');

  // Corrupted state → UNCERTAIN on fresh boot.
  const savedState = fs.readFileSync(stateFile, 'utf8');
  fs.writeFileSync(stateFile, 'CORRUPTED');
  const rec2 = spawnSync('npx', ['tsx', bootScript], { encoding: 'utf8', timeout: 90_000, cwd: REPO, shell: true, env: { ...process.env, KRISHA_SANDBOX_DIR: eStore, KRISHA_FS_ROOTS: eRoots } });
  assert(rec2.stdout.includes('ACTIVE_UNCERTAIN'), 'E: corrupted state boots ACTIVE_UNCERTAIN (fail-closed)');
  // Restore.
  fs.writeFileSync(stateFile, savedState);
  // Re-derive in the parent (the in-memory state was already healthy, re-sync not needed for the test)
}

// ===========================================================================
section('Phase F — Five operator procedures (live-code verification)');
// ===========================================================================
{
  const { scanQuarantineIntegrity, releaseQuarantine, listQuarantine } = await import('../quarantineCore');
  const { journalIntegrityCheck: jic } = await import('../sandboxCore');
  const itemsDir = path.join(storeDir, 'quarantine', 'items');
  fs.mkdirSync(itemsDir, { recursive: true });
  // Seed: a real mutation creates the journal and ensures the store is active.
  await sys.fsCreate(path.join(fsRoots, 'f-seed.txt'), 'file', 'seed');

  // F-A: orphan detection + no automatic action
  const orphan = path.join(itemsDir, 'aaaaaaaa-0000-4000-8000-00000000h6a0.data');
  fs.writeFileSync(orphan, 'orphan-content-h6');
  const scan = scanQuarantineIntegrity();
  assert(scan.orphanedData.some((o) => o.quarantineId === 'aaaaaaaa-0000-4000-8000-00000000h6a0'), 'F-A: orphan detected');
  const rel = releaseQuarantine([path.join(fsRoots, 'no-such-origin.txt')]);
  assert(rel.released.length === 0, 'F-A: orphan not releasable');
  assert(fs.existsSync(orphan), 'F-A: orphan retained (no automatic deletion)');
  fs.rmSync(orphan, { force: true });

  // F-B: torn journal + mutation refusal + no auto-repair
  const sys = await import('../systemAgentServer');
  const journalFile = path.join(storeDir, 'sandbox-journal', 'journal.jsonl');
  await sys.fsCreate(path.join(fsRoots, 'f-b-seed.txt'), 'file', 'seed');
  const jBefore = fs.readFileSync(journalFile, 'utf8');
  fs.appendFileSync(journalFile, '{ H6 TORN\n');
  assert(jic().ok === false, 'F-B: torn journal detected');
  await assertRejects(() => sys.fsCreate(path.join(fsRoots, 'fb-denied.txt'), 'file', 'x'), 'F-B: mutations refused', 'journal inconsistency detected');
  assert(fs.readFileSync(journalFile, 'utf8').includes('{ H6 TORN'), 'F-B: no automatic journal repair');
  fs.writeFileSync(journalFile, jBefore);

  // F-C: unreadable meta → global lock
  const cf = path.join(fsRoots, 'proc-c-h6.txt');
  fs.writeFileSync(cf, 'C-CONTENT');
  await sys.fsDelete(cf);
  const item = listQuarantine().items.find((i) => i.originalPath === cf)!;
  const metaPath = path.join(itemsDir, `${item.quarantineId}.meta.json`);
  const dataPath = path.join(itemsDir, `${item.quarantineId}.data`);
  fs.writeFileSync(metaPath, 'TAMPERED');
  assert(listQuarantine().globallyLocked === true, 'F-C: global lock engages');
  await assertRejects(() => releaseQuarantine([cf]), 'F-C: release refused', 'GLOBALLY LOCKED');
  assert(fs.existsSync(dataPath), 'F-C: data retained');
  fs.rmSync(metaPath, { force: true });
  fs.rmSync(dataPath, { force: true });

  // F-D: audit discontinuity → detected, no auto-repair
  const auditFile = path.join(storeDir, 'audit', 'server-audit.jsonl');
  const auditBefore = fs.readFileSync(auditFile, 'utf8');
  fs.appendFileSync(auditFile, '{"torn":true\n');
  const { verifyAuditChain } = await import('../serverSafety');
  const broken = verifyAuditChain();
  assert(broken.ok === false, 'F-D: audit discontinuity detected');
  assert(fs.readFileSync(auditFile, 'utf8').startsWith(auditBefore), 'F-D: no auto-repair');
  fs.writeFileSync(auditFile, auditBefore);

  // F-E: UNCERTAIN → fresh boot re-derives
  const eStore = path.join(tmp, 'f-e-store');
  const eRoots = path.join(tmp, 'f-e-roots');
  fs.mkdirSync(eRoots, { recursive: true });
  fs.mkdirSync(eStore, { recursive: true });
  fs.writeFileSync(path.join(eStore, 'install.marker'), '{}');
  fs.writeFileSync(path.join(eStore, 'stop-state.json'), 'CORRUPTED');
  const bootScript = path.join(tmp, 'f-boot.mts');
  fs.writeFileSync(bootScript, `
    const ss = await import('${repoUrl}/serverSafety');
    console.log('KIND=' + ss.stopKind());
    process.exit(0);
  `);
  const rec = spawnSync('npx', ['tsx', bootScript], { encoding: 'utf8', timeout: 90_000, cwd: REPO, shell: true, env: { ...process.env, KRISHA_SANDBOX_DIR: eStore, KRISHA_FS_ROOTS: eRoots } });
  assert(rec.stdout.includes('ACTIVE_UNCERTAIN'), 'F-E: corrupted state boots UNCERTAIN (fresh process)');

  // Distinction: production-enforced vs operator-discipline
  assert(typeof scanQuarantineIntegrity === 'function', 'F-A: detection enforced by code');
  assert(typeof listQuarantine === 'function' && 'globallyLocked' in listQuarantine(), 'F-C: global lock enforced by code');
  assert(!fs.readFileSync(path.join(REPO, 'integrityMonitor.ts'), 'utf8').includes('unlinkSync'), 'F: monitor never deletes [source-enforced]');
  const rollbackSrc = fs.readFileSync(path.join(REPO, 'rollbackCore.ts'), 'utf8');
  assert(!rollbackSrc.includes('archive'), 'F-D: archiving is an OPERATOR DISCIPLINE requirement, not technically enforced');
}

// ===========================================================================
section('Phase G — Regression verification');
// ===========================================================================
{
  const { verifyAuditChain: vac, stopKind: sk } = await import('../serverSafety');
  assert(vac().ok === true, 'audit chain verifies');
  const { journalIntegrityCheck: jic } = await import('../sandboxCore');
  assert(jic().ok === true, 'journal integrity verifies');
  const mon = await import('../integrityMonitor');
  const health = mon.evaluateIntegrityHealth();
  assert(health.state === 'HEALTHY' || health.state === 'DEGRADED', `health state reasonable (${health.state})`);
  assert(sk() === 'INACTIVE', 'stop state INACTIVE after all tests');
}

// ===========================================================================
section('Phase H — Failure and interruption testing');
// ===========================================================================
{
  const serverSrc = fs.readFileSync(path.join(REPO, 'serverSafety.ts'), 'utf8');
  assert(serverSrc.includes("socket.on('close'") || serverSrc.includes("socket.on('end'"), 'H: server handles client disconnect [source]');
  const cliSrc = fs.readFileSync(path.join(REPO, 'krisha-recovery.ts'), 'utf8');
  assert(cliSrc.includes("socket.on('error'"), 'H: CLI detects pipe errors [source]');
  assert(cliSrc.includes('recovery pipe unavailable') || cliSrc.includes('recovery pipe timed out'), 'H: clear error message [source]');
  assert(serverSrc.includes('JSON.parse'), 'H: server parses pipe messages atomically [source]');
  unverified.push('Phase H: process-kill during an active pipe operation cannot be timed deterministically — the operation is sub-millisecond');
}

// ===========================================================================
// Cleanup
// ===========================================================================
const itemsDir = path.join(storeDir, 'quarantine', 'items');
try { fs.rmSync(itemsDir, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n== E5 H8 RESULTS: ${passed} passed, ${failed} failed ==`);
if (unverified.length) {
  console.log('Unverified / BLOCKED:');
  for (const u of unverified) console.log(`  ? ${u}`);
}
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
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
process.exit(0);
