import { describe, expect, it } from "vitest";
import { MockMapsDiscoveryProvider } from "./mock-provider";

describe("MockMapsDiscoveryProvider", () => {
  it("returns a deterministic page of results for the same query/geography", async () => {
    const provider = new MockMapsDiscoveryProvider();
    const first = await provider.search({ query: "farmacia", geography: "Madrid", pageToken: null });
    const second = await provider.search({ query: "farmacia", geography: "Madrid", pageToken: null });
    expect(first.results).toEqual(second.results);
  });

  it("produces different results for a different geography", async () => {
    const provider = new MockMapsDiscoveryProvider();
    const madrid = await provider.search({ query: "farmacia", geography: "Madrid", pageToken: null });
    const sevilla = await provider.search({ query: "farmacia", geography: "Sevilla", pageToken: null });
    expect(madrid.results[0]?.externalPlaceId).not.toBe(sevilla.results[0]?.externalPlaceId);
  });

  it("paginates and eventually terminates", async () => {
    const provider = new MockMapsDiscoveryProvider();
    let pageToken: string | null = null;
    let pages = 0;
    do {
      const page = await provider.search({ query: "farmacia", geography: "Madrid", pageToken });
      pageToken = page.nextPageToken;
      pages++;
    } while (pageToken && pages < 20);
    expect(pages).toBeLessThan(20);
  });

  it("reports non-zero provider usage per call", async () => {
    const provider = new MockMapsDiscoveryProvider();
    const result = await provider.search({ query: "farmacia", geography: "Madrid", pageToken: null });
    expect(result.usage.calls).toBe(1);
    expect(result.usage.items).toBe(result.results.length);
  });
});
