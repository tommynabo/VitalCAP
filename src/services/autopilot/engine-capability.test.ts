import { describe, expect, it } from "vitest";
import { buildEngineCapabilities } from "./engine-capability";

describe("engine capabilities", () => {
  it("only exposes configured healthy Maps Fast as available", () => {
    const capabilities = buildEngineCapabilities({
      mapsProvider: "apify",
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
      serpProvider: "disabled",
      mapsFastHealth: "paused",
      costAllowed: false,
      campaignCounts: { maps_fast: 1 },
    });
    expect(capabilities.find((item) => item.engineType === "maps_fast")?.available).toBe(false);
  });
});