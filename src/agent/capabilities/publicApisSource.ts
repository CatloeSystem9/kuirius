/**
 * Public-APIs catalog source (Phase 20 integration) — adapts the SUPPLIED
 * public-apis catalog (generated from the public-apis/public-apis README:
 * 52 categories, 1,841 entries, metadata only) into the capability catalog.
 *
 * Integration honesty (spec §23/§24):
 *  - The supplied files contain CATALOG METADATA ONLY (name, description,
 *    auth, HTTPS, CORS, doc link, category). They document no endpoints,
 *    request/response formats, or rate limits — so NOTHING here is
 *    executable. No record ever pretends to be a working integration.
 *  - Availability is honest: entries whose auth model requires a key/token
 *    are `requires_credentials`; entries usable without a secret are
 *    `discoverable` (indexed + searchable metadata). None are executable.
 *  - Credentials are NEVER invented, stored, or prompted for. If the user
 *    later wires a specific API up, that happens through the existing
 *    ToolRegistry + Phase 18 SafetyGate — not through this catalog.
 *  - LAZY: the 460KB generated data module is dynamically imported on first
 *    catalog use — startup never loads it (mirrors SpecialistCatalogSource).
 */
import type { CatalogSource } from './capabilityCatalog';
import type { CapabilityRecord } from './capabilityTypes';

export const PUBLIC_APIS_SOURCE_ID = 'public-apis';
export const PUBLIC_APIS_FAMILY = 'public-api';

/** Auth models that require a real credential (key/token/account). */
const CREDENTIAL_AUTH = new Set(['apiKey', 'OAuth', 'X-Mashape-Key']);

interface PublicApiEntryLike {
  name: string;
  description: string;
  auth: string;
  https: boolean;
  cors: string;
  link: string;
  krixCapabilityHint?: string;
}

interface PublicApiCategoryLike {
  category: string;
  entries: PublicApiEntryLike[];
}

interface PublicApisCatalogModule {
  PUBLIC_APIS_CATALOG: PublicApiCategoryLike[];
  CATEGORY_COUNT: number;
  TOTAL_ENTRY_COUNT: number;
}

/** Deterministic kebab-case slug for ids/tags. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'api';
}

/** Advisory mapping to tool families that ACTUALLY exist in the ToolRegistry. */
function preferredToolsForHint(hint: string | undefined): string[] {
  switch (hint) {
    case 'browser':
      return ['web.open_website'];
    case 'web-search':
      return ['web.search_website'];
    case 'document-reader':
      return ['filesystem.read', 'filesystem.open_file'];
    default:
      return [];
  }
}

export class PublicApisCatalogSource implements CatalogSource {
  readonly sourceId = PUBLIC_APIS_SOURCE_ID;
  readonly family = PUBLIC_APIS_FAMILY;
  readonly description =
    'Supplied public-apis catalog (public-apis/public-apis README snapshot): 52 categories, 1,841 entries of METADATA ONLY (auth/HTTPS/CORS/docs link). Nothing is executable; credential-required APIs are labeled requires_credentials — never faked.';

  private module: PublicApisCatalogModule | null = null;

  /** Lazy: the generated data module loads once, on first catalog use. */
  async load(): Promise<CapabilityRecord[]> {
    if (!this.module) {
      this.module = (await import('./publicapis/publicApisCatalog')) as PublicApisCatalogModule;
    }
    const records: CapabilityRecord[] = [];
    const idCounts = new Map<string, number>();
    for (const category of this.module.PUBLIC_APIS_CATALOG) {
      const categorySlug = slugify(category.category);
      for (const entry of category.entries) {
        // Deterministic unique id: first occurrence keeps the plain slug;
        // same-name entries (kept in the catalog when URLs differ) get -2, -3…
        const base = slugify(entry.name);
        const n = (idCounts.get(base) ?? 0) + 1;
        idCounts.set(base, n);
        const id = n === 1 ? base : `${base}-${n}`;
        records.push(this.toRecord(entry, category.category, categorySlug, id));
      }
    }
    return records;
  }

  private toRecord(entry: PublicApiEntryLike, category: string, categorySlug: string, id: string): CapabilityRecord {
    const requiresCredentials = CREDENTIAL_AUTH.has(entry.auth);
    const tags = [categorySlug, `auth:${slugify(entry.auth)}`, entry.https ? 'https' : 'no-https', `cors:${entry.cors.toLowerCase()}`];
    if (entry.krixCapabilityHint && entry.krixCapabilityHint !== 'none') tags.push(`hint:${entry.krixCapabilityHint}`);

    const limitations = [
      'Catalog metadata only — Krisha has no adapter for this API and the catalog cannot execute it.',
    ];
    if (requiresCredentials) {
      limitations.push(`Requires ${entry.auth} credentials — obtain and configure them yourself; Krisha never invents, stores, or prompts for secrets.`);
    } else if (entry.auth === 'User-Agent') {
      limitations.push('Requires a custom User-Agent header per the provider policy — no secret involved.');
    }
    if (entry.cors !== 'Yes') {
      limitations.push('CORS not confirmed permissive — direct browser calls may be blocked; server-side use would be required.');
    }
    limitations.push(`Docs: ${entry.link}`);

    return {
      id,
      sourceId: PUBLIC_APIS_SOURCE_ID,
      name: entry.name,
      family: PUBLIC_APIS_FAMILY,
      category,
      description: entry.description,
      activationConditions: requiresCredentials
        ? `Consider only when the task explicitly needs ${category} data from this external provider AND the user has already configured the required ${entry.auth} credentials.`
        : `Consider only when the task explicitly needs ${category} data from this external provider and external HTTP access is authorized.`,
      tags,
      preferredTools: preferredToolsForHint(entry.krixCapabilityHint),
      // No modelHint: the supplied metadata provides no basis for one.
      riskLevel: 'MEDIUM',
      limitations,
      availability: requiresCredentials ? 'requires_credentials' : 'discoverable',
    };
  }
}
