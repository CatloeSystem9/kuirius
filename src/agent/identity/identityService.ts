/**
 * Persistent Identity Foundation (Step 1) — service facade.
 *
 * The single authorization boundary for Krisha's identity:
 *  - Read access is free: every consumer (chat pipeline, providers, future
 *    phases) receives the same canonical identity.
 *  - Mutation is deliberate and validated only: identityId is immutable,
 *    schemaVersion advances only through migrations, every update is
 *    checksummed, and a bounded change history records who/when (no secrets
 *    ever pass through here — identity contains no user data).
 *  - Initialization is guarded: one singleton per JS context, and concurrent
 *    first-runs adopt the already-stored identityId instead of minting a new
 *    one (duplicate-initialization protection).
 */
import type { StorageAdapter } from '../taskState';
import { localStorageAdapter, MemoryStorage } from '../taskState';
import {
  IDENTITY_SCHEMA_VERSION,
  type KrishaIdentity,
  type IdentityTransportPayload,
} from './identityTypes';
import {
  CANONICAL_IDENTITY,
  identityContentHash,
  renderIdentityPromptBlock,
  validateIdentityRecord,
} from './identityDefinition';
import { IdentityStore } from './identityStore';

export interface IdentityChangeRecord {
  at: number;
  /** What changed (bounded, human-readable). */
  note: string;
  fromVersion: number;
  toVersion: number;
}

export interface IdentityUpdateResult {
  ok: boolean;
  identity?: KrishaIdentity;
  issues: string[];
}

const MAX_CHANGE_HISTORY = 20;

export class IdentityService {
  private store: IdentityStore;
  private current: KrishaIdentity;
  private changeHistory: IdentityChangeRecord[] = [];
  /** Status reported by the last load (observability without exposing internals). */
  readonly lastLoad: { status: string; issues: string[] };

  constructor(storage: StorageAdapter = new MemoryStorage()) {
    this.store = new IdentityStore(storage);
    const loaded = this.store.load();
    this.current = loaded.identity;
    this.lastLoad = { status: loaded.status, issues: loaded.issues };
  }

  /** The current persistent identity (always schema-valid; never null). */
  get(): KrishaIdentity {
    return this.current;
  }

  /** The stable identifier — constant across restarts, models and providers. */
  getIdentityId(): string {
    return this.current.identityId;
  }

  /**
   * The canonical identity block for AI providers. Provider-neutral; callers
   * may reformat around it but must not redefine its content.
   */
  renderPromptBlock(): string {
    return renderIdentityPromptBlock(this.current);
  }

  /**
   * Transport payload for provider boundaries (e.g. /api/chat). Structured
   * data only — the receiving side re-validates and renders it itself, so a
   * compromised transport cannot inject pre-rendered identity prose.
   */
  getTransportPayload(): IdentityTransportPayload {
    return {
      identityId: this.current.identityId,
      name: this.current.name,
      archetype: this.current.archetype,
      version: this.current.version,
      personality: { ...this.current.personality },
      communication: { ...this.current.communication },
      principles: [...this.current.principles],
      contentHash: this.current.contentHash,
    };
  }

  /**
   * Deliberate, validated update path (used by future phases; there is no UI
   * or automatic caller in Step 1). Rules enforced:
   *  - identityId is immutable;
   *  - schemaVersion advances only via migrations (not via updates);
   *  - checksum recomputed on every accepted change;
   *  - change history is bounded (oldest evicted).
   */
  applyUpdate(patch: Partial<KrishaIdentity>, note: string): IdentityUpdateResult {
    const issues: string[] = [];
    if (typeof patch.identityId !== 'undefined' && patch.identityId !== this.current.identityId) {
      return { ok: false, issues: ['identityId is immutable — identity replacement is refused'] };
    }
    if (typeof patch.schemaVersion !== 'undefined' && patch.schemaVersion !== this.current.schemaVersion) {
      return { ok: false, issues: ['schemaVersion changes only through migrations'] };
    }
    if (patch.version !== undefined && (typeof patch.version !== 'number' || patch.version < this.current.version)) {
      return { ok: false, issues: ['identity version may not decrease'] };
    }

    const fromVersion = this.current.version;
    const candidate: KrishaIdentity = {
      ...this.current,
      ...patch,
      identityId: this.current.identityId,
      schemaVersion: this.current.schemaVersion,
      createdAt: this.current.createdAt,
      updatedAt: Date.now(),
      contentHash: '',
    };
    candidate.contentHash = identityContentHash(candidate);
    const check = validateIdentityRecord(candidate);
    if (!check.ok) {
      return { ok: false, issues: check.issues };
    }

    this.current = candidate;
    this.store.save(this.current);
    this.changeHistory.push({ at: this.current.updatedAt, note: String(note).slice(0, 200), fromVersion, toVersion: this.current.version });
    if (this.changeHistory.length > MAX_CHANGE_HISTORY) this.changeHistory.shift();
    return { ok: true, identity: this.current, issues };
  }

  /**
   * Restore-from-backup support: adopt a backup identity ONLY after full
   * validation. The local stable identityId wins when both exist and differ —
   * identity replacement from transport data is refused by design.
   */
  adoptFromBackup(identity: unknown): IdentityUpdateResult {
    const check = validateIdentityRecord(identity);
    if (!check.ok) return { ok: false, issues: check.issues };
    const candidate = identity as KrishaIdentity;
    if (candidate.identityId !== this.current.identityId) {
      return {
        ok: false,
        issues: ['backup identityId differs from the local stable identity — local identity preserved (replace refused)'],
      };
    }
    // Same identityId — this is a legitimate restore of the same Krix.
    const { contentHash: _omit, ...rest } = candidate;
    this.current = {
      ...(rest as Omit<KrishaIdentity, 'contentHash'>),
      schemaVersion: IDENTITY_SCHEMA_VERSION,
      updatedAt: Date.now(),
      contentHash: identityContentHash(rest as Omit<KrishaIdentity, 'contentHash'>),
    };
    this.store.save(this.current);
    return { ok: true, identity: this.current, issues: [] };
  }

  /** Bounded, human-readable change history (diagnostics). */
  getChangeHistory(): IdentityChangeRecord[] {
    return [...this.changeHistory];
  }

  /** Raw quarantined payload from the last recovery (inspection support). */
  getQuarantinedRaw(): string | null {
    return this.store.getQuarantined();
  }

  /** Diagnostic summary — no secrets exist in identity, still bounded. */
  diagnostics(): { identityId: string; name: string; version: number; schemaVersion: number; origin: string; lastLoadStatus: string } {
    return {
      identityId: this.current.identityId,
      name: this.current.name,
      version: this.current.version,
      schemaVersion: this.current.schemaVersion,
      origin: this.current.origin,
      lastLoadStatus: this.lastLoad.status,
    };
  }

  /** Verify the in-memory identity still matches its checksum (integrity check). */
  verifyIntegrity(): boolean {
    return validateIdentityRecord(this.current).ok;
  }
}

// ---------------------------------------------------------------- singleton

let singleton: IdentityService | null = null;
/** Initialization guard: concurrent first calls share one construction. */
let initPromise: Promise<IdentityService> | null = null;

/**
 * Browser singleton (lazy, localStorage-backed). Construction is synchronous
 * and idempotent; the init guard makes concurrent first calls (e.g. two
 * effects firing in the same tick) share exactly one initialization.
 * Tests construct their own instances with a injected StorageAdapter.
 */
export function getIdentityService(): IdentityService {
  if (singleton) return singleton;
  if (!initPromise) {
    initPromise = new Promise<IdentityService>((resolve) => {
      try {
        singleton = new IdentityService(localStorageAdapter);
      } catch {
        // Absolute last-resort: canonical identity, never null.
        singleton = new IdentityService(new MemoryStorage());
      }
      resolve(singleton);
    });
  }
  // Construction is synchronous inside the executor, so the singleton is
  // set by the time the promise resolves; return it directly.
  return singleton as IdentityService;
}

/** Test hook: reset the singleton (tests inject their own storage adapters). */
export function resetIdentityServiceForTests(): void {
  singleton = null;
  initPromise = null;
}
