import { describe, expect, it } from "vitest";
import {
  engineDeficit,
  globalDeficit,
  globalProgressPct,
  sumReady,
  sumSoftTargets,
} from "@/lib/autopilot/targets";
import type { EngineTargetState } from "@/domain/autopilot/types";

const engines: EngineTargetState[] = [
  { engineType: "maps_fast", softTarget: 50, readyToday: 60, rawQueueDepth: 10, processingQueueDepth: 2, currentYield: 0.4, providerHealth: "healthy", lastRunAt: null, nextPlannedAction: null },
  { engineType: "maps_deep", softTarget: 50, readyToday: 50, rawQueueDepth: 5, processingQueueDepth: 1, currentYield: 0.3, providerHealth: "healthy", lastRunAt: null, nextPlannedAction: null },
  { engineType: "google_serp", softTarget: 50, readyToday: 63, rawQueueDepth: 8, processingQueueDepth: 0, currentYield: 0.5, providerHealth: "healthy", lastRunAt: null, nextPlannedAction: null },
  { engineType: "linkedin_owner", softTarget: 50, readyToday: 27, rawQueueDepth: 12, processingQueueDepth: 3, currentYield: 0.15, providerHealth: "degraded", lastRunAt: null, nextPlannedAction: null },
  { engineType: "hybrid_fill", softTarget: 50, readyToday: 50, rawQueueDepth: 0, processingQueueDepth: 0, currentYield: 0.6, providerHealth: "healthy", lastRunAt: null, nextPlannedAction: null },
];

describe("autopilot target math", () => {
  it("sums soft targets to 250 for the default 5x50 configuration", () => {
    expect(sumSoftTargets(engines)).toBe(250);
  });

  it("matches the worked example from Prompt 0 §0.4 (total 250 ready)", () => {
    expect(sumReady(engines)).toBe(250);
    expect(globalDeficit(250, engines)).toBe(0);
    expect(globalProgressPct(250, engines)).toBe(100);
  });

  it("reports a per-engine deficit without ever going negative", () => {
    expect(engineDeficit(engines[3]!)).toBe(23);
    expect(engineDeficit(engines[0]!)).toBe(0);
  });

  it("never counts raw/processing queue depth toward global ready progress", () => {
    const inflatedQueueOnly: EngineTargetState = {
      engineType: "hybrid_fill",
      softTarget: 50,
      readyToday: 0,
      rawQueueDepth: 500,
      processingQueueDepth: 500,
      currentYield: 0,
      providerHealth: "healthy",
      lastRunAt: null,
      nextPlannedAction: null,
    };
    expect(sumReady([inflatedQueueOnly])).toBe(0);
  });
});
