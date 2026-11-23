/**
 * Persistent Identity Foundation (Step 1) — public surface.
 *
 * Krisha's identity: one stable, validated, versioned record persisted via
 * the project StorageAdapter convention, restored at startup, and delivered
 * to any AI provider through a validated injection boundary. Independent of
 * model configuration, conversation history, memory, voice and avatar.
 */
export * from './identityTypes';
export {
  CANONICAL_IDENTITY,
  identityContentHash,
  normalizeIdentity,
  validateIdentityRecord,
  validateIdentityTransportPayload,
  renderIdentityPromptBlock,
  migrateIdentityEnvelope,
  IDENTITY_MIGRATIONS,
} from './identityDefinition';
export { IdentityStore, rehashIdentity, type IdentityLoadResult } from './identityStore';
export {
  IdentityService,
  getIdentityService,
  resetIdentityServiceForTests,
  type IdentityChangeRecord,
  type IdentityUpdateResult,
} from './identityService';
