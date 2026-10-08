/**
 * Two-type cache system (Context Engine v1, spec §9/§10):
 *
 *  A. PersistentCache — survives restarts via the existing StorageAdapter
 *     convention (localStorage in the browser, a JSON file on the server).
 *     TTL/expiration, stale detection with bounded overstay, entry + total
 *     size caps, dedup by deterministic key, invalidation, corruption-safe
 *     load, lazy sweeping (no timers, no background processes).
 *
 *  B. SessionCache — plain bounded in-memory map. Lives only for the current
 *     execution/session; a restart (new process/page load) constructs a new
 *     empty one. Never written to storage.
 *
 * Cache keys are deterministic (FNV-1a via the existing routing hashKey) and
 * lookups resolve session → persistent (cache-first, network-last is enforced
 * by callers, not here).
 */
import type { CacheEntry, CacheGetResult, CacheStats, ContextCacheLimits } from './contextTypes';
import { CONTEXT_CACHE_SCHEMA_VERSION, CONTEXT_CACHE_STORAGE_KEY, DEFAULT_CACHE_LIMITS } from './contextTypes';
import { hashKey } from '../routing/cache';

/** Deterministic, namespaced cache key. */
export function cacheKey(source: string, identifier: string): string {
  return `${source}:${hashKey(identifier.trim().toLowerCase())}`;
}

// ---------------------------------------------------------------------------
// Session cache — temporary, cleared on restart, never persisted.
// ---------------------------------------------------------------------------
export class SessionCache {
  private map = new Map<string, CacheEntry>();
  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;
  private readonly limits: ContextCacheLimits;
  private readonly now: () => number;

  constructor(limits: Partial<ContextCacheLimits> = {}, now: () => number = Date.now) {
    this.limits = { ...DEFAULT_CACHE_LIMITS, ...limits };
    this.now = now;
  }

  set(key: string, value: unknown, opts: { ttlMs?: number; source?: string; tags?: string[] } = {}): CacheEntry {
    const now = this.now();
    const serialized = safeSize(value);
    const entry: CacheEntry = {
      key,
      value,
      createdAt: this.map.get(key)?.createdAt ?? now,
      updatedAt: now,
      expiresAt: now + (opts.ttlMs ?? this.limits.sessionTtlMs),
      source: opts.source ?? 'session',
      sizeChars: serialized,
      hits: this.map.get(key)?.hits ?? 0,
      tags: opts.tags,
    };
    // Dedup by key: overwrite in place (map.delete + set keeps LRU order).
    this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.limits.sessionMaxEntries) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
      this._evictions++;
    }
    return entry;
  }

  get(key: string): CacheGetResult {
    const entry = this.map.get(key);
    const now = this.now();
    if (!entry) {
      this._misses++;
      return { hit: false };
    }
    if (entry.expiresAt > 0 && now > entry.expiresAt) {
      this.map.delete(key);
      this._misses++;
      return { hit: false };
    }
    entry.hits++;
    entry.updatedAt = now;
    return { hit: true, value: entry.value, entry };
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  stats(): CacheStats['session'] {
    return { size: this.map.size, hits: this._hits, misses: this._misses, evictions: this._evictions };
  }
}

// ---------------------------------------------------------------------------
// Persistent cache — survives restarts, corruption-tolerant, size-bounded.
// ---------------------------------------------------------------------------
interface PersistentSchema {
  schemaVersion: number;
  entries: CacheEntry[];
}

export class PersistentCache {
  private entries = new Map<string, CacheEntry>();
  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;
  private _expired = 0;
  private loaded = false;
  private readonly limits: ContextCacheLimits;
  private readonly now: () => number;
  private readonly storage?: import('../taskState').StorageAdapter;

  constructor(
    storage?: import('../taskState').StorageAdapter,
    limits: Partial<ContextCacheLimits> = {},
    now: () => number = Date.now
  ) {
    this.storage = storage;
    this.limits = { ...DEFAULT_CACHE_LIMITS, ...limits };
    this.now = now;
  }

  /** Load once with validation + corruption recovery. Never throws. */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(CONTEXT_CACHE_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PersistentSchema | null;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return; // corrupt → clean start
      if ((parsed.schemaVersion ?? 0) > CONTEXT_CACHE_SCHEMA_VERSION) return; // future schema → clean start
      const now = this.now();
      for (const e of parsed.entries) {
        if (!e || typeof e.key !== 'string' || typeof e.updatedAt !== 'number') continue;
        // Load live entries; drop anything hard-expired beyond the stale overstay.
        const hardExpiry = e.expiresAt + (e.expiresAt - e.updatedAt) * this.limits.staleOverstayFactor;
        if (e.expiresAt > 0 && now > hardExpiry) {
          this._expired++;
          continue;
        }
        this.entries.set(e.key, e);
      }
    } catch {
      // corrupted storage — start clean; the in-memory cache remains authoritative
      this.entries.clear();
    }
  }

  private persist(): void {
    if (!this.storage) return;
    this.sweepExpired();
    this.enforceLimits();
    try {
      const schema: PersistentSchema = { schemaVersion: CONTEXT_CACHE_SCHEMA_VERSION, entries: [...this.entries.values()] };
      this.storage.setItem(CONTEXT_CACHE_STORAGE_KEY, JSON.stringify(schema));
    } catch {
      // storage failure — in-memory state remains authoritative
    }
  }

  /** Drop expired entries (bounded pass; called on mutation, not on a timer). */
  private sweepExpired(): void {
    const now = this.now();
    for (const [key, e] of this.entries) {
      const hardExpiry = e.expiresAt + (e.expiresAt - e.updatedAt) * this.limits.staleOverstayFactor;
      if (e.expiresAt > 0 && now > hardExpiry) {
        this.entries.delete(key);
        this._expired++;
      }
    }
  }

  /** Enforce entry-count and total-size caps: expired → oldest-lowest-value first. */
  private enforceLimits(): void {
    let totalChars = 0;
    for (const e of this.entries.values()) totalChars += e.sizeChars;
    const evictOne = (): void => {
      let oldestKey: string | undefined;
      let oldestScore = Infinity;
      for (const [key, e] of this.entries) {
        const score = e.hits * 1000 - (this.now() - e.updatedAt) / 60_000;
        if (score < oldestScore) {
          oldestScore = score;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.entries.delete(oldestKey);
        this._evictions++;
      }
    };
    while (this.entries.size > this.limits.persistentMaxEntries) evictOne();
    while (totalChars > this.limits.persistentMaxTotalChars && this.entries.size > 0) {
      const victim = this.entries.values().next().value as CacheEntry | undefined;
      if (!victim) break;
      totalChars -= victim.sizeChars;
      this.entries.delete(victim.key);
      this._evictions++;
    }
  }

  set(key: string, value: unknown, opts: { ttlMs?: number; source?: string; tags?: string[] } = {}): CacheEntry {
    this.ensureLoaded();
    const now = this.now();
    const ttl = opts.ttlMs ?? this.limits.persistentDefaultTtlMs;
    const sizeChars = safeSize(value);
    // Dedup by deterministic key: same logical information updates in place.
    const entry: CacheEntry = {
      key,
      value,
      createdAt: this.entries.get(key)?.createdAt ?? now,
      updatedAt: now,
      expiresAt: ttl > 0 ? now + ttl : 0,
      source: opts.source ?? 'persistent',
      sizeChars,
      hits: this.entries.get(key)?.hits ?? 0,
      tags: opts.tags,
    };
    this.entries.set(key, entry);
    this.persist();
    return entry;
  }

  /**
   * Cache-first lookup with honest staleness. With `allowStale` (only when the
   * analyzer marked the request stale-tolerant) an expired entry inside the
   * overstay window is served with `stale: true`; beyond that it is a miss.
   */
  get(key: string, opts: { allowStale?: boolean } = {}): CacheGetResult {
    this.ensureLoaded();
    const entry = this.entries.get(key);
    const now = this.now();
    if (!entry) {
      this._misses++;
      return { hit: false };
    }
    if (entry.expiresAt > 0 && now > entry.expiresAt) {
      if (!opts.allowStale) {
        this._misses++;
        return { hit: false };
      }
      const overstayMs = (entry.expiresAt - entry.updatedAt) * this.limits.staleOverstayFactor;
      if (now > entry.expiresAt + overstayMs) {
        this.entries.delete(key);
        this._expired++;
        this._misses++;
        return { hit: false };
      }
      entry.hits++;
      return { hit: true, value: entry.value, entry, stale: true };
    }
    entry.hits++;
    return { hit: true, value: entry.value, entry };
  }

  /** Invalidate one key or every key with a prefix (source-level invalidation). */
  invalidate(keyOrPrefix: string): number {
    this.ensureLoaded();
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (key === keyOrPrefix || key.startsWith(keyOrPrefix)) {
        this.entries.delete(key);
        removed++;
      }
    }
    if (removed > 0) this.persist();
    return removed;
  }

  /** Find entries whose cached content mentions any of the given keywords. */
  findByKeywords(keywords: string[], limit = 4): Array<{ entry: CacheEntry; stale: boolean }> {
    this.ensureLoaded();
    const now = this.now();
    const out: Array<{ entry: CacheEntry; stale: boolean }> = [];
    if (keywords.length === 0) return out;
    for (const entry of this.entries.values()) {
      if (entry.expiresAt > 0 && now > entry.expiresAt + (entry.expiresAt - entry.updatedAt) * this.limits.staleOverstayFactor) continue;
      const text = JSON.stringify(entry.value ?? '').toLowerCase();
      if (keywords.some((k) => text.includes(k))) {
        out.push({ entry, stale: entry.expiresAt > 0 && now > entry.expiresAt });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  stats(): CacheStats['persistent'] {
    this.ensureLoaded();
    let chars = 0;
    for (const e of this.entries.values()) chars += e.sizeChars;
    return { size: this.entries.size, chars, hits: this._hits, misses: this._misses, evictions: this._evictions, expired: this._expired };
  }

  clear(): void {
    this.entries.clear();
    if (this.storage) {
      try {
        this.storage.removeItem(CONTEXT_CACHE_STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }
}

function safeSize(value: unknown): number {
  try {
    return JSON.stringify(value ?? null)?.length ?? 0;
  } catch {
    return 0;
  }
}
