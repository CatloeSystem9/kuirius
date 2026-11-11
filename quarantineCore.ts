/**
 * E5 M3 — E7 Quarantine: retained capture of deleted nodes.
 *
 * Rules implemented (E7):
 *   - Deleted nodes are CAPTURED (moved) into protected-storage quarantine
 *     before their origin is released — data is retained until a valid
 *     release decision; nothing is auto-destroyed.
 *   - Header-READABLE items (metadata parses + integrity self-hash verifies)
 *     can be matched by OPERATOR DECLARATION of the exact affected path —
 *     a scoped claim. Restores never overwrite existing user files.
 *   - Header-UNREADABLE items (corrupt/tampered metadata) cannot be matched
 *     to any trusted path → they remain locked; moreover their existence
 *     locks the WHOLE quarantine against releases until the operator resolves
 *     the inconsistency out-of-band (conservative reading of "globally
 *     locked by default").
 *   - Acknowledgement alone never releases data — only a verified restore
 *     driven by an exact path declaration does.
 *   - Quarantine is NOT an alternate mutation route: restores pass the M1
 *     in-process gate (stop → permission → audit) and M2 staging/identity
 *     primitives; captures refuse when the retention cap is reached (the
 *     delete itself is then refused — nothing is silently lost).
 *
 * Honest limits carried forward: in degraded storage mode quarantine data is
 * not model-immutable; restore operations REFUSE in degraded mode because a
 * tamperable store cannot prove capture integrity for a destructive
 * operation. Cross-volume capture of directories or large files is refused
 * rather than weakening verification.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getStorageInfo, stopKind, serverPermissions, appendAuditSyncSafe, durableWrite, resolveSafePath, assertNotProtected } from './serverSafety';
import { captureIdentity, identityMatches, FileIdentity, assertSandboxMutation, E1_CONTRACT, stageFile, commitStaged, abortStaged, readJournalEntries, SandboxJournalEntry, journalIntegrityCheck } from './sandboxCore';

const ITEM_HASH_MAX_BYTES = 64 * 1024 * 1024;
export const QUARANTINE_MAX_ITEMS = 50;
const TREE_MANIFEST_MAX_ENTRIES = 2000;

export interface QuarantineMeta {
  schemaVersion: 1;
  quarantineId: string;
  kind: 'file' | 'directory';
  originalPath: string;
  /** Identity of the CAPTURED data node (rename preserves the original's). */
  dataIdentity: FileIdentity;
  /** Content hash for files up to the bounded hashing cap (E1 evidence). */
  contentSha256?: string;
  contentBytes?: number;
  captureAt: number;
  opId?: string;
  /** E5 M4: per-descendant manifest for directory captures — proves tree
   *  integrity at restore time (paths, kinds, sizes, bounded hashes). */
  treeManifest?: TreeManifest;
  headerIntegrity: string;
}

export interface TreeManifestEntry {
  rel: string;
  kind: 'file' | 'directory';
  size: number;
  sha256?: string;
}

export interface TreeManifest {
  complete: boolean;
  entries: TreeManifestEntry[];
}

function buildTreeManifest(root: string): TreeManifest {
  const entries: TreeManifestEntry[] = [];
  let complete = true;
  const walk = (dir: string, relBase: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      complete = false;
      return;
    }
    for (const name of names) {
      if (entries.length >= TREE_MANIFEST_MAX_ENTRIES) { complete = false; return; }
      const abs = path.join(dir, name);
      const rel = relBase ? `${relBase}/${name}` : name;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        complete = false;
        return;
      }
      if (st.isSymbolicLink()) { complete = false; entries.push({ rel, kind: 'file', size: -1 }); return; }
      if (st.isDirectory()) {
        entries.push({ rel, kind: 'directory', size: 0 });
        walk(abs, rel);
      } else {
        const entry: TreeManifestEntry = { rel, kind: 'file', size: st.size };
        if (st.size <= ITEM_HASH_MAX_BYTES) {
          entry.sha256 = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        } else {
          complete = false; // unhashable descendant → manifest incomplete
        }
        entries.push(entry);
      }
    }
  };
  walk(root, '');
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { complete, entries };
}

function verifyTreeManifest(root: string, manifest: TreeManifest): { ok: boolean; reason?: string } {
  const current = buildTreeManifest(root);
  if (!current.complete || !manifest.complete) return { ok: false, reason: 'tree manifest incomplete' };
  if (current.entries.length !== manifest.entries.length) {
    return { ok: false, reason: `descendant count changed since capture (${manifest.entries.length} → ${current.entries.length})` };
  }
  for (let i = 0; i < current.entries.length; i++) {
    const a = manifest.entries[i];
    const b = current.entries[i];
    if (a.rel !== b.rel || a.kind !== b.kind || a.size !== b.size || a.sha256 !== b.sha256) {
      return { ok: false, reason: `descendant changed since capture: ${a.rel}` };
    }
  }
  return { ok: true };
}

function canonicalMetaFields(m: Omit<QuarantineMeta, 'headerIntegrity'>): string {
  return JSON.stringify({
    schemaVersion: m.schemaVersion,
    quarantineId: m.quarantineId,
    kind: m.kind,
    originalPath: m.originalPath,
    dataIdentity: m.dataIdentity,
    contentSha256: m.contentSha256 ?? null,
    contentBytes: m.contentBytes ?? null,
    captureAt: m.captureAt,
    opId: m.opId ?? null,
    treeManifest: m.treeManifest ?? null,
  });
}

export function quarantineItemsDir(): string {
  const { root, protection } = getStorageInfo();
  if (!root || protection === 'unavailable') {
    throw new Error('quarantine storage unavailable — deletion cannot preserve required retention, refusing');
  }
  return path.join(root, 'quarantine', 'items');
}

function itemDataPath(id: string): string {
  return path.join(quarantineItemsDir(), `${id}.data`);
}
function itemMetaPath(id: string): string {
  return path.join(quarantineItemsDir(), `${id}.meta.json`);
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** True when the item's metadata parses AND its integrity self-hash verifies. */
export function readMeta(quarantineId: string): { readable: boolean; meta?: QuarantineMeta; reason?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(itemMetaPath(quarantineId), 'utf8');
  } catch {
    return { readable: false, reason: 'metadata missing or unreadable' };
  }
  try {
    const parsed = JSON.parse(raw) as QuarantineMeta;
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1) {
      return { readable: false, reason: 'metadata schema invalid' };
    }
    const { headerIntegrity, ...fields } = parsed;
    if (crypto.createHash('sha256').update(canonicalMetaFields(fields), 'utf8').digest('hex') !== headerIntegrity) {
      return { readable: false, reason: 'metadata integrity hash mismatch' };
    }
    return { readable: true, meta: parsed };
  } catch {
    return { readable: false, reason: 'metadata not parseable' };
  }
}

/** Capture a node into quarantine by RENAMING it (same volume — identity and
 *  content preserved exactly; child identities of directory trees preserved
 *  for later whole-tree restore). Cross-volume nodes: files up to the bounded
 *  cap are captured via two agreeing full reads (E1 verification); anything
 *  larger, and every directory, refuses instead of weakening verification. */
export function captureNode(info: { nodePath: string; identity: FileIdentity; isDirectory: boolean; opId: string }): { quarantineId: string } {
  const items = quarantineItemsDir();
  fs.mkdirSync(items, { recursive: true });
  if (countItems() >= QUARANTINE_MAX_ITEMS) {
    throw new Error(`quarantine retention cap (${QUARANTINE_MAX_ITEMS}) reached — delete refused so data is not silently lost; release items first`);
  }
  const quarantineId = crypto.randomUUID();
  const dataPath = itemDataPath(quarantineId);
  const storeDev = fs.statSync(path.dirname(items)).dev;
  let dataIdentity: FileIdentity;
  let contentSha256: string | undefined;
  const { dev: nodeDev } = info.identity;
  if (nodeDev === storeDev) {
    fs.renameSync(info.nodePath, dataPath); // identity + content preserved exactly
    dataIdentity = captureIdentity(dataPath)!;
  } else if (!info.isDirectory && info.identity.size <= ITEM_HASH_MAX_BYTES) {
    const read1 = fs.readFileSync(info.nodePath);
    const after1 = captureIdentity(info.nodePath);
    const read2 = fs.readFileSync(info.nodePath);
    const after2 = captureIdentity(info.nodePath);
    if (!read1.equals(read2) || !after1 || !after2 || !identityMatches(after1, after2).match) {
      throw new Error('source changed during quarantine capture (two agreeing reads failed) — delete refused, data preserved');
    }
    const fd = fs.openSync(dataPath, 'wx');
    try {
      fs.writeSync(fd, read2);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    dataIdentity = captureIdentity(dataPath)!;
  } else {
    throw new Error(info.isDirectory
      ? 'cross-volume directory deletion cannot preserve per-child identity into quarantine — refusing (conservative)'
      : 'cross-volume file exceeds the bounded quarantine capture cap — refusing (conservative)');
  }
  if (!info.isDirectory && dataIdentity.size <= ITEM_HASH_MAX_BYTES) {
    contentSha256 = sha256(fs.readFileSync(dataPath));
  }
  const meta: Omit<QuarantineMeta, 'headerIntegrity'> = {
    schemaVersion: 1,
    quarantineId,
    kind: info.isDirectory ? 'directory' : 'file',
    originalPath: info.nodePath,
    dataIdentity,
    contentSha256,
    contentBytes: dataIdentity.size,
    captureAt: Date.now(),
    opId: info.opId,
    ...(info.isDirectory ? { treeManifest: buildTreeManifest(dataPath) } : {}),
  };
  const withIntegrity: QuarantineMeta = { ...meta, headerIntegrity: sha256(Buffer.from(canonicalMetaFields(meta), 'utf8')) };
  durableWrite(itemMetaPath(quarantineId), JSON.stringify(withIntegrity, null, 2));
  if (nodeDev !== storeDev) {
    // Copy-capture: the origin must now be removed — the rename path already
    // moved the node; leaving the original behind would make the delete
    // report success while the file persists (false deletion).
    fs.unlinkSync(info.nodePath);
  }
  return { quarantineId };
}

function countItems(): number {
  try {
    return fs.readdirSync(quarantineItemsDir()).filter((f) => f.endsWith('.meta.json')).length;
  } catch {
    return 0;
  }
}

export interface QuarantineListItem {
  quarantineId: string;
  kind: 'file' | 'directory';
  originalPath?: string;
  readable: boolean;
  contentBytes?: number;
  captureAt?: number;
  reason?: string;
}

/** Read-only listing for the UI/operator. Unreadable items are LISTED (id +
 *  reason) but reveal no trusted path. */
export function listQuarantine(): { items: QuarantineListItem[]; globallyLocked: boolean; integrity: ReturnType<typeof scanQuarantineIntegrity> } {
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(quarantineItemsDir()).filter((f) => f.endsWith('.meta.json')).map((f) => f.replace('.meta.json', ''));
  } catch {
    return {
      items: [], globallyLocked: false,
      integrity: { valid: [], orphanedData: [], orphanedMeta: [], tempArtifacts: [], corrupted: [], unexpected: [], journalUnlinked: [], associationConflicts: [], journalOk: false, itemsDirAccessible: false, pagination: { digest: '', processed: 0, total: 0, nextAfter: null, completed: true } },
    };
  }
  const items: QuarantineListItem[] = [];
  let globallyLocked = false;
  for (const id of ids) {
    const r = readMeta(id);
    if (r.readable && r.meta) {
      items.push({ quarantineId: id, kind: r.meta.kind, originalPath: r.meta.originalPath, readable: true, contentBytes: r.meta.contentBytes, captureAt: r.meta.captureAt });
    } else {
      globallyLocked = true;
      items.push({ quarantineId: id, kind: 'file', readable: false, reason: r.reason });
    }
  }
  // E5 H1 — the listing always carries the current integrity classification
  // (additive field; read-only; no audit entry here — the explicit audited
  // scan is a separate operation).
  return { items, globallyLocked, integrity: scanQuarantineIntegrity() };
}

/** Explicit, audited integrity scan — the operator-visible "recovery"
 *  operation. It performs NO repair: orphaned artifacts stay locked and are
 *  reported for operator review, exactly as the fail-closed design requires.
 *  E5 H2: a scan WITHOUT a continuation walks ALL pages and audits ONE
 *  aggregate record (completed=true, processed=total); a scan WITH a
 *  continuation audits its single page as PARTIAL — audit consumers can
 *  never mistake a page for a complete classification. */
export function auditedQuarantineScan(options?: ScanOptions): QuarantineIntegrityReport {
  if (options?.continuation === undefined) {
    const complete = scanQuarantineIntegrityComplete(options?.limit);
    appendAuditSyncSafe({
      kind: 'e5_quarantine_scan',
      completed: true,
      processed: complete.pagination.processed,
      total: complete.pagination.total,
      digest: complete.pagination.digest,
      pages: complete.pages,
      valid: complete.valid.length,
      journalOk: complete.journalOk,
      journalUnlinked: complete.journalUnlinked.map((o) => o.quarantineId),
      orphanedData: complete.orphanedData.map((o) => o.quarantineId),
      orphanedMeta: complete.orphanedMeta.map((o) => o.quarantineId),
      tempArtifacts: complete.tempArtifacts.map((o) => o.fileName),
      corrupted: complete.corrupted.map((c) => c.quarantineId),
      unexpected: complete.unexpected.map((u) => u.fileName),
      associationConflicts: complete.associationConflicts.map((c) => c.quarantineId),
    });
    return complete;
  }
  const report = scanQuarantineIntegrity(options);
  appendAuditSyncSafe({
    kind: 'e5_quarantine_scan',
    completed: report.pagination.completed,
    processed: report.pagination.processed,
    total: report.pagination.total,
    digest: report.pagination.digest,
    valid: report.valid.length,
    journalOk: report.journalOk,
    journalUnlinked: report.journalUnlinked.map((o) => o.quarantineId),
    orphanedData: report.orphanedData.map((o) => o.quarantineId),
    orphanedMeta: report.orphanedMeta.map((o) => o.quarantineId),
    tempArtifacts: report.tempArtifacts.map((o) => o.fileName),
    corrupted: report.corrupted.map((c) => c.quarantineId),
    unexpected: report.unexpected.map((u) => u.fileName),
    associationConflicts: report.associationConflicts.map((c) => c.quarantineId),
  });
  return report;
}

// ---------------------------------------------------------------------------
// E5 H1 — quarantine integrity scan (finding F5).
//
// Classifies every artifact in the quarantine items directory. READ-ONLY and
// IDEMPOTENT: it never renames, releases, deletes, or repairs anything. An
// orphan whose original path or operation identity cannot be established from
// TRUSTED records (integrity-verified metadata + journal association) stays
// locked and is reported for operator review — nothing is manufactured.
// Crash windows covered by the classification:
//   W1/W2  data written/moved before the metadata durable-write → orphanedData
//   W3     metadata durable-write interrupted            → tempArtifacts
//   W4/W5  capture complete but the journal record never written → journalUnlinked
//   restore-side  data moved out before the record cleanup      → orphanedMeta
// ---------------------------------------------------------------------------

export interface OrphanRecord {
  quarantineId: string;
  fileName: string;
  reason: string;
}

export type JournalAssociation = 'verified' | 'unverified' | 'conflicted' | 'unverifiable-journal';

export interface ValidEntry {
  quarantineId: string;
  kind: 'file' | 'directory';
  originalPath: string;
  journalAssociated: boolean;
  /** E5 H2 — WHY the association stands or falls:
   *  verified            = journal integrity OK + exactly one well-formed
   *                        delete record + recorded origin path and opId agree
   *                        with the metadata (consistency, not cryptography —
   *                        a consistent same-user forgery is out of scope);
   *  unverified          = no record found although the journal is healthy —
   *                        compaction may have discarded it, or W4/W5 crash;
   *                        HISTORICALLY UNVERIFIABLE either way;
   *  conflicted          = duplicate/conflicting records or metadata↔record
   *                        disagreement;
   *  unverifiable-journal = the journal itself failed integrity — no
   *                        association can be proven from it. */
  association: JournalAssociation;
}

export interface QuarantineIntegrityReport {
  valid: ValidEntry[];
  orphanedData: OrphanRecord[];   // .data without metadata — origin state unknown, LOCKED
  orphanedMeta: OrphanRecord[];   // metadata without .data — data already left quarantine
  tempArtifacts: OrphanRecord[];  // interrupted durable-write remnants (.tmp)
  corrupted: OrphanRecord[];      // unreadable / id-conflicting / identity-mismatched metadata
  unexpected: OrphanRecord[];     // anything that is neither .data, .meta.json, nor .tmp
  journalUnlinked: OrphanRecord[]; // internally valid entries with an UNVERIFIED journal association
  associationConflicts: OrphanRecord[]; // E5 H2 — duplicate/conflicting journal records
  /** E5 H2 — false when the journal failed integrity: no association in this
   *  report can be trusted (all are unverifiable-journal). */
  journalOk: boolean;
  /** E5 H4 — false when the items directory exists but could not be read:
   *  verification was UNAVAILABLE and this report is NOT a healthy empty scan. */
  itemsDirAccessible: boolean;
  pagination: { digest: string; processed: number; total: number; nextAfter: string | null; completed: boolean };
}

export interface ScanContinuation {
  /** Last artifact name processed (deterministic sorted order). */
  after?: string;
  /** Snapshot digest the first page computed — binds continuation to an
   *  unchanged artifact set; any change fails the continuation closed. */
  digest?: string;
}

export interface ScanOptions {
  continuation?: ScanContinuation;
  /** Artifacts classified per call. Default 100, capped at 500. */
  limit?: number;
}

function expectedDataName(id: string): string {
  return `${id}.data`;
}

const SCAN_PAGE_DEFAULT = 100;
const SCAN_PAGE_MAX = 500;

function snapshotDigest(sortedNames: string[]): string {
  return crypto.createHash('sha256').update(sortedNames.join('\n'), 'utf8').digest('hex');
}

interface JournalRecordIndex {
  ok: boolean;
  /** quarantineId → ALL mutation records referencing it (duplicates detectable). */
  byQuarantineId: Map<string, Array<SandboxJournalEntry & { op?: string; from?: string; opId?: string; quarantineId?: string }>>;
}

/** E5 H2 — build a TRUST-AWARE journal index. A parsed record is not yet a
 *  trustworthy association: the journal must pass integrity, records must be
 *  well-formed delete records, and duplicates are surfaced as conflicts. */
function buildJournalIndex(): JournalRecordIndex {
  const integrity = journalIntegrityCheck();
  const index: JournalRecordIndex = { ok: integrity.ok, byQuarantineId: new Map() };
  if (!integrity.ok) return index; // associations cannot be proven from a corrupt journal
  for (const e of readJournalEntries()) {
    if (e.t !== 'mutation') continue;
    const rec = e as SandboxJournalEntry & { op?: string; from?: string; opId?: string; quarantineId?: string };
    if (typeof rec.quarantineId !== 'string') continue;
    const list = index.byQuarantineId.get(rec.quarantineId) ?? [];
    list.push(rec);
    index.byQuarantineId.set(rec.quarantineId, list);
  }
  return index;
}

/** E5 H2 — verify ONE metadata entry against its journal records.
 *  Returns the association verdict; conflicts carry precise reasons. */
function verifyAssociation(
  meta: QuarantineMeta,
  records: Array<SandboxJournalEntry & { op?: string; from?: string; opId?: string; quarantineId?: string }>,
  journalOk: boolean,
): { association: JournalAssociation; conflict?: OrphanRecord } {
  if (!journalOk) {
    return { association: 'unverifiable-journal' };
  }
  if (records.length === 0) {
    // The journal is healthy and the entry is simply not in it — either the
    // capture crashed before the record (W4/W5) or compaction discarded the
    // historical record. BOTH are historically unverifiable; no cause is invented.
    return { association: 'unverified' };
  }
  if (records.length > 1) {
    return {
      association: 'conflicted',
      conflict: {
        quarantineId: meta.quarantineId,
        fileName: `${meta.quarantineId}.meta.json`,
        reason: `${records.length} journal records reference this quarantine id (duplicate operation identifiers) — association conflicted, fail closed`,
      },
    };
  }
  const rec = records[0];
  if (rec.op !== 'delete' && rec.op !== 'delete-dir') {
    return {
      association: 'conflicted',
      conflict: {
        quarantineId: meta.quarantineId,
        fileName: `${meta.quarantineId}.meta.json`,
        reason: `journal record carries quarantineId on a non-delete operation ("${rec.op}") — conflicted`,
      },
    };
  }
  if (typeof rec.from !== 'string' || canonicalForCompare(rec.from) !== canonicalForCompare(meta.originalPath)) {
    return {
      association: 'conflicted',
      conflict: {
        quarantineId: meta.quarantineId,
        fileName: `${meta.quarantineId}.meta.json`,
        reason: 'journal record origin path disagrees with the metadata originalPath — conflicted',
      },
    };
  }
  if (meta.opId && rec.opId && meta.opId !== rec.opId) {
    return {
      association: 'conflicted',
      conflict: {
        quarantineId: meta.quarantineId,
        fileName: `${meta.quarantineId}.meta.json`,
        reason: 'journal record opId disagrees with the metadata opId — conflicted',
      },
    };
  }
  return { association: 'verified' };
}

/** E5 H1/H2 — quarantine integrity scan. READ-ONLY and IDEMPOTENT: it never
 *  renames, releases, deletes, or repairs anything. Classification covers
 *  every artifact in the items directory; pagination is deterministic
 *  (sorted artifact names) with a snapshot digest binding each continuation
 *  to an UNCHANGED artifact set — any change fails the continuation closed
 *  rather than producing a false integrity claim. */
export function scanQuarantineIntegrity(options?: ScanOptions): QuarantineIntegrityReport {
  const items = quarantineItemsDir(); // throws when storage unavailable → fail closed
  const limit = Math.max(1, Math.min(options?.limit ?? SCAN_PAGE_DEFAULT, SCAN_PAGE_MAX));
  const report: QuarantineIntegrityReport = {
    valid: [], orphanedData: [], orphanedMeta: [], tempArtifacts: [], corrupted: [], unexpected: [], journalUnlinked: [], associationConflicts: [],
    journalOk: false,
    itemsDirAccessible: true,
    pagination: { digest: '', processed: 0, total: 0, nextAfter: null, completed: false },
  };
  let entries: string[];
  try {
    entries = fs.readdirSync(items).sort();
  } catch {
    // E5 H4 — distinguish "fresh install (directory absent)" from "directory
    // exists but is unreadable" — the latter is a VERIFICATION FAILURE and
    // must never be reported as a healthy empty scan.
    if (fs.existsSync(items)) {
      report.itemsDirAccessible = false;
      report.pagination.completed = true;
      return report; // flagged via itemsDirAccessible; the monitor maps it to degraded
    }
    report.pagination.completed = true; // no items directory yet — trivially complete
    return report; // nothing to classify
  }
  report.pagination.digest = snapshotDigest(entries);
  report.pagination.total = entries.length;

  // Continuation: bind to the exact artifact set; any change fails closed.
  if (options?.continuation?.after !== undefined || options?.continuation?.digest !== undefined) {
    const { after, digest } = options.continuation;
    if (typeof digest !== 'string' || digest !== report.pagination.digest) {
      throw new Error('quarantine artifact set changed between scan pages — continuation refused (fail closed; restart the scan)');
    }
    if (after !== undefined && (typeof after !== 'string' || !entries.includes(after))) {
      throw new Error('continuation cursor does not match the artifact set — continuation refused (fail closed; restart the scan)');
    }
  }
  const after = options?.continuation?.after;
  const pending = after === undefined ? entries : entries.filter((n) => n > after);
  const page = pending.slice(0, limit);
  report.pagination.processed = page.length;
  report.pagination.completed = pending.length <= limit;
  report.pagination.nextAfter = report.pagination.completed ? null : page[page.length - 1];

  // Journal trust: integrity first — a corrupt journal proves no association.
  const journal = buildJournalIndex();
  report.journalOk = journal.ok;

  const metaIds = new Set<string>();
  const dataIds = new Set<string>();
  // The FULL meta-id set (not page-local): a data/meta pair split across a
  // page boundary must never classify the data as orphaned.
  const allMetaIds = new Set(entries.filter((n) => n.endsWith('.meta.json')).map((n) => n.slice(0, -'.meta.json'.length)));
  for (const name of page) {
    if (name.endsWith('.meta.json')) metaIds.add(name.slice(0, -'.meta.json'.length));
    else if (name.endsWith('.data')) dataIds.add(name.slice(0, -'.data'.length));
    else if (name.endsWith('.tmp')) report.tempArtifacts.push({ quarantineId: name, fileName: name, reason: 'interrupted durable-write artifact' });
    else report.unexpected.push({ quarantineId: name, fileName: name, reason: 'unrecognized artifact in quarantine items directory' });
  }

  // Metadata files: verify integrity, filename/id agreement, data presence,
  // then the journal association (never trusted from a bare ID match).
  for (const id of metaIds) {
    const fileName = `${id}.meta.json`;
    const r = readMeta(id);
    if (!r.readable || !r.meta) {
      report.corrupted.push({ quarantineId: id, fileName, reason: r.reason ?? 'metadata unreadable' });
      continue;
    }
    if (r.meta.quarantineId !== id) {
      report.corrupted.push({ quarantineId: id, fileName, reason: 'metadata quarantineId conflicts with its filename — duplicate or conflicting identifier, fail closed' });
      continue;
    }
    const dataPresent = fs.existsSync(itemDataPath(id));
    if (!dataPresent) {
      report.orphanedMeta.push({ quarantineId: id, fileName, reason: 'metadata without quarantine data — the data already left quarantine or was never captured' });
      continue;
    }
    const dataNow = captureIdentity(itemDataPath(id));
    if (!dataNow || !identityMatches(r.meta.dataIdentity, dataNow).match) {
      report.corrupted.push({ quarantineId: id, fileName, reason: 'quarantine data identity does not match the metadata header' });
      continue;
    }
    const verdict = verifyAssociation(r.meta, journal.byQuarantineId.get(id) ?? [], journal.ok);
    if (verdict.conflict) report.associationConflicts.push(verdict.conflict);
    const journalAssociated = verdict.association === 'verified';
    report.valid.push({ quarantineId: id, kind: r.meta.kind, originalPath: r.meta.originalPath, journalAssociated, association: verdict.association });
    if (verdict.association === 'unverified') {
      report.journalUnlinked.push({ quarantineId: id, fileName, reason: 'valid entry with no journal record although the journal is healthy — historically unverifiable (compaction or crash window W4/W5); kept locked, reported for review' });
    }
  }

  // Data files without metadata: the F5 orphan class — LOCKED, never touched.
  // The check runs against the FULL meta-id set so a page boundary can never
  // split a data/meta pair into a false orphan.
  for (const id of dataIds) {
    if (allMetaIds.has(id)) continue;
    report.orphanedData.push({
      quarantineId: id,
      fileName: expectedDataName(id),
      reason: 'quarantine data without metadata — original path and operation identity are UNKNOWN; the file is retained and locked (never released or deleted automatically)',
    });
  }
  return report;
}

/** E5 H2 — complete-scan helper: walks ALL pages via continuation, verifying
 *  the artifact set never changed. Still READ-ONLY. Used where a complete
 *  classification is required in one call (bounded per underlying page). */
export function scanQuarantineIntegrityComplete(limit?: number): QuarantineIntegrityReport & { pages: number } {
  const merged: QuarantineIntegrityReport = {
    valid: [], orphanedData: [], orphanedMeta: [], tempArtifacts: [], corrupted: [], unexpected: [], journalUnlinked: [], associationConflicts: [],
    journalOk: true, itemsDirAccessible: true, pagination: { digest: '', processed: 0, total: 0, nextAfter: null, completed: false },
  };
  let pages = 0;
  let after: string | undefined;
  let digest: string | undefined;
  for (;;) {
    const page = scanQuarantineIntegrity({ continuation: { after, digest }, limit });
    merged.journalOk = merged.journalOk && page.journalOk;
    merged.itemsDirAccessible = merged.itemsDirAccessible && page.itemsDirAccessible;
    merged.pagination.digest = page.pagination.digest;
    merged.pagination.total = page.pagination.total;
    merged.pagination.processed += page.pagination.processed;
    for (const key of ['valid', 'orphanedData', 'orphanedMeta', 'tempArtifacts', 'corrupted', 'unexpected', 'journalUnlinked', 'associationConflicts'] as const) {
      (merged[key] as unknown[]).push(...(page[key] as unknown[]));
    }
    pages++;
    if (page.pagination.completed) { merged.pagination.completed = true; merged.pagination.nextAfter = null; break; }
    after = page.pagination.nextAfter!;
    digest = page.pagination.digest;
  }
  return { ...merged, pages };
}

function canonicalForCompare(p: string): string {
  return path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
}

function verifyContentIfHashed(meta: QuarantineMeta): Buffer | null {
  if (!meta.contentSha256) return null; // unhashed (oversized) — caller decides
  const read1 = fs.readFileSync(itemDataPath(meta.quarantineId));
  const read2 = fs.readFileSync(itemDataPath(meta.quarantineId));
  if (!read1.equals(read2)) throw new Error('quarantine data changed between the two agreeing reads (E1 verification failed) — restore refused');
  if (sha256(read2) !== meta.contentSha256) throw new Error('quarantine data hash does not match its capture header — restore refused');
  return read2;
}

/**
 * Verified restore of one quarantine item to its exact captured path.
 * NEVER overwrites: the origin must be free. Uses M2 staging (O_EXCL +
 * identity-verified commit) for file content; directories rename back
 * whole-tree (child identities preserved by the capture rename).
 * Passes the M1 in-process gate (stop → permission → audit).
 */
export function restoreFromQuarantine(quarantineId: string, declaredPath: string): { restored: true; path: string; verifiedBy: string } {
  // E5 H5 — class quarantine-release: the mutation gate's journal/audit policy
  // does not apply here (restore safety is proven per-item); store-level and
  // stop/permission enforcement still apply.
  assertSandboxMutation('filesystem.write', 'quarantine-restore', declaredPath, 'quarantine-release');
  const { protection } = getStorageInfo();
  if (protection !== 'full') {
    throw new Error(`quarantine restore refused: storage protection is "${protection}" — a tamperable store cannot prove capture integrity for a destructive operation`);
  }
  const r = readMeta(quarantineId);
  if (!r.readable || !r.meta) {
    throw new Error(`quarantine header unreadable (${r.reason}) — item remains locked, restore refused`);
  }
  const meta = r.meta;
  if (canonicalForCompare(declaredPath) !== canonicalForCompare(meta.originalPath)) {
    throw new Error(`declared path does not match the quarantine capture record — release refused (scoped claim violated)`);
  }
  // E5 M4: re-validate the restore destination against the CURRENT path
  // safety rules — a parent replaced by a junction (or any protected/
  // out-of-root landing) must refuse rather than restore through it.
  const revalidated = resolveSafePath(meta.originalPath, 'write');
  assertNotProtected(revalidated, 'write');
  if (canonicalForCompare(revalidated) !== canonicalForCompare(meta.originalPath)) {
    throw new Error('restore destination no longer resolves to its captured path (aliasing/junction substitution) — refusing');
  }
  if (fs.existsSync(meta.originalPath)) {
    throw new Error(`"${meta.originalPath}" now exists — refusing to overwrite unexpected user changes`);
  }
  const dataNow = captureIdentity(itemDataPath(meta.quarantineId));
  if (!dataNow || !identityMatches(meta.dataIdentity, dataNow).match) {
    throw new Error('quarantine data identity does not match its capture header — restore refused');
  }
  if (meta.kind === 'directory') {
    if (!meta.treeManifest) {
      throw new Error('directory capture predates tree manifests — descendant integrity cannot be proven, restore refused (conservative)');
    }
    if (!meta.treeManifest.complete) {
      throw new Error('tree manifest was incomplete at capture — descendant integrity cannot be proven, restore refused (conservative)');
    }
    const v = verifyTreeManifest(itemDataPath(meta.quarantineId), meta.treeManifest);
    if (!v.ok) {
      throw new Error(`quarantined tree changed since capture (${v.reason}) — restore refused, data preserved`);
    }
    fs.renameSync(itemDataPath(meta.quarantineId), meta.originalPath);
  } else {
    const content = verifyContentIfHashed(meta);
    if (content) {
      // E1 verification: the restored content is what Krisha verified via
      // two agreeing full reads of the quarantine source.
      const sw = stageFile(meta.originalPath, content, 'quarantine-restore');
      try {
        commitStaged(sw);
      } catch (err) {
        abortStaged(sw);
        throw err;
      }
    } else {
      // Oversized unhashed capture: same-volume rename restore (identity
      // verified above); cross-volume would be unverifiable → refused.
      fs.renameSync(itemDataPath(meta.quarantineId), meta.originalPath);
    }
  }
  // Retention ends only after a VERIFIED restore: remove the (now empty)
  // record. Ownership was established above; the data node has moved out.
  try {
    fs.rmSync(itemDataPath(meta.quarantineId), { force: true });
    fs.rmSync(itemMetaPath(meta.quarantineId), { force: true });
  } catch { /* best-effort record cleanup; restore itself is complete */ }
  return { restored: true, path: meta.originalPath, verifiedBy: meta.contentSha256 ? `two agreeing full reads + content hash (${E1_CONTRACT})` : 'rename-preserving identity match' };
}

/**
 * Operator release flow: declarations are EXACT affected paths. Readable
 * items are matched one-to-one (scoped claims). If ANY unreadable item
 * exists the whole quarantine is locked: nothing is released until the
 * operator resolves the inconsistency out-of-band (with the server stopped).
 */
export function releaseQuarantine(declaredPaths: string[]): { released: string[]; refused: Array<{ declared: string; reason: string }> } {
  const kind = stopKind();
  if (kind !== 'INACTIVE') {
    appendAuditSyncSafe({ kind: 'e5_quarantine_blocked_stop', stopKind: kind });
    throw new Error('emergency stop is ACTIVE — quarantine release refused');
  }
  const granted = serverPermissions.isGranted('filesystem.write') ||
    serverPermissions.checkScoped('filesystem.write').status === 'granted';
  if (!granted) {
    appendAuditSyncSafe({ kind: 'e5_quarantine_blocked_permission', permission: 'filesystem.write' });
    throw new Error('permission_denied: filesystem.write');
  }
  const { items, globallyLocked } = listQuarantine();
  if (globallyLocked) {
    appendAuditSyncSafe({ kind: 'e5_quarantine_locked', reason: 'unreadable quarantine header present' });
    throw new Error('quarantine contains an item with an unreadable header — the quarantine is GLOBALLY LOCKED until that inconsistency is resolved out-of-band; no releases permitted');
  }
  const released: string[] = [];
  const refused: Array<{ declared: string; reason: string }> = [];
  const byPath = new Map<string, QuarantineListItem>();
  for (const it of items) if (it.readable && it.originalPath) byPath.set(canonicalForCompare(it.originalPath), it);
  for (const declared of declaredPaths) {
    const match = byPath.get(canonicalForCompare(declared));
    if (!match) {
      refused.push({ declared, reason: 'no readable quarantine item matches this exact path (unknown ownership is not permission to release)' });
      continue;
    }
    try {
      const res = restoreFromQuarantine(match.quarantineId, declared);
      released.push(res.path);
      appendAuditSyncSafe({ kind: 'e5_quarantine_released', path: res.path, quarantineId: match.quarantineId, verifiedBy: res.verifiedBy });
    } catch (err) {
      refused.push({ declared, reason: String((err as Error)?.message || err) });
      appendAuditSyncSafe({ kind: 'e5_quarantine_release_refused', path: declared, reason: String((err as Error)?.message || err) });
    }
  }
  return { released, refused };
}
