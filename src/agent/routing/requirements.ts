/**
 * Task requirements (Phase 17) — what a task or tool capability needs from a
 * model. Resolution is deterministic: classification factors + optional
 * hints + the declarative capability map (spec §6). The map is keyed on the
 * SAME capability prefixes the ToolRegistry/plan validation already use —
 * routing reads the existing contracts, never duplicates them.
 */
import type { Classification } from './complexity';

export interface TaskRequirements {
  vision?: boolean;
  toolUse?: boolean;
  structuredOutput?: boolean;
  deepReasoning?: boolean;
  webReasoning?: boolean;
  coding?: boolean;
  minContextTokens?: number;
}

/** Capability prefix → model requirements (declarative, mirrors the registry). */
const CAPABILITY_REQUIREMENTS: { match: RegExp; req: TaskRequirements }[] = [
  { match: /^(screen|vision)\./, req: { vision: true, deepReasoning: true } },
  { match: /^(browser|web)\./, req: { toolUse: true, webReasoning: true } },
  { match: /^(computer|keyboard|mouse)\./, req: { toolUse: true } },
  { match: /^research\./, req: { deepReasoning: true, webReasoning: true } },
  { match: /^(filesystem|files|application|app)\./, req: { toolUse: true } },
  { match: /^(memory|chat|system)\./, req: {} },
];

/** Requirements a tool capability implies (empty object = no special needs). */
export function requirementsForCapability(capability: string | undefined): TaskRequirements {
  if (!capability) return {};
  for (const entry of CAPABILITY_REQUIREMENTS) {
    if (entry.match.test(capability.trim().toLowerCase())) return { ...entry.req };
  }
  return {};
}

function mergeRequirements(base: TaskRequirements, extra: TaskRequirements): TaskRequirements {
  const out: TaskRequirements = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'boolean') (out as Record<string, unknown>)[key] = (out as Record<string, unknown>)[key] === true || value === true;
    else if (typeof value === 'number') (out as Record<string, unknown>)[key] = Math.max(Number(out[key as keyof TaskRequirements] ?? 0), value);
  }
  return out;
}

/**
 * Resolve requirements from a classification (+ optional hints). Deep
 * reasoning is required by COMPLEX/HIGH_COMPLEXITY tasks and research;
 * everything else runs on the lightest capable model.
 */
export function resolveRequirements(
  classification: Classification,
  hints?: { vision?: boolean; structuredOutput?: boolean; coding?: boolean; capability?: string; minContextTokens?: number }
): TaskRequirements {
  let req: TaskRequirements = {};
  const f = classification.factors;

  // Vision alone stays light (describing a screenshot is cheap); screen
  // ANALYSIS with deep reasoning comes from the screen.* capability map.
  if (f.visionSignals > 0 || hints?.vision) req.vision = true;
  if (f.browserSignals > 0 || f.computerSignals > 0) req.toolUse = true;
  if (f.researchSignals > 0) {
    req.deepReasoning = true;
    req.webReasoning = true;
  }
  if (classification.tier === 'COMPLEX' || classification.tier === 'HIGH_COMPLEXITY') req.deepReasoning = true;
  if (hints?.structuredOutput) req.structuredOutput = true;
  if (hints?.coding) req.coding = true;
  if (hints?.minContextTokens) req.minContextTokens = hints.minContextTokens;
  if (hints?.capability) req = mergeRequirements(req, requirementsForCapability(hints.capability));
  return req;
}

/** True when a profile satisfies every requirement. */
export function satisfiesRequirements(
  profile: { capabilities: { vision: boolean; toolUse: boolean; structuredOutput: boolean; coding: boolean }; contextTokens: number },
  req: TaskRequirements
): boolean {
  if (req.vision && !profile.capabilities.vision) return false;
  if (req.toolUse && !profile.capabilities.toolUse) return false;
  if (req.structuredOutput && !profile.capabilities.structuredOutput) return false;
  if (req.coding && !profile.capabilities.coding) return false;
  // Deep reasoning is a TIER requirement (strong/balanced models reason
  // multi-step better) — enforced by the router's tier floor, not per-profile.
  if (req.minContextTokens && profile.contextTokens < req.minContextTokens) return false;
  return true;
}
