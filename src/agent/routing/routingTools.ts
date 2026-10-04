/**
 * Routing tools (Phase 17) — the router exposed through the Phase 3 Tool
 * contract. Both tools are SAFE, LOCAL and FREE: they compute decisions and
 * read metrics only. They execute nothing, so routing can never bypass
 * permissions, verification or recovery (spec §6/§20) — they give the
 * planner, proactive layer and DevTools a deterministic routing oracle.
 */
import type { AgentTool } from '../types';
import type { ModelRouter } from './router';
import type { CachedClassifier } from './classifier';
import type { PerformanceTelemetry } from './telemetry';
import { recommendedTimeoutMs } from './complexity';

export function createRoutingTools(
  router: ModelRouter,
  classifier: CachedClassifier,
  telemetry: PerformanceTelemetry
): AgentTool[] {
  return [
    {
      name: 'model.route',
      description: 'Classify a task and route it: returns the smallest capable model, the ordered fallback waterfall, and the bounded escalation path. Decision only — executes nothing.',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 0.99,
      capabilities: ['model.route', 'routing.decide'],
      permissions: [],
      inputSchema: {
        optional: ['task', 'capability'],
        types: { task: 'string', capability: 'string' },
      },
      verification: { strategy: 'self_reported', description: 'Deterministic local decision over the model registry; fully reproducible.' },
      timeoutMs: 2_000,
      async execute(input, ctx): Promise<any> {
        const task = input.task !== undefined ? String(input.task) : ctx.userRequest ?? '';
        const decision = router.route({ text: task, hints: { capability: input.capability ? String(input.capability) : undefined } });
        return {
          success: true,
          output: {
            summary: `Route: ${decision.model} (${decision.tier} tier) for ${decision.classification.tier} task; escalation path: ${decision.escalationPath.join(' → ') || 'none'}.`,
            model: decision.model,
            tier: decision.tier,
            complexity: decision.classification.tier,
            score: decision.classification.score,
            reason: decision.reason,
            orderedModels: decision.orderedModels,
            escalationPath: decision.escalationPath,
            recommendedTimeoutMs: decision.recommendedTimeoutMs,
          },
        };
      },
    },
    {
      name: 'perf.metrics',
      description: 'Read the local performance telemetry snapshot: routing decisions, model latencies, escalations, fallbacks, cache stats, tool durations.',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 0.99,
      capabilities: ['perf.metrics', 'telemetry.read'],
      permissions: [],
      inputSchema: {},
      verification: { strategy: 'self_reported', description: 'Passive counters over events that already happened; no background collection.' },
      timeoutMs: 2_000,
      async execute(): Promise<any> {
        const snapshot = telemetry.snapshot();
        return {
          success: true,
          output: {
            summary: `Routes: ${snapshot.counters.routes}, model calls: ${snapshot.counters.modelCalls} (avg ${snapshot.modelCalls.avgLatencyMs}ms), escalations: ${snapshot.counters.escalations}, fallbacks: ${snapshot.counters.fallbacks}, cache ${snapshot.counters.cacheHits}H/${snapshot.counters.cacheMisses}M.`,
            ...snapshot,
          },
        };
      },
    },
    {
      name: 'perf.classify',
      description: 'Classify task complexity only (TRIVIAL…HIGH_COMPLEXITY) with factor breakdown — deterministic, cached, no model call.',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 0.99,
      capabilities: ['perf.classify', 'routing.classify'],
      permissions: [],
      inputSchema: { optional: ['task'], types: { task: 'string' } },
      verification: { strategy: 'self_reported', description: 'Pure heuristics; the same text always yields the same tier.' },
      timeoutMs: 2_000,
      async execute(input, ctx): Promise<any> {
        const task = input.task !== undefined ? String(input.task) : ctx.userRequest ?? '';
        const classification = classifier.classify(task);
        return {
          success: true,
          output: {
            summary: `Complexity: ${classification.tier} (score ${classification.score}).`,
            tier: classification.tier,
            score: classification.score,
            factors: classification.factors,
            recommendedTimeoutMs: recommendedTimeoutMs(classification.tier),
          },
        };
      },
    },
  ];
}
