/**
 * LPV core test suite — vault lifecycle, crypto properties, tamper
 * fail-closed behavior, retention policy, audit chain, restart recovery,
 * degraded mode. All credentials are SYNTHETIC.
 *
 * Run: npx tsx scripts/test-lpv-core.ts
 *
 * Isolation (house pattern, cf. test-e5-m1.ts): all fixtures live in
 * os.tmpdir(); model filesystem roots are narrowed via KRISHA_FS_ROOTS and
 * the E5 store — and therefore the LPV store — sits outside them.
 * Store-switching scenarios (restart, degraded protection) run in CHILD
 * processes because the core module resolves its boot state once at import.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
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

function runChild(scriptPath: string, env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  // Children must run through tsx (like this parent): Node's native type
  // stripping rejects parameter properties used by the TypeScript sources.
  // The tsx CLI is resolved relative to this script's module location.
  const tsxCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const useTsx = fs.existsSync(tsxCli);
  const args = useTsx ? [tsxCli, scriptPath] : [scriptPath];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.on('data', (d) => (out += String(d)));
    child.stderr!.on('data', (d) => (out += String(d)));
    child.on('exit', (code) => resolve({ code: code ?? 1, out }));
  });
}

// ---------------------------------------------------------------------------
// Environment BEFORE module import (house pattern).
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'krisha-lpv-core-'));
const fsRoots = path.join(tmp, 'fsroots');
const storeDir = path.join(tmp, 'e5store');
fs.mkdirSync(fsRoots, { recursive: true });
process.env.KRISHA_FS_ROOTS = fsRoots;
process.env.KRISHA_SANDBOX_DIR = storeDir;

const lpvDir = path.join(storeDir, 'lpv');
const VAULT_FILE = path.join(lpvDir, 'vault.json');
const VAULT_BAK = path.join(lpvDir, 'vault.json.bak');
const KEY_FILE = path.join(lpvDir, 'key.blob');
const ACCOUNT_FILE = path.join(lpvDir, 'account.json');
const AUDIT_FILE = path.join(lpvDir, 'audit', 'lpv-audit.jsonl');

const LPV_CORE_TS = pathToFileURL(fileURLToPath(new URL('../lpvCore.ts', import.meta.url))).href;

const safety = await import('../serverSafety');
const lpv = await import('../lpvCore');
const dpapi = await import('../lpvDpapi');

// Synthetic credentials — never real ones.
const SYN_USER = 'synthetic-user@example.test';
const SYN_PASS = 'S0ynth-Passw0rd-Core!';

/** Fetch the one-time decision token for a pending challenge — the same
 *  capability the operator card receives from the pending listing. */
function tokenFor(challengeId: string): string {
  const v = lpv.listPendingChallenges().find((c) => c.challengeId === challengeId);
  if (!v) throw new Error(`challenge not pending: ${challengeId}`);
  return v.decisionToken;
}

// Snapshot of a healthy vault.json, kept for the J-section boot checks
// (section L destroys this store afterwards).
let validVaultRaw = '';

// ===========================================================================
section('A. Boot state + initialization');
// ===========================================================================
{
  const s0 = lpv.getVaultStatus();
  assert(s0.state === 'UNINITIALIZED', 'fresh store boots UNINITIALIZED');
  assert(s0.protection === 'full', 'storage protection = full (store outside model roots)');
  assert(!fs.existsSync(VAULT_FILE), 'no vault file before init');

  await lpv.initializeVault();
  const s1 = lpv.getVaultStatus();
  assert(s1.state === 'LOCKED', 'after creation the vault is LOCKED (never auto-unlocked)');
  assert(s1.entryCount === 0 && s1.generation === 1, 'generation 1, zero entries');
  assert(fs.existsSync(VAULT_FILE) && fs.existsSync(KEY_FILE) && fs.existsSync(ACCOUNT_FILE), 'key.blob / vault.json / account.json all created');
  assert(fs.readFileSync(KEY_FILE, 'utf8').length > 40, 'key.blob holds a DPAPI blob (base64)');

  const sid = await dpapi.dpapiCurrentSid();
  const acct = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
  assert(acct.sid === sid, 'account binding records the current Windows SID');

  await assertRejects(() => lpv.initializeVault(), 'double initialization refused', 'already exists');

  assertThrowsRef(() => safety.assertNotProtected(VAULT_FILE), 'model fs operations refuse the vault file (assertNotProtected)');
  assert(safety.isProtectedPath(lpvDir), 'isProtectedPath marks the lpv directory (fsSearch skips it)');

  const listed = lpv.listEntries();
  assert(listed.entries.length === 0 && listed.verified === false, 'locked listing serves no entries and is flagged unverified');
}

function assertThrowsRef(fn: () => unknown, label: string): void {
  try {
    fn();
    assert(false, `${label} (no throw)`);
  } catch {
    assert(true, label);
  }
}

// ===========================================================================
section('B. Unlock / lock lifecycle + key hygiene');
// ===========================================================================
{
  await lpv.unlockVault();
  assert(lpv.getVaultStatus().state === 'UNLOCKED', 'unlock succeeds (DPAPI round-trip + MAC verified)');
  assert(lpv.getVaultStatus().verified === true, 'document verified after unlock');

  lpv.lockVault('test');
  assert(lpv.getVaultStatus().state === 'LOCKED', 'lock returns to LOCKED');
  assert(lpv._lpvTestHooks.noKeyMaterialResident(), 'master key + subkeys are ZEROED while locked');

  await assertRejects(() => lpv.addEntry({ categoryKey: 'google', title: 'x', password: 'y' }, { kind: 'user-direct' }, 'test'), 'locked vault refuses writes', 'vault_locked');
  await assertRejects(() => lpv.requestUiFill('ve_none'), 'locked vault refuses fill grants', 'vault_locked');

  await lpv.unlockVault();
  assert(lpv.getVaultStatus().state === 'UNLOCKED', 're-unlock works after lock');
}

// ===========================================================================
section('C. Entry CRUD + encryption properties');
// ===========================================================================
let robloxId = '';
let googleId = '';
{
  const g = lpv.addEntry({ categoryKey: 'google', title: 'Synth Google', username: SYN_USER, password: SYN_PASS, url: 'https://accounts.example.test/login' }, { kind: 'user-direct' }, 'test');
  assert(g.entry.category === 'A', 'google is Category A');
  googleId = g.entry.id;

  const r0 = lpv.addEntry({ categoryKey: 'roblox', title: 'Synth Roblox', username: SYN_USER, password: SYN_PASS }, { kind: 'user-direct' }, 'test');
  assert(r0.entry.category === 'A', 'unclassified "roblox" defaults to Category A (fail-closed)');

  lpv.setPolicy({ autoSaveEnabled: true, autoSaveCategories: { roblox: true } }, 'test');
  const r1 = lpv.addEntry({ categoryKey: 'roblox', title: 'Synth Roblox 2', username: SYN_USER, password: SYN_PASS }, { kind: 'policy-auto' }, 'automation');
  assert(r1.entry.category === 'B', 'policy-enabled category behaves as Category B');
  robloxId = r1.entry.id;
  const events = lpv.getHistory(200).events;
  assert(events.some((e) => e.kind === 'lpv_auto_save' && e.entryId === robloxId), 'auto-save audited as lpv_auto_save');

  const raw = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
  const ivs = new Set(raw.entries.map((e: { iv: string }) => e.iv));
  assert(ivs.size === raw.entries.length, 'every entry carries a unique IV');
  const joined = JSON.stringify(raw.entries);
  assert(!joined.includes(SYN_PASS), 'ciphertexts do not contain the synthetic password (encrypted at rest)');
  assert(joined.includes('Synth Roblox'), 'plaintext metadata (title) IS present by design');

  const oldCipher = JSON.parse(JSON.stringify(raw.entries)).find((e: { id: string }) => e.id === robloxId).ciphertext;
  const u = lpv.updateEntry(robloxId, { title: 'Synth Roblox (renamed)' }, { kind: 'user-direct' }, 'test');
  assert(u.entry.title === 'Synth Roblox (renamed)' && u.entry.hasUsername === true, 'update keeps carried-over secrets (decrypt/re-encrypt round-trip)');
  const raw2 = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
  const newCipher = raw2.entries.find((e: { id: string }) => e.id === robloxId).ciphertext;
  assert(newCipher !== oldCipher, 're-encryption produces a different ciphertext (fresh IV)');

  const before = raw2.generation;
  const del = lpv.deleteEntry(r0.entry.id, 'test');
  assert(del.deleted === true, 'delete removes the entry');
  const raw3 = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
  assert(!raw3.entries.some((e: { id: string }) => e.id === r0.entry.id), 'deleted entry gone from primary (secure delete)');
  const bak = JSON.parse(fs.readFileSync(VAULT_BAK, 'utf8'));
  assert(bak.generation === before, 'backup holds the previous generation');
  assert(bak.entries.some((e: { id: string }) => e.id === r0.entry.id), 'backup retains pre-delete generation');
}

// ===========================================================================
section('D. Retention policy enforcement (bypass attempts refused)');
// ===========================================================================
{
  await assertRejects(
    () => lpv.addEntry({ categoryKey: 'banking', title: 'Synth Bank', password: SYN_PASS }, { kind: 'policy-auto' }, 'automation'),
    'auto-save for Category A refused',
    'policy_violation'
  );
  lpv.setPolicy({ autoSaveEnabled: false }, 'test');
  await assertRejects(
    () => lpv.addEntry({ categoryKey: 'roblox', title: 'Synth Roblox 3', password: SYN_PASS }, { kind: 'policy-auto' }, 'automation'),
    'auto-save with master toggle off refused',
    'policy_violation'
  );
  lpv.setPolicy({ autoSaveEnabled: true, autoSaveCategories: { roblox: false } }, 'test');
  await assertRejects(
    () => lpv.addEntry({ categoryKey: 'roblox', title: 'Synth Roblox 3', password: SYN_PASS }, { kind: 'policy-auto' }, 'automation'),
    'auto-save with category toggle off refused',
    'policy_violation'
  );
  lpv.setPolicy({ autoSaveCategories: { roblox: true } }, 'test');
}

// ===========================================================================
section('E. Category C — temporary secrets never stored (fail-closed)');
// ===========================================================================
{
  await assertRejects(() => lpv.addEntry({ categoryKey: 'google', title: 'Gmail OTP', password: SYN_PASS }, { kind: 'user-direct' }, 'test'), 'OTP label refused', 'temporary_secret');
  await assertRejects(() => lpv.addEntry({ categoryKey: 'google', title: 'Login', password: SYN_PASS, notes: 'verification code arrives by SMS' }, { kind: 'user-direct' }, 'test'), 'verification-code label refused', 'temporary_secret');
  await assertRejects(() => lpv.addEntry({ categoryKey: 'payment', title: 'Card code', password: '123456' }, { kind: 'user-direct' }, 'test'), 'short numeric code in code-labeled entry refused', 'temporary_secret');
  await assertRejects(() => lpv.addEntry({ categoryKey: 'google', title: 'Authenticator seed key', password: 'JBSWY3DPEHPK3PXPJBSWY3DP' }, { kind: 'user-direct' }, 'test'), 'base32 seed shape refused', 'temporary_secret');
  const ok = lpv.addEntry({ categoryKey: 'google', title: 'Synth Plain', password: '123456' }, { kind: 'user-direct' }, 'test');
  assert(ok.entry.category === 'A', 'plain short numeric password without code-label context is accepted');
  lpv.deleteEntry(ok.entry.id, 'test');
}

// ===========================================================================
section('F. Approval challenges (Category A)');
// ===========================================================================
{
  await assertRejects(
    () => lpv.addEntry({ categoryKey: 'google', title: 'Synth NoApproval', password: SYN_PASS }, { kind: 'policy-auto' }, 'automation'),
    'Category A with policy-auto approval refused',
    'policy_violation'
  );
  const ch = lpv.createChallenge('save', { entryDraft: { categoryKey: 'google', title: 'Synth Challenged' } }, 'automation');
  assert(lpv._lpvTestHooks.pendingChallenges() === 1, 'challenge created pending');

  await lpv.approveChallenge(ch.challengeId, tokenFor(ch.challengeId));
  const saved = lpv.addEntry({ categoryKey: 'google', title: 'Synth Challenged', password: SYN_PASS }, { kind: 'challenge', challengeId: ch.challengeId }, 'automation');
  assert(saved.entry.category === 'A', 'challenge-approved Category A save accepted');
  await assertRejects(
    () => lpv.addEntry({ categoryKey: 'google', title: 'Synth Replay', password: SYN_PASS }, { kind: 'challenge', challengeId: ch.challengeId }, 'automation'),
    'challenge replay (second use) refused',
    'approval_invalid'
  );
  lpv.deleteEntry(saved.entry.id, 'test');

  const ch2 = lpv.createChallenge('save', { entryDraft: { categoryKey: 'google', title: 'X' } }, 'automation');
  await assertRejects(
    () => lpv.addEntry({ categoryKey: 'google', title: 'Synth Unapproved', password: SYN_PASS }, { kind: 'challenge', challengeId: ch2.challengeId }, 'automation'),
    'pending (unapproved) challenge refused for save',
    'approval_invalid'
  );
  await assertRejects(
    () => lpv.addEntry({ categoryKey: 'google', title: 'Synth Unknown', password: SYN_PASS }, { kind: 'challenge', challengeId: 'lpc_bogus' }, 'automation'),
    'unknown challenge id refused',
    'approval_invalid'
  );
  lpv.declineChallenge(ch2.challengeId, tokenFor(ch2.challengeId));
}

// ===========================================================================
section('F2. Approval authority — decision tokens, binding, expiry, immunity');
// ===========================================================================
{
  // D2 — an approved save challenge authorizes EXACTLY the approved draft.
  const ok = lpv.createChallenge('save', { entryDraft: { categoryKey: 'google', title: 'Bound Save' } }, 'automation');
  await lpv.approveChallenge(ok.challengeId, tokenFor(ok.challengeId));
  const saved = lpv.addEntry({ categoryKey: 'google', title: 'Bound Save', password: SYN_PASS }, { kind: 'challenge', challengeId: ok.challengeId }, 'automation');
  assert(saved.entry.category === 'A', 'D2: challenge-approved save with the EXACT draft accepted');
  lpv.deleteEntry(saved.entry.id, 'test');

  const swap = lpv.createChallenge('save', { entryDraft: { categoryKey: 'google', title: 'Approved Title' } }, 'automation');
  await lpv.approveChallenge(swap.challengeId, tokenFor(swap.challengeId));
  await assertRejects(
    () => lpv.addEntry({ categoryKey: 'google', title: 'DIFFERENT Title', password: SYN_PASS }, { kind: 'challenge', challengeId: swap.challengeId }, 'automation'),
    'D2: save with a different title than the approved draft refused',
    'approval_invalid'
  );
  await assertRejects(
    () => lpv.addEntry({ categoryKey: 'roblox', title: 'Approved Title', password: SYN_PASS }, { kind: 'challenge', challengeId: swap.challengeId }, 'automation'),
    'D2: save with a different category than the approved draft refused',
    'approval_invalid'
  );
  await assertRejects(
    () => lpv.createChallenge('save', { entryDraft: { categoryKey: 'google' } as { categoryKey: string; title: string } }, 'automation'),
    'D2: save challenge without a draft title refused',
    'invalid_input'
  );

  // D3 — approved challenges expire at their original TTL (no delayed replay).
  const late = lpv.createChallenge('save', { entryDraft: { categoryKey: 'google', title: 'Late Save' } }, 'automation');
  await lpv.approveChallenge(late.challengeId, tokenFor(late.challengeId));
  lpv._lpvTestHooks.setNow(() => Date.now() + 11 * 60_000);
  await assertRejects(
    () => lpv.addEntry({ categoryKey: 'google', title: 'Late Save', password: SYN_PASS }, { kind: 'challenge', challengeId: late.challengeId }, 'automation'),
    'D3: approved challenge redeemed after TTL refused',
    'approval_invalid'
  );
  lpv._lpvTestHooks.setNow(() => Date.now());

  // Built-in Category A keys are immune to policy enablement.
  lpv.setPolicy({ autoSaveCategories: { google: true } }, 'test');
  await assertRejects(
    () => lpv.addEntry({ categoryKey: 'google', title: 'Synth PolicyA', password: SYN_PASS }, { kind: 'policy-auto' }, 'automation'),
    'built-in Category A cannot be auto-save-enabled via policy',
    'policy_violation'
  );

  // D8 — pending fill challenges resolve the display origin from the entry,
  // and every pending challenge carries its one-time decision token.
  const cardEntry = lpv.addEntry({ categoryKey: 'roblox', title: 'Synth CardOrigin', password: SYN_PASS, url: 'https://card-origin.example.test/x' }, { kind: 'policy-auto' }, 'test');
  const fc = lpv.createChallenge('fill', { entryId: cardEntry.entry.id, fields: [{ secret: 'password', match: 'password' }] }, 'automation');
  const view = lpv.listPendingChallenges().find((c) => c.challengeId === fc.challengeId);
  assert(view?.origin === 'https://card-origin.example.test', 'D8: pending fill challenge shows the entry destination origin');
  assert(typeof view?.decisionToken === 'string' && view.decisionToken.length >= 32, 'pending challenge carries the one-time decision token');
  lpv.declineChallenge(fc.challengeId, tokenFor(fc.challengeId));
  lpv.deleteEntry(cardEntry.entry.id, 'test');

  // Approval-authority adversarial cases (core level).
  const adv = lpv.createChallenge('save', { entryDraft: { categoryKey: 'google', title: 'Adversary' } }, 'automation');
  await assertRejects(() => lpv.approveChallenge(adv.challengeId, undefined), 'blind approve WITHOUT a decision token refused', 'approval_invalid');
  await assertRejects(() => lpv.approveChallenge(adv.challengeId, 'forged-token-value-000'), 'forged decision token refused', 'approval_invalid');
  const decoy = lpv.createChallenge('save', { entryDraft: { categoryKey: 'google', title: 'Decoy' } }, 'automation');
  await assertRejects(
    () => lpv.approveChallenge(adv.challengeId, tokenFor(decoy.challengeId)),
    'cross-challenge token substitution refused',
    'approval_invalid'
  );
  const advToken = tokenFor(adv.challengeId);
  lpv.declineChallenge(adv.challengeId, advToken);
  await assertRejects(
    () => lpv.approveChallenge(adv.challengeId, advToken),
    'approval after decline refused (challenge consumed by the decline)',
    'approval_invalid'
  );
  lpv.declineChallenge(decoy.challengeId, tokenFor(decoy.challengeId));
}

// ===========================================================================
section('G. Fill grants — lifecycle (browser path refuses safely here)');
// ===========================================================================

// ===========================================================================
section('G. Fill grants — lifecycle (browser path refuses safely here)');
// ===========================================================================
{
  await assertRejects(() => lpv.requestUiFill(robloxId), 'fill on entry without destination refused', 'no_destination');

  const withUrl = lpv.addEntry({ categoryKey: 'roblox', title: 'Synth Fill', username: SYN_USER, password: SYN_PASS, url: 'http://127.0.0.1:9/login' }, { kind: 'policy-auto' }, 'test');
  const g = lpv.requestUiFill(withUrl.entry.id);
  assert(typeof g.grantId === 'string' && g.grantId.startsWith('lpg_'), 'UI fill issues a bound grant');
  assert(g.origin === 'http://127.0.0.1:9', 'grant origin = entry destination origin');

  await assertRejects(() => lpv.fillEntry({ grantId: 'lpg_bogus', fields: [{ secret: 'password', match: 'password' }] }, 'test'), 'bogus grant refused', 'grant_invalid');

  // Grant expiry via the injectable clock (no real sleeps). The sweep
  // removes expired grants, so the observable kind is grant_invalid.
  lpv._lpvTestHooks.setNow(() => Date.now() + 61_000);
  await assertRejects(() => lpv.fillEntry({ grantId: g.grantId, fields: [{ secret: 'password', match: 'password' }] }, 'test'), 'expired grant (>60 s) refused', 'grant_invalid');
  lpv._lpvTestHooks.setNow(() => Date.now());

  // Grant bound to one entry cannot be reused; each fill consumes it first.
  const g2 = lpv.requestUiFill(withUrl.entry.id);
  await assertRejects(() => lpv.fillEntry({ grantId: g2.grantId, fields: [{ secret: 'password', match: 'password' }] }, 'test'), 'fill against a non-matching page fails safely (grant consumed)', '');
  await assertRejects(() => lpv.fillEntry({ grantId: g2.grantId, fields: [{ secret: 'password', match: 'password' }] }, 'test'), 'second use of the SAME grant refused (single-use)', 'grant_invalid');
  lpv.deleteEntry(withUrl.entry.id, 'test');
}

// ===========================================================================
section('H. Auto-lock + in-flight deferral (injectable clock, deterministic)');
// ===========================================================================
{
  const policy = lpv.getPolicy().policy!;
  // Stale activity → auto-lock.
  lpv._lpvTestHooks.setNow(() => Date.now() + policy.autoLockMs + 1000);
  lpv._lpvTestHooks.evaluateAutoLock();
  assert(lpv._lpvTestHooks.state() === 'LOCKED', 'auto-lock fires after the idle window (stale activity)');
  await lpv.unlockVault();

  // Fresh authorized activity → no auto-lock.
  const t0 = Date.now();
  lpv._lpvTestHooks.setNow(() => t0);
  lpv.addEntry({ categoryKey: 'roblox', title: 'Synth Activity', password: SYN_PASS }, { kind: 'policy-auto' }, 'test');
  lpv._lpvTestHooks.setNow(() => t0 + 1000);
  lpv._lpvTestHooks.evaluateAutoLock();
  assert(lpv._lpvTestHooks.state() === 'UNLOCKED', 'recent authorized activity prevents auto-lock');
  lpv.deleteEntry(lpv.listEntries().entries.find((e) => e.title === 'Synth Activity')!.id, 'test');

  // In-flight fill defers auto-lock (fillEntry increments fillsInFlight
  // synchronously, before its first await).
  const fillTarget = lpv.addEntry({ categoryKey: 'roblox', title: 'Synth InFlight', username: SYN_USER, password: SYN_PASS, url: 'http://127.0.0.1:9/x' }, { kind: 'policy-auto' }, 'test');
  const grant = lpv.requestUiFill(fillTarget.entry.id);
  const fillPromise = lpv.fillEntry({ grantId: grant.grantId, fields: [{ secret: 'password', match: 'password' }] }, 'test');
  fillPromise.catch(() => undefined); // no unhandled-rejection crash before we await it below
  lpv._lpvTestHooks.setNow(() => Date.now() + policy.autoLockMs + 5000);
  lpv._lpvTestHooks.evaluateAutoLock();
  assert(lpv._lpvTestHooks.state() === 'UNLOCKED', 'in-flight fill defers auto-lock');
  await assertRejects(() => fillPromise, 'in-flight fill then fails safely (origin mismatch on blank page)', '');
  lpv._lpvTestHooks.setNow(() => Date.now());
  lpv.deleteEntry(fillTarget.entry.id, 'test');

  // Re-arm: stale again → lock.
  lpv._lpvTestHooks.setNow(() => Date.now() + policy.autoLockMs + 1000);
  lpv._lpvTestHooks.evaluateAutoLock();
  assert(lpv._lpvTestHooks.state() === 'LOCKED', 'auto-lock re-arms after stale activity');
  lpv._lpvTestHooks.setNow(() => Date.now());
  await lpv.unlockVault();
}

// ===========================================================================
section('I. Tamper / corruption — always fail-closed, never auto-recreated');
// ===========================================================================
{
  // I1: plaintext-metadata tamper while locked → MAC failure at unlock.
  await lpv.unlockVault();
  const meta = lpv.addEntry({ categoryKey: 'roblox', title: 'Synth Tamper', password: SYN_PASS }, { kind: 'policy-auto' }, 'test');
  lpv.lockVault('test');
  const parsed = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
  parsed.entries[0].title = 'Tampered Title';
  fs.writeFileSync(VAULT_FILE, JSON.stringify(parsed, null, 2));
  const tamperedBytes = fs.readFileSync(VAULT_FILE, 'utf8');
  await assertRejects(() => lpv.unlockVault(), 'MAC catches plaintext-metadata tamper at unlock', 'vault_tampered');
  assert(lpv._lpvTestHooks.state() === 'TAMPERED', 'vault enters TAMPERED state');
  assert(lpv._lpvTestHooks.noKeyMaterialResident(), 'key material zeroed on tamper detection');
  assert(fs.readFileSync(VAULT_FILE, 'utf8') === tamperedBytes, 'tampered file NEVER silently rewritten/recreated');

  // I2: operator restore — MAC-verified backup returns the pre-tamper generation.
  const restored = await lpv.restoreFromBackup();
  assert(restored.restored === true, 'restore from MAC-verified backup succeeds');
  assert(lpv._lpvTestHooks.state() === 'LOCKED', 'restored vault is locked');
  await lpv.unlockVault();
  const list = lpv.listEntries();
  assert(!list.entries.some((e) => e.id === meta.entry.id), 'restore returns the pre-tamper generation (post-backup entry absent)');

  // I3: generation inconsistency (backup NEWER than primary, both MAC-valid) → TAMPERED.
  const swapEntry = lpv.addEntry({ categoryKey: 'roblox', title: 'Synth Swap', password: SYN_PASS }, { kind: 'policy-auto' }, 'test');
  lpv.lockVault('test');
  const pRaw = fs.readFileSync(VAULT_FILE, 'utf8');
  const bRaw = fs.readFileSync(VAULT_BAK, 'utf8');
  assert(JSON.parse(bRaw).generation < JSON.parse(pRaw).generation, 'backup is older before the swap');
  fs.writeFileSync(VAULT_FILE, bRaw);
  fs.writeFileSync(VAULT_BAK, pRaw);
  await assertRejects(() => lpv.unlockVault(), 'generation inconsistency (bak newer) → TAMPERED', 'vault_tampered');
  await lpv.restoreFromBackup();
  await lpv.unlockVault();
  assert(lpv.listEntries().entries.some((e) => e.id === swapEntry.entry.id), 'restore of the newer MAC-valid generation succeeds');
  lpv.deleteEntry(swapEntry.entry.id, 'test');
  validVaultRaw = fs.readFileSync(VAULT_FILE, 'utf8');
  lpv.lockVault('pre-bootcheck');
}

// ===========================================================================
section('L. Audit chain + history trust');
// ===========================================================================
{
  const verdict = lpv.verifyLpvAuditChain();
  assert(verdict.ok === true, `audit chain verifies (${verdict.entries} entries)`);
  const hist = lpv.getHistory(200);
  const blob = JSON.stringify(hist);
  assert(!blob.includes(SYN_PASS) && !blob.includes(SYN_USER), 'audit/history never contain credential values');

  // Tamper-evidence: a forged appended record breaks verification; history
  // is served flagged UNTRUSTED (never repaired).
  const rawAudit = fs.readFileSync(AUDIT_FILE, 'utf8');
  fs.writeFileSync(AUDIT_FILE, rawAudit + '{"seq":999,"prevHash":"forged","at":1,"kind":"lpv_forged"}\n');
  const verdict2 = lpv.verifyLpvAuditChain();
  assert(verdict2.ok === false && verdict2.firstBrokenLine !== null, 'appended forged record breaks chain verification (tamper-evident)');
  const hist2 = lpv.getHistory(50);
  assert(hist2.untrusted === true, 'history served flagged UNTRUSTED after chain break');

  // Chain loss → honest empty verdict; next append writes an explicit marker.
  fs.rmSync(lpvDir, { recursive: true, force: true });
  const verdict3 = lpv.verifyLpvAuditChain();
  assert(verdict3.ok === true && verdict3.entries === 0, 'no audit file — honest empty verdict (not a fake pass)');
  assert(lpv.getHistory(10).untrusted === false, 'history of an empty chain is served as trusted-empty');
}

// ===========================================================================
section('J. Boot-time tamper detection + restart recovery (child processes)');
// ===========================================================================
{
  const childScript = path.join(tmp, 'lpv-child.mts');
  fs.writeFileSync(
    childScript,
    `process.env.KRISHA_FS_ROOTS = process.env.LPV_TEST_FS_ROOTS;
process.env.KRISHA_SANDBOX_DIR = process.env.LPV_TEST_STORE;
const lpv = await import(${JSON.stringify(LPV_CORE_TS)});
const mode = process.env.LPV_TEST_MODE;
if (mode === 'bootcheck') {
  // Store was damaged out-of-band before this process started.
  const s = lpv.getVaultStatus();
  if (s.state !== 'TAMPERED') { console.error('BOOTCHECK-FAIL state=' + s.state); process.exit(1); }
  console.log('BOOTCHECK-OK'); process.exit(0);
}
if (mode === 'create') {
  if (lpv.getVaultStatus().state !== 'UNINITIALIZED') { console.error('CHILD-FAIL not fresh'); process.exit(1); }
  await lpv.initializeVault();
  await lpv.unlockVault();
  lpv.addEntry({ categoryKey: 'roblox', title: 'Synth Restart', username: 'syn-user@example.test', password: 'S0ynth-Passw0rd-Core!' }, { kind: 'user-direct' }, 'test');
  lpv.lockVault('pre-restart');
  console.log('CREATE-OK'); process.exit(0);
}
if (mode === 'restart') {
  const s = lpv.getVaultStatus();
  if (s.state !== 'LOCKED') { console.error('RESTART-FAIL state=' + s.state); process.exit(1); }
  await lpv.unlockVault();
  const entries = lpv.listEntries();
  if (entries.entries.length !== 1 || entries.entries[0].title !== 'Synth Restart' || entries.verified !== true) {
    console.error('RESTART-FAIL entries=' + JSON.stringify(entries.entries.map((e) => e.title))); process.exit(1);
  }
  console.log('RESTART-OK'); process.exit(0);
}
console.error('unknown mode'); process.exit(1);
`
  );

  // J1/J2 — boot-time detection of a damaged store (child = fresh module
  // load). L destroyed this store, so the fixtures are rebuilt explicitly:
  // J1: unparseable vault.json (with key + account present).
  fs.mkdirSync(lpvDir, { recursive: true });
  fs.writeFileSync(KEY_FILE, 'placeholder-dpapi-blob');
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify({ schemaVersion: 1, sid: 'S-1-5-PLACEHOLDER' }));
  fs.writeFileSync(VAULT_FILE, '{ this is not json');
  const j1 = await runChild(childScript, { ...process.env, LPV_TEST_FS_ROOTS: fsRoots, LPV_TEST_STORE: storeDir, LPV_TEST_MODE: 'bootcheck' });
  assert(j1.code === 0 && j1.out.includes('BOOTCHECK-OK'), 'boot: unparseable vault.json → TAMPERED (never silently recreated)');
  // J2: valid vault.json but key.blob missing (incomplete store).
  fs.writeFileSync(VAULT_FILE, validVaultRaw || JSON.stringify({ schemaVersion: 1, generation: 1, entries: [], policy: { autoSaveEnabled: false, autoSaveCategories: {}, autoLockMs: 300000 }, updatedAt: Date.now(), mac: '0'.repeat(64) }));
  fs.unlinkSync(KEY_FILE);
  const j2 = await runChild(childScript, { ...process.env, LPV_TEST_FS_ROOTS: fsRoots, LPV_TEST_STORE: storeDir, LPV_TEST_MODE: 'bootcheck' });
  assert(j2.code === 0 && j2.out.includes('BOOTCHECK-OK'), 'boot: key.blob missing (incomplete store) → TAMPERED (fail-closed)');

  // J3/J4 — restart recovery on a healthy second store.
  const store2 = path.join(tmp, 'e5store-restart');
  const baseEnv = { ...process.env, LPV_TEST_FS_ROOTS: fsRoots, LPV_TEST_STORE: store2 };
  const c1 = await runChild(childScript, { ...baseEnv, LPV_TEST_MODE: 'create' });
  assert(c1.code === 0 && c1.out.includes('CREATE-OK'), `restart prep: vault created + locked in child store (${c1.out.trim().slice(-120)})`);
  const c2 = await runChild(childScript, { ...baseEnv, LPV_TEST_MODE: 'restart' });
  assert(c2.code === 0 && c2.out.includes('RESTART-OK'), 'restart: fresh process boots LOCKED, unlocks, MAC-verifies, reads the entry');
}

// ===========================================================================
section('K. Degraded mode — unlock/creation refused, listing readable');
// ===========================================================================
{
  const fakeHome = path.join(tmp, 'fakehome');
  const fakeStore = path.join(fakeHome, 'AppData', 'Local', 'Krisha', 'sandbox');
  const brokenProgramData = path.join(tmp, 'pd-blocker.txt');
  fs.writeFileSync(brokenProgramData, 'this file exists so mkdirSync(ProgramData) fails');
  const childScript = path.join(tmp, 'lpv-degraded.mts');
  fs.writeFileSync(
    childScript,
    `process.env.KRISHA_FS_ROOTS = process.env.LPV_TEST_FS_ROOTS;
const mode = process.env.LPV_TEST_MODE;
if (mode === 'create') {
  process.env.KRISHA_SANDBOX_DIR = process.env.LPV_TEST_STORE; // FULL protection (normal ProgramData)
} else {
  // Degraded: ProgramData uncreatable + KRISHA_SANDBOX_DIR unset → the
  // LOCALAPPDATA fallback (fake home) is used WITH the degraded flag.
  process.env.ProgramData = process.env.LPV_TEST_PD_BLOCKER;
  process.env.USERPROFILE = process.env.LPV_TEST_FAKE_HOME;
  delete process.env.KRISHA_SANDBOX_DIR;
}
const lpv = await import(${JSON.stringify(LPV_CORE_TS)});
if (mode === 'create') {
  if (lpv.getVaultStatus().state !== 'UNINITIALIZED' || lpv.getVaultStatus().protection !== 'full') { console.error('DEG-PREP-FAIL ' + lpv.getVaultStatus().state + '/' + lpv.getVaultStatus().protection); process.exit(1); }
  await lpv.initializeVault();
  await lpv.unlockVault();
  lpv.lockVault('prep');
  console.log('DEG-PREP-OK'); process.exit(0);
}
const s = lpv.getVaultStatus();
if (s.protection !== 'degraded') { console.error('DEGRADED-FAIL protection=' + s.protection); process.exit(1); }
if (s.state !== 'LOCKED') { console.error('DEGRADED-FAIL state=' + s.state); process.exit(1); }
try { await lpv.unlockVault(); console.error('DEGRADED-FAIL unlock succeeded'); process.exit(1); } catch (err) {
  if (err.kind !== 'degraded_mode') { console.error('DEGRADED-FAIL wrong kind=' + err.kind); process.exit(1); }
}
try { await lpv.initializeVault(); console.error('DEGRADED-FAIL init succeeded'); process.exit(1); } catch (err) {
  // Degraded check runs BEFORE the already-exists check by design.
  if (err.kind !== 'degraded_mode') { console.error('DEGRADED-FAIL wrong init kind=' + err.kind); process.exit(1); }
}
const listed = lpv.listEntries();
if (listed.tampered || listed.entries.length !== 0) { console.error('DEGRADED-FAIL listing=' + JSON.stringify(listed)); process.exit(1); }
console.log('DEGRADED-OK'); process.exit(0);
`
  );
  const c1 = await runChild(childScript, {
    ...process.env,
    LPV_TEST_FS_ROOTS: fsRoots,
    LPV_TEST_STORE: fakeStore,
    LPV_TEST_MODE: 'create',
  });
  assert(c1.code === 0 && c1.out.includes('DEG-PREP-OK'), `degraded prep: vault created under FULL protection at the fallback path (${c1.out.trim().slice(-120)})`);

  const c2 = await runChild(childScript, {
    ...process.env,
    LPV_TEST_FS_ROOTS: fsRoots,
    LPV_TEST_PD_BLOCKER: brokenProgramData,
    LPV_TEST_FAKE_HOME: fakeHome,
    LPV_TEST_MODE: 'degraded',
  });
  assert(c2.code === 0 && c2.out.includes('DEGRADED-OK'), `degraded mode: unlock refused (degraded_mode), listing readable (${c2.out.trim().slice(-160)})`);
}

// ===========================================================================
// Summary
// ===========================================================================
// Hygiene: stop the CDP browser the fill attempts may have launched.
try {
  const cdp = await import('../browserCdp');
  await cdp.browserStop();
} catch {
  /* not launched */
}
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failures.length > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
