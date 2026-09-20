import { describe, expect, it } from "vitest";
import type { SearchSeed } from "@/domain/discovery/types";
import { recordSeedRun, selectNextSeeds } from "./geography-planner";

function makeSeed(overrides: Partial<SearchSeed> = {}): SearchSeed {
  return {
    id: "seed_1",
    campaignId: "camp_1",
    engineType: "maps_fast",
    query: "farmacia",
    geography: "Madrid",
    lastRunAt: null,
    totalRaw: 0,
    totalUnique: 0,
    totalReady: 0,
    yieldRate: 0,
    exhaustionScore: 0,
    nextEligibleAt: null,
    ...overrides,
  };
}

describe("selectNextSeeds", () => {
  it("prioritizes never-run seeds first", () => {
    const now = new Date("2025-01-01T00:00:00Z");
    const neverRun = makeSeed({ id: "never" });
    const highYield = makeSeed({ id: "ran_high_yield", lastRunAt: "2024-12-01T00:00:00Z", yieldRate: 0.9 });
    const picks = selectNextSeeds([highYield, neverRun], 1, now);
    expect(picks).toEqual([neverRun]);
  });

  it("among previously-run seeds, prefers higher yield", () => {
    const now = new Date("2025-01-01T00:00:00Z");
    const low = makeSeed({ id: "low", lastRunAt: "2024-12-01T00:00:00Z", yieldRate: 0.1 });
    const high = makeSeed({ id: "high", lastRunAt: "2024-12-01T00:00:00Z", yieldRate: 0.8 });
    const picks = selectNextSeeds([low, high], 2, now);
    expect(picks.map((seed) => seed.id)).toEqual(["high", "low"]);
  });

  it("excludes seeds still in cooldown", () => {
    const now = new Date("2025-01-01T00:00:00Z");
    const cooling = makeSeed({ id: "cooling", nextEligibleAt: "2025-06-01T00:00:00Z" });
    const ready = makeSeed({ id: "ready", nextEligibleAt: "2024-06-01T00:00:00Z", lastRunAt: "2024-06-01T00:00:00Z" });
    const picks = selectNextSeeds([cooling, ready], 5, now);
    expect(picks.map((seed) => seed.id)).toEqual(["ready"]);
  });
});

describe("recordSeedRun", () => {
  it("accumulates raw/unique/ready totals and yield rate", () => {
    const seed = makeSeed();
    const updated = recordSeedRun(seed, { rawCount: 20, uniqueCount: 15, readyCount: 5, finishedAt: "2025-01-01T00:00:00Z" });
    expect(updated.totalRaw).toBe(20);
    expect(updated.totalReady).toBe(5);
    expect(updated.yieldRate).toBeCloseTo(0.25);
    expect(updated.lastRunAt).toBe("2025-01-01T00:00:00.000Z");
    expect(updated.nextEligibleAt).not.toBeNull();
  });

  it("gives an exhausted (near-zero-yield, previously-run) seed a much longer cooldown than a healthy one", () => {
    const healthySeed = makeSeed({ totalRaw: 20, totalReady: 5, yieldRate: 0.25, lastRunAt: "2024-12-01T00:00:00Z" });
    const healthyUpdated = recordSeedRun(healthySeed, { rawCount: 20, uniqueCount: 15, readyCount: 5, finishedAt: "2025-01-01T00:00:00Z" });

    const exhaustedSeed = makeSeed({ totalRaw: 100, totalReady: 1, yieldRate: 0.01, lastRunAt: "2024-12-01T00:00:00Z" });
    const exhaustedUpdated = recordSeedRun(exhaustedSeed, { rawCount: 20, uniqueCount: 18, readyCount: 0, finishedAt: "2025-01-01T00:00:00Z" });

    const healthyCooldown = new Date(healthyUpdated.nextEligibleAt!).getTime() - new Date("2025-01-01T00:00:00Z").getTime();
    const exhaustedCooldown = new Date(exhaustedUpdated.nextEligibleAt!).getTime() - new Date("2025-01-01T00:00:00Z").getTime();
    expect(exhaustedCooldown).toBeGreaterThan(healthyCooldown);
  });
});
