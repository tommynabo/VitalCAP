import { describe, expect, it } from "vitest";
import type { GlobalAutopilotState } from "@/domain/autopilot/types";
import type { JobRecord } from "@/domain/discovery/types";
import { runAutopilotTick } from "./autopilot-scheduler";

function state(): GlobalAutopilotState {
  return {
    dailyTarget: 250,
    readyToday: 200,
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
      { engineType: "hybrid_fill", softTarget: 50, readyToday: 0, rawQueueDepth: 0, processingQueueDepth: 0, currentYield: 0, providerHealth: "healthy", lastRunAt: null, nextPlannedAction: null },
    ],
  };
}

describe("runAutopilotTick", () => {
  it("composes pacing, rebalancing, hybrid fill, and queue health into one tick result", () => {
    const jobs: JobRecord[] = [
      {
        id: "job_1",
        campaignId: "camp_1",
        type: "discovery",
        payload: {},
        status: "pending",
        attemptCount: 0,
        maxAttempts: 5,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: null,
        lastError: null,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
    ];
    const result = runAutopilotTick(state(), jobs, new Date("2025-01-01T12:00:00Z"));
    expect(result.pacing).toBeDefined();
    expect(result.rebalanceDecisions.length).toBeGreaterThan(0);
    expect(result.hybridFillActions.length).toBeGreaterThan(0);
    expect(result.queueHealth.pendingCount).toBe(1);
  });
});
