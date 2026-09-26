import { describe, expect, it } from "vitest";
import { planHybridFill } from "./hybrid-fill-planner";
import type { SearchSeed } from "@/domain/discovery/types";

const seed: SearchSeed = {
  id: "seed-1",
  campaignId: "campaign-1",
  engineType: "maps_fast",
  query: "parafarmacia",
  geography: "Madrid",
  lastRunAt: null,
  totalRaw: 0,
  totalUnique: 0,
  totalReady: 0,
  yieldRate: 0,
  exhaustionScore: 0,
  nextEligibleAt: null,
};

const base = {
  remainingEffectiveTarget: 10,
  hoursRemaining: 1,
  normalAllocationExhausted: true,
  sourceUnderperformed: false,
  seedInventoryExhausted: false,
  providerHealthy: true,
  budgetRemaining: 5,
  onPace: false,
  seeds: [seed],
  campaignId: "campaign-1",
  now: new Date("2026-09-26T12:00:00Z"),
};

describe("Maps-only Hybrid Fill", () => {
  it("does not trigger while on pace", () => {
    expect(planHybridFill({ ...base, onPace: true }).active).toBe(false);
  });

  it("rescues a late deficit using a healthy Spanish Maps seed", () => {
    const plan = planHybridFill(base);
    expect(plan.active).toBe(true);
    expect(plan.seed).toEqual({ query: "parafarmacia", geography: "Madrid" });
    expect(plan.reason).toContain("hybrid_fill");
  });

  it("stops on budget/provider risk and avoids exhausted seeds", () => {
    expect(planHybridFill({ ...base, budgetRemaining: 0 }).targetRisk).toBe("target_at_risk_budget");
    expect(planHybridFill({ ...base, providerHealthy: false }).targetRisk).toBe("target_at_risk_provider");
      expect(planHybridFill({ ...base, seedInventoryExhausted: true, seeds: [{ ...seed, exhaustionScore: 1 }] }).targetRisk).toBe("target_at_risk_exhaustion");
  });
});