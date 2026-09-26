import type { SearchSeed } from "@/domain/discovery/types";
import { buildHybridMapsSeedCatalog, ICP_CATEGORY_TERMS, HYBRID_GEOGRAPHIES } from "@/services/discovery/spain-search-catalog";

export type TargetRisk = "on_track" | "recoverable" | "target_at_risk_budget" | "target_at_risk_provider" | "target_at_risk_exhaustion" | "target_at_risk_time";

export interface HybridFillPlanInput {
  remainingEffectiveTarget: number;
  hoursRemaining: number;
  normalAllocationExhausted: boolean;
  sourceUnderperformed: boolean;
  seedInventoryExhausted: boolean;
  providerHealthy: boolean;
  budgetRemaining: number;
  onPace: boolean;
  seeds: readonly SearchSeed[];
  campaignId: string;
  now: Date;
}

export interface HybridFillPlan {
  active: boolean;
  rawCount: number;
  targetRisk: TargetRisk;
  seed: { query: string; geography: string } | null;
  reason: string;
}

export function planHybridFill(input: HybridFillPlanInput): HybridFillPlan {
  if (input.onPace || input.remainingEffectiveTarget <= 0) return { active: false, rawCount: 0, targetRisk: "on_track", seed: null, reason: "on pace; Hybrid Fill is inactive." };
  if (!input.providerHealthy) return { active: false, rawCount: 0, targetRisk: "target_at_risk_provider", seed: null, reason: "no healthy Maps Fast capability; no paid rescue work scheduled." };
  if (input.budgetRemaining <= 0) return { active: false, rawCount: 0, targetRisk: "target_at_risk_budget", seed: null, reason: "remaining Apify budget is zero; no rescue work scheduled." };
  if (input.hoursRemaining > 2 && !input.normalAllocationExhausted && !input.sourceUnderperformed && !input.seedInventoryExhausted) {
    return { active: false, rawCount: 0, targetRisk: "recoverable", seed: null, reason: "deficit is still recoverable by normal allocation." };
  }

  const approvedHybridSeeds = input.seedInventoryExhausted
    ? buildHybridMapsSeedCatalog(input.campaignId)
    : [];
  const eligible = [...input.seeds, ...approvedHybridSeeds]
    .filter((seed) => seed.engineType === "maps_fast" && (!seed.nextEligibleAt || new Date(seed.nextEligibleAt) <= input.now))
    .sort((a, b) => a.exhaustionScore - b.exhaustionScore || b.yieldRate - a.yieldRate || a.query.localeCompare(b.query) || a.geography.localeCompare(b.geography));
  const seed = eligible[0] ?? null;
  if (!seed) return { active: false, rawCount: 0, targetRisk: "target_at_risk_exhaustion", seed: null, reason: "approved Maps Fast seed inventory is exhausted." };
  return {
    active: true,
    rawCount: Math.min(100, Math.max(1, input.remainingEffectiveTarget * 4)),
    targetRisk: "recoverable",
    seed: { query: seed.query || ICP_CATEGORY_TERMS[0], geography: seed.geography || HYBRID_GEOGRAPHIES[0] },
    reason: `hybrid_fill: ${input.seedInventoryExhausted ? "bootstrapped approved catalog; " : ""}late-day deficit rescue using approved Maps Fast seed ${seed.query} / ${seed.geography}.`,
  };
}