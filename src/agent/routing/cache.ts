/**
 * Bounded cache (Phase 17) â€” TTL + LRU + entry cap, with hit/miss/eviction
 * statistics. Used only for model-INDEPENDENT, deterministic computations
 * (classification keys, routing decisions) â€” never for side-effecting or
 * dynamic data, so stale results cannot leak into behavior (spec Â§11).
 */
export function hashKey(input: string): string {
  // FNV-1a (32-bit) â€” cheap, deterministic, collision-safe enough for
  // bounded local caches. NOT a security primitive.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  expired: number;
}

interface Entry<V> {
  value: V;
  storedAt: number;
  lastUsed: number;
}

export class BoundedCache<V> {
  private map = new Map<string, Entry<V>>();
  private _stats: CacheStats = { hits: 0, misses: 0, evictions: 0, size: 0, expired: 0 };

  constructor(
    private options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}
  ) {}

  private get maxEntries(): number {
    return Math.max(1, this.options.maxEntries ?? 64);
  }
  private get ttlMs(): number {
    return Math.max(0, this.options.ttlMs ?? 60_000);
  }
  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    const now = this.now();
    if (!entry) {
      this._stats.misses++;
      return undefined;
    }
    if (this.ttlMs > 0 && now - entry.storedAt > this.ttlMs) {
      // Stale-data protection: expired entries are removed, never served.
      this.map.delete(key);
      this._stats.expired++;
      this._stats.misses++;
      return undefined;
    }
    entry.lastUsed = now;
    // LRU touch: move to the end of insertion order.
    this.map.delete(key);
    this.map.set(key, entry);
    this._stats.hits++;
    return entry.value;
  }

  set(key: string, value: V): void {
    const now = this.now();
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, storedAt: now, lastUsed: now });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
      this._stats.evictions++;
    }
    this._stats.size = this.map.size;
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this._stats.size = 0;
  }

  get size(): number {
    return this.map.size;
  }

  stats(): CacheStats {
    return { ...this._stats, size: this.map.size };
  }
}
