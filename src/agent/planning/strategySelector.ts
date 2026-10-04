/**
 * Strategy selection (Phase 16, spec §17) — deterministic, cheapest-reliable
 * first. The ToolRegistry remains the authoritative source of tool knowledge;
 * this module only ranks and explains. No model calls.
 */
import type { ToolRegistry } from '../toolRegistry';
import type { AgentTool } from '../types';
import { rankToolsForCapability } from '../toolSelector';
import type { PlanDomain } from './planningTypes';

export interface StrategyOption {
  tool: AgentTool;
  cost: string;
  risk: string;
  reliability: number;
}

/** All viable tools for a capability, cheapest → most expensive. */
export function strategyOptions(registry: ToolRegistry, capability: string): StrategyOption[] {
  return rankToolsForCapability(registry, capability).map((tool) => ({
    tool,
    cost: tool.cost ?? 'cheap',
    risk: tool.riskLevel,
    reliability: tool.reliability ?? 0.8,
  }));
}

/**
 * Deterministic modality preference per domain (structured/native evidence
 * before visual interaction) — used for diagnosis planning and diagnostics.
 */
export function preferredPlan(domain: PlanDomain): string[] {
  switch (domain) {
    case 'browser':
      return ['browser-native structured state', 'on-page structured query', 'visual observation via screen'];
    case 'computer':
      return ['screen observation (Phase 13 adaptive)', 'targeted control action'];
    case 'filesystem':
      return ['direct filesystem read', 'filesystem search'];
    case 'application':
      return ['process-table status read', 'visual observation'];
    case 'memory':
      return ['memory recall'];
    case 'communication':
      return ['direct report'];
    default:
      return ['deterministic local check'];
  }
}
