import { describe, expect, it } from "vitest";
import { applyEconomicDiscoveryPacing, computeProviderBudgetPacing, getElapsedOperatingFraction, projectEndOfDayImports } from "./economic-pacing";

describe("economic pacing", () => {
  it("measures budget pace across the configured local operating window", () => {
    const now = new Date("2026-10-25T13:30:00.000Z");

    expect(getElapsedOperatingFraction("Europe/Madrid", now, 7, 22)).toBe(0.5);
    expect(getElapsedOperatingFraction("Europe/Madrid", new Date("2026-10-25T06:00:00.000Z"), 7, 22)).toBe(0);
  });

  it("reduces discovery when provider spend is ahead of operating-time pace", () => {
    const pacing = computeProviderBudgetPacing({ spendTodayUsd: 2.5, dailyCapUsd: 5, elapsedOperatingFraction: 0.25 });

    expect(pacing).toMatchObject({ state: "AHEAD_OF_BUDGET_PACE", expectedSpendByNowUsd: 1.25, discoveryMultiplier: 0.75 });
    expect(applyEconomicDiscoveryPacing(100, pacing.discoveryMultiplier)).toBe(75);
  });

  it("fails closed near the daily cap and never increases the planned allocation", () => {
    const pacing = computeProviderBudgetPacing({ spendTodayUsd: 4.6, dailyCapUsd: 5, elapsedOperatingFraction: 0.25 });

    expect(pacing.state).toBe("NEAR_DAILY_CAP");
    expect(applyEconomicDiscoveryPacing(100, pacing.discoveryMultiplier)).toBe(0);
    expect(applyEconomicDiscoveryPacing(100, 1.5)).toBe(100);
  });

  it("uses separate enter and exit thresholds to prevent pacing oscillation", () => {
    const entered = computeProviderBudgetPacing({ spendTodayUsd: 2, dailyCapUsd: 5, elapsedOperatingFraction: 0.25 });
    const retained = computeProviderBudgetPacing({
      spendTodayUsd: 1.65,
      dailyCapUsd: 5,
      elapsedOperatingFraction: 0.25,
      previousState: entered.state,
    });
    const exited = computeProviderBudgetPacing({
      spendTodayUsd: 1.45,
      dailyCapUsd: 5,
      elapsedOperatingFraction: 0.25,
      previousState: entered.state,
    });

    expect(entered.state).toBe("AHEAD_OF_BUDGET_PACE");
    expect(retained.state).toBe("AHEAD_OF_BUDGET_PACE");
    expect(exited.state).toBe("ON_PACE");
  });

  it("does not extrapolate early-day noise and keeps backlog probabilistic", () => {
    const early = projectEndOfDayImports({
      confirmedImports: 3,
      dailyTarget: 250,
      elapsedOperatingFraction: 0.1,
      recentImportsPerDay: 0,
      recentImportSample: 3,
      expectedImportsFromBacklog: 10,
    });

    expect(early).toEqual({ low: 3, base: 8, high: 13 });
  });

  it("uses a mature recent import rate for bounded low/base/high projections", () => {
    const projection = projectEndOfDayImports({
      confirmedImports: 40,
      dailyTarget: 250,
      elapsedOperatingFraction: 0.5,
      recentImportsPerDay: 60,
      recentImportSample: 60,
      expectedImportsFromBacklog: 4,
    });

    expect(projection).toEqual({ low: 64, base: 71, high: 79 });
    expect(projection.low).toBeGreaterThanOrEqual(40);
    expect(projection.high).toBeLessThanOrEqual(250);
  });
});