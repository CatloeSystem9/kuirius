/**
 * Final capability layer (Phase 20) — types.
 *
 * Phase 20 INTEGRATES the existing systems; it does not replace them:
 *   - ToolRegistry remains the execution authority.
 *   - Phase 18 SafetyGate remains authoritative for every execution.
 *   - Phase 17 routing remains decision-only; capability records provide
 *     ADVISORY model hints only.
 *   - Phase 16 planning remains the planning authority; capability discovery
 *     is advisory context a planner MAY consult, never an execution path.
 *
 * The prepared capability source is the `krisha-specialists` library: 100
 * metadata-only specialist definitions (zero runtime dependencies, no
 * execution, no world access). They are cataloged + discoverable + advisory —
 * they are NOT executable APIs and never pretend to be. The catalog layer is
 * metadata-driven and source-agnostic: additional catalogs (e.g. a large
 * public-API catalog file, if provided) plug in through the same
 * CatalogSource interface and are lazily loaded on first search.
 */

/** Availability states (spec: cataloged ≠ discoverable ≠ executable). */
export type CapabilityAvailability =
  | 'cataloged' // present in a catalog's metadata
  | 'discoverable' // indexed and searchable
  | 'advisory' // reasoning/knowledge capability — advises, never executes
  | 'requires_credentials' // needs API key/OAuth/account — marked, never faked
  | 'requires_payment' // paid service — marked, never faked
  | 'unavailable'; // known to be non-functional right now

export interface CapabilityRecord {
  /** Stable kebab-case id (unique within its source). */
  id: string;
  /** Originating catalog source id. */
  sourceId: string;
  name: string;
  /** Capability family (e.g. 'specialist', 'public-api'). */
  family: string;
  /** Grouping category (e.g. specialist department). */
  category: string;
  description: string;
  /** When the agent should consider this capability. */
  activationConditions: string;
  /** Search/routing tags. */
  tags: string[];
  /** Tool families this capability would use IF executed (advisory only). */
  preferredTools: string[];
  /** Phase 17 advisory model hint. */
  modelHint?: 'lightweight' | 'standard' | 'advanced' | 'coding' | 'vision';
  /** Risk of acting on this capability's output (advisory metadata). */
  riskLevel: string;
  /** Explicit non-claims — what this capability must NOT be trusted to do. */
  limitations: string[];
  availability: CapabilityAvailability;
}

export interface CapabilitySearchResult {
  record: CapabilityRecord;
  /** Matched tag count (router-provided ranking signal). */
  matchCount: number;
  matchedTags: string[];
}

export interface CatalogStats {
  sources: { sourceId: string; family: string; count: number }[];
  total: number;
  byAvailability: Partial<Record<CapabilityAvailability, number>>;
  byCategory: { category: string; count: number }[];
}
