/**
 * Final Agent Integration (Phase 20) — public surface.
 *
 * Integrates the existing systems into one coherent agent architecture
 * WITHOUT replacing any of them: the ToolRegistry stays the execution
 * authority, Phase 18 the safety authority, Phase 16 planning, Phase 17
 * routing, Phase 11 recovery, Phase 19 long-run sessions. The capability
 * layer adds lazy, metadata-driven DISCOVERY over prepared catalogs
 * (starting with the 100-specialist krisha-specialists library) — advisory
 * only, never an execution path, never a bypass.
 */
export * from './capabilityTypes';
export { CapabilityCatalog, modelHintToTier } from './capabilityCatalog';
export type { CatalogSource } from './capabilityCatalog';
export { SpecialistCatalogSource, SPECIALIST_SOURCE_ID, SPECIALIST_FAMILY } from './specialistSource';
export { createCapabilityTools } from './capabilityTools';
