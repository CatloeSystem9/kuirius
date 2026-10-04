/**
 * Model router (Phase 17) — centralized, deterministic route selection.
 *
 *   classification → requirements → available profiles → route → escalate/fallback
 *
 * The router NEVER executes anything: it only produces decisions (model ids,
 * ordered waterfalls, escalation paths). Execution stays with the existing
 * server waterfall / Agent Core — so routing cannot bypass permissions,
 * verification, or recovery (spec §20). Escalation is strictly bounded
 * (light → balanced → strong, then null).
 */
import type { Classification, TaskComplexity } from './complexity';
import { classifyTask, recommendedTimeoutMs } from './complexity';
import type { ModelRegistry, ModelTier } from './modelProfiles';
import type { TaskRequirements } from './requirements';
import { resolveRequirements, satisfiesRequirements } from './requirements';
import type { PerformanceTelemetry } from './telemetry';

const TIER_ORDER: ModelTier[] = ['light', 'balanced', 'strong'];

export type FallbackReason =
  | 'timeout'
  | 'rate_limit'
  | 'unavailable'
  | 'invalid_response'
  | 'malformed_output'
  | 'network'
  | 'context_overflow'
  | 'refusal'
  | 'unknown';

export interface RouteDecision {
  tier: ModelTier;
  model: string;
  reason: string;
  /** Full waterfall order — selected model first, whole registry preserved
   *  behind it so existing fallback resilience is never reduced. */
  orderedModels: string[];
  /** Tiers above the selected one (bounded escalation ladder, spec §4). */
  escalationPath: ModelTier[];
  attempts: number;
  escalationHistory: { from: string; to: string; reason: string }[];
  recommendedTimeoutMs: number;
  classification: Classification;
  requirements: TaskRequirements;
}

export interface RouteInput {
  /** Task text — classified locally when no classification is supplied. */
  text?: string;
  classification?: Classification;
  requirements?: TaskRequirements;
  hints?: { vision?: boolean; structuredOutput?: boolean; coding?: boolean; capability?: string };
}

export interface EscalationInfo {
  from: string;
  to: string;
  reason: string;
}

function tierFloorFor(complexity: TaskComplexity): ModelTier {
  switch (complexity) {
    case 'TRIVIAL':
    case 'SIMPLE':
      return 'light';
    case 'MODERATE':
      return 'balanced';
    case 'COMPLEX':
    case 'HIGH_COMPLEXITY':
      return 'strong';
  }
}

function maxTier(a: ModelTier, b: ModelTier): ModelTier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

/** Tier implied by requirements (web/deep reasoning need at least balanced). */
function requirementsFloor(req: TaskRequirements): ModelTier {
  if (req.deepReasoning || req.webReasoning) return 'balanced';
  return 'light';
}

export class ModelRouter {
  constructor(
    private registry: ModelRegistry,
    private telemetry?: PerformanceTelemetry,
    private now: () => number = Date.now
  ) {}

  /** Select the smallest capable available model for the task. */
  route(input: RouteInput): RouteDecision {
    const classification = input.classification ?? classifyTask({ text: input.text ?? '' });
    const requirements = input.requirements ?? resolveRequirements(classification, input.hints);

    const floor = maxTier(tierFloorFor(classification.tier), requirementsFloor(requirements));
    let selected: { id: string; tier: ModelTier } | null = null;

    for (let i = TIER_ORDER.indexOf(floor); i < TIER_ORDER.length; i++) {
      const tier = TIER_ORDER[i];
      const candidates = this.registry.byTier(tier, this.now()).filter((p) => satisfiesRequirements(p, requirements));
      if (candidates.length > 0) {
        selected = { id: candidates[0].id, tier };
        break;
      }
    }
    if (!selected) {
      // Every matching model is marked unavailable — still return a decision
      // (cheapest light model) and let the waterfall/recovery deal with the
      // world as it is. Routing never leaves the caller without a plan.
      const any = this.registry.allAvailable(this.now());
      const fallbackPick = any[0] ?? this.registry.list().sort((a, b) => a.relativeCost - b.relativeCost)[0];
      selected = { id: fallbackPick.id, tier: fallbackPick.tier };
    }

    const profile = this.registry.get(selected.id)!;
    const decision: RouteDecision = {
      tier: profile.tier,
      model: profile.id,
      reason: `smallest capable: tier ${profile.tier} meets complexity ${classification.tier}`,
      orderedModels: this.orderedModelsFrom(profile.id),
      escalationPath: TIER_ORDER.slice(TIER_ORDER.indexOf(profile.tier) + 1),
      attempts: 0,
      escalationHistory: [],
      recommendedTimeoutMs: recommendedTimeoutMs(classification.tier),
      classification,
      requirements,
    };
    this.telemetry?.recordRoute({ at: this.now(), tier: decision.tier, model: decision.model, reason: decision.reason, complexity: classification.tier });
    return decision;
  }

  /**
   * Controlled escalation (spec §4): one tier up per call, bounded by the
   * ladder length. Returns null at the top — never loops.
   */
  escalate(previous: RouteDecision, reason: string): RouteDecision | null {
    const nextTier = TIER_ORDER[TIER_ORDER.indexOf(previous.tier) + 1];
    if (!nextTier) return null;
    const candidates = this.registry.byTier(nextTier, this.now()).filter((p) => satisfiesRequirements(p, previous.requirements));
    if (candidates.length === 0) return this.escalate({ ...previous, tier: nextTier, escalationPath: TIER_ORDER.slice(TIER_ORDER.indexOf(nextTier) + 1) }, reason);
    const profile = candidates[0];
    const decision: RouteDecision = {
      ...previous,
      tier: profile.tier,
      model: profile.id,
      reason: `escalated: ${reason.slice(0, 120)}`,
      orderedModels: this.orderedModelsFrom(profile.id),
      escalationPath: TIER_ORDER.slice(TIER_ORDER.indexOf(profile.tier) + 1),
      attempts: previous.attempts + 1,
      escalationHistory: [...previous.escalationHistory, { from: previous.model, to: profile.id, reason: reason.slice(0, 120) }],
      recommendedTimeoutMs: Math.max(previous.recommendedTimeoutMs, recommendedTimeoutMs(previous.classification.tier)),
    };
    this.telemetry?.recordEscalation({ at: this.now(), from: previous.model, to: profile.id, reason: reason.slice(0, 120) });
    return decision;
  }

  /**
   * Reason-aware fallback (spec §5): a COMPATIBLE alternative — never the
   * same failing model first. Context overflow prefers larger context;
   * everything else prefers same-tier reliability then adjacent tiers.
   * `markFailedTtlMs` optionally marks the failed model unavailable.
   */
  fallbackFrom(
    failedModelId: string,
    reason: FallbackReason,
    opts?: { requirements?: TaskRequirements; markFailedTtlMs?: number }
  ): { model: string; reason: string; exhausted: boolean } | null {
    if (opts?.markFailedTtlMs) this.registry.markUnavailable(failedModelId, opts.markFailedTtlMs, this.now());
    const failed = this.registry.get(failedModelId);
    const requirements = opts?.requirements ?? {};
    const pool = this.registry.allAvailable(this.now()).filter((p) => p.id !== failedModelId && satisfiesRequirements(p, requirements));

    if (pool.length === 0) {
      this.telemetry?.recordFallback({ at: this.now(), from: failedModelId, to: null, reason });
      return null;
    }

    let pick;
    if (reason === 'context_overflow') {
      pick = pool.slice().sort((a, b) => b.contextTokens - a.contextTokens || a.relativeCost - b.relativeCost)[0];
    } else {
      const failedTierIndex = failed ? TIER_ORDER.indexOf(failed.tier) : 1;
      pick = pool
        .slice()
        .sort(
          (a, b) =>
            Math.abs(TIER_ORDER.indexOf(a.tier) - failedTierIndex) - Math.abs(TIER_ORDER.indexOf(b.tier) - failedTierIndex) ||
            b.reliability - a.reliability ||
            a.relativeCost - b.relativeCost
        )[0];
    }
    this.telemetry?.recordFallback({ at: this.now(), from: failedModelId, to: pick.id, reason });
    return { model: pick.id, reason: `fallback from ${failedModelId} (${reason}) → ${pick.id}`, exhausted: false };
  }

  /**
   * Full fallback ladder for a failed model (bounded, duplicate-free):
   * every available alternative, best-first. Used by callers that want the
   * complete remaining order instead of one step.
   */
  fallbackLadder(failedModelId: string, requirements?: TaskRequirements): string[] {
    const failed = this.registry.get(failedModelId);
    const failedTierIndex = failed ? TIER_ORDER.indexOf(failed.tier) : 1;
    return this.registry
      .allAvailable(this.now())
      .filter((p) => p.id !== failedModelId && satisfiesRequirements(p, requirements ?? {}))
      .sort(
        (a, b) =>
          Math.abs(TIER_ORDER.indexOf(a.tier) - failedTierIndex) - Math.abs(TIER_ORDER.indexOf(b.tier) - failedTierIndex) ||
          b.reliability - a.reliability ||
          a.relativeCost - b.relativeCost
      )
      .map((p) => p.id);
  }

  /**
   * Waterfall order with the preferred model first — the ENTIRE registry
   * stays in the chain (never reduces existing fallback coverage).
   */
  private orderedModelsFrom(preferredId: string): string[] {
    const ladder = this.fallbackLadder(preferredId);
    return [preferredId, ...ladder];
  }
}
