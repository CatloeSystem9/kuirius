/**
 * Self-Diagnostics v1: Persistence Checks.
 *
 * Verifies StorageAdapter read/write/delete integrity via an isolated, temporary probe,
 * and checks cache corruption handling.
 */

import type { DiagnosticCheckDef, DiagnosticCheckOutcome } from '../diagnosticTypes';
import type { StorageAdapter } from '../../taskState';
import { MemoryStorage } from '../../taskState';
import { PersistentCache } from '../../context/contextCache';

export interface PersistenceCheckDeps {
  storage?: StorageAdapter;
}

export function createPersistenceChecks(deps: PersistenceCheckDeps): DiagnosticCheckDef[] {
  return [
    {
      id: 'persistence.storage_adapter',
      name: 'Storage Adapter Read/Write/Delete Integrity',
      subsystem: 'persistence',
      description: 'Tests storage adapter with an isolated, temporary diagnostic probe key.',
      severity: 'critical',
      checkType: 'active_probe',
      run(): DiagnosticCheckOutcome {
        const storage = deps.storage ?? new MemoryStorage();
        const probeKey = `_krisha_diag_probe_${Date.now()}`;
        const probeValue = 'diagnostic_ok';

        try {
          storage.setItem(probeKey, probeValue);
          const readBack = storage.getItem(probeKey);

          if (readBack !== probeValue) {
            return {
              status: 'unhealthy',
              message: `Storage adapter failed to read back written value (got "${readBack}").`,
              remediation: 'Inspect storage adapter implementation or quota limits.',
            };
          }

          storage.removeItem(probeKey);
          const deleted = storage.getItem(probeKey);
          if (deleted !== null) {
            return {
              status: 'degraded',
              message: 'Storage adapter failed to remove temporary diagnostic probe key.',
              remediation: 'Verify removeItem implementation in storage adapter.',
            };
          }

          return {
            status: 'healthy',
            message: 'Storage adapter read, write, and removal are fully functional.',
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
      id: 'persistence.cache_resilience',
      name: 'Persistent Cache Corruption Resilience',
      subsystem: 'persistence',
      description: 'Verifies PersistentCache handles malformed storage payloads safely.',
      severity: 'warning',
      checkType: 'active_probe',
      run(): DiagnosticCheckOutcome {
        const tempStorage = new MemoryStorage();
        // Inject invalid JSON
        tempStorage.setItem('krisha_context_cache_v1', 'corrupted!json{{{{');

        try {
          const cache = new PersistentCache(tempStorage);
          const result = cache.get('any_key', 'query');

          if (result !== undefined) {
            return {
              status: 'degraded',
              message: 'PersistentCache returned a non-undefined result on corrupted storage.',
            };
          }

          return {
            status: 'healthy',
            message: 'PersistentCache gracefully recovered from corrupted storage without throwing.',
          };
        } catch (err: any) {
          return {
            status: 'unhealthy',
            message: `PersistentCache failed to handle corrupted data safely: ${err?.message || String(err)}`,
            evidence: { error: String(err) },
            remediation: 'Ensure JSON.parse is wrapped in try/catch inside cache loader.',
          };
        }
      },
    },
  ];
}
