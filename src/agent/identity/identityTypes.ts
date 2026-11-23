/**
 * Persistent Identity Foundation (Step 1) — types.
 *
 * Krisha's identity is WHO she is, permanently: one stable, versioned record
 * that survives restarts, sessions, model switches and provider switches.
 * It is deliberately NOT memory (what she knows about the user), NOT model
 * configuration (which AI runs her), NOT voice/avatar configuration (how she
 * sounds/looks). Those systems evolve independently without replacing her.
 */

/** Storage key for the versioned identity envelope (localStorage convention). */
export const IDENTITY_STORAGE_KEY = 'krisha_identity_v1';

/** Quarantine key: raw preserved payload when an unreadable/future schema is found. */
export const IDENTITY_QUARANTINE_KEY = 'krisha_identity_quarantine_v1';

/** Current storage schema version. Bump only with a migration in identityDefinition. */
export const IDENTITY_SCHEMA_VERSION = 1;

/** Where the currently-served identity came from. */
export type IdentityOrigin = 'canonical' | 'migrated' | 'restored' | 'recovered';

/** Personality foundation — the stable character core (provider-neutral data). */
export interface IdentityPersonality {
  /** One-paragraph canonical character foundation. */
  foundation: string;
  /** Stable tone descriptors (bounded list). */
  tone: string[];
  /** How warmth/affection is expressed. */
  warmthStyle: string;
}

/** Communication characteristics — how she speaks (not what she knows). */
export interface IdentityCommunication {
  /** Overall speaking style. */
  style: string;
  /** Language adaptation rule (multilingual behaviour). */
  languages: string;
  /** Reference to the emotion-tag protocol her voice/avatar layer consumes. */
  expressionTagging: string;
  /** Stable communication prohibitions (e.g. no written laughter tokens). */
  prohibitions: string[];
}

/**
 * The persistent identity record. Structured data — never pre-rendered prose —
 * so any provider can receive the same canonical identity rendered locally.
 */
export interface KrishaIdentity {
  /** Stable identifier generated once at first creation; NEVER changes afterwards. */
  identityId: string;
  /** Canonical name. */
  name: string;
  /** Short canonical archetype descriptor. */
  archetype: string;
  /** Identity definition revision (bumped only by deliberate canonical updates). */
  version: number;
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
  personality: IdentityPersonality;
  communication: IdentityCommunication;
  /** Behavioural principles (bounded list of stable commitments). */
  principles: string[];
  /** Where this record came from. */
  origin: IdentityOrigin;
  /** Deterministic integrity checksum over all semantic fields (except itself). */
  contentHash: string;
}

/** Persistence envelope — the schema-versioned wrapper convention. */
export interface IdentityStoreSchema {
  schemaVersion: number;
  identity: KrishaIdentity;
  savedAt: number;
}

/** Transport payload: the client sends this; the server validates + renders it. */
export interface IdentityTransportPayload {
  identityId: string;
  name: string;
  archetype: string;
  version: number;
  personality: IdentityPersonality;
  communication: IdentityCommunication;
  principles: string[];
  contentHash: string;
}

/**
 * Bounded field limits (validation + tamper resistance). Every limit is set
 * comfortably ABOVE the canonical definition's length — canonical content
 * must round-trip byte-perfect, never be clamped.
 */
export const IDENTITY_LIMITS = {
  name: 64,
  archetype: 200,
  foundation: 2000,
  toneCount: 12,
  toneItem: 120,
  warmthStyle: 500,
  style: 500,
  languages: 600,
  expressionTagging: 800,
  prohibitionsCount: 16,
  prohibitionItem: 200,
  principlesCount: 20,
  principleItem: 300,
} as const;

/** Result of validating a transport payload or persisted record. */
export interface IdentityValidationResult {
  ok: boolean;
  /** Repaired/rejected field notes (bounded diagnostics, no secrets possible here). */
  issues: string[];
}
