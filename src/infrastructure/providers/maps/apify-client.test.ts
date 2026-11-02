import { describe, expect, it, vi } from "vitest";
import { ApifyClient, classifyApifyRunFailure, reconcileApifyRunCost } from "./apify-client";

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

  it("classifies actor memory-limit 402 responses as a safe resource failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("actor-memory-limit secret=do-not-store query=private", { status: 402 }));
    const client = new ApifyClient({ apiToken: "t", fetchImpl });
    let failure: unknown;
    try {
      await client.startActorRun("owner/actor", {});
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ kind: "transient", failureKind: "actor_resource_limit", failureClass: "actor_memory_limit", status: 402 });
    expect((failure as Error).message).not.toContain("secret=do-not-store");
    expect((failure as Error).message).not.toContain("query=private");
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

  it("classifies a quota-related 403 as billing exhaustion but keeps permission 403s as authentication", async () => {
    const billingClient = new ApifyClient({
      apiToken: "t",
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { type: "usage-limit-exceeded", message: "Monthly usage limit exceeded" } }), { status: 403 })),
    });
    const permissionClient = new ApifyClient({
      apiToken: "t",
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { type: "insufficient-permissions", message: "Not allowed" } }), { status: 403 })),
    });

    await expect(billingClient.getRun("run1")).rejects.toMatchObject({ kind: "billing", failureKind: "billing" });
    await expect(permissionClient.getRun("run1")).rejects.toMatchObject({ kind: "authentication", failureKind: "authentication" });
  });

  it("sums real run costs and outstanding ceilings for the requested account window", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: {
        total: 3,
        items: [
          { id: "done", status: "SUCCEEDED", startedAt: "2026-10-19T23:10:00.000Z", usageTotalUsd: 0.2 },
          { id: "active", status: "RUNNING", startedAt: "2026-10-19T23:20:00.000Z", usageTotalUsd: 0.1 },
          { id: "outside", status: "SUCCEEDED", startedAt: "2026-10-20T00:00:00.000Z", usageTotalUsd: 3 },
        ],
      } }))
      .mockResolvedValueOnce(jsonResponse({ data: { total: 1, items: [
        { id: "active", status: "RUNNING", startedAt: "2026-10-19T23:20:00.000Z", usageTotalUsd: 0.1 },
      ] } }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        id: "active", actId: "actor", status: "RUNNING", defaultDatasetId: null,
        usageTotalUsd: 0.1, options: { maxTotalChargeUsd: 0.5 },
        startedAt: "2026-10-19T23:20:00.000Z", finishedAt: null,
      } }));
    const client = new ApifyClient({ apiToken: "t", fetchImpl });

    const snapshot = await client.getAccountCostSnapshot(
      new Date("2026-10-19T22:00:00.000Z"),
      new Date("2026-10-20T00:00:00.000Z"),
    );

    expect(snapshot.actualSpendUsd).toBeCloseTo(0.3);
    expect(snapshot.reservedSpendUsd).toBeCloseTo(0.4);
    expect(snapshot.committedSpendUsd).toBeCloseTo(0.7);
    expect(snapshot.runCount).toBe(2);
    expect(snapshot.runIds).toEqual(["done", "active"]);
    expect(snapshot.dayStart).toBe("2026-10-19T22:00:00.000Z");
    expect(snapshot.dayEnd).toBe("2026-10-20T00:00:00.000Z");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("startedAfter=2026-10-19T22%3A00%3A00.000Z");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("startedBefore=2026-10-20T00%3A00%3A00.000Z");
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("status=READY%2CRUNNING%2CTIMING-OUT%2CABORTING");
    expect(String(fetchImpl.mock.calls[2]?.[0])).toContain("/actor-runs/active");
  });

  it("fails closed when an in-flight account run has no charge ceiling", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: {
        total: 1,
        items: [{ id: "active", status: "RUNNING", startedAt: "2026-10-19T23:20:00.000Z", usageTotalUsd: 0.1 }],
      } }))
      .mockResolvedValueOnce(jsonResponse({ data: { total: 1, items: [
        { id: "active", status: "RUNNING", startedAt: "2026-10-19T23:20:00.000Z", usageTotalUsd: 0.1 },
      ] } }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        id: "active", actId: "actor", status: "RUNNING", defaultDatasetId: null,
        usageTotalUsd: 0.1, options: { maxTotalChargeUsd: null },
        startedAt: "2026-10-19T23:20:00.000Z", finishedAt: null,
      } }));
    const client = new ApifyClient({ apiToken: "t", fetchImpl });

    await expect(client.getAccountCostSnapshot(new Date("2026-10-19T22:00:00.000Z"), new Date("2026-10-20T00:00:00.000Z")))
      .rejects.toThrow(/no verifiable charge ceiling/);
  });

  it("reconciles a final actual run cost against its reservation", () => {
    expect(reconcileApifyRunCost(0.5, 0.31)).toEqual({
      reservedCostUsd: 0.5,
      actualCostUsd: 0.31,
      varianceUsd: -0.19,
      exceedsReservation: false,
    });
    expect(reconcileApifyRunCost(0.25, 0.3).exceedsReservation).toBe(true);
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
    const memoryFailure = classifyApifyRunFailure({ id: "run5", status: "FAILED", statusMessage: "actor-memory-limit, HTTP 402" });
    expect(memoryFailure).toMatchObject({ kind: "transient", failureKind: "actor_resource_limit", failureClass: "actor_memory_limit" });
    expect(memoryFailure.message).not.toContain("HTTP 402");
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
