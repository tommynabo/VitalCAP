import { describe, expect, it } from "vitest";
import type { GlobalAutopilotState } from "@/domain/autopilot/types";
import { computeRebalancing } from "./quota-rebalancer";

function state(): GlobalAutopilotState {
  return {
    dailyTarget: 250,
    readyToday: 232,
    sentToday: 0,
    repliesToday: 0,
    meetingsToday: 0,
    readyBufferDays: 1,
    systemHealth: "healthy",
    engines: [
      { engineType: "maps_fast", softTarget: 50, readyToday: 60, rawQueueDepth: 0, processingQueueDepth: 0, currentYield: 0.4, providerHealth: "healthy", lastRunAt: null, nextPlannedAction: null },
      { engineType: "maps_deep", softTarget: 50, readyToday: 50, rawQueueDepth: 0, processingQueueDepth: 0, currentYield: 0.3, providerHealth: "healthy", lastRunAt: null, nextPlannedAction: null },
      { engineType: "google_serp", softTarget: 50, readyToday: 63, rawQueueDepth: 0, processingQueueDepth: 0, currentYield: 0.35, providerHealth: "healthy", lastRunAt: null, nextPlannedAction: null },
      { engineType: "linkedin_owner", softTarget: 50, readyToday: 27, rawQueueDepth: 0, processingQueueDepth: 0, currentYield: 0.08, providerHealth: "degraded", lastRunAt: null, nextPlannedAction: null },
      { engineType: "hybrid_fill", softTarget: 50, readyToday: 32, rawQueueDepth: 0, processingQueueDepth: 0, currentYield: 0.15, providerHealth: "healthy", lastRunAt: null, nextPlannedAction: null },
    ],
  };
}

describe("computeRebalancing", () => {
  it("reallocates a behind engine's deficit to the highest-yield healthy donors", () => {
    const decisions = computeRebalancing(state(), new Date("2025-01-01T12:00:00Z"));
    const linkedinDecisions = decisions.filter((d) => d.fromEngine === "linkedin_owner");
    expect(linkedinDecisions.length).toBeGreaterThan(0);
    const totalAllocated = linkedinDecisions.reduce((sum, d) => sum + d.amount, 0);
    expect(totalAllocated).toBe(23); // deficit = 50 - 27
  });

  it("spreads a single engine's deficit across at most 2 donors to preserve source diversity", () => {
    const decisions = computeRebalancing(state(), new Date("2025-01-01T12:00:00Z"));
    const linkedinDonors = new Set(decisions.filter((d) => d.fromEngine === "linkedin_owner").map((d) => d.toEngine));
    expect(linkedinDonors.size).toBeLessThanOrEqual(2);
  });

  it("never allocates from an engine that is already at or above its soft target", () => {
    const decisions = computeRebalancing(state(), new Date("2025-01-01T12:00:00Z"));
    expect(decisions.some((d) => d.fromEngine === "maps_fast")).toBe(false);
    expect(decisions.some((d) => d.fromEngine === "google_serp")).toBe(false);
  });

  it("produces a human-readable reason string matching the spec's example format", () => {
    const decisions = computeRebalancing(state(), new Date("2025-01-01T12:00:00Z"));
    const decision = decisions.find((d) => d.fromEngine === "linkedin_owner")!;
    expect(decision.reason).toContain("linkedin_owner behind target by 23");
  });

  it("returns no decisions when every engine is at or above its soft target", () => {
    const s = state();
    for (const engine of s.engines) engine.readyToday = engine.softTarget;
    expect(computeRebalancing(s, new Date())).toHaveLength(0);
  });
});
