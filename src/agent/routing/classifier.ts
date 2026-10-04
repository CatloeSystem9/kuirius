/**
 * Cached classifier (Phase 17) — memoizes the deterministic complexity
 * classifier behind a bounded TTL/LRU cache. The classifier is pure, so
 * caching is always safe (same text → same tier); repeated identical
 * messages (voice retries, re-sends) skip the regex passes entirely.
 */
import type { Classification } from './complexity';
import { classificationKey, classifyTask } from './complexity';
import { BoundedCache } from './cache';
import type { PerformanceTelemetry } from './telemetry';

export interface CachedClassifierOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
  telemetry?: PerformanceTelemetry;
}

export class CachedClassifier {
  private cache: BoundedCache<Classification>;

  constructor(private options: CachedClassifierOptions = {}) {
    this.cache = new BoundedCache<Classification>({
      maxEntries: options.maxEntries ?? 128,
      ttlMs: options.ttlMs ?? 60_000,
      now: options.now ?? Date.now,
    });
  }

  /** Text-only classification (the common case). Cached; contextChars = 0. */
  classify(text: string): Classification {
    const key = classificationKey(text);
    const cached = this.cache.get(key);
    if (cached) {
      this.options.telemetry?.recordCacheHit(key);
      return cached;
    }
    this.options.telemetry?.recordCacheMiss(key);
    const result = classifyTask({ text });
    this.cache.set(key, result);
    return result;
  }

  invalidate(): void {
    this.cache.clear();
  }

  stats() {
    return this.cache.stats();
  }
}
