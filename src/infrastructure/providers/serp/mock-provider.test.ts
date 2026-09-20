import { describe, expect, it } from "vitest";
import { MockSerpDiscoveryProvider } from "./mock-provider";

describe("MockSerpDiscoveryProvider", () => {
  it("returns deterministic results for the same query", async () => {
    const provider = new MockSerpDiscoveryProvider();
    const first = await provider.search({ query: "farmacia suplementos Madrid", maxResults: 5 });
    const second = await provider.search({ query: "farmacia suplementos Madrid", maxResults: 5 });
    expect(first.results).toEqual(second.results);
  });

  it("caps results at maxResults", async () => {
    const provider = new MockSerpDiscoveryProvider();
    const result = await provider.search({ query: "farmacia suplementos Madrid", maxResults: 3 });
    expect(result.results.length).toBeLessThanOrEqual(3);
  });

  it("produces LinkedIn-shaped results for role-family queries", async () => {
    const provider = new MockSerpDiscoveryProvider();
    const result = await provider.search({ query: "titular farmacéutico Madrid", maxResults: 10 });
    expect(result.results.some((r) => r.domain === "linkedin.com")).toBe(true);
  });

  it("produces business-website-shaped results for category queries", async () => {
    const provider = new MockSerpDiscoveryProvider();
    const result = await provider.search({ query: "parafarmacia Madrid", maxResults: 10 });
    expect(result.results.every((r) => r.domain !== "linkedin.com")).toBe(true);
  });
});
