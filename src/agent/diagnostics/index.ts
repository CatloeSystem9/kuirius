/**
 * Self-Diagnostics v1: Runtime Health and Failure Awareness — Public API.
 */

export * from './diagnosticTypes';
export { DiagnosticRegistry } from './diagnosticRegistry';
export { FailureTracker, inferAffectedCapabilities, createFailureFingerprint } from './failureTracker';
export { DiagnosticsService, type DiagnosticsServiceDeps } from './diagnosticsService';
export { createDiagnosticTools } from './diagnosticTools';
export { createCoreChecks } from './checks/coreChecks';
export { createIntelligenceChecks } from './checks/intelligenceChecks';
export { createExecutionChecks } from './checks/executionChecks';
export { createModelChecks } from './checks/modelChecks';
export { createPersistenceChecks } from './checks/persistenceChecks';
export { createSystemChecks } from './checks/systemChecks';
