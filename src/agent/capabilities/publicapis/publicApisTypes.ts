/**
 * publicApisTypes.ts
 *
 * Shared types for the public-apis catalog. Mirrors the structure used by
 * the public-apis/public-apis GitHub repo (API name, description, auth
 * model, HTTPS support, CORS support, category) and adds an optional link
 * to Krix's own ToolCapability enum (see specialistTypes.ts) so specialist
 * definitions can reference real-world API categories they'd eventually
 * be wired up to.
 *
 * ZERO runtime dependencies. Pure types + one small helper.
 */

/** Matches the auth column convention used by public-apis/public-apis. */
export type ApiAuthType =
  | "None"
  | "apiKey"
  | "OAuth"
  | "X-Mashape-Key"
  | "User-Agent";

export type CorsSupport = "Yes" | "No" | "Unknown";

/**
 * Loose mapping to Krix's ToolCapability enum (specialistTypes.ts).
 * Not every category maps cleanly — many public APIs are domain data
 * sources rather than a generic capability. Left undefined when there's
 * no sensible mapping.
 */
export type KrixCapabilityHint =
  | "browser"
  | "web-search"
  | "data-analysis"
  | "spreadsheet-engine"
  | "image-analysis"
  | "video-analysis"
  | "document-reader"
  | "calendar"
  | "code-execution"
  | "none";

export interface PublicApiEntry {
  /** Display name, e.g. "OpenWeatherMap" */
  name: string;
  /** One-line description of what the API provides. */
  description: string;
  /** Authentication model required to use the API. */
  auth: ApiAuthType;
  /** Whether the API is served over HTTPS. */
  https: boolean;
  /** Whether the API sets permissive CORS headers (for client-side calls). */
  cors: CorsSupport;
  /** Documentation / homepage URL. */
  link: string;
  /** Optional link into Krix's generic tool-capability vocabulary. */
  krixCapabilityHint?: KrixCapabilityHint;
}

export interface PublicApiCategory {
  /** Category name, matching the public-apis/public-apis section headers. */
  category: string;
  /** Short note on what kinds of APIs live in this category. */
  summary?: string;
  entries: PublicApiEntry[];
}

/** Flattens all categories into a single entry list. */
export function flattenCatalog(categories: PublicApiCategory[]): PublicApiEntry[] {
  return categories.flatMap((c) => c.entries);
}

/** Filters entries that require no authentication at all — good for quick prototypes. */
export function noAuthEntries(categories: PublicApiCategory[]): PublicApiEntry[] {
  return flattenCatalog(categories).filter((e) => e.auth === "None");
}

/** Filters entries that are both HTTPS and CORS-enabled — safe for direct browser/frontend calls. */
export function browserSafeEntries(categories: PublicApiCategory[]): PublicApiEntry[] {
  return flattenCatalog(categories).filter((e) => e.https && e.cors === "Yes");
}

/** Look up all entries tagged with a given Krix capability hint. */
export function entriesForCapability(
  categories: PublicApiCategory[],
  hint: KrixCapabilityHint
): PublicApiEntry[] {
  return flattenCatalog(categories).filter((e) => e.krixCapabilityHint === hint);
}
