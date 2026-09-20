import { describe, expect, it } from "vitest";
import type { SearchSeed } from "@/domain/discovery/types";
import { MockMapsDiscoveryProvider } from "@/infrastructure/providers/maps/mock-provider";
import { MockSerpDiscoveryProvider } from "@/infrastructure/providers/serp/mock-provider";
import { MapsFastEngine } from "./maps-fast-engine";
import { MapsDeepEngine } from "./maps-deep-engine";
import { GoogleSerpEngine } from "./google-serp-engine";
import { LinkedInOwnerEngine } from "./linkedin-owner-engine";
import { HybridFillEngine } from "./hybrid-fill-engine";
import { DiscoveryRouter } from "./discovery-router";
import type { WebsiteFetcher } from "@/domain/providers/types";
import type { MapsRawPayload, SerpRawPayload, LinkedInRawPayload } from "./candidate-processor";

function seed(overrides: Partial<SearchSeed> = {}): SearchSeed {
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

const fakeFetcher: WebsiteFetcher = {
  fetchPage: async (url: string) => ({ url, status: 200, contentType: "text/html", body: '<a href="/contacto">Contacto</a> info@site.es' }),
};

describe("MapsFastEngine", () => {
  it("emits raw candidates tagged maps_fast and reports provider usage", async () => {
    const engine = new MapsFastEngine(new MockMapsDiscoveryProvider());
    const result = await engine.executeDiscovery({ seed: seed({ engineType: "maps_fast" }), dryRun: true });
    expect(result.rawCandidates.length).toBeGreaterThan(0);
    expect(result.rawCandidates.every((c) => c.engineType === "maps_fast")).toBe(true);
    expect(result.providerCalls).toBe(1);
    const payload = result.rawCandidates[0]!.rawPayload as unknown as MapsRawPayload;
    expect(payload.kind).toBe("maps");
    expect(payload.crawledPages).toBeUndefined();
  });
});

describe("MapsDeepEngine", () => {
  it("attaches crawled pages and owner SERP evidence for candidates with a website", async () => {
    const engine = new MapsDeepEngine(new MockMapsDiscoveryProvider(2), fakeFetcher, new MockSerpDiscoveryProvider());
    const result = await engine.executeDiscovery({ seed: seed({ engineType: "maps_deep" }), dryRun: true });
    const withWebsite = result.rawCandidates.find((c) => (c.rawPayload as unknown as MapsRawPayload).place.websiteUrl);
    expect(withWebsite).toBeDefined();
    const payload = withWebsite!.rawPayload as unknown as MapsRawPayload;
    expect(payload.crawledPages && payload.crawledPages.length).toBeGreaterThan(0);
    expect(payload.ownerSerpEvidence).toBeDefined();
  });
});

describe("GoogleSerpEngine", () => {
  it("excludes linkedin.com domains from its results", async () => {
    const engine = new GoogleSerpEngine(new MockSerpDiscoveryProvider());
    const result = await engine.executeDiscovery({ seed: seed({ engineType: "google_serp", query: "titular farmacéutico" }), dryRun: true });
    for (const candidate of result.rawCandidates) {
      const payload = candidate.rawPayload as unknown as SerpRawPayload;
      expect(payload.result.domain).not.toBe("linkedin.com");
    }
  });
});

describe("LinkedInOwnerEngine", () => {
  it("only emits linkedin.com profile results and attempts employer domain resolution", async () => {
    const engine = new LinkedInOwnerEngine(new MockSerpDiscoveryProvider());
    const result = await engine.executeDiscovery({ seed: seed({ engineType: "linkedin_owner", query: "titular farmacéutico" }), dryRun: true });
    expect(result.rawCandidates.length).toBeGreaterThan(0);
    for (const candidate of result.rawCandidates) {
      const payload = candidate.rawPayload as unknown as LinkedInRawPayload;
      expect(payload.profile.domain).toBe("linkedin.com");
    }
  });
});

describe("HybridFillEngine", () => {
  it("delegates to the underlying engine matching the seed's engineType and re-tags candidates as hybrid_fill", async () => {
    const mapsFast = new MapsFastEngine(new MockMapsDiscoveryProvider());
    const hybrid = new HybridFillEngine({ maps_fast: mapsFast });
    const result = await hybrid.executeDiscovery({ seed: seed({ engineType: "maps_fast" }), dryRun: true });
    expect(result.rawCandidates.length).toBeGreaterThan(0);
    expect(result.rawCandidates.every((c) => c.engineType === "hybrid_fill")).toBe(true);
  });

  it("returns an empty result when no delegate is registered for the seed's engine", async () => {
    const hybrid = new HybridFillEngine({});
    const result = await hybrid.executeDiscovery({ seed: seed({ engineType: "google_serp" }), dryRun: true });
    expect(result.rawCandidates).toHaveLength(0);
  });
});

describe("DiscoveryRouter", () => {
  it("routes to the correct engine by engineType", () => {
    const mapsFast = new MapsFastEngine(new MockMapsDiscoveryProvider());
    const router = new DiscoveryRouter([mapsFast]);
    expect(router.engineFor("maps_fast")).toBe(mapsFast);
    expect(router.has("google_serp")).toBe(false);
  });

  it("throws for an unregistered engine type", () => {
    const router = new DiscoveryRouter([]);
    expect(() => router.engineFor("maps_fast")).toThrow();
  });
});
