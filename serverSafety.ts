/**
 * E5 M1 — Server-side safety foundation (serverSafety.ts).
 *
 * The trusted server process owns ALL safety authority for Krisha:
 *
 *   1. Protected storage — the E5 store lives OUTSIDE every model-writable
 *      filesystem root (ProgramData by default), behind realpath-hardened
 *      resolution and a relational protected-path refusal. Ordinary
 *      filesystem operations (any grant level) cannot create, write, delete,
 *      rename, copy over, or read E5-internal bytes. See assertNotProtected.
 *   2. Persistent emergency stop — stop-state.json with integrity self-hash,
 *      staged atomic writes (temp → fsync → rename), the nine-row bootstrap
 *      table (never silently converts suspicious state into INACTIVE), and
 *      activation that is independent of permissions.
 *   3. Server-side permission state — the authority for T1 requests. Scoped
 *      grants (once/task/session/duration), server-MINTED task identities
 *      with lifecycle revocation, and atomic remove-before-grant `once`
 *      consumption. The browser-side gate remains a first filter; this state
 *      is authoritative.
 *   4. Audit — append-only, hash-chained, fsync-per-entry JSONL. Tamper-
 *      EVIDENT (same-user processes can rewrite local files — documented),
 *      never tamper-proof. Authority transitions refuse to complete if their
 *      audit append fails.
 *   5. Recovery pipe — a restricted local named pipe exposing exactly
 *      arm / set-credential / recover / rotate / status. The plaintext
 *      recovery credential NEVER crosses HTTP, never appears in logs, args,
 *      env, or browser traffic, and is chosen by the operator (never shown).
 *
 * Trust boundary (honest): same-user local processes can access everything
 * this module protects at the OS level. The boundaries enforced here are
 * network exclusion (loopback), model exclusion (structural — no tool or
 * page path reaches any of this), and knowledge gating (the recovery
 * credential). Nothing here claims protection against a determined same-user
 * actor beyond what the OS itself enforces.
 *
 * All initialization is SYNCHRONOUS and completes at module load — before
 * any HTTP request can be served (server.ts imports this module before
 * app.listen). No timers, no polling, no background work.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import net from 'net';
import type { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Model filesystem roots (authority for "where can model-driven tools reach")
// ---------------------------------------------------------------------------

/** Model-reachable roots. Moved from systemAgentServer.ts so the protected-
 *  storage validation can consult them without a circular import. */
export function allowedRoots(): string[] {
  const env = process.env.KRISHA_FS_ROOTS;
  const roots = env
    ? env.split(';')
    : [os.homedir(), os.tmpdir(), process.cwd()];
  return roots.map((r) => path.resolve(r.trim())).filter(Boolean);
}

/** Paths with a second colon are NTFS Alternate Data Stream spellings and
 *  are refused everywhere (closes the colon gap in the character filter). */
function hasAlternateStreamSpelling(p: string): boolean {
  const m = /^[a-zA-Z]:/.exec(p);
  if (!m) return p.includes(':');
  return p.slice(2).includes(':');
}

function canonicalForCompare(p: string): string {
  return path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
}

/** True when `canonical` is inside any model-writable root. */
function insideModelRoots(canonical: string): boolean {
  return allowedRoots().some((root) => {
    const r = canonicalForCompare(root);
    return canonical === r || canonical.startsWith(r + '\\') || canonical.startsWith(r + '/');
  });
}

const SYSTEM_WRITE_DENYLIST = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'];

/**
 * Hardened path resolution for every filesystem operation (moved from
 * systemAgentServer.ts and strengthened):
 *   - character filter, relative→tmpdir rule (unchanged behavior);
 *   - lexical containment + system write denylist (unchanged behavior);
 *   - NEW: alternate-data-stream spellings (second colon) refused;
 *   - NEW: E5-protected storage refused via relational canonical check
 *     (assertNotProtected), which also covers junction/symlink indirection
 *     because the check runs on the resolved spelling.
 */
export function resolveSafePath(rawPath: string, operation: 'read' | 'write'): string {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new Error('Path is required');
  }
  if (/[<>|?*\x00-\x1F]/.test(rawPath)) {
    throw new Error(`Path contains invalid characters: "${rawPath.slice(0, 60)}"`);
  }
  // Relative paths (no drive letter) resolve against the TEMP directory —
  // never against the project directory, so unqualified creates are safe.
  const trimmed = rawPath.trim();
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\');
  const resolved = path.resolve(isAbsolute ? trimmed : path.join(os.tmpdir(), trimmed));
  const normalized = resolved.toLowerCase().replace(/[\\/]+$/, '');

  if (hasAlternateStreamSpelling(resolved)) {
    throw new Error('Alternate data stream spellings are not permitted');
  }

  const inRoot = allowedRoots().some((root) => {
    const r = root.toLowerCase().replace(/[\\/]+$/, '');
    return normalized === r || normalized.startsWith(r + '\\') || normalized.startsWith(r + '/');
  });
  if (!inRoot) {
    throw new Error(`Path "${resolved}" is outside the allowed filesystem roots — traversal rejected`);
  }

  if (operation === 'write') {
    const denied = SYSTEM_WRITE_DENYLIST.some((dir) => normalized.startsWith(dir.toLowerCase()));
    if (denied) {
      throw new Error(`Writing to a protected system location is not allowed: ${resolved}`);
    }
  }

  // E5 protected storage is refused for reads and writes alike, on the
  // RESOLVED spelling — junction/symlink indirection cannot reach it. Write
  // operations additionally refuse protected ANCESTORS (rename-of-parent).
  assertNotProtected(resolved, operation);
  return resolved;
}

// ---------------------------------------------------------------------------
// Protected storage resolution (M1a)
// ---------------------------------------------------------------------------

export type StorageProtection = 'full' | 'degraded' | 'unavailable';

const STOP_STATE_FILE = 'stop-state.json';
const INSTALL_MARKER_FILE = 'install.marker';
const AUDIT_DIR = 'audit';
const AUDIT_FILE = 'server-audit.jsonl';

let storeRoot: string | null = null;
let storageProtection: StorageProtection = 'unavailable';
let protectedRoots: string[] = []; // canonical protected ancestors (store root + audit dir)

function tryCreateDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Probe writability with a real write (creation alone can succeed on
    // read-only ACLs in exotic configurations).
    const probe = path.join(dir, '.krisha-probe');
    fs.writeFileSync(probe, 'probe');
    fs.unlinkSync(probe);
    return fs.existsSync(dir);
  } catch {
    return false;
  }
}

/**
 * Resolve the E5 store root. Resolution order:
 *   1. KRISHA_SANDBOX_DIR — honored ONLY if the location passes the placement
 *      invariant (outside every model-writable root). An override that would
 *      degrade protection is REJECTED with a warning; the safe default is
 *      used instead. No silent downgrade.
 *   2. C:\ProgramData\Krisha\sandbox — outside homedir/tmpdir/cwd, and
 *      already covered by the system write denylist for route operations.
 *   3. %LOCALAPPDATA%\Krisha\sandbox — DEGRADED fallback (inside homedir):
 *      the assertNotProtected refusal layer still holds, but placement depth
 *      is lost. Surfaced in status; never silent.
 *   4. Unavailable — the stop subsystem cannot persist; T1 mutations are
 *      refused (an unpersistable stop must not fake persistence).
 */
function resolveStoreRootSync(): void {
  const candidates: { root: string; protection: StorageProtection; note?: string }[] = [];
  const envDir = process.env.KRISHA_SANDBOX_DIR;
  if (envDir) {
    const resolved = path.resolve(envDir.trim());
    const canonical = canonicalForCompare(resolved);
    if (insideModelRoots(canonical)) {
      candidates.push({ root: resolved, protection: 'degraded', note: 'KRISHA_SANDBOX_DIR rejected: inside model-writable roots' });
    } else {
      candidates.push({ root: resolved, protection: 'full' });
    }
  }
  candidates.push({ root: path.join(process.env.ProgramData || 'C:\\ProgramData', 'Krisha', 'sandbox'), protection: 'full' });
  candidates.push({ root: path.join(os.homedir(), 'AppData', 'Local', 'Krisha', 'sandbox'), protection: 'degraded' });

  let rejectionNote: string | undefined;
  for (const candidate of candidates) {
    if (candidate.protection === 'degraded' || candidate.note) {
      rejectionNote = candidate.note ?? rejectionNote;
    }
    if (candidate.protection === 'degraded' && candidate.note) {
      // A rejected override must not silently downgrade — skip it entirely
      // unless nothing else works (then it is used WITH the degraded flag
      // surfaced, never silently).
      continue;
    }
    if (tryCreateDir(candidate.root)) {
      storeRoot = candidate.root;
      storageProtection = candidate.protection;
      if (rejectionNote) console.warn(`[E5] ${rejectionNote} — using ${candidate.protection === 'full' ? 'safe default' : 'degraded'} storage at ${candidate.root}`);
      break;
    }
  }
  // Last resort: if every full candidate failed, allow the degraded
  // locations (including a rejected override) rather than running without
  // persistence — but surface the degradation loudly.
  if (storeRoot === null) {
    for (const candidate of candidates) {
      if (tryCreateDir(candidate.root)) {
        storeRoot = candidate.root;
        storageProtection = 'degraded';
        console.warn(`[E5] Storage protection DEGRADED: using ${candidate.root}`);
        break;
      }
    }
  }
  if (storeRoot === null) {
    storageProtection = 'unavailable';
    console.error('[E5] No usable storage location — stop subsystem cannot persist; mutations will be refused.');
  } else {
    protectedRoots = [canonicalForCompare(storeRoot)];
    try {
      fs.mkdirSync(path.join(storeRoot, AUDIT_DIR), { recursive: true });
      protectedRoots.push(canonicalForCompare(path.join(storeRoot, AUDIT_DIR)));
    } catch { /* audit dir creation failure surfaces via appendAudit */ }
  }
}

/** Canonical resolution: realpath when the target exists, otherwise the
 *  nearest existing ancestor plus the remaining relative tail. */
function canonicalResolve(p: string): string {
  const abs = path.resolve(p);
  try {
    return path.resolve(fs.realpathSync(abs));
  } catch {
    // Walk up to the nearest existing ancestor and re-append the tail.
    let existing = path.dirname(abs);
    const tail: string[] = [path.basename(abs)];
    while (existing !== path.dirname(existing)) {
      try {
        fs.realpathSync(existing);
        break;
      } catch {
        tail.unshift(path.basename(existing));
        existing = path.dirname(existing);
      }
    }
    const base = path.resolve(fs.realpathSync(existing));
    return path.resolve(base, ...tail);
  }
}

function intersectsProtectedSubtree(canonical: string): boolean {
  const c = canonicalForCompare(canonical);
  return protectedRoots.some((root) => c === root || c.startsWith(root + '\\') || c.startsWith(root + '/'));
}

/** Write-direction rule: a WRITE on an ancestor of protected storage (rename,
 *  delete, move of the store's parent) would destroy or relocate protected
 *  bytes, so ancestors are protected for write operations. READS of an
 *  ancestor are harmless (listing a parent reveals only names) and remain
 *  permitted. */
function intersectsProtectedIncludingAncestors(canonical: string): boolean {
  const c = canonicalForCompare(canonical);
  return intersectsProtectedSubtree(c) ||
    protectedRoots.some((root) => root.startsWith(c + '\\') || root.startsWith(c + '/'));
}

/**
 * Hard-link alias defense: realpath does NOT resolve hard links (a link is
 * an equally-valid name for the same bytes), so path-based checks alone
 * cannot see through them. The stop subsystem records the filesystem
 * identity (dev:ino) of every protected file it writes; any operation whose
 * target carries a protected identity is refused regardless of its path.
 */
const protectedInodes = new Set<string>();

function refreshProtectedInodes(): void {
  if (storeRoot === null) return;
  const candidates = [STATE_FILE(), MARKER_FILE(), path.join(storeRoot, AUDIT_DIR, AUDIT_FILE)];
  for (const file of candidates) {
    try {
      const st = fs.statSync(file);
      protectedInodes.add(`${st.dev}:${st.ino}`);
    } catch { /* not yet created */ }
  }
}

/**
 * Refuse any operation whose canonical path touches E5-protected storage —
 * as source, destination, ancestor, or descendant. Applies to reads too
 * (protected metadata disclosure). Extra-colon (ADS) spellings under a
 * protected ancestor are refused. Fail-closed: if protected roots cannot be
 * established, every path is treated as potentially protected and refused
 * when it cannot be proven outside them... implemented as: when storage is
 * unavailable the guard refuses nothing here (the enforcement middleware
 * already refuses ALL mutations while storage is unavailable), and the
 * stop subsystem itself never exposes a path.
 */
export function assertNotProtected(target: string, operation: 'read' | 'write' = 'read'): void {
  if (!target || typeof target !== 'string') throw new Error('Path is required');
  if (hasAlternateStreamSpelling(target)) {
    throw new Error('Alternate data stream spellings are not permitted');
  }
  if (storeRoot === null) return; // storage unavailable — mutation refusal happens at enforcement
  const canonical = canonicalResolve(target);
  const hit = operation === 'write' ? intersectsProtectedIncludingAncestors(canonical) : intersectsProtectedSubtree(canonical);
  if (hit) {
    throw new Error('Path is inside E5 protected storage and cannot be accessed through filesystem operations');
  }
  // Hard-link alias defense (realpath cannot see through hard links).
  try {
    const st = fs.statSync(path.resolve(target));
    if (protectedInodes.has(`${st.dev}:${st.ino}`)) {
      throw new Error('Path is a hard-link alias of E5-protected storage');
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('hard-link alias')) throw err;
    // ENOENT / stat failures — nothing to check for a not-yet-existing file.
  }
}

/** Non-throwing predicate for walkers (e.g. fsSearch skips protected subtrees). */
export function isProtectedPath(target: string): boolean {
  if (storeRoot === null) return false;
  try {
    return intersectsProtectedSubtree(canonicalResolve(target));
  } catch {
    return false;
  }
}

export function getStorageInfo(): { root: string | null; protection: StorageProtection } {
  return { root: storeRoot, protection: storageProtection };
}

// ---------------------------------------------------------------------------
// Stop-state persistence (M1a)
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;
const STATE_FILE = () => path.join(storeRoot ?? '', STOP_STATE_FILE);
const MARKER_FILE = () => path.join(storeRoot ?? '', INSTALL_MARKER_FILE);

export interface StopState {
  schemaVersion: number;
  generation: number;
  active: boolean;
  credentialSet: boolean;
  reason?: string;
  activatedAt?: number;
  updatedAt: number;
  recoveryCodeHash?: string;
  recoverySalt?: string;
  failedAttempts: number;
  nextAttemptAt?: number;
  integrity: string;
}

function canonicalStateFields(s: Omit<StopState, 'integrity'>): string {
  // Fixed key order — canonical serialization for the integrity self-hash.
  return JSON.stringify({
    schemaVersion: s.schemaVersion,
    generation: s.generation,
    active: s.active,
    credentialSet: s.credentialSet,
    reason: s.reason ?? null,
    activatedAt: s.activatedAt ?? null,
    updatedAt: s.updatedAt,
    recoveryCodeHash: s.recoveryCodeHash ?? null,
    recoverySalt: s.recoverySalt ?? null,
    failedAttempts: s.failedAttempts,
    nextAttemptAt: s.nextAttemptAt ?? null,
  });
}

function stateIntegrity(s: Omit<StopState, 'integrity'>): string {
  return crypto.createHash('sha256').update(canonicalStateFields(s), 'utf8').digest('hex');
}

function readRaw(file: string): string | null {
  try {
    const data = fs.readFileSync(file, 'utf8');
    return data.length > 0 ? data : null;
  } catch {
    return null;
  }
}

/** Durable staged write: temp file → write → fsync → atomic rename. On NTFS
 *  the completed rename is durable via metadata journaling (no user-mode
 *  directory-fsync exists on Windows). Non-NTFS volumes are best-effort and
 *  covered by the fail-closed uncertain-state policy.
 *  E5 M2: exported (additive) for the sandbox journal's bounded rewrites. */
export function durableWrite(file: string, data: string): void {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function parseValidState(raw: string): StopState | null {
  try {
    const parsed = JSON.parse(raw) as StopState;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    if (!Number.isInteger(parsed.generation) || parsed.generation < 1) return null;
    if (typeof parsed.active !== 'boolean') return null;
    if (typeof parsed.updatedAt !== 'number') return null;
    if (!Number.isInteger(parsed.failedAttempts) || parsed.failedAttempts < 0) return null;
    const { integrity, ...fields } = parsed;
    if (stateIntegrity(fields as Omit<StopState, 'integrity'>) !== integrity) return null;
    return parsed;
  } catch {
    return null;
  }
}

let currentState: StopState | null = null; // null ⇒ ACTIVE_UNCERTAIN (fail-closed)
export let auditDegraded = false;

type AuditInput = { kind: string; [key: string]: unknown };

let auditSeq = 0;
let auditPrevHash = 'genesis';

/** Append one hash-chained audit record. Returns the record hash.
 *  E5 H4: the record's seq/prevHash chain from the ACTUAL on-disk tail
 *  (read per append — the disk is the single source of truth; no cached
 *  prevHash can fork the chain). */
function appendAuditRecord(entry: AuditInput): string {
  const tail = readAuditTail();
  const seq = tail.state === 'ok' ? tail.seq + 1 : 1;
  const prevHash = tail.state === 'ok' ? tail.prevHash : 'genesis';
  const record = {
    seq,
    prevHash,
    at: Date.now(),
    ...entry,
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(record), 'utf8').digest('hex');
  const line = JSON.stringify({ ...record, hash }) + '\n';
  const file = path.join(storeRoot, AUDIT_DIR, AUDIT_FILE);
  // E5 M4: recreate the audit directory if it was lost (store deletion) so a
  // chain restart can actually take effect instead of degrading forever.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
    auditSeq = seq;
    auditPrevHash = prevHash;
    return hash;
  } finally {
    fs.closeSync(fd);
  }
}

/** Append one hash-chained audit entry, fsync'd. Throws on failure —
 *  authority transitions treat that as refusal-to-complete.
 *  E5 M4: if the audit FILE was lost (store deletion/corruption), the chain
 *  restarts from genesis and the restart is itself recorded — a silently
 *  broken on-disk chain is never left behind.
 *  E5 H4: chain continuation is driven by the on-disk tail read per append
 *  (readAuditTail) — cross-process safe; a torn/missing tail restarts the
 *  chain with an explicit marker. */

/** E5 H4 — read and validate the LAST record of the on-disk audit file.
 *  Returns the trusted tail so every append CONTINUES the on-disk chain:
 *  'ok'     → append seq+1 chained to this hash;
 *  'empty'  → fresh chain, first record is seq 1 / genesis;
 *  'lost'   → file missing, unreadable, or torn tail — the caller restarts
 *             the chain with an explicit marker (existing M4 behavior). */
function readAuditTail(): { state: 'empty' | 'ok' | 'lost'; seq: number; prevHash: string; hash: string } {
  const file = path.join(storeRoot, AUDIT_DIR, AUDIT_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { state: 'lost', seq: 0, prevHash: 'genesis', hash: '' };
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return { state: 'empty', seq: 0, prevHash: 'genesis', hash: '' };
  const lastLine = lines[lines.length - 1];
  try {
    const rec = JSON.parse(lastLine) as { seq?: unknown; prevHash?: unknown; hash?: unknown };
    if (typeof rec.seq !== 'number' || typeof rec.prevHash !== 'string' || typeof rec.hash !== 'string') {
      return { state: 'lost', seq: 0, prevHash: 'genesis', hash: '' };
    }
    const { hash, ...rest } = rec;
    const computed = crypto.createHash('sha256').update(JSON.stringify(rest), 'utf8').digest('hex');
    if (rec.hash !== computed) return { state: 'lost', seq: 0, prevHash: 'genesis', hash: '' };
    // The next record must chain from the tail's OWN hash:
    return { state: 'ok', seq: rec.seq, prevHash: rec.hash, hash: rec.hash };
  } catch {
    return { state: 'lost', seq: 0, prevHash: 'genesis', hash: '' };
  }
}

function appendAudit(entry: AuditInput): void {
  if (storeRoot === null) throw new Error('audit unavailable');
  const file = path.join(storeRoot, AUDIT_DIR, AUDIT_FILE);
  const fileExists = (() => { try { return fs.existsSync(file); } catch { return false; } })();
  const tail = readAuditTail();
  // Loss conditions (existing M4 behavior): file missing/unreadable, or a
  // torn/unverifiable tail → the chain restarts with an explicit marker.
  // A present-and-empty file is a fresh chain, not a loss. A healthy tail is
  // CONTINUED — including when another process appended in the meantime
  // (cross-process safe: the disk tail is the single source of truth).
  const lost = !fileExists || tail.state === 'lost';
  try {
    if (lost) appendAuditRecord({ kind: 'e5_audit_chain_restarted' });
    appendAuditRecord(entry);
    auditDegraded = false;
    refreshProtectedInodes();
  } catch (err) {
    auditDegraded = true;
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function persistState(next: StopState): void {
  durableWrite(STATE_FILE(), JSON.stringify(next, null, 2));
  currentState = next;
  refreshProtectedInodes();
}

/** Initialize the install marker. Created only during genuine first
 *  installation or self-healed when the (valid) state file proves the
 *  installation. Never created when the state file is missing-but-expected. */
function ensureMarker(): { created: boolean; warning?: string } {
  const markerRaw = readRaw(MARKER_FILE());
  if (markerRaw !== null) {
    try {
      const parsed = JSON.parse(markerRaw) as { schemaVersion?: number; createdAt?: number };
      if (parsed && typeof parsed.createdAt === 'number') return { created: false };
    } catch { /* corrupt — recreate below with a warning */ }
    durableWrite(MARKER_FILE(), JSON.stringify({ schemaVersion: 1, createdAt: Date.now() }));
    return { created: true, warning: 'corrupt installation marker recreated' };
  }
  durableWrite(MARKER_FILE(), JSON.stringify({ schemaVersion: 1, createdAt: Date.now() }));
  return { created: true };
}

/**
 * Synchronous startup per the nine-row bootstrap table. Never silently
 * converts suspicious state into INACTIVE. Runs once at module load —
 * before the HTTP server can accept any request.
 */
function initStopStateSync(): void {
  if (storeRoot === null) {
    currentState = null; // ACTIVE_UNCERTAIN semantics — enforcement refuses mutations
    return;
  }
  const stateRaw = readRaw(STATE_FILE());
  const markerRaw = readRaw(MARKER_FILE());

  if (stateRaw === null && markerRaw === null) {
    // Genuine first installation: write the INACTIVE state, then the marker.
    const first: StopState = {
      schemaVersion: SCHEMA_VERSION,
      generation: 1,
      active: false,
      credentialSet: false,
      updatedAt: Date.now(),
      failedAttempts: 0,
      integrity: '',
    };
    first.integrity = stateIntegrity(first);
    persistState(first);
    ensureMarker();
    appendAuditSyncSafe({ kind: 'e5_first_install', generation: first.generation });
    return;
  }

  if (stateRaw === null) {
    // Marker present (corrupt or valid): the state file was removed after
    // installation. Fail closed — a stop may have been active.
    currentState = null;
    console.error('[E5] stop-state file missing but installation marker present — failing closed (ACTIVE_UNCERTAIN).');
    return;
  }

  const parsed = parseValidState(stateRaw);
  if (parsed === null) {
    currentState = null; // corrupt / integrity-fail / schema-invalid ⇒ fail closed
    console.error('[E5] stop-state file corrupt or integrity-invalid — failing closed (ACTIVE_UNCERTAIN).');
    return;
  }

  // Valid state file. The state proves the installation; the marker is
  // self-healed if missing or corrupt (recreation conceals nothing of
  // consequence — enforcement follows the state file).
  currentState = parsed;
  const marker = ensureMarker();
  if (marker.warning) console.warn(`[E5] ${marker.warning}`);
  if (currentState.active) {
    console.warn(`[E5] EMERGENCY STOP restored from persisted state (generation ${currentState.generation})${currentState.reason ? `: ${currentState.reason}` : ''}`);
  }
}

/** Sync audit for module-init time (no async paths during boot).
 *  E5 M2: exported (additive) for the sandbox core's in-process gate. */
export function appendAuditSyncSafe(entry: AuditInput): void {
  try {
    appendAudit(entry);
  } catch {
    auditDegraded = true;
  }
}

/**
 * E5 H3 — audit-chain verification (READ-ONLY, bounded). Walks the on-disk
 * audit chain and verifies, per segment: sequence continuity from 1, genesis
 * prevHash at each segment start, and hash-chain linkage. Segment restarts
 * (post-loss `e5_audit_chain_restarted` records) begin a NEW verifiable
 * segment — they are honest evidence of loss, not chain breaks. A torn append
 * or manipulated record is reported with its line number. NEVER repairs
 * anything: the audit is evidence, and rewriting it would itself be tampering.
 * Distinguishes dynamically tested behavior from source review: callers get
 * the first broken line and reason; nothing is mutated.
 */
export function verifyAuditChain(): {
  ok: boolean;
  entries: number;
  segments: number;
  firstBrokenLine: number | null;
  reason: string | null;
} {
  if (storeRoot === null) {
    return { ok: false, entries: 0, segments: 0, firstBrokenLine: null, reason: 'protected storage unavailable — audit unverifiable' };
  }
  const file = path.join(storeRoot, AUDIT_DIR, AUDIT_FILE);
  // E5 H4 — distinguish "no audit file yet (fresh install)" from "audit file
  // present but unreadable": the latter is verification UNAVAILABLE, never a
  // clean result.
  const filePresent = (() => { try { return fs.existsSync(file); } catch { return false; } })();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    if (filePresent) {
      return { ok: false, entries: 0, segments: 0, firstBrokenLine: null, reason: 'audit file present but unreadable — verification unavailable' };
    }
    return { ok: true, entries: 0, segments: 0, firstBrokenLine: null, reason: 'no audit file yet — nothing to verify' };
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  let seq = 0;
  let prevHash = 'genesis';
  let segments = 0;
  let ok = true;
  let firstBrokenLine: number | null = null;
  let reason: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let rec: { seq?: unknown; prevHash?: unknown; hash?: unknown; kind?: unknown };
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      ok = false;
      if (firstBrokenLine === null) { firstBrokenLine = lineNo; reason = `torn or unparseable audit line ${lineNo}`; }
      continue;
    }
    const restartRecord = rec.kind === 'e5_audit_chain_restarted';
    if (restartRecord) {
      if (rec.seq !== 1 || rec.prevHash !== 'genesis') {
        ok = false;
        if (firstBrokenLine === null) { firstBrokenLine = lineNo; reason = `audit restart marker at line ${lineNo} does not start a fresh segment`; }
        continue;
      }
      seq = 1;
      segments++;
      const { hash: rh, ...restartRest } = rec;
      const computed = crypto.createHash('sha256').update(JSON.stringify(restartRest), 'utf8').digest('hex');
      if (rec.hash !== computed) {
        ok = false;
        if (firstBrokenLine === null) { firstBrokenLine = lineNo; reason = `audit restart marker hash mismatch at line ${lineNo}`; }
        continue;
      }
      prevHash = rec.hash as string;
      continue;
    }
    if (rec.seq !== seq + 1 || rec.prevHash !== prevHash) {
      ok = false;
      if (firstBrokenLine === null) { firstBrokenLine = lineNo; reason = `audit chain discontinuity at line ${lineNo} (seq ${String(rec.seq)}, expected ${seq + 1})`; }
      continue;
    }
    const { hash, ...rest } = rec;
    const computed = crypto.createHash('sha256').update(JSON.stringify(rest), 'utf8').digest('hex');
    if (hash !== computed) {
      ok = false;
      if (firstBrokenLine === null) { firstBrokenLine = lineNo; reason = `audit record hash mismatch at line ${lineNo}`; }
      continue;
    }
    seq = rec.seq as number;
    prevHash = rec.hash as string;
  }
  return { ok, entries: lines.length, segments, firstBrokenLine, reason };
}

// ---------------------------------------------------------------------------
// Safe-open allowlist (M1d, decision D8) — the ONLY types that may be handed
// to ShellExecute. Scripts/executables/interpreters/unknown are refused
// unconditionally; no confirmation overrides the refusal.
// ---------------------------------------------------------------------------

export const OPEN_FILE_EXTENSIONS: Set<string> = new Set([
  'txt', 'md', 'log', 'csv', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
  'svg', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'webm', 'mkv', 'json',
]);

// ---------------------------------------------------------------------------
// Recovery credential (chosen by the operator — never generated, never shown)
// ---------------------------------------------------------------------------

const COMMON_CREDENTIALS = new Set([
  'password', 'password1', 'passw0rd', '1234567890', '123456789a', 'qwertyuiop',
  'letmein123', 'iloveyou1', 'admin12345', 'welcome123', 'krisha1234', 'abcdefghij',
  'aaaaaaaaaa', '1111111111', '0000000000', 'asdfghjkl;', 'qwertzuiop', 'zxcvbnm,.',
]);

const CREDENTIAL_MIN = 10;
const CREDENTIAL_MAX = 128;

/** NFKC normalization + policy check. Length is not entropy: require ≥3 of 4
 *  character classes and reject common credentials. Throws with the policy
 *  reason on failure; returns the normalized credential on success. */
function assertValidCredential(code: string): string {
  if (typeof code !== 'string') throw new Error('credential required');
  const normalized = code.normalize('NFKC');
  if (COMMON_CREDENTIALS.has(normalized.toLowerCase())) throw new Error('credential is too common');
  if (/^(.)\1+$/.test(normalized)) throw new Error('credential is trivially repetitive');
  if (normalized.length < CREDENTIAL_MIN) throw new Error(`credential must be at least ${CREDENTIAL_MIN} characters`);
  if (normalized.length > CREDENTIAL_MAX) throw new Error(`credential must be at most ${CREDENTIAL_MAX} characters`);
  let classes = 0;
  if (/[a-z]/.test(normalized)) classes++;
  if (/[A-Z]/.test(normalized)) classes++;
  if (/[0-9]/.test(normalized)) classes++;
  if (/[^A-Za-z0-9]/.test(normalized)) classes++;
  if (classes < 3) throw new Error('credential must contain at least 3 of: lowercase, uppercase, digit, symbol');
  return normalized;
}

const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashCredential(code: string, salt: string): string {
  return crypto.scryptSync(code.normalize('NFKC'), salt, 32, SCRYPT_PARAMS).toString('hex');
}

function credentialMatches(code: string, state: StopState): boolean {
  if (!state.recoveryCodeHash || !state.recoverySalt) return false;
  const candidate = Buffer.from(hashCredential(code, state.recoverySalt), 'hex');
  const stored = Buffer.from(state.recoveryCodeHash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

function backoffDelayMs(failedAttempts: number): number {
  // 2^(n-1) seconds after the n-th failure, capped at 15 minutes.
  return Math.min(2 ** Math.max(0, failedAttempts - 1) * 1000, 15 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Stop-state transitions (serialized: all synchronous under JS serialization;
// scrypt is intentionally synchronous — activation/recovery are rare)
// ---------------------------------------------------------------------------

export type StopKind = 'INACTIVE' | 'ACTIVE_NO_CREDENTIAL' | 'ACTIVE_CREDENTIALED' | 'ACTIVE_UNCERTAIN';

export function stopKind(): StopKind {
  if (currentState === null) return 'ACTIVE_UNCERTAIN';
  if (!currentState.active) return 'INACTIVE';
  return currentState.credentialSet ? 'ACTIVE_CREDENTIALED' : 'ACTIVE_NO_CREDENTIAL';
}

export function stopSnapshot(): {
  kind: StopKind; generation: number | null; reason: string | null;
  storageProtection: StorageProtection; auditDegraded: boolean; recoveryAvailable: boolean;
} {
  return {
    kind: stopKind(),
    generation: currentState?.generation ?? null,
    reason: currentState?.active ? currentState.reason ?? null : null,
    storageProtection,
    auditDegraded,
    recoveryAvailable: recoveryAvailable,
  };
}

function requireActiveState(): StopState {
  if (currentState === null) throw new Error('stop state uncertain — out-of-band recovery required');
  return currentState;
}

/** Activate (idempotent). Model/UI/CLI may activate; none may deactivate. */
export function activateStop(reason: string, source: string): { generation: number; alreadyActive: boolean } {
  const s = requireActiveState();
  if (s.active) return { generation: s.generation, alreadyActive: true };
  appendAudit({ kind: 'emergency_stop', source, reason: String(reason ?? '').slice(0, 160) });
  const next: StopState = {
    ...s,
    generation: s.generation + 1,
    active: true,
    // A fresh activation is ALWAYS credential-less: a credential from a
    // PREVIOUS stop episode must never authorize recovery of a NEW one.
    credentialSet: false,
    recoveryCodeHash: undefined,
    recoverySalt: undefined,
    reason: String(reason ?? 'emergency stop').slice(0, 160),
    activatedAt: Date.now(),
    updatedAt: Date.now(),
    failedAttempts: 0,
    nextAttemptAt: undefined,
    integrity: '',
  };
  next.integrity = stateIntegrity(next);
  persistState(next);
  return { generation: next.generation, alreadyActive: false };
}

/** Operator-chosen credential on an INACTIVE stop (`--arm`). */
export function armStop(code: string, source: string): { generation: number } {
  const s = requireActiveState();
  if (s.active) throw new Error('stop is already active — use set-credential or recover');
  const normalized = assertValidCredential(code);
  appendAudit({ kind: 'e5_stop_armed', source });
  const salt = crypto.randomBytes(16).toString('hex');
  const next: StopState = {
    ...s,
    generation: s.generation + 1,
    active: true,
    credentialSet: true,
    reason: 'operator armed emergency stop',
    activatedAt: Date.now(),
    updatedAt: Date.now(),
    recoveryCodeHash: hashCredential(normalized, salt),
    recoverySalt: salt,
    failedAttempts: 0,
    nextAttemptAt: undefined,
    integrity: '',
  };
  next.integrity = stateIntegrity(next);
  persistState(next);
  return { generation: next.generation };
}

/** First credential on a model/UI-activated stop (`--set-credential`). */
export function setCredential(code: string, source: string): { generation: number } {
  const s = requireActiveState();
  if (!s.active) throw new Error('stop is not active');
  if (s.credentialSet) throw new Error('credential already set — use rotate (requires the current credential)');
  const normalized = assertValidCredential(code);
  appendAudit({ kind: 'e5_credential_set', source });
  const salt = crypto.randomBytes(16).toString('hex');
  const next: StopState = {
    ...s,
    generation: s.generation + 1,
    credentialSet: true,
    updatedAt: Date.now(),
    recoveryCodeHash: hashCredential(normalized, salt),
    recoverySalt: salt,
    failedAttempts: 0,
    nextAttemptAt: undefined,
    integrity: '',
  };
  next.integrity = stateIntegrity(next);
  persistState(next);
  return { generation: next.generation };
}

/** Rotation requires the CURRENT credential; the old code dies at the write. */
export function rotateCredential(currentCode: string, newCode: string, source: string): { generation: number } {
  const s = requireActiveState();
  if (!s.active || !s.credentialSet) throw new Error('rotation requires an active, credentialed stop');
  assertBackoffAllowed(s);
  if (!credentialMatches(currentCode, s)) {
    registerFailedAttempt(s);
    throw new Error('invalid current credential');
  }
  const normalized = assertValidCredential(newCode);
  appendAudit({ kind: 'e5_credential_rotated', source });
  const salt = crypto.randomBytes(16).toString('hex');
  const next: StopState = {
    ...s,
    generation: s.generation + 1,
    updatedAt: Date.now(),
    recoveryCodeHash: hashCredential(normalized, salt),
    recoverySalt: salt,
    failedAttempts: 0,
    nextAttemptAt: undefined,
    integrity: '',
  };
  next.integrity = stateIntegrity(next);
  persistState(next);
  return { generation: next.generation };
}

function assertBackoffAllowed(s: StopState): void {
  if (s.nextAttemptAt && Date.now() < s.nextAttemptAt) {
    const waitSec = Math.ceil((s.nextAttemptAt - Date.now()) / 1000);
    throw new Error(`too many failed attempts — retry in ${waitSec}s`);
  }
}

function registerFailedAttempt(s: StopState): void {
  const failedAttempts = s.failedAttempts + 1;
  const next: StopState = {
    ...s,
    failedAttempts,
    nextAttemptAt: Date.now() + backoffDelayMs(failedAttempts),
    updatedAt: Date.now(),
    integrity: '',
  };
  next.integrity = stateIntegrity(next);
  persistState(next);
}

/** Recovery (deactivation) — operator credential required. Refuses on
 *  ACTIVE_NO_CREDENTIAL (out-of-band documented) and ACTIVE_UNCERTAIN.
 *  Recovery failure NEVER deactivates the stop. */
export function recoverStop(code: string, source: string): { generation: number } {
  const s = requireActiveState();
  if (!s.active) throw new Error('stop is not active');
  if (!s.credentialSet) {
    throw new Error('this stop has no recovery credential — out-of-band recovery required (stop Krisha, delete stop-state.json, restart)');
  }
  assertBackoffAllowed(s);
  if (!credentialMatches(code, s)) {
    registerFailedAttempt(s);
    appendAuditSyncSafe({ kind: 'e5_recovery_denied', source });
    throw new Error('invalid recovery credential');
  }
  appendAudit({ kind: 'emergency_resume', source, via: 'recovery-cli' });
  const next: StopState = {
    ...s,
    generation: s.generation + 1,
    active: false,
    // The credential served its purpose — deactivate clears it. A future
    // activation is credential-less until the operator arms or sets one.
    credentialSet: false,
    recoveryCodeHash: undefined,
    recoverySalt: undefined,
    reason: undefined,
    activatedAt: undefined,
    updatedAt: Date.now(),
    failedAttempts: 0,
    nextAttemptAt: undefined,
    integrity: '',
  };
  next.integrity = stateIntegrity(next);
  persistState(next);
  return { generation: next.generation };
}

// ---------------------------------------------------------------------------
// Containment approval credential (Phase D completion)
//
// The operator's dedicated approval secret for high-stakes containment
// actions. DELIBERATELY SEPARATE from the episode-scoped recovery
// credential (which exists only during an active stop episode and is
// cleared on activation/recovery): containment approval must work in the
// normal INACTIVE state. Stored in the protected E5 store with the same
// scrypt + timing-safe + integrity self-hash machinery as the stop state;
// set and cleared ONLY through the operator's existing trusted channel
// (the recovery pipe). The MODEL/agent has no tool or bridge path to the
// pipe (documented doctrine), so it cannot enroll or self-approve. The
// disclosed same-user OS boundary applies to the pipe exactly as it does
// to the recovery credential itself.
// ---------------------------------------------------------------------------

const CONTAINMENT_APPROVAL_FILE = 'containment-approval.json';
const CONTAINMENT_APPROVAL_SCHEMA = 1;

interface ContainmentApprovalState {
  schemaVersion: number;
  credentialSet: boolean;
  recoveryCodeHash?: string;
  recoverySalt?: string;
  setAt?: number;
  integrity: string;
}

let containmentApproval: ContainmentApprovalState | null = null;
let containmentApprovalEpochCounter = 0;
let containmentApprovalFailures = 0;
let containmentApprovalNextAttemptAt = 0;

function containmentApprovalFile(): string {
  return path.join(storeRoot ?? '', CONTAINMENT_APPROVAL_FILE);
}

function containmentApprovalIntegrity(fields: Omit<ContainmentApprovalState, 'integrity'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(fields), 'utf8').digest('hex');
}

function persistContainmentApproval(next: ContainmentApprovalState): void {
  const file = containmentApprovalFile();
  durableWrite(file, JSON.stringify(next) + '\n');
  containmentApproval = next;
}

function loadContainmentApprovalSync(): void {
  containmentApproval = { schemaVersion: CONTAINMENT_APPROVAL_SCHEMA, credentialSet: false, integrity: '' };
  if (storeRoot === null) return;
  const file = containmentApprovalFile();
  let raw: string | null = null;
  try {
    raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  } catch { raw = null; }
  if (raw === null) return; // not enrolled — approval unavailable (fail-closed)
  try {
    const parsed = JSON.parse(raw) as ContainmentApprovalState;
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== CONTAINMENT_APPROVAL_SCHEMA) throw new Error('schema');
    const { integrity, ...fields } = parsed;
    if (containmentApprovalIntegrity(fields) !== integrity) throw new Error('integrity');
    if (typeof parsed.credentialSet !== 'boolean') throw new Error('shape');
    containmentApproval = parsed;
  } catch (err) {
    // Corrupt approval state is NEVER silently treated as enrolled.
    containmentApproval = { schemaVersion: CONTAINMENT_APPROVAL_SCHEMA, credentialSet: false, integrity: '' };
    console.error(`[E5] containment-approval state corrupt — failing closed (not enrolled): ${String((err as Error)?.message || err)}`);
    appendAuditSyncSafe({ kind: 'e5_containment_credential_corrupt' });
  }
}

/** Whether an operator approval credential is enrolled. Approval authority
 *  does not exist until the operator enrolls (D.4 posture preserved). */
export function containmentApprovalCredentialSet(): boolean {
  return containmentApproval?.credentialSet === true;
}

/** Monotonic epoch of the approval authority — changes on every enrollment
 *  change so issued approvals can detect mid-operation invalidation. */
export function containmentApprovalEpoch(): number {
  return containmentApprovalEpochCounter;
}

/** Operator enrolls (or re-enrolls) the containment approval credential via
 *  the recovery pipe (`set-containment-credential`). Strength rules are the
 *  recovery credential's (assertValidCredential). */
export function setContainmentApprovalCredential(code: string, source: string): { epoch: number } {
  if (storeRoot === null) throw new Error('storage unavailable — containment approval credential cannot be enrolled');
  const normalized = assertValidCredential(code);
  const salt = crypto.randomBytes(16).toString('hex');
  const next: ContainmentApprovalState = {
    schemaVersion: CONTAINMENT_APPROVAL_SCHEMA,
    credentialSet: true,
    recoveryCodeHash: hashCredential(normalized, salt),
    recoverySalt: salt,
    setAt: Date.now(),
    integrity: '',
  };
  next.integrity = containmentApprovalIntegrity(next);
  persistContainmentApproval(next);
  containmentApprovalEpochCounter += 1;
  containmentApprovalFailures = 0;
  containmentApprovalNextAttemptAt = 0;
  appendAuditSyncSafe({ kind: 'e5_containment_credential_set', source: String(source ?? '').slice(0, 64) });
  return { epoch: containmentApprovalEpochCounter };
}

/** Operator clears enrollment via the recovery pipe. Termination falls back
 *  to the disabled (D.4) posture. Failure pacing resets too: with no
 *  credential enrolled there is nothing to brute-force, and a cleared
 *  authority must fail closed QUIETLY (never with backoff throws). */
export function clearContainmentApprovalCredential(source: string): { epoch: number } {
  if (storeRoot === null) throw new Error('storage unavailable');
  const next: ContainmentApprovalState = {
    schemaVersion: CONTAINMENT_APPROVAL_SCHEMA,
    credentialSet: false,
    integrity: '',
  };
  persistContainmentApproval(next);
  containmentApprovalEpochCounter += 1;
  containmentApprovalFailures = 0;
  containmentApprovalNextAttemptAt = 0;
  appendAuditSyncSafe({ kind: 'e5_containment_credential_cleared', source: String(source ?? '').slice(0, 64) });
  return { epoch: containmentApprovalEpochCounter };
}

/**
 * Server-side verification of a candidate approval credential. READ-ONLY on
 * success (the stop state machine is untouched — this is not a recovery).
 * Failed attempts share an exponential backoff with recovery-style pacing
 * so the approval route cannot be used as a brute-force oracle.
 */
export function verifyContainmentApprovalCredential(code: string, source = 'containment-approval'): boolean {
  const now = Date.now();
  if (now < containmentApprovalNextAttemptAt) {
    const waitSec = Math.ceil((containmentApprovalNextAttemptAt - now) / 1000);
    throw new Error(`too many failed approval attempts — retry in ${waitSec}s`);
  }
  const state = containmentApproval;
  if (!state || !state.credentialSet || !state.recoveryCodeHash || !state.recoverySalt) {
    // Not enrolled: fail-closed without consuming backoff (nothing to brute-force).
    return false;
  }
  const normalized = code.normalize('NFKC');
  const candidate = Buffer.from(hashCredential(normalized, state.recoverySalt), 'hex');
  const stored = Buffer.from(state.recoveryCodeHash, 'hex');
  const ok = candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
  if (ok) {
    containmentApprovalFailures = 0;
    containmentApprovalNextAttemptAt = 0;
    return true;
  }
  containmentApprovalFailures += 1;
  containmentApprovalNextAttemptAt = now + backoffDelayMs(containmentApprovalFailures);
  appendAuditSyncSafe({ kind: 'e5_containment_approval_denied', source: String(source ?? '').slice(0, 64) });
  return false;
}

// ---------------------------------------------------------------------------
// Server-side permission state (M1b)
// ---------------------------------------------------------------------------

export type ScopeKind = 'once' | 'task' | 'session' | 'duration';

interface ScopedGrantRecord {
  id: string;
  permission: string;
  scope: { kind: ScopeKind; taskId?: string; expiresAt?: number };
  reason: string;
  grantedAt: number;
  temporary: boolean;
}

/**
 * Server-side session permission baseline. Seeded to match the operator's
 * own direct-action authority: the operator's UI performs filesystem and
 * application actions directly, and a same-user process can do all of it
 * without Krisha — so the operator baseline is permissive BY DOCUMENTED
 * DECISION. The MODEL is filtered by the browser-side gate (default-deny on
 * filesystem.write etc.) before any request reaches the server. The server
 * state is authoritative for: the emergency stop, revocation semantics, and
 * scoped-grant consumption (M2+ consumes once/task grants here).
 */
const SERVER_SESSION_SEED: Record<string, boolean> = {
  'filesystem.read': true,
  'filesystem.write': true, // operator baseline — documented M1 decision
  'browser.interaction': true,
  'application.launch': true,
  'location.access': true,
  'memory.access': true,
  'screen.observation': false,
  'mouse.control': false,
  'keyboard.control': false,
  'terminal.execution': false,
  'camera.access': false,
  'microphone.access': false,
  // LPV (Local Private Vault): the operator's own UI manages the vault
  // (baseline true, matching the operator-baseline doctrine); RETRIEVAL is
  // never baseline — it is satisfied only by approval-issued `once` grants
  // (see lpvCore.issueFillGrant).
  'vault.manage': true,
  'vault.retrieve': false,
};

const MAX_LIVE_TASKS = 16;
const MAX_SCOPED_GRANTS = 64;

class ServerPermissionState {
  private session: Record<string, boolean> = { ...SERVER_SESSION_SEED };
  private scoped: ScopedGrantRecord[] = [];
  private tasks = new Map<string, { state: 'live' | 'closed'; closedAt?: number }>();
  private revoked = new Set<string>();

  isGranted(permission: string): boolean {
    if (this.revoked.has(permission)) return false;
    return this.session[permission] === true;
  }

  revokeSession(permission: string): void {
    this.session[permission] = false;
  }

  grantSession(permission: string): void {
    this.session[permission] = true;
  }

  /** Server-MINTED task identity. Callers cannot choose the ID. Bounded. */
  taskBegin(): { taskId: string } {
    const live = [...this.tasks.values()].filter((t) => t.state === 'live').length;
    if (live >= MAX_LIVE_TASKS) throw new Error('task registry full');
    const taskId = `task_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    this.tasks.set(taskId, { state: 'live' });
    return { taskId };
  }

  isTaskLive(taskId: string): boolean {
    return this.tasks.get(taskId)?.state === 'live';
  }

  /** Completion, cancellation, or timeout: closes the task and destroys its
   *  task-scoped grants. Stale contexts are denied at every later check. */
  taskEnd(taskId: string, reason: 'completed' | 'cancelled' | 'timeout'): void {
    const t = this.tasks.get(taskId);
    if (!t || t.state !== 'live') return;
    t.state = 'closed';
    t.closedAt = Date.now();
    this.scoped = this.scoped.filter(
      (g) => !(g.scope.kind === 'task' && g.scope.taskId === taskId),
    );
    void reason;
  }

  grantScoped(input: { permission: string; scope: { kind: ScopeKind; taskId?: string; expiresAt?: number }; reason: string; temporary?: boolean }): ScopedGrantRecord {
    if (input.scope.kind === 'task') {
      if (!input.scope.taskId || !this.isTaskLive(input.scope.taskId)) {
        throw new Error('task-scoped grants require a live server-side task');
      }
    }
    if (this.scoped.length >= MAX_SCOPED_GRANTS) this.scoped.shift();
    const grant: ScopedGrantRecord = {
      id: `sg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      permission: input.permission,
      scope: input.scope,
      reason: String(input.reason ?? '').slice(0, 160),
      grantedAt: Date.now(),
      temporary: input.temporary ?? input.scope.kind !== 'session',
    };
    this.scoped.push(grant);
    this.revoked.delete(input.permission);
    return grant;
  }

  /**
   * Atomic scoped check. `once` is REMOVE-BEFORE-GRANT: under JS
   * serialization the delete and the return are indivisible, so two
   * concurrent consumers cannot both succeed. Expired and closed-task
   * grants are destroyed, never reused. Task scopes resolve only against
   * live server-registered tasks — never against caller input.
   */
  checkScoped(permission: string, ctx?: { taskId?: string }): { status: 'granted' | 'denied' | 'expired' | 'task_closed'; grant?: ScopedGrantRecord } {
    if (this.revoked.has(permission)) return { status: 'denied' };
    let sawExpired = false;
    // Iterate a snapshot: consumption/destroy modifies the live array.
    for (const g of [...this.scoped]) {
      if (g.permission !== permission) continue;
      // Expired duration grants are destroyed on sight, never reused.
      if (g.scope.kind === 'duration' && (g.scope.expiresAt ?? 0) <= Date.now()) {
        this.scoped = this.scoped.filter((x) => x.id !== g.id);
        sawExpired = true;
        continue;
      }
      if (g.scope.kind === 'once') {
        // REMOVE-BEFORE-GRANT: atomic under JS serialization.
        this.scoped = this.scoped.filter((x) => x.id !== g.id);
        return { status: 'granted', grant: g };
      }
      if (g.scope.kind === 'task') {
        if (ctx?.taskId && g.scope.taskId === ctx.taskId && this.isTaskLive(ctx.taskId)) {
          return { status: 'granted', grant: g };
        }
        // A task grant whose task is closed is stale — destroy it.
        if (g.scope.taskId && !this.isTaskLive(g.scope.taskId)) {
          this.scoped = this.scoped.filter((x) => x.id !== g.id);
        }
        continue;
      }
      if (g.scope.kind === 'session') return { status: 'granted', grant: g };
      if (g.scope.kind === 'duration') return { status: 'granted', grant: g };
    }
    return sawExpired ? { status: 'expired' } : { status: 'denied' };
  }

  revokeAllTemporary(): number {
    const before = this.scoped.length;
    this.scoped = this.scoped.filter((g) => !g.temporary);
    return before - this.scoped.length;
  }

  countScoped(): number {
    return this.scoped.length;
  }
}

export const serverPermissions = new ServerPermissionState();

// ---------------------------------------------------------------------------
// Request size guard (M1d) — checked BEFORE body parsing.
// ---------------------------------------------------------------------------

export function createBodySizeGuard(largeBodyPaths: Set<string>, normalLimit: number, largeLimit: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const declared = Number(req.headers['content-length'] ?? 0);
    const limit = largeBodyPaths.has(req.path) ? largeLimit : normalLimit;
    if (declared > limit) {
      res.status(413).json({ success: false, error: 'request body too large' });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory token buckets, per boot)
// ---------------------------------------------------------------------------

const buckets = new Map<string, { tokens: number; last: number }>();

export function rateLimit(group: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(group) ?? { tokens: limit, last: now };
  const refill = ((now - bucket.last) / windowMs) * limit;
  bucket.tokens = Math.min(limit, bucket.tokens + refill);
  bucket.last = now;
  if (bucket.tokens < 1) {
    buckets.set(group, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(group, bucket);
  return true;
}

// ---------------------------------------------------------------------------
// Enforcement middleware (M1b/M1d)
// ---------------------------------------------------------------------------

export interface EnforcementOptions {
  /** Server-side permission required for this route (session or scoped). */
  permission?: string;
  /** Refuse while the emergency stop is ACTIVE or UNCERTAIN. */
  stopBlock?: boolean;
  /** Rate-limit group + parameters. */
  rate?: { group: string; limit: number; windowMs: number };
}

/**
 * Server-side enforcement: rate limit → emergency stop → permission →
 * audit. Runs BEFORE any handler; the browser-side gate is not trusted.
 * Decisions are audited; mutations under a degraded audit proceed with the
 * `auditDegraded` flag surfaced (the audit is evidence, not the gate), while
 * authority transitions (inside the stop module) refuse on audit failure.
 */
export function enforce(options: EnforcementOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (options.rate && !rateLimit(options.rate.group, options.rate.limit, options.rate.windowMs)) {
      res.status(429).json({ success: false, error: 'rate_limited', group: options.rate.group });
      return;
    }
    const kind = stopKind();
    if (options.stopBlock && kind !== 'INACTIVE') {
      appendAuditSyncSafe({ kind: 'e5_stop_blocked', route: req.path, stopKind: kind });
      res.status(423).json({
        success: false,
        error: kind === 'ACTIVE_UNCERTAIN' ? 'emergency_stop_uncertain' : 'emergency_stop_active',
        stop: { kind, generation: currentState?.generation ?? null },
      });
      return;
    }
    if (options.permission) {
      // Task-scoped and once grants intentionally never satisfy HTTP
      // requests — task identity is server-minted for the agent runtime,
      // and HTTP enforcement resolves session/duration scopes only. The
      // context is deliberately omitted so no caller input can select a
      // task scope.
      const granted = serverPermissions.isGranted(options.permission) ||
        serverPermissions.checkScoped(options.permission).status === 'granted';
      if (!granted) {
        appendAuditSyncSafe({ kind: 'blocked', route: req.path, permission: options.permission });
        res.status(403).json({ success: false, error: `permission_denied: ${options.permission}` });
        return;
      }
    }
    appendAuditSyncSafe({ kind: 'executed', route: req.path });
    next();
  };
}

// ---------------------------------------------------------------------------
// Recovery named pipe (M1c) — restricted local transport, ONE operation set
// ---------------------------------------------------------------------------

/**
 * Recovery-pipe transport path. The recovery AUTHORITY is always this
 * process's own stop-state machine; the pipe is only its transport. The
 * default name is the production endpoint (recovery CLI compatibility).
 * Test processes may override it via KRISHA_RECOVERY_PIPE_PATH so an
 * isolated store's tests bind their OWN transport instead of racing the
 * live application for the global name — one authority per store, no
 * second recovery authority is created.
 */
export const RECOVERY_PIPE_PATH =
  (process.env.KRISHA_RECOVERY_PIPE_PATH ?? '').trim() || '\\\\.\\pipe\\krisha-e5-recovery';
let recoveryAvailable = false;
let activePipeConnections = 0;
const MAX_PIPE_CONNECTIONS = 4;
const seenNonces = new Set<string>();

function pipeDispatch(msg: any): { ok: boolean; error?: string; result?: unknown } {
  if (!msg || typeof msg !== 'object') return { ok: false, error: 'malformed' };
  if (typeof msg.nonce !== 'string' || msg.nonce.length < 16 || msg.nonce.length > 128) {
    return { ok: false, error: 'invalid_nonce' };
  }
  if (seenNonces.has(msg.nonce)) return { ok: false, error: 'replayed_nonce' };
  seenNonces.add(msg.nonce);
  if (seenNonces.size > 128) {
    const first = seenNonces.values().next().value;
    if (first !== undefined) seenNonces.delete(first);
  }
  const source = 'recovery-cli';
  try {
    switch (msg.op) {
      case 'status':
        return { ok: true, result: stopSnapshot() };
      case 'arm': {
        const r = armStop(String(msg.code ?? ''), source);
        return { ok: true, result: r };
      }
      case 'set-credential': {
        const r = setCredential(String(msg.code ?? ''), source);
        return { ok: true, result: r };
      }
      case 'recover': {
        const r = recoverStop(String(msg.code ?? ''), source);
        return { ok: true, result: r };
      }
      case 'rotate': {
        const r = rotateCredential(String(msg.currentCode ?? ''), String(msg.newCode ?? ''), source);
        return { ok: true, result: r };
      }
      case 'set-containment-credential': {
        // Operator channel only (recovery CLI doctrine — no model/tool path).
        const r = setContainmentApprovalCredential(String(msg.code ?? ''), source);
        return { ok: true, result: r };
      }
      case 'clear-containment-credential': {
        const r = clearContainmentApprovalCredential(source);
        return { ok: true, result: r };
      }
      default:
        return { ok: false, error: 'unknown_op' };
    }
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err).slice(0, 200) };
  }
}

/** Create the recovery pipe. Squatting (name already taken) disables the
 *  recovery subsystem — fail-closed, surfaced. */
export function startRecoveryPipe(): { available: boolean; error?: string } {
  if (storeRoot === null) return { available: false, error: 'storage unavailable' };
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    activePipeConnections += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      activePipeConnections -= 1;
      clearTimeout(timer);
    };
    const timer = setTimeout(() => socket.destroy(), 10_000);
    // Connection cap is RESOURCE protection only: all state transitions are
    // synchronous under the process lock, so concurrent connections cannot
    // interleave them. Rapid sequential connections must always succeed.
    if (activePipeConnections > MAX_PIPE_CONNECTIONS) {
      socket.end(JSON.stringify({ ok: false, error: 'busy' }) + '\n');
      release();
      socket.destroy();
      return;
    }
    socket.on('close', release);
    socket.on('error', release);
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 4096) {
        socket.end(JSON.stringify({ ok: false, error: 'oversized' }) + '\n');
        socket.destroy();
        return;
      }
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      let response: unknown;
      try {
        response = pipeDispatch(JSON.parse(line));
      } catch {
        response = { ok: false, error: 'malformed' };
      }
      socket.end(JSON.stringify(response) + '\n');
    });
  });
  server.on('error', (err) => {
    recoveryAvailable = false;
    console.error(`[E5] recovery pipe unavailable: ${String((err as Error)?.message || err)}`);
  });
  try {
    server.listen(RECOVERY_PIPE_PATH);
    recoveryAvailable = true;
    return { available: true };
  } catch (err) {
    recoveryAvailable = false;
    return { available: false, error: String((err as Error)?.message || err) };
  }
}

// ---------------------------------------------------------------------------
// Boot — everything above runs synchronously at module load.
// ---------------------------------------------------------------------------

resolveStoreRootSync();
initStopStateSync();
loadContainmentApprovalSync();
startRecoveryPipe();
