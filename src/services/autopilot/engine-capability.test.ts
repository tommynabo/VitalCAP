import { describe, expect, it } from "vitest";
import { buildEngineCapabilities } from "./engine-capability";

describe("engine capabilities", () => {
  it("only exposes configured healthy Maps Fast as available", () => {
    const capabilities = buildEngineCapabilities({
      mapsProvider: "apify",
      mapsProviderConfigured: true,
      serpProvider: "disabled",
      mapsFastHealth: "healthy",
      costAllowed: true,
      campaignCounts: { maps_fast: 1 },
    });
    expect(capabilities.find((item) => item.engineType === "maps_fast")?.available).toBe(true);
    expect(capabilities.find((item) => item.engineType === "google_serp")?.available).toBe(false);
    expect(capabilities.find((item) => item.engineType === "maps_deep")?.available).toBe(false);
  });

  it("blocks Maps Fast when provider health or budget blocks paid work", () => {
    const capabilities = buildEngineCapabilities({
      mapsProvider: "apify",
      mapsProviderConfigured: true,
      serpProvider: "disabled",
      mapsFastHealth: "paused",
      costAllowed: false,
      campaignCounts: { maps_fast: 1 },
    });
    expect(capabilities.find((item) => item.engineType === "maps_fast")?.available).toBe(false);
  });

  it("blocks paid discovery when the provider is degraded", () => {
    const maps = buildEngineCapabilities({
      mapsProvider: "apify",
      mapsProviderConfigured: true,
      serpProvider: "disabled",
      mapsFastHealth: "degraded",
      costAllowed: true,
      campaignCounts: { maps_fast: 1 },
    }).find((item) => item.engineType === "maps_fast");
    expect(maps).toMatchObject({ available: false, reasonUnavailable: "provider_degraded" });
  });

  it("allows a configured untested provider to bootstrap paid work", () => {
    const maps = buildEngineCapabilities({
      mapsProvider: "apify",
      mapsProviderConfigured: true,
      serpProvider: "disabled",
      mapsFastHealth: "untested",
      costAllowed: true,
      campaignCounts: { maps_fast: 1 },
    }).find((item) => item.engineType === "maps_fast");
    expect(maps).toMatchObject({ available: true, providerUntested: true });
  });

  it("exposes every concrete configured engine with its real provider health", () => {
    const capabilities = buildEngineCapabilities({
      mapsProvider: "apify",
      mapsProviderConfigured: true,
      serpProvider: "serper",
      serpProviderConfigured: true,
      mapsFastHealth: "healthy",
      providerHealth: { maps_fast: "healthy", maps_deep: "healthy", google_serp: "healthy", linkedin_owner: "healthy", hybrid_fill: "healthy" },
      costAllowed: true,
      campaignCounts: { maps_fast: 1, maps_deep: 1, google_serp: 1, linkedin_owner: 1, hybrid_fill: 1 },
    });
    expect(capabilities.filter((capability) => capability.available).map((capability) => capability.engineType))
      .toEqual(["maps_fast", "maps_deep", "google_serp", "linkedin_owner", "hybrid_fill"]);
  });

  it("does not schedule SERP-backed engines when the provider is missing or degraded", () => {
    const missing = buildEngineCapabilities({ mapsProvider: "apify", mapsProviderConfigured: true, serpProvider: "serper", serpProviderConfigured: false, mapsFastHealth: "healthy", costAllowed: true, campaignCounts: { google_serp: 1, linkedin_owner: 1 } });
    expect(missing.find((capability) => capability.engineType === "google_serp")).toMatchObject({ available: false, reason: "provider_not_configured" });
    const degraded = buildEngineCapabilities({ mapsProvider: "apify", mapsProviderConfigured: true, serpProvider: "serper", serpProviderConfigured: true, mapsFastHealth: "healthy", providerHealth: { google_serp: "degraded" }, costAllowed: true, campaignCounts: { google_serp: 1 } });
    expect(degraded.find((capability) => capability.engineType === "google_serp")).toMatchObject({ available: false, reason: "provider_degraded" });
  });
});
