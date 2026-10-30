/**
 * Self-Diagnostics v1: Model and API Integration Checks.
 *
 * Verifies model profiles, routing configuration, and passive telemetry.
 * STRICT POLICY: NO EXTERNAL NETWORK REQUESTS. Purely passive local inspection.
 */

import type { DiagnosticCheckDef, DiagnosticCheckOutcome } from '../diagnosticTypes';
import type { ModelRouter } from '../../routing/router';
import type { ModelRegistry } from '../../routing/modelProfiles';
import { getPerformanceTelemetry } from '../../routing/telemetry';

export interface ModelCheckDeps {
  router?: ModelRouter;
  registry?: ModelRegistry;
  modelRegistry?: ModelRegistry;
}

export function createModelChecks(deps: ModelCheckDeps): DiagnosticCheckDef[] {
  const reg = deps.modelRegistry ?? deps.registry;

  return [
    {
      id: 'models.registry.profiles',
      name: 'Model Profiles Configuration',
      subsystem: 'models',
      description: 'Verifies Model Registry has loaded configured model profiles.',
      severity: 'warning',
      checkType: 'configuration',
      run(): DiagnosticCheckOutcome {
        if (!reg) {
          return {
            status: 'unknown',
            message: 'ModelRegistry instance not supplied to diagnostics.',
            remediation: 'Provide ModelRegistry reference to diagnostic checks.',
          };
        }

        const profiles = reg.list();
        if (profiles.length === 0) {
          return {
            status: 'degraded',
            message: 'ModelRegistry contains 0 model profiles.',
            remediation: 'Ensure createDefaultModelRegistry() is called during startup.',
          };
        }

        return {
          status: 'healthy',
          message: `Model Registry has ${profiles.length} profile(s) configured.`,
          evidence: {
            configuredModels: profiles.map((p) => `${p.id} (${p.tier})`),
          },
        };
      },
    },
    {
      id: 'models.routing.config',
      name: 'Model Router Wiring',
      subsystem: 'models',
      description: 'Passively verifies that a Model Router is attached; no route is computed and no telemetry is mutated.',
      severity: 'warning',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        if (!deps.router) {
          return {
            status: 'unknown',
            message: 'ModelRouter instance is not configured.',
            remediation: 'Attach ModelRouter in bridge.ts.',
          };
        }

        return {
          status: 'healthy',
          message: 'Model Router is configured; diagnostics did not invoke routing or any model.',
          evidence: { routerAttached: true, modelInvocation: false },
        };
      },
    },
    {
      id: 'models.credentials.environment',
      name: 'API Key Configuration (Passive)',
      subsystem: 'models',
      description: 'Passively verifies whether required Gemini API keys are configured (no network calls).',
      severity: 'warning',
      checkType: 'configuration',
      run(): DiagnosticCheckOutcome {
        // Inspect process.env safely (works in Node and mocked environments)
        const hasGeminiKey = typeof process !== 'undefined' && Boolean(process.env?.GEMINI_API_KEY);

        if (!hasGeminiKey) {
          return {
            status: 'degraded',
            message: 'GEMINI_API_KEY is not set in the environment. Cloud model features will be unavailable.',
            remediation: 'Provide a valid GEMINI_API_KEY in the environment or settings if online generation is needed.',
          };
        }

        return {
          status: 'healthy',
          message: 'GEMINI_API_KEY is configured in the environment.',
        };
      },
    },
    {
      id: 'models.telemetry.failures',
      name: 'Model Failure Rate Telemetry',
      subsystem: 'models',
      description: 'Inspects passive performance telemetry for elevated model call failures.',
      severity: 'informational',
      checkType: 'passive',
      run(): DiagnosticCheckOutcome {
        const telemetry = getPerformanceTelemetry();
        const snapshot = telemetry.snapshot();
        const failures = snapshot.counters.modelCallFailures ?? 0;
        const totalCalls = snapshot.counters.modelCalls ?? 0;

        if (totalCalls > 0 && failures / totalCalls > 0.5) {
          return {
            status: 'degraded',
            message: `High model call failure rate detected: ${failures}/${totalCalls} failed.`,
            evidence: { totalCalls, failures, fallbacks: snapshot.counters.fallbacks },
            remediation: 'Check network connectivity or API key validity.',
          };
        }

        return {
          status: 'healthy',
          message: `Model call telemetry is normal (${failures} failure(s) out of ${totalCalls} call(s)).`,
          evidence: { totalCalls, failures },
        };
      },
    },
  ];
}
