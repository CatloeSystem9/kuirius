/**
 * Initiation Subsystem — durable outbox queue.
 *
 * The trigger engine (Node) writes here; the executor (browser) reads from
 * here. The queue is the handoff point between the two halves:
 *
 *   trigger fires  ->  enqueue()  ->  [persistent file]  ->  claim()  ->  ack()
 *
 * Why a queue instead of a direct call: the browser is not always open. A
 * mission that fires at 09:00 must survive until Krisha is next running, and
 * a reboot in the middle must not lose it. The file-backed store makes the
 * handoff durable and replayable.
 *
 * Leases (not a destructive pop) so a client that dies mid-delivery does not
 * swallow the work: an expired lease returns the record to `pending`.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { InitiationAck, InitiationLease, InitiationOutcome, InitiationRecord } from './contracts';

export interface InitiationQueueOptions {
  /** Where the queue file lives. */
  storagePath?: string;
  /** How long a delivery lease is valid before the record returns to pending. */
  leaseMs?: number;
  /** Max records retained (including finished history). */
  maxRecords?: number;
  /** Max finished records kept for the recent-history view. */
  maxFinished?: number;
  now?: () => number;
  audit?: (event: { kind: string; [key: string]: unknown }) => void;
}

const DEFAULT_STORE_DIR = path.join(process.cwd(), '.krisha');
const DEFAULT_QUEUE_FILE = 'initiation_queue.json';

/** Records older than this are dropped from the backlog entirely. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface QueueFile {
  schemaVersion: number;
  records: InitiationRecord[];
}

const QUEUE_SCHEMA_VERSION = 1;

export class InitiationQueue {
  private records: InitiationRecord[] = [];
  private loaded = false;
  private readonly storagePath: string;
  private readonly leaseMs: number;
  private readonly maxRecords: number;
  private readonly maxFinished: number;
  private readonly now: () => number;
  private readonly audit?: (event: { kind: string; [key: string]: unknown }) => void;

  constructor(options: InitiationQueueOptions = {}) {
    this.storagePath = options.storagePath || path.join(DEFAULT_STORE_DIR, DEFAULT_QUEUE_FILE);
    this.leaseMs = options.leaseMs ?? 90_000;
    this.maxRecords = options.maxRecords ?? 200;
    this.maxFinished = options.maxFinished ?? 40;
    this.now = options.now || (() => Date.now());
    this.audit = options.audit;
    this.ensureLoaded();
  }

  /**
   * Add a record to the backlog. Returns the stored record.
   *
   * When the record carries a `dedupeKey`, an existing PENDING record with
   * the same key is REPLACED rather than duplicated — "the latest thing that
   * happened" wins, so a burst of process events becomes one notification
   * instead of ten.
   */
  public enqueue(record: Omit<InitiationRecord, 'status' | 'attempts'>): InitiationRecord {
    this.ensureLoaded();
    const now = this.now();

    if (record.dedupeKey) {
      const index = this.records.findIndex(
        (r) => r.status === 'pending' && r.dedupeKey === record.dedupeKey
      );
      if (index !== -1) {
        const existing = this.records[index];
        const replaced: InitiationRecord = {
          ...record,
          status: 'pending',
          attempts: existing.attempts,
          createdAt: now,
        };
        this.records[index] = replaced;
        this.persist();
        this.audit?.({
          kind: 'initiation_deduped',
          id: replaced.id,
          dedupeKey: record.dedupeKey,
        });
        return replaced;
      }
    }

    const stored: InitiationRecord = {
      ...record,
      status: 'pending',
      attempts: 0,
      createdAt: record.createdAt || now,
    };
    this.records.push(stored);
    this.prune();
    this.persist();
    this.audit?.({ kind: 'initiation_enqueued', id: stored.id, source: stored.source, action: stored.action });
    return stored;
  }

  /**
   * Lease pending records for a client. Records whose lease expired become
   * pending again and are handed out afresh — a crashed client never eats
   * the work silently.
   */
  public claim(clientId: string, limit = 10): InitiationLease[] {
    this.ensureLoaded();
    const now = this.now();
    this.reclaimExpired(now);

    const ready = this.records
      .filter((r) => r.status === 'pending')
      .filter((r) => !r.notBefore || r.notBefore <= now)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, Math.max(0, limit));

    const leases: InitiationLease[] = [];
    for (const record of ready) {
      record.status = 'claimed';
      record.claimedAt = now;
      record.clientId = clientId;
      record.attempts += 1;
      leases.push({ record: { ...record }, expiresAt: now + this.leaseMs });
    }
    if (leases.length) this.persist();
    this.audit?.({ kind: 'initiation_claimed', clientId, count: leases.length });
    return leases;
  }

  /**
   * Push a record back into the queue, to be handed out again after
   * `delayMs`. Used when an initiation could not be delivered right now
   * (quiet hours, user busy) — deferring is honest, dropping is not.
   *
   * Returns false when the deferral budget is exhausted; the caller should
   * then complete the record as skipped.
   */
  public defer(id: string, delayMs: number, maxDeferrals = 12): boolean {
    this.ensureLoaded();
    const record = this.records.find((r) => r.id === id);
    if (!record) return false;
    const count = (record.deferCount || 0) + 1;
    if (count > maxDeferrals) return false;
    record.deferCount = count;
    record.status = 'pending';
    record.notBefore = this.now() + Math.max(0, delayMs);
    delete record.claimedAt;
    delete record.clientId;
    this.persist();
    this.audit?.({ kind: 'initiation_deferred', id, delayMs, deferCount: count });
    return true;
  }

  /** The executor finished a record. */
  public complete(id: string, outcome: InitiationOutcome): boolean {
    this.ensureLoaded();
    const record = this.records.find((r) => r.id === id);
    if (!record) return false;
    record.status = outcome.success ? 'done' : 'failed';
    record.result = { ...outcome, completedAt: this.now() };
    delete record.claimedAt;
    delete record.clientId;
    this.persist();
    this.audit?.({ kind: 'initiation_completed', id, success: outcome.success });
    return true;
  }

  /** Apply an ack from the executor (success/failure/skip). */
  public acknowledge(ack: InitiationAck): boolean {
    return this.complete(ack.id, {
      success: ack.success,
      summary: ack.skipped ? `skipped: ${ack.skipped}` : ack.summary,
    });
  }

  /** Put a record back into the pending state (used by explicit retry). */
  public requeue(id: string): boolean {
    this.ensureLoaded();
    const record = this.records.find((r) => r.id === id);
    if (!record) return false;
    record.status = 'pending';
    delete record.claimedAt;
    delete record.clientId;
    this.persist();
    return true;
  }

  /** All records, newest first (diagnostics view). */
  public list(): InitiationRecord[] {
    this.ensureLoaded();
    return [...this.records].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Records still waiting for delivery (and already due). */
  public pending(): InitiationRecord[] {
    this.ensureLoaded();
    const now = this.now();
    this.reclaimExpired(now);
    return this.records
      .filter((r) => r.status === 'pending')
      .filter((r) => !r.notBefore || r.notBefore <= now)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Summary counts for the status endpoint. */
  public stats(): { total: number; pending: number; claimed: number; done: number; failed: number } {
    this.ensureLoaded();
    const counts = { total: this.records.length, pending: 0, claimed: 0, done: 0, failed: 0 };
    for (const r of this.records) {
      if (r.status === 'pending') counts.pending += 1;
      else if (r.status === 'claimed') counts.claimed += 1;
      else if (r.status === 'done') counts.done += 1;
      else counts.failed += 1;
    }
    return counts;
  }

  // ------------------------------------------------------------- internals

  /** Expired leases go back to pending so the work is not lost. */
  private reclaimExpired(now: number): void {
    let changed = false;
    for (const record of this.records) {
      if (record.status !== 'claimed') continue;
      const claimedAt = record.claimedAt ?? 0;
      if (now - claimedAt < this.leaseMs) continue;
      record.status = 'pending';
      delete record.claimedAt;
      delete record.clientId;
      changed = true;
    }
    if (changed) this.persist();
  }

  /** Bound the store: drop stale records and trim finished history. */
  private prune(): void {
    const now = this.now();
    this.records = this.records.filter((r) => {
      if (r.status === 'pending' || r.status === 'claimed') return true;
      return now - r.createdAt < MAX_AGE_MS;
    });

    const finished = this.records.filter((r) => r.status === 'done' || r.status === 'failed');
    if (finished.length > this.maxFinished) {
      const excess = finished.length - this.maxFinished;
      const drop = new Set(
        finished
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, excess)
          .map((r) => r.id)
      );
      this.records = this.records.filter((r) => !drop.has(r.id));
    }

    if (this.records.length > this.maxRecords) {
      const excess = this.records.length - this.maxRecords;
      // Oldest finished records go first; pending work is never dropped.
      const removable = this.records
        .filter((r) => r.status === 'done' || r.status === 'failed')
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, excess);
      const drop = new Set(removable.map((r) => r.id));
      this.records = this.records.filter((r) => !drop.has(r.id));
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.storagePath)) return;
      const raw = fs.readFileSync(this.storagePath, 'utf8');
      const parsed = JSON.parse(raw) as QueueFile;
      const list = Array.isArray(parsed?.records) ? parsed.records : [];
      for (const record of list) {
        if (!record || typeof record.id !== 'string') continue;
        if (typeof record.title !== 'string' || typeof record.message !== 'string') continue;
        this.records.push({
          ...record,
          status: record.status || 'pending',
          attempts: typeof record.attempts === 'number' ? record.attempts : 0,
          createdAt: typeof record.createdAt === 'number' ? record.createdAt : this.now(),
        });
      }
    } catch (err) {
      console.warn('[InitiationQueue] Could not load queue (starting empty):', err);
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data: QueueFile = { schemaVersion: QUEUE_SCHEMA_VERSION, records: this.records };
      fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.warn('[InitiationQueue] Could not persist queue:', err);
    }
  }
}
