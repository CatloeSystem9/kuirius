/**
 * Incident Orchestration (Phase F) — public surface. NODE-ONLY module
 * (server entrypoint and tests only); browser-safe tool wrappers live in
 * tools.ts.
 *
 * Phase F coordinates Phases A–E into traceable incidents: Phase E stays the
 * sole intelligence source; containment executes ONLY through Phase D's
 * credential-verified, pinned pathway; the E-stop is authoritative at
 * evaluation and execution; every operation is audited (metadata-only) via
 * the E5 funnel.
 */
export * from './incidentTypes';
export { IncidentStore, newIncidentId } from './incidentStore';
export { IncidentOrchestrator, type OrchestratorDeps } from './orchestrator';
