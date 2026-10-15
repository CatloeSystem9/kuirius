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
}

export function createModelChecks(deps: ModelCheckDeps): DiagnosticCheckDef[] {
  return [
    {
      id: 'models.registry.profiles',
      name: 'Model Profiles Configuration',
      subsystem: 'models',
      description: 'Verifies Model Registry has loaded configured model profiles.',
      severity: 'warning',
      checkType: 'configuration',
      run(): DiagnosticCheckOutcome {
        if (!deps.registry) {
          return {
            status: 'unknown',
            message: 'ModelRegistry instance not supplied to diagnostics.',
            remediation: 'Provide ModelRegistry reference to diagnostic checks.',
          };
        }

        const profiles = deps.registry.list();
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
      name: 'Model Router Route Computation',
      subsystem: 'models',
      description: 'Verifies the Model Router can compute routes without external network calls.',
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

        try {
          const route = deps.router.route({
            taskType: 'chat',
            complexity: 'simple',
            requirements: { reasoning: false, coding: false, vision: false, toolUse: false, structuredOutput: false, streaming: false },
          });

          if (!route?.selectedModel) {
            return {
              status: 'degraded',
              message: 'Model Router failed to select a model for standard chat requirements.',
              remediation: 'Review model profile capabilities and routing rules.',
            };
          }

          return {
            status: 'healthy',
            message: `Model Router selected model "${route.selectedModel.id}" for baseline chat.`,
            evidence: {
              selectedModel: route.selectedModel.id,
              tier: route.selectedModel.tier,
              reason: route.reason,
            },
          };
        } catch (err: any) {
          return {
            status: 'unhealthy',
            message: `Model Router evaluation failed: ${err?.message || String(err)}`,
            evidence: { error: String(err) },
            remediation: 'Inspect ModelRouter routing logic.',
          };
        }
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
