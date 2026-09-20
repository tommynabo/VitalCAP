import { describe, expect, it } from "vitest";
import type { GlobalAutopilotState } from "@/domain/autopilot/types";
import { planHybridFillActions } from "./hybrid-fill-decision";

function state(overrides: Partial<GlobalAutopilotState> = {}): GlobalAutopilotState {
  return {
    dailyTarget: 250,
    readyToday: 200,
    sentToday: 0,
    repliesToday: 0,
    meetingsToday: 0,
    readyBufferDays: 1,
    systemHealth: "healthy",
    engines: [
      { engineType: "maps_fast", softTarget: 50, readyToday: 50, rawQueueDepth: 0, processingQueueDepth: 0, currentYield: 0.4, providerHealth: "healthy", lastRunAt: null, nextPlannedAction: null },
      { engineType: "maps_deep", softTarget: 50, readyToday: 50, rawQueueDepth: 0, processingQueueDepth: 0, currentYield: 0.3, providerHealth: "healthy", lastRunAt: null, nextPlannedAction: null },
      { engineType: "google_serp", softTarget: 50, readyToday: 50, rawQueueDepth: 0, processingQueueDepth: 0, currentYield: 0.2, providerHealth: "healthy", lastRunAt: null, nextPlannedAction: null },
      { engineType: "linkedin_owner", softTarget: 50, readyToday: 32, rawQueueDepth: 0, processingQueueDepth: 0, currentYield: 0.1, providerHealth: "healthy", lastRunAt: null, nextPlannedAction: null },
      { engineType: "hybrid_fill", softTarget: 50, readyToday: 18, rawQueueDepth: 0, processingQueueDepth: 0, currentYield: 0, providerHealth: "healthy", lastRunAt: null, nextPlannedAction: null },
    ],
    ...overrides,
  };
}

describe("planHybridFillActions", () => {
  it("returns no fill actions when the global target is already met", () => {
    const s = state();
    for (const engine of s.engines) engine.readyToday = engine.softTarget; // sum(ready) === dailyTarget (250)
    const actions = planHybridFillActions(s);
    expect(actions.filter((a) => a.amount > 0 && a.type !== "retry_transient_failures")).toHaveLength(0);
  });

  it("runs extra Maps Fast seeds when behind target and Maps Fast is healthy with good yield", () => {
    const actions = planHybridFillActions(state());
    const mapsFastAction = actions.find((a) => a.targetEngine === "maps_fast");
    expect(mapsFastAction?.type).toBe("extra_maps_fast_seeds");
    expect(mapsFastAction?.reason).toContain("deficit");
  });

  it("broadens retail category instead of extra seeds when Maps Fast yield is exhausted", () => {
    const s = state();
    s.engines[0]!.currentYield = 0.02;
    const actions = planHybridFillActions(s);
    expect(actions.find((a) => a.targetEngine === "maps_fast")?.type).toBe("broaden_retail_category");
  });

  it("logs a retry action for a degraded provider and a switch action for a paused one", () => {
    const s = state();
    s.engines[2]!.providerHealth = "degraded";
    s.engines[3]!.providerHealth = "paused";
    const actions = planHybridFillActions(s);
    expect(actions.some((a) => a.targetEngine === "google_serp" && a.type === "retry_transient_failures")).toBe(true);
    expect(actions.some((a) => a.targetEngine === "linkedin_owner" && a.type === "switch_healthy_provider")).toBe(true);
  });

  it("prioritizes deepening incomplete accounts when Maps Deep has a raw queue backlog", () => {
    const s = state();
    s.engines[1]!.rawQueueDepth = 12;
    const actions = planHybridFillActions(s);
    const deepenAction = actions.find((a) => a.type === "deepen_incomplete_accounts");
    expect(deepenAction?.amount).toBe(12);
  });

  it("every action carries a non-empty, specific reason string", () => {
    const actions = planHybridFillActions(state());
    for (const action of actions) {
      expect(action.reason.length).toBeGreaterThan(10);
    }
  });
});
