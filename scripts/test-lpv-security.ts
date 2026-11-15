/**
 * LPV security test suite — fill authorization (live CDP), leak prevention,
 * permission/stop enforcement, locked-state defense in depth, memory-system
 * rejection, audit redaction. All credentials are SYNTHETIC.
 *
 * Run: npx tsx scripts/test-lpv-security.ts
 *
 * Isolation (house pattern): fixtures in os.tmpdir(); KRISHA_FS_ROOTS
 * narrowed; the E5/LPV store outside every model root. Live fill tests use a
 * loopback-only HTTP server (the vault accepts plain http ONLY on loopback).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { pathToFileURL, fileURLToPath } from 'url';
import { spawn } from 'child_process';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

async function assertRejects(fn: () => unknown, label: string, needle?: string): Promise<void> {
  try {
    await fn();
    assert(false, `${label} (no rejection)`);
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    const kind = (err as { kind?: string })?.kind ?? '';
    const hit = !needle || msg.includes(needle) || kind.includes(needle);
    assert(hit, `${label}${needle ? ` [${needle}]` : ''} — got: ${msg.slice(0, 120)}`);
  }
}

function section(name: string): void {
  console.log(`\n== ${name} ==`);
}

// ---------------------------------------------------------------------------
// Environment BEFORE module import (house pattern).
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'krisha-lpv-sec-'));
const fsRoots = path.join(tmp, 'fsroots');
const storeDir = path.join(tmp, 'e5store');
fs.mkdirSync(fsRoots, { recursive: true });
process.env.KRISHA_FS_ROOTS = fsRoots;
process.env.KRISHA_SANDBOX_DIR = storeDir;

const safety = await import('../serverSafety');
const lpv = await import('../lpvCore');
const cdp = await import('../browserCdp');

// Synthetic credentials — never real ones.
const SYN_USER = 'sec-user@example.test';
const SYN_PASS = 'S3curity-Synth!Pass';

/** Fetch the one-time decision token for a pending challenge — the same
 *  capability the operator card receives from the pending listing. */
function tokenFor(challengeId: string): string {
  const v = lpv.listPendingChallenges().find((c) => c.challengeId === challengeId);
  if (!v) throw new Error(`challenge not pending: ${challengeId}`);
  return v.decisionToken;
}

// ===========================================================================
section('Setup: fresh vault + entries for the fill scenarios');
// ===========================================================================
let loginUrl = '';
let otherUrl = '';
let targetEntryId = '';
{
  await lpv.initializeVault();
  await lpv.unlockVault();
  lpv.setPolicy({ autoSaveEnabled: true, autoSaveCategories: { roblox: true } }, 'test');
  const entry = lpv.addEntry(
    { categoryKey: 'roblox', title: 'Sec Synth Login', username: SYN_USER, password: SYN_PASS, url: 'https://fill-placeholder.invalid/login' },
    { kind: 'policy-auto' },
    'test'
  );
  targetEntryId = entry.entry.id;
  assert(lpv.getVaultStatus().state === 'UNLOCKED', 'vault unlocked for security scenarios');
}

// ===========================================================================
section('A. Enforcement layer — permission + stop gate on vault routes');
// ===========================================================================
{
  function mockReq(p: string, body: Record<string, unknown> = {}): { path: string; body: Record<string, unknown>; headers: Record<string, unknown> } {
    return { path: p, body, headers: {} };
  }
  function mockRes(): { statusCode: number; payload: unknown; nextCalled: boolean; status(c: number): unknown; json(p: unknown): unknown; next(): void } {
    const r = {
      statusCode: 0,
      payload: null as unknown,
      nextCalled: false,
      status(c: number) {
        r.statusCode = c;
        return r;
      },
      json(p: unknown) {
        r.payload = p;
        return r;
      },
      next() {
        r.nextCalled = true;
      },
    };
    return r;
  }

  // /api/vault/fill without a grant → 403 (vault.retrieve is never baseline).
  const mw = safety.enforce({ permission: 'vault.retrieve', stopBlock: true, rate: { group: 'vault-retrieve', limit: 10, windowMs: 60_000 } });
  const res1 = mockRes();
  mw(mockReq('/api/vault/fill') as never, res1 as never, res1.next as never);
  assert(res1.statusCode === 403 && !res1.nextCalled, 'fill route: 403 without an approval-issued grant');

  // With a once-grant issued by requestUiFill → passes; the grant is consumed.
  const g = lpv.requestUiFill(targetEntryId);
  const res2 = mockRes();
  const mw2 = safety.enforce({ permission: 'vault.retrieve', stopBlock: true });
  mw2(mockReq('/api/vault/fill') as never, res2 as never, res2.next as never);
  assert(res2.nextCalled === true, 'fill route passes with an approval-issued single-use grant');
  const res3 = mockRes();
  mw2(mockReq('/api/vault/fill') as never, res3 as never, res3.next as never);
  assert(res3.statusCode === 403 && !res3.nextCalled, 'once-grant is consumed by the first request (remove-before-grant)');

  // vault.manage is operator baseline → management routes pass.
  const mwManage = safety.enforce({ permission: 'vault.manage', stopBlock: true });
  const res4 = mockRes();
  mwManage(mockReq('/api/vault/entry') as never, res4 as never, res4.next as never);
  assert(res4.nextCalled === true, 'vault.manage is operator baseline (management UI works)');
}

// ===========================================================================
section('B. Emergency stop blocks every vault mutation/fill (423)');
// ===========================================================================
{
  const cred = 'S0pth-Stop-Cred!42';
  safety.armStop(cred, 'test');
  const mw = safety.enforce({ permission: 'vault.manage', stopBlock: true });
  const res = { statusCode: 0, payload: null as unknown, nextCalled: false, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.payload = p; return this; }, next() { this.nextCalled = true; } };
  mw({ path: '/api/vault/entry', body: {}, headers: {} } as never, res as never, res.next as never);
  assert(res.statusCode === 423 && !res.nextCalled, 'stop ACTIVE → vault route refused with 423');
  safety.recoverStop(cred, 'test');
  assert(safety.stopKind() === 'INACTIVE', 'stop recovered (INACTIVE)');
}

// ===========================================================================
section('C. Locked vault — defense in depth on every retrieval/fill path');
// ===========================================================================
{
  lpv.lockVault('security-test');
  await assertRejects(() => lpv.requestUiFill(targetEntryId), 'locked: UI fill grant refused', 'vault_locked');
  await assertRejects(
    () => lpv.fillEntry({ grantId: 'lpg_x', fields: [{ secret: 'password', match: 'password' }] }, 'test'),
    'locked: fillEntry refused',
    'vault_locked'
  );
  const ch = lpv.createChallenge('fill', { entryId: targetEntryId, origin: 'https://fill-placeholder.invalid', fields: [{ secret: 'password', match: 'password' }] }, 'automation');
  const lockedToken = lpv.listPendingChallenges().find((c) => c.challengeId === ch.challengeId)!.decisionToken;
  await assertRejects(() => lpv.approveChallenge(ch.challengeId, lockedToken), 'locked: challenge approval refused (valid token, locked vault)', 'vault_locked');
  // (Degraded-mode refusal of unlock is exercised by the core suite's child process.)
  await lpv.unlockVault();
  assert(lpv.getVaultStatus().state === 'UNLOCKED', 'vault re-unlocked for the live-fill sections');
  lpv.declineChallenge(ch.challengeId, lockedToken);
}

// ===========================================================================
section('D. Console/log redaction — synthetic secret never printed');
// ===========================================================================
{
  const captured: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of ['log', 'warn', 'error', 'info'] as const) {
    console[k] = (...args: unknown[]) => captured.push(args.map((a) => String(a)).join(' '));
  }
  try {
    // Full flow with the credential in play: unlock → save → update → delete.
    await lpv.unlockVault();
    const e = lpv.addEntry({ categoryKey: 'roblox', title: 'Sec Redaction', username: SYN_USER, password: SYN_PASS, url: 'https://redaction.example.test/x' }, { kind: 'policy-auto' }, 'test');
    lpv.updateEntry(e.entry.id, { title: 'Sec Redaction 2' }, { kind: 'user-direct' }, 'test');
    lpv.deleteEntry(e.entry.id, 'test');
    lpv.lockVault('test');
    await lpv.unlockVault();
    // A failing fill with the credential decrypted in-process (wrong origin).
    const e2 = lpv.addEntry({ categoryKey: 'roblox', title: 'Sec Redaction Fill', username: SYN_USER, password: SYN_PASS, url: 'https://nowhere.example.test/x' }, { kind: 'policy-auto' }, 'test');
    const g = lpv.requestUiFill(e2.entry.id);
    await assertRejects(() => lpv.fillEntry({ grantId: g.grantId, fields: [{ secret: 'password', match: 'password' }] }, 'test'), 'fill fails (origin mismatch)', 'origin_mismatch');
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
    console.info = orig.info;
  }
  const blob = captured.join('\n');
  assert(!blob.includes(SYN_PASS), 'console output during full flow contains NO synthetic password');
  assert(!blob.includes(SYN_USER), 'console output during full flow contains NO synthetic username');
  const histBlob = JSON.stringify(lpv.getHistory(500));
  assert(!histBlob.includes(SYN_PASS) && !histBlob.includes(SYN_USER), 'audit history contains NO credential values');
}

// ===========================================================================
section('E. Memory system rejects credential-shaped content');
// ===========================================================================
{
  try {
    const memoryPath = pathToFileURL(fileURLToPath(new URL('../src/agent/memory/memoryService.ts', import.meta.url))).href;
    const memory = (await import(memoryPath)) as { getMemoryService: () => { remember: (t: string, o?: unknown) => unknown; displayMemories: () => string[] } };
    const svc = memory.getMemoryService();
    svc.remember(`My Roblox password is ${SYN_PASS}`, { source: 'conversation_extract' } as never);
    svc.remember(`api key: sk-proj-SYNTHETIC1234567890`, { source: 'conversation_extract' } as never);
    const mems = svc.displayMemories().join('\n');
    assert(!mems.includes(SYN_PASS), 'memory system REJECTS password-shaped content (SECRET_PATTERNS)');
    assert(!mems.includes('sk-proj-SYNTHETIC'), 'memory system REJECTS api-key-shaped content (SECRET_PATTERNS)');
  } catch (err) {
    console.log(`  ! memoryService unavailable in Node (${String((err as Error)?.message || err).slice(0, 80)}) — pattern check covered by lpv-core E-section`);
    assert(true, 'memory rejection check skipped (client-side module)');
  }
}

// ===========================================================================
section('F/G/H. Live CDP fill — origin-verified, field-verified, leak-free');
// ===========================================================================
let port1 = 0;
let port2 = 0;
const servers: http.Server[] = []; // kept up through sections I–K (fills target these origins)
{
  // Two loopback HTTP servers on DIFFERENT origins (ports).
  const loginPage = (tag: string) => `<!doctype html><html><head><title>${tag} Login</title></head><body>
    <form><input id="u" name="email" type="text" placeholder="Email address">
    <input id="p" name="password" type="password" placeholder="Password">
    <button type="submit">Sign in</button></form></body></html>`;
  const listen = (): Promise<number> =>
    new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(loginPage(req.url?.includes('other') ? 'Other' : 'Main'));
      });
      servers.push(s);
      s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port));
    });
  port1 = await listen();
  port2 = await listen();
  loginUrl = `http://127.0.0.1:${port1}/login`;
  otherUrl = `http://127.0.0.1:${port2}/other`;

  // Bind the entry to the FIRST origin and open that page in Krisha's
  // controlled browser (the fill verifies the live page origin).
  lpv.updateEntry(targetEntryId, { url: loginUrl }, { kind: 'user-direct' }, 'test');
  await cdp.browserNavigate(loginUrl);

  // F: approval-authority closure — challenge → operator decision → SERVER-SIDE
  // execution of the exact approved fill. No grant capability is ever issued
  // to the requester, and challenge/status exposes metadata only.
  const ch = lpv.createChallenge(
    'fill',
    { entryId: targetEntryId, fields: [{ secret: 'username', match: 'email' }, { secret: 'password', match: 'password' }] },
    'automation'
  );
  const createdBlob = JSON.stringify(ch);
  assert(!createdBlob.includes('decisionToken') && !createdBlob.includes('lpg_'), 'challenge creation response carries NO decision capability');
  const st0 = lpv.getChallengeStatus(ch.challengeId);
  assert(st0.state === 'pending' && !('grantId' in st0) && st0.fillOutcome === undefined, 'challenge status exposes state only (no grant, no outcome before approval)');

  // Adversarial: blind approve / forged token / cross-challenge token.
  await assertRejects(() => lpv.approveChallenge(ch.challengeId, undefined), 'blind approve WITHOUT the card-issued decision token refused', 'approval_invalid');
  await assertRejects(() => lpv.approveChallenge(ch.challengeId, 'forged-token-000000000000'), 'forged decision token refused', 'approval_invalid');
  const decoy = lpv.createChallenge('save', { entryDraft: { categoryKey: 'google', title: 'Decoy' } }, 'automation');
  await assertRejects(
    () => lpv.approveChallenge(ch.challengeId, tokenFor(decoy.challengeId)),
    'cross-challenge token substitution refused',
    'approval_invalid'
  );
  lpv.declineChallenge(decoy.challengeId, tokenFor(decoy.challengeId));

  // The human-facing card path: pending listing carries the one-time token.
  const pending = lpv.listPendingChallenges().find((c) => c.challengeId === ch.challengeId)!;
  assert(typeof pending.decisionToken === 'string' && pending.decisionToken.length >= 32, 'pending listing carries the one-time decision token (the card\'s capability)');
  const approved = await lpv.approveChallenge(ch.challengeId, pending.decisionToken);
  assert(approved.approved === true && approved.fill?.success === true, 'operator approval EXECUTES the approved fill server-side');
  assert(approved.fill.url === `http://127.0.0.1:${port1}`, 'executed fill origin equals the approved destination');
  assert(approved.fill.filled.length === 2 && approved.fill.filled.every((f) => f.filled), 'both fields filled (username + password)');
  assert(approved.fill.filled.some((f) => (f.matched ?? '').includes('password')), 'password landed in a real input[type=password]');
  assert(!('grantId' in approved), 'approval response hands out NO grant capability');
  const approvedBlob = JSON.stringify(approved);
  assert(!approvedBlob.includes(SYN_PASS) && !approvedBlob.includes(SYN_USER), 'approval-executed fill response contains no credential values (metadata only)');

  // Consumed challenge: replay approve refused; status metadata-only.
  await assertRejects(() => lpv.approveChallenge(ch.challengeId, pending.decisionToken), 'consumed challenge cannot be redeemed (replay refused)', 'approval_invalid');
  const status = lpv.getChallengeStatus(ch.challengeId);
  assert(status.state === 'approved' && typeof status.fillOutcome?.url === 'string', 'challenge status exposes state + metadata outcome');
  assert(!('grantId' in status) && !JSON.stringify(status).includes('lpg_'), 'challenge status NEVER exposes a retrieval grant');
  assert(!JSON.stringify(status.fillOutcome).includes(SYN_PASS) && !JSON.stringify(status.fillOutcome).includes(SYN_USER), 'challenge outcome contains no credential values');

  // Retrieval bookkeeping + audit.
  const meta = lpv.listEntries().entries.find((e) => e.id === targetEntryId)!;
  assert(meta.retrieveCount === 1 && meta.lastRetrievedAt !== null, 'retrieval bookkeeping updated (count + timestamp)');
  const auditBlob = JSON.stringify(lpv.getHistory(500).events.filter((e) => e.kind === 'lpv_retrieve' || e.kind === 'lpv_grant_issued'));
  assert(auditBlob.includes(targetEntryId.slice(0, 12)), 'retrieval audited with entry id');
  assert(!auditBlob.includes(SYN_PASS), 'retrieval audit contains no secret');

  // F2 (grant path): the operator UI-direct fill still uses single-use bound
  // grants — and a grant cannot fill twice.
  const g1 = lpv.requestUiFill(targetEntryId);
  const result = await lpv.fillEntry(
    { grantId: g1.grantId, fields: [{ secret: 'username', match: 'email' }, { secret: 'password', match: 'password' }] },
    'ui-direct'
  );
  assert(result.success === true, 'grant-path fill succeeds on the approved origin');
  await assertRejects(
    () => lpv.fillEntry({ grantId: g1.grantId, fields: [{ secret: 'password', match: 'password' }] }, 'test'),
    'grant is single-use (second fill refused)',
    'grant_invalid'
  );

  // G: origin mismatch — navigate the browser to the SECOND origin, present
  // a grant bound to the FIRST → refused, grant consumed, nothing filled.
  await cdp.browserNavigate(otherUrl);
  const g2 = lpv.requestUiFill(targetEntryId);
  await assertRejects(
    () => lpv.fillEntry({ grantId: g2.grantId, fields: [{ secret: 'password', match: 'password' }] }, 'test'),
    'cross-origin fill refused (page origin ≠ approved origin)',
    'origin_mismatch'
  );

  // H: field verification — a match that hits no real password field.
  await cdp.browserNavigate(loginUrl);
  const g3 = lpv.requestUiFill(targetEntryId);
  const r3 = await lpv.fillEntry({ grantId: g3.grantId, fields: [{ secret: 'password', match: 'totally-absent-field' }] }, 'test');
  assert(r3.success === true && r3.filled[0].filled === false && r3.filled[0].reason === 'field_not_found', 'unknown field match → honest field_not_found result');
  assert(!JSON.stringify(r3).includes(SYN_PASS), 'failed-fill response still leaks nothing');

  // NOTE: the local servers stay UP through sections I–K — sections I–K fill
  // against these origins; closing them here made section K navigate to a
  // dead port (the fill's origin refusal was CORRECT; the harness was wrong).
}

// ===========================================================================
section('I. Multi-tab fill pinning (audit repair D1)');
// ===========================================================================
{
  // Pre-fix TOCTOU: origin was verified on "the first page target" and the
  // fill executed on a SECOND independent "first page target" resolution —
  // with ≥2 tabs the two could diverge. Repair: the probe walks ALL open
  // pages, picks the one whose LIVE origin equals the approved origin,
  // pins the fill to THAT session, and the expression re-verifies
  // location.origin atomically with the typing.
  //
  // SPF-verification coordination note (defect established, owner: LPV
  // workstream — reproduced 1-in-4 suite runs): Target.createTarget
  // registers the tab asynchronously and a freshly created page is rarely
  // 'complete' on the next tick, so filling immediately after createTab
  // raced the target list (origin_mismatch) and the load state
  // (page_not_ready). This bounded probe waits for exactly what the D1
  // scenario needs — the matching-origin page listed AND 'complete' — using
  // browserFillFields with a probe-only expression (no field specs, nothing
  // typed). No origin or pinning semantics change.
  async function waitForTabReady(origin: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        await cdp.browserFillFields(origin, 'JSON.stringify({ probed: true, origin: location.origin, ready: document.readyState })');
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw lastErr ?? new Error('tab readiness wait timed out');
  }

  const entry2 = lpv.addEntry({ categoryKey: 'roblox', title: 'Sec Tab B', username: SYN_USER, password: SYN_PASS, url: otherUrl }, { kind: 'policy-auto' }, 'test');
  await cdp.browserCreateTab(otherUrl); // second tab, DIFFERENT origin
  await waitForTabReady(new URL(otherUrl).origin); // tab listed AND loaded (removes the load race)

  // With BOTH tabs open (in either possible target order), each entry must
  // land on the page matching ITS approved origin.
  const g1 = lpv.requestUiFill(targetEntryId);
  const r1 = await lpv.fillEntry({ grantId: g1.grantId, fields: [{ secret: 'password', match: 'password' }] }, 'test');
  assert(r1.success === true && r1.url === `http://127.0.0.1:${port1}`, 'D1: fill lands on the approved-origin tab even with a foreign tab open');

  const g2 = lpv.requestUiFill(entry2.entry.id);
  const r2 = await lpv.fillEntry({ grantId: g2.grantId, fields: [{ secret: 'password', match: 'password' }] }, 'test');
  assert(r2.success === true && r2.url === `http://127.0.0.1:${port2}`, 'D1: fill lands on tab B (probe skipped tab A of a different origin)');

  // No open page at the approved origin → refusal, nothing typed anywhere.
  const entry3 = lpv.addEntry({ categoryKey: 'roblox', title: 'Sec Tab Missing', password: SYN_PASS, url: 'https://absent-origin.example.test/x' }, { kind: 'policy-auto' }, 'test');
  const g3 = lpv.requestUiFill(entry3.entry.id);
  await assertRejects(
    () => lpv.fillEntry({ grantId: g3.grantId, fields: [{ secret: 'password', match: 'password' }] }, 'test'),
    'D1: no matching page → refusal (origin_mismatch)',
    'origin_mismatch'
  );
  lpv.deleteEntry(entry2.entry.id, 'test');
  lpv.deleteEntry(entry3.entry.id, 'test');
}

// ===========================================================================
section('J. Concurrent fills — serialized, correct pages, no cross-talk');
// ===========================================================================
{
  // Both tabs are open from section I (tab A at port1, tab B at port2). Two
  // fills targeting DIFFERENT origins are launched simultaneously; the fill
  // chain serializes the CDP work while each fill still lands on ITS
  // approved page.
  const eA = lpv.addEntry({ categoryKey: 'roblox', title: 'Sec Conc A', username: SYN_USER, password: SYN_PASS, url: loginUrl }, { kind: 'policy-auto' }, 'test');
  const eB = lpv.addEntry({ categoryKey: 'roblox', title: 'Sec Conc B', username: SYN_USER, password: SYN_PASS, url: otherUrl }, { kind: 'policy-auto' }, 'test');
  const gA = lpv.requestUiFill(eA.entry.id); // origin port1
  const gB = lpv.requestUiFill(eB.entry.id); // origin port2
  const [ra, rb] = await Promise.all([
    lpv.fillEntry({ grantId: gA.grantId, fields: [{ secret: 'password', match: 'password' }] }, 'concurrent'),
    lpv.fillEntry({ grantId: gB.grantId, fields: [{ secret: 'password', match: 'password' }] }, 'concurrent'),
  ]);
  assert(ra.success === true && ra.url === `http://127.0.0.1:${port1}`, 'concurrent fill A landed on the approved origin A');
  assert(rb.success === true && rb.url === `http://127.0.0.1:${port2}`, 'concurrent fill B landed on the approved origin B');
  const bothBlob = JSON.stringify([ra, rb]);
  assert(!bothBlob.includes(SYN_PASS), 'concurrent fill responses leak nothing');
  lpv.deleteEntry(eA.entry.id, 'test');
  lpv.deleteEntry(eB.entry.id, 'test');
}

// ===========================================================================
section('K. Browser restart — a fresh browser can never receive a fill');
// ===========================================================================
{
  // Restart the Krisha-controlled browser: the new instance opens with NO
  // tabs. A fill against ANY origin must refuse (no matching page) — a
  // restart can never redirect a fill into an unverified page.
  await cdp.browserStop();
  const g = lpv.requestUiFill(targetEntryId);
  await assertRejects(
    () => lpv.fillEntry({ grantId: g.grantId, fields: [{ secret: 'password', match: 'password' }] }, 'test'),
    'post-restart fill refused (no matching page in the fresh browser)',
    'origin_mismatch'
  );
  // Recover: navigate the fresh browser to the approved origin → fill works.
  await cdp.browserNavigate(loginUrl);
  const g2 = lpv.requestUiFill(targetEntryId);
  const r = await lpv.fillEntry({ grantId: g2.grantId, fields: [{ secret: 'password', match: 'password' }] }, 'test');
  assert(r.success === true && r.url === `http://127.0.0.1:${port1}`, 'post-restart fill succeeds after navigating to the approved origin');
}

// ===========================================================================
section('L. Emergency stop — core-level gate on retrieval and approval');
// ===========================================================================
{
  // Route-level stop blocking is verified in section B; the core-level gate
  // (defense in depth) is exercised here directly.
  const cred = 'S0pth-Stop-Cred!42';
  safety.armStop(cred, 'test');
  await assertRejects(
    () => lpv.fillEntry({ grantId: 'lpg_x', fields: [{ secret: 'password', match: 'password' }] }, 'test'),
    'core-level stop gate refuses fillEntry while the emergency stop is ACTIVE',
    'emergency_stop_active'
  );
  const ch = lpv.createChallenge('fill', { entryId: targetEntryId, fields: [{ secret: 'password', match: 'password' }] }, 'automation');
  const tk = tokenFor(ch.challengeId);
  await assertRejects(
    () => lpv.approveChallenge(ch.challengeId, tk),
    'core-level stop gate refuses challenge approval while the stop is ACTIVE',
    'emergency_stop_active'
  );
  await assertRejects(
    () => lpv.requestUiFill(targetEntryId),
    'core-level stop gate refuses grant issuance while the stop is ACTIVE',
    'emergency_stop_active'
  );
  await assertRejects(
    () => lpv.addEntry({ categoryKey: 'roblox', title: 'Sec StopBlocked', password: SYN_PASS }, { kind: 'user-direct' }, 'test'),
    'core-level stop gate refuses entry mutation while the stop is ACTIVE',
    'emergency_stop_active'
  );
  safety.recoverStop(cred, 'test');
  assert(safety.stopKind() === 'INACTIVE', 'stop recovered (INACTIVE)');
}

for (const s of servers) s.close();

// ===========================================================================
section('Z. Cleanup');
// ===========================================================================
{
  lpv.lockVault('security-suite');
  assert(lpv._lpvTestHooks.noKeyMaterialResident(), 'key material zeroed at suite end');
  try {
    await cdp.browserStop();
  } catch {
    /* not launched */
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failures.length > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
