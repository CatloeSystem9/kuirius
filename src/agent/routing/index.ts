/**
 * Model Routing + Performance (Phase 17) — public surface.
 *
 * Deterministic, local-first routing: classify → requirements → registry →
 * route → bounded escalation / reason-aware fallback. The router produces
 * DECISIONS only; execution stays with the existing server waterfall and the
 * Agent Core, so routing can never bypass permissions, verification or
 * recovery. Telemetry is passive and bounded.
 */
export * from './complexity';
export * from './modelProfiles';
export * from './requirements';
export * from './router';
export * from './localPolicy';
export * from './cache';
export * from './coalesce';
export * from './telemetry';
export { CachedClassifier } from './classifier';
export type { CachedClassifierOptions } from './classifier';
export { createRoutingTools } from './routingTools';
