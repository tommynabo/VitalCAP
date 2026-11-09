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
    expect(result?.externalPlaceId).toBe("p1");
    expect(result?.name).toBe("Farmacia Central");
    expect(result?.websiteUrl).toBe("https://example.es");
    expect(result?.latitude).toBe(40.1);
    expect(result?.longitude).toBe(-3.5);
  });

  it("falls back gracefully when fields are missing", () => {
    const result = mapApifyItemToPlaceResult({});
    expect(result).toBeNull();
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
      actorId: "compass/crawler-google-places",
      dailyCostLimitUsd: 10,
      batchCostLimitUsd: 2,
      getReservedCostUsd: vi.fn().mockResolvedValue(0.5),
      recordRun,
      client,
    });
    return { provider, client, recordRun };
  }

  it("refuses to start a run when no daily reservation is available", async () => {
    const provider = new ApifyMapsDiscoveryProvider({
      apiToken: "token",
      actorId: "compass/crawler-google-places",
      dailyCostLimitUsd: 10,
      batchCostLimitUsd: 2,
      getReservedCostUsd: vi.fn().mockRejectedValue(new ApifyCostLimitExceededError("No budget")),
      client: { runAndWait: vi.fn(), getDatasetItems: vi.fn() },
    });

    await expect(provider.search({ query: "farmacia", geography: "Madrid", pageToken: null, requestKey: "reservation-key" })).rejects.toThrow(ApifyCostLimitExceededError);
  });

  it("uses the exact persisted reservation as Apify's charge ceiling", async () => {
    const startActorRun = vi.fn().mockResolvedValue({ ...SUCCEEDED_RUN, status: "READY", defaultDatasetId: null });
    const provider = new ApifyMapsDiscoveryProvider({
      apiToken: "token",
      actorId: "compass/crawler-google-places",
      dailyCostLimitUsd: 10,
      batchCostLimitUsd: 2,
      getReservedCostUsd: vi.fn().mockResolvedValue(0.1),
      client: { runAndWait: vi.fn(), startActorRun, getDatasetItems: vi.fn() },
    });
    await provider.startAsync({ query: "farmacia", geography: "Madrid", pageToken: null, requestKey: "reservation-key", maxResults: 5 });
    expect(startActorRun).toHaveBeenCalledWith(expect.any(String), expect.any(Object), { maxTotalChargeUsd: 0.1 });
  });

  it("marks an Apify start error as a provider attempt only after the client call begins", async () => {
    const requestError = new Error("Actor API unavailable");
    const startActorRun = vi.fn().mockRejectedValue(requestError);
    const provider = new ApifyMapsDiscoveryProvider({
      apiToken: "token",
      actorId: "compass/crawler-google-places",
      dailyCostLimitUsd: 10,
      batchCostLimitUsd: 2,
      getReservedCostUsd: vi.fn().mockResolvedValue(0.1),
      client: { runAndWait: vi.fn(), startActorRun, getDatasetItems: vi.fn() },
    });

    await expect(provider.startAsync({ query: "yoga studio", geography: "Madrid", pageToken: null, requestKey: "reservation-key", maxResults: 1 }))
      .rejects.toMatchObject({ providerCallAttempted: true });
    expect(startActorRun).toHaveBeenCalledTimes(1);
  });

  it("uses the same hard-capped result count in actor input and async accounting", async () => {
    const startActorRun = vi.fn().mockResolvedValue({ ...SUCCEEDED_RUN, status: "READY", defaultDatasetId: null });
    const provider = new ApifyMapsDiscoveryProvider({
      apiToken: "token",
      actorId: "compass/crawler-google-places",
      dailyCostLimitUsd: 10,
      batchCostLimitUsd: 0.5,
      getReservedCostUsd: vi.fn().mockResolvedValue(0.5),
      client: { runAndWait: vi.fn(), startActorRun, getDatasetItems: vi.fn() },
    });

    const result = await provider.startAsync({ query: "farmacia", geography: "Madrid", pageToken: null, requestKey: "reservation-key", maxResults: 250 });
    expect(startActorRun.mock.calls[0]?.[1]).toMatchObject({ maxCrawledPlacesPerSearch: 100 });
    expect(result.itemsRequested).toBe(100);
  });

  it("does not start an actor run when the batch budget cannot fund one result", async () => {
    const startActorRun = vi.fn();
    const provider = new ApifyMapsDiscoveryProvider({
      apiToken: "token",
      actorId: "compass/crawler-google-places",
      dailyCostLimitUsd: 10,
      batchCostLimitUsd: 0,
      getReservedCostUsd: vi.fn().mockResolvedValue(0),
      client: { runAndWait: vi.fn(), startActorRun, getDatasetItems: vi.fn() },
    });

    await expect(provider.startAsync({ query: "farmacia", geography: "Madrid", pageToken: null, requestKey: "reservation-key" }))
      .rejects.toThrow(ApifyCostLimitExceededError);
    expect(startActorRun).not.toHaveBeenCalled();
  });

  it("respects a lower configured result ceiling in actor input and run records", async () => {
    const client: ApifyMapsClient = {
      runAndWait: vi.fn().mockResolvedValue(SUCCEEDED_RUN),
      getDatasetItems: vi.fn().mockResolvedValue([{ title: "Farmacia A", placeId: "p1" }]),
    };
    const recordRun = vi.fn().mockResolvedValue(undefined);
    const provider = new ApifyMapsDiscoveryProvider({
      apiToken: "token",
      actorId: "compass/crawler-google-places",
      dailyCostLimitUsd: 10,
      batchCostLimitUsd: 0.5,
      maxCrawledPlacesPerSearch: 20,
      getReservedCostUsd: vi.fn().mockResolvedValue(0.5),
      recordRun,
      client,
    });

    await provider.search({ query: "farmacia", geography: "Madrid", pageToken: null, requestKey: "reservation-key", maxResults: 80 });
    expect(client.runAndWait).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ maxCrawledPlacesPerSearch: 20 }), expect.any(Object));
    expect(client.getDatasetItems).toHaveBeenCalledWith("ds1", { limit: 20 });
    expect(recordRun).toHaveBeenCalledWith(expect.objectContaining({ itemsRequested: 20 }));
  });

  it("uses the reservation key to retrieve the exact reserved amount", async () => {
    const getReservedCostUsd = vi.fn().mockResolvedValue(0.25);
    const startActorRun = vi.fn().mockResolvedValue({ ...SUCCEEDED_RUN, status: "READY", defaultDatasetId: null });
    const provider = new ApifyMapsDiscoveryProvider({
      apiToken: "token",
      actorId: "compass/crawler-google-places",
      dailyCostLimitUsd: 10,
      batchCostLimitUsd: 2,
      getReservedCostUsd,
      client: { runAndWait: vi.fn(), startActorRun, getDatasetItems: vi.fn() },
    });

    await provider.startAsync({ query: "farmacia", geography: "Madrid", pageToken: null, requestKey: "apify:request-1", maxResults: 10 });
    expect(getReservedCostUsd).toHaveBeenCalledWith("apify:request-1");
    expect(startActorRun).toHaveBeenCalledWith(expect.any(String), expect.any(Object), { maxTotalChargeUsd: 0.25 });
  });

  it("uses the lower workspace daily cap", async () => {
    const startActorRun = vi.fn();
    const provider = new ApifyMapsDiscoveryProvider({
      apiToken: "token",
      actorId: "compass/crawler-google-places",
      dailyCostLimitUsd: 10,
      workspaceDailyCostLimitUsd: 0.25,
      batchCostLimitUsd: 2,
      getReservedCostUsd: vi.fn().mockResolvedValue(0.5),
      client: { runAndWait: vi.fn(), startActorRun, getDatasetItems: vi.fn() },
    });
    await expect(provider.startAsync({ query: "farmacia", geography: "Madrid", pageToken: null, requestKey: "reservation-key" })).rejects.toThrow(ApifyCostLimitExceededError);
    expect(startActorRun).not.toHaveBeenCalled();
  });

  it("does not start a new run while the workspace is paused", async () => {
    const startActorRun = vi.fn();
    const provider = new ApifyMapsDiscoveryProvider({
      apiToken: "token",
      actorId: "compass/crawler-google-places",
      dailyCostLimitUsd: 10,
      batchCostLimitUsd: 2,
      getReservedCostUsd: vi.fn().mockResolvedValue(0.5),
      getAutopilotState: vi.fn().mockResolvedValue("paused"),
      client: { runAndWait: vi.fn(), startActorRun, getDatasetItems: vi.fn() },
    });

    await expect(provider.startAsync({ query: "farmacia", geography: "Madrid", pageToken: null, requestKey: "reservation-key" })).rejects.toThrow(/paused/);
    expect(startActorRun).not.toHaveBeenCalled();
  });

  it("maps a successful run into MapsSearchOutput and records the run", async () => {
    const { provider, recordRun } = makeProvider();
    const output = await provider.search({ query: "farmacia", geography: "Madrid", pageToken: null, requestKey: "reservation-key", maxResults: 7 });

    expect(output.results).toHaveLength(1);
    expect(output.results[0]?.name).toBe("Farmacia A");
    expect(output.usage.costUsd).toBe(0.12);
    expect(output.nextPageToken).toBeNull();
    expect((vi.mocked((provider as unknown as { client: ApifyMapsClient }).client.runAndWait).mock.calls[0]?.[1] as Record<string, unknown>).maxCrawledPlacesPerSearch).toBe(7);
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
      actorId: "compass/crawler-google-places",
      dailyCostLimitUsd: 10,
      batchCostLimitUsd: 2,
      getReservedCostUsd: vi.fn().mockResolvedValue(0.5),
      recordRun,
      client,
    });

    await expect(provider.search({ query: "farmacia", geography: "Madrid", pageToken: null, requestKey: "reservation-key" })).rejects.toThrow(/did not succeed/);
    expect(recordRun).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
});
