/**
 * Capability catalog (Phase 20) — lazy, metadata-driven discovery over
 * pluggable catalog sources.
 *
 * Design rules (spec §4/§16/§23):
 *  - NOTHING is executed by the catalog. It is a metadata index + search.
 *  - Sources are LAZY: a source's loader runs once, on first use. Startup
 *    never loads a catalog (no 1,000s of tools at boot — ToolRegistry stays
 *    exactly as sized by the phases that own those tools).
 *  - Availability is explicit: advisory capabilities (specialists) are
 *    labeled advisory; APIs needing credentials/payment would be labeled
 *    requires_credentials/requires_payment — never faked as usable.
 *  - Bounded: search results are capped; the index is built once and cached.
 */
import type { CapabilityAvailability, CapabilityRecord, CapabilitySearchResult, CatalogStats } from './capabilityTypes';

/** A catalog source contributes CapabilityRecords lazily. */
export interface CatalogSource {
  sourceId: string;
  family: string;
  /** Human-readable note about what this source contains. */
  description: string;
  /** Loads the records (called once, lazily). Must be pure metadata loading. */
  load: () => CapabilityRecord[] | Promise<CapabilityRecord[]>;
}

/** Advisory mapping to the Phase 17 tier vocabulary (decision-only hints). */
export function modelHintToTier(hint: string | undefined): 'light' | 'balanced' | 'strong' | undefined {
  switch (hint) {
    case 'lightweight': return 'light';
    case 'standard': return 'balanced';
    case 'advanced': return 'strong';
    case 'coding': return 'strong';
    case 'vision': return 'balanced';
    default: return undefined;
  }
}

export class CapabilityCatalog {
  private records: CapabilityRecord[] | null = null;
  private loadCounts = new Map<string, number>();
  private searchCount = 0;

  constructor(private sources: CatalogSource[]) {}

  /**
   * Lazily load all source records. Each source loads at most once for the
   * lifetime of the catalog — repeated searches are pure index lookups.
   */
  async ensureLoaded(): Promise<CapabilityRecord[]> {
    if (this.records) return this.records;
    const all: CapabilityRecord[] = [];
    for (const source of this.sources) {
      this.loadCounts.set(source.sourceId, (this.loadCounts.get(source.sourceId) ?? 0) + 1);
      let loaded: CapabilityRecord[] = [];
      try {
        loaded = await source.load();
      } catch (err) {
        // A broken source degrades gracefully: it contributes nothing but
        // never prevents the catalog (or Krisha) from working.
        all.push({
          id: `${source.sourceId}.source-error`,
          sourceId: source.sourceId,
          name: `${source.sourceId} (source failed to load)`,
          family: source.family,
          category: 'system',
          description: `Catalog source failed to load: ${String((err as Error)?.message || err).slice(0, 120)}`,
          activationConditions: 'never',
          tags: [],
          preferredTools: [],
          riskLevel: 'LOW',
          limitations: ['This source is currently unavailable — honest degradation, not a fake capability.'],
          availability: 'unavailable',
        });
        continue;
      }
      for (const record of loaded) all.push(record);
    }
    // Dedupe by sourceId + id (a record id is unique within its source).
    const seen = new Set<string>();
    this.records = all.filter((r) => {
      const key = `${r.sourceId}::${r.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return this.records;
  }

  /**
   * Keyword search over tags/name/description — deterministic, bounded.
   * Mirrors the lightweight tag-matching philosophy of the existing router:
   * first-pass filtering only; the caller (planner/model) decides what to do.
   */
  async search(query: string, opts: { maxResults?: number; category?: string; availability?: CapabilityAvailability } = {}): Promise<CapabilitySearchResult[]> {
    const records = await this.ensureLoaded();
    this.searchCount++;
    const maxResults = Math.max(1, Math.min(opts.maxResults ?? 5, 25));
    const q = query.toLowerCase();
    const words = q.replace(/[^\w\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
    const bigrams: string[] = [];
    for (let i = 0; i < words.length - 1; i++) bigrams.push(`${words[i]} ${words[i + 1]}`);
    const keywords = [...words, ...bigrams];

    const scored: CapabilitySearchResult[] = [];
    for (const record of records) {
      if (opts.category && record.category !== opts.category) continue;
      if (opts.availability && record.availability !== opts.availability) continue;
      const haystack = `${record.name} ${record.tags.join(' ')} ${record.description}`.toLowerCase();
      const matchedTags: string[] = [];
      let matchCount = 0;
      for (const kw of keywords) {
        const tagHit = record.tags.some((t) => t.toLowerCase().includes(kw));
        const nameHit = record.name.toLowerCase().includes(kw);
        if (tagHit || nameHit) {
          matchCount++;
          matchedTags.push(kw);
        } else if (record.description.toLowerCase().includes(kw)) {
          matchCount += 0.25;
        }
      }
      if (matchCount > 0) scored.push({ record, matchCount: Math.round(matchCount * 100) / 100, matchedTags });
    }
    return scored
      .sort((a, b) => b.matchCount - a.matchCount || a.record.id.localeCompare(b.record.id))
      .slice(0, maxResults);
  }

  async byId(sourceId: string, id: string): Promise<CapabilityRecord | undefined> {
    return (await this.ensureLoaded()).find((r) => r.sourceId === sourceId && r.id === id);
  }

  async byCategory(category: string, limit = 25): Promise<CapabilityRecord[]> {
    return (await this.ensureLoaded()).filter((r) => r.category === category).slice(0, limit);
  }

  async stats(): Promise<CatalogStats> {
    const records = await this.ensureLoaded();
    const byAvailability: Partial<Record<CapabilityAvailability, number>> = {};
    const byCategory = new Map<string, number>();
    const sources = new Map<string, { sourceId: string; family: string; count: number }>();
    for (const r of records) {
      byAvailability[r.availability] = (byAvailability[r.availability] ?? 0) + 1;
      byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + 1);
      const s = sources.get(r.sourceId) ?? { sourceId: r.sourceId, family: r.family || 'unknown', count: 0 };
      s.count++;
      sources.set(r.sourceId, s);
    }
    return {
      sources: [...sources.values()],
      total: records.length,
      byAvailability,
      byCategory: [...byCategory.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    };
  }

  /** Observability: how many times each lazy source loaded (must stay 1). */
  lazyLoadCounts(): Record<string, number> {
    return Object.fromEntries(this.loadCounts);
  }

  searchVolume(): number {
    return this.searchCount;
  }
}
