/**
 * specialistRegistry.ts
 *
 * A lightweight, in-memory registry over the static specialist definitions.
 * No database, no embeddings, no background processes — just structured
 * data plus indexing/lookup logic, built once at module load.
 */
import {
  type SpecialistDefinition,
  type Department,
  validateSpecialistDefinition,
  DEPARTMENTS,
} from "./specialistTypes";
import { ALL_SPECIALISTS } from "./specialistDefinitions";

export class SpecialistRegistryError extends Error {}

export class SpecialistRegistry {
  private readonly byId = new Map<string, SpecialistDefinition>();
  private readonly byDepartment = new Map<Department, SpecialistDefinition[]>();
  private readonly byTag = new Map<string, SpecialistDefinition[]>();

  constructor(definitions: SpecialistDefinition[] = ALL_SPECIALISTS) {
    this.load(definitions);
  }

  /**
   * Loads and validates a set of specialist definitions. Throws on any
   * malformed definition or duplicate ID — the registry never silently
   * accepts invalid data.
   */
  private load(definitions: SpecialistDefinition[]): void {
    for (const def of definitions) {
      const errors = validateSpecialistDefinition(def);
      if (errors.length > 0) {
        throw new SpecialistRegistryError(
          `Invalid specialist definition "${def.id ?? "<unknown>"}": ${errors.join("; ")}`
        );
      }

      if (this.byId.has(def.id)) {
        throw new SpecialistRegistryError(`Duplicate specialist ID: "${def.id}"`);
      }

      this.byId.set(def.id, def);

      const deptList = this.byDepartment.get(def.department) ?? [];
      deptList.push(def);
      this.byDepartment.set(def.department, deptList);

      for (const rawTag of def.routingTags) {
        const tag = rawTag.toLowerCase().trim();
        const tagList = this.byTag.get(tag) ?? [];
        tagList.push(def);
        this.byTag.set(tag, tagList);
      }
    }

    // Duplicate name check (names should also be unique, though not the
    // primary key).
    const seenNames = new Set<string>();
    for (const def of definitions) {
      if (seenNames.has(def.name)) {
        throw new SpecialistRegistryError(`Duplicate specialist name: "${def.name}"`);
      }
      seenNames.add(def.name);
    }
  }

  /** Total number of registered specialists. */
  get size(): number {
    return this.byId.size;
  }

  /** All specialists, in registration order. */
  getAll(): SpecialistDefinition[] {
    return Array.from(this.byId.values());
  }

  /** Retrieve a single specialist by its stable ID. Returns null if not found. */
  getById(id: string): SpecialistDefinition | null {
    return this.byId.get(id) ?? null;
  }

  /** Retrieve every specialist in a given department. */
  getByDepartment(department: Department): SpecialistDefinition[] {
    return this.byDepartment.get(department) ?? [];
  }

  /** Count of specialists per department, for every known department. */
  getDepartmentCounts(): Record<Department, number> {
    const counts = {} as Record<Department, number>;
    for (const dept of DEPARTMENTS) {
      counts[dept] = this.getByDepartment(dept).length;
    }
    return counts;
  }

  /**
   * Search specialists whose capabilities, description, or purpose contain
   * the given text (case-insensitive substring match). Lightweight —
   * no embeddings/vector search.
   */
  searchByCapability(query: string): SpecialistDefinition[] {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    return this.getAll().filter((def) => {
      const haystack = [
        def.description,
        def.purpose,
        ...def.capabilities,
        ...def.responsibilities,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }

  /** Retrieve specialists matching a single routing tag exactly. */
  getByTag(tag: string): SpecialistDefinition[] {
    return this.byTag.get(tag.toLowerCase().trim()) ?? [];
  }

  /**
   * Retrieve specialists matching ANY of the given tags, ranked by number
   * of matching tags (most relevant first). This is the core primitive
   * the router builds on.
   *
   * Matching is exact-tag first, with a lightweight stem-prefix fallback
   * (e.g. "crashing" ~ "crash", "debugging" ~ "debug") so simple
   * morphological variants of a keyword still find their specialist
   * without pulling in a full NLP stemming library.
   */
  matchByTags(tags: string[]): { specialist: SpecialistDefinition; matchCount: number }[] {
    const normalizedTags = tags.map((t) => t.toLowerCase().trim()).filter(Boolean);
    const scoreById = new Map<string, number>();
    const allTags = Array.from(this.byTag.keys());

    const MIN_STEM_LEN = 4;

    for (const tag of normalizedTags) {
      const exact = this.getByTag(tag);
      if (exact.length > 0) {
        for (const def of exact) {
          scoreById.set(def.id, (scoreById.get(def.id) ?? 0) + 1);
        }
        continue;
      }

      // Fallback: single-word tags only, and only when the shared prefix
      // is long enough to avoid spurious matches (e.g. "cat" ~ "category").
      if (tag.includes(" ") || tag.length < MIN_STEM_LEN) continue;

      for (const knownTag of allTags) {
        if (knownTag.includes(" ") || knownTag.length < MIN_STEM_LEN) continue;
        const shorter = tag.length < knownTag.length ? tag : knownTag;
        const longer = tag.length < knownTag.length ? knownTag : tag;
        if (shorter.length >= MIN_STEM_LEN && longer.startsWith(shorter)) {
          for (const def of this.getByTag(knownTag)) {
            scoreById.set(def.id, (scoreById.get(def.id) ?? 0) + 1);
          }
        }
      }
    }

    return Array.from(scoreById.entries())
      .map(([id, matchCount]) => ({ specialist: this.byId.get(id)!, matchCount }))
      .sort((a, b) => b.matchCount - a.matchCount);
  }
}

/** Default registry instance loaded from the full 100-specialist library. */
export const defaultRegistry = new SpecialistRegistry();
