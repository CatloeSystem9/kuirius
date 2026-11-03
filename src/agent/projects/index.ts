/**
 * Project Awareness v1 — public surface.
 *
 * Read-only understanding of the user's approved software projects: identity,
 * languages, frameworks, dependencies, entry points, module structure,
 * development progress and change detection. Integrates through the EXISTING
 * Knowledge Graph (retrieval via the Context Engine), Memory Service,
 * Semantic Intelligence and the gated Tool Registry — no duplicate memory,
 * graph or context systems.
 */
export * from './projectTypes';
export { HttpProjectFs } from './projectFs';
export type { ProjectFs, ProjectDirEntry } from './projectFs';
// NOTE: NodeProjectFs (projectFsNode.ts) is deliberately NOT re-exported here —
// it imports 'fs'/'path' and must stay out of the browser bundle. Import it
// directly from './projects/projectFsNode' in Node-only code and tests.
export { ProjectStore } from './projectStore';
export { scanProject, detectChanges } from './projectScanner';
export type { ScanResult } from './projectScanner';
export { ProjectEngine } from './projectEngine';
export type { ProjectEngineOptions, IndexOutcome } from './projectEngine';
export { createProjectTools } from './projectTools';
export type { ProjectToolsDeps } from './projectTools';
