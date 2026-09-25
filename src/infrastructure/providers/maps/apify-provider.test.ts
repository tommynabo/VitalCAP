import { describe, expect, it, vi } from "vitest";
import { ApifyCostLimitExceededError, ApifyMapsDiscoveryProvider, mapApifyItemToPlaceResult } from "./apify-provider";
import type { ApifyMapsClient } from "./apify-provider";

const SUCCEEDED_RUN = {
  id: "run1",
  actId: "act1",
  status: "SUCCEEDED" as const,
  defaultDatasetId: "ds1",
  usageTotalUsd: 0.12,
  startedAt: "t",
  finishedAt: "t2",
};

describe("mapApifyItemToPlaceResult", () => {
  it("maps the common field aliases across actor variants", () => {
    const result = mapApifyItemToPlaceResult({
      title: "Farmacia Central",
      placeId: "p1",
      categoryName: "farmacia",
      address: "Calle Mayor 1",
      city: "Madrid",
      website: "https://example.es",
      phone: "+34123456789",
      totalScore: 4.5,
      reviewsCount: 120,
      url: "https://maps.google.com/p1",
      location: { lat: 40.1, lng: -3.5 },
    });
    expect(result.externalPlaceId).toBe("p1");
    expect(result.name).toBe("Farmacia Central");
    expect(result.websiteUrl).toBe("https://example.es");
    expect(result.latitude).toBe(40.1);
    expect(result.longitude).toBe(-3.5);
  });

  it("falls back gracefully when fields are missing", () => {
    const result = mapApifyItemToPlaceResult({});
    expect(result.name).toBe("Unknown");
    expect(result.websiteUrl).toBeNull();
  });
});

describe("ApifyMapsDiscoveryProvider", () => {
  function makeProvider() {
    const client: ApifyMapsClient = {
      runAndWait: vi.fn().mockResolvedValue(SUCCEEDED_RUN),
      getDatasetItems: vi.fn().mockResolvedValue([{ title: "Farmacia A", placeId: "p1" }]),
    };
    const recordRun = vi.fn().mockResolvedValue(undefined);
    const provider = new ApifyMapsDiscoveryProvider({
      apiToken: "token",
      actorId: "owner/actor",
      dailyCostLimitUsd: 10,
      batchCostLimitUsd: 2,
      getTodaySpendUsd: vi.fn().mockResolvedValue(0),
      recordRun,
      client,
    });
    return { provider, client, recordRun };
  }

  it("refuses to start a run once the daily cost limit is reached", async () => {
    const provider = new ApifyMapsDiscoveryProvider({
      apiToken: "token",
      actorId: "owner/actor",
      dailyCostLimitUsd: 10,
      batchCostLimitUsd: 2,
      getTodaySpendUsd: vi.fn().mockResolvedValue(10),
      client: { runAndWait: vi.fn(), getDatasetItems: vi.fn() },
    });

    await expect(provider.search({ query: "farmacia", geography: "Madrid", pageToken: null })).rejects.toThrow(ApifyCostLimitExceededError);
  });

  it("maps a successful run into MapsSearchOutput and records the run", async () => {
    const { provider, recordRun } = makeProvider();
    const output = await provider.search({ query: "farmacia", geography: "Madrid", pageToken: null });

    expect(output.results).toHaveLength(1);
    expect(output.results[0]?.name).toBe("Farmacia A");
    expect(output.usage.costUsd).toBe(0.12);
    expect(output.nextPageToken).toBeNull();
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", externalRunId: "run1", externalDatasetId: "ds1", itemsReturned: 1 }),
    );
  });

  it("throws and records a failed run when the actor run does not succeed", async () => {
    const client: ApifyMapsClient = {
      runAndWait: vi.fn().mockResolvedValue({ ...SUCCEEDED_RUN, status: "FAILED" }),
      getDatasetItems: vi.fn(),
    };
    const recordRun = vi.fn().mockResolvedValue(undefined);
    const provider = new ApifyMapsDiscoveryProvider({
      apiToken: "token",
      actorId: "owner/actor",
      dailyCostLimitUsd: 10,
      batchCostLimitUsd: 2,
      getTodaySpendUsd: vi.fn().mockResolvedValue(0),
      recordRun,
      client,
    });

    await expect(provider.search({ query: "farmacia", geography: "Madrid", pageToken: null })).rejects.toThrow(/did not succeed/);
    expect(recordRun).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
});
