/**
 * Model capability profiles (Phase 17) — standardized, registry-based model
 * descriptions. Profiles are CONFIGURATION DATA describing the models the
 * repository already configures (the chat waterfall in server.ts); no
 * provider is assumed that the repo does not use. The registry is the single
 * source the router ranks against.
 */
export type ModelTier = 'light' | 'balanced' | 'strong';

export interface ModelCapabilities {
  reasoning: boolean;
  coding: boolean;
  vision: boolean;
  toolUse: boolean;
  structuredOutput: boolean;
  streaming: boolean;
}

export interface ModelProfile {
  id: string;
  provider: string;
  tier: ModelTier;
  capabilities: ModelCapabilities;
  /** Approximate context capacity in tokens. */
  contextTokens: number;
  /** 0..1 — higher is faster. */
  relativeSpeed: number;
  /** 0..1 — higher is more expensive. */
  relativeCost: number;
  /** 0..1 — observed/declared reliability for ranking. */
  reliability: number;
}

/** Tier inferred from the repo's model naming (configuration mapping). */
export function tierForModelName(modelId: string): ModelTier {
  if (/lite/i.test(modelId)) return 'light';
  if (/3\.[89]/.test(modelId) && !/lite/i.test(modelId)) return 'strong';
  return 'balanced';
}

export class ModelRegistry {
  private profiles = new Map<string, ModelProfile>();
  /** Transient unavailability with TTL — never a permanent verdict. */
  private unavailableUntil = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  register(profile: ModelProfile): void {
    if (!profile?.id) throw new Error('Model profile must have an id');
    this.profiles.set(profile.id, profile);
  }

  get(id: string): ModelProfile | undefined {
    return this.profiles.get(id);
  }

  list(): ModelProfile[] {
    return [...this.profiles.values()];
  }

  count(): number {
    return this.profiles.size;
  }

  isAvailable(id: string, at = this.now()): boolean {
    const until = this.unavailableUntil.get(id);
    if (until === undefined) return true;
    if (at >= until) {
      this.unavailableUntil.delete(id); // TTL expired — implicitly available again
      return true;
    }
    return false;
  }

  /** Mark a model temporarily unavailable (rate limit, outage). Bounded TTL. */
  markUnavailable(id: string, ttlMs: number, at = this.now()): void {
    this.unavailableUntil.set(id, Math.max(at, this.unavailableUntil.get(id) ?? 0) + Math.max(0, ttlMs));
  }

  clearUnavailable(): void {
    this.unavailableUntil.clear();
  }

  /** Profiles of one tier, cheapest → priciest (ties: reliability desc). */
  byTier(tier: ModelTier, at = this.now()): ModelProfile[] {
    return this.list()
      .filter((p) => p.tier === tier && this.isAvailable(p.id, at))
      .sort((a, b) => a.relativeCost - b.relativeCost || b.reliability - a.reliability || a.id.localeCompare(b.id));
  }

  /** Every available profile, cheapest first. */
  allAvailable(at = this.now()): ModelProfile[] {
    return this.list()
      .filter((p) => this.isAvailable(p.id, at))
      .sort((a, b) => a.relativeCost - b.relativeCost || b.reliability - a.reliability || a.id.localeCompare(b.id));
  }
}

/**
 * Registry seeded from the models the repository actually configures for
 * text generation (server.ts chat waterfall). All Gemini flash models in the
 * waterfall are multimodal and tool-capable — that is a fact of the existing
 * configuration, not an assumption about an unused provider.
 */
export function createDefaultModelRegistry(now: () => number = Date.now): ModelRegistry {
  const registry = new ModelRegistry(now);
  const flashCaps = (tier: ModelTier, speed: number, cost: number, reliability: number): ModelProfile => ({
    id: '',
    provider: 'gemini',
    tier,
    capabilities: { reasoning: true, coding: true, vision: true, toolUse: true, structuredOutput: true, streaming: true },
    contextTokens: 1_000_000,
    relativeSpeed: speed,
    relativeCost: cost,
    reliability,
  });

  const seed = (id: string, tier: ModelTier, speed: number, cost: number, reliability: number): void => {
    const profile = flashCaps(tier, speed, cost, reliability);
    profile.id = id;
    registry.register(profile);
  };

  // server.ts CANDIDATE_CHAT_MODELS, strongest → lightest:
  seed('gemini-3.8-flash', 'strong', 0.6, 0.6, 0.9);
  seed('gemini-3.7-flash', 'balanced', 0.72, 0.45, 0.9);
  seed('gemini-flash-latest', 'balanced', 0.8, 0.4, 0.92);
  seed('gemini-3.1-flash-lite', 'light', 0.95, 0.12, 0.85);
  return registry;
}
