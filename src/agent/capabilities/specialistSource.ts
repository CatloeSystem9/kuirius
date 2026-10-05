/**
 * Specialist catalog source (Phase 20) — adapts the PREPARED
 * `krisha-specialists` library (100 metadata-only definitions across 10
 * departments, zero runtime dependencies) into the capability catalog.
 *
 * Integration honesty (spec §23/§24): specialists are ADVISORY reasoning
 * capabilities. They never execute, never touch the world, and never bypass
 * planning/safety — the record states exactly that. The lazy loader wraps
 * the package's own SpecialistRegistry (reused, not rebuilt) via async
 * dynamic import so startup never touches the catalog until first use.
 */
import type { CatalogSource } from './capabilityCatalog';
import type { CapabilityRecord } from './capabilityTypes';

export const SPECIALIST_SOURCE_ID = 'krisha-specialists';
export const SPECIALIST_FAMILY = 'specialist';

interface SpecialistDefinitionLike {
  id: string;
  name: string;
  department: string;
  description: string;
  activationConditions: string;
  routingTags: string[];
  preferredTools: string[];
  modelHint?: string;
  riskLevel: string;
  limitations: string[];
}

interface SpecialistRegistryLike {
  getAll(): SpecialistDefinitionLike[];
  getByDepartment(department: string): SpecialistDefinitionLike[];
}

export class SpecialistCatalogSource implements CatalogSource {
  readonly sourceId = SPECIALIST_SOURCE_ID;
  readonly family = SPECIALIST_FAMILY;
  readonly description = '100 prepared specialist reasoning definitions (krisha-specialists library) — advisory only, zero runtime dependencies';

  private registry: SpecialistRegistryLike | null = null;

  /** Lazy: the specialists package loads once, on first catalog use. */
  async load(): Promise<CapabilityRecord[]> {
    if (!this.registry) {
      const mod = (await import('../../../krisha-specialists/specialistRegistry')) as {
        defaultRegistry: SpecialistRegistryLike;
      };
      this.registry = mod.defaultRegistry;
    }
    return this.registry.getAll().map((def) => this.toRecord(def));
  }

  byDepartmentFromRegistry(department: string, limit = 25): CapabilityRecord[] {
    if (!this.registry) return [];
    return this.registry.getByDepartment(department as never).slice(0, limit).map((def) => this.toRecord(def));
  }

  private toRecord(def: SpecialistDefinitionLike): CapabilityRecord {
    return {
      id: def.id,
      sourceId: SPECIALIST_SOURCE_ID,
      name: def.name,
      family: SPECIALIST_FAMILY,
      category: def.department,
      description: def.description,
      activationConditions: def.activationConditions,
      tags: def.routingTags,
      preferredTools: def.preferredTools,
      modelHint: def.modelHint as CapabilityRecord['modelHint'],
      riskLevel: def.riskLevel,
      limitations: def.limitations,
      // Specialists are reasoning/advisory capabilities by design — they
      // advise the planner and inform model routing; they never execute.
      availability: 'advisory',
    };
  }
}
