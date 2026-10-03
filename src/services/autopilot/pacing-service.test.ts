import { describe, expect, it } from "vitest";
import { classifyAutopilotTargetRisk, computeAutopilotPacing, computePacing, madridHourOf } from "./pacing-service";

describe("madridHourOf", () => {
  it("extracts the Europe/Madrid local hour from a UTC instant", () => {
    // 2025-06-15T10:00:00Z is 12:00 CEST (summer, UTC+2) in Madrid.
    expect(madridHourOf(new Date("2025-06-15T10:00:00Z"))).toBe(12);
  });
});

describe("computePacing", () => {
  const window = { startHour: 8, endHour: 20 };

  it("reports on_track when actual matches the linear trajectory", () => {
    // Midday (14:00 Madrid, summer) = 50% through an 8-20 window.
    const result = computePacing(250, 125, new Date("2025-06-15T12:00:00Z"), window);
    expect(result.status).toBe("on_track");
    expect(result.suggestedBatchMultiplier).toBe(1);
  });

  it("reports behind and suggests a >1 batch multiplier when trailing the trajectory", () => {
    const result = computePacing(250, 50, new Date("2025-06-15T12:00:00Z"), window);
    expect(result.status).toBe("behind");
    expect(result.suggestedBatchMultiplier).toBeGreaterThan(1);
  });

  it("reports ahead and suggests a <1 batch multiplier when far ahead of the trajectory", () => {
    const result = computePacing(250, 200, new Date("2025-06-15T12:00:00Z"), window);
    expect(result.status).toBe("ahead");
    expect(result.suggestedBatchMultiplier).toBeLessThan(1);
  });

  it("treats a moment before the window opens as zero expected progress (never behind before the day starts)", () => {
    const result = computePacing(250, 0, new Date("2025-06-15T05:00:00Z"), window);
    expect(result.expectedReadyByNow).toBe(0);
    expect(result.status).toBe("on_track");
  });
});

describe("computeAutopilotPacing", () => {
  const base = {
    workspaceId: "workspace-1",
    timeZone: "Europe/Madrid",
    dailyTarget: 250,
    targetAchievedToday: 7,
    rawRequestedToday: 4, rawReturnedToday: 4,
    processingInFlight: 0,
    providerRunsInFlight: 0,
    expectedQualifiedFromInFlight: 0,
    apifySpendToday: 1,
    apifyDailyBudgetRemaining: 9,
    providerHealth: "healthy" as const,
    estimatedYield: 0.5,
    yieldSampleSize: 30,
    operatingStartHour: 7,
    operatingEndHour: 22,
  };

  it("does not schedule before or after the local operating window", () => {
    expect(computeAutopilotPacing({ ...base, now: new Date("2025-06-15T04:00:00Z") }).status).toBe("before_window");
    expect(computeAutopilotPacing({ ...base, now: new Date("2025-06-15T20:00:00Z") }).status).toBe("after_window");
  });

  it("stays on pace when achieved plus in-flight covers the checkpoint", () => {
    const result = computeAutopilotPacing({ ...base, targetAchievedToday: 115, expectedQualifiedFromInFlight: 2, now: new Date("2025-06-15T12:00:00Z") });
    expect(result.status).toBe("on_pace");
    expect(result.rawNeededToPlan).toBe(0);
  });

  it("calculates production above 100 raws when a 250 target is behind at medium yield", () => {
    const result = computeAutopilotPacing({ ...base, targetAchievedToday: 0, estimatedYield: 0.3, now: new Date("2025-06-15T12:00:00Z") });
    expect(result.status).toBe("behind_pace");
    expect(result.qualifiedNeededToPlan).toBeGreaterThan(0);
    expect(result.rawNeededToPlan).toBeGreaterThan(100);
  });

  it("starts production from zero progress during the operating day", () => {
    const result = computeAutopilotPacing({ ...base, targetAchievedToday: 0, rawRequestedToday: 0, rawReturnedToday: 0, now: new Date("2025-06-15T07:30:00Z") });
    expect(result.status).toBe("behind_pace");
    expect(result.rawNeededToPlan).toBeGreaterThan(0);
  });

  it("lets in-flight work reduce the deficit and does not double count it", () => {
    const result = computeAutopilotPacing({ ...base, targetAchievedToday: 110, expectedQualifiedFromInFlight: 7, now: new Date("2025-06-15T12:00:00Z") });
    expect(result.paceDeficit).toBe(0);
    expect(result.rawNeededToPlan).toBe(0);
  });

  it("honours the remaining daily raw safety ceiling", () => {
    const result = computeAutopilotPacing({
      ...base,
      targetAchievedToday: 0,
      estimatedYield: 0.1,
      rawRequestedToday: 1490,
      maxDailyRawRequests: 1500,
      now: new Date("2025-06-15T12:00:00Z"),
    });
    expect(result.rawNeededToPlan).toBe(10);
  });

  it("stops normal production once the qualified target is reached", () => {
    const result = computeAutopilotPacing({ ...base, targetAchievedToday: 250, now: new Date("2025-06-15T12:00:00Z") });
    expect(result.remainingTarget).toBe(0);
    expect(result.qualifiedNeededToPlan).toBe(0);
    expect(result.rawNeededToPlan).toBe(0);
  });

  it("uses a conservative floor for low-yield samples without imposing a 100-raw ceiling", () => {
    const result = computeAutopilotPacing({ ...base, estimatedYield: 0.001, yieldSampleSize: 2, now: new Date("2025-06-15T12:00:00Z") });
    expect(result.estimatedYield).toBe(0.1);
    expect(result.rawNeededToPlan).toBeGreaterThan(100);
  });

  it("pauses scheduling for exhausted budget or unhealthy provider", () => {
    expect(computeAutopilotPacing({ ...base, apifyDailyBudgetRemaining: 0, now: new Date("2025-06-15T12:00:00Z") }).status).toBe("budget_paused");
    expect(computeAutopilotPacing({ ...base, providerHealth: "paused", now: new Date("2025-06-15T12:00:00Z") }).status).toBe("provider_paused");
  });

  it("continues scheduling when Apify is unavailable but another discovery provider has capacity", () => {
    const result = computeAutopilotPacing({
      ...base,
      providerHealth: "paused",
      apifyDailyBudgetRemaining: 0,
      availableDiscoveryCapacity: true,
      now: new Date("2025-06-15T12:00:00Z"),
    });
    expect(result.status).toBe("behind_pace");
    expect(result.rawNeededToPlan).toBeGreaterThan(0);
    expect(classifyAutopilotTargetRisk(result)).toBe("recoverable");
  });

  it("uses the workspace timezone across DST boundaries", () => {
    const beforeDst = computeAutopilotPacing({ ...base, now: new Date("2025-03-30T06:00:00Z") });
    const afterDst = computeAutopilotPacing({ ...base, now: new Date("2025-03-30T07:00:00Z") });
    expect(beforeDst.operatingStart).toBe("07:00");
    expect(afterDst.elapsedOperatingFraction).toBeGreaterThan(beforeDst.elapsedOperatingFraction);
  });
});
