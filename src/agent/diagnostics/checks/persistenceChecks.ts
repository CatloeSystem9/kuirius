/**
 * Self-Diagnostics v1: Persistence Checks.
 *
 * Verifies storage availability without writing, deleting, or parsing user data.
 */

import type { DiagnosticCheckDef, DiagnosticCheckOutcome } from '../diagnosticTypes';
import type { StorageAdapter } from '../../taskState';

export interface PersistenceCheckDeps {
  storage?: StorageAdapter;
}

export function createPersistenceChecks(deps: PersistenceCheckDeps): DiagnosticCheckDef[] {
  return [
    {
      id: 'persistence.storage_adapter',
      name: 'Storage Adapter Read Availability',
      subsystem: 'persistence',
      description: 'Passively tests only the StorageAdapter read path; it never writes or removes data.',
      severity: 'critical',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        const storage = deps.storage;
        if (!storage) {
          return {
            status: 'unknown',
            message: 'StorageAdapter was not supplied to diagnostics.',
            remediation: 'Provide the existing storage adapter during DiagnosticsService construction.',
          };
        }

        try {
          const value = storage.getItem('krisha_agent_tasks_v1');

          return {
            status: 'healthy',
            message: 'Storage adapter read path is available; no persisted value was exposed or modified.',
            evidence: { taskSnapshotPresent: value !== null, readOnly: true },
          };
        } catch (err: any) {
          return {
            status: 'unhealthy',
            message: `Storage adapter threw an error: ${err?.message || String(err)}`,
            evidence: { error: String(err) },
            remediation: 'Check storage quota, file permissions, or storage availability.',
          };
        }
      },
    },
    {
      id: 'persistence.storage_contract',
      name: 'Storage Adapter Contract',
      subsystem: 'persistence',
      description: 'Passively verifies the existing adapter exposes the read/write/remove contract without calling mutators.',
      severity: 'warning',
      checkType: 'configuration',
      run(): DiagnosticCheckOutcome {
        const storage = deps.storage;
        if (!storage) {
          return {
            status: 'unknown',
            message: 'StorageAdapter was not supplied to diagnostics.',
            remediation: 'Provide the existing storage adapter during DiagnosticsService construction.',
          };
        }
        if (typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
          return {
            status: 'unhealthy',
            message: 'StorageAdapter does not implement the required storage contract.',
            remediation: 'Provide getItem, setItem, and removeItem methods on the storage adapter.',
          };
        }
        return {
          status: 'healthy',
          message: 'Storage adapter exposes the required contract; mutating methods were not called.',
          evidence: { hasGetItem: true, hasSetItem: true, hasRemoveItem: true, mutatorsCalled: false },
        };
      },
    },
  ];
}
