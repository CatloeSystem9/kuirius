/**
 * Memory Store (Phase 2) — versioned, corruption-tolerant persistence.
 *
 * Owns the structured `krisha_agent_memory_v2` key and keeps a write-through
 * mirror of valid memories into the legacy `krisha_memories_v1` string[] key so
 * every pre-existing reader keeps working unchanged.
 */
import type { MemoryRecord, MemoryStoreSchema } from './memoryTypes';
import {
  MEMORY_SCHEMA_VERSION,
  MEMORY_STORAGE_KEY,
  LEGACY_MEMORY_KEY,
  MAX_MEMORY_RECORDS,
} from './memoryTypes';
import type { StorageAdapter } from '../taskState';
import { MemoryStorage } from '../taskState';

export { MemoryStorage };
export type { StorageAdapter };

const SEED_MEMORIES = [
  'Loves quiet, peaceful late-night conversations with Krisha',
  'Prefers a minimal, clutter-free environment',
  'Appreciates honest, warm banter and genuine emotional presence',
];

function isValidRecord(entry: unknown): entry is MemoryRecord {
  if (!entry || typeof entry !== 'object') return false;
  const r = entry as Partial<MemoryRecord>;
  return (
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    typeof r.content === 'string' &&
    r.content.trim().length > 0 &&
    typeof r.category === 'string' &&
    typeof r.createdAt === 'number' &&
    typeof r.updatedAt === 'number' &&
    typeof r.importance === 'number' &&
    typeof r.confidence === 'number' &&
    typeof r.source === 'string' &&
    typeof r.valid === 'boolean' &&
    typeof r.usageCount === 'number'
  );
}

/** Repair lightly-damaged records (clamped numbers, missing optional fields). */
function repairRecord(entry: Partial<MemoryRecord>): MemoryRecord | null {
  if (!entry || typeof entry.content !== 'string' || !entry.content.trim()) return null;
  const now = Date.now();
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : 'mem_' + now + '_' + Math.random().toString(36).slice(2, 8),
    category: (entry.category as MemoryRecord['category']) ?? 'long_term',
    content: entry.content.trim(),
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : now,
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : now,
    importance: clamp01(entry.importance ?? 0.5),
    confidence: clamp01(entry.confidence ?? 0.5),
    source: (entry.source as MemoryRecord['source']) ?? 'legacy_migrated',
    tags: Array.isArray(entry.tags) ? entry.tags.filter((t) => typeof t === 'string') : undefined,
    usageCount: typeof entry.usageCount === 'number' ? entry.usageCount : 0,
    lastUsedAt: typeof entry.lastUsedAt === 'number' ? entry.lastUsedAt : undefined,
    valid: typeof entry.valid === 'boolean' ? entry.valid : true,
    supersededBy: typeof entry.supersededBy === 'string' ? entry.supersededBy : undefined,
    metadata: entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : undefined,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function seedRecords(now: number): MemoryRecord[] {
  return SEED_MEMORIES.map((content) => ({
    id: 'mem_seed_' + Math.random().toString(36).slice(2, 8),
    category: 'preference' as const,
    content,
    createdAt: now,
    updatedAt: now,
    importance: 0.7,
    confidence: 0.75,
    source: 'system_seed' as const,
    usageCount: 0,
    valid: true,
  }));
}

/** Convert a v1 flat string[] into v2 records. */
function migrateLegacyStrings(strings: unknown, now: number): MemoryRecord[] {
  if (!Array.isArray(strings)) return [];
  return strings
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 1)
    .map((content) => ({
      id: 'mem_mig_' + Math.random().toString(36).slice(2, 8),
      category: 'long_term' as const,
      content: content.trim(),
      createdAt: now,
      updatedAt: now,
      importance: 0.6,
      confidence: 0.7,
      source: 'legacy_migrated' as const,
      usageCount: 0,
      valid: true,
    }));
}

export class MemoryStore {
  private storage: StorageAdapter;
  records: MemoryRecord[] = [];

  constructor(storage: StorageAdapter = new MemoryStorage()) {
    this.storage = storage;
    this.load();
  }

  /** Load with validation, migration, and corruption recovery. Never throws. */
  load(): void {
    const now = Date.now();
    let loaded: MemoryRecord[] = [];
    let sawCorruptV2 = false;

    const raw = this.storage.getItem(MEMORY_STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<MemoryStoreSchema> | MemoryRecord[] | null;
        if (Array.isArray(parsed)) {
          // Unexpected bare array — treat as records, best effort.
          loaded = parsed.map((r) => repairRecord(r as Partial<MemoryRecord>)).filter((r): r is MemoryRecord => !!r);
          sawCorruptV2 = true;
        } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.records)) {
          if ((parsed.schemaVersion as number) <= MEMORY_SCHEMA_VERSION) {
            loaded = parsed.records
              .map((r) => (isValidRecord(r) ? r : repairRecord(r)))
              .filter((r): r is MemoryRecord => !!r);
          } else {
            // Future schema — do not destroy it, but start clean for this app version.
            sawCorruptV2 = true;
          }
        } else {
          sawCorruptV2 = true;
        }
      } catch {
        sawCorruptV2 = true;
      }
    }

    if (loaded.length === 0) {
      const legacyRaw = this.storage.getItem(LEGACY_MEMORY_KEY);
      if (legacyRaw) {
        try {
          const legacy = JSON.parse(legacyRaw);
          if (Array.isArray(legacy) && legacy.length > 0) {
            loaded = migrateLegacyStrings(legacy, now);
          }
        } catch {
          // corrupted legacy data — fall through to seed
        }
      }
    }

    if (loaded.length === 0 && !sawCorruptV2 && !this.storage.getItem(LEGACY_MEMORY_KEY)) {
      loaded = seedRecords(now);
    }

    // De-duplicate ids defensively (duplicate writes must not create ghosts).
    const seen = new Set<string>();
    this.records = loaded.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });

    this.persist();
  }

  persist(): void {
    // Enforce the cap: invalid + short_term + oldest records go first.
    if (this.records.length > MAX_MEMORY_RECORDS) {
      const rank = (r: MemoryRecord): number => {
        let score = 0;
        if (!r.valid) score -= 100;
        if (r.category === 'short_term') score -= 50;
        score += r.importance;
        score -= (Date.now() - r.updatedAt) / (1000 * 60 * 60 * 24 * 365); // gentle recency bias
        return score;
      };
      this.records = [...this.records].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_MEMORY_RECORDS);
    }

    try {
      const envelope: MemoryStoreSchema = { schemaVersion: MEMORY_SCHEMA_VERSION, records: this.records };
      this.storage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      // storage failure — keep the in-memory list authoritative
    }

    // Write-through mirror for legacy readers (v1 string[] UI view).
    try {
      this.storage.setItem(LEGACY_MEMORY_KEY, JSON.stringify(this.displayStrings()));
    } catch {
      // ignore
    }
  }

  /** Strings in the order the existing Memory UI displays them. */
  displayStrings(): string[] {
    return this.records
      .filter((r) => r.valid)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 200)
      .map((r) => r.content);
  }

  clear(): void {
    this.records = [];
    this.storage.removeItem(MEMORY_STORAGE_KEY);
    this.storage.removeItem(LEGACY_MEMORY_KEY);
  }

  resetToSeed(): MemoryRecord[] {
    this.clear();
    this.records = seedRecords(Date.now());
    this.persist();
    return this.records;
  }
}
