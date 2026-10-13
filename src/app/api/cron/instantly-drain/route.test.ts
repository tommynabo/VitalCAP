import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorized: vi.fn(),
  unauthorizedResponse: vi.fn(() => new Response(null, { status: 401 })),
  runCronRoute: vi.fn(),
  runInstantlyImportTick: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("@/infrastructure/jobs/runners/instantly-import-runner", () => ({
  runInstantlyImportTick: mocks.runInstantlyImportTick,
}));
vi.mock("@/lib/observability/structured-logger", () => ({ logEvent: mocks.logEvent }));
vi.mock("../_lib/cron-http", () => ({
  isAuthorizedCronRequest: mocks.authorized,
  unauthorizedCronResponse: mocks.unauthorizedResponse,
  runCronRoute: mocks.runCronRoute,
}));

import { GET } from "./route";

function request(): Parameters<typeof GET>[0] {
  return { nextUrl: new URL("https://example.test/api/cron/instantly-drain") } as Parameters<typeof GET>[0];
}

describe("Instantly drain cron route", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 without running queue work when unauthorized", async () => {
    mocks.authorized.mockReturnValue(false);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.unauthorizedResponse).toHaveBeenCalledOnce();
    expect(mocks.runCronRoute).not.toHaveBeenCalled();
    expect(mocks.runInstantlyImportTick).not.toHaveBeenCalled();
  });

  it("runs only the queue-only Instantly tick when authorized", async () => {
    mocks.authorized.mockReturnValue(true);
    mocks.runInstantlyImportTick.mockResolvedValue({
      candidatesFound: 0,
      leadsQueued: 0,
      leadsAttempted: 3,
      leadsAdded: 1,
      leadsSkipped: 1,
      leadsDeferred: 0,
      leadsFailed: 1,
      leadsNeedsReconciliation: 0,
      providerStatus: "ready",
      instantlyTelemetryReady: true,
      instantlyLeadImportReady: true,
      telemetryWarnings: [],
      quota: null,
      metrics: {},
    });
    mocks.runCronRoute.mockImplementation(async (_name, operation) => {
      const result = await operation();
      return Response.json({ status: "completed", ...result });
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.runInstantlyImportTick).toHaveBeenCalledOnce();
    expect(mocks.runInstantlyImportTick).toHaveBeenCalledWith({ processQueueOnly: true });
    expect(mocks.logEvent).toHaveBeenCalledWith("info", "cron.instantly-drain.completed", expect.objectContaining({
      provider: "instantly",
      outcome: "ready",
      leadsAttempted: 3,
      leadsAdded: 1,
      leadsFailed: 1,
      telemetryReady: true,
    }));
    const loggedFields = Object.keys(mocks.logEvent.mock.calls[0]?.[2] ?? {}).sort();
    expect(loggedFields).toEqual([
      "candidatesFound",
      "correlationId",
      "leadsAdded",
      "leadsAttempted",
      "leadsDeferred",
      "leadsFailed",
      "leadsNeedsReconciliation",
      "leadsQueued",
      "leadsSkipped",
      "outcome",
      "provider",
      "telemetryReady",
    ]);
  });
});