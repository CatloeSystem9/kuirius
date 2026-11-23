/**
 * LPV — Local Private Vault core (post-roadmap capability).
 *
 * Encrypted, local-only credential storage for Krisha. The vault lives in a
 * dedicated subdirectory of the E5 protected store (serverSafety.ts), so it
 * inherits every protection that store already has: outside every
 * model-writable filesystem root, refused to the filesystem agent
 * (assertNotProtected), skipped by fsSearch, never OneDrive-synced, and
 * surfaced to the integrity monitor via the shared storage info.
 *
 * Crypto design (hardened):
 *   - Master key: 32 random bytes (crypto.randomBytes), generated once at
 *     vault creation, wrapped with Windows DPAPI (CurrentUser scope, see
 *     lpvDpapi.ts) and stored SEPARATELY from the encrypted data
 *     (key.blob vs vault.json). Never hardcoded, never in env/argv/logs.
 *   - HKDF domain-separated subkeys: `enc` for per-entry AES-256-GCM
 *     (random 12-byte IV per save, AAD binds {id, categoryKey, updatedAt} so
 *     ciphertexts cannot be relocated or spliced) and `mac` for HMAC-SHA256
 *     over the canonical FULL vault document — policy and plaintext metadata
 *     included — so deliberate modification is detected, not just accidental
 *     corruption.
 *   - Account binding: the DPAPI-wrapping Windows account SID is recorded at
 *     creation and re-verified at every unlock; mismatch → refuse.
 *   - Generation tracking: every mutation increments a monotonic generation;
 *     vault.json.bak holds the previous document; inconsistent generations →
 *     TAMPERED. Corruption/tamper is ALWAYS fail-closed: nothing is ever
 *     silently recreated, reset, or repaired. The only recovery paths are
 *     the explicit operator "restore previous generation" action (which
 *     re-verifies the MAC of the backup) or a documented manual reset.
 *
 * Authorization design (hardened):
 *   - Fill grants are server-minted, SINGLE-USE, ≤60 s TTL, and bound to
 *     {entryId, operation, approved origin}. They are issued ONLY by explicit
 *     user approval (operator UI click, or an approval challenge approved
 *     through the operator UI card). The model can request a challenge; it
 *     can never approve one, and no endpoint ever returns a secret.
 *   - Fill verifies the page origin BEFORE typing (CDP top-frame URL origin
 *     must equal the grant's approved origin), requires the password field to
 *     be a real input[type=password], ignores iframes, refuses navigation
 *     detected between pre-check and post-check, and returns metadata only.
 *   - A locked vault refuses every retrieval and fill path (enforced in the
 *     route layer AND here). Metadata listing and audit history stay
 *     available (they contain no secrets); metadata read while locked is
 *     served flagged `verified:false` because the HMAC cannot be checked
 *     without the unwrapped key.
 *
 * Locking (precise): boot is ALWAYS locked. Auto-lock fires after
 * `policy.autoLockMs` without AUTHORIZED vault activity — read-only polls,
 * status and metadata listing never reset the idle timer; mutations, unlock
 * and approved fills do. An in-flight fill completes before auto-lock.
 * Locking zeroes the master key and both subkeys. Shutdown hooks lock on
 * SIGINT/SIGTERM/beforeExit (re-raising the signal to preserve default exit
 * semantics).
 *
 * Degraded mode (strict): when storage protection is `degraded` or
 * `unavailable`, ALL vault writes, unlock, auto-saving and filling are
 * refused. Status, metadata listing and audit history remain readable so the
 * operator can see state. Guarantees are never quietly weakened to keep the
 * vault available.
 *
 * Retention policy:
 *   - Category A (approval required, never auto-saved): built-in google,
 *     email_primary, banking, payment — and EVERY unclassified or
 *     user-defined category defaults to A.
 *   - Category B (auto-save possible): only categories the user explicitly
 *     enabled in policy.autoSaveCategories, gated additionally by the master
 *     autoSaveEnabled toggle.
 *   - Category C (never stored): OTPs, temporary codes, CVVs and other
 *     short-lived verification secrets are refused via an explicit label
 *     rejection table plus shape rules; ANY uncertain match refuses the save
 *     (fail-closed). The heuristics are best-effort and are never claimed to
 *     catch every temporary secret.
 *
 * Honest limits (do not weaken these disclosures):
 *   - Same-user local processes can access what the OS lets them access —
 *     the same documented E5 trust boundary. DPAPI + the loopback server +
 *     knowledge gating narrow the adversary; they do not defeat a determined
 *     same-user actor.
 *   - Plaintext secrets exist transiently in the server process and in the
 *     target page during a fill (inherent to filling). JS string copies
 *     cannot be force-zeroed; Buffer copies the module owns are zeroed.
 *   - Secure delete removes the ciphertext from the live document and the
 *     previous generation; NTFS may retain freed clusters (and system shadow
 *     copies may exist). Full media sanitization is out of scope.
 *   - OTP/temp-secret detection is heuristic and fail-closed, not perfect.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  getStorageInfo,
  durableWrite,
  appendAuditSyncSafe,
  serverPermissions,
  stopKind,
} from './serverSafety';
import { dpapiProtect, dpapiUnprotect, dpapiCurrentSid } from './lpvDpapi';
import { browserPageState, browserFillFields } from './browserCdp';

// ---------------------------------------------------------------------------
// Errors — typed kinds so routes never have to guess and logs never need
// secret-bearing messages.
// ---------------------------------------------------------------------------

export type LpvErrorKind =
  | 'vault_locked'
  | 'vault_tampered'
  | 'vault_uninitialized'
  | 'storage_unavailable'
  | 'degraded_mode'
  | 'account_mismatch'
  | 'key_unwrap_failed'
  | 'temporary_secret_refused'
  | 'approval_required'
  | 'approval_invalid'
  | 'grant_invalid'
  | 'grant_expired'
  | 'entry_not_found'
  | 'invalid_input'
  | 'no_destination'
  | 'origin_mismatch'
  | 'page_not_ready'
  | 'field_not_found'
  | 'field_not_password'
  | 'fill_navigation_detected'
  | 'policy_violation'
  | 'emergency_stop_active'
  | 'audit_unavailable';

export class LpvError extends Error {
  constructor(public readonly kind: LpvErrorKind, message: string) {
    super(message);
    this.name = 'LpvError';
  }
}

function lerr(kind: LpvErrorKind, message: string): never {
  throw new LpvError(kind, message);
}

// ---------------------------------------------------------------------------
// File layout (inside the E5 protected store)
// ---------------------------------------------------------------------------

const LPV_DIR = 'lpv';
const VAULT_FILE = 'vault.json';
const VAULT_BAK_FILE = 'vault.json.bak';
const KEY_FILE = 'key.blob';
const ACCOUNT_FILE = 'account.json';
const AUDIT_SUBDIR = 'audit';
const AUDIT_FILE = 'lpv-audit.jsonl';

const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 200;
const MAX_ENTRY_SECRETS_LEN = 512;
const CHALLENGE_TTL_MS = 10 * 60_000;
const GRANT_TTL_MS = 60_000;
const MAX_CHALLENGES = 16;
const MAX_GRANTS = 16;
const HISTORY_SERVE_LIMIT = 200;
const AUTOLOCK_TICK_MS = 15_000;
export const DEFAULT_AUTO_LOCK_MS = 300_000;
const AUTO_LOCK_MIN_MS = 30_000;
const AUTO_LOCK_MAX_MS = 60 * 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VaultState = 'UNINITIALIZED' | 'LOCKED' | 'UNLOCKED' | 'TAMPERED' | 'UNAVAILABLE';
export type VaultCategory = 'A' | 'B';

export interface VaultEntryMeta {
  id: string;
  categoryKey: string;
  category: VaultCategory;
  title: string;
  hasUsername: boolean;
  hasNotes: boolean;
  url: string | null;
  createdAt: number;
  updatedAt: number;
  lastRetrievedAt: number | null;
  retrieveCount: number;
}

export interface VaultPolicy {
  autoSaveEnabled: boolean;
  autoSaveCategories: Record<string, boolean>;
  autoLockMs: number;
}

export interface EntrySecrets {
  username: string;
  password: string;
  notes: string;
}

interface EncryptedEntry extends VaultEntryMeta {
  iv: string;
  ciphertext: string;
  tag: string;
}

interface VaultDocument {
  schemaVersion: number;
  generation: number;
  entries: EncryptedEntry[];
  policy: VaultPolicy;
  updatedAt: number;
}

interface VaultFile extends VaultDocument {
  mac: string;
}

export type SaveApproval =
  | { kind: 'user-direct' }
  | { kind: 'challenge'; challengeId: string }
  | { kind: 'policy-auto' };

export interface VaultStatus {
  state: VaultState;
  initialized: boolean;
  locked: boolean;
  protection: string;
  storageRoot: string | null;
  entryCount: number;
  generation: number | null;
  verified: boolean;
  autoLockMs: number;
  lastActivityAt: number | null;
  fillsInFlight: number;
}

// ---------------------------------------------------------------------------
// Category policy
// ---------------------------------------------------------------------------

const BUILT_IN_CATEGORY_A = new Set(['google', 'email_primary', 'banking', 'payment']);

/** Category C rejection table — explicit labels that must never be stored. */
const TEMP_SECRET_LABELS: RegExp[] = [
  /\botp\b/i,
  /\bone[-\s]?time\s+(?:password|code|pin)\b/i,
  /\bverification\s+code\b/i,
  /\bverify\s+code\b/i,
  /\bsecurity\s+code\b/i,
  /\bcvv2?\b/i,
  /\bcvc\b/i,
  /\bcard\s+(?:verification|security)\s+code\b/i,
  /\b2fa\s+code\b/i,
  /\btwo[-\s]?factor\s+code\b/i,
  /\bauthenticator\s+code\b/i,
  /\btotp\s+(?:seed|secret|key)\b/i,
  /\btemp(?:orary)?\s+code\b/i,
];

const CODE_CONTEXT = /\b(?:code|otp|pin|verif|2fa|auth)\b/i;
const KEY_CONTEXT = /\b(?:secret|key|seed|totp|2fa|authenticator)\b/i;
const BASE32_RE = /^[A-Z2-7]{16,}$/;

export interface SaveCandidate {
  categoryKey: string;
  title: string;
  username?: string;
  password?: string;
  notes?: string;
  url?: string;
}

/**
 * Category C detection (fail-closed). Returns a refusal reason when the
 * candidate matches the temporary-secret rejection table, or null when no
 * rule fired. Best-effort by design — an uncertain candidate for STORAGE
 * CLASSIFICATION defaults to Category A behavior instead.
 */
export function detectTemporarySecret(candidate: SaveCandidate): string | null {
  const labels = [candidate.title, candidate.categoryKey, candidate.username ?? '', candidate.notes ?? '', candidate.url ?? '']
    .map((s) => String(s ?? ''));
  for (const label of labels) {
    for (const re of TEMP_SECRET_LABELS) {
      if (re.test(label)) return `label matched temporary-secret rule ${re.source}`;
    }
  }
  const password = String(candidate.password ?? '');
  if (password) {
    const context = labels.join(' ');
    // 6–8 digit value in a code-labeled field.
    if (/^\d{6,8}$/.test(password) && CODE_CONTEXT.test(context)) {
      return 'short numeric code in a code-labeled entry';
    }
    // Base32 TOTP-seed shape in a secret/key/seed-labeled field.
    if (BASE32_RE.test(password) && KEY_CONTEXT.test(context)) {
      return 'base32 seed shape in a key/seed-labeled entry';
    }
  }
  return null;
}

function classifyCategory(categoryKey: string, policy: VaultPolicy): VaultCategory {
  const key = categoryKey.toLowerCase();
  if (BUILT_IN_CATEGORY_A.has(key)) return 'A';
  if (policy.autoSaveCategories[key] === true) return 'B';
  // Unclassified and user-defined categories default to A (fail-closed).
  return 'A';
}

function isAutoSaveAllowed(categoryKey: string, category: VaultCategory, policy: VaultPolicy): boolean {
  if (category !== 'B') return false;
  if (!policy.autoSaveEnabled) return false;
  return policy.autoSaveCategories[categoryKey.toLowerCase()] === true;
}

// ---------------------------------------------------------------------------
// Crypto primitives
// ---------------------------------------------------------------------------

const HKDF_SALT = 'krisha-lpv-v1';

function hkdf(master: Buffer, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from(HKDF_SALT, 'utf8'), Buffer.from(info, 'utf8'), 32));
}

function deriveSubkeys(master: Buffer): { enc: Buffer; mac: Buffer } {
  return { enc: hkdf(master, 'krisha-lpv-enc-v1'), mac: hkdf(master, 'krisha-lpv-mac-v1') };
}

function zeroBuffer(b: Buffer | null | undefined): void {
  if (b && b.length > 0) b.fill(0);
}

/** Canonical serialization — fixed key order, no optional-key drift. */
function canonicalDocJson(doc: VaultDocument): string {
  return JSON.stringify({
    schemaVersion: doc.schemaVersion,
    generation: doc.generation,
    entries: doc.entries,
    policy: {
      autoSaveEnabled: doc.policy.autoSaveEnabled,
      autoSaveCategories: doc.policy.autoSaveCategories,
      autoLockMs: doc.policy.autoLockMs,
    },
    updatedAt: doc.updatedAt,
  });
}

function macDocument(macKey: Buffer, doc: VaultDocument): string {
  return crypto.createHmac('sha256', macKey).update(canonicalDocJson(doc), 'utf8').digest('hex');
}

function timingSafeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function encryptEntryPayload(encKey: Buffer, entry: EncryptedEntry, secrets: EntrySecrets): void {
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from(
    JSON.stringify({ id: entry.id, categoryKey: entry.categoryKey, updatedAt: entry.updatedAt }),
    'utf8'
  );
  const plain = Buffer.from(JSON.stringify(secrets), 'utf8');
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    entry.iv = iv.toString('base64');
    entry.ciphertext = ct.toString('base64');
    entry.tag = cipher.getAuthTag().toString('base64');
  } finally {
    plain.fill(0);
  }
}

function decryptEntryPayload(encKey: Buffer, entry: EncryptedEntry): EntrySecrets {
  const aad = Buffer.from(
    JSON.stringify({ id: entry.id, categoryKey: entry.categoryKey, updatedAt: entry.updatedAt }),
    'utf8'
  );
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(entry.iv, 'base64'), {
    authTagLength: 16,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, 'base64')), decipher.final()]);
  try {
    const parsed = JSON.parse(plain.toString('utf8')) as EntrySecrets;
    if (typeof parsed?.password !== 'string') throw new Error('payload shape invalid');
    return { username: String(parsed.username ?? ''), password: parsed.password, notes: String(parsed.notes ?? '') };
  } finally {
    plain.fill(0);
  }
}

// ---------------------------------------------------------------------------
// LPV audit — hash-chained, fsync-per-entry (mirrors the E5 audit pattern).
// Records carry METADATA ONLY: never credentials, OTPs, keys or payloads.
// ---------------------------------------------------------------------------

interface AuditInput {
  kind: string;
  [key: string]: unknown;
}

function auditPath(): string | null {
  if (!vaultDir) return null;
  return path.join(vaultDir, AUDIT_SUBDIR, AUDIT_FILE);
}

function readAuditTail(): { state: 'empty' | 'ok' | 'lost'; seq: number; prevHash: string } {
  const file = auditPath();
  if (!file) return { state: 'lost', seq: 0, prevHash: 'genesis' };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { state: 'lost', seq: 0, prevHash: 'genesis' };
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return { state: 'empty', seq: 0, prevHash: 'genesis' };
  try {
    const rec = JSON.parse(lines[lines.length - 1]) as { seq?: unknown; prevHash?: unknown; hash?: unknown };
    if (typeof rec.seq !== 'number' || typeof rec.prevHash !== 'string' || typeof rec.hash !== 'string') {
      return { state: 'lost', seq: 0, prevHash: 'genesis' };
    }
    const { hash, ...rest } = rec;
    const computed = crypto.createHash('sha256').update(JSON.stringify(rest), 'utf8').digest('hex');
    if (rec.hash !== computed) return { state: 'lost', seq: 0, prevHash: 'genesis' };
    return { state: 'ok', seq: rec.seq, prevHash: rec.hash };
  } catch {
    return { state: 'lost', seq: 0, prevHash: 'genesis' };
  }
}

function appendLpvAudit(entry: AuditInput): void {
  const file = auditPath();
  if (!file) throw new LpvError('audit_unavailable', 'LPV audit unavailable (no store root)');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fileExists = (() => {
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  })();
  const tail = readAuditTail();
  const lost = !fileExists || tail.state === 'lost';
  const writeRecord = (record: Record<string, unknown>): void => {
    const hash = crypto.createHash('sha256').update(JSON.stringify(record), 'utf8').digest('hex');
    const line = JSON.stringify({ ...record, hash }) + '\n';
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  if (lost) {
    // Explicit restart marker — a broken chain is never silently continued.
    writeRecord({ seq: 1, prevHash: 'genesis', at: Date.now(), kind: 'lpv_audit_chain_restarted' });
  }
  const next = readAuditTail();
  const record = {
    seq: next.state === 'ok' ? next.seq + 1 : 1,
    prevHash: next.state === 'ok' ? next.prevHash : 'genesis',
    at: Date.now(),
    ...entry,
  };
  writeRecord(record);
  // Phase E observation sink (additive, best-effort): lets the security
  // event-intelligence layer consume LPV security-decision metadata AFTER
  // the record is durably written. Purely outbound — LPV security behavior,
  // storage, and chain verification are untouched; a sink failure can never
  // affect the audit or the vault.
  try {
    lpvSecurityEventSink?.(record);
  } catch { /* observation must never break the audit */ }
}

/** Optional outbound observer for the Phase E security event-intelligence
 *  layer (see appendLpvAudit). Additive only: setting/clearing it has no
 *  effect on LPV security behavior. */
let lpvSecurityEventSink: ((record: Record<string, unknown>) => void) | null = null;
export function setLpvSecurityEventSink(fn: ((record: Record<string, unknown>) => void) | null): void {
  lpvSecurityEventSink = fn;
}

/** Full bounded chain walk — REQUIRED before audit history is trusted. */
export function verifyLpvAuditChain(): {
  ok: boolean;
  entries: number;
  firstBrokenLine: number | null;
  reason: string | null;
} {
  const file = auditPath();
  if (!file) return { ok: false, entries: 0, firstBrokenLine: null, reason: 'no store root' };
  let raw: string;
  const filePresent = (() => {
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  })();
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    if (filePresent) return { ok: false, entries: 0, firstBrokenLine: null, reason: 'audit file present but unreadable' };
    return { ok: true, entries: 0, firstBrokenLine: null, reason: 'no audit file yet' };
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  let seq = 0;
  let prevHash = 'genesis';
  let firstBrokenLine: number | null = null;
  let reason: string | null = null;
  const fail = (lineNo: number, why: string): void => {
    if (firstBrokenLine === null) {
      firstBrokenLine = lineNo;
      reason = why;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let rec: { seq?: unknown; prevHash?: unknown; hash?: unknown; kind?: unknown };
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      fail(lineNo, `torn or unparseable audit line ${lineNo}`);
      continue;
    }
    const { hash, ...rest } = rec as Record<string, unknown>;
    const computed = crypto.createHash('sha256').update(JSON.stringify(rest), 'utf8').digest('hex');
    if (rec.kind === 'lpv_audit_chain_restarted') {
      if (rec.seq !== 1 || rec.prevHash !== 'genesis') {
        fail(lineNo, `restart marker at line ${lineNo} does not start a fresh segment`);
        continue;
      }
      if (rec.hash !== computed) {
        fail(lineNo, `restart marker hash mismatch at line ${lineNo}`);
        continue;
      }
      seq = 1;
      prevHash = rec.hash as string;
      continue;
    }
    if (rec.seq !== seq + 1 || rec.prevHash !== prevHash) {
      fail(lineNo, `chain discontinuity at line ${lineNo}`);
      continue;
    }
    if (rec.hash !== computed) {
      fail(lineNo, `record hash mismatch at line ${lineNo}`);
      continue;
    }
    seq = rec.seq as number;
    prevHash = rec.hash as string;
  }
  return { ok: firstBrokenLine === null, entries: lines.length, firstBrokenLine, reason };
}

// ---------------------------------------------------------------------------
// Module state (all resolved synchronously at import; NO async work at boot)
// ---------------------------------------------------------------------------

let vaultDir: string | null = null;
let state: VaultState = 'UNAVAILABLE';
let tamperReason: string | null = null;
let doc: VaultDocument | null = null; // ciphertext + metadata only — never plaintext
let docVerified = false;
let masterKey: Buffer | null = null; // exists ONLY while unlocked
let subkeys: { enc: Buffer; mac: Buffer } | null = null; // ONLY while unlocked
let lastActivityAt = 0;
let fillsInFlight = 0;
let autoLockTimer: NodeJS.Timeout | null = null;
let shutdownHooked = false;
let nowFn: () => number = Date.now; // injectable clock (tests)

const challenges = new Map<
  string,
  {
    id: string;
    purpose: 'save' | 'fill';
    entryId?: string;
    origin?: string;
    entryDraft?: { categoryKey: string; title: string; url?: string };
    /** Fill challenges carry the EXACT operation the operator approves
     *  (field specs only — no values; values come from the vault at
     *  execution). Approval executes this operation server-side, so no
     *  grant capability is ever handed to the requester. */
    fields?: FillFieldSpec[];
    /** Server-minted one-time decision token, delivered ONLY through the
     *  operator's pending-approvals listing (the human-facing card). The
     *  approve/decline routes require it — a blind approve(challengeId)
     *  call that never read the operator-facing pending list is refused. */
    decisionToken: string;
    /** Metadata-only outcome of an approval-executed fill (no secrets). */
    fillOutcome?: { at: number; url: string; filled: Array<{ secret: string; filled: boolean; matched?: string; reason?: string }> };
    requester: string;
    createdAt: number;
    expiresAt: number;
    state: 'pending' | 'approved' | 'declined';
  }
>();

const grants = new Map<
  string,
  { grantId: string; op: 'fill'; entryId: string; origin: string; issuedAt: number; expiresAt: number; used: boolean }
>();

function vaultFilePath(name: string): string {
  if (!vaultDir) throw new LpvError('storage_unavailable', 'no protected store root');
  return path.join(vaultDir, name);
}

function readRaw(file: string): string | null {
  try {
    const data = fs.readFileSync(file, 'utf8');
    return data.length > 0 ? data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Boot (synchronous): resolve store, derive initial state — ALWAYS LOCKED.
// ---------------------------------------------------------------------------

function resolveBootStateSync(): void {
  const store = getStorageInfo();
  if (!store.root || store.protection === 'unavailable') {
    vaultDir = null;
    state = 'UNAVAILABLE';
    return;
  }
  vaultDir = path.join(store.root, LPV_DIR);
  const hasVault = readRaw(vaultFilePath(VAULT_FILE)) !== null;
  const hasKey = readRaw(vaultFilePath(KEY_FILE)) !== null;
  const hasAccount = readRaw(vaultFilePath(ACCOUNT_FILE)) !== null;
  if (!hasVault && !hasKey) {
    state = 'UNINITIALIZED';
    doc = null;
    return;
  }
  if (hasVault && hasKey && hasAccount) {
    try {
      JSON.parse(readRaw(vaultFilePath(VAULT_FILE))!);
      state = 'LOCKED'; // verification (MAC + generations) happens at unlock
      return;
    } catch (err) {
      state = 'TAMPERED';
      tamperReason = `vault file unparseable: ${String((err as Error)?.message || err).slice(0, 120)}`;
      return;
    }
  }
  // Partial store: data without key, key without data, or missing account
  // binding — fail closed, never recreate.
  state = 'TAMPERED';
  tamperReason = 'incomplete vault store (vault/key/account files inconsistent)';
}

// ---------------------------------------------------------------------------
// Document load + verification
// ---------------------------------------------------------------------------

function parseVaultFile(raw: string): VaultFile {
  const parsed = JSON.parse(raw) as VaultFile;
  if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
  if (parsed.schemaVersion !== SCHEMA_VERSION) throw new Error(`schema version ${String(parsed.schemaVersion)} unsupported`);
  if (!Number.isInteger(parsed.generation) || parsed.generation < 1) throw new Error('generation invalid');
  if (!Array.isArray(parsed.entries)) throw new Error('entries invalid');
  if (!parsed.policy || typeof parsed.policy !== 'object') throw new Error('policy invalid');
  if (typeof parsed.policy.autoSaveEnabled !== 'boolean') throw new Error('policy.autoSaveEnabled invalid');
  if (typeof parsed.policy.autoSaveCategories !== 'object' || parsed.policy.autoSaveCategories === null) {
    throw new Error('policy.autoSaveCategories invalid');
  }
  if (!Number.isFinite(parsed.policy.autoLockMs)) throw new Error('policy.autoLockMs invalid');
  if (typeof parsed.updatedAt !== 'number') throw new Error('updatedAt invalid');
  if (typeof parsed.mac !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.mac)) throw new Error('mac invalid');
  const ids = new Set<string>();
  for (const e of parsed.entries) {
    if (!e || typeof e.id !== 'string' || ids.has(e.id)) throw new Error('entry id invalid or duplicated');
    ids.add(e.id);
    if (typeof e.iv !== 'string' || typeof e.ciphertext !== 'string' || typeof e.tag !== 'string') {
      throw Error('entry ciphertext fields invalid');
    }
  }
  return parsed;
}

function stripToDocument(file: VaultFile): VaultDocument {
  return {
    schemaVersion: file.schemaVersion,
    generation: file.generation,
    entries: file.entries,
    policy: {
      autoSaveEnabled: file.policy.autoSaveEnabled,
      autoSaveCategories: { ...file.policy.autoSaveCategories },
      autoLockMs: file.policy.autoLockMs,
    },
    updatedAt: file.updatedAt,
  };
}

/** Metadata-only load while LOCKED (no MAC possible without the key). */
function loadDocumentUnverified(): void {
  if (!vaultDir || doc) return;
  const raw = readRaw(vaultFilePath(VAULT_FILE));
  if (raw === null) return;
  try {
    doc = stripToDocument(parseVaultFile(raw));
  } catch (err) {
    state = 'TAMPERED';
    tamperReason = `vault file unparseable: ${String((err as Error)?.message || err).slice(0, 120)}`;
    doc = null;
  }
}

/** Full verified load at unlock: MAC + generation consistency (fail-closed). */
function loadDocumentVerified(): void {
  const raw = readRaw(vaultFilePath(VAULT_FILE));
  if (raw === null) {
    enterTampered('vault file missing at unlock');
    return;
  }
  let file: VaultFile;
  try {
    file = parseVaultFile(raw);
  } catch (err) {
    enterTampered(`vault file invalid: ${String((err as Error)?.message || err).slice(0, 120)}`);
    return;
  }
  // Generation consistency against the previous-generation backup.
  const bakRaw = readRaw(vaultFilePath(VAULT_BAK_FILE));
  if (bakRaw !== null) {
    try {
      const bak = parseVaultFile(bakRaw);
      if (bak.generation > file.generation) {
        enterTampered(`generation inconsistency: backup generation ${bak.generation} exceeds primary ${file.generation}`);
        return;
      }
    } catch {
      // An unparseable backup is not evidence of primary tampering — the
      // primary MAC below is the authority. The backup is stale/lost.
    }
  }
  if (!subkeys) {
    enterTampered('internal: keys unavailable during verified load');
    return;
  }
  if (!timingSafeEq(macDocument(subkeys.mac, stripToDocument(file)), file.mac)) {
    enterTampered('vault HMAC verification failed — the document was modified without the master key');
    return;
  }
  doc = stripToDocument(file);
  docVerified = true;
}

function enterTampered(reason: string): void {
  zeroBuffer(masterKey);
  masterKey = null;
  if (subkeys) {
    zeroBuffer(subkeys.enc);
    zeroBuffer(subkeys.mac);
    subkeys = null;
  }
  state = 'TAMPERED';
  tamperReason = reason;
  doc = null;
  docVerified = false;
  stopAutoLockTimer();
  try {
    appendLpvAudit({ kind: 'lpv_tamper_detected', reason: reason.slice(0, 160) });
  } catch {
    /* audit failure must not mask the tamper state */
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function persistVault(): void {
  if (!doc || !subkeys) throw new LpvError('vault_locked', 'persist requires an unlocked vault');
  const primary = vaultFilePath(VAULT_FILE);
  // Previous generation → backup BEFORE the primary is replaced.
  const currentRaw = readRaw(primary);
  if (currentRaw !== null) {
    durableWrite(vaultFilePath(VAULT_BAK_FILE), currentRaw);
  }
  const mac = macDocument(subkeys.mac, doc);
  durableWrite(primary, JSON.stringify({ ...doc, mac }, null, 2));
}

function assertWritableEnvironment(): void {
  const store = getStorageInfo();
  if (!store.root || store.protection === 'unavailable') {
    lerr('storage_unavailable', 'protected storage unavailable — vault operations refused');
  }
  if (store.protection === 'degraded') {
    lerr(
      'degraded_mode',
      'protected storage is DEGRADED — vault writes, unlock and filling are disabled until protection is restored'
    );
  }
}

function assertUnlocked(): void {
  if (state === 'TAMPERED') lerr('vault_tampered', `vault is TAMPERED and refuses all operations (${tamperReason ?? 'integrity failure'})`);
  if (state === 'UNINITIALIZED') lerr('vault_uninitialized', 'vault is not initialized');
  if (state === 'UNAVAILABLE') lerr('storage_unavailable', 'protected storage unavailable');
  if (state !== 'UNLOCKED' || !subkeys || !doc) lerr('vault_locked', 'vault is locked — unlock required for this operation');
}

/** In-process emergency-stop gate (defense in depth alongside the route
 *  layer's stopBlock): retrieval and mutation entry points re-check the E5
 *  stop authority directly, so no caller that reaches the core — today the
 *  HTTP routes, tomorrow any in-process consumer — can bypass the stop. */
function assertStopInactive(): void {
  const kind = stopKind();
  if (kind !== 'INACTIVE') {
    appendLpvAudit({ kind: 'lpv_stop_blocked', stopKind: kind });
    lerr('emergency_stop_active', kind === 'ACTIVE_UNCERTAIN' ? 'emergency stop is UNCERTAIN — operations refused' : 'emergency stop is ACTIVE — operations refused');
  }
}

function noteActivity(): void {
  lastActivityAt = nowFn();
}

/** Read the live state through a function boundary: TS narrows the module
 *  variable across opaque calls (functions like enterTampered mutate it), so
 *  direct comparisons after such calls would be falsely "unreachable". */
function currentState(): VaultState {
  return state;
}

// ---------------------------------------------------------------------------
// Auto-lock (precise)
// ---------------------------------------------------------------------------

function stopAutoLockTimer(): void {
  if (autoLockTimer) {
    clearInterval(autoLockTimer);
    autoLockTimer = null;
  }
}

function startAutoLockTimer(): void {
  stopAutoLockTimer();
  autoLockTimer = setInterval(() => {
    try {
      evaluateAutoLock();
    } catch {
      /* never let the tick crash the process */
    }
  }, AUTOLOCK_TICK_MS);
  autoLockTimer.unref();
}

/** Idle evaluation: fires ONLY after `autoLockMs` without authorized vault
 *  activity; read-only polls never reset the timer; an in-flight fill is
 *  allowed to finish first. Injectable clock → deterministic in tests. */
function evaluateAutoLock(): void {
  if (state !== 'UNLOCKED' || !doc) return;
  if (fillsInFlight > 0) return;
  const ms = Math.min(AUTO_LOCK_MAX_MS, Math.max(AUTO_LOCK_MIN_MS, doc.policy.autoLockMs));
  if (nowFn() - lastActivityAt >= ms) {
    lockVault('auto-lock');
  }
}

// ---------------------------------------------------------------------------
// Lock / unlock / init
// ---------------------------------------------------------------------------

export async function initializeVault(): Promise<{ created: boolean }> {
  const store = getStorageInfo();
  if (!store.root || store.protection === 'unavailable') {
    lerr('storage_unavailable', 'protected storage unavailable — vault cannot be created');
  }
  if (store.protection === 'degraded') {
    lerr('degraded_mode', 'protected storage is DEGRADED — the vault will not be created in a weaker environment');
  }
  if (state === 'TAMPERED') lerr('vault_tampered', `vault is TAMPERED (${tamperReason ?? 'integrity failure'}) — manual recovery required`);
  if (state === 'UNLOCKED' || state === 'LOCKED') lerr('invalid_input', 'vault already exists');
  if (state === 'UNAVAILABLE') lerr('storage_unavailable', 'protected storage unavailable');

  // DPAPI probe — fail-closed if the OS facility is missing.
  const sid = await dpapiCurrentSid();
  const master = crypto.randomBytes(32);
  try {
    const blob = await dpapiProtect(master);
    fs.mkdirSync(vaultDir!, { recursive: true });
    durableWrite(vaultFilePath(KEY_FILE), blob.toString('base64'));
    durableWrite(vaultFilePath(ACCOUNT_FILE), JSON.stringify({ schemaVersion: 1, sid, createdAt: nowFn() }));

    const newDoc: VaultDocument = {
      schemaVersion: SCHEMA_VERSION,
      generation: 1,
      entries: [],
      policy: { autoSaveEnabled: false, autoSaveCategories: {}, autoLockMs: DEFAULT_AUTO_LOCK_MS },
      updatedAt: nowFn(),
    };
    const tempSubkeys = deriveSubkeys(master);
    try {
      const mac = macDocument(tempSubkeys.mac, newDoc);
      durableWrite(vaultFilePath(VAULT_FILE), JSON.stringify({ ...newDoc, mac }, null, 2));
    } finally {
      zeroBuffer(tempSubkeys.enc);
      zeroBuffer(tempSubkeys.mac);
    }
  } finally {
    zeroBuffer(master);
  }
  doc = null;
  docVerified = false;
  state = 'LOCKED';
  appendLpvAudit({ kind: 'lpv_created' });
  appendAuditSyncSafe({ kind: 'lpv_created' });
  hookShutdown();
  return { created: true };
}

// Repair D4: unlock calls are SERIALIZED. Two concurrent unlocks would both
// pass the LOCKED check and each DPAPI-unwrap a master key; the first
// buffer would be overwritten by the second WITHOUT being zeroed — an
// unzeroed key copy in the heap. The chain below makes unlock operations
// strictly sequential; a later call re-checks the (possibly now unlocked)
// state inside doUnlockVault.
let unlockChain: Promise<unknown> = Promise.resolve();

export function unlockVault(): Promise<{ unlocked: boolean; alreadyUnlocked: boolean }> {
  const run = unlockChain.then(() => doUnlockVault());
  unlockChain = run.catch(() => undefined);
  return run;
}

async function doUnlockVault(): Promise<{ unlocked: boolean; alreadyUnlocked: boolean }> {
  if (state === 'TAMPERED') lerr('vault_tampered', `vault is TAMPERED (${tamperReason ?? 'integrity failure'}) — all operations refused`);
  if (state === 'UNAVAILABLE') lerr('storage_unavailable', 'protected storage unavailable');
  if (state === 'UNINITIALIZED') lerr('vault_uninitialized', 'vault is not initialized');
  assertWritableEnvironment(); // degraded → unlock refused (directive 4)
  if (state === 'UNLOCKED') return { unlocked: true, alreadyUnlocked: true };

  // Account binding check BEFORE touching the wrapped key.
  const acctRaw = readRaw(vaultFilePath(ACCOUNT_FILE));
  let recordedSid = '';
  try {
    const acct = JSON.parse(acctRaw ?? '{}') as { sid?: unknown };
    if (typeof acct.sid !== 'string' || acct.sid.length < 5) throw new Error('account binding invalid');
    recordedSid = acct.sid;
  } catch (err) {
    enterTampered(`account binding unreadable: ${String((err as Error)?.message || err).slice(0, 120)}`);
    lerr('vault_tampered', 'account binding unreadable — vault TAMPERED');
  }
  let currentSid: string;
  try {
    currentSid = await dpapiCurrentSid();
  } catch (err) {
    lerr('key_unwrap_failed', `Windows identity check failed: ${String((err as Error)?.message || err).slice(0, 120)}`);
  }
  if (recordedSid !== currentSid) {
    appendLpvAudit({ kind: 'lpv_key_unwrap_denied', reason: 'account_mismatch' });
    lerr('account_mismatch', 'the vault is bound to a different Windows account — unlock refused');
  }

  // Unwrap the master key (exists in memory ONLY while unlocked).
  const blobRaw = readRaw(vaultFilePath(KEY_FILE));
  if (blobRaw === null) {
    enterTampered('key blob missing at unlock');
    lerr('vault_tampered', 'key blob missing — vault TAMPERED');
  }
  let master: Buffer;
  try {
    master = await dpapiUnprotect(Buffer.from(blobRaw!, 'base64'));
  } catch (err) {
    appendLpvAudit({ kind: 'lpv_key_unwrap_denied', reason: 'dpapi_failure' });
    lerr('key_unwrap_failed', `DPAPI unprotect failed: ${String((err as Error)?.message || err).slice(0, 120)}`);
  }
  masterKey = master!;
  const derived = deriveSubkeys(masterKey);
  subkeys = { enc: derived.enc, mac: derived.mac };
  try {
    // loadDocumentVerified either succeeds (doc loaded + MAC verified) or
    // flips the vault into TAMPERED (which zeroed the keys).
    loadDocumentVerified();
    if (currentState() === 'TAMPERED') {
      lerr('vault_tampered', tamperReason ?? 'vault verification failed');
    }
  } catch (err) {
    zeroBuffer(masterKey);
    masterKey = null;
    if (subkeys) {
      zeroBuffer(subkeys.enc);
      zeroBuffer(subkeys.mac);
      subkeys = null;
    }
    throw err;
  }
  state = 'UNLOCKED';
  noteActivity();
  startAutoLockTimer();
  appendLpvAudit({ kind: 'lpv_unlock' });
  return { unlocked: true, alreadyUnlocked: false };
}

export function lockVault(reason: string): { locked: boolean } {
  zeroBuffer(masterKey);
  masterKey = null;
  if (subkeys) {
    zeroBuffer(subkeys.enc);
    zeroBuffer(subkeys.mac);
    subkeys = null;
  }
  if (state === 'UNLOCKED') {
    state = 'LOCKED';
    docVerified = false;
    // Release the in-memory document: a locked vault holds nothing resident;
    // metadata reads re-parse the on-disk file (flagged unverified).
    doc = null;
    stopAutoLockTimer();
    appendLpvAudit({ kind: 'lpv_lock', reason: String(reason ?? '').slice(0, 60) });
  }
  return { locked: state === 'LOCKED' };
}

/** Shutdown hygiene: zero key material before process death. Registered
 *  once; signals are re-raised so default exit semantics are preserved. */
function hookShutdown(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const lockForExit = (): void => {
    if (state === 'UNLOCKED') lockVault('shutdown');
  };
  process.once('beforeExit', lockForExit);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      lockForExit();
      process.kill(process.pid, sig);
    });
  }
}

// ---------------------------------------------------------------------------
// Listing / policy / history (read paths — never reset the idle timer)
// ---------------------------------------------------------------------------

function metaOf(entry: EncryptedEntry): VaultEntryMeta {
  return {
    id: entry.id,
    categoryKey: entry.categoryKey,
    category: entry.category,
    title: entry.title,
    hasUsername: entry.hasUsername,
    hasNotes: entry.hasNotes,
    url: entry.url,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastRetrievedAt: entry.lastRetrievedAt,
    retrieveCount: entry.retrieveCount,
  };
}

export function getVaultStatus(): VaultStatus {
  loadDocumentUnverified();
  return {
    state,
    initialized: state === 'LOCKED' || state === 'UNLOCKED' || state === 'TAMPERED',
    locked: state === 'LOCKED' || state === 'TAMPERED' || state === 'UNAVAILABLE',
    protection: getStorageInfo().protection,
    storageRoot: vaultDir,
    entryCount: doc?.entries.length ?? 0,
    generation: doc?.generation ?? null,
    verified: docVerified,
    autoLockMs: doc?.policy.autoLockMs ?? DEFAULT_AUTO_LOCK_MS,
    lastActivityAt: state === 'UNLOCKED' ? lastActivityAt : null,
    fillsInFlight,
  };
}

export function listEntries(): { verified: boolean; tampered: boolean; tamperReason: string | null; entries: VaultEntryMeta[] } {
  if (state === 'UNAVAILABLE') lerr('storage_unavailable', 'protected storage unavailable');
  if (state === 'UNINITIALIZED') return { verified: false, tampered: false, tamperReason: null, entries: [] };
  if (state === 'TAMPERED') {
    return { verified: false, tampered: true, tamperReason: tamperReason, entries: [] };
  }
  loadDocumentUnverified();
  if (currentState() === 'TAMPERED') {
    return { verified: false, tampered: true, tamperReason: tamperReason, entries: [] };
  }
  return { verified: docVerified, tampered: false, tamperReason: null, entries: (doc?.entries ?? []).map(metaOf) };
}

export function getPolicy(): { verified: boolean; policy: VaultPolicy | null } {
  if (state === 'UNAVAILABLE') lerr('storage_unavailable', 'protected storage unavailable');
  if (state === 'UNINITIALIZED' || state === 'TAMPERED') return { verified: false, policy: null };
  loadDocumentUnverified();
  return { verified: docVerified, policy: doc ? { ...doc.policy, autoSaveCategories: { ...doc.policy.autoSaveCategories } } : null };
}

export function getHistory(limit?: number): {
  untrusted: boolean;
  reason: string | null;
  entries: number;
  events: Array<Record<string, unknown>>;
} {
  // The chain is FULLY verified before any history is served/trusted.
  const verdict = verifyLpvAuditChain();
  const capped = Math.min(Math.max(1, Math.floor(limit ?? 50)), HISTORY_SERVE_LIMIT);
  const file = auditPath();
  const events: Array<Record<string, unknown>> = [];
  if (file && verdict.ok) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
      for (const line of lines.slice(-capped)) {
        try {
          events.push(JSON.parse(line));
        } catch {
          /* verified above; defensive only */
        }
      }
    } catch {
      /* served as untrusted below */
    }
  }
  return { untrusted: !verdict.ok, reason: verdict.reason, entries: verdict.entries, events };
}

// ---------------------------------------------------------------------------
// Entry CRUD
// ---------------------------------------------------------------------------

const CATEGORY_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i;

/** Destination URLs are stored in full (the fill flow navigates to them).
 *  https is required for every non-loopback host; plain http is accepted
 *  ONLY on loopback (local services, test targets). */
function assertValidUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(String(raw));
  } catch {
    lerr('invalid_input', 'url must be an absolute URL');
  }
  if (parsed.protocol === 'https:') return parsed.toString();
  if (parsed.protocol === 'http:' && LOOPBACK_HOST_RE.test(parsed.hostname)) return parsed.toString();
  lerr('invalid_input', 'only https:// URLs (or http:// on loopback) are accepted as destinations');
}

function validateSaveInput(input: SaveCandidate): void {
  if (typeof input.categoryKey !== 'string' || !CATEGORY_KEY_RE.test(input.categoryKey)) {
    lerr('invalid_input', 'categoryKey must match [a-z0-9][a-z0-9_-]{0,39}');
  }
  if (typeof input.title !== 'string' || input.title.trim().length === 0 || input.title.length > 120) {
    lerr('invalid_input', 'title must be 1-120 characters');
  }
  if (typeof input.password !== 'string' || input.password.length === 0 || input.password.length > MAX_ENTRY_SECRETS_LEN) {
    lerr('invalid_input', `password must be 1-${MAX_ENTRY_SECRETS_LEN} characters`);
  }
  if (input.username !== undefined && (typeof input.username !== 'string' || input.username.length > 120)) {
    lerr('invalid_input', 'username must be at most 120 characters');
  }
  if (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 2000)) {
    lerr('invalid_input', 'notes must be at most 2000 characters');
  }
  assertValidUrl(input.url);
}

function assertApprovedForCategory(
  category: VaultCategory,
  approval: SaveApproval,
  categoryKey: string,
  title: string
): void {
  if (approval.kind === 'user-direct') return; // operator's own UI action (two-step confirm)
  if (approval.kind === 'policy-auto') {
    if (!isAutoSaveAllowed(categoryKey, category, doc!.policy)) {
      appendLpvAudit({ kind: 'lpv_save_denied', reason: 'policy_violation', categoryKey, category });
      lerr('policy_violation', 'automatic saving is not enabled for this category (or the entry is not Category B)');
    }
    return;
  }
  if (approval.kind === 'challenge') {
    sweepChallenges();
    const c = challenges.get(approval.challengeId);
    // Repairs D2 + D3: the challenge must be APPROVED, be a SAVE approval,
    // match the draft the operator actually approved (categoryKey + title),
    // and still be within its original TTL — approvals are short-lived and
    // cannot be redeemed later or swapped for different content.
    if (!c || c.state !== 'approved' || c.purpose !== 'save') {
      appendLpvAudit({ kind: 'lpv_save_denied', reason: 'approval_invalid', categoryKey, category });
      lerr('approval_invalid', 'the referenced save challenge is not approved');
    }
    if (c.expiresAt <= nowFn()) {
      challenges.delete(approval.challengeId);
      appendLpvAudit({ kind: 'lpv_save_denied', reason: 'approval_expired', categoryKey, category });
      lerr('approval_invalid', 'the approved save challenge has expired — request a new approval');
    }
    if (!c.entryDraft || c.entryDraft.categoryKey !== categoryKey || c.entryDraft.title !== title.trim()) {
      appendLpvAudit({ kind: 'lpv_save_denied', reason: 'approval_draft_mismatch', categoryKey, category });
      lerr('approval_invalid', 'the save does not match the approved challenge draft');
    }
    challenges.delete(approval.challengeId); // consume — a challenge authorizes exactly one save
    return;
  }
  appendLpvAudit({ kind: 'lpv_save_denied', reason: 'approval_required', categoryKey, category });
  lerr('approval_required', 'saving this entry requires explicit user approval');
}

export function addEntry(
  input: SaveCandidate,
  approval: SaveApproval,
  requester: string
): { entry: VaultEntryMeta } {
  assertUnlocked();
  assertStopInactive();
  assertWritableEnvironment(); // degraded → writes refused
  validateSaveInput(input);

  const refuse = detectTemporarySecret(input);
  if (refuse) {
    appendLpvAudit({ kind: 'lpv_save_denied', reason: 'temporary_secret', detail: refuse.slice(0, 120), categoryKey: input.categoryKey });
    lerr('temporary_secret_refused', `refused: this looks like a short-lived secret (${refuse.slice(0, 80)}) — temporary codes are never stored`);
  }

  const category = classifyCategory(input.categoryKey, doc!.policy);
  assertApprovedForCategory(category, approval, input.categoryKey, input.title);

  if (doc!.entries.length >= MAX_ENTRIES) lerr('invalid_input', `vault is full (max ${MAX_ENTRIES} entries)`);

  const now = nowFn();
  const entry: EncryptedEntry = {
    id: `ve_${now}_${crypto.randomBytes(6).toString('hex')}`,
    categoryKey: input.categoryKey.toLowerCase(),
    category,
    title: input.title.trim(),
    hasUsername: Boolean(input.username),
    hasNotes: Boolean(input.notes),
    url: assertValidUrl(input.url),
    createdAt: now,
    updatedAt: now,
    lastRetrievedAt: null,
    retrieveCount: 0,
    iv: '',
    ciphertext: '',
    tag: '',
  };
  encryptEntryPayload(subkeys!.enc, entry, {
    username: input.username ?? '',
    password: input.password,
    notes: input.notes ?? '',
  });
  doc!.entries.push(entry);
  doc!.generation += 1;
  doc!.updatedAt = now;
  persistVault();
  noteActivity();
  appendLpvAudit({
    kind: approval.kind === 'policy-auto' ? 'lpv_auto_save' : 'lpv_save',
    entryId: entry.id,
    categoryKey: entry.categoryKey,
    category: entry.category,
    approval: approval.kind,
    requester: String(requester ?? '').slice(0, 60),
    result: 'ok',
  });
  return { entry: metaOf(entry) };
}

export function updateEntry(
  entryId: string,
  patch: Partial<SaveCandidate>,
  approval: SaveApproval,
  requester: string
): { entry: VaultEntryMeta } {
  assertUnlocked();
  assertStopInactive();
  assertWritableEnvironment();
  const entry = doc!.entries.find((e) => e.id === entryId);
  if (!entry) lerr('entry_not_found', 'no such vault entry');

  const merged: SaveCandidate = {
    categoryKey: patch.categoryKey ?? entry.categoryKey,
    title: patch.title ?? entry.title,
    username: patch.username ?? undefined,
    password: patch.password ?? '',
    notes: patch.notes ?? undefined,
    url: patch.url ?? entry.url ?? undefined,
  };
  // When the caller does not re-supply secrets, decrypt the existing payload
  // and carry the values over (they are re-encrypted immediately). A decrypt
  // failure here means the stored payload is corrupt — refuse (fail-closed),
  // never wipe the secret silently.
  let carried: EntrySecrets;
  try {
    carried = decryptEntryPayload(subkeys!.enc, entry);
  } catch (err) {
    appendLpvAudit({ kind: 'lpv_save_denied', reason: 'payload_decrypt_failed', entryId });
    lerr('vault_tampered', `stored payload failed to decrypt — update refused (${String((err as Error)?.message || err).slice(0, 100)})`);
  }
  if (patch.password === undefined || patch.password === '') merged.password = carried.password;
  if (patch.username === undefined) merged.username = carried.username || undefined;
  if (patch.notes === undefined) merged.notes = carried.notes || undefined;

  validateSaveInput(merged);
  const refuse = detectTemporarySecret(merged);
  if (refuse) {
    appendLpvAudit({ kind: 'lpv_save_denied', reason: 'temporary_secret', detail: refuse.slice(0, 120), entryId, categoryKey: merged.categoryKey });
    lerr('temporary_secret_refused', `refused: this looks like a short-lived secret (${refuse.slice(0, 80)})`);
  }

  const category = classifyCategory(merged.categoryKey, doc!.policy);
  assertApprovedForCategory(category, approval, merged.categoryKey, merged.title);

  entry.categoryKey = merged.categoryKey.toLowerCase();
  entry.category = category;
  entry.title = merged.title.trim();
  entry.hasUsername = Boolean(merged.username);
  entry.hasNotes = Boolean(merged.notes);
  entry.url = assertValidUrl(merged.url);
  entry.updatedAt = nowFn(); // AAD input — rotates on every payload change
  encryptEntryPayload(subkeys!.enc, entry, {
    username: merged.username ?? '',
    password: merged.password,
    notes: merged.notes ?? '',
  });
  doc!.generation += 1;
  doc!.updatedAt = entry.updatedAt;
  persistVault();
  noteActivity();
  appendLpvAudit({
    kind: 'lpv_update',
    entryId,
    categoryKey: entry.categoryKey,
    category: entry.category,
    approval: approval.kind,
    requester: String(requester ?? '').slice(0, 60),
    result: 'ok',
  });
  return { entry: metaOf(entry) };
}

export function deleteEntry(entryId: string, requester: string): { deleted: boolean; remainingBackups: number } {
  assertUnlocked();
  assertStopInactive();
  assertWritableEnvironment();
  const idx = doc!.entries.findIndex((e) => e.id === entryId);
  if (idx < 0) lerr('entry_not_found', 'no such vault entry');
  const [removed] = doc!.entries.splice(idx, 1);
  doc!.generation += 1;
  doc!.updatedAt = nowFn();
  persistVault();
  noteActivity();
  appendLpvAudit({
    kind: 'lpv_delete',
    entryId,
    categoryKey: removed.categoryKey,
    category: removed.category,
    requester: String(requester ?? '').slice(0, 60),
    result: 'ok',
  });
  // Honest secure-delete note: the ciphertext is gone from the live document
  // and the NEW backup; the previous backup file was just overwritten by
  // this persist. NTFS freed-cluster retention is disclosed in the module
  // header. remainingBackups: 1 (the .bak now predates this delete) or 0.
  const hasBak = readRaw(vaultFilePath(VAULT_BAK_FILE)) !== null;
  return { deleted: true, remainingBackups: hasBak ? 1 : 0 };
}

export function setPolicy(
  patch: Partial<VaultPolicy>,
  requester: string
): { policy: VaultPolicy } {
  assertUnlocked();
  assertStopInactive();
  assertWritableEnvironment();
  const next: VaultPolicy = {
    autoSaveEnabled: typeof patch.autoSaveEnabled === 'boolean' ? patch.autoSaveEnabled : doc!.policy.autoSaveEnabled,
    autoSaveCategories: { ...doc!.policy.autoSaveCategories },
    autoLockMs: doc!.policy.autoLockMs,
  };
  if (patch.autoSaveCategories !== undefined) {
    if (typeof patch.autoSaveCategories !== 'object' || patch.autoSaveCategories === null) {
      lerr('invalid_input', 'autoSaveCategories must be an object');
    }
    for (const [k, v] of Object.entries(patch.autoSaveCategories)) {
      if (!CATEGORY_KEY_RE.test(k)) lerr('invalid_input', `invalid category key "${k.slice(0, 40)}"`);
      if (typeof v !== 'boolean') lerr('invalid_input', 'autoSaveCategories values must be booleans');
      if (v === true) next.autoSaveCategories[k] = true;
      else delete next.autoSaveCategories[k];
    }
  }
  if (patch.autoLockMs !== undefined) {
    if (!Number.isFinite(patch.autoLockMs)) lerr('invalid_input', 'autoLockMs must be a number');
    next.autoLockMs = Math.min(AUTO_LOCK_MAX_MS, Math.max(AUTO_LOCK_MIN_MS, Math.round(patch.autoLockMs)));
  }
  doc!.policy = next;
  doc!.generation += 1;
  doc!.updatedAt = nowFn();
  persistVault();
  noteActivity();
  appendLpvAudit({
    kind: 'lpv_policy_change',
    autoSaveEnabled: next.autoSaveEnabled,
    autoSaveCategories: Object.keys(next.autoSaveCategories).sort(),
    autoLockMs: next.autoLockMs,
    requester: String(requester ?? '').slice(0, 60),
    result: 'ok',
  });
  appendAuditSyncSafe({ kind: 'lpv_policy_change' });
  return { policy: { ...next, autoSaveCategories: { ...next.autoSaveCategories } } };
}

// ---------------------------------------------------------------------------
// Challenges + single-use fill grants
// ---------------------------------------------------------------------------

function sweepChallenges(): void {
  const now = nowFn();
  for (const [id, c] of challenges) {
    if (c.state === 'pending' && c.expiresAt <= now) challenges.delete(id);
  }
  while (challenges.size > MAX_CHALLENGES) {
    const first = challenges.keys().next().value;
    if (first === undefined) break;
    challenges.delete(first);
  }
}

function sweepGrants(): void {
  const now = nowFn();
  for (const [id, g] of grants) {
    if (g.used || g.expiresAt <= now) grants.delete(id);
  }
  while (grants.size > MAX_GRANTS) {
    const first = grants.keys().next().value;
    if (first === undefined) break;
    grants.delete(first);
  }
}

export function createChallenge(
  purpose: 'save' | 'fill',
  payload: { entryId?: string; origin?: string; entryDraft?: { categoryKey: string; title: string; url?: string }; fields?: FillFieldSpec[] },
  requester: string
): { challengeId: string; expiresAt: number; purpose: 'save' | 'fill' } {
  if (state === 'TAMPERED') lerr('vault_tampered', 'vault is TAMPERED');
  if (state === 'UNAVAILABLE') lerr('storage_unavailable', 'protected storage unavailable');
  // Repair D2: a SAVE challenge must carry the exact draft it asks approval
  // for — the operator card displays it, and consumption later enforces it.
  if (purpose === 'save') {
    const draft = payload.entryDraft;
    if (!draft || typeof draft.categoryKey !== 'string' || !CATEGORY_KEY_RE.test(draft.categoryKey)) {
      lerr('invalid_input', 'save challenges require a valid entryDraft.categoryKey');
    }
    if (!draft.title || typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > 120) {
      lerr('invalid_input', 'save challenges require a valid entryDraft.title');
    }
  }
  // Approval-authority closure: a FILL challenge carries the EXACT operation
  // (entry + validated field specs) that approval will execute server-side —
  // no grant capability is ever handed to the requester.
  if (purpose === 'fill') {
    if (!payload.entryId || typeof payload.entryId !== 'string') {
      lerr('invalid_input', 'fill challenges require an entryId');
    }
    validateFillFields(Array.isArray(payload.fields) ? payload.fields : []);
  }
  sweepChallenges();
  const id = `lpc_${nowFn()}_${crypto.randomBytes(6).toString('hex')}`;
  const challenge = {
    id,
    purpose,
    entryId: payload.entryId ? String(payload.entryId) : undefined,
    origin: payload.origin ? String(payload.origin) : undefined,
    entryDraft: payload.entryDraft,
    fields: purpose === 'fill' ? payload.fields : undefined,
    decisionToken: crypto.randomBytes(16).toString('hex'),
    requester: String(requester ?? '').slice(0, 60),
    createdAt: nowFn(),
    expiresAt: nowFn() + CHALLENGE_TTL_MS,
    state: 'pending' as const,
  };
  challenges.set(id, challenge);
  appendLpvAudit({ kind: 'lpv_challenge_created', purpose, challengeId: id, requester: challenge.requester });
  return { challengeId: id, expiresAt: challenge.expiresAt, purpose };
}

function originOfEntry(entry: EncryptedEntry): string {
  if (!entry.url) lerr('no_destination', 'this entry has no https destination URL — browser fill is unavailable');
  try {
    return new URL(entry.url).origin;
  } catch {
    lerr('invalid_input', 'entry URL is malformed');
  }
}

export interface PendingChallengeView {
  challengeId: string;
  purpose: 'save' | 'fill';
  entryId?: string;
  origin?: string;
  entryDraft?: { categoryKey: string; title: string; url?: string };
  entryTitle?: string;
  category?: VaultCategory;
  requester: string;
  expiresAt: number;
  /** One-time decision capability for the operator card — delivered ONLY
   *  here, so an approve/decline call must have come through the
   *  human-facing pending-approvals surface. */
  decisionToken: string;
}

export function listPendingChallenges(): PendingChallengeView[] {
  sweepChallenges();
  const out: PendingChallengeView[] = [];
  for (const c of challenges.values()) {
    if (c.state !== 'pending') continue;
    const entry = c.entryId ? doc?.entries.find((e) => e.id === c.entryId) : undefined;
    // Repair D8: the approval card must show the DESTINATION the fill will
    // bind to. For fill challenges created without an explicit origin, the
    // entry's destination origin is resolved for display (never throws).
    let displayOrigin = c.origin;
    if (!displayOrigin && entry?.url) {
      try {
        displayOrigin = new URL(entry.url).origin;
      } catch {
        displayOrigin = undefined;
      }
    }
    out.push({
      challengeId: c.id,
      purpose: c.purpose,
      entryId: c.entryId,
      origin: displayOrigin,
      entryDraft: c.entryDraft,
      entryTitle: entry?.title,
      category: entry?.category,
      requester: c.requester,
      expiresAt: c.expiresAt,
      decisionToken: c.decisionToken,
    });
  }
  return out;
}

/** Challenge-status lookup for the REQUESTER. Metadata ONLY: state plus the
 *  outcome of an approval-executed fill — it NEVER exposes credentials or a
 *  retrieval grant (grants exist solely inside the server for the
 *  operator-UI-direct fill path, and approval-executed fills never create
 *  one). */
export function getChallengeStatus(challengeId: string): {
  state: 'pending' | 'approved' | 'declined' | 'expired' | 'unknown';
  fillOutcome?: { at: number; url: string; filled: Array<{ secret: string; filled: boolean; matched?: string; reason?: string }> };
} {
  sweepChallenges();
  const c = challenges.get(challengeId);
  if (!c) return { state: 'unknown' };
  if (c.fillOutcome) {
    return { state: c.state, fillOutcome: c.fillOutcome };
  }
  return { state: c.state };
}

/** Timing-safe decision-token comparison. */
function decisionTokenMatches(challenge: { decisionToken: string }, decisionToken: unknown): boolean {
  if (typeof decisionToken !== 'string' || decisionToken.length === 0) return false;
  const a = Buffer.from(challenge.decisionToken, 'utf8');
  const b = Buffer.from(decisionToken, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Operator decision on a pending challenge. Approval authority closure:
 *   - the decision must carry the one-time decisionToken that is delivered
 *     ONLY through the operator-facing pending-approvals listing, so a blind
 *     approve(challengeId) call that never surfaced the card is refused;
 *   - a FILL challenge is executed server-side AT APPROVAL with the exact
 *     approved operation — no grant capability is created or returned, so
 *     the requester never holds a reusable retrieval credential;
 *   - expired, declined and consumed challenges cannot be redeemed.
 * The route layer additionally gates this behind `vault.manage` + the E5
 * emergency stop; the honest boundary remains the documented same-user one
 * (the server cannot cryptographically distinguish the operator's browser
 * from another same-user process — disclosed in ARCHITECTURE.md §33). */
export async function approveChallenge(
  challengeId: string,
  decisionToken: unknown
): Promise<{ approved: boolean; fill?: FillResult }> {
  sweepChallenges();
  const found = challenges.get(challengeId);
  if (!found || found.state !== 'pending') lerr('approval_invalid', 'no pending challenge with this id');
  if (!decisionTokenMatches(found, decisionToken)) {
    appendLpvAudit({ kind: 'lpv_challenge_decision_denied', purpose: found.purpose, challengeId, reason: 'decision_token_invalid' });
    lerr('approval_invalid', 'the decision token does not match this challenge');
  }
  assertUnlocked(); // approvals operate against the live vault
  assertStopInactive();
  if (found.purpose === 'fill') {
    // Approve-and-execute: consume the challenge FIRST (remove-before-execute),
    // then run the pinned fill inside the fill serialization chain.
    challenges.delete(challengeId);
    appendLpvAudit({ kind: 'lpv_challenge_approved', purpose: 'fill', challengeId });
    const entry = doc!.entries.find((e) => e.id === found.entryId);
    if (!entry) lerr('entry_not_found', 'challenge references a missing entry');
    const origin = found.origin ?? originOfEntry(entry!);
    if (found.origin && found.origin !== originOfEntry(entry!)) {
      lerr('invalid_input', 'challenge origin does not match the entry destination');
    }
    assertWritableEnvironment();
    const outcome = await runFillTracked(() =>
      executeFillCore(entry!, origin, found.fields!, `approval:${challengeId.slice(0, 24)}`)
    );
    // Keep a METADATA outcome for the requester-side status seam (no grant,
    // no secret). The record lingers until challenge-cap eviction.
    challenges.set(challengeId, {
      ...found,
      state: 'approved' as const,
      fillOutcome: { at: nowFn(), url: outcome.url, filled: outcome.filled },
    });
    return { approved: true, fill: outcome };
  }
  // SAVE challenges: the secret arrives with the later save call (never in
  // the challenge); the approval state + draft binding + TTL enforce it.
  found.state = 'approved';
  appendLpvAudit({ kind: 'lpv_challenge_approved', purpose: 'save', challengeId });
  return { approved: true };
}

export function declineChallenge(challengeId: string, decisionToken: unknown): { declined: boolean } {
  sweepChallenges();
  const found = challenges.get(challengeId);
  if (!found || found.state !== 'pending') lerr('approval_invalid', 'no pending challenge with this id');
  if (!decisionTokenMatches(found, decisionToken)) {
    appendLpvAudit({ kind: 'lpv_challenge_decision_denied', purpose: found.purpose, challengeId, reason: 'decision_token_invalid' });
    lerr('approval_invalid', 'the decision token does not match this challenge');
  }
  found.state = 'declined';
  appendLpvAudit({ kind: 'lpv_challenge_declined', purpose: found.purpose, challengeId });
  return { declined: true };
}

/** Operator UI-direct fill: the click IS the approval. Issues the bound,
 *  single-use grant immediately. Repair D5: degraded protection refuses
 *  grant issuance too — never issue an authorization that cannot be used. */
export function requestUiFill(entryId: string): { grantId: string; origin: string; expiresAt: number } {
  assertStopInactive();
  assertUnlocked();
  assertWritableEnvironment();
  const entry = doc!.entries.find((e) => e.id === entryId);
  if (!entry) lerr('entry_not_found', 'no such vault entry');
  const origin = originOfEntry(entry);
  const grantId = issueFillGrant(entryId, origin, 'ui-direct');
  return { grantId, origin, expiresAt: grants.get(grantId)!.expiresAt };
}

function issueFillGrant(entryId: string, origin: string, requester: string): string {
  sweepGrants();
  const grantId = `lpg_${nowFn()}_${crypto.randomBytes(8).toString('hex')}`;
  grants.set(grantId, {
    grantId,
    op: 'fill',
    entryId,
    origin,
    issuedAt: nowFn(),
    expiresAt: nowFn() + GRANT_TTL_MS,
    used: false,
  });
  // Defense in depth: the route ALSO consumes a server-side `once` grant of
  // vault.retrieve, so even a stolen grantId cannot pass the permission
  // layer without an approval-issued capability.
  serverPermissions.grantScoped({
    permission: 'vault.retrieve',
    scope: { kind: 'once' },
    reason: `lpv fill grant ${requester}`.slice(0, 160),
  });
  appendLpvAudit({ kind: 'lpv_grant_issued', entryId, origin, requester: String(requester ?? '').slice(0, 60) });
  return grantId;
}

// ---------------------------------------------------------------------------
// Fill — the ONLY retrieval path. Returns metadata, never secrets.
// ---------------------------------------------------------------------------

export interface FillFieldSpec {
  secret: 'username' | 'password';
  match: string;
}

export interface FillResult {
  success: boolean;
  url: string;
  filled: Array<{ secret: 'username' | 'password'; filled: boolean; matched?: string; reason?: string }>;
}

function validateFillFields(fields: FillFieldSpec[]): void {
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > 2) {
    lerr('invalid_input', 'fill requires 1-2 field specs');
  }
  const seen = new Set<string>();
  for (const f of fields) {
    if (f.secret !== 'username' && f.secret !== 'password') lerr('invalid_input', 'field secret must be "username" or "password"');
    if (seen.has(f.secret)) lerr('invalid_input', 'duplicate field secret');
    seen.add(f.secret);
    if (typeof f.match !== 'string' || f.match.trim().length === 0 || f.match.length > 120) {
      lerr('invalid_input', 'field match must be 1-120 characters');
    }
  }
}

/** In-page fill script (top frame only; iframes are never traversed).
 *  Security audit repair D1: the APPROVED origin is re-verified INSIDE the
 *  page as the first statement, so the decision and the typing are atomic —
 *  a page that is not the approved destination can never receive a value,
 *  even if target selection raced. D7: single/double-character field
 *  attributes can no longer match bidirectionally (accuracy hardening). */
function buildFillExpression(expectedOrigin: string, specs: Array<{ secret: string; match: string; value: string }>): string {
  return `(() => {
  if (location.origin !== ${JSON.stringify(expectedOrigin)}) {
    return JSON.stringify({ results: [], finalUrl: location.href, originRefused: true });
  }
  const specs = ${JSON.stringify(specs)};
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const hayOf = (f) => [f.placeholder, f.name, f.id, f.getAttribute('aria-label'), (f.labels && f.labels[0] && f.labels[0].innerText)].map(x => (x || '').toLowerCase());
  const findField = (match, kinds) => {
    const m = match.toLowerCase();
    let best = null, bestScore = 0;
    for (const f of inputs) {
      const t = (f.type || 'text').toLowerCase();
      if (!kinds.includes(t)) continue;
      const hay = hayOf(f);
      let score = 0;
      if (hay.some(h => h && (h === m || h.includes(m) || (h.length >= 3 && m.includes(h))))) score = 2;
      else if (hay.some(h => h && m.split(/\\s+/).some(w => w.length > 2 && h.includes(w)))) score = 1;
      if (score > bestScore) { bestScore = score; best = f; }
    }
    return best;
  };
  const results = [];
  for (const s of specs) {
    const kinds = s.secret === 'password' ? ['password'] : ['text', 'email', 'tel'];
    const f = findField(s.match, kinds);
    if (!f) { results.push({ secret: s.secret, filled: false, reason: 'field_not_found' }); continue; }
    if (s.secret === 'password' && (f.type || '').toLowerCase() !== 'password') {
      results.push({ secret: s.secret, filled: false, reason: 'field_not_password' }); continue;
    }
    const proto = HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(f, s.value);
    f.dispatchEvent(new Event('input', { bubbles: true }));
    f.dispatchEvent(new Event('change', { bubbles: true }));
    results.push({ secret: s.secret, filled: true, matched: (f.name || f.placeholder || f.id || f.type || '').slice(0, 60) });
  }
  return JSON.stringify({ results, finalUrl: location.href });
})()`;
}

// Fill serialization (concurrency repair): ALL typed fills — grant-path and
// approval-executed — run through ONE promise chain, so concurrent fill
// requests never interleave CDP probing/typing and never overwrite each
// other's target state. Failures do not break the chain. The in-flight
// counter increments AT CALL TIME (synchronously), so auto-lock defers for
// accepted-but-queued fills as well.
let fillChain: Promise<unknown> = Promise.resolve();

function queueFill<T>(fn: () => Promise<T>): Promise<T> {
  const run = fillChain.then(fn);
  fillChain = run.catch(() => undefined);
  return run;
}

function runFillTracked<T>(fn: () => Promise<T>): Promise<T> {
  fillsInFlight += 1;
  return queueFill(fn).finally(() => {
    fillsInFlight -= 1;
  });
}

/** Grant-path fill (operator UI-direct). Authorization: vault.retrieve route
 *  gate + approval-issued single-use bound grant (consumed remove-before-use)
 *  + every core-level check below. */
export function fillEntry(
  input: { grantId: string; fields: FillFieldSpec[] },
  requester: string
): Promise<FillResult> {
  return runFillTracked(() => doFillEntry(input, requester));
}

async function doFillEntry(
  input: { grantId: string; fields: FillFieldSpec[] },
  requester: string
): Promise<FillResult> {
  if (state === 'TAMPERED') lerr('vault_tampered', 'vault is TAMPERED');
  assertStopInactive(); // emergency stop blocks retrieval (route + core)
  assertWritableEnvironment(); // degraded → fill refused
  assertUnlocked(); // locked vault refuses every retrieval/fill path

  validateFillFields(input.fields);

  // Consume the grant FIRST (single-use, remove-before-use semantics).
  sweepGrants();
  const grant = grants.get(input.grantId);
  if (!grant || grant.used || grant.op !== 'fill') {
    appendLpvAudit({ kind: 'lpv_retrieve_denied', reason: 'grant_invalid', requester: String(requester ?? '').slice(0, 60) });
    lerr('grant_invalid', 'fill grant is invalid or already used');
  }
  if (grant.expiresAt <= nowFn()) {
    grants.delete(input.grantId);
    appendLpvAudit({ kind: 'lpv_retrieve_denied', reason: 'grant_expired', requester: String(requester ?? '').slice(0, 60) });
    lerr('grant_expired', 'fill grant expired (60 s window)');
  }
  const entry = doc!.entries.find((e) => e.id === grant.entryId);
  if (!entry) {
    grants.delete(input.grantId);
    appendLpvAudit({ kind: 'lpv_retrieve_denied', reason: 'entry_not_found', requester: String(requester ?? '').slice(0, 60) });
    lerr('entry_not_found', 'grant references a missing entry');
  }
  if (grant.origin !== originOfEntry(entry!)) {
    grants.delete(input.grantId);
    appendLpvAudit({ kind: 'lpv_fill_refused', reason: 'origin_mismatch', entryId: entry!.id });
    lerr('origin_mismatch', 'grant origin does not match the entry destination');
  }
  grants.delete(input.grantId); // consumed — this grant can NEVER fill again

  return executeFillCore(entry!, grant.origin, input.fields, requester);
}

/** Shared typed-fill execution core. Callers have ALREADY validated
 *  authorization (single-use grant OR approval-executed challenge). The fill
 *  is pinned to the page whose LIVE origin equals the approved origin
 *  (browserFillFields) and the expression re-verifies origin atomically with
 *  the typing; failures refuse without leaving reusable capabilities. */
async function executeFillCore(
  entry: EncryptedEntry,
  origin: string,
  fields: FillFieldSpec[],
  requester: string
): Promise<FillResult> {
  // Decrypt inside the server→CDP path only.
  const secrets = decryptEntryPayload(subkeys!.enc, entry);
  const valueFor = (secret: 'username' | 'password'): string => (secret === 'username' ? secrets.username : secrets.password);
  if (fields.some((f) => f.secret === 'password' && !valueFor('password'))) {
    lerr('invalid_input', 'entry has no stored password to fill');
  }
  const specs = fields.map((f) => ({ secret: f.secret, match: f.match, value: valueFor(f.secret) }));

  try {
    // Advisory pre-check: browser availability ONLY. The AUTHORITATIVE origin
    // enforcement lives in browserFillFields (pinned target selection among
    // ALL open pages) and inside the fill expression itself (atomic origin
    // check + typing on that page). The pre-check must NOT refuse on
    // first-page origin or readiness — with multiple tabs the approved page
    // may simply not be the first target. Repair D1.
    let preState: { url?: string; ready?: string };
    try {
      preState = await browserPageState();
    } catch (err) {
      appendLpvAudit({ kind: 'lpv_fill_refused', reason: 'browser_unavailable', entryId: entry.id });
      lerr('page_not_ready', `browser automation unavailable: ${String((err as Error)?.message || err).slice(0, 100)}`);
    }
    // SPF-verification coordination note (defect established, owner: LPV
    // workstream — reproduced 1-in-4 suite runs): the readiness of the FIRST
    // page target says nothing about the readiness of the PINNED
    // matching-origin page this fill will use, so a non-complete first target
    // must NOT refuse the fill — with multiple tabs the approved page may
    // simply not be the first target (same reasoning as the origin note
    // above). Readiness of the pinned page is authoritatively enforced inside
    // browserFillFields (browserCdp.ts — a matching page that is not
    // 'complete' is refused there, nothing typed). No origin or pinning
    // semantics change; false refusals only.
    void preState;

    // Fill on the PINNED matching-origin page (secrets transit server→CDP
    // only; never into HTTP responses). The expression re-verifies origin.
    // (The `secret` values are echoed from the validated specs — cast is safe.)
    let parsed: { results: FillResult['filled']; finalUrl: string; originRefused?: boolean };
    try {
      parsed = (await browserFillFields(origin, buildFillExpression(origin, specs))) as {
        results: FillResult['filled'];
        finalUrl: string;
        originRefused?: boolean;
      };
      if (!Array.isArray(parsed.results)) throw new Error('bad shape');
    } catch (err) {
      const kind = (err as { kind?: string })?.kind;
      appendLpvAudit({ kind: 'lpv_fill_refused', reason: kind ?? 'page_evaluation_failed', entryId: entry.id });
      if (kind === 'origin_mismatch') lerr('origin_mismatch', String((err as Error)?.message || err).slice(0, 140));
      lerr('page_not_ready', `page fill failed: ${String((err as Error)?.message || err).slice(0, 100)}`);
    }
    if (parsed.originRefused) {
      appendLpvAudit({ kind: 'lpv_fill_refused', reason: 'origin_mismatch', entryId: entry.id });
      lerr('origin_mismatch', 'the page refused the fill (origin changed) — nothing was typed');
    }

    // Navigation detection: the URL reported by the SAME page that was
    // filled must still be the approved origin.
    let postOrigin = '';
    try {
      postOrigin = new URL(String(parsed.finalUrl ?? '')).origin;
    } catch {
      postOrigin = '';
    }
    if (postOrigin !== origin) {
      appendLpvAudit({ kind: 'lpv_fill_refused', reason: 'navigation_detected', entryId: entry.id });
      lerr('fill_navigation_detected', 'the page navigated during the fill — operation refused');
    }

    // Retrieval bookkeeping (metadata only).
    entry.lastRetrievedAt = nowFn();
    entry.retrieveCount += 1;
    doc!.generation += 1;
    doc!.updatedAt = nowFn();
    persistVault();
    noteActivity();
    appendLpvAudit({
      kind: 'lpv_retrieve',
      entryId: entry.id,
      categoryKey: entry.categoryKey,
      category: entry.category,
      requester: String(requester ?? '').slice(0, 60),
      result: 'ok',
    });
    return { success: true, url: origin, filled: parsed.results };
  } finally {
    // Zero the plaintext payload copy the module owns.
    secrets.username = '';
    secrets.password = '';
    secrets.notes = '';
  }
}

// ---------------------------------------------------------------------------
// Recovery (operator-only) — restore previous generation on TAMPERED
// ---------------------------------------------------------------------------

export async function restoreFromBackup(): Promise<{ restored: boolean; generation: number | null }> {
  const store = getStorageInfo();
  if (!store.root || store.protection === 'unavailable') lerr('storage_unavailable', 'protected storage unavailable');
  if (store.protection === 'degraded') lerr('degraded_mode', 'restore refused in degraded mode');
  if (state !== 'TAMPERED') lerr('invalid_input', 'restore is only offered on a TAMPERED vault');
  const bakRaw = readRaw(vaultFilePath(VAULT_BAK_FILE));
  if (bakRaw === null) lerr('vault_tampered', 'no backup available — manual recovery required (never auto-reset)');
  const keyRaw = readRaw(vaultFilePath(KEY_FILE));
  const acctRaw = readRaw(vaultFilePath(ACCOUNT_FILE));
  if (keyRaw === null || acctRaw === null) lerr('vault_tampered', 'key/account files missing — manual recovery required');

  // Verify the account binding, unwrap the key, and MAC-verify the backup.
  const sid = await dpapiCurrentSid();
  let recordedSid = '';
  try {
    recordedSid = String((JSON.parse(acctRaw) as { sid?: unknown }).sid ?? '');
  } catch {
    lerr('vault_tampered', 'account binding unreadable — manual recovery required');
  }
  if (recordedSid !== sid) lerr('account_mismatch', 'the vault is bound to a different Windows account — restore refused');
  let master: Buffer;
  try {
    master = await dpapiUnprotect(Buffer.from(keyRaw, 'base64'));
  } catch (err) {
    lerr('key_unwrap_failed', `DPAPI unprotect failed during restore: ${String((err as Error)?.message || err).slice(0, 120)}`);
  }
  const derived = deriveSubkeys(master!);
  try {
    const bak = parseVaultFile(bakRaw);
    if (!timingSafeEq(macDocument(derived.mac, stripToDocument(bak)), bak.mac)) {
      lerr('vault_tampered', 'backup failed MAC verification — restore refused (never auto-reset)');
    }
    durableWrite(vaultFilePath(VAULT_FILE), bakRaw);
    appendLpvAudit({ kind: 'lpv_restored', generation: bak.generation });
    appendAuditSyncSafe({ kind: 'lpv_restored', generation: bak.generation });
    state = 'LOCKED';
    tamperReason = null;
    doc = null;
    docVerified = false;
    return { restored: true, generation: bak.generation };
  } finally {
    zeroBuffer(derived.enc);
    zeroBuffer(derived.mac);
    zeroBuffer(master);
  }
}

// ---------------------------------------------------------------------------
// Test hooks (used only by scripts/test-lpv-*.ts; deterministic, no sleeps)
// ---------------------------------------------------------------------------

export const _lpvTestHooks = {
  setNow(fn: () => number): void {
    nowFn = fn;
  },
  evaluateAutoLock(): void {
    evaluateAutoLock();
  },
  state(): VaultState {
    return state;
  },
  tamperReason(): string | null {
    return tamperReason;
  },
  grantCount(): number {
    return grants.size;
  },
  challengeCount(): number {
    return challenges.size;
  },
  /** Force the in-memory lock WITHOUT an audit event (pure state hygiene). */
  forceLockMemory(): void {
    // Repair D6: subkeys must be zeroed too, not just dropped.
    zeroBuffer(masterKey);
    masterKey = null;
    if (subkeys) {
      zeroBuffer(subkeys.enc);
      zeroBuffer(subkeys.mac);
      subkeys = null;
    }
  },
  /** True when no key material is resident (lock-zeroing assertion). */
  noKeyMaterialResident(): boolean {
    return masterKey === null && subkeys === null;
  },
  pendingChallenges(): number {
    let n = 0;
    for (const c of challenges.values()) if (c.state === 'pending') n++;
    return n;
  },
};

// Boot.
resolveBootStateSync();
