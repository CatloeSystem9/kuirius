/**
 * Capability tools (Phase 20) — discovery/visibility over the capability
 * catalog. SAFE/FREE/LOCAL control-plane tools: they search metadata and
 * report stats; they execute NOTHING and grant NOTHING. Every actual action
 * still flows through the ToolRegistry + Phase 18 gate as before.
 */
import type { AgentTool } from '../types';
import type { CapabilityCatalog } from './capabilityCatalog';

export function createCapabilityTools(catalog: CapabilityCatalog): AgentTool[] {
  return [
    {
      name: 'capability.search',
      description: 'Search the capability catalog for capabilities matching a task or query (ranked, bounded). Returns advisory metadata — availability, preferred tools, model hints — never an executable. Executable tools live in the ToolRegistry and remain safety-gated.',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 0.99,
      capabilities: ['capability.search'],
      permissions: [],
      inputSchema: {
        required: ['query'],
        optional: ['maxResults', 'category'],
        types: { query: 'string', maxResults: 'number', category: 'string' },
      },
      verification: { strategy: 'self_reported', description: 'Deterministic metadata search over a lazily-loaded catalog index.' },
      timeoutMs: 5_000,
      async execute(input): Promise<any> {
        const results = await catalog.search(String(input.query ?? ''), {
          maxResults: input.maxResults ? Number(input.maxResults) : undefined,
          category: input.category ? String(input.category) : undefined,
        });
        return {
          success: true,
          output: {
            summary: `${results.length} matching capabilit(ies) for "${String(input.query).slice(0, 60)}"${results.length > 0 ? ` — top: ${results[0].record.name} (${results[0].record.availability})` : ''}.`,
            results: results.map((r) => ({
              id: r.record.id,
              name: r.record.name,
              source: r.record.sourceId,
              category: r.record.category,
              availability: r.record.availability,
              matchCount: r.matchCount,
              description: r.record.description,
              activationConditions: r.record.activationConditions,
              preferredTools: r.record.preferredTools,
              modelHint: r.record.modelHint,
              limitations: r.record.limitations,
            })),
          },
        };
      },
    },
    {
      name: 'capability.stats',
      description: 'Read capability-catalog statistics: sources, totals, availability breakdown (cataloged/discoverable/advisory/unavailable), category counts. Read-only.',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 0.99,
      capabilities: ['capability.stats'],
      permissions: [],
      inputSchema: {},
      verification: { strategy: 'self_reported', description: 'Direct read of catalog index statistics.' },
      timeoutMs: 5_000,
      async execute(): Promise<any> {
        const stats = await catalog.stats();
        return {
          success: true,
          output: {
            summary: `Catalog: ${stats.total} capabilit(ies) from ${stats.sources.length} source(s). Availability: ${Object.entries(stats.byAvailability).map(([k, v]) => `${k}=${v}`).join(', ')}.`,
            ...stats,
            lazyLoadCounts: catalog.lazyLoadCounts(),
          },
        };
      },
    },
    {
      name: 'capability.by_category',
      description: 'List catalog capabilities in one category (bounded). Read-only.',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 0.99,
      capabilities: ['capability.by_category'],
      permissions: [],
      inputSchema: { required: ['category'], optional: ['limit'], types: { category: 'string', limit: 'number' } },
      verification: { strategy: 'self_reported', description: 'Direct read of the catalog index.' },
      timeoutMs: 5_000,
      async execute(input): Promise<any> {
        const records = await catalog.byCategory(String(input.category ?? ''), input.limit ? Number(input.limit) : 25);
        return {
          success: true,
          output: {
            summary: `${records.length} capabilit(ies) in category "${String(input.category).slice(0, 40)}".`,
            records: records.map((r) => ({ id: r.id, name: r.name, availability: r.availability, description: r.description })),
          },
        };
      },
    },
  ];
}
