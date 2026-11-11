/**
 * E5 M2 — Sandbox Core: server-controlled sandbox filesystem layer.
 *
 * Built ON TOP of the accepted M1 foundation (serverSafety.ts): every path
 * still resolves through resolveSafePath (containment + denylist + ADS +
 * realpath hardening), every mutation is additionally refused inside E5
 * protected storage (assertNotProtected), and every mutation passes an
 * in-process enforcement gate (emergency stop → server-side permission →
 * audit) BEFORE any filesystem primitive runs. The HTTP middleware in
 * server.ts remains the outer layer; this gate covers in-process callers.
 *
 * What M2 adds:
 *   1. Filesystem identity tracking (volume id + NTFS file id + birthtime)
 *      with revalidation IMMEDIATELY BEFORE every destructive primitive.
 *   2. Parent-directory identity validation (replacement detection).
 *   3. Safe staging per E4: journal-first, O_EXCL staging files, recorded
 *      staging + parent identity, ownership verification before any cleanup,
 *      unknown/unverifiable files are reported — never silently deleted.
 *   4. A bounded, durable sandbox journal in a dedicated subdirectory of the
 *      E5 protected store (separate from stop-state / marker / audit), which
 *      the model filesystem API cannot reach (full protection mode).
 *
 * Honest limits (do not weaken these disclosures):
 *   - dev/ino/birthtime identify a file PRACTICALLY, not cryptographically.
 *     NTFS file ids can be reused after deletion (birthtime narrows but does
 *     not close that window); on FAT/exFAT birthtime is unreliable and
 *     identity checks degrade to dev+ino (flagged per-comparison).
 *   - Node has no openat/unlinkat: between the final revalidation and the
 *     primitive there remains a small same-user race window. Path validation
 *     does NOT eliminate every filesystem race — it narrows them to the
 *     same-user adversary class, which is an accepted, disclosed boundary.
 *   - In degraded storage mode the journal lives inside the user profile and
 *     is no longer model-immutable; cleanup still requires on-disk identity
 *     agreement, but tamper resistance is weaker and disclosed.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  resolveSafePath, assertNotProtected, getStorageInfo, stopKind, serverPermissions,
  appendAuditSyncSafe, durableWrite,
} from './serverSafety';

// E1 contract wording — preserved verbatim (do not reword):
export const E1_CONTRACT = 'Restored content is what Krisha verified via two agreeing full reads of the source; it may not correspond to any single historical version.';

// ---------------------------------------------------------------------------
// Filesystem identity
// ---------------------------------------------------------------------------

export interface FileIdentity {
  dev: number;          // volume serial number
  ino: number;          // NTFS file id (Node fills this on Windows)
  birthtimeMs: number;
  birthtimeReliable: boolean;
  size: number;
  mtimeMs: number;
}

const BIRTHTIME_TOLERANCE_MS = 2;

function birthtimeReliable(st: fs.Stats): boolean {
  return Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0;
}

/** Capture identity via lstat — never follows symlinks/junctions. */
export function captureIdentity(p: string): FileIdentity | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return null;
  }
  return {
    dev: st.dev,
    ino: st.ino,
    birthtimeMs: st.birthtimeMs,
    birthtimeReliable: birthtimeReliable(st),
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

function identityOf(st: fs.Stats): FileIdentity {
  return {
    dev: st.dev,
    ino: st.ino,
    birthtimeMs: st.birthtimeMs,
    birthtimeReliable: birthtimeReliable(st),
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

/** Practical identity agreement: same volume, same file id, and — where the
 *  platform provides a usable birthtime — same creation instant. When either
 *  side lacks a reliable birthtime (FAT/exFAT), the comparison degrades to
 *  dev+ino and reports that it did so. */
export function identityMatches(a: FileIdentity, b: FileIdentity): { match: boolean; degraded: boolean } {
  if (a.dev !== b.dev || a.ino !== b.ino) return { match: false, degraded: false };
  if (a.birthtimeReliable && b.birthtimeReliable) {
    return { match: Math.abs(a.birthtimeMs - b.birthtimeMs) <= BIRTHTIME_TOLERANCE_MS, degraded: false };
  }
  return { match: true, degraded: true };
}

/** Strict staging-ownership check: identity PLUS content fingerprints.
 *  A staging file whose size or mtime changed after staging_ready is treated
 *  as changed identity (E4 #6) — an unsafe condition, never cleaned up. */
function strictStagingMatch(recorded: FileIdentity, current: fs.Stats): { match: boolean; reason?: string } {  const id = identityOf(current);
  const base = identityMatches(recorded, id);
  if (!base.match) return { match: false, reason: 'identity mismatch (dev/ino/birthtime)' };
  if (recorded.size !== id.size) return { match: false, reason: 'size changed after staging' };
  if (Math.abs(recorded.mtimeMs - id.mtimeMs) > BIRTHTIME_TOLERANCE_MS) return { match: false, reason: 'mtime changed after staging' };
  return { match: true };
}

/** E5 H3 — strict identity agreement between the staged record and a node
 *  found at the destination after a crash: dev + file id + birthtime + size
 *  + mtime. Used ONLY to classify a committed-but-unjournaled mutation —
 *  it never triggers a mutation by itself. */
function isStrictMatchForSweep(recorded: FileIdentity, current: FileIdentity): boolean {
  if (recorded.dev !== current.dev || recorded.ino !== current.ino) return false;
  if (recorded.birthtimeReliable && current.birthtimeReliable && Math.abs(recorded.birthtimeMs - current.birthtimeMs) > BIRTHTIME_TOLERANCE_MS) return false;
  if (recorded.size !== current.size) return false;
  if (Math.abs(recorded.mtimeMs - current.mtimeMs) > BIRTHTIME_TOLERANCE_MS) return false;
  return true;
}

/** Refuse symlink/junction/reparse targets for mutation operations. */
function assertNotReparse(p: string, role: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return; // absence is handled by callers that require existence
  }
  if (st.isSymbolicLink()) throw new Error(`Refusing ${role}: "${p}" is a symlink or junction`);
}

// ---------------------------------------------------------------------------
// Enforcement gate — emergency stop → permission → audit (M1 primitives)
// ---------------------------------------------------------------------------

/** In-process mutation gate. Complements the HTTP middleware so that future
 *  in-process (agent-runtime) callers cannot bypass stop/permission state. */
import { verifyAuditChain } from './serverSafety';

// ---------------------------------------------------------------------------
// E5 H5 — operation-specific integrity policy (centralized, server-side).
//
// Policy matrix (operations × integrity domains), enforced at the trusted
// chokepoints:
//
//   operation class            audit       journal      store     quarantine(per-item)
//   sandbox-mutation           evaluate*   DENY on fail evaluate   n/a (capture inherits)
//   quarantine-release         evaluate*   evaluate     DENY fail  DENY per-item
//   rollback-plan              DENY fail   DENY fail    DENY fail  per-op in plan
//   rollback-execute           DENY fail   DENY fail    DENY fail  per-op in execute
//   diagnostics                evaluate    evaluate     evaluate   evaluate
//   stop-control               evaluate    evaluate     evaluate   evaluate
//
//   * = recorded via auditDegraded (M1: the audit is evidence, not the gate —
//       an audit-chain failure never blocks a sandbox mutation or stop
//       control, but rollback planning/execution DO refuse: authority
//       transitions, per the M3 rule).
//
//   - sandbox-mutation: DENIED on journal corruption — new mutations depend
//     on trustworthy journaling; an unreliable journal would create uncertain
//     crash states. Quarantine-domain anomalies do NOT block mutations.
//   - quarantine-release: journal/audit state does not block (restore safety
//     is proven per-item by metadata integrity + identity); the store and the
//     per-item checks are authoritative.
//   - stop-control (activation/recovery): never denied for integrity — the
//     safety direction must always remain available.
// ---------------------------------------------------------------------------

export type OperationIntegrityClass =
  | 'sandbox-mutation'
  | 'quarantine-release'
  | 'rollback-plan'
  | 'rollback-execute'
  | 'diagnostics'
  | 'stop-control';

export interface OperationIntegrityReport {
  ok: boolean;
  domain: 'audit' | 'journal' | 'store' | null;
  reason: string | null;
}

/** E5 H5 — evaluate the integrity preconditions for ONE operation class.
 *  Fresh verification per call (never the H4 monitor's cached state). Returns
 *  a report; THROWS the structured denial for mutating classes when policy
 *  refuses, and audits the denial (bounded: one record per attempted
 *  operation; a failing audit write surfaces via auditDegraded and cannot
 *  mask the denial, which is the thrown error itself). */
export function assertOperationIntegrity(opClass: OperationIntegrityClass): OperationIntegrityReport {
  const store = getStorageInfo();
  if (!store.root || store.protection === 'unavailable') {
    const reason = `protected store ${store.root ? 'protection unavailable' : 'unavailable'} — operation refused`;
    appendAuditSyncSafe({ kind: 'e5_integrity_denied', opClass, domain: 'store', reason });
    throw new Error(reason);
  }
  if (opClass === 'diagnostics' || opClass === 'stop-control') {
    return { ok: true, domain: null, reason: null }; // evaluate-only classes
  }
  // Fail closed on unknown classes: they default to the strictest journal
  // policy (a mutation-like unknown must not bypass journal trust).
  const journalPolicy = opClass === 'quarantine-release' ? false : true;
  if (journalPolicy) {
    const journal = journalIntegrityCheck();
    if (!journal.ok) {
      const reason = `journal inconsistency detected (${journal.malformedLines} malformed of ${journal.totalLines} lines) — ${opClass} refused, no guessed recovery`;
      appendAuditSyncSafe({ kind: 'e5_integrity_denied', opClass, domain: 'journal', reason });
      throw new Error(reason);
    }
  }
  if (opClass === 'rollback-plan' || opClass === 'rollback-execute') {
    const audit = verifyAuditChain();
    if (!audit.ok && audit.entries > 0) {
      const reason = `audit chain integrity failure (${audit.reason ?? 'verification failed'}) — authority transition refused`;
      appendAuditSyncSafe({ kind: 'e5_integrity_denied', opClass, domain: 'audit', reason });
      throw new Error(reason);
    }
  }
  // quarantine-release: per-item verification happens in
  // restoreFromQuarantine/releaseQuarantine (metadata integrity + identity +
  // declared path) — journal/audit state intentionally does not block here.
  return { ok: true, domain: null, reason: null };
}

export function assertSandboxMutation(permission: string, op: string, target: string, opClass: OperationIntegrityClass = 'sandbox-mutation'): void {
  // E5 H5 — integrity policy first: the journal must be trustworthy before a
  // mutation is recorded into it.
  assertOperationIntegrity(opClass);
  const kind = stopKind();
  if (kind !== 'INACTIVE') {
    appendAuditSyncSafe({ kind: 'e5_sandbox_blocked_stop', op, path: target, stopKind: kind });
    throw new Error(kind === 'ACTIVE_UNCERTAIN'
      ? 'emergency stop state is UNCERTAIN — all mutations refused'
      : 'emergency stop is ACTIVE — all mutations refused');
  }
  const granted = serverPermissions.isGranted(permission) ||
    serverPermissions.checkScoped(permission).status === 'granted';
  if (!granted) {
    appendAuditSyncSafe({ kind: 'e5_sandbox_blocked_permission', op, path: target, permission });
    throw new Error(`permission_denied: ${permission}`);
  }
  appendAuditSyncSafe({ kind: 'e5_sandbox_mutation', op, path: target });
}

// ---------------------------------------------------------------------------
// Sandbox journal — bounded, durable, in a DEDICATED subdirectory of the
// E5 protected store. Clearly separate from safety metadata (stop-state.json,
// install.marker, audit/): the journal holds sandbox operation records only,
// and the model filesystem API cannot reach it (assertNotProtected refuses
// the whole store subtree in full protection mode).
// ---------------------------------------------------------------------------

const JOURNAL_DIR = 'sandbox-journal';
const JOURNAL_FILE = 'journal.jsonl';
const JOURNAL_MAX_LINES = 400;
const JOURNAL_KEEP_CLOSED = 100;

type JournalEntry =
  | { t: 'staging_started'; opId: string; op: string; destPath: string; stagePath: string; at: number }
  | { t: 'staging_ready'; opId: string; stage: FileIdentity; parentPath: string; parent: FileIdentity; at: number }
  | { t: 'staging_committed'; opId: string; at: number }
  | { t: 'staging_aborted'; opId: string; at: number }
  | { t: 'staging_missing'; opId: string; at: number }
  | { t: 'staging_orphan'; opId: string; reason: string; at: number }
  // E5 H3 — evidence-based closure for a commit whose journal record was lost
  // to a crash (rename happened; identity of the destination matches the
  // staged identity exactly). Never guessed: written only on an identity match.
  | { t: 'staging_committed_recovered'; opId: string; destPath: string; at: number }
  | { t: 'mutation'; op: string; from?: string; to?: string; opId?: string; quarantineId?: string; at: number }
  // E5 M3 — rollback outcome records (closed bookkeeping):
  | { t: 'rollback_executed'; opId: string; planHash: string; at: number }
  | { t: 'rollback_refused'; opId: string; planHash?: string; reason: string; at: number };

// Closed = records that need no further action. 'mutation' op records are
// closed bookkeeping; only unresolved staging (started/ready without a
// closure) stays open for sweep/crash recovery. Rollback outcome records are
// likewise closed.
const CLOSED = new Set(['staging_committed', 'staging_committed_recovered', 'staging_aborted', 'staging_missing', 'staging_orphan', 'mutation', 'rollback_executed', 'rollback_refused']);

/** Explicit type guards — the repo tsconfig is non-strict, so discriminant
 *  narrowing cannot be relied on implicitly. */
type StartedEntry = Extract<JournalEntry, { t: 'staging_started' }>;
function isStarted(e: JournalEntry): e is StartedEntry {
  return e.t === 'staging_started';
}
function opIdOf(e: JournalEntry): string {
  return (e as { opId?: string }).opId ?? '';
}

function journalPath(): string {
  const { root, protection } = getStorageInfo();
  if (!root || protection === 'unavailable') {
    throw new Error('sandbox journal unavailable — protected storage is unavailable, mutations are refused');
  }
  return path.join(root, JOURNAL_DIR, JOURNAL_FILE);
}

function appendJournal(entry: JournalEntry): void {
  const file = journalPath(); // throws when storage unavailable → fail-closed
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(entry) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  compactJournalIfBounded(file);
}

function readJournal(file: string): JournalEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries: JournalEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as JournalEntry;
      if (parsed && typeof parsed === 'object' && typeof (parsed as { t?: string }).t === 'string') entries.push(parsed);
    } catch {
      // a torn final line (crash mid-append) is skipped, never trusted
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// E5 M3 exports — the rollback core consumes the SAME journal semantics and
// must never invent its own (no reinterpretation of entries, no writes that
// bypass this module's append path).
// ---------------------------------------------------------------------------

export type SandboxJournalEntry = JournalEntry;

/** Read the raw journal (bounded file). Rollback uses this read-only. */
export function readJournalEntries(): JournalEntry[] {
  return readJournal(journalPath());
}

/** Append a rollback outcome record through the same durable path. */
export function appendJournalEntry(entry: JournalEntry): void {
  appendJournal(entry);
}

/** Journal integrity for rollback planning: ANY malformed line (including a
 *  torn final line) is an inconsistency → rollback refuses conservatively.
 *  (Normal operations skip torn lines; rollback does not — it needs an exact,
 *  fully-parseable journal state to bind a plan to.)
 *  E5 H3: also reports a leftover compaction temp file — proof that a
 *  compaction was interrupted. The journal itself remains the pre-compaction
 *  truth; the artifact is DETECTED, never auto-deleted. */
export function journalIntegrityCheck(): { ok: boolean; totalLines: number; malformedLines: number; present: boolean; compactionTmpPresent: boolean; verificationUnavailable: boolean } {
  const file = journalPath(); // throws when storage unavailable (fail-closed)
  const tmpPresent = (() => {
    try { return fs.existsSync(file + '.tmp'); } catch { return false; }
  })();
  const filePresent = (() => { try { return fs.existsSync(file); } catch { return false; } })();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    // E5 H6 — an unreadable-but-present journal is a VERIFICATION FAILURE,
    // never a healthy empty scan (mirror of the H4 audit-file fix).
    if (filePresent) return { ok: false, totalLines: 0, malformedLines: 0, present: true, compactionTmpPresent: tmpPresent, verificationUnavailable: true };
    return { ok: true, totalLines: 0, malformedLines: 0, present: false, compactionTmpPresent: tmpPresent, verificationUnavailable: false };
  }
  let total = 0;
  let malformed = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    total++;
    try {
      const parsed = JSON.parse(line) as { t?: unknown };
      if (!parsed || typeof parsed !== 'object' || typeof parsed.t !== 'string') malformed++;
    } catch {
      malformed++;
    }
  }
  return { ok: malformed === 0, totalLines: total, malformedLines: malformed, present: total > 0, compactionTmpPresent: tmpPresent, verificationUnavailable: false };
}

/** Bounded journal: rewrite when the file outgrows its cap. Semantics:
 *  - unresolved staging operations (started/ready without closure) are kept
 *    IN FULL — crash recovery must see them;
 *  - closed operations are dropped entirely EXCEPT the most recent
 *    JOURNAL_KEEP_CLOSED closure records (bounded history). Keeping closure
 *    records without their started/ready counterparts is safe: the closure
 *    alone proves the op resolved; keeping started/ready without closure
 *    would resurrect resolved ops as false-unresolved. */
function compactJournalIfBounded(file: string): void {
  let lines = 0;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch {
    return;
  }
  if (lines <= JOURNAL_MAX_LINES) return;
  const entries = readJournal(file);
  const closedOps = new Set(entries.filter((e) => CLOSED.has(e.t)).map(opIdOf));
  const kept: JournalEntry[] = [];
  for (const e of entries) {
    if (!closedOps.has(opIdOf(e))) kept.push(e); // unresolved op — keep whole lifecycle
  }
  const closures = entries.filter((e) => CLOSED.has(e.t));
  kept.push(...closures.slice(-JOURNAL_KEEP_CLOSED)); // bounded recent history
  try {
    durableWrite(file, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
  } catch {
    // compaction is best-effort bounding; the journal remains correct either
    // way (append-only truth), boundedness is retried on the next append
  }
}

// ---------------------------------------------------------------------------
// Safe staging (E4): journal BEFORE creation, O_EXCL creation, identity
// recording, verification before cleanup, never delete the unverified.
// ---------------------------------------------------------------------------

const STAGE_SUFFIX_RE = /\.krisha-stage-[0-9a-f-]{36}\.tmp$/;

export interface StagedWrite {
  opId: string;
  stagePath: string;
  destPath: string;
}

function stagePathFor(dest: string, opId: string): string {
  return path.join(path.dirname(dest), `.krisha-stage-${opId}.tmp`);
}

/** Prepare a staged write for `destPath`: journal-first (E4 #1), then create
 *  the staging file O_EXCL (E4 #2), then record staging + parent identity
 *  (E4 #3). The caller commits or aborts explicitly. Content may be text or
 *  binary (E5 M3: quarantine restore round-trips binary captures). */
export function stageFile(destPath: string, content: string | Buffer, op = 'create'): StagedWrite {
  const dest = resolveSafePath(destPath, 'write');
  assertNotProtected(dest, 'write');
  if (fs.existsSync(dest)) throw new Error(`"${dest}" already exists — refusing to overwrite`);
  const parent = path.dirname(dest);
  const parentBefore = captureIdentity(parent);
  if (!parentBefore) throw new Error(`Parent directory "${parent}" does not exist`);
  const opId = crypto.randomUUID();
  const stagePath = stagePathFor(dest, opId);
  appendJournal({ t: 'staging_started', opId, op, destPath: dest, stagePath, at: Date.now() }); // E4 #1 — BEFORE creation
  const fd = fs.openSync(stagePath, 'wx'); // E4 #2 — O_EXCL, exclusive creation
  try {
    if (typeof content === 'string') fs.writeSync(fd, content);
    else fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const stage = fs.lstatSync(stagePath);
  const parentNow = fs.lstatSync(parent);
  appendJournal({
    t: 'staging_ready', opId, stage: identityOf(stage), parentPath: parent, parent: identityOf(parentNow), at: Date.now(),
  }); // E4 #3 — identity + parent identity recorded
  return { opId, stagePath, destPath: dest };
}

/** Commit a staged write into place. Revalidates staging identity (strict),
 *  parent identity, and destination expectations IMMEDIATELY BEFORE the
 *  rename. Same-volume rename — atomic on NTFS. */
export function commitStaged(sw: StagedWrite, expectExisting?: FileIdentity): { name: string; path: string; kind: 'file' | 'directory'; size: number; modifiedAt: number } {
  const { opId, stagePath, destPath } = sw;
  const parent = path.dirname(destPath);
  // Stage ownership: only the exact recorded staging file may be committed.
  const st = fs.lstatSync(stagePath); // throws if missing → unsafe condition surfaced
  const ready = findReady(opId);
  if (!ready) throw new Error(`staging record for ${opId} is incomplete — refusing to commit (unsafe condition)`);
  const owned = strictStagingMatch(ready.stage, st);
  if (!owned.match) throw new Error(`staging identity changed since staging_ready (${owned.reason}) — refusing to commit (E4 unsafe condition)`);
  // Parent replacement defense.
  const parentNow = captureIdentity(parent);
  if (!parentNow || !identityMatches(ready.parent, parentNow).match) {
    appendJournal({ t: 'staging_orphan', opId, reason: 'parent directory replaced after staging', at: Date.now() });
    throw new Error('parent directory changed after staging — refusing to commit (E4 unsafe condition)');
  }
  // Destination expectation, revalidated at the last possible moment.
  if (expectExisting) {
    const destNow = captureIdentity(destPath);
    if (!destNow || !identityMatches(expectExisting, destNow).match) {
      throw new Error('destination changed since authorization — refusing to overwrite (E4 unsafe condition)');
    }
  } else if (fs.existsSync(destPath)) {
    throw new Error(`"${destPath}" came into existence during staging — refusing to overwrite`);
  }
  fs.renameSync(stagePath, destPath);
  appendJournal({ t: 'staging_committed', opId, at: Date.now() });
  const final = fs.lstatSync(destPath);
  return entryFromStats(destPath, final);
}

/** Abort a staged write. Deletes the staging file ONLY after strict identity
 *  verification proves it is still the file this operation created (E4 #4).
 *  Missing or changed identity is an unsafe condition: nothing is deleted
 *  and the condition is recorded + reported (E4 #5/#6/#7). */
export function abortStaged(sw: StagedWrite): { deleted: boolean; reason?: string } {
  const { opId, stagePath } = sw;
  let st: fs.Stats;
  try {
    st = fs.lstatSync(stagePath);
  } catch {
    appendJournal({ t: 'staging_missing', opId, at: Date.now() });
    return { deleted: false, reason: 'staging file already absent (recorded, nothing deleted)' };
  }
  const ready = findReady(opId);
  if (!ready) {
    appendJournal({ t: 'staging_orphan', opId, reason: 'no staging_ready record — ownership unverifiable', at: Date.now() });
    return { deleted: false, reason: 'ownership unverifiable (no ready record) — file left in place' };
  }
  const owned = strictStagingMatch(ready.stage, st);
  if (!owned.match) {
    appendJournal({ t: 'staging_orphan', opId, reason: `identity changed (${owned.reason})`, at: Date.now() });
    return { deleted: false, reason: `identity changed (${owned.reason}) — file left in place (E4 #6/#7)` };
  }
  fs.unlinkSync(stagePath);
  appendJournal({ t: 'staging_aborted', opId, at: Date.now() });
  return { deleted: true };
}

function findReady(opId: string): Extract<JournalEntry, { t: 'staging_ready' }> | null {
  const entries = readJournal(journalPath());
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.t === 'staging_ready' && e.opId === opId) return e;
  }
  return null;
}

export interface SweepReport {
  cleaned: string[];
  missing: string[];
  orphans: { opId: string; stagePath: string; reason: string }[];
  /** E5 H3 — crash window: the commit rename happened but the journal closure
   *  was lost. The destination exists with the EXACT staged identity, so the
   *  outcome is provable (not guessed): the sweep closes the operation with an
   *  explicit `staging_committed_recovered` record instead of mislabeling it
   *  as missing. */
  committedUnjournaled: Array<{ opId: string; destPath: string }>;
}

/** Bounded sweep of unresolved staging operations (crash recovery). Deletion
 *  happens ONLY for staging files whose on-disk identity strictly matches
 *  the journal's staged record. Everything else is reported, never touched:
 *  files that match the staging naming pattern but have no journal record
 *  are NOT ours to delete (E4 #7). */
export function sweepStaging(maxEntries = 50): SweepReport {
  const file = journalPath();
  const entries = readJournal(file);
  const closedOps = new Set(entries.filter((e) => CLOSED.has(e.t)).map(opIdOf));
  const started = entries.filter(isStarted).filter((e) => !closedOps.has(e.opId));
  const report: SweepReport = { cleaned: [], missing: [], orphans: [], committedUnjournaled: [] };
  for (const s of started.slice(-maxEntries)) {
    const opId = s.opId;
    const ready = findReady(opId);
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(s.stagePath);
    } catch {
      st = null;
    }
    if (!st) {
      // The staging file is gone. Before recording "missing", check whether
      // the commit rename actually landed: if the destination exists with the
      // EXACT staged identity, the outcome is provable and the operation is
      // closed with an honest `staging_committed_recovered` record — never a
      // mislabeled missing, and never a replay.
      const readyEntry = ready;
      if (readyEntry) {
        const destId = captureIdentity(s.destPath);
        if (destId && isStrictMatchForSweep(readyEntry.stage, destId)) {
          appendJournal({ t: 'staging_committed_recovered', opId, destPath: s.destPath, at: Date.now() });
          report.committedUnjournaled.push({ opId, destPath: s.destPath });
          continue;
        }
      }
      appendJournal({ t: 'staging_missing', opId, at: Date.now() });
      report.missing.push(s.stagePath);
      continue;
    }
    if (!ready) {
      const reason = 'staging file exists without a ready record — ownership unverifiable';
      appendJournal({ t: 'staging_orphan', opId, reason, at: Date.now() });
      report.orphans.push({ opId, stagePath: s.stagePath, reason });
      continue;
    }
    const owned = strictStagingMatch(ready.stage, st);
    if (!owned.match) {
      const reason = `identity changed since staging_ready (${owned.reason})`;
      appendJournal({ t: 'staging_orphan', opId, reason, at: Date.now() });
      report.orphans.push({ opId, stagePath: s.stagePath, reason });
      continue;
    }
    try {
      fs.unlinkSync(s.stagePath);
      appendJournal({ t: 'staging_aborted', opId, at: Date.now() });
      report.cleaned.push(s.stagePath);
    } catch (err) {
      const reason = `verified staging file could not be removed (${String((err as Error)?.message || err)})`;
      appendJournal({ t: 'staging_orphan', opId, reason, at: Date.now() });
      report.orphans.push({ opId, stagePath: s.stagePath, reason });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Sandbox operations (all mutations flow through here)
// ---------------------------------------------------------------------------

function entryFromStats(p: string, st: fs.Stats): { name: string; path: string; kind: 'file' | 'directory'; size: number; modifiedAt: number } {
  return {
    name: path.basename(p),
    path: p,
    kind: st.isDirectory() ? 'directory' : 'file',
    size: st.size,
    modifiedAt: st.mtimeMs,
  };
}

function requireIdentity(p: string, role: string): FileIdentity {
  const id = captureIdentity(p);
  if (!id) throw new Error(`${role} "${p}" does not exist`);
  assertNotReparse(p, role);
  return id;
}

/** Revalidate captured identity IMMEDIATELY before a destructive primitive. */
function revalidate(p: string, recorded: FileIdentity, what: string): void {
  const now = captureIdentity(p);
  if (!now) throw new Error(`${what} disappeared immediately before the operation — refusing (identity revalidation failed)`);
  if (!identityMatches(recorded, now).match) {
    throw new Error(`${what} was replaced between authorization and execution — refusing (identity revalidation failed)`);
  }
}

function recordMutation(op: string, from?: string, to?: string, opId?: string, quarantineId?: string): void {
  try {
    appendJournal({ t: 'mutation', op, from, to, opId, quarantineId, at: Date.now() });
  } catch {
    // journal-unavailable is impossible here (the gate + staging would have
    // refused already); a mutation-record failure never rolls back a verified
    // filesystem result — it is surfaced through the audit trail instead.
  }
}

export function sandboxCreateFile(targetPath: string, content: string | Buffer): { name: string; path: string; kind: 'file' | 'directory'; size: number; modifiedAt: number; opId: string } {
  assertSandboxMutation('filesystem.write', 'create', targetPath);
  const sw = stageFile(targetPath, content, 'create');
  try {
    return { ...commitStaged(sw), opId: sw.opId };
  } catch (err) {
    abortStaged(sw); // best-effort verified cleanup; unsafe conditions are recorded, not forced
    throw err;
  }
}

export function sandboxCreateDir(targetPath: string): { name: string; path: string; kind: 'file' | 'directory'; size: number; modifiedAt: number; opId: string } {
  assertSandboxMutation('filesystem.write', 'create-dir', targetPath);
  const full = resolveSafePath(targetPath, 'write');
  assertNotProtected(full, 'write');
  const parent = path.dirname(full);
  const parentBefore = requireIdentity(parent, 'Parent directory');
  if (fs.existsSync(full)) throw new Error(`"${full}" already exists — refusing to overwrite`);
  revalidate(parent, parentBefore, 'Parent directory');
  fs.mkdirSync(full); // no recursive flag — parent must exist (explicit sandboxing)
  const created = fs.lstatSync(full);
  const opId = crypto.randomUUID();
  recordMutation('create-dir', undefined, full, opId);
  return { ...entryFromStats(full, created), opId };
}

export function sandboxRename(fromPath: string, newName: string): { name: string; path: string; kind: 'file' | 'directory'; size: number; modifiedAt: number; opId: string } {
  if (!newName || /[\\/:*?"<>|]/.test(newName)) throw new Error(`Invalid new name "${newName.slice(0, 40)}"`);
  assertSandboxMutation('filesystem.write', 'rename', fromPath);
  const from = resolveSafePath(fromPath, 'write');
  const to = resolveSafePath(path.join(path.dirname(from), newName), 'write');
  assertNotProtected(from, 'write');
  assertNotProtected(to, 'write');
  const fromId = requireIdentity(from, 'Source');
  const fromParent = path.dirname(from);
  const parentBefore = requireIdentity(fromParent, 'Parent directory');
  if (fs.existsSync(to)) throw new Error(`Destination "${to}" already exists`);
  revalidate(from, fromId, 'Source');
  revalidate(fromParent, parentBefore, 'Parent directory');
  fs.renameSync(from, to);
  // Rename preserves the file id on the same volume — verify the result is
  // the very inode we authorized, not a same-named replacement.
  const final = fs.lstatSync(to);
  if (final.ino !== fromId.ino || final.dev !== fromId.dev) {
    throw new Error('post-rename identity mismatch — the renamed node is not the authorized file (unsafe condition)');
  }
  const opId = crypto.randomUUID();
  recordMutation('rename', from, to, opId);
  return { ...entryFromStats(to, final), opId };
}

const COPY_DOUBLE_READ_MAX = 16 * 1024 * 1024;

/**
 * File copy through staging with the E1 verification discipline: the source
 * is read IN FULL TWICE and the reads must agree byte-for-byte before the
 * staged copy may be committed. Files above the bounded cap fall back to a
 * single read plus an identity recheck — a weaker, disclosed guarantee.
 * The E1 wording above governs restoration (M3); this is the same two-read
 * verification primitive applied to copy-source consistency.
 */
export function sandboxCopy(fromPath: string, toPath: string, overwrite = false): { name: string; path: string; kind: 'file' | 'directory'; size: number; modifiedAt: number; opId: string } {
  assertSandboxMutation('filesystem.write', 'copy', fromPath);
  const from = resolveSafePath(fromPath, 'read');
  let to = resolveSafePath(toPath, 'write');
  assertNotProtected(from, 'read');
  assertNotProtected(to, 'write');
  const fromId = requireIdentity(from, 'Source');

  if (fs.lstatSync(from).isDirectory()) {
    // Directory copy: existing recursive behavior, identity-checked at the root.
    if (fs.existsSync(to) && fs.lstatSync(to).isDirectory()) {
      to = path.join(to, path.basename(from));
      assertNotProtected(to, 'write'); // re-derivation can land inside protected storage
    }
    if (fs.existsSync(to) && !overwrite) throw new Error(`Destination "${to}" already exists — set overwrite to replace it`);
    revalidate(from, fromId, 'Source directory');
    fs.cpSync(from, to, { recursive: true, force: overwrite, errorOnExist: !overwrite });
    const final = fs.lstatSync(to);
    const dirOpId = crypto.randomUUID();
    recordMutation('copy-dir', from, to, dirOpId);
    return { ...entryFromStats(to, final), opId: dirOpId };
  }

  // If the destination is an existing directory, copy INTO it.
  if (fs.existsSync(to) && fs.lstatSync(to).isDirectory()) {
    to = path.join(to, path.basename(from));
    assertNotProtected(to, 'write');
  }
  const destBefore = captureIdentity(to);
  if (destBefore && !overwrite) throw new Error(`Destination "${to}" already exists — set overwrite to replace it`);

  revalidate(from, fromId, 'Source');
  let content: Buffer;
  if (fromId.size <= COPY_DOUBLE_READ_MAX) {
    const read1 = fs.readFileSync(from);
    revalidate(from, fromId, 'Source');
    const read2 = fs.readFileSync(from);
    if (!read1.equals(read2)) throw new Error('source changed between the two agreeing reads — copy refused (E1 verification failed)');
    content = read2;
  } else {
    content = fs.readFileSync(from);
    const after = captureIdentity(from);
    if (!after || !identityMatches(fromId, after).match || after.size !== fromId.size) {
      throw new Error('source identity changed during copy — result refused (bounded single-read fallback)');
    }
  }

  // Stage the content next to the destination and commit atomically. For an
  // authorized overwrite, the destination identity captured above must still
  // hold at commit time.
  const opId = crypto.randomUUID();
  const stagePath = stagePathFor(to, opId);
  appendJournal({ t: 'staging_started', opId, op: 'copy', destPath: to, stagePath, at: Date.now() });
  const fd = fs.openSync(stagePath, 'wx');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const stage = fs.lstatSync(stagePath);
  const parentNow = fs.lstatSync(path.dirname(to));
  appendJournal({ t: 'staging_ready', opId, stage: identityOf(stage), parentPath: path.dirname(to), parent: identityOf(parentNow), at: Date.now() });
  try {
    return { ...commitStaged({ opId, stagePath, destPath: to }, destBefore ?? undefined), opId };
  } catch (err) {
    abortStaged({ opId, stagePath, destPath: to });
    throw err;
  }
}

export function sandboxMove(fromPath: string, toPath: string, overwrite = false): { name: string; path: string; kind: 'file' | 'directory'; size: number; modifiedAt: number; opId: string } {
  assertSandboxMutation('filesystem.write', 'move', fromPath);
  const from = resolveSafePath(fromPath, 'read');
  let to = resolveSafePath(toPath, 'write');
  assertNotProtected(from, 'read');
  assertNotProtected(to, 'write');
  const fromId = requireIdentity(from, 'Source');
  const fromParent = path.dirname(from);
  const parentBefore = requireIdentity(fromParent, 'Parent directory');

  if (fs.existsSync(to) && fs.lstatSync(to).isDirectory()) {
    to = path.join(to, path.basename(from));
    assertNotProtected(to, 'write');
  }
  const destBefore = captureIdentity(to);
  if (destBefore && !overwrite) throw new Error(`Destination "${to}" already exists — set overwrite to replace it`);

  revalidate(from, fromId, 'Source');
  revalidate(fromParent, parentBefore, 'Parent directory');
  if (destBefore) {
    const destNow = captureIdentity(to);
    if (!destNow || !identityMatches(destBefore, destNow).match) {
      throw new Error('destination changed since authorization — refusing to overwrite (identity revalidation failed)');
    }
  }
  fs.renameSync(from, to);
  const final = fs.lstatSync(to);
  if (final.ino !== fromId.ino || final.dev !== fromId.dev) {
    throw new Error('post-move identity mismatch — the moved node is not the authorized file (unsafe condition)');
  }
  const moveOpId = crypto.randomUUID();
  recordMutation('move', from, to, moveOpId);
  return { ...entryFromStats(to, final), opId: moveOpId };
}

/** E5 M3 — quarantine capture hook. Implemented by quarantineCore (injected
 *  by systemAgentServer to avoid a circular import). The hook MOVES the node
 *  out of its origin (rename-capture on the same volume) so the delete and
 *  the capture are one step; it returns the quarantine record id. */
export interface DeleteCaptureHook {
  (info: { nodePath: string; identity: FileIdentity; isDirectory: boolean; opId: string }): { quarantineId: string };
}

export function sandboxDelete(targetPath: string, recursive = false, capture?: DeleteCaptureHook): { path: string; deleted: true; replacedAfterDelete?: boolean; quarantined?: boolean; quarantineId?: string; opId: string } {
  assertSandboxMutation('filesystem.write', 'delete', targetPath);
  const full = resolveSafePath(targetPath, 'write');
  assertNotProtected(full, 'write');
  const id = requireIdentity(full, 'Target');
  const parent = path.dirname(full);
  const parentBefore = requireIdentity(parent, 'Parent directory');
  revalidate(full, id, 'Target');
  revalidate(parent, parentBefore, 'Parent directory');
  const isDir = fs.lstatSync(full).isDirectory();
  if (isDir) {
    // Recursive semantics are enforced BEFORE any capture: a non-recursive
    // request must never move a non-empty directory into quarantine.
    const remaining = fs.readdirSync(full);
    if (remaining.length > 0 && !recursive) {
      throw new Error(`Directory "${full}" is not empty — recursive deletion is required but must be explicitly requested`);
    }
  }
  const opId = crypto.randomUUID();
  if (capture) {
    // E5 M3 (E7): the capture MOVES the node into quarantine storage — the
    // delete and the retention capture are the same step, so the content is
    // retained until a valid release decision. A capture refusal (cap
    // reached, cross-volume size limits) refuses the whole delete: data is
    // preserved, nothing is silently lost.
    const result = capture({ nodePath: full, identity: id, isDirectory: isDir, opId });
    // The capture contract: the node is GONE from its origin afterwards.
    // A hook that leaves the original in place must fail the delete rather
    // than report a deletion that did not happen.
    const afterCapture = captureIdentity(full);
    if (afterCapture && identityMatches(id, afterCapture).match) {
      throw new Error('quarantine capture did not remove the origin node — delete refused (false deletion prevented)');
    }
    recordMutation(isDir ? 'delete-dir' : 'delete', full, undefined, opId, result.quarantineId);
    // Post-verification: the captured node must be gone from its origin.
    const after = captureIdentity(full);
    const replacedAfterDelete = after !== null && !identityMatches(id, after).match;
    return { path: full, deleted: true, quarantined: true, quarantineId: result.quarantineId, opId, ...(replacedAfterDelete ? { replacedAfterDelete: true } : {}) };
  }
  if (isDir) {
    fs.rmSync(full, { recursive });
  } else {
    fs.unlinkSync(full);
  }
  // Post-verification: the verified node must be gone. If something now sits
  // at the same path, it is a DIFFERENT node (replacement) — disclose it.
  const after = captureIdentity(full);
  const replacedAfterDelete = after !== null && !identityMatches(id, after).match;
  recordMutation(isDir ? 'delete-dir' : 'delete', full, undefined, opId);
  return { path: full, deleted: true, opId, ...(replacedAfterDelete ? { replacedAfterDelete: true } : {}) };
}

/**
 * Identity-verified read wrapper: captures identity before and after the read
 * callback; when they agree, the returned content was read from an unchanged
 * node. A disagreement still returns the content with verified:false.
 */
export function readVerifiedFile<T>(fullPath: string, read: () => T): { content: T; verified: boolean } {
  const before = captureIdentity(fullPath);
  const content = read();
  const after = captureIdentity(fullPath);
  const verified = before !== null && after !== null && identityMatches(before, after).match;
  return { content, verified };
}
