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
    const provider = new SerperDiscoveryProvider({ apiKey: "key", fetchImpl, retryDelay: async () => undefined });

    await expect(provider.search({ query: "unique query", maxResults: 5 })).rejects.toThrow(/HTTP 500/);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });

  it.each([401, 403])("does not retry HTTP %i authentication/configuration failures", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("denied", { status }));
    const provider = new SerperDiscoveryProvider({ apiKey: "key", fetchImpl });

    await expect(provider.search({ query: "safe probe", maxResults: 1 })).rejects.toMatchObject({
      kind: status === 401 ? "authentication" : "configuration",
      estimatedCostUsd: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies other HTTP 400 responses as configuration errors without retry", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"message":"Invalid request"}', { status: 400 }));
    const provider = new SerperDiscoveryProvider({ apiKey: "key", fetchImpl });

    await expect(provider.search({ query: "safe probe", maxResults: 1 })).rejects.toMatchObject({ kind: "configuration", estimatedCostUsd: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("respects a bounded 429 retry and accounts for both attempts on success", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "Retry-After": "900" } }))
      .mockResolvedValueOnce(jsonResponse({ organic: [] }));
    const provider = new SerperDiscoveryProvider({ apiKey: "key", fetchImpl, retryDelay: async (delayMs) => {
      expect(delayMs).toBeLessThanOrEqual(30_000);
    } });

    const output = await provider.search({ query: "safe probe", maxResults: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(output.usage).toMatchObject({ calls: 2, costUsd: 0.002 });
  });

  it("charges each potentially billable HTTP attempt after a transient retry", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("temporary failure", { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ organic: [] }));
    const provider = new SerperDiscoveryProvider({ apiKey: "key", fetchImpl, retryDelay: async () => undefined });

    const output = await provider.search({ query: "safe probe", maxResults: 1 });

    expect(output.usage).toMatchObject({ calls: 2, costUsd: 0.002 });
  });

  it("bounds a network timeout retry and counts both possible billable attempts", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new DOMException("request timed out", "AbortError"))
      .mockResolvedValueOnce(jsonResponse({ organic: [] }));
    const provider = new SerperDiscoveryProvider({ apiKey: "key", fetchImpl, retryDelay: async () => undefined });

    const output = await provider.search({ query: "safe probe", maxResults: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(output.usage).toMatchObject({ calls: 2, costUsd: 0.002 });
  });

  it("classifies insufficient credits as billing and does not retry", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"message":"Not enough credits"}', { status: 400 }));
    const provider = new SerperDiscoveryProvider({ apiKey: "key", fetchImpl });

    await expect(provider.search({ query: "safe probe", maxResults: 1 })).rejects.toMatchObject({ kind: "billing" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts the active request without retrying when the caller deadline expires", async () => {
    const controller = new AbortController();
    const abortReason = new Error("PROCESSING_JOB_TIMEOUT");
    const fetchImpl: typeof fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const rejectOnAbort = () => reject(init?.signal?.reason);
      init?.signal?.addEventListener("abort", rejectOnAbort, { once: true });
      if (init?.signal?.aborted) rejectOnAbort();
    }));
    const provider = new SerperDiscoveryProvider({ apiKey: "key", fetchImpl });
    const pending = provider.search({ query: "deadline query", maxResults: 5, signal: controller.signal });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
