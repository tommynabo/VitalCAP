import { describe, expect, it, vi } from "vitest";
import { SerperDiscoveryProvider } from "./serper-provider";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("SerperDiscoveryProvider", () => {
  it("calls the documented Serper search endpoint with the right headers/body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ organic: [{ title: "Farmacia X", link: "https://farmaciax.es", snippet: "..." }] }),
    );
    const provider = new SerperDiscoveryProvider({ apiKey: "key123", country: "es", language: "es", fetchImpl });

    const output = await provider.search({ query: "farmacia Madrid", maxResults: 5 });

    expect(output.results).toEqual([{ title: "Farmacia X", url: "https://farmaciax.es", snippet: "...", domain: "farmaciax.es" }]);
    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [string, RequestInit & { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://google.serper.dev/search");
    expect(init.headers["X-API-KEY"]).toBe("key123");
    expect(JSON.parse(init.body)).toEqual({ q: "farmacia Madrid", gl: "es", hl: "es", num: 5 });
  });

  it("caches identical queries and does not re-call fetch or re-bill", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ organic: [{ title: "A", link: "https://a.es" }] }));
    const provider = new SerperDiscoveryProvider({ apiKey: "key", fetchImpl });

    const first = await provider.search({ query: "farmacia Madrid", maxResults: 5 });
    const second = await provider.search({ query: "farmacia Madrid", maxResults: 5 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first.usage.costUsd).toBeGreaterThan(0);
    expect(second.usage.costUsd).toBe(0);
    expect(second.results).toEqual(first.results);
  });

  it("retries on transient failure then throws after exhausting retries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const provider = new SerperDiscoveryProvider({ apiKey: "key", fetchImpl });

    await expect(provider.search({ query: "unique query", maxResults: 5 })).rejects.toThrow(/HTTP 500/);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});
