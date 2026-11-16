/**
 * Process Monitor public surface (Phase A).
 *
 * `ProcessMonitor` is Node-only (child_process) — import it from the server
 * entrypoint and tests only. `createProcessMonitorTools` is browser-safe
 * (fetch-backed read-only visibility tool).
 */
export * from './monitorTypes';
export { ProcessMonitor, KPM_WORKER_SCRIPT } from './processMonitor';
export { createProcessMonitorTools } from './tools';
