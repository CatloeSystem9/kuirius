/**
 * Tool Selection (Phase 3) — deterministic, cost-aware choice among tools
 * that declare a matching capability. The registry is the authoritative
 * source of tool knowledge; the selector only ranks candidates.
 *
 * Preference order: lower cost → lower risk → higher declared reliability.
 */
import type { AgentTool, ToolCost, ToolRiskLevel } from './types';
import type { ToolRegistry } from './toolRegistry';
import { RISK_ORDER } from './permissions';

const COST_ORDER: Record<ToolCost, number> = {
  free: 0,
  cheap: 1,
  moderate: 2,
  expensive: 3,
};

export interface ToolSelection {
  tool: AgentTool;
  capability: string;
  reason: string;
  candidatesConsidered: number;
}

export function rankToolsForCapability(registry: ToolRegistry, capability: string): AgentTool[] {
  return registry
    .findByCapability(capability)
    .slice()
    .sort((a, b) => {
      const cost = COST_ORDER[a.cost ?? 'cheap'] - COST_ORDER[b.cost ?? 'cheap'];
      if (cost !== 0) return cost;
      const risk = RISK_ORDER[a.riskLevel] - RISK_ORDER[b.riskLevel];
      if (risk !== 0) return risk;
      const reliability = (b.reliability ?? 0.8) - (a.reliability ?? 0.8);
      if (reliability !== 0) return reliability;
      return a.name.localeCompare(b.name);
    });
}

export function selectToolForCapability(registry: ToolRegistry, capability: string): ToolSelection | null {
  const ranked = rankToolsForCapability(registry, capability);
  if (ranked.length === 0) return null;
  const tool = ranked[0];
  const reason =
    `capability "${capability}" matched ${tool.name} ` +
    `(cost: ${tool.cost ?? 'cheap'}, risk: ${tool.riskLevel}, reliability: ${(tool.reliability ?? 0.8).toFixed(2)})` +
    (ranked.length > 1 ? ` over ${ranked.length - 1} alternative(s)` : '');
  return { tool, capability, reason, candidatesConsidered: ranked.length };
}
