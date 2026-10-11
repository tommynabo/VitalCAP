import { describe, expect, it } from "vitest";
import type { GlobalAutopilotState } from "@/domain/autopilot/types";
import { decideHybridFill, planHybridFillActions, type HybridFillCandidate } from "./hybrid-fill-decision";

function candidate(overrides: Partial<HybridFillCandidate> = {}): HybridFillCandidate {
  return {
    campaignId: "maps-campaign",
    engineType: "maps_fast",
    eligible: true,
    available: true,
    providerHealthy: true,
    yield: 0.04,
    queueDepth: 0,
    seedExhaustion: 0,
    ...overrides,
  };
}

const alternative = candidate({ campaignId: "serper-campaign", engineType: "google_serp", yield: 0.3 });

describe("canonical Hybrid Fill decision", () => {
  it("reroutes underperforming Maps work to a healthy concrete campaign", () => {
    const [decision] = decideHybridFill({ enabled: true, rawDeficit: 100, candidates: [candidate(), alternative] });

    expect(decision).toMatchObject({
      sourceCampaignId: "maps-campaign",
      sourceEngine: "maps_fast",
      destinationCampaignIds: ["serper-campaign"],
      trigger: "low_end_to_end_yield",
    });
  });

  it("reacts to provider health, engine availability, seed exhaustion, and queue saturation", () => {
    expect(decideHybridFill({ enabled: true, rawDeficit: 10, candidates: [candidate({ providerHealthy: false, available: false }), alternative] })[0]?.trigger).toBe("provider_unhealthy");
    expect(decideHybridFill({ enabled: true, rawDeficit: 10, candidates: [candidate({ available: false }), alternative] })[0]?.trigger).toBe("engine_unavailable");
    expect(decideHybridFill({ enabled: true, rawDeficit: 10, candidates: [candidate({ seedExhaustion: 0.8 }), alternative] })[0]?.trigger).toBe("seed_exhausted");
    expect(decideHybridFill({ enabled: true, rawDeficit: 10, candidates: [candidate({ queueDepth: 1_000, yield: 0.3 }), alternative] })[0]?.trigger).toBe("queue_saturated");
  });

  it("lets recovered Maps re-enter when its yield is competitive and inventory is healthy", () => {
    const decisions = decideHybridFill({
      enabled: true,
      rawDeficit: 100,
      candidates: [candidate({ yield: 0.2 }), alternative],
    });

    expect(decisions).toEqual([]);
  });

  it("does not create demand when the target is met or no healthy alternative exists", () => {
    expect(decideHybridFill({ enabled: true, rawDeficit: 0, candidates: [candidate(), alternative] })).toEqual([]);
    expect(decideHybridFill({
      enabled: true,
      rawDeficit: 10,
      candidates: [candidate({ available: false, providerHealthy: false }), { ...alternative, available: false, providerHealthy: false }],
    })).toEqual([]);
  });

  it("keeps the legacy scheduler adapter demand-neutral", () => {
    const state: GlobalAutopilotState = {
      dailyTarget: 250,
      readyToday: 0,
      sentToday: 0,
      repliesToday: 0,
      meetingsToday: 0,
      readyBufferDays: 1,
      systemHealth: "healthy",
      engines: [
        { engineType: "maps_fast", softTarget: 100, readyToday: 0, rawQueueDepth: 0, processingQueueDepth: 0, currentYield: 0.01, providerHealth: "healthy", lastRunAt: null, nextPlannedAction: null },
        { engineType: "google_serp", softTarget: 100, readyToday: 0, rawQueueDepth: 0, processingQueueDepth: 0, currentYield: 0.3, providerHealth: "healthy", lastRunAt: null, nextPlannedAction: null },
        { engineType: "hybrid_fill", softTarget: 0, readyToday: 0, rawQueueDepth: 0, processingQueueDepth: 0, currentYield: 0, providerHealth: "healthy", lastRunAt: null, nextPlannedAction: null },
      ],
    };
    const [action] = planHybridFillActions(state);

    expect(action?.amount).toBe(0);
    expect(action?.reason).toContain("low end to end yield");
  });
});
