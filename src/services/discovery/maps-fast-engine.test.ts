import { describe, expect, it, vi } from "vitest";
import type { MapsDiscoveryProvider } from "@/domain/providers/types";
import type { SearchSeed } from "@/domain/discovery/types";
import { MapsFastEngine } from "./maps-fast-engine";

const seed: SearchSeed = {
  id: "seed-1",
  campaignId: "campaign-1",
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
};

describe("MapsFastEngine async provider lifecycle", () => {
  it("starts and returns without polling or creating raw candidates", async () => {
    const search = vi.fn();
    const startAsync = vi.fn().mockResolvedValue({
      actorId: "compass/crawler-google-places",
      externalRunId: "run-1",
      externalDatasetId: "dataset-1",
      status: "running" as const,
      itemsRequested: 20,
      costUsd: 0,
      metadata: { requestKey: "request-1" },
    });
    const provider: MapsDiscoveryProvider = { providerName: "apify-maps", search, startAsync };
    const engine = new MapsFastEngine(provider);

    const result = await engine.executeDiscovery({ seed, dryRun: false, requestKey: "request-1" });

    expect(startAsync).toHaveBeenCalledWith(expect.objectContaining({ requestKey: "request-1" }));
    expect(search).not.toHaveBeenCalled();
    expect(result.rawCandidates).toHaveLength(0);
    expect(result.providerRun?.externalRunId).toBe("run-1");
  });
});
