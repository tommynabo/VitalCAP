import type { EngineType } from "@/domain/campaigns/types";
import type { GlobalAutopilotState } from "@/domain/autopilot/types";
import { globalDeficit } from "@/lib/autopilot/targets";

/**
 * Hybrid Fill *decisioning* (Prompt 2 §2.10) — the part that matters most:
 * given the current global/engine state, decide which reactive actions to
 * take and log exactly why. Deliberately pure and independent of the
 * `DiscoveryEngine` interface (which has no room for a full
 * `GlobalAutopilotState` input) so it can be unit-tested and driven
 * directly by the Autopilot Target Engine, not just through a discovery
 * job's narrow `{ seed, dryRun }` shape.
 */

export type HybridFillTrigger = "provider_unhealthy" | "engine_unavailable" | "low_end_to_end_yield" | "seed_exhausted" | "queue_saturated";

export interface HybridFillCandidate {
  campaignId: string;
  engineType: EngineType;
  eligible: boolean;
  available: boolean;
  providerHealthy: boolean;
  yield: number;
  queueDepth: number;
  seedExhaustion: number;
}

export interface HybridFillDecision {
  sourceCampaignId: string;
  sourceEngine: EngineType;
  destinationCampaignIds: string[];
  trigger: HybridFillTrigger;
  reason: string;
}

export interface HybridFillDecisionInput {
  enabled: boolean;
  rawDeficit: number;
  candidates: readonly HybridFillCandidate[];
}

export interface HybridFillAction extends HybridFillDecision {
  targetEngine: EngineType;
  amount: 0;
}

export const HYBRID_FILL_LOW_YIELD_RATIO = 0.5;
export const HYBRID_FILL_SEED_EXHAUSTION_THRESHOLD = 0.8;
export const HYBRID_FILL_QUEUE_SATURATION_THRESHOLD = 1_000;

export function decideHybridFill(input: HybridFillDecisionInput): HybridFillDecision[] {
  if (!input.enabled || input.rawDeficit <= 0) return [];

  const decisions: HybridFillDecision[] = [];
  for (const source of input.candidates) {
    if (!source.eligible || source.engineType === "hybrid_fill") continue;
    const destinations = input.candidates.filter((candidate) =>
      candidate.eligible
      && candidate.campaignId !== source.campaignId
      && candidate.engineType !== source.engineType
      && candidate.available
      && candidate.providerHealthy,
    );
    if (!destinations.length) continue;

    const bestAlternativeYield = Math.max(...destinations.map((candidate) => candidate.yield));
    const trigger: HybridFillTrigger | null = !source.providerHealthy
      ? "provider_unhealthy"
      : !source.available
        ? "engine_unavailable"
        : source.seedExhaustion >= HYBRID_FILL_SEED_EXHAUSTION_THRESHOLD
          ? "seed_exhausted"
          : source.queueDepth >= HYBRID_FILL_QUEUE_SATURATION_THRESHOLD
            ? "queue_saturated"
            : source.yield < bestAlternativeYield * HYBRID_FILL_LOW_YIELD_RATIO
              ? "low_end_to_end_yield"
              : null;
    if (!trigger) continue;

    decisions.push({
      sourceCampaignId: source.campaignId,
      sourceEngine: source.engineType,
      destinationCampaignIds: destinations.map((candidate) => candidate.campaignId),
      trigger,
      reason: `hybrid_fill: ${source.engineType} ${trigger.replaceAll("_", " ")}; reallocating only this campaign's normal allocation to healthy concrete alternatives.`,
    });
  }
  return decisions;
}

export function planHybridFillActions(state: GlobalAutopilotState): HybridFillAction[] {
  const candidates: HybridFillCandidate[] = state.engines
    .filter((engine) => engine.engineType !== "hybrid_fill")
    .map((engine) => {
      const healthy = engine.providerHealth === "healthy" || engine.providerHealth === "untested";
      return {
        campaignId: engine.engineType,
        engineType: engine.engineType,
        eligible: engine.softTarget > 0 && engine.campaignActive !== false && engine.autopilotEnabled !== false,
        available: healthy && engine.providerConfigured !== false,
        providerHealthy: healthy && engine.providerConfigured !== false,
        yield: engine.currentYield,
        queueDepth: engine.rawQueueDepth + engine.processingQueueDepth,
        seedExhaustion: 0,
      };
    });
  return decideHybridFill({
    enabled: state.engines.some((engine) => engine.engineType === "hybrid_fill"),
    rawDeficit: globalDeficit(state.dailyTarget, state.engines),
    candidates,
  }).map((decision) => ({ ...decision, targetEngine: decision.sourceEngine, amount: 0 }));
}
