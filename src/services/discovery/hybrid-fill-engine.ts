import type { DiscoveryEngine, RawCandidate, SearchSeed } from "@/domain/discovery/types";
import type { EngineType } from "@/domain/campaigns/types";

/**
 * Hybrid Fill engine wrapper (Prompt 2 §2.10). Its decision-making lives in
 * `planHybridFillActions` (`hybrid-fill-decision.ts`), which needs a full
 * `GlobalAutopilotState` the narrow `DiscoveryEngine` contract has no room
 * for — this class only satisfies that contract so `DiscoveryRouter` can
 * dispatch `hybrid_fill` seeds uniformly: it delegates the actual raw
 * discovery to whichever underlying engine the seed already targets
 * (`seed.engineType`), then re-tags the resulting candidates as
 * `hybrid_fill` to preserve the fact that Hybrid Fill is what chose to run
 * them, not the engine's own regular schedule.
 */
export class HybridFillEngine implements DiscoveryEngine {
  readonly engineType = "hybrid_fill" as const;

  constructor(private readonly delegates: Partial<Record<EngineType, DiscoveryEngine>>) {}

  validateConfig(): { valid: boolean; errors: string[] } {
    return { valid: true, errors: [] };
  }

  async planDiscoveryBatch(input: { campaignId: string; remainingTarget: number }): Promise<{ seeds: SearchSeed[] }> {
    const mapsFast = this.delegates.maps_fast;
    if (!mapsFast) return { seeds: [] };
    return mapsFast.planDiscoveryBatch(input);
  }

  async executeDiscovery(input: { seed: SearchSeed; dryRun: boolean }): Promise<{
    rawCandidates: RawCandidate[];
    providerCalls: number;
    providerErrors: number;
    latencyMs: number;
  }> {
    const delegate = this.delegates[input.seed.engineType];
    if (!delegate) {
      return { rawCandidates: [], providerCalls: 0, providerErrors: 0, latencyMs: 0 };
    }

    const result = await delegate.executeDiscovery(input);
    return {
      ...result,
      rawCandidates: result.rawCandidates.map((candidate) => ({ ...candidate, engineType: this.engineType })),
    };
  }
}
