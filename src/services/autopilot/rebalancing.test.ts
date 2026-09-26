import { describe, expect, it } from "vitest";
import { campaignScore, planRebalancing, type CampaignPerformance } from "./rebalancing";

function performance(overrides: Partial<CampaignPerformance> = {}): CampaignPerformance {
  return {
    campaignId: "a",
    engineType: "maps_fast",
    recentRaw: 100,
    recentQualified: 20,
    sampleSize: 100,
    providerCostUsd: 1,
    providerHealth: "healthy",
    seedExhaustion: 0,
    queueDepth: 0,
    activeRuns: 0,
    allocatedRaw: 10,
    ...overrides,
  };
}

describe("Maps Fast rebalancing", () => {
  it("moves deficit capacity to the better campaign", () => {
    const actions = planRebalancing({
      performances: [performance(), performance({ campaignId: "b", recentQualified: 60 })],
      uncoveredRaw: 6,
      now: new Date("2026-09-26T12:00:00Z"),
    });
    expect(actions[0]?.toCampaignId).toBe("b");
    expect(actions[0]?.amount).toBe(6);
  });

  it("uses neutral confidence for small samples and respects cooldown", () => {
    const small = campaignScore(performance({ sampleSize: 2, recentRaw: 2, recentQualified: 0 }), 20);
    const mature = campaignScore(performance({ sampleSize: 100, recentRaw: 100, recentQualified: 0 }), 20);
    expect(small).toBeGreaterThan(mature);
    expect(planRebalancing({
      performances: [performance({ campaignId: "a" }), performance({ campaignId: "b", recentQualified: 60 })],
      uncoveredRaw: 6,
      now: new Date("2026-09-26T12:10:00Z"),
      lastRebalanceAt: new Date("2026-09-26T12:00:00Z"),
    })).toHaveLength(0);
  });

  it("does not use unhealthy campaigns", () => {
    expect(planRebalancing({
      performances: [performance({ providerHealth: "paused" }), performance({ campaignId: "b", providerHealth: "paused" })],
      uncoveredRaw: 6,
      now: new Date("2026-09-26T12:00:00Z"),
    })).toHaveLength(0);
  });
});