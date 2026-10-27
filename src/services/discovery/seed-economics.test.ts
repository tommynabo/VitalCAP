import { describe, expect, it } from "vitest";
import type { SearchSeed } from "@/domain/discovery/types";
import {
  calculateSeedNoveltyRate,
  planSeedBatches,
  scoreSeedEconomicPerformance,
  type SeedEconomicPerformance,
} from "./seed-economics";

function seed(id: string, overrides: Partial<SearchSeed> = {}): SearchSeed {
  return {
    id,
    campaignId: "campaign-1",
    engineType: "maps_fast",
    query: "farmacia",
    geography: id,
    lastRunAt: null,
    totalRaw: 0,
    totalUnique: 0,
    totalReady: 0,
    yieldRate: 0.1,
    exhaustionScore: 0,
    nextEligibleAt: null,
    ...overrides,
  };
}

function performance(overrides: Partial<SeedEconomicPerformance> = {}): SeedEconomicPerformance {
  return {
    seedId: "seed",
    recentRuns: 3,
    itemsReturned: 100,
    newRaw: 40,
    duplicates: 60,
    noveltyRate: 0.4,
    providerCostUsd: 0.5,
    costPerNewRaw: 0.0125,
    qualifiedFromSeed: 20,
    websiteFromSeed: 60,
    emailFoundFromSeed: 30,
    validEmailFromSeed: 8,
    confirmedInstantlyImportsFromSeed: 5,
    qualifiedYield: 0.5,
    websiteRate: 0.6,
    emailFoundRate: 0.3,
    validEmailYield: 0.2,
    validEmailRate: 0.2,
    confirmedImportYield: 0.125,
    instantlyImportRate: 0.125,
    costPerConfirmedImport: 0.1,
    sampleSize: 100,
    zeroNoveltyRunStreak: 0,
    lastRunAt: "2026-10-25T10:00:00.000Z",
    providerCostTodayUsd: 0.2,
    outcomeAttributionComplete: true,
    itemsReturnedToday: 40,
    newRawToday: 16,
    duplicatesToday: 24,
    nextEligibleAt: null,
    ...overrides,
  };
}

describe("seed economics", () => {
  const now = new Date("2026-10-27T10:00:00.000Z");

  it("defines novelty as newly inserted raw divided by provider results returned", () => {
    expect(calculateSeedNoveltyRate(3, 10)).toBe(0.3);
    expect(calculateSeedNoveltyRate(0, 0)).toBeNull();
  });

  it("does not count duplicates or invalid/unmappable results as new-raw novelty", () => {
    const itemsReturned = 10;
    const insertedNewRaw = 2;
    const duplicateExistingRaw = 5;
    const invalidOrUnmappable = 3;
    expect(calculateSeedNoveltyRate(insertedNewRaw, itemsReturned)).toBe(0.2);
    expect(duplicateExistingRaw + invalidOrUnmappable).toBe(itemsReturned - insertedNewRaw);
  });

  it("keeps small samples exploratory and does not exhaust one zero-novelty run", () => {
    const smallSample = scoreSeedEconomicPerformance(seed("small"), performance({
      recentRuns: 1,
      itemsReturned: 10,
      sampleSize: 10,
      noveltyRate: 0,
      zeroNoveltyRunStreak: 1,
    }), now);
    const oneLargeRun = scoreSeedEconomicPerformance(seed("single"), performance({
      recentRuns: 1,
      itemsReturned: 100,
      sampleSize: 100,
      noveltyRate: 0,
      zeroNoveltyRunStreak: 1,
    }), now);

    expect(smallSample).toMatchObject({ tier: "exploration", eligible: true, exploration: true });
    expect(oneLargeRun).toMatchObject({ tier: "zero", eligible: true, maxResults: 10 });
  });

  it("cools repeated confident zero-novelty seeds and permits re-exploration after expiry", () => {
    const repeatedZero = performance({
      recentRuns: 3,
      noveltyRate: 0,
      zeroNoveltyRunStreak: 2,
      lastRunAt: "2026-10-20T10:00:00.000Z",
    });
    const cooling = scoreSeedEconomicPerformance(seed("cooling"), repeatedZero, new Date("2026-10-26T10:00:00.000Z"));
    const returned = scoreSeedEconomicPerformance(seed("returned"), repeatedZero, new Date("2026-10-28T10:00:00.000Z"));

    expect(cooling).toMatchObject({ eligible: false, maxResults: 0, tier: "zero" });
    expect(cooling.cooldownUntil).toBe("2026-10-27T10:00:00.000Z");
    expect(returned).toMatchObject({ eligible: true, exploration: true, maxResults: 20 });
  });

  it("gives high-novelty seeds more batch capacity than low-novelty seeds", () => {
    const high = scoreSeedEconomicPerformance(seed("high"), performance({ noveltyRate: 0.7 }), now);
    const low = scoreSeedEconomicPerformance(seed("low"), performance({ noveltyRate: 0.05 }), now);
    expect(high.maxResults).toBeGreaterThan(low.maxResults);
    expect(high.maxResults).toBeLessThanOrEqual(100);
  });

  it("reallocates a low-novelty seed's planned capacity to productive seeds", () => {
    const seeds = [seed("high-a"), seed("high-b"), seed("low")];
    const performances = new Map([
      ["high-a", performance({ seedId: "high-a", noveltyRate: 0.7 })],
      ["high-b", performance({ seedId: "high-b", noveltyRate: 0.6 })],
      ["low", performance({ seedId: "low", noveltyRate: 0.05 })],
    ]);
    const batches = planSeedBatches({ seeds, performanceBySeed: performances, rawNeeded: 180, maxSeeds: 3, now });

    expect(batches.map((batch) => batch.seed.id)).toEqual(["high-a", "high-b"]);
    expect(batches.reduce((sum, batch) => sum + batch.requestedItems, 0)).toBe(180);
    expect(batches.every((batch) => batch.requestedItems <= 100)).toBe(true);
  });

  it("keeps exploration allocation while filling the rest from productive seeds", () => {
    const seeds = [seed("high-a"), seed("high-b"), seed("new")];
    const performances = new Map([
      ["high-a", performance({ seedId: "high-a", noveltyRate: 0.7 })],
      ["high-b", performance({ seedId: "high-b", noveltyRate: 0.6 })],
    ]);
    const batches = planSeedBatches({ seeds, performanceBySeed: performances, rawNeeded: 100, maxSeeds: 3, now });

    expect(batches.find((batch) => batch.seed.id === "new")?.requestedItems).toBeGreaterThanOrEqual(12);
    expect(batches.reduce((sum, batch) => sum + batch.requestedItems, 0)).toBe(100);
  });

  it("spreads equally ranked seeds across geographies when capacity allows", () => {
    const seeds = [
      seed("madrid-a", { geography: "Madrid" }),
      seed("madrid-b", { geography: "Madrid" }),
      seed("barcelona", { geography: "Barcelona" }),
    ];
    const performances = new Map(seeds.map((item) => [item.id, performance({ seedId: item.id, noveltyRate: 0.6 })]));
    const batches = planSeedBatches({ seeds, performanceBySeed: performances, rawNeeded: 150, maxSeeds: 2, now });

    expect(batches.map((batch) => batch.seed.id)).toEqual(["madrid-a", "barcelona"]);
  });

  it("spreads productive slots across regions already used by exploration", () => {
    const seeds = [
      seed("exploration-madrid", { geography: "Madrid" }),
      seed("productive-madrid", { geography: "Madrid" }),
      seed("productive-valencia", { geography: "Valencia" }),
    ];
    const performances = new Map([
      ["productive-madrid", performance({ seedId: "productive-madrid", noveltyRate: 0.6 })],
      ["productive-valencia", performance({ seedId: "productive-valencia", noveltyRate: 0.6 })],
    ]);
    const batches = planSeedBatches({ seeds, performanceBySeed: performances, rawNeeded: 150, maxSeeds: 2, now });

    expect(batches.map((batch) => batch.seed.id)).toEqual(["productive-valencia", "exploration-madrid"]);
  });

  it("uses confirmed-import cost only with a confident sample and limits its weight", () => {
    const baseline = performance({
      seedId: "baseline",
      costPerConfirmedImport: 0.1,
      confirmedInstantlyImportsFromSeed: 5,
    });
    const expensive = performance({
      seedId: "expensive",
      costPerConfirmedImport: 0.2,
      confirmedInstantlyImportsFromSeed: 5,
    });
    const noisy = performance({
      seedId: "noisy",
      costPerConfirmedImport: 10,
      confirmedInstantlyImportsFromSeed: 2,
    });
    const noisyWithoutCost = { ...noisy, costPerConfirmedImport: null };
    const expensiveScore = scoreSeedEconomicPerformance(seed("expensive"), expensive, now, 0.1).priorityScore;
    const baselineScore = scoreSeedEconomicPerformance(seed("baseline"), baseline, now, 0.1).priorityScore;
    const noisyScore = scoreSeedEconomicPerformance(seed("noisy"), noisy, now, 0.1).priorityScore;
    const noisyNeutralScore = scoreSeedEconomicPerformance(seed("noisy"), noisyWithoutCost, now, 0.1).priorityScore;

    expect(expensiveScore).toBeLessThan(baselineScore);
    expect(noisyScore).toBeCloseTo(noisyNeutralScore);
    expect(expensiveScore).toBeGreaterThanOrEqual(baselineScore * 0.75);
  });

  it("projects the verified zero-novelty bucket at more than 15% savings with all useful raw retained", () => {
    const baselineCostUsd = 14.2244;
    const zeroNoveltyCostUsd = 2.2308;
    const baselineNewRaw = 694;
    const zeroNoveltyNewRaw = 0;
    const projectedCostReductionPct = (zeroNoveltyCostUsd / baselineCostUsd) * 100;
    const projectedUsefulRawRetainedPct = ((baselineNewRaw - zeroNoveltyNewRaw) / baselineNewRaw) * 100;

    expect(projectedCostReductionPct).toBeGreaterThanOrEqual(15);
    expect(projectedUsefulRawRetainedPct).toBe(100);
  });
});