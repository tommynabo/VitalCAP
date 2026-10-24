import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EngineCard } from "./engine-card";

describe("EngineCard provider health attribution", () => {
  it("shows Maps Fast provider health separately from a downstream Serper error", () => {
    const markup = renderToStaticMarkup(<EngineCard engine={{
      engineType: "maps_fast",
      providerConfigured: true,
      campaignActive: true,
      autopilotEnabled: true,
      softTarget: 250,
      readyToday: 0,
      rawQueueDepth: 0,
      processingQueueDepth: 0,
      currentYield: 0,
      providerHealth: "healthy",
      lastRunAt: null,
      lastError: "Serper unavailable for website recovery",
      nextPlannedAction: null,
    }} />);

    expect(markup).toContain("Provider health");
    expect(markup).toContain("HEALTHY");
    expect(markup).toContain("Last pipeline / enrichment error: Serper unavailable for website recovery");
  });
});