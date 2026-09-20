import { describe, expect, it } from "vitest";
import { simulateAutopilotDay } from "./simulate-autopilot-day";

describe("simulateAutopilotDay", () => {
  it("runs all five engines' mock providers, dedups globally, and produces ready candidates", async () => {
    const result = await simulateAutopilotDay();
    expect(result.totalRawCandidates).toBeGreaterThan(0);
    expect(result.totalProcessed).toBe(result.totalRawCandidates);
    expect(result.totalReady).toBeGreaterThan(0);
    expect(result.totalReady).toBeLessThanOrEqual(result.totalProcessed);
  });

  it("forces the LinkedIn Owner provider into a paused health state after simulated repeated errors", async () => {
    const result = await simulateAutopilotDay();
    const linkedIn = result.engines.find((e) => e.engineType === "linkedin_owner")!;
    expect(linkedIn.providerHealth).toBe("paused");
    expect(result.state.systemHealth).toBe("degraded");
  });

  it("plans Hybrid Fill actions in response to the LinkedIn Owner outage and overall deficit", async () => {
    const result = await simulateAutopilotDay();
    expect(result.tick.hybridFillActions.length).toBeGreaterThan(0);
  });

  it("exercises the job queue: one job completes, one permanently-failing job dead-letters immediately", async () => {
    const result = await simulateAutopilotDay();
    expect(result.jobQueueOutcome.completedJobId).toBe("job_ok");
    expect(result.jobQueueOutcome.deadLetteredJobId).toBe("job_bad");
  });

  it("computes a ready-buffer-days figure and an autopilot tick against the final engine state", async () => {
    const result = await simulateAutopilotDay();
    expect(result.bufferDays).toBeGreaterThanOrEqual(0);
    expect(result.tick.pacing).toBeDefined();
    expect(result.tick.queueHealth).toBeDefined();
  });
});
