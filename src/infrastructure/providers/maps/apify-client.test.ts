import { describe, expect, it, vi } from "vitest";
import { ApifyClient, classifyApifyRunFailure } from "./apify-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("ApifyClient", () => {
  it("starts a run with the documented endpoint and auth header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ data: { id: "run1", actId: "act1", status: "RUNNING", defaultDatasetId: "ds1", usageTotalUsd: null, startedAt: "t", finishedAt: null } }),
    );
    const client = new ApifyClient({ apiToken: "token123", fetchImpl });

    const run = await client.startRun("owner/actor", { foo: "bar" }, { maxTotalChargeUsd: 2 });

    expect(run.id).toBe("run1");
    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://api.apify.com/v2/acts/owner%2Factor/runs?maxTotalChargeUsd=2");
    expect(init.headers.Authorization).toBe("Bearer token123");
  });

  it("exposes explicit run status and dataset pagination endpoints", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { id: "run1", actId: "act1", status: "RUNNING", defaultDatasetId: "ds1", usageTotalUsd: null, startedAt: "t", finishedAt: null } }))
      .mockResolvedValueOnce(jsonResponse([{ title: "A" }]));
    const client = new ApifyClient({ apiToken: "token123", fetchImpl });
    await client.getActorRun("run1");
    await client.getDatasetItems("ds1", { offset: 100, limit: 25 });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/actor-runs/run1");
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("offset=100");
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("limit=25");
  });

  it("throws ApifyRequestError on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const client = new ApifyClient({ apiToken: "t", fetchImpl });
    await expect(client.getRun("run1")).rejects.toThrow(/HTTP 401/);
  });

  it("classifies HTTP 402 as a billing cooldown rather than an arbitrary failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("credits exhausted", { status: 402 }));
    const client = new ApifyClient({ apiToken: "t", fetchImpl });
    await expect(client.getRun("run1")).rejects.toMatchObject({ kind: "billing", retryAt: expect.any(Date) });
  });

  it("classifies HTTP 500 as a short transient provider cooldown", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("provider unavailable", { status: 500 }));
    const client = new ApifyClient({ apiToken: "t", fetchImpl });
    await expect(client.getRun("run1")).rejects.toMatchObject({ kind: "transient", retryAt: expect.any(Date) });
  });

  it.each([401, 403])( "classifies HTTP %i as a visible long authentication cooldown", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unauthorized", { status }));
    const client = new ApifyClient({ apiToken: "t", fetchImpl });
    await expect(client.getRun("run1")).rejects.toMatchObject({ kind: "authentication", retryAt: expect.any(Date) });
  });

  it("classifies network errors as transient provider failures", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const client = new ApifyClient({ apiToken: "t", fetchImpl });
    await expect(client.getRun("run1")).rejects.toMatchObject({ name: "ProviderTransientError", kind: "transient" });
  });

  it("classifies terminal actor input, billing, auth, and provider failures", () => {
    expect(classifyApifyRunFailure({ id: "run1", status: "FAILED", statusMessage: "Invalid input schema" }).kind).toBe("configuration");
    expect(classifyApifyRunFailure({ id: "run2", status: "FAILED", statusMessage: "Insufficient credits" }).kind).toBe("billing");
    expect(classifyApifyRunFailure({ id: "run3", status: "FAILED", statusMessage: "Invalid token" }).kind).toBe("authentication");
    expect(classifyApifyRunFailure({ id: "run4", status: "FAILED", statusMessage: "Temporary server issue" }).kind).toBe("transient");
  });

  it("runAndWait polls until a terminal status", async () => {
    const runningRun = { id: "run1", actId: "act1", status: "RUNNING", defaultDatasetId: "ds1", usageTotalUsd: null, startedAt: "t", finishedAt: null };
    const succeededRun = { ...runningRun, status: "SUCCEEDED", usageTotalUsd: 0.05, finishedAt: "t2" };

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: runningRun }))
      .mockResolvedValueOnce(jsonResponse({ data: runningRun }))
      .mockResolvedValueOnce(jsonResponse({ data: succeededRun }));

    const client = new ApifyClient({ apiToken: "t", fetchImpl });
    const run = await client.runAndWait("owner/actor", {}, { pollIntervalMs: 0, maxWaitMs: 5000 });

    expect(run.status).toBe("SUCCEEDED");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("fetches dataset items with clean=true", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ title: "A" }]));
    const client = new ApifyClient({ apiToken: "t", fetchImpl });
    const items = await client.getDatasetItems("ds1", { limit: 10 });
    expect(items).toEqual([{ title: "A" }]);
    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    const [url] = call as [string];
    expect(url).toContain("clean=true");
    expect(url).toContain("limit=10");
  });
});
