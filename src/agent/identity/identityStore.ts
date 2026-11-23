/**
 * Persistent Identity Foundation (Step 1) — store.
 *
 * Versioned, corruption-tolerant persistence for the identity envelope,
 * following the exact store conventions of memoryStore/goalStore:
 * validate → repair → migrate → quarantine-on-failure, never throw.
 * Identity data is agent-layer state (who Krisha is) — it shares the
 * StorageAdapter infrastructure but is NOT part of any memory system.
 */
import type { StorageAdapter } from '../taskState';
import { MemoryStorage } from '../taskState';
import {
  IDENTITY_QUARANTINE_KEY,
  IDENTITY_SCHEMA_VERSION,
  IDENTITY_STORAGE_KEY,
  type IdentityStoreSchema,
  type KrishaIdentity,
} from './identityTypes';
import {
  CANONICAL_IDENTITY,
  identityContentHash,
  migrateIdentityEnvelope,
  normalizeIdentity,
  validateIdentityRecord,
} from './identityDefinition';

export interface IdentityLoadResult {
  identity: KrishaIdentity;
  /** 'stored' — valid envelope loaded; 'migrated' — legacy shape upgraded;
   *  'recovered' — corrupted/future schema repaired (raw quarantined);
   *  'created' — nothing persisted yet. */
  status: 'stored' | 'migrated' | 'recovered' | 'created';
  issues: string[];
}

export class IdentityStore {
  private storage: StorageAdapter;

  constructor(storage: StorageAdapter = new MemoryStorage()) {
    this.storage = storage;
  }

  /**
   * Load with validation, migration and corruption recovery. Never throws.
   * The stable identityId is preserved across every recovery path.
   */
  load(): IdentityLoadResult {
    const now = Date.now();
    const raw = this.readRaw(IDENTITY_STORAGE_KEY);

    if (raw) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // fall through to recovery with the raw string preserved
      }

      if (parsed !== null) {
        const asEnvelope = parsed as Partial<IdentityStoreSchema> | null;
        const futureSchema =
          !!asEnvelope &&
          typeof asEnvelope === 'object' &&
          typeof asEnvelope.schemaVersion === 'number' &&
          asEnvelope.schemaVersion > IDENTITY_SCHEMA_VERSION;

        if (futureSchema) {
          // Future schema: never destroy the data — quarantine it and serve a
          // recovered canonical identity that KEEPS the stable identityId.
          this.quarantine(raw);
          return this.create(now, [
            `future schema version ${(asEnvelope as { schemaVersion: number }).schemaVersion} — quarantined for forward compatibility`,
          ], 'recovered');
        }

        const migrated = migrateIdentityEnvelope(parsed, now);
        if (migrated) {
          // Validate the RAW record first: corruption must be honestly
          // reported (recovered + quarantined), never silently repaired.
          const rawIdentity = (parsed as Record<string, unknown>).identity;
          const innerRaw = migrated.wasLegacyShape ? parsed : rawIdentity;
          const rawCheck = validateIdentityRecord(innerRaw);
          if (!rawCheck.ok) {
            this.quarantine(raw);
            return this.create(now, rawCheck.issues, 'recovered');
          }
          const result: IdentityLoadResult = {
            identity: migrated.envelope.identity,
            status: migrated.wasLegacyShape || migrated.versionUplift || migrated.issues.length > 0 ? 'migrated' : 'stored',
            issues: migrated.issues,
          };
          // Persist the upgraded envelope once so future boots skip migration.
          if (result.status === 'migrated') {
            this.save(result.identity);
          }
          return result;
        }
        this.quarantine(raw);
        return this.create(now, ['unrecognized identity envelope structure'], 'recovered');
      }

      this.quarantine(raw);
      return this.create(now, ['identity envelope is not valid JSON'], 'recovered');
    }

    return this.create(now, [], 'created');
  }

  /** Persist the identity envelope atomically (single key write). */
  save(identity: KrishaIdentity): void {
    const envelope: IdentityStoreSchema = {
      schemaVersion: IDENTITY_SCHEMA_VERSION,
      identity,
      savedAt: Date.now(),
    };
    try {
      this.storage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      // persistence failure is non-fatal — the in-memory identity stays authoritative
    }
  }

  /** Quarantine an unreadable payload (bounded) for forward compatibility. */
  quarantine(raw: string): void {
    try {
      this.storage.setItem(IDENTITY_QUARANTINE_KEY, raw.slice(0, 16_000));
    } catch {
      // best-effort only
    }
  }

  /** Read the quarantined raw payload, if any (recovery/inspection support). */
  getQuarantined(): string | null {
    return this.readRaw(IDENTITY_QUARANTINE_KEY);
  }

  /**
   * Create the canonical identity. Read-before-write: if a valid identity
   * already exists in storage, its stable identityId is adopted (protects
   * against duplicate initialization across concurrent first-runs).
   */
  create(now: number, issues: string[], status: IdentityLoadResult['status']): IdentityLoadResult {
    const existingId = this.readStoredIdentityId();
    const normalized = normalizeIdentity(
      {
        ...CANONICAL_IDENTITY,
        identityId: existingId ?? undefined,
        createdAt: now,
        updatedAt: now,
        origin: status === 'created' ? 'canonical' : 'recovered',
      },
      { now, origin: status === 'created' ? 'canonical' : 'recovered' }
    );
    this.save(normalized.identity);
    return { identity: normalized.identity, status, issues };
  }

  private readRaw(key: string): string | null {
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }

  /** Extract a plausible stable identityId from any parsed shape (recovery path). */
  private readStoredIdentityId(): string | null {
    const raw = this.readRaw(IDENTITY_STORAGE_KEY);
    if (!raw) return null;
    try {
      return extractIdentityId(JSON.parse(raw));
    } catch {
      return null;
    }
  }
}

function extractIdentityId(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const direct = obj.identityId;
  if (typeof direct === 'string' && direct.trim()) return direct.trim().slice(0, 100);
  const inner = obj.identity;
  if (inner && typeof inner === 'object') {
    const id = (inner as Record<string, unknown>).identityId;
    if (typeof id === 'string' && id.trim()) return id.trim().slice(0, 100);
  }
  return null;
}

/**
 * Recompute and attach a fresh checksum (used after deliberate, validated
 * updates — mutation paths only; the store never writes unhashed records).
 */
export function rehashIdentity(identity: KrishaIdentity): KrishaIdentity {
  const { contentHash: _omit, ...rest } = identity;
  return { ...rest, contentHash: identityContentHash(rest) };
}
